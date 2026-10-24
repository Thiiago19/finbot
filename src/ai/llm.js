// Roteador de IA de texto: tenta os provedores em ordem e cai para o próximo
// quando um falha (cota estourada, erro de rede, chave ausente).
//
// Ordem padrão: groq → gemini. Configurável por AI_TEXT_PROVIDERS="gemini,groq".

import * as groq from './providers/groq.js';
import * as gemini from './providers/gemini.js';

const REGISTRY = { groq, gemini };

function textProviders() {
  const order = (process.env.AI_TEXT_PROVIDERS || 'groq,gemini')
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter((p) => REGISTRY[p]);
  return order.map((p) => REGISTRY[p]).filter((p) => p.isConfigured());
}

/** Há pelo menos um provedor de texto configurado? */
export function isTextAIEnabled() {
  return textProviders().length > 0;
}

/** Imagem e PDF dependem do Gemini. */
export function isVisionAIEnabled() {
  return gemini.isConfigured();
}

/** Áudio: Whisper (Groq) ou, na falta dele, o Gemini. */
export function isAudioAIEnabled() {
  return groq.isConfigured() || gemini.isConfigured();
}

/** Nomes dos provedores ativos, para log de inicialização. */
export function describeProviders() {
  return {
    text: textProviders().map((p) => p.name),
    vision: isVisionAIEnabled() ? ['gemini'] : [],
    audio: [groq.isConfigured() && 'groq', gemini.isConfigured() && 'gemini'].filter(Boolean),
  };
}

/**
 * Gera texto com o primeiro provedor disponível.
 * @param {string} prompt
 * @param {{ task?: string, maxTokens?: number, temperature?: number }} [options]
 *   task: rótulo usado só nos logs (ex.: 'parse', 'sarcasmo')
 * @returns {Promise<{ text: string, provider: string } | null>} null se todos falharem
 */
export async function generateText(prompt, { task = 'texto', ...options } = {}) {
  const providers = textProviders();

  for (const provider of providers) {
    try {
      const text = await provider.generateText(prompt, options);
      return { text, provider: provider.name };
    } catch (error) {
      const next = providers[providers.indexOf(provider) + 1];
      console.error(
        `[FinBot ERROR] IA (${task}) falhou em ${provider.name}: ${error.message}` +
          (next ? ` — tentando ${next.name}` : ' — sem provedor restante')
      );
    }
  }

  return null;
}
