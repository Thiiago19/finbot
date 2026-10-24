// Provedor Google Gemini.
// Usado como fallback de texto e como provedor principal de imagem e PDF.

import { GoogleGenerativeAI } from '@google/generative-ai';
import { ProviderError } from './errors.js';

// 2.5 Flash-Lite não está descontinuado (Google: "servido até novo aviso").
// Para trocar, defina GEMINI_MODEL no ambiente — sem mexer no código.
const DEFAULT_MODEL = 'gemini-2.5-flash-lite';

export const name = 'gemini';

export function isConfigured() {
  return Boolean(process.env.GEMINI_API_KEY);
}

function getModel() {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || DEFAULT_MODEL });
}

function wrap(error) {
  const status = error?.status ?? null;
  const retryable = status === 429 || (status !== null && status >= 500) || status === null;
  return new ProviderError(name, error?.message || String(error), { status, retryable });
}

/** Gera texto a partir de um prompt simples. */
export async function generateText(prompt) {
  try {
    const result = await getModel().generateContent(prompt);
    return result.response.text().trim();
  } catch (error) {
    throw wrap(error);
  }
}

/**
 * Gera texto a partir de partes multimodais (imagem, áudio, PDF + prompt).
 * @param {Array} parts no formato do SDK: [{ inlineData: { data, mimeType } }, 'prompt']
 */
export async function generateFromParts(parts) {
  try {
    const result = await getModel().generateContent(parts);
    return result.response.text().trim();
  } catch (error) {
    throw wrap(error);
  }
}
