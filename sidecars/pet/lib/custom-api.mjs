// Direct HTTP clients for user-configured OpenAI-compatible, Anthropic, and Gemini APIs.
export const DEFAULT_BASE_URLS = Object.freeze({
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
});

export function resolveEndpoint(provider, baseUrl, model) {
  if (!Object.hasOwn(DEFAULT_BASE_URLS, provider)) throw new Error(`Unsupported AI provider: ${provider}`);
  const raw = (baseUrl || DEFAULT_BASE_URLS[provider] || '').trim().replace(/\/+$/, '');
  if (provider === 'openai') {
    return /\/chat\/completions$/i.test(raw) ? raw : `${raw}/chat/completions`;
  }
  if (provider === 'anthropic') {
    if (/\/messages$/i.test(raw)) return raw;
    return /\/v\d+$/i.test(raw) ? `${raw}/messages` : `${raw}/v1/messages`;
  }
  const cleanModel = encodeURIComponent(String(model || '').trim().replace(/^models\//i, ''));
  if (/:generateContent(?:$|\?)/i.test(raw)) return raw;
  if (/\/models$/i.test(raw)) return `${raw}/${cleanModel}:generateContent`;
  if (/\/v1(?:beta|alpha)?$/i.test(raw)) return `${raw}/models/${cleanModel}:generateContent`;
  return `${raw}/v1beta/models/${cleanModel}:generateContent`;
}

export function isCustomApiConfigured(ai, env = process.env) {
  if (!ai || !Object.hasOwn(DEFAULT_BASE_URLS, ai.provider)) return false;
  if (!ai.apiModel?.trim()) return false;
  if (ai.apiBaseUrl?.trim()) return true;
  return Boolean(ai.apiKey?.trim() || env.HAGEMI_API_KEY?.trim());
}

export function stripThinkTags(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function buildRequest(provider, key, model, prompt) {
  if (provider === 'openai') {
    return {
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: { model, messages: [{ role: 'user', content: prompt }], max_tokens: 160 },
    };
  }
  if (provider === 'anthropic') {
    return {
      headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', ...(key ? { 'x-api-key': key } : {}) },
      body: { model, max_tokens: 160, messages: [{ role: 'user', content: prompt }] },
    };
  }
  return {
    headers: { 'Content-Type': 'application/json', ...(key ? { 'x-goog-api-key': key } : {}) },
    body: { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 160 } },
  };
}

function parseProviderResponse(provider, data) {
  if (provider === 'openai') {
    const content = data?.choices?.[0]?.message?.content;
    const raw = Array.isArray(content)
      ? content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('')
      : typeof content === 'string' ? content : '';
    const totalTokens = Number(data?.usage?.total_tokens)
      || ((Number(data?.usage?.prompt_tokens) || 0) + (Number(data?.usage?.completion_tokens) || 0))
      || null;
    return { text: stripThinkTags(raw), totalTokens };
  }
  if (provider === 'anthropic') {
    const raw = (data?.content || [])
      .filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('');
    const totalTokens = ((Number(data?.usage?.input_tokens) || 0) + (Number(data?.usage?.output_tokens) || 0)) || null;
    return { text: stripThinkTags(raw), totalTokens };
  }
  const raw = (data?.candidates?.[0]?.content?.parts || [])
    .filter(part => part && !part.thought && typeof part.text === 'string')
    .map(part => part.text)
    .join('');
  const totalTokens = Number(data?.usageMetadata?.totalTokenCount)
    || ((Number(data?.usageMetadata?.promptTokenCount) || 0) + (Number(data?.usageMetadata?.candidatesTokenCount) || 0))
    || null;
  return { text: stripThinkTags(raw), totalTokens };
}

export async function callCustomApi({ provider, baseUrl, apiKey, model, prompt, timeoutMs = 30000, fetchImpl = fetch, env = process.env }) {
  const key = (apiKey || env.HAGEMI_API_KEY || '').trim();
  const url = resolveEndpoint(provider, baseUrl, model);
  const { headers, body } = buildRequest(provider, key, model, prompt);
  const res = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 200);
    throw new Error(`${provider} HTTP ${res.status}: ${detail}`);
  }
  const data = await res.json();
  return parseProviderResponse(provider, data);
}
