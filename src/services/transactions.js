import { parseTransaction } from '../ai/gemini.js';
import {
  insertTransaction,
  getCategoryMonthTotal,
  getLastTransactions,
} from '../db/queries.js';

const VALID_CATEGORIES = [
  'Alimentação', 'Transporte', 'Moradia', 'Saúde', 'Lazer',
  'Assinaturas', 'Educação', 'Compras', 'Investimentos', 'Receita', 'Negócio', 'Outros',
];

export async function processMessage(message, userId) {
  const parsed = await parseTransaction(message, userId);

  if (!parsed) {
    return { success: false, reason: 'not_transaction' };
  }

  const category = VALID_CATEGORIES.includes(parsed.category) ? parsed.category : 'Outros';

  return {
    success: true,
    parsed: { ...parsed, category },
    needsConfirmation: parsed.confidence < 0.6,
  };
}

// Retorna a data de hoje em horário LOCAL (não UTC) no formato YYYY-MM-DD.
// Evita bug em que à noite (fuso UTC-3) toISOString() dá o dia seguinte.
function localTodayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function resolveTransactionDate(rawDate) {
  // Aceita apenas strings no formato YYYY-MM-DD informadas pelo usuário.
  // Qualquer outro valor (null, "null", "", undefined, formato inválido) → hoje.
  if (typeof rawDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
    console.log('[FinBot] Transação: usando data informada pelo usuário:', rawDate);
    return rawDate;
  }
  const today = localTodayStr();
  console.log('[FinBot] Transação: sem data informada, usando hoje (local):', today);
  return today;
}

export async function saveTransaction(userId, parsed, rawMessage) {
  try {
    const transactionDate = resolveTransactionDate(parsed.date);
    const transactionId = insertTransaction(
      userId,
      parsed.type,
      parsed.amount,
      parsed.category,
      parsed.description,
      rawMessage,
      transactionDate
    );

    const now = new Date();
    const categoryTotal = getCategoryMonthTotal(
      userId,
      parsed.category,
      now.getFullYear(),
      now.getMonth() + 1
    );

    return { success: true, transactionId, categoryTotal, transactionDate };
  } catch (error) {
    console.error('[FinBot ERROR] Falha ao salvar transação:', error.message);
    return { success: false, error: error.message };
  }
}

export function getRecentTransactions(userId, limit = 10) {
  try {
    return getLastTransactions(userId, limit);
  } catch (error) {
    console.error('[FinBot ERROR] Falha ao buscar transações:', error.message);
    return [];
  }
}
