import assert from 'node:assert/strict';
import { test } from 'node:test';
import { callCustomApi, DEFAULT_BASE_URLS, isCustomApiConfigured, resolveEndpoint } from '../sidecars/pet/lib/custom-api.mjs';

test('resolveEndpoint handles default, base, trailing-slash, and full URLs for all providers', () => {
  assert.equal(resolveEndpoint('openai', '', 'gpt-4o-mini'), `${DEFAULT_BASE_URLS.openai}/chat/completions`);
  assert.equal(resolveEndpoint('openai', 'https://api.deepseek.com/v1/', 'deepseek-chat'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(resolveEndpoint('openai', 'http://127.0.0.1:11434/v1/chat/completions', 'llama3'), 'http://127.0.0.1:11434/v1/chat/completions');

  assert.equal(resolveEndpoint('anthropic', '', 'claude-sonnet-4-5'), `${DEFAULT_BASE_URLS.anthropic}/v1/messages`.replace('/v1/v1', '/v1'));
  assert.equal(resolveEndpoint('anthropic', 'https://proxy.example.com', 'claude-sonnet-4-5'), 'https://proxy.example.com/v1/messages');
  assert.equal(resolveEndpoint('anthropic', 'https://proxy.example.com/v1/', 'claude-sonnet-4-5'), 'https://proxy.example.com/v1/messages');
  assert.equal(resolveEndpoint('anthropic', 'https://proxy.example.com/v1/messages', 'claude-sonnet-4-5'), 'https://proxy.example.com/v1/messages');

  assert.equal(
    resolveEndpoint('gemini', '', 'gemini-2.5-flash'),
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
  );
  assert.equal(
    resolveEndpoint('gemini', 'https://gemini-proxy.example.com/', 'models/gemini-2.5-flash'),
    'https://gemini-proxy.example.com/v1beta/models/gemini-2.5-flash:generateContent',
  );
  assert.equal(
    resolveEndpoint('gemini', 'https://gemini-proxy.example.com/v1', 'gemini-2.5-flash'),
    'https://gemini-proxy.example.com/v1/models/gemini-2.5-flash:generateContent',
  );
  assert.equal(
    resolveEndpoint('gemini', 'https://gemini-proxy.example.com/v1beta/models', 'gemini-2.5-flash'),
    'https://gemini-proxy.example.com/v1beta/models/gemini-2.5-flash:generateContent',
  );
  assert.equal(
    resolveEndpoint('gemini', 'https://gemini-proxy.example.com/custom:generateContent', 'gemini-2.5-flash'),
    'https://gemini-proxy.example.com/custom:generateContent',
  );
});

test('isCustomApiConfigured enforces model, default-endpoint key, and allows keyless custom URLs', () => {
  assert.equal(isCustomApiConfigured({ provider: 'antigravity', apiModel: 'x', apiKey: 'k' }, {}), false);
  assert.equal(isCustomApiConfigured({ provider: 'openai', apiBaseUrl: '', apiKey: '', apiModel: 'gpt-4o-mini' }, {}), false);
  assert.equal(isCustomApiConfigured({ provider: 'openai', apiBaseUrl: '', apiKey: 'sk-test', apiModel: 'gpt-4o-mini' }, {}), true);
  assert.equal(isCustomApiConfigured({ provider: 'gemini', apiBaseUrl: '', apiKey: '', apiModel: 'gemini-2.5-flash' }, { HAGEMI_API_KEY: 'env-key' }), true);
  assert.equal(isCustomApiConfigured({ provider: 'openai', apiBaseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', apiModel: 'qwen2.5' }, {}), true);
  assert.equal(isCustomApiConfigured({ provider: 'anthropic', apiBaseUrl: 'https://proxy.local', apiKey: '', apiModel: '   ' }, {}), false);
});

test('callCustomApi formats OpenAI-compatible requests and parses array content + think tags', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({
      choices: [{ message: { content: [{ type: 'text', text: '<think>secret</think>\nsmug|Extremely clean, nya.' }] } }],
      usage: { total_tokens: 42 },
    }), { status: 200 });
  };
  const result = await callCustomApi({
    provider: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-123',
    model: 'deepseek-chat',
    prompt: 'hello',
    fetchImpl,
  });
  assert.equal(seen.url, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(seen.init.headers.Authorization, 'Bearer sk-123');
  assert.equal(seen.body.model, 'deepseek-chat');
  assert.deepEqual(seen.body.messages, [{ role: 'user', content: 'hello' }]);
  assert.deepEqual(result, { text: 'smug|Extremely clean, nya.', totalTokens: 42 });
});

test('callCustomApi formats Anthropic requests and sums input/output tokens', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({
      content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'happy|Good job, big cat!' }],
      usage: { input_tokens: 100, output_tokens: 15 },
    }), { status: 200 });
  };
  const result = await callCustomApi({
    provider: 'anthropic',
    baseUrl: '',
    apiKey: 'ant-key',
    model: 'claude-sonnet-4-5',
    prompt: 'hi',
    fetchImpl,
  });
  assert.equal(seen.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen.init.headers['x-api-key'], 'ant-key');
  assert.equal(seen.init.headers['anthropic-version'], '2023-06-01');
  assert.equal(seen.body.model, 'claude-sonnet-4-5');
  assert.deepEqual(result, { text: 'happy|Good job, big cat!', totalTokens: 115 });
});

test('callCustomApi formats Gemini requests using x-goog-api-key header and skips thought parts', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ thought: true, text: 'internal' }, { text: 'wink|Extremely shiny, nya.' }] } }],
      usageMetadata: { totalTokenCount: 77 },
    }), { status: 200 });
  };
  const result = await callCustomApi({
    provider: 'gemini',
    baseUrl: '',
    apiKey: '',
    model: 'gemini-2.5-flash',
    prompt: 'yo',
    fetchImpl,
    env: { HAGEMI_API_KEY: 'gem-env-key' },
  });
  assert.equal(seen.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
  assert.equal(seen.init.headers['x-goog-api-key'], 'gem-env-key');
  assert.ok(!seen.url.includes('gem-env-key'));
  assert.equal(seen.body.contents[0].parts[0].text, 'yo');
  assert.deepEqual(result, { text: 'wink|Extremely shiny, nya.', totalTokens: 77 });
});

test('callCustomApi throws concise HTTP errors without exposing API keys', async () => {
  const secret = 'sk-super-secret-token-value';
  const fetchImpl = async () => new Response('invalid request', { status: 401 });
  await assert.rejects(
    () => callCustomApi({ provider: 'openai', baseUrl: '', apiKey: secret, model: 'gpt-4o-mini', prompt: 'hi', fetchImpl }),
    err => {
      assert.match(err.message, /openai HTTP 401: invalid request/);
      assert.ok(!err.message.includes(secret));
      return true;
    },
  );
});
