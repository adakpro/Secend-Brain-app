import { ProviderError, mapProviderError } from './anthropic';

export const OPENAI_API = 'https://api.openai.com';

export async function openAICall(path: string, key: string, body?: unknown, baseUrl = OPENAI_API) {
  try {
    const res = await fetch(baseUrl + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 429 && data.error?.code === 'insufficient_quota') throw new ProviderError('insufficient_credit', 'اعتبار یا سهمیهٔ حساب OpenAI کافی نیست.', false, 429);
      throw mapProviderError(res.status, data, res.headers.get('retry-after'));
    }
    return data as Record<string, any>;
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    if (['TimeoutError', 'AbortError'].includes((e as Error).name)) throw new ProviderError('timeout', 'پاسخ سرویس مدل در زمان مجاز نرسید.', true);
    throw new ProviderError('network', 'اتصال به سرویس مدل برقرار نشد.', true);
  }
}

export async function listOpenAIModels(key: string, baseUrl = OPENAI_API): Promise<{ id: string; display_name?: string }[]> {
  const body = await openAICall('/v1/models', key, undefined, baseUrl);
  // Visibility does not guarantee Responses/tool support; the explicit generation test checks it.
  return (Array.isArray(body.data) ? body.data : []).map((m: { id: string }) => ({ id: m.id })).sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id));
}

export async function testOpenAIGeneration(key: string, model: string, baseUrl = OPENAI_API) {
  const body = await openAICall('/v1/responses', key, { model, input: 'Reply with the single word: ok', max_output_tokens: 256, store: false }, baseUrl);
  if (body.status !== 'completed') throw new ProviderError('bad_request', 'آزمون تولید متن کامل نشد؛ مدل یا سقف خروجی را بررسی کنید.', false);
  return { model: body.model, usage: body.usage, stopReason: body.status };
}
