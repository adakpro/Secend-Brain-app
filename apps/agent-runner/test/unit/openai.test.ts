import { afterEach, describe, expect, it, vi } from 'vitest';
import { runOpenAI } from '../../src/openai';
import type { JobRequest, RunnerEvent } from '@sb/contracts';

const job: JobRequest = {
  provider: 'openai', jobId: 'job', attemptId: 'attempt', skillId: 'query', systemPrompt: 'Use vault only', userPrompt: 'Question', model: 'test-model',
  maxTurns: 3, maxBudgetUsd: 1, timeoutS: 30, maxOutputTokens: 1000, writable: false,
  outputSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
  proxy: { baseUrl: 'http://proxy/inference', token: 'sb_test' },
  bundle: { index: [], docs: [], chunks: [] },
};

afterEach(() => vi.unstubAllGlobals());
describe('OpenAI scoped function loop', () => {
  it('replays reasoning and tool results before emitting a validated final result', async () => {
    const reasoning = { type: 'reasoning', id: 'reason', encrypted_content: 'opaque', summary: [] };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ status: 'completed', output: [reasoning, { type: 'function_call', call_id: 'call', name: 'list_index', arguments: '{}' }], usage: { input_tokens: 10, output_tokens: 5 } }))
      .mockResolvedValueOnce(Response.json({ status: 'completed', output: [{ type: 'function_call', call_id: 'final', name: 'StructuredOutput', arguments: '{"answer":"No evidence"}' }], usage: { input_tokens: 20, output_tokens: 6 } }));
    vi.stubGlobal('fetch', fetchMock);
    const events: RunnerEvent[] = [];
    await runOpenAI(job, e => events.push(e), new AbortController().signal);
    const request = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(request.input).toContainEqual(reasoning);
    expect(request.input).toContainEqual(expect.objectContaining({ type: 'function_call_output', call_id: 'call' }));
    expect(request.tools.some((t: { name: string }) => t.name === 'propose_change')).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ type: 'result', structured: { answer: 'No evidence' }, usage: { input_tokens: 30, output_tokens: 11 } }));
  });

  it('does not emit a result for malformed output or an incomplete response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ status: 'incomplete', output: [], usage: {} })));
    const events: RunnerEvent[] = [];
    await runOpenAI(job, e => events.push(e), new AbortController().signal);
    expect(events.some(e => e.type === 'result')).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', code: 'incomplete_response' }));
  });

  it('rejects writes outside scope even when proposed by a model', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ status: 'completed', output: [{ type: 'function_call', call_id: 'bad', name: 'propose_change', arguments: JSON.stringify({ op: 'create', path: '../secrets/key', content: 'x' }) }] }))
      .mockResolvedValueOnce(Response.json({ status: 'completed', output: [{ type: 'function_call', call_id: 'final', name: 'StructuredOutput', arguments: '{"answer":"done"}' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const events: RunnerEvent[] = [];
    await runOpenAI({ ...job, writable: true }, e => events.push(e), new AbortController().signal);
    expect(events.some(e => e.type === 'proposal')).toBe(false);
    expect(events.some(e => e.type === 'proposal_rejected')).toBe(true);
  });
});
