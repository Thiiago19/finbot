import {
  getOrCreateUser, getMonthlySummary, getPreviousMonthSummary, getActiveGoals,
  getCreditFatura, getFutureInstallments, getPaymentMethodBreakdown,
  getAllSubscriptions, getAllCards, getFaturaByCard,
} from '../db/queries.js';
import { Markup } from 'telegraf';
import { getMonthlyInsights } from '../services/insights.js';
import { getRecentTransactions } from '../services/transactions.js';
import {
  formatCurrency,
  formatMonthlySummary,
  formatTransaction,
  formatGoal,
  formatFatura,
  formatFutureInstallments,
  formatSubscriptions,
  formatCards,
} from './formatter.js';

export function registerCommands(bot) {
  bot.start(handleStart);
  bot.command('resumo', handleResumo);
  bot.command('mes', handleResumo);
  bot.command('saldo', handleSaldo);
  bot.command('gastos', handleGastos);
  bot.command('metas', handleMetas);
  bot.command('ajuda', handleAjuda);
  bot.command('limpar', handleLimpar);
  bot.command('fatura', handleFatura);
  bot.command('parcelas', handleParcelas);
  bot.command('assinaturas', handleAssinaturas);
  bot.command('cartoes', handleCartoes);
  bot.help(handleAjuda);
}

async function handleStart(ctx) {
  try {
    const { id: telegramId, first_name, username } = ctx.from;
    const user = getOrCreateUser(telegramId, first_name, username);

    const isNew = !user.created_at ||
      Date.now() - new Date(user.created_at).getTime() < 5000;

    if (isNew) {
      await ctx.reply(
        `👋 Olá, *${first_name}*! Seja bem-vindo ao *FinBot*! 🤖💰\n\n` +
        `Sou seu assistente financeiro pessoal. Veja como me usar:\n\n` +
        `💬 *Registrar gastos* — fale naturalmente:\n` +
        `   "Gastei 35 no iFood"\n` +
        `   "Paguei 150 de Uber"\n` +
        `   "Recebi salário de 3500"\n\n` +
        `📊 *Comandos disponíveis:*\n` +
        `   /resumo — resumo do mês atual\n` +
        `   /saldo — saldo rápido\n` +
        `   /gastos — últimos 10 lançamentos\n` +
        `   /metas — suas metas financeiras\n` +
        `   /ajuda — ajuda completa\n\n` +
        `Vamos começar? Me diga quanto você gastou hoje! 💪`,
        { parse_mode: 'Markdown' }
      );
    } else {
      await ctx.reply(
        `👋 Olá de novo, *${first_name}*! Bem-vindo de volta ao FinBot! 💰\n\n` +
        `Use /ajuda para ver todos os comandos disponíveis.`,
        { parse_mode: 'Markdown' }
      );
    }
  } catch (error) {
    console.error('[FinBot ERROR] Erro no /start:', error.message);
    await ctx.reply('❌ Ocorreu um erro ao iniciar. Tente novamente em instantes.');
  }
}

async function handleResumo(ctx) {
  try {
    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    const summary = getMonthlySummary(user.id, year, month);
    const previousSummary = getPreviousMonthSummary(user.id);
    const paymentBreakdown = getPaymentMethodBreakdown(user.id, year, month);
    const fatura = getCreditFatura(user.id, year, month);

    await ctx.reply('⏳ Gerando seu resumo com insights da IA...', { parse_mode: 'Markdown' });

    const insightText = await getMonthlyInsights(user);
    const message = formatMonthlySummary(
      summary, previousSummary, insightText,
      paymentBreakdown, fatura.totalParcelas
    );

    await ctx.reply(message, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('[FinBot ERROR] Erro no /resumo:', error.message);
    await ctx.reply('❌ Não consegui gerar o resumo agora. Tente novamente em instantes.');
  }
}

async function handleSaldo(ctx) {
  try {
    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
    const now = new Date();
    const summary = getMonthlySummary(user.id, now.getFullYear(), now.getMonth() + 1);
    const balance = summary.total_income - summary.total_expenses;
    const balanceEmoji = balance >= 0 ? '🟢' : '🔴';

    const monthName = now.toLocaleString('pt-BR', { month: 'long' });
    await ctx.reply(
      `💰 *Saldo de ${monthName}*\n\n` +
      `🟢 Receitas: ${formatCurrency(summary.total_income)}\n` +
      `🔴 Gastos: ${formatCurrency(summary.total_expenses)}\n` +
      `${balanceEmoji} Saldo: *${formatCurrency(balance)}*`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('[FinBot ERROR] Erro no /saldo:', error.message);
    await ctx.reply('❌ Não consegui buscar o saldo agora. Tente novamente.');
  }
}

async function handleGastos(ctx) {
  try {
    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
    const transactions = getRecentTransactions(user.id, 10);

    if (transactions.length === 0) {
      await ctx.reply(
        '📭 Nenhuma transação registrada ainda.\n\nComece me dizendo quanto você gastou hoje! 💬',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    let msg = '📋 *Últimos 10 lançamentos:*\n\n';
    for (const t of transactions) {
      msg += formatTransaction(t) + '\n';
    }

    await ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('[FinBot ERROR] Erro no /gastos:', error.message);
    await ctx.reply('❌ Não consegui listar os gastos agora. Tente novamente.');
  }
}

async function handleMetas(ctx) {
  try {
    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
    const goals = getActiveGoals(user.id);

    if (goals.length === 0) {
      await ctx.reply(
        '🎯 Você ainda não tem metas cadastradas.\n\n' +
        'Em breve você poderá criar metas diretamente aqui no bot! 🚀',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    let msg = '🎯 *Suas metas ativas:*\n\n';
    for (const goal of goals) {
      msg += formatGoal(goal) + '\n';
    }

    await ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('[FinBot ERROR] Erro no /metas:', error.message);
    await ctx.reply('❌ Não consegui listar as metas agora. Tente novamente.');
  }
}

async function handleAjuda(ctx) {
  try {
    await ctx.reply(
      `🤖 *Como usar o FinBot*\n\n` +
      `━━━━━━━━━━━━━━━━━━━\n` +
      `💬 *Registrar transações* (fale naturalmente):\n` +
      `• "Gastei 45 reais no iFood"\n` +
      `• "Paguei 200 de condomínio"\n` +
      `• "Recebi 3500 de salário"\n` +
      `• "Cinema com família: 80"\n` +
      `• "Uber 15,50"\n` +
      `• "Farmácia 67,90"\n\n` +
      `━━━━━━━━━━━━━━━━━━━\n` +
      `📊 *Comandos:*\n` +
      `• /resumo — resumo do mês com insights da IA\n` +
      `• /mes — mesmo que /resumo\n` +
      `• /saldo — saldo rápido do mês\n` +
      `• /gastos — últimas 10 transações\n` +
      `• /fatura — fatura do crédito do mês\n` +
      `• /parcelas — parcelas dos próximos 6 meses\n` +
      `• /metas — metas financeiras ativas\n` +
      `• /ajuda — esta mensagem\n\n` +
      `━━━━━━━━━━━━━━━━━━━\n` +
      `🏷️ *Categorias reconhecidas:*\n` +
      `🍽️ Alimentação • 🚗 Transporte • 🏠 Moradia\n` +
      `💊 Saúde • 🎉 Lazer • 📺 Assinaturas\n` +
      `📚 Educação • 🛍️ Compras • 📈 Investimentos\n` +
      `💰 Receita • 📦 Outros\n\n` +
      `Dúvidas? Me manda uma mensagem! 😊`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('[FinBot ERROR] Erro no /ajuda:', error.message);
  }
}

async function handleFatura(ctx) {
  try {
    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
    const now = new Date();
    const data = getCreditFatura(user.id, now.getFullYear(), now.getMonth() + 1);
    const byCard = getFaturaByCard(user.id, now.getFullYear(), now.getMonth() + 1);
    await ctx.reply(formatFatura(data, byCard), { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('[FinBot ERROR] Erro no /fatura:', error.message);
    await ctx.reply('❌ Não consegui buscar a fatura agora. Tente novamente.');
  }
}

async function handleAssinaturas(ctx) {
  try {
    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
    const subs = getAllSubscriptions(user.id);
    await ctx.reply(formatSubscriptions(subs), { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('[FinBot ERROR] Erro no /assinaturas:', error.message);
    await ctx.reply('❌ Não consegui listar as assinaturas agora. Tente novamente.');
  }
}

async function handleCartoes(ctx) {
  try {
    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
    const cards = getAllCards(user.id);
    await ctx.reply(formatCards(cards), { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('[FinBot ERROR] Erro no /cartoes:', error.message);
    await ctx.reply('❌ Não consegui listar os cartões agora. Tente novamente.');
  }
}

async function handleParcelas(ctx) {
  try {
    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
    const data = getFutureInstallments(user.id, 6);
    await ctx.reply(formatFutureInstallments(data), { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('[FinBot ERROR] Erro no /parcelas:', error.message);
    await ctx.reply('❌ Não consegui listar as parcelas agora. Tente novamente.');
  }
}

async function handleLimpar(ctx) {
  try {
    await ctx.reply(
      `🗑️ *Apagar todas as transações?*\n\n` +
      `Isso vai deletar *todo o seu histórico financeiro* permanentemente.\n` +
      `Não tem como desfazer. Sério. 🤡`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Confirmar', 'limpar_confirmar'),
            Markup.button.callback('❌ Cancelar', 'limpar_cancelar'),
          ],
        ]),
      }
    );
  } catch (error) {
    console.error('[FinBot ERROR] Erro no /limpar:', error.message);
  }
}
