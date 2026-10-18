import { z } from 'zod';
import type { JobRequest, RunnerEvent } from '@sb/contracts';
import { buildTools } from './tools';

/** Responses function loop. All handlers use the same scoped bundle as Claude. */
export async function runOpenAI(job: JobRequest, emit: (e: RunnerEvent) => void, signal: AbortSignal) {
  const { functions, readChunks } = buildTools(job, emit);
  const finalSchema = z.fromJSONSchema(job.outputSchema);
  const input: Record<string, unknown>[] = [{ role: 'user', content: job.userPrompt }];
  const tools = functions.map(f => ({ type: 'function', name: f.name, description: f.description, parameters: f.parameters, strict: false }));
  tools.push({ type: 'function', name: 'StructuredOutput', description: 'Finish the run with the structured report after reading sources and proposing changes.', parameters: job.outputSchema, strict: false });
  const usage = { input_tokens: 0, output_tokens: 0 };
  emit({ type: 'started', tools: tools.map(t => t.name), model: job.model });
  for (let turn = 1; turn <= job.maxTurns; turn++) {
    const res = await fetch(`${job.proxy.baseUrl}/v1/responses`, {
      method: 'POST', headers: { authorization: `Bearer ${job.proxy.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: job.model, instructions: job.systemPrompt, input, tools, parallel_tool_calls: false, max_output_tokens: job.maxOutputTokens, store: false }), signal,
    });
    const body = await res.json() as Record<string, any>;
    if (!res.ok) {
      const code = body.error?.code ?? (res.status === 429 ? 'rate_limited' : res.status >= 500 ? 'server_error' : 'provider_error');
      emit({ type: 'error', code, message: 'درخواست OpenAI ناموفق بود؛ وضعیت اتصال و محدودیت مصرف را بررسی کنید.', retryable: ['rate_limited', 'server_error', 'timeout', 'network'].includes(code) });
      return;
    }
    usage.input_tokens += body.usage?.input_tokens ?? 0;
    usage.output_tokens += body.usage?.output_tokens ?? 0;
    if (body.status !== 'completed') {
      emit({ type: 'error', code: 'incomplete_response', message: 'پاسخ مدل کامل نشد؛ سقف خروجی را بررسی کنید.', retryable: false }); return;
    }
    // Replay every item, including reasoning, for stateless continuation.
    const output = Array.isArray(body.output) ? body.output : [];
    input.push(...output);
    let called = false;
    for (const item of output) {
      if (item.type === 'message') for (const c of item.content ?? []) {
        if (c.type === 'output_text') emit({ type: 'text_delta', text: c.text });
      }
      if (item.type !== 'function_call') continue;
      called = true;
      let result: unknown;
      try {
        const args = JSON.parse(item.arguments);
        if (item.name === 'StructuredOutput') {
          const structured = finalSchema.parse(args);
          emit({ type: 'coverage', readChunks: [...readChunks] });
          emit({ type: 'result', structured, text: '', usage, costUsd: null, numTurns: turn, subtype: 'success' }); return;
        }
        const fn = functions.find(f => f.name === item.name);
        result = fn ? await fn.execute(args) : { error: 'tool not allowed' };
      } catch { result = { error: 'invalid tool arguments; use the supplied schema' }; }
      input.push({ type: 'function_call_output', call_id: item.call_id, output: JSON.stringify(result) });
    }
    if (!called) input.push({ role: 'user', content: 'Continue using the available tools; finish by calling StructuredOutput.' });
  }
  emit({ type: 'error', code: 'max_turns', message: 'تعداد دورهای مجاز اجرا تمام شد.', retryable: false });
}
