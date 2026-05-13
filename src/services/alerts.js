import { getCategoryMonthTotal, getMonthlySummary, getBudget } from '../db/queries.js';

const DEFAULT_LIMITS = {
  Alimentação: 800,
  Transporte: 400,
  Lazer: 300,
  Assinaturas: 200,
  Saúde: 300,
  Compras: 500,
  Moradia: 1500,
  Educação: 400,
};

function getMonthlyLimit(userId, category, userBudget) {
  if (userBudget) return userBudget.monthly_limit;
  return DEFAULT_LIMITS[category] || null;
}

export async function checkCategoryAlert(userId, category, categoryTotal) {
  try {
    const userBudget = getBudget(userId, category);
    const limit = getMonthlyLimit(userId, category, userBudget);

    if (!limit) return null;

    const percentage = (categoryTotal / limit) * 100;

    if (percentage >= 100) {
      return {
        level: 'danger',
        emoji: '🚨',
        message: `*Limite ultrapassado em ${category}!*\nVocê gastou R$ ${categoryTotal.toFixed(2)} de R$ ${limit.toFixed(2)} (${Math.round(percentage)}% do limite mensal).`,
      };
    }

    if (percentage >= 80) {
      return {
        level: 'warning',
        emoji: '⚠️',
        message: `*Atenção: ${category} em ${Math.round(percentage)}% do limite!*\nGasto atual: R$ ${categoryTotal.toFixed(2)} de R$ ${limit.toFixed(2)}.`,
      };
    }

    return null;
  } catch (error) {
    console.error('[FinBot ERROR] Falha ao verificar alerta de categoria:', error.message);
    return null;
  }
}

export async function checkEndOfMonthAlert(userId) {
  try {
    const now = new Date();
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const daysLeft = lastDay - now.getDate();

    if (daysLeft > 3) return null;

    const summary = getMonthlySummary(userId, now.getFullYear(), now.getMonth() + 1);
    const balance = summary.total_income - summary.total_expenses;

    if (balance >= 0) return null;

    return {
      level: 'warning',
      emoji: '📅',
      message: `*Fim do mês se aproximando!*\nFaltam ${daysLeft} dia(s) e seu saldo está negativo em R$ ${Math.abs(balance).toFixed(2)}. Tente reduzir gastos até o próximo ciclo.`,
    };
  } catch (error) {
    console.error('[FinBot ERROR] Falha ao verificar alerta de fim de mês:', error.message);
    return null;
  }
}

export async function runAlertsAfterExpense(userId, category, categoryTotal) {
  const alerts = [];

  const categoryAlert = await checkCategoryAlert(userId, category, categoryTotal);
  if (categoryAlert) alerts.push(categoryAlert);

  const endOfMonthAlert = await checkEndOfMonthAlert(userId);
  if (endOfMonthAlert) alerts.push(endOfMonthAlert);

  return alerts;
}
