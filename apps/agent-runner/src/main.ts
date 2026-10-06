import Fastify from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { timingSafeEqual, createHash } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { JobRequest, RunnerEvent } from '@sb/contracts';
import { buildTools } from './tools';

const PORT = Number(process.env.PORT ?? 8791);
const MAX_CONCURRENCY = Number(process.env.RUNNER_CONCURRENCY ?? 2);
const tokenFile = process.env.INTERNAL_TOKEN_FILE;
const INTERNAL_TOKEN = tokenFile && fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : (process.env.INTERNAL_TOKEN ?? '');
if (!INTERNAL_TOKEN || INTERNAL_TOKEN.length < 32) { console.error(JSON.stringify({ level: 'error', msg: 'runner.missing_internal_token' })); process.exit(1); }
const SDK_VERSION = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.resolve('@anthropic-ai/claude-agent-sdk')).pathname), 'package.json'), 'utf8')).version as string;

let active = 0;
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.authorization'] }, bodyLimit: 20 * 1024 * 1024 });

const hashEq = (a: string, b: string) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

app.get('/health', async () => ({ ok: true, active, max: MAX_CONCURRENCY, sdk: SDK_VERSION }));

app.post('/jobs', async (req, reply) => {
  const auth = String(req.headers.authorization ?? '');
  if (!auth.startsWith('Bearer ') || !hashEq(auth.slice(7), INTERNAL_TOKEN)) return reply.code(401).send({ code: 'unauthorized' });
  if (active >= MAX_CONCURRENCY) return reply.code(429).send({ code: 'runner_busy', retryable: true });
  const job = req.body as JobRequest;
  if (!job?.jobId || !job.proxy?.token || !job.systemPrompt) return reply.code(400).send({ code: 'bad_job' });

  active++;
  reply.raw.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
  const emit = (e: RunnerEvent) => { if (!reply.raw.destroyed) reply.raw.write(JSON.stringify(e) + '\n'); };
  const abort = new AbortController();
  // The RESPONSE closing early means the worker went away (cancel or crash); abort the SDK run.
  reply.raw.on('close', () => { if (!reply.raw.writableFinished) abort.abort(); });
  const timer = setTimeout(() => abort.abort(), job.timeoutS * 1000);
  // Each job gets a private, empty HOME/config dir; nothing persists between jobs.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'job-'));
  try {
    const { server, allowed, readChunks, proposals } = buildTools(job, emit);
    const q = query({
      prompt: job.userPrompt,
      options: {
        model: job.model,
        systemPrompt: job.systemPrompt,
        tools: [],                                  // no built-in tools at all (no Bash/Read/Write/Web*)
        mcpServers: { vault: server },
        allowedTools: allowed,
        disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'NotebookEdit', 'Skill'],
        permissionMode: 'dontAsk',                  // anything not pre-approved is denied
        settingSources: [],                         // never load user/project/local settings, CLAUDE.md, hooks
        strictMcpConfig: true,
        persistSession: false,
        includePartialMessages: true,
        maxTurns: job.maxTurns,
        maxBudgetUsd: job.maxBudgetUsd,
        outputFormat: { type: 'json_schema', schema: job.outputSchema },
        cwd: home,
        abortController: abort,
        env: {
          PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), TMPDIR: home,
          ANTHROPIC_BASE_URL: job.proxy.baseUrl, ANTHROPIC_API_KEY: job.proxy.token,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
          CLAUDE_CODE_MAX_RETRIES: '2', CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(job.maxOutputTokens), CLAUDE_AGENT_SDK_CLIENT_APP: 'second-brain-os/0.1',
        },
        stderr: d => app.log.debug({ jobId: job.jobId, stderr: d.slice(0, 300) }),
      },
    });
    let finalText = '';
    for await (const m of q) {
      if (m.type === 'system' && m.subtype === 'init') emit({ type: 'started', tools: m.tools, model: m.model });
      else if (m.type === 'stream_event') {
        const ev = m.event as { type: string; delta?: { type: string; text?: string } };
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) emit({ type: 'text_delta', text: ev.delta.text });
      } else if (m.type === 'assistant') {
        for (const b of m.message.content as { type: string; text?: string }[]) if (b.type === 'text' && b.text) finalText += b.text;
      } else if (m.type === 'system' && m.subtype === 'api_retry') {
        emit({ type: 'progress', message: `retrying provider request (attempt ${(m as { attempt?: number }).attempt ?? '?'})` });
      } else if (m.type === 'result') {
        emit({ type: 'coverage', readChunks: [...readChunks] });
        const usage = { input_tokens: m.usage?.input_tokens ?? 0, output_tokens: m.usage?.output_tokens ?? 0, cache_read_input_tokens: m.usage?.cache_read_input_tokens ?? 0, cache_creation_input_tokens: m.usage?.cache_creation_input_tokens ?? 0 };
        if (m.subtype === 'success' && !m.is_error) {
          emit({ type: 'result', structured: m.structured_output ?? null, text: finalText || m.result, usage, costUsd: m.total_cost_usd ?? null, numTurns: m.num_turns, subtype: m.subtype });
        } else {
          const msg = m.subtype === 'success' ? m.result : (m.errors ?? []).join('; ');
          const code = m.subtype === 'error_max_budget_usd' ? 'budget_exceeded' : m.subtype === 'error_max_turns' ? 'max_turns' : classify(msg);
          emit({ type: 'error', code, message: sanitize(msg), retryable: ['rate_limited', 'overloaded', 'server_error', 'timeout'].includes(code) });
        }
      }
    }
    void proposals;
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    emit({ type: 'error', code: abort.signal.aborted ? 'canceled_or_timeout' : classify(msg), message: sanitize(msg), retryable: !abort.signal.aborted && /429|529|5\d\d|timeout|ECONN/i.test(msg) });
  } finally {
    clearTimeout(timer);
    active--;
    fs.rmSync(home, { recursive: true, force: true });
    reply.raw.end();
  }
  return reply;
});

function classify(msg: string): string {
  if (/401|authentication|invalid x-api-key/i.test(msg)) return 'invalid_key';
  if (/403|permission/i.test(msg)) return 'permission_denied';
  if (/429|rate/i.test(msg)) return 'rate_limited';
  if (/529|overloaded/i.test(msg)) return 'overloaded';
  if (/credit|balance/i.test(msg)) return 'insufficient_credit';
  if (/timeout|timed out/i.test(msg)) return 'timeout';
  if (/5\d\d/.test(msg)) return 'server_error';
  return 'runner_error';
}
// Never echo tokens or long provider bodies back to the worker.
const sanitize = (s: string) => s.replace(/sb_[A-Za-z0-9_-]{10,}/g, '[token]').replace(/sk-ant-[A-Za-z0-9_-]+/g, '[key]').slice(0, 500);

app.listen({ host: '0.0.0.0', port: PORT }).then(() => app.log.info({ sdk: SDK_VERSION, max: MAX_CONCURRENCY }, 'runner.listening'));
