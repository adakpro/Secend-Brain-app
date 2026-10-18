import { afterEach, expect, it, vi } from 'vitest';
import { listOpenAIModels, testOpenAIGeneration } from '../../src/providers/openai';

afterEach(() => vi.unstubAllGlobals());
it('uses Bearer authentication and lists models without generating text', async () => {
  const f = vi.fn().mockResolvedValue(Response.json({ data: [{ id: 'model-b' }, { id: 'model-a' }] })); vi.stubGlobal('fetch', f);
  expect(await listOpenAIModels('test-key')).toEqual([{ id: 'model-a' }, { id: 'model-b' }]);
  expect(f.mock.calls[0][0]).toBe('https://api.openai.com/v1/models');
  expect(f.mock.calls[0][1].headers.authorization).toBe('Bearer test-key');
});
it('distinguishes exhausted credit from a retryable rate limit without leaking provider text', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: { code: 'insufficient_quota', message: 'secret upstream text' } }, { status: 429 })));
  await expect(testOpenAIGeneration('test-key', 'model')).rejects.toMatchObject({ code: 'insufficient_credit', retryable: false });
});
it('does not mark a truncated generation test as successful', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ status: 'incomplete', usage: {} })));
  await expect(testOpenAIGeneration('test-key', 'model')).rejects.toMatchObject({ code: 'bad_request' });
});
