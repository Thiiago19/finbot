import { generateInsights } from '../ai/claude.js';
import {
  getMonthlySummary,
  getPreviousMonthSummary,
  getRecentTransactionsForInsights,
} from '../db/queries.js';

export async function getMonthlyInsights(user) {
  try {
    const now = new Date();
    const summary = getMonthlySummary(user.id, now.getFullYear(), now.getMonth() + 1);
    const previousSummary = getPreviousMonthSummary(user.id);
    const recentTransactions = getRecentTransactionsForInsights(user.id, 50);

    if (recentTransactions.length < 3) {
      return 'Registre mais transações para receber insights personalizados sobre seus hábitos financeiros! 📊';
    }

    const userData = {
      firstName: user.first_name,
      summary,
      previousSummary,
      recentTransactions,
    };

    const insightsText = await generateInsights(userData);
    return insightsText || 'Continue registrando seus gastos para insights mais precisos! 💪';
  } catch (error) {
    console.error('[FinBot ERROR] Falha ao obter insights:', error.message);
    return null;
  }
}
