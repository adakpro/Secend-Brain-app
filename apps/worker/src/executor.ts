import { randomUUID } from 'node:crypto';
import type { JobRequest, RunnerEvent, JobBundle } from '@sb/contracts';
import {
  type Db, type AppConfig, RunService, CredentialService, ChangeSetEngine, validateAgentOps, buildSystemPrompt, skillById,
  INGEST_OUTPUT_SCHEMA, QUERY_OUTPUT_SCHEMA, STUDIO_OUTPUT_SCHEMA, QUIZ_OUTPUT_SCHEMA, buildIngestBundle, buildQueryBundle, buildDocsBundle,
  validateCitations, excerptOf, log, withTx, audit,
} from '@sb/core';

export class RetryableRunError extends Error {}

export class Executor {
  constructor(private db: Db, private cfg: AppConfig, private runs: RunService, private creds: CredentialService, private engine: ChangeSetEngine, private internalToken: string) {}

  async execute(runId: string): Promise<void> {
    const run = (await this.db.query('SELECT * FROM agent_runs WHERE id=$1', [runId])).rows[0];
    if (!run) return;
    if (run.status !== 'queued') { log.info('run.skip_not_queued', { runId, status: run.status }); return; }
    const skill = skillById(run.skill_id);
    if (!skill || skill.status !== 'implemented') return this.fail(runId, 'skill_not_available', 'این مهارت در این نسخه پیاده نشده است.', false);

    // Connection: real API card, or the explicit test-only mock. Never a silent fallback.
    let model: string; let credentialId: string | null = null; let settings: Record<string, any>;
    if (this.cfg.modelProviderMode === 'mock') {
      model = 'claude-mock-test'; settings = { perRunBudgetUsd: 1, maxOutputTokens: 4000, timeoutS: 120 };
    } else {
      const cred = await this.creds.decryptActive();
      if (!cred) return this.fail(runId, 'model_not_connected', 'اتصال API مدل برقرار نیست. از «تنظیمات › اتصال Claude» کلید API را ثبت کنید.', false);
      if (cred.status === 'invalid') return this.fail(runId, 'invalid_key', 'کلید API در آخرین آزمون نامعتبر بود.', false);
      if (!cred.settings.model) return this.fail(runId, 'model_not_selected', 'مدل پیش‌فرض در پنل اتصال انتخاب نشده است.', false);
      model = cred.settings.model; credentialId = cred.id; settings = cred.settings;
      const spent = await this.runs.todaysSpend();
      if (settings.dailyBudgetUsd && spent >= settings.dailyBudgetUsd) return this.fail(runId, 'budget_exceeded', 'سقف مصرف روزانهٔ تعیین‌شده پر شده است.', false);
    }

    const attemptId = randomUUID();
    await this.runs.transition(this.db, runId, 'running', { attempt: run.attempt + 1, attempt_id: attemptId, started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(), provider: this.cfg.modelProviderMode === 'mock' ? 'mock' : 'anthropic', model, error_code: null, error_message: null });
    if (run.source_id) await this.db.query(`UPDATE sources SET status='analyzing', updated_at=now() WHERE id=$1`, [run.source_id]);

    let bundle: JobBundle; let userPrompt: string; let schema: Record<string, unknown>; let coverage: { totalChunks: number; included: number } | null = null;
    try {
      ({ bundle, userPrompt, schema, coverage } = await this.prepare(run));
    } catch (e) {
      const code = (e as { code?: string }).code ?? 'prepare_failed';
      return this.fail(runId, code, code === 'no_external' ? 'این منبع با برچسب «عدم ارسال بیرونی» علامت خورده و به مدل فرستاده نمی‌شود.' : (e as Error).message.slice(0, 300), false);
    }
    const timeoutS = Math.min(settings.timeoutS ?? skill.limits.timeoutS, skill.limits.timeoutS);
    const token = await this.runs.issueToken(runId, credentialId, model, settings.maxOutputTokens ?? 16000, timeoutS + 60);
    const job: JobRequest = {
      jobId: runId, attemptId, skillId: skill.id, systemPrompt: buildSystemPrompt(skill.id), userPrompt, model,
      maxTurns: skill.limits.maxTurns, maxBudgetUsd: settings.perRunBudgetUsd ?? 0.5, timeoutS, maxOutputTokens: settings.maxOutputTokens ?? 16000,
      outputSchema: schema, writable: skill.mode === 'propose', proxy: { baseUrl: this.cfg.inferenceProxyPublicUrl, token }, bundle,
    };

    const ctl = new AbortController();
    const heartbeat = setInterval(async () => {
      try {
        const s = (await this.db.query(`UPDATE agent_runs SET heartbeat_at=now() WHERE id=$1 RETURNING status`, [runId])).rows[0]?.status;
        if (s === 'cancel_requested' || s === 'canceled') ctl.abort();
      } catch { /* DB blip: keep going, next tick retries */ }
    }, 2000);
    const proposals = new Map<string, Extract<RunnerEvent, { type: 'proposal' }>['op']>();
    const rejected: { path: string; reason: string }[] = [];
    let result: Extract<RunnerEvent, { type: 'result' }> | null = null;
    let error: Extract<RunnerEvent, { type: 'error' }> | null = null;
    let readChunks: string[] = [];
    let pendingText = ''; let lastFlush = Date.now();
    const flushText = async () => { if (pendingText) { const t = pendingText; pendingText = ''; await this.runs.event(this.db, run.workspace_id, runId, 'text_delta', { text: t }); } lastFlush = Date.now(); };
    try {
      const res = await fetch(`${this.cfg.runnerUrl}/jobs`, { method: 'POST', headers: { authorization: `Bearer ${this.internalToken}`, 'content-type': 'application/json' }, body: JSON.stringify(job), signal: ctl.signal });
      if (res.status === 429) throw new RetryableRunError('runner_busy');
      if (!res.ok || !res.body) throw new Error(`runner http ${res.status}`);
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const ev = JSON.parse(line) as RunnerEvent;
          if (ev.type === 'text_delta') { pendingText += ev.text; if (Date.now() - lastFlush > 250) await flushText(); continue; }
          await flushText();
          if (ev.type === 'proposal') { proposals.set(ev.op.path, ev.op); await this.runs.event(this.db, run.workspace_id, runId, 'proposal', { op: ev.op.op, path: ev.op.path }); }
          else if (ev.type === 'proposal_rejected') { rejected.push({ path: ev.path, reason: ev.reason }); await this.runs.event(this.db, run.workspace_id, runId, 'proposal_rejected', ev); }
          else if (ev.type === 'tool') await this.runs.event(this.db, run.workspace_id, runId, 'tool', { name: ev.name, summary: ev.summary });
          else if (ev.type === 'started') await this.runs.event(this.db, run.workspace_id, runId, 'started', { tools: ev.tools, model: this.cfg.modelProviderMode === 'mock' ? 'mock' : ev.model });
          else if (ev.type === 'progress') await this.runs.event(this.db, run.workspace_id, runId, 'progress', { message: ev.message });
          else if (ev.type === 'coverage') readChunks = ev.readChunks;
          else if (ev.type === 'result') result = ev;
          else if (ev.type === 'error') error = ev;
        }
      }
      await flushText();
    } catch (e) {
      clearInterval(heartbeat);
      await this.runs.revokeTokens(runId);
      const st = (await this.db.query('SELECT status FROM agent_runs WHERE id=$1', [runId])).rows[0]?.status;
      if (ctl.signal.aborted || st === 'cancel_requested') return this.canceled(run);
      if (e instanceof RetryableRunError) { await this.runs.transition(this.db, runId, 'queued', { error_code: 'runner_busy' }); throw e; }
      return this.fail(runId, 'runner_unreachable', 'سرویس اجرای عامل در دسترس نبود.', true, run.source_id);
    } finally { clearInterval(heartbeat); }
    await this.runs.revokeTokens(runId);

    if ((await this.db.query('SELECT status FROM agent_runs WHERE id=$1', [runId])).rows[0]?.status === 'cancel_requested') return this.canceled(run);
    const usageCost = result?.costUsd ?? null;
    if (usageCost !== null && this.cfg.modelProviderMode !== 'mock') await this.db.query('UPDATE agent_runs SET cost_estimate_usd=$2 WHERE id=$1', [runId, usageCost]);
    if (error || !result) {
      const code = error?.code ?? 'no_result';
      if (error?.retryable && run.attempt + 1 < 3) {
        await this.runs.transition(this.db, runId, 'queued', { error_code: code, error_message: error?.message ?? null });
        throw new RetryableRunError(code);
      }
      return this.fail(runId, code, error?.message ?? 'اجرا بدون نتیجه پایان یافت.', !!error?.retryable, run.source_id);
    }
    try {
      await this.finalize(run, bundle, result, proposals, rejected, readChunks, coverage);
    } catch (e) {
      log.error('run.finalize_failed', { runId, error: (e as Error).message });
      return this.fail(runId, 'finalize_failed', (e as Error).message.slice(0, 300), false, run.source_id);
    }
  }

  private async prepare(run: Record<string, any>): Promise<{ bundle: JobBundle; userPrompt: string; schema: Record<string, unknown>; coverage: { totalChunks: number; included: number } | null }> {
    const input = run.input ?? {};
    if (run.skill_id === 'ingest') {
      const { bundle, coverage } = await buildIngestBundle(this.db, run.workspace_id, run.source_id);
      const partial = coverage.included < coverage.totalChunks;
      const prompt = `Ingest the source "${bundle.source!.title}" into this vault.\n\nRead the whole source with read_source (it has ${bundle.source!.chunkKeys.length} passages${partial ? `; only ${coverage.included} of ${coverage.totalChunks} passages fit this run's budget — list the rest in unreadParts` : ''}). Check existing pages with list_index, search_wiki and read_note. Then propose the source page and the concept/entity pages it needs with propose_change (cite passages with sourceKeys). Finally return the structured report.`;
      return { bundle, userPrompt: prompt, schema: INGEST_OUTPUT_SCHEMA as never, coverage };
    }
    if (run.skill_id === 'query') {
      const bundle = await buildQueryBundle(this.db, run.workspace_id, input.question, run.scope);
      const prompt = `Answer from this vault only.\n\nQuestion: ${input.question}\n\nStart with list_index or search_wiki, read the relevant pages with read_note, follow links one hop at a time while they add something. Write the answer in plain text with [Cn] markers first, then call StructuredOutput.`;
      return { bundle, userPrompt: prompt, schema: QUERY_OUTPUT_SCHEMA as never, coverage: null };
    }
    if (run.skill_id === 'report' || run.skill_id === 'write') {
      const bundle = await buildDocsBundle(this.db, run.workspace_id, input.documentIds ?? []);
      const b = input.brief ?? {};
      const prompt = `Draft a ${b.template ?? 'report'} titled "${b.title}". Goal: ${b.goal || '-'}. Audience: ${b.audience || '-'}. Language: ${b.language === 'en' ? 'English' : 'Persian'}. Length: ${b.length ?? 'medium'}.\nUse only the pages listed by list_index (the owner selected them). Read them with read_note. Produce an outline and the section texts with [Cn] markers, and list what the selected pages do not cover.`;
      return { bundle, userPrompt: prompt, schema: STUDIO_OUTPUT_SCHEMA as never, coverage: null };
    }
    if (run.skill_id === 'quiz') {
      const bundle = await buildDocsBundle(this.db, run.workspace_id, input.documentIds ?? []);
      const prompt = `Write ${Math.min(Number(input.count ?? 5), 10)} multiple-choice questions that test understanding of the pages listed by list_index (read them with read_note). Each question must be answerable from one passage; give its key and an exact quote.`;
      return { bundle, userPrompt: prompt, schema: QUIZ_OUTPUT_SCHEMA as never, coverage: null };
    }
    throw new Error('unsupported skill');
  }

  private async finalize(run: Record<string, any>, bundle: JobBundle, result: Extract<RunnerEvent, { type: 'result' }>, proposals: Map<string, any>, rejected: { path: string; reason: string }[], readChunks: string[], coverage: { totalChunks: number; included: number } | null) {
    const ws = run.workspace_id; const runId = run.id;
    const s = (result.structured ?? {}) as Record<string, any>;
    const provider = this.cfg.modelProviderMode === 'mock' ? 'mock' : 'anthropic';
    if (run.skill_id === 'ingest') {
      const allowed = new Set(bundle.chunks.map(c => c.key));
      const { ops, issues } = validateAgentOps([...proposals.values()], { allowedSourceRefs: allowed });
      const sourceKeys = bundle.source?.chunkKeys ?? [];
      const unread = sourceKeys.filter(k => !readChunks.includes(k));
      const partial = (coverage && coverage.included < coverage.totalChunks) || unread.length > 0;
      if (!ops.length) {
        await this.db.query(`UPDATE sources SET status='analysis_failed', status_detail=$2, updated_at=now() WHERE id=$1`, [run.source_id, 'no valid proposals' + (issues.length ? ': ' + issues[0] : '')]);
        await this.runs.transition(this.db, runId, 'failed', { finished_at: new Date().toISOString(), error_code: 'no_valid_proposals', error_message: issues.slice(0, 3).join('; ') || 'عامل پیشنهادی ارائه نکرد.', result: { issues, rejected } });
        return;
      }
      const src = (await this.db.query('SELECT title, current_version_id FROM sources WHERE id=$1', [run.source_id])).rows[0];
      const csId = await this.engine.propose({
        workspaceId: ws, runId, origin: 'agent', title: String(s.title ?? `ورود «${src.title}»`), summary: String(s.summary ?? ''),
        ops, sourceRefs: [{ sourceId: run.source_id, sourceVersionId: src.current_version_id }],
        report: { sourceLabel: src.title, contradictions: s.contradictions ?? [], gaps: s.gaps ?? [], unreadParts: s.unreadParts ?? [], validationIssues: issues, rejectedProposals: rejected, provider,
          coverage: { sourcePassages: sourceKeys.length, readPassages: sourceKeys.length - unread.length, totalSourceChunks: coverage?.totalChunks ?? sourceKeys.length, partial } },
      });
      await this.db.query(`UPDATE sources SET status='awaiting_review', status_detail=$2, updated_at=now() WHERE id=$1`, [run.source_id, partial ? 'پوشش ناقص: بخشی از منبع خوانده نشد' : null]);
      await this.runs.transition(this.db, runId, 'waiting_for_review', { finished_at: new Date().toISOString(), result: { changesetId: csId, proposals: ops.length, partial } });
      return;
    }
    if (run.skill_id === 'query') {
      const v = validateCitations(String(s.answer ?? ''), s.citations ?? [], bundle.chunks);
      await withTx(this.db, async tx => {
        const msg = await tx.query(
          `INSERT INTO messages(workspace_id, conversation_id, role, mode, content, meta, run_id) VALUES ($1,$2,'assistant','model_answer',$3,$4,$5) RETURNING id`,
          [ws, run.conversation_id, String(s.answer ?? result.text ?? ''), { notCovered: s.notCovered ?? [], conflicts: s.conflicts ?? [], read: s.read ?? [], provider, validation: { unbacked: v.unbacked, fabricated: v.fabricated, valid: v.validCount, total: v.checks.length } }, runId]);
        for (const c of v.checks) await this.insertCitation(tx, ws, runId, c, { message_id: msg.rows[0].id });
        await tx.query('UPDATE conversations SET updated_at=now() WHERE id=$1', [run.conversation_id]);
      });
      await this.runs.transition(this.db, runId, 'succeeded', { finished_at: new Date().toISOString(), result: { citations: v.checks.length, valid: v.validCount, unbacked: v.unbacked, fabricated: v.fabricated } });
      return;
    }
    if (run.skill_id === 'report' || run.skill_id === 'write') {
      const sections = (s.sections ?? []) as { heading: string; body: string }[];
      const content = sections.map(x => `## ${x.heading}\n\n${x.body}`).join('\n\n') + ((s.notCovered ?? []).length ? `\n\n## خارج از پوشش منابع\n\n${(s.notCovered as string[]).map(n => `- ${n}`).join('\n')}` : '');
      const v = validateCitations(content, s.citations ?? [], bundle.chunks);
      await withTx(this.db, async tx => {
        const o = (await tx.query('SELECT current_version FROM outputs WHERE id=$1 AND workspace_id=$2 FOR UPDATE', [run.input.outputId, ws])).rows[0];
        const ver = (o?.current_version ?? 0) + 1;
        const ov = await tx.query(`INSERT INTO output_versions(workspace_id, output_id, version, outline, content, source_refs, author_kind, run_id) VALUES ($1,$2,$3,$4,$5,$6,'agent',$7) RETURNING id`,
          [ws, run.input.outputId, ver, JSON.stringify(s.outline ?? []), content, JSON.stringify(bundle.docs.map(d => ({ documentId: d.documentId, revisionId: d.revisionId, path: d.path }))), runId]);
        await tx.query('UPDATE outputs SET current_version=$2, updated_at=now() WHERE id=$1', [run.input.outputId, ver]);
        for (const c of v.checks) await this.insertCitation(tx, ws, runId, c, { output_version_id: ov.rows[0].id });
      });
      await this.runs.transition(this.db, runId, 'succeeded', { finished_at: new Date().toISOString(), result: { sections: sections.length, valid: v.validCount, unbacked: v.unbacked } });
      return;
    }
    if (run.skill_id === 'quiz') {
      const byKey = new Map(bundle.chunks.map(c => [c.key, c]));
      let kept = 0; const dropped: string[] = [];
      for (const q of (s.questions ?? []) as Record<string, any>[]) {
        const chunk = byKey.get(String(q.citationKey));
        const v = validateCitations('', [{ key: q.citationKey, quote: q.quote }], bundle.chunks);
        const ok = chunk && v.validCount === 1 && Array.isArray(q.choices) && q.choices.length >= 2 && q.choices.length <= 6 && Number.isInteger(q.answerIndex) && q.answerIndex >= 0 && q.answerIndex < q.choices.length;
        if (!ok) { dropped.push(String(q.question ?? '').slice(0, 80)); continue; }
        await this.db.query(`INSERT INTO quiz_items(workspace_id, run_id, question, choices, answer_index, explanation, document_id, revision_id, excerpt) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [ws, runId, String(q.question).slice(0, 1000), JSON.stringify(q.choices.map(String)), q.answerIndex, String(q.explanation ?? '').slice(0, 2000), chunk!.documentId, chunk!.revisionId, excerptOf(chunk!).excerpt]);
        kept++;
      }
      await this.runs.transition(this.db, runId, kept ? 'succeeded' : 'failed', { finished_at: new Date().toISOString(), result: { kept, dropped }, ...(kept ? {} : { error_code: 'no_valid_questions', error_message: 'هیچ سؤال معتبر و مستندی تولید نشد.' }) });
    }
  }

  private async insertCitation(tx: { query: Db['query'] }, ws: string, runId: string, c: ReturnType<typeof validateCitations>['checks'][number], link: Record<string, string>) {
    const ch = c.chunk;
    const { excerpt, excerptSha256 } = ch ? excerptOf(ch) : { excerpt: '', excerptSha256: '' };
    await tx.query(
      `INSERT INTO citations(workspace_id, run_id, citation_key, message_id, output_version_id, document_id, revision_id, source_version_id, title, heading, start_offset, end_offset, page, excerpt, excerpt_sha256, used, validation)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,true,$16) ON CONFLICT (run_id, citation_key) DO NOTHING`,
      [ws, runId, c.key, link.message_id ?? null, link.output_version_id ?? null, ch?.documentId ?? null, ch?.revisionId ?? null, ch?.sourceVersionId ?? null, ch?.title ?? '(unknown)', ch?.heading ?? null, ch?.start ?? 0, ch?.end ?? 0, ch?.page ?? null, excerpt, excerptSha256, { valid: c.valid, reasons: c.reasons, quote: c.quote.slice(0, 500) }]);
  }

  private async fail(runId: string, code: string, message: string, retryable: boolean, sourceId?: string | null) {
    await this.runs.revokeTokens(runId);
    const st = (await this.db.query('SELECT status, workspace_id, conversation_id, skill_id, source_id FROM agent_runs WHERE id=$1', [runId])).rows[0];
    if (!st) return;
    const to = st.status === 'queued' || st.status === 'running' || st.status === 'cancel_requested' ? 'failed' : null;
    if (to) await this.runs.transition(this.db, runId, 'failed', { finished_at: new Date().toISOString(), error_code: code, error_message: message, retryable });
    const sid = sourceId ?? st.source_id;
    if (sid) await this.db.query(`UPDATE sources SET status='analysis_failed', status_detail=$2, updated_at=now() WHERE id=$1 AND status IN ('analyzing','queued','ready_for_analysis')`, [sid, `${code}: ${message}`.slice(0, 300)]);
    if (st.skill_id === 'query' && st.conversation_id) {
      await this.db.query(`INSERT INTO messages(workspace_id, conversation_id, role, mode, content, meta, run_id) VALUES ($1,$2,'assistant','error',$3,$4,$5)`, [st.workspace_id, st.conversation_id, message, { code }, runId]);
    }
    await audit(this.db, { workspaceId: st.workspace_id, action: 'run.failed', targetType: 'run', targetId: runId, result: 'failure', meta: { code } });
  }

  private async canceled(run: Record<string, any>) {
    await this.runs.transition(this.db, run.id, 'canceled', { finished_at: new Date().toISOString() }).catch(() => undefined);
    if (run.source_id) await this.db.query(`UPDATE sources SET status='canceled', updated_at=now() WHERE id=$1 AND status='analyzing'`, [run.source_id]);
  }
}
