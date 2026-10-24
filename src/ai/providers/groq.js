// Provedor Groq — API compatível com a da OpenAI.
// Usado para texto (parse, resposta sarcástica, insights) e transcrição de áudio.
//
// Limites do plano gratuito são POR MODELO (pedidos/dia e tokens/dia).
// Consulte o painel em console.groq.com → Settings → Limits.

import { ProviderError } from './errors.js';

const BASE_URL = 'https://api.groq.com/openai/v1';
const DEFAULT_TEXT_MODEL = 'openai/gpt-oss-120b';
const DEFAULT_STT_MODEL = 'whisper-large-v3-turbo';
const TIMEOUT_MS = 30_000;


export const name = 'groq';

export function isConfigured() {
  return Boolean(process.env.GROQ_API_KEY);
}

function textModel() {
  return process.env.GROQ_MODEL || DEFAULT_TEXT_MODEL;
}

async function request(path, init) {
  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, ...init.headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new ProviderError(name, `falha de rede: ${error.message}`, { retryable: true });
  }

  if (!res.ok) {
    // Nunca logar o corpo inteiro: pode ecoar parte da requisição.
    let detail = '';
    try {
      const body = await res.json();
      detail = body?.error?.message ? ` — ${String(body.error.message).slice(0, 200)}` : '';
    } catch { /* corpo não-JSON */ }
    const retryable = res.status === 429 || res.status >= 500;
    throw new ProviderError(name, `HTTP ${res.status}${detail}`, { status: res.status, retryable });
  }

  return res.json();
}

/**
 * Gera texto a partir de um prompt.
 * @returns {Promise<string>} texto da resposta (pode ser string vazia)
 */
export async function generateText(prompt, { maxTokens = 1024, temperature = 0.4 } = {}) {
  const model = textModel();
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature,
    max_completion_tokens: maxTokens,
  };

  // Modelos gpt-oss "pensam" antes de responder; o raciocínio consome a cota
  // de tokens/dia. Esforço baixo basta para extrair JSON e gerar uma frase.
  if (model.startsWith('openai/gpt-oss')) {
    body.reasoning_effort = process.env.GROQ_REASONING_EFFORT || 'low';
  }

  const data = await request('/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  return (data?.choices?.[0]?.message?.content || '').trim();
}

/**
 * Transcreve áudio (Whisper).
 * @param {Buffer} buffer conteúdo do arquivo
 * @param {string} mimeType ex.: 'audio/ogg'
 * @returns {Promise<string>} texto transcrito
 */
export async function transcribe(buffer, mimeType = 'audio/ogg', filename = 'audio.ogg') {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType }), filename);
  form.append('model', process.env.GROQ_STT_MODEL || DEFAULT_STT_MODEL);
  form.append('language', 'pt');
  form.append('response_format', 'json');

  const data = await request('/audio/transcriptions', { method: 'POST', body: form });
  return (data?.text || '').trim();
}
