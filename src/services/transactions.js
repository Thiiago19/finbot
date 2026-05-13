import { parseTransaction } from '../ai/gemini.js';
import {
  insertTransaction,
  getCategoryMonthTotal,
  getLastTransactions,
} from '../db/queries.js';

const VALID_CATEGORIES = [
  'Alimentação', 'Transporte', 'Moradia', 'Saúde', 'Lazer',
  'Assinaturas', 'Educação', 'Compras', 'Investimentos', 'Receita', 'Outros',
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

export async function saveTransaction(userId, parsed, rawMessage) {
  try {
    const transactionId = insertTransaction(
      userId,
      parsed.type,
      parsed.amount,
      parsed.category,
      parsed.description,
      rawMessage
    );

    const now = new Date();
    const categoryTotal = getCategoryMonthTotal(
      userId,
      parsed.category,
      now.getFullYear(),
      now.getMonth() + 1
    );

    return { success: true, transactionId, categoryTotal };
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
