import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { generateText, isTextAIEnabled, describeProviders } = await import('../src/ai/llm.js');
const groq = await import('../src/ai/providers/groq.js');

const realFetch = globalThis.fetch;
let calls;

function mockFetch(handler) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  delete process.env.GROQ_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.AI_TEXT_PROVIDERS;
  delete process.env.GROQ_MODEL;
});
afterEach(() => { globalThis.fetch = realFetch; });

test('sem chaves: IA desabilitada e generateText devolve null', async () => {
  assert.equal(isTextAIEnabled(), false);
  assert.equal(await generateText('oi'), null);
});

test('Groq responde: devolve texto e provedor, com reasoning_effort baixo', async () => {
  process.env.GROQ_API_KEY = 'teste';
  mockFetch(() => json(200, { choices: [{ message: { content: '  {"ok":true}  ' } }] }));

  const r = await generateText('prompt', { task: 'parse' });
  assert.deepEqual(r, { text: '{"ok":true}', provider: 'groq' });

  const body = JSON.parse(calls[0].init.body);
  assert.equal(calls[0].url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(body.model, 'openai/gpt-oss-120b');
  assert.equal(body.reasoning_effort, 'low');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer teste');
});

test('modelo não gpt-oss não recebe reasoning_effort', async () => {
  process.env.GROQ_API_KEY = 'teste';
  process.env.GROQ_MODEL = 'llama-3.3-70b-versatile';
  mockFetch(() => json(200, { choices: [{ message: { content: 'x' } }] }));
  await generateText('p');
  assert.equal(JSON.parse(calls[0].init.body).reasoning_effort, undefined);
});

test('cota estourada (429) sem outro provedor: devolve null sem lançar', async () => {
  process.env.GROQ_API_KEY = 'teste';
  mockFetch(() => json(429, { error: { message: 'Rate limit reached' } }));
  assert.equal(await generateText('p'), null);
});

test('erro do Groq carrega status e retryable', async () => {
  process.env.GROQ_API_KEY = 'teste';
  mockFetch(() => json(429, { error: { message: 'limite' } }));
  await assert.rejects(groq.generateText('p'), (e) => e.status === 429 && e.retryable === true);
});

test('AI_TEXT_PROVIDERS define a ordem e ignora nomes desconhecidos', () => {
  process.env.GROQ_API_KEY = 'a';
  process.env.GEMINI_API_KEY = 'b';
  process.env.AI_TEXT_PROVIDERS = 'gemini, foo, groq';
  assert.deepEqual(describeProviders().text, ['gemini', 'groq']);
});

test('transcribe envia multipart para o Whisper em português', async () => {
  process.env.GROQ_API_KEY = 'teste';
  mockFetch(() => json(200, { text: ' gastei cinquenta no mercado ' }));
  const text = await groq.transcribe(Buffer.from('fake'), 'audio/ogg');
  assert.equal(text, 'gastei cinquenta no mercado');
  assert.equal(calls[0].url, 'https://api.groq.com/openai/v1/audio/transcriptions');
  const form = calls[0].init.body;
  assert.equal(form.get('model'), 'whisper-large-v3-turbo');
  assert.equal(form.get('language'), 'pt');
});
