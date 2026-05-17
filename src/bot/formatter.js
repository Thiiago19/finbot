const CATEGORY_EMOJIS = {
  Alimentação: '🍽️',
  Transporte: '🚗',
  Moradia: '🏠',
  Saúde: '💊',
  Lazer: '🎉',
  Assinaturas: '📺',
  Compras: '🛍️',
  Investimentos: '📈',
  Receita: '💰',
  Educação: '📚',
  Outros: '📦',
};

const SARCASTIC_COMMENTS = {
  Alimentação: 'Barriga cheia, carteira vazia 🍔',
  Transporte: 'Indo a algum lugar importante, espero 🚗',
  Moradia: 'Ter onde morar é luxo, né 🏠',
  Saúde: 'Investindo no básico — pelo menos isso 💊',
  Lazer: 'Saúde mental tem preço, aparentemente 🎉',
  Assinaturas: 'Mais uma assinatura que você vai esquecer que tem 📺',
  Educação: 'Alguém aqui quer crescer na vida 📚',
  Compras: 'Terapia de varejo, claro 🛍️',
  Investimentos: 'Olha aí, adulto responsável aparecendo 📈',
  Receita: 'Dinheiro entrando! Aproveita, é raro 💰',
  Outros: 'Misterioso. Não vamos perguntar 📦',
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
  const comment = SARCASTIC_COMMENTS[parsed.category] || '';
  const confidenceBar = formatProgressBar(parsed.confidence, 1, 5);

  return (
    `🧾 *Deixa eu confirmar se você realmente quer fazer isso...*\n\n` +
    `${typeLabel}\n` +
    `💵 Valor: *${formatCurrency(parsed.amount)}*\n` +
    `${emoji} Categoria: *${parsed.category}*\n` +
    `📝 Descrição: ${parsed.description || 'sem descrição'}\n` +
    `🎯 Confiança: ${confidenceBar}\n` +
    (comment ? `\n_${comment}_` : '')
  );
}

const PAYMENT_EMOJIS = { credito: '💳', debito: '🏦', pix: '⚡', dinheiro: '💵', outro: '📦' };
const PAYMENT_LABELS = { credito: 'Crédito', debito: 'Débito', pix: 'Pix', dinheiro: 'Dinheiro', outro: 'Outro' };
const MONTH_NAMES = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

export function formatFatura({ avista, parcelas, totalParcelas, total }, byCard = []) {
  const now = new Date();
  const monthName = now.toLocaleString('pt-BR', { month: 'long' });
  const cap = monthName.charAt(0).toUpperCase() + monthName.slice(1);

  let msg = `💳 *Fatura de ${cap}*\n`;
  msg += `_Prepare o coração (e a conta). 😏_\n\n`;
  msg += `À vista: *${formatCurrency(avista)}*\n`;
  msg += `Parcelas: *${formatCurrency(totalParcelas)}*\n`;

  if (parcelas.length > 0) {
    msg += `━━━━━━━━━━━━━━\n`;
    for (const t of parcelas) {
      msg += `📌 ${t.description || t.category} · ${formatCurrency(t.amount)} _(${t.installment_number}/${t.installments})_\n`;
    }
    msg += `━━━━━━━━━━━━━━\n`;
  }

  msg += `Total: *${formatCurrency(total)}* 💸\n`;
  if (byCard.length > 1) {
    msg += `\n💳 *Por cartão:*\n`;
    for (const c of byCard) msg += `  💳 ${c.card_name}: ${formatCurrency(c.total)}\n`;
  }
  if (total === 0) msg += `\n_Zerei a fatura? Ou não usou o crédito? Respeito. 👏_`;
  return msg;
}

export function formatFutureInstallments(monthsData) {
  if (monthsData.length === 0) {
    return '😏 *Parcelas futuras*\n\nParabéns, nenhuma parcela no horizonte. Milagre ou pobreza — não sei dizer. 🙄';
  }

  let msg = `📅 *Parcelas dos próximos meses*\n`;
  msg += `_Esse dinheiro já foi. Só falta sair da conta. 🤡_\n\n`;

  for (const { year, month, transactions, total } of monthsData) {
    msg += `*${MONTH_NAMES[month - 1]}/${year}* — ${formatCurrency(total)}\n`;
    for (const t of transactions) {
      msg += `  💳 ${t.description || t.category} · ${formatCurrency(t.amount)} _(${t.installment_number}/${t.installments})_\n`;
    }
    msg += '\n';
  }
  return msg.trim();
}

export function formatMonthlySummary(data, previousData, insightText, paymentBreakdown, creditInstallmentsTotal) {
  const { total_income, total_expenses, by_category } = data;
  const balance = total_income - total_expenses;
  const balanceEmoji = balance >= 0 ? '🟢' : '🔴';

  const now = new Date();
  const monthName = now.toLocaleString('pt-BR', { month: 'long', year: 'numeric' });

  const balanceComment = balance < 0
    ? `_Mês produtivo na arte de gastar mais do que ganha. Talento raro. 🤡_`
    : total_expenses === 0
      ? `_Ou você não registrou nada, ou fez um milagre. 🙄_`
      : `_Sobrou um troco. Guarda antes de inventar algo pra comprar. 😏_`;

  let msg = `📊 *Resumo de ${monthName}*\n${balanceComment}\n\n`;
  msg += `🟢 Receitas: *${formatCurrency(total_income)}*\n`;
  msg += `🔴 Gastos: *${formatCurrency(total_expenses)}*\n`;
  msg += `${balanceEmoji} Saldo: *${formatCurrency(balance)}*\n`;

  if (previousData) {
    const prevExpenses = previousData.total_expenses;
    if (prevExpenses > 0) {
      const variation = ((total_expenses - prevExpenses) / prevExpenses) * 100;
      const sign = variation > 0 ? '+' : '';
      if (variation > 0) {
        msg += `📈 vs. mês anterior: *${sign}${variation.toFixed(1)}%* — progresso impressionante no esvaziamento da carteira 🙄\n`;
      } else {
        msg += `📉 vs. mês anterior: *${sign}${variation.toFixed(1)}%* — olha aí, alguém aprendeu! 😮\n`;
      }
    }
  }

  if (by_category && by_category.length > 0) {
    msg += `\n📌 *Onde o dinheiro foi parar:*\n`;
    const top5 = by_category.slice(0, 5);
    const maxAmount = top5[0]?.total || 1;

    for (const cat of top5) {
      const emoji = CATEGORY_EMOJIS[cat.category] || '📦';
      const bar = formatProgressBar(cat.total, maxAmount, 8);
      msg += `${emoji} ${cat.category}\n   ${bar} ${formatCurrency(cat.total)}\n`;
    }
  }

  if (paymentBreakdown && paymentBreakdown.length > 0) {
    msg += `\n💳 *Por método de pagamento:*\n`;
    for (const p of paymentBreakdown) {
      const emoji = PAYMENT_EMOJIS[p.payment_method] || '📦';
      const label = PAYMENT_LABELS[p.payment_method] || p.payment_method;
      msg += `${emoji} ${label}: ${formatCurrency(p.total)} _(${p.count}x)_\n`;
    }
  }

  if (creditInstallmentsTotal > 0 && data.total_income > 0) {
    const pct = Math.round((creditInstallmentsTotal / data.total_income) * 100);
    if (pct > 30) {
      msg += `\n⚠️ _Suas parcelas de crédito comprometem ${pct}% da renda. Impressionante. 😬_\n`;
    }
  }

  if (insightText) {
    msg += `\n${formatInsight(insightText)}`;
  }

  return msg;
}

export function formatSubscriptions(subs) {
  if (subs.length === 0) {
    return '📺 *Suas assinaturas*\n\nNenhuma assinatura cadastrada. Raro. Parabéns. 👏';
  }
  const total = subs.reduce((s, sub) => s + sub.my_amount, 0);
  const yearly = total * 12;

  const SERVICE_EMOJIS = { spotify: '🎵', netflix: '🎬', disney: '🏰', max: '🎥', globoplay: '📡', amazon: '📦', youtube: '▶️', apple: '🍎', paramount: '🌟', deezer: '🎶' };
  const getEmoji = (name) => {
    const low = name.toLowerCase();
    for (const [k, e] of Object.entries(SERVICE_EMOJIS)) if (low.includes(k)) return e;
    return '📺';
  };

  let msg = `📺 *Suas assinaturas* _(porque uma não era suficiente)_\n━━━━━━━━━━━━━━\n`;
  for (const sub of subs) {
    const emoji = getEmoji(sub.name);
    const label = sub.is_split
      ? `_(dividido por ${sub.split_with})_`
      : `_(só você mesmo)_`;
    msg += `${emoji} ${sub.name} · ${formatCurrency(sub.my_amount)} ${label}\n`;
  }
  msg += `━━━━━━━━━━━━━━\n`;
  msg += `Total: *${formatCurrency(total)}/mês*\n`;
  msg += `💸 *${formatCurrency(yearly)}/ano* indo embora em entretenimento`;
  return msg;
}

export function formatCards(cards) {
  if (cards.length === 0) {
    return '💳 *Seus cartões*\n\nNenhum cartão cadastrado ainda.\nAdicione um ao fazer um gasto no crédito!';
  }
  let msg = `💳 *Seus cartões*\n━━━━━━━━━━━━━━\n`;
  for (const c of cards) {
    msg += `💳 *${c.name}* — vencimento dia ${c.due_day}\n`;
  }
  return msg.trim();
}

export function formatInsight(text) {
  return `\n😏 *O FinBot tem algo a dizer:*\n_${text}_`;
}

export function formatSarcasticSave(sarcasticText, parsed, categoryTotal) {
  const typeEmoji = parsed.type === 'expense' ? '💸' : '💰';
  const emoji = CATEGORY_EMOJIS[parsed.category] || '📦';

  let msg = `${typeEmoji} *Registrado!*\n\n`;
  msg += `_${sarcasticText}_\n\n`;
  msg += `${emoji} ${parsed.category} · ${formatCurrency(parsed.amount)}`;
  if (parsed.type === 'expense' && categoryTotal > 0) {
    msg += `\n📊 Total no mês em ${parsed.category}: ${formatCurrency(categoryTotal)}`;
  }
  return msg;
}

export function formatTransaction(transaction) {
  const emoji = CATEGORY_EMOJIS[transaction.category] || '📦';
  const typeEmoji = transaction.type === 'expense' ? '💸' : '💰';
  const date = new Date(transaction.created_at).toLocaleDateString('pt-BR');
  return `${typeEmoji} ${date} — ${emoji} ${transaction.category}: *${formatCurrency(transaction.amount)}*${transaction.description ? ` (${transaction.description})` : ''}`;
}

export function formatGoal(goal) {
  const progress = goal.target_amount > 0 ? goal.current_amount / goal.target_amount : 0;
  const bar = formatProgressBar(goal.current_amount, goal.target_amount);
  const remaining = goal.target_amount - goal.current_amount;

  let progressComment;
  if (progress >= 1) {
    progressComment = '🎊 _Missão cumprida. Pode comemorar... com moderação._';
  } else if (progress >= 0.75) {
    progressComment = '😏 _Quase lá. Tente não desistir bem no final._';
  } else if (progress >= 0.25) {
    progressComment = '😬 _No caminho certo. Devagar, mas vai._';
  } else {
    progressComment = '🫠 _Começou bem... ou nem isso._';
  }

  let msg = `🎯 *${goal.name}*\n`;
  msg += `   ${bar}\n`;
  msg += `   ${formatCurrency(goal.current_amount)} de ${formatCurrency(goal.target_amount)}\n`;
  msg += `   Faltam: ${formatCurrency(Math.max(remaining, 0))}\n`;
  msg += `   ${progressComment}\n`;

  if (goal.deadline) {
    const deadline = new Date(goal.deadline).toLocaleDateString('pt-BR');
    msg += `   📅 Prazo: ${deadline}\n`;
  }
  return msg;
}
