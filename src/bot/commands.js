import {
  getOrCreateUser, getMonthlySummary, getPreviousMonthSummary, getActiveGoals,
  getCreditFatura, getFutureInstallments, getPaymentMethodBreakdown,
  getAllActiveSubscriptions, getAllCards, getFaturaByCard,
  getBusinessMonthlyTotal, getLastBusinessTransactions,
  getTransactionsForExport,
} from '../db/queries.js';
import { generateExportXlsx, buildExportLabel } from '../services/exporter.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { unlinkSync, existsSync, createReadStream } from 'fs';
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
  formatContas,
  formatNegocio,
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
  bot.command('contas', handleContas);
  bot.command('negocio', handleNegocio);
  bot.command('exportar', handleExportar);
  bot.command('gerenciar', handleGerenciar);
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
    const businessExpenses = getBusinessMonthlyTotal(user.id, year, month);

    await ctx.reply('⏳ Gerando seu resumo com insights da IA...', { parse_mode: 'Markdown' });

    const insightText = await getMonthlyInsights(user);
    const message = formatMonthlySummary(
      summary, previousSummary, insightText,
      paymentBreakdown, fatura.totalParcelas, businessExpenses
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
      `• /negocio — resumo dos gastos da loja/empresa\n` +
      `• /exportar — planilha .xlsx (aceita: maio, 2026, tudo, negocio, pessoal)\n` +
      `• /metas — metas financeiras ativas\n` +
      `• /ajuda — esta mensagem\n\n` +
      `━━━━━━━━━━━━━━━━━━━\n` +
      `🏷️ *Categorias reconhecidas:*\n` +
      `🍽️ Alimentação • 🚗 Transporte • 🏠 Moradia\n` +
      `💊 Saúde • 🎉 Lazer • 📺 Assinaturas\n` +
      `📚 Educação • 🛍️ Compras • 📈 Investimentos\n` +
      `💰 Receita • 🏪 Negócio • 📦 Outros\n\n` +
      `• /gerenciar — limpar transações, cartões ou assinaturas\n\n` +
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
    const allSubs = getAllActiveSubscriptions(user.id);
    const subs = allSubs.filter((s) => !s.is_variable); // só streamings/valor fixo
    const text = formatSubscriptions(subs);

    if (subs.length === 0) {
      await ctx.reply(text, { parse_mode: 'Markdown' });
      return;
    }

    const cancelButtons = subs.map((s) => [
      Markup.button.callback(`❌ Cancelar ${s.name}`, `sub_cncl_${s.id}`),
    ]);

    await ctx.reply(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(cancelButtons),
    });
  } catch (error) {
    console.error('[FinBot ERROR] Erro no /assinaturas:', error.message);
    await ctx.reply('❌ Não consegui listar as assinaturas agora. Tente novamente.');
  }
}

async function handleContas(ctx) {
  try {
    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
    const allSubs = getAllActiveSubscriptions(user.id);
    const fixedSubs = allSubs.filter((s) => !s.is_variable);
    const variableSubs = allSubs.filter((s) => s.is_variable);
    await ctx.reply(formatContas(fixedSubs, variableSubs), { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('[FinBot ERROR] Erro no /contas:', error.message);
    await ctx.reply('❌ Não consegui listar as contas agora. Tente novamente.');
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

async function handleNegocio(ctx) {
  try {
    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const prev = new Date(year, month - 2, 1);

    const currentTotal = getBusinessMonthlyTotal(user.id, year, month);
    const previousTotal = getBusinessMonthlyTotal(user.id, prev.getFullYear(), prev.getMonth() + 1);
    const transactions = getLastBusinessTransactions(user.id, 10);
    const monthName = now.toLocaleString('pt-BR', { month: 'long', year: 'numeric' });

    await ctx.reply(
      formatNegocio({ currentTotal, previousTotal, transactions, monthName }),
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('[FinBot ERROR] Erro no /negocio:', error.message);
    await ctx.reply('❌ Não consegui buscar o resumo do negócio agora. Tente novamente.');
  }
}

const EXPORT_MONTHS = {
  janeiro: 1, fevereiro: 2, 'março': 3, marco: 3, abril: 4,
  maio: 5, junho: 6, julho: 7, agosto: 8,
  setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};

function parseExportArgs(text) {
  const args = text.trim().split(/\s+/).slice(1); // remove '/exportar'
  const now = new Date();
  const result = {
    scope: 'all',
    period: 'month',
    month: now.getMonth() + 1,
    year: now.getFullYear(),
  };
  let monthExplicit = false;
  let allExplicit = false;

  for (const raw of args) {
    const a = raw.toLowerCase().normalize('NFC');
    if (a === 'negocio' || a === 'negócio') result.scope = 'business';
    else if (a === 'pessoal') result.scope = 'personal';
    else if (a === 'tudo' || a === 'todo' || a === 'todos') { result.period = 'all'; allExplicit = true; }
    else if (EXPORT_MONTHS[a]) { result.month = EXPORT_MONTHS[a]; result.period = 'month'; monthExplicit = true; }
    else if (/^\d{4}$/.test(a)) {
      result.year = parseInt(a, 10);
      // Ano sozinho vira period=year; mês+ano mantém period=month; tudo sempre vence
      if (!monthExplicit && !allExplicit) result.period = 'year';
    }
  }
  return result;
}

async function handleExportar(ctx) {
  let tmpPath = null;
  try {
    const parsed = parseExportArgs(ctx.message.text);
    await ctx.reply('⏳ Gerando sua planilha... preparando as provas do crime financeiro 🔍');

    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
    const transactions = getTransactionsForExport(user.id, parsed);

    if (transactions.length === 0) {
      await ctx.reply(
        '😏 Não há transações nesse período.\nOu você é muito econômico, ou esqueceu de registrar. _Chuto a segunda opção._',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const label = buildExportLabel(parsed);
    const filename = `${label}.xlsx`;
    tmpPath = join(tmpdir(), `finbot_export_${user.id}_${Date.now()}.xlsx`);

    await generateExportXlsx(transactions, parsed, tmpPath);

    // Garantir que o arquivo foi efetivamente escrito antes de enviar
    if (!existsSync(tmpPath)) {
      throw new Error('Arquivo não gerado');
    }

    // Enviar via stream evita "socket hang up" em arquivos maiores
    await ctx.replyWithDocument(
      { source: createReadStream(tmpPath), filename },
      { caption: '📊 Aqui está sua planilha de arrependimentos... digo, de controle financeiro! 😏' }
    );
  } catch (error) {
    console.error('[FinBot ERROR] Erro no /exportar:', error.message);
    await ctx.reply('❌ Erro ao gerar a planilha. Tente novamente.');
  } finally {
    if (tmpPath) {
      try { unlinkSync(tmpPath); } catch { /* arquivo já removido */ }
    }
  }
}

async function handleGerenciar(ctx) {
  try {
    await ctx.reply(
      `⚙️ *Gerenciar dados*\n\n_O que você quer destruir hoje?_`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🗑️ Limpar transações', 'mgr_tx')],
          [Markup.button.callback('💳 Limpar cartões', 'mgr_cards')],
          [Markup.button.callback('📺 Limpar assinaturas', 'mgr_subs')],
          [Markup.button.callback('☢️ Limpar tudo', 'mgr_all')],
        ]),
      }
    );
  } catch (error) {
    console.error('[FinBot ERROR] Erro no /gerenciar:', error.message);
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
