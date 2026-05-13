const CATEGORY_EMOJIS = {
  Alimentação: '🍽️',
  Transporte: '🚗',
  Moradia: '🏠',
  Saúde: '💊',
  Lazer: '🎉',
  Assinaturas: '📺',
  Educação: '📚',
  Compras: '🛍️',
  Investimentos: '📈',
  Receita: '💰',
  Outros: '📦',
};

export function formatCurrency(amount) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(amount);
}

export function formatProgressBar(current, total, size = 10) {
  if (total <= 0) return '░'.repeat(size) + ' 0%';
  const percentage = Math.min(current / total, 1);
  const filled = Math.round(percentage * size);
  const empty = size - filled;
  const pct = Math.round(percentage * 100);
  return '█'.repeat(filled) + '░'.repeat(empty) + ` ${pct}%`;
}

export function formatTransactionConfirm(parsed) {
  const typeLabel = parsed.type === 'expense' ? '💸 Gasto' : '💰 Receita';
  const emoji = CATEGORY_EMOJIS[parsed.category] || '📦';
  const confidenceBar = formatProgressBar(parsed.confidence, 1, 5);

  return (
    `📋 *Confirmar transação?*\n\n` +
    `${typeLabel}\n` +
    `💵 Valor: *${formatCurrency(parsed.amount)}*\n` +
    `${emoji} Categoria: *${parsed.category}*\n` +
    `📝 Descrição: ${parsed.description || 'sem descrição'}\n` +
    `🎯 Confiança: ${confidenceBar}`
  );
}

export function formatMonthlySummary(data, previousData, insightText) {
  const { total_income, total_expenses, by_category } = data;
  const balance = total_income - total_expenses;
  const balanceEmoji = balance >= 0 ? '🟢' : '🔴';

  const now = new Date();
  const monthName = now.toLocaleString('pt-BR', { month: 'long', year: 'numeric' });

  let msg = `📊 *Resumo de ${monthName}*\n\n`;
  msg += `🟢 Receitas: *${formatCurrency(total_income)}*\n`;
  msg += `🔴 Gastos: *${formatCurrency(total_expenses)}*\n`;
  msg += `${balanceEmoji} Saldo: *${formatCurrency(balance)}*\n`;

  if (previousData) {
    const prevExpenses = previousData.total_expenses;
    if (prevExpenses > 0) {
      const variation = ((total_expenses - prevExpenses) / prevExpenses) * 100;
      const variationEmoji = variation > 0 ? '📈' : '📉';
      const sign = variation > 0 ? '+' : '';
      msg += `${variationEmoji} vs. mês anterior: *${sign}${variation.toFixed(1)}%*\n`;
    }
  }

  if (by_category && by_category.length > 0) {
    msg += `\n📌 *Top categorias (gastos):*\n`;
    const top5 = by_category.slice(0, 5);
    const maxAmount = top5[0]?.total || 1;

    for (const cat of top5) {
      const emoji = CATEGORY_EMOJIS[cat.category] || '📦';
      const bar = formatProgressBar(cat.total, maxAmount, 8);
      msg += `${emoji} ${cat.category}\n   ${bar} ${formatCurrency(cat.total)}\n`;
    }
  }

  if (insightText) {
    msg += `\n${formatInsight(insightText)}`;
  }

  return msg;
}

export function formatInsight(text) {
  return `\n💡 *Insight do FinBot:*\n_${text}_`;
}

export function formatTransaction(transaction) {
  const emoji = CATEGORY_EMOJIS[transaction.category] || '📦';
  const typeEmoji = transaction.type === 'expense' ? '💸' : '💰';
  const date = new Date(transaction.created_at).toLocaleDateString('pt-BR');
  return `${typeEmoji} ${date} — ${emoji} ${transaction.category}: *${formatCurrency(transaction.amount)}*${transaction.description ? ` (${transaction.description})` : ''}`;
}

export function formatGoal(goal) {
  const progress = goal.target_amount > 0
    ? goal.current_amount / goal.target_amount
    : 0;
  const bar = formatProgressBar(goal.current_amount, goal.target_amount);
  const remaining = goal.target_amount - goal.current_amount;
  let msg = `🎯 *${goal.name}*\n`;
  msg += `   ${bar}\n`;
  msg += `   ${formatCurrency(goal.current_amount)} de ${formatCurrency(goal.target_amount)}\n`;
  msg += `   Faltam: ${formatCurrency(Math.max(remaining, 0))}\n`;

  if (goal.deadline) {
    const deadline = new Date(goal.deadline).toLocaleDateString('pt-BR');
    msg += `   📅 Prazo: ${deadline}\n`;
  }
  return msg;
}
