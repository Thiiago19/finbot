import { Markup } from 'telegraf';
import {
  getOrCreateUser, deleteAllTransactions, deleteAllCards, deleteAllSubscriptions,
  updateTransactionPayment, createInstallmentTransactions, updateTransactionAmount,
  getSubscription, findSubscriptionByDescription, saveSubscription,
  updateSubscriptionBillingDay, deactivateSubscription, getSubscriptionById,
  updateSubscriptionAmount, insertSubscriptionTransaction,
  insertPendingBill, getUnresolvedPendingBill, resolvePendingBill,
  getAllCards, findCardByName, saveCard, updateTransactionCard,
  updateTransactionCategory, createOngoingInstallments,
} from '../db/queries.js';
import { processMessage, saveTransaction } from '../services/transactions.js';
import { runAlertsAfterExpense } from '../services/alerts.js';
import { generateSarcasticResponse } from '../ai/gemini.js';
import { downloadTelegramFile, analyzeImage, analyzeAudio, analyzePDF } from '../ai/media.js';
import { pendingBillAmount } from '../state.js';
import {
  formatCurrency,
  formatTransactionConfirm,
  formatSarcasticSave,
} from './formatter.js';

// ─── Extração do nome do serviço a partir da descrição da IA ─────────────────

function extractSubscriptionName(description) {
  if (!description) return 'Serviço';
  // Remove emojis
  const clean = description.replace(/\p{Emoji_Presentation}|\p{Emoji}️/gu, '').trim();
  // Remove sufixos sarcásticos comuns inseridos pela IA
  const stripped = clean
    .replace(/\s*(de novo|novamente|outra vez|\(.*?\)|—.*|-\s+.*)/i, '')
    .trim();
  return stripped.split(/\s{2,}/)[0].trim() || description.split(' ')[0] || 'Serviço';
}

// ─── Contas variáveis (internet, energia, água, etc.) ────────────────────────

const VARIABLE_SERVICES = [
  ['claro net', 'Internet (Claro)'], ['vivo fibra', 'Internet (Vivo)'],
  ['tim live', 'Internet (TIM)'], ['oi fibra', 'Internet (Oi)'],
  ['internet', 'Internet'], ['banda larga', 'Internet'], ['fibra', 'Internet'],
  ['cpfl', 'Energia (CPFL)'], ['enel', 'Energia (Enel)'],
  ['cemig', 'Energia (Cemig)'], ['copel', 'Energia (Copel)'],
  ['energia elétrica', 'Energia Elétrica'], ['energia', 'Energia Elétrica'],
  ['sabesp', 'Água (Sabesp)'], ['embasa', 'Água (Embasa)'],
  ['saneamento', 'Água/Saneamento'],
  ['comgás', 'Gás (Comgás)'], ['gás encanado', 'Gás'],
  ['aluguel', 'Aluguel'], ['condomínio', 'Condomínio'],
  ['plano de saúde', 'Plano de Saúde'], ['convênio médico', 'Plano de Saúde'],
  ['unimed', 'Unimed'], ['amil', 'Amil'],
  ['sulamerica', 'SulAmérica'], ['bradesco saúde', 'Bradesco Saúde'],
  ['smartfit', 'SmartFit'], ['bodytech', 'Bodytech'], ['academia', 'Academia'],
  ['seguro', 'Seguro'],
];
// Plano/conta de celular é Assinatura fixa (não entra aqui como variável)

function detectVariableService(description) {
  if (!description) return null;
  const lower = description.toLowerCase();
  for (const [key, display] of VARIABLE_SERVICES) {
    if (lower.includes(key)) return display;
  }
  return null;
}

// ─── Sarcasmo para resposta de conta variável ─────────────────────────────────

const BILL_SARCASMS = [
  [['internet', 'fibra', 'banda larga', 'claro net', 'vivo fibra', 'tim live', 'oi fibra'], 'pela internet que cai toda hora'],
  [['energia', 'cpfl', 'enel', 'cemig', 'copel', 'luz'], 'pela luz que você esquece acesa em todo canto'],
  [['água', 'saneamento', 'sabesp', 'embasa'], 'pela água — esperamos que esteja economizando'],
  [['gás', 'comgás'], 'pelo gás — pelo menos aquece no inverno'],
  [['aluguel'], 'pelo aluguel — a certeza mensal que não falha'],
  [['condomínio'], 'pelo condomínio e suas taxas que ninguém entende'],
  [['plano de saúde', 'unimed', 'amil', 'sulamerica', 'bradesco'], 'pelo plano que cobre o que você nunca precisa'],
  [['academia', 'smartfit', 'bodytech'], 'pela academia que você vai uma vez por mês, se tanto'],
  [['seguro'], 'pelo seguro que você torce pra nunca precisar'],
  [['celular', 'plano celular'], 'pelo celular que você não desgruda nem dormindo'],
];

function getBillSarcasm(name) {
  const lower = name.toLowerCase();
  for (const [keys, comment] of BILL_SARCASMS) {
    if (keys.some((k) => lower.includes(k))) return comment;
  }
  return 'mais uma conta devidamente paga';
}

function parseMonetaryAmount(text) {
  const cleaned = text.trim().replace(',', '.').replace(/[^\d.]/g, '');
  const n = parseFloat(cleaned);
  return !isNaN(n) && n > 0 && n < 1_000_000 ? n : null;
}

// ─── State maps ───────────────────────────────────────────────────────────────

const pendingTransactions      = new Map();
const pendingPdfImports        = new Map();
const pendingBusinessReview    = new Map(); // key → { dbUserId, items:[{txId,amount,description}], selected:Set, page }
const pendingPaymentUpdate     = new Map();
const pendingInstallCount      = new Map();
const pendingSubTypeSetup      = new Map(); // transactionId → { serviceName, totalAmount, telegramUserId }
const pendingSubBillingDay     = new Map();
const pendingVariableBillSetup = new Map(); // transactionId → dados
const pendingVariableBillDay   = new Map(); // userId → dados
const pendingCardNameInput     = new Map();
const pendingCardDueDayInput   = new Map();

export function registerHandlers(bot) {
  bot.on('text', handleTextMessage);
  bot.on('photo', handlePhoto);
  bot.on('voice', handleVoice);
  bot.on('document', handleDocument);

  bot.action(/^confirm_(.+)$/, handleConfirmCallback);
  bot.action('cancel_transaction', handleCancelCallback);

  bot.action(/^pay_(cred|deb|pix|din)_(\d+)$/, handlePaymentMethod);
  bot.action(/^inst_(av|pr)_(\d+)$/, handleInstallmentChoice);

  bot.action(/^sub_type_(fix|var|one)_(\d+)$/, handleSubscriptionType);
  bot.action(/^sub_cncl_(\d+)$/, handleSubCancel);
  bot.action(/^sub_cncl_yes_(\d+)$/, handleSubCancelConfirm);
  bot.action(/^sub_cncl_no_(\d+)$/, handleSubCancelKeep);

  bot.action(/^varbill_(yes|no)_(\d+)$/, handleVariableBillChoice);

  bot.action(/^card_sel_(\d+)_(\d+)$/, handleCardSelection);
  bot.action(/^card_new_(\d+)$/, handleNewCard);

  bot.action(/^pdf_imp_(.+)$/, handlePdfImport);
  bot.action(/^pdf_can_(.+)$/, handlePdfCancel);

  bot.action(/^biz_yes_(.+)$/, handleBusinessReviewYes);
  bot.action(/^biz_no_(.+)$/, handleBusinessReviewNo);
  bot.action(/^biz_tog_(.+)_(\d+)$/, handleBusinessReviewToggle);
  bot.action(/^biz_page_(.+)_(\d+)$/, handleBusinessReviewPage);
  bot.action(/^biz_ok_(.+)$/, handleBusinessReviewConfirm);

  bot.action('limpar_confirmar', handleLimparConfirmar);
  bot.action('limpar_cancelar', handleLimparCancelar);

  bot.action(/^mgr_(tx|cards|subs|all)$/, handleGerenciarOption);
  bot.action(/^mgr_ok_(tx|cards|subs|all)$/, handleGerenciarConfirm);
  bot.action('mgr_cancel', handleGerenciarCancel);
}

// ─── Helper central ───────────────────────────────────────────────────────────

async function saveAndReply(ctx, parsed, rawSource, userId) {
  const saveResult = await saveTransaction(userId, parsed, rawSource);
  if (!saveResult.success) {
    await ctx.reply('❌ Erro ao salvar a transação. Tente novamente.');
    return;
  }

  const sarcasticText = await generateSarcasticResponse({
    type: parsed.type, amount: parsed.amount,
    category: parsed.category, description: parsed.description,
    categoryTotal: saveResult.categoryTotal,
  });

  let responseMsg = sarcasticText
    ? formatSarcasticSave(sarcasticText, parsed, saveResult.categoryTotal)
    : `✅ *Registrado!*\n\n${formatCurrency(parsed.amount)} em ${parsed.category}`;

  const today = new Date().toISOString().split('T')[0];
  const parsedDate = (parsed.date && parsed.date !== 'null') ? parsed.date : null;
  if (parsedDate && parsedDate !== today) {
    const d = new Date(parsed.date + 'T12:00:00');
    const dateLabel = d.toLocaleDateString('pt-BR', { day: 'numeric', month: 'long' });
    responseMsg += `\n📅 _Data: ${dateLabel}_`;
  }

  await ctx.reply(responseMsg, { parse_mode: 'Markdown' });

  if (parsed.type === 'expense') {
    const alerts = await runAlertsAfterExpense(userId, parsed.category, saveResult.categoryTotal);
    for (const alert of alerts) {
      await ctx.reply(`${alert.emoji} ${alert.message}`, { parse_mode: 'Markdown' });
    }

    // Verificar streaming/assinatura fixa
    if (parsed.category === 'Assinaturas') {
      const skipPayment = await handleSubscriptionCheck(ctx, parsed, saveResult.transactionId, userId);
      if (skipPayment) return;
    }

    // Verificar conta variável
    const variableService = detectVariableService(parsed.description);
    if (variableService) {
      const skipPayment = await handleVariableBillCheck(ctx, parsed, saveResult.transactionId, userId, variableService);
      if (skipPayment) return;
    }

    await processPaymentData(ctx, saveResult, parsed, userId);
  }
}

// ─── Assinaturas: verificar cadastro ou perguntar tipo ───────────────────────

async function handleSubscriptionCheck(ctx, parsed, transactionId, userId) {
  const serviceName = extractSubscriptionName(parsed.description);
  // Lookup fuzzy: encontra sub cujo nome aparece na descrição
  const sub = findSubscriptionByDescription(userId, parsed.description)
    || getSubscription(userId, serviceName);

  if (sub) {
    if (!sub.billing_day) {
      pendingSubBillingDay.set(ctx.from.id, {
        subId: sub.id, transactionId, displayName: sub.name,
        myAmount: sub.my_amount, isSplit: false,
        isVariable: sub.is_variable, defaultCategory: sub.default_category || 'Assinaturas',
      });
      await ctx.reply(
        `Ah, o *${sub.name}* de novo 😏\nMas ainda não sei quando é cobrado. Qual o dia do mês?`,
        { parse_mode: 'Markdown' }
      );
      return true;
    }
    await ctx.reply(
      `Ah, o *${sub.name}* de novo. ${formatCurrency(sub.my_amount)}/mês debitado da sua consciência 😏`,
      { parse_mode: 'Markdown' }
    );
    return false;
  }

  // Primeira vez — perguntar tipo de recorrência
  pendingSubTypeSetup.set(transactionId, { serviceName, totalAmount: parsed.amount, telegramUserId: ctx.from.id });
  setTimeout(() => pendingSubTypeSetup.delete(transactionId), 5 * 60 * 1000);

  await ctx.reply(
    `📺 *${serviceName}* — esse serviço é mensal?`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📅 Fixo todo mês', `sub_type_fix_${transactionId}`)],
        [Markup.button.callback('📊 Mensal mas varia', `sub_type_var_${transactionId}`)],
        [Markup.button.callback('1️⃣ Foi só essa vez', `sub_type_one_${transactionId}`)],
      ]),
    }
  );
  return true;
}

async function handleSubscriptionType(ctx) {
  try {
    await ctx.answerCbQuery();
    const type = ctx.match[1]; // fix, var, one
    const transactionId = Number(ctx.match[2]);
    const pending = pendingSubTypeSetup.get(transactionId);
    if (!pending) { await ctx.editMessageText('⏰ Opção expirada.'); return; }

    pendingSubTypeSetup.delete(transactionId);

    if (type === 'one') {
      await ctx.editMessageText(
        `👍 Registrado como gasto avulso. Sem compromisso! 😌`,
        { parse_mode: 'Markdown' }
      );
      await askPaymentMethod(ctx, transactionId, pending.totalAmount, 'Assinaturas', pending.serviceName);
      return;
    }

    const isVariable = type === 'var';
    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);

    pendingSubBillingDay.set(ctx.from.id, {
      transactionId, displayName: pending.serviceName,
      totalAmount: pending.totalAmount, splitWith: 1,
      myAmount: pending.totalAmount, isSplit: false,
      dbUserId: user.id, isVariable, defaultCategory: 'Assinaturas',
    });

    await ctx.editMessageText(
      isVariable
        ? `📊 Mensal variável! Qual o dia de vencimento do *${pending.serviceName}*? _(ex: 10)_`
        : `📅 Fixo todo mês! Qual o dia de cobrança do *${pending.serviceName}*? _(ex: 15)_`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('[FinBot ERROR] Erro no fluxo de assinatura:', error.message);
  }
}

// ─── Contas variáveis (internet, luz, água, etc.) ─────────────────────────────

async function handleVariableBillCheck(ctx, parsed, transactionId, userId, serviceName) {
  const sub = getSubscription(userId, serviceName);

  if (sub && sub.is_variable) {
    // Conta variável já cadastrada — atualizar last amount e seguir
    updateSubscriptionAmount(sub.id, parsed.amount);
    return false; // perguntar método de pagamento normalmente
  }

  if (sub && !sub.is_variable) {
    // Existe como fixa (não deveria acontecer, mas tratar)
    return false;
  }

  // Primeira vez — perguntar se é mensal
  pendingVariableBillSetup.set(transactionId, {
    serviceName, category: parsed.category, telegramUserId: ctx.from.id, totalAmount: parsed.amount,
  });
  setTimeout(() => pendingVariableBillSetup.delete(transactionId), 5 * 60 * 1000);

  await ctx.reply(
    `🔌 *${serviceName}* — essa conta vem todo mês?`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('📅 Sim, é mensal', `varbill_yes_${transactionId}`),
          Markup.button.callback('1️⃣ Foi só essa vez', `varbill_no_${transactionId}`),
        ],
      ]),
    }
  );
  return true; // fluxo de conta variável cuida do método de pagamento
}

async function handleVariableBillChoice(ctx) {
  try {
    await ctx.answerCbQuery();
    const choice = ctx.match[1];
    const transactionId = Number(ctx.match[2]);
    const pending = pendingVariableBillSetup.get(transactionId);
    if (!pending) { await ctx.editMessageText('⏰ Opção expirada.'); return; }

    if (choice === 'no') {
      pendingVariableBillSetup.delete(transactionId);
      await ctx.editMessageText('👍 Entendido, registrado como gasto avulso!', { parse_mode: 'Markdown' });
      await askPaymentMethod(ctx, transactionId, pending.totalAmount, pending.category, pending.serviceName);
      return;
    }

    // Sim, é mensal — pedir dia de vencimento
    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
    pendingVariableBillSetup.delete(transactionId);
    pendingVariableBillDay.set(ctx.from.id, {
      transactionId, serviceName: pending.serviceName,
      category: pending.category, totalAmount: pending.totalAmount,
      dbUserId: user.id,
    });

    await ctx.editMessageText(
      `📅 Qual o dia que o *${pending.serviceName}* costuma vencer? _(ex: 10)_`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('[FinBot ERROR] Erro no fluxo de conta variável:', error.message);
  }
}

async function handleVariableBillDayInput(ctx, text) {
  const userId = ctx.from.id;
  const pending = pendingVariableBillDay.get(userId);
  const day = parseInt(text.trim(), 10);

  if (isNaN(day) || day < 1 || day > 31) {
    await ctx.reply('😬 Dia inválido. Digite um número entre 1 e 31.');
    return;
  }

  pendingVariableBillDay.delete(userId);

  saveSubscription(
    pending.dbUserId, pending.serviceName,
    pending.totalAmount, 1, pending.totalAmount, false,
    day, true, pending.category
  );

  await ctx.reply(
    `Anotado! Todo dia *${day}* vou te lembrar da conta de *${pending.serviceName}*.\nPorque você definitivamente ia esquecer 😏`,
    { parse_mode: 'Markdown' }
  );

  await askPaymentMethod(ctx, pending.transactionId, pending.totalAmount, pending.category, pending.serviceName);
}

// ─── Resposta de valor para lembrete de conta variável ───────────────────────

async function handlePendingBillAmount(ctx, text, billInfo) {
  const amount = parseMonetaryAmount(text);
  if (!amount) {
    await ctx.reply('Isso não parece um valor... tenta de novo? 🤨');
    return;
  }

  const user = getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
  insertSubscriptionTransaction(user.id, billInfo.subName, amount, billInfo.category);
  updateSubscriptionAmount(billInfo.subId, amount);
  resolvePendingBill(billInfo.pendingBillId);
  pendingBillAmount.delete(ctx.from.id);

  const sarcasm = getBillSarcasm(billInfo.subName);
  await ctx.reply(
    `${formatCurrency(amount)} ${sarcasm}.\nAnotado! 😒`,
    { parse_mode: 'Markdown' }
  );
}

// ─── Dia de cobrança (streaming fixo) ────────────────────────────────────────

async function handleSubBillingDayInput(ctx, text) {
  const userId = ctx.from.id;
  const pending = pendingSubBillingDay.get(userId);
  const day = parseInt(text.trim(), 10);

  if (isNaN(day) || day < 1 || day > 31) {
    await ctx.reply('😬 Dia inválido. Digite um número entre 1 e 31.');
    return;
  }

  pendingSubBillingDay.delete(userId);

  if (pending.subId) {
    updateSubscriptionBillingDay(pending.subId, day);
  } else {
    saveSubscription(
      pending.dbUserId, pending.displayName,
      pending.totalAmount, pending.splitWith, pending.myAmount, pending.isSplit,
      day, pending.isVariable || false, pending.defaultCategory || 'Assinaturas'
    );
  }

  const confirmMsg = pending.isVariable
    ? `📊 Todo dia *${day}* vou te lembrar do *${pending.displayName}*.\nPorque seu bolso precisa de aviso prévio 😒`
    : `📅 Todo dia *${day}* vou registrar o *${pending.displayName}* automaticamente.\nComo se você fosse cancelar algum dia 😏`;
  await ctx.reply(confirmMsg, { parse_mode: 'Markdown' });

  await askPaymentMethod(ctx, pending.transactionId, pending.myAmount, 'Assinaturas', pending.displayName);
}

// ─── Helpers: dados de pagamento pré-extraídos pela IA ───────────────────────

const MONTHS_PT = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

function normalizePaymentMethod(m) {
  if (!m || typeof m !== 'string') return null;
  const lower = m.toLowerCase().trim();
  return ['credito', 'debito', 'pix', 'dinheiro'].includes(lower) ? lower : null;
}

function normalizeInstallments(n) {
  const v = parseInt(n, 10);
  if (isNaN(v) || v < 1 || v > 120) return null;
  return v;
}

function formatInstallmentRange(baseDateStr, n) {
  const clean = (baseDateStr || new Date().toISOString().split('T')[0])
    .split('T')[0].split(' ')[0];
  const [by, bm] = clean.split('-').map(Number);
  const startIdx = bm - 1;
  const endDate = new Date(by, startIdx + (n - 1), 1);
  return endDate.getFullYear() !== by
    ? `de ${MONTHS_PT[startIdx]} de ${by} a ${MONTHS_PT[endDate.getMonth()]} de ${endDate.getFullYear()}`
    : `de ${MONTHS_PT[startIdx]} a ${MONTHS_PT[endDate.getMonth()]}`;
}

// Aplica parcelas direto e responde com sarcasmo
async function applyInstallmentsAndReply(ctx, txId, n, txDate, userId, cardName = null) {
  const { installmentAmount } = createInstallmentTransactions(txId, n, userId, txDate);
  const range = formatInstallmentRange(txDate, n);
  const cardPrefix = cardName ? `💳 ${cardName} — ` : '';
  await ctx.reply(
    `${n}x sem juros? _Mentira do universo._ 😏\n\n${cardPrefix}*${formatCurrency(installmentAmount)}/mês* *${range}*. 💳`,
    { parse_mode: 'Markdown' }
  );
}

// Orquestra tudo que vem pré-extraído pela IA (payment_method, card_name, installments).
// Retorna sem fazer nada se ainda restar pergunta — o fluxo continua via interação.
async function processPaymentData(ctx, saveResult, parsed, userId) {
  const txId = saveResult.transactionId;
  const txDate = saveResult.transactionDate;
  const method = normalizePaymentMethod(parsed.payment_method);
  const installments = normalizeInstallments(parsed.installments);

  // (0) Parcela JÁ EM ANDAMENTO informada (ex: "parcela 2/3") → registra e cria as restantes,
  //     sem perguntar nada sobre parcelamento.
  const current = normalizeInstallments(parsed.current_installment);
  const total = normalizeInstallments(parsed.total_installments);
  if (current && total && total >= current) {
    await processOngoingInstallment(ctx, txId, parsed, txDate, userId, current, total);
    return;
  }

  // (1) Sem método informado → pergunta tudo via fluxo clássico
  if (!method) {
    await askPaymentMethod(ctx, txId, parsed.amount, parsed.category, parsed.description, txDate);
    return;
  }

  // (2) Método não-crédito → salva direto, fim
  if (method !== 'credito') {
    updateTransactionPayment(txId, method, 1, 1, null, null);
    const labels = { debito: '🏦 Débito anotado!', pix: '⚡ Pix anotado!', dinheiro: '💵 Dinheiro anotado!' };
    await ctx.reply(`${labels[method]}\n_Pelo menos não vai gerar fatura. 😌_`, { parse_mode: 'Markdown' });
    return;
  }

  // (3) Crédito — precisa de cartão + (à vista ou parcelas)
  await processCreditFlow(ctx, txId, parsed, txDate, userId, installments);
}

async function processCreditFlow(ctx, txId, parsed, txDate, userId, installments) {
  const cardName = parsed.card_name;
  const user = getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);

  // (3a) Cartão informado → buscar no banco
  if (cardName && typeof cardName === 'string' && cardName.trim()) {
    const card = findCardByName(user.id, cardName.trim());
    if (card) {
      // Cartão encontrado → aplicar parcelas ou à vista direto
      updateTransactionCard(txId, card.name);
      if (installments && installments >= 2) {
        await applyInstallmentsAndReply(ctx, txId, installments, txDate, userId, card.name);
      } else {
        updateTransactionPayment(txId, 'credito', 1, 1, null, null);
        await ctx.reply(`💳 *${card.name}* — à vista no crédito. _Anotado!_`, { parse_mode: 'Markdown' });
      }
      return;
    }
    // Cartão não cadastrado → pular pergunta de nome, pedir só o vencimento
    pendingCardDueDayInput.set(ctx.from.id, {
      transactionId: txId,
      cardName: cardName.trim(),
      autoRegister: true,
      installmentsHint: installments,
      transactionDate: txDate,
    });
    await ctx.reply(
      `💳 Cartão *${cardName.trim()}* não está cadastrado. Qual o dia do vencimento? _(1 a 31)_`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // (3b) Crédito sem cartão informado → ir direto à seleção (sem reperguntar método)
  pendingPaymentUpdate.set(txId, {
    amount: parsed.amount, category: parsed.category, description: parsed.description,
    transactionDate: txDate, telegramUserId: ctx.from.id,
    installmentsHint: installments,
  });
  setTimeout(() => pendingPaymentUpdate.delete(txId), 5 * 60 * 1000);

  const cards = getAllCards(user.id);
  if (cards.length === 0) {
    pendingCardNameInput.set(ctx.from.id, { transactionId: txId });
    await ctx.reply('💳 Crédito. Qual o nome do cartão? _(ex: Nubank, Inter, XP)_', { parse_mode: 'Markdown' });
    return;
  }
  const cardButtons = cards.map((c) => [Markup.button.callback(`💳 ${c.name}`, `card_sel_${c.id}_${txId}`)]);
  cardButtons.push([Markup.button.callback('➕ Novo cartão', `card_new_${txId}`)]);
  await ctx.reply('💳 Qual cartão foi usado?', Markup.inlineKeyboard(cardButtons));
}

// Aplica as parcelas em andamento e responde (após o cartão estar resolvido)
async function applyOngoingAndReply(ctx, txId, current, total, txDate, userId, cardName = null) {
  const { installmentAmount, remaining } = createOngoingInstallments(txId, current, total, userId, txDate);
  const cardLabel = cardName ? `💳 ${cardName} — ` : '';

  if (remaining === 0) {
    await ctx.reply(
      `${cardLabel}*Parcela ${current}/${total}* registrada — a última! 🎉\n` +
      `_${formatCurrency(installmentAmount)}. Finalmente quita. Ou começa outra amanhã. 😏_`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  await ctx.reply(
    `${cardLabel}*Parcela ${current}/${total}* registrada!\n` +
    `Criei as *${remaining}* restantes de *${formatCurrency(installmentAmount)}/mês* nos próximos meses. 💳\n` +
    `_Esse dinheiro já era. Só não saiu da conta ainda. 😏_`,
    { parse_mode: 'Markdown' }
  );
}

// Parcela em andamento (ex: "parcela 2/3"): registra a atual e cria as restantes,
// sem perguntar sobre parcelamento. É sempre crédito — então o cartão é obrigatório.
async function processOngoingInstallment(ctx, txId, parsed, txDate, userId, current, total) {
  const user = getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);

  // (a) Cartão informado pela IA → resolver e aplicar direto
  if (parsed.card_name && typeof parsed.card_name === 'string' && parsed.card_name.trim()) {
    const card = findCardByName(user.id, parsed.card_name.trim());
    const name = card ? card.name : parsed.card_name.trim();
    updateTransactionCard(txId, name);
    await applyOngoingAndReply(ctx, txId, current, total, txDate, userId, name);
    return;
  }

  // (b) card_name null → SEMPRE perguntar o cartão antes de salvar as parcelas.
  pendingPaymentUpdate.set(txId, {
    amount: parsed.amount, category: parsed.category, description: parsed.description,
    transactionDate: txDate, telegramUserId: ctx.from.id,
    ongoingHint: { current, total },
  });
  setTimeout(() => pendingPaymentUpdate.delete(txId), 5 * 60 * 1000);

  const cards = getAllCards(user.id);
  if (cards.length === 0) {
    pendingCardNameInput.set(ctx.from.id, { transactionId: txId });
    await ctx.reply(
      `💳 Parcela ${current}/${total} no crédito. Qual o nome do cartão? _(ex: Nubank, Inter, XP)_`,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  const cardButtons = cards.map((c) => [Markup.button.callback(`💳 ${c.name}`, `card_sel_${c.id}_${txId}`)]);
  cardButtons.push([Markup.button.callback('➕ Novo cartão', `card_new_${txId}`)]);
  await ctx.reply(`💳 Parcela ${current}/${total} — qual cartão?`, Markup.inlineKeyboard(cardButtons));
}

// ─── Método de pagamento ──────────────────────────────────────────────────────

async function askPaymentMethod(ctx, transactionId, amount, category, description, transactionDate = null) {
  pendingPaymentUpdate.set(transactionId, { amount, category, description, transactionDate, telegramUserId: ctx.from.id });
  setTimeout(() => pendingPaymentUpdate.delete(transactionId), 5 * 60 * 1000);

  await ctx.reply(
    '💳 Como foi o pagamento?',
    Markup.inlineKeyboard([
      [
        Markup.button.callback('💳 Crédito', `pay_cred_${transactionId}`),
        Markup.button.callback('🏦 Débito', `pay_deb_${transactionId}`),
      ],
      [
        Markup.button.callback('⚡ Pix', `pay_pix_${transactionId}`),
        Markup.button.callback('💵 Dinheiro', `pay_din_${transactionId}`),
      ],
    ])
  );
}

async function handlePaymentMethod(ctx) {
  try {
    await ctx.answerCbQuery();
    const method = ctx.match[1];
    const transactionId = Number(ctx.match[2]);
    const pending = pendingPaymentUpdate.get(transactionId);
    if (!pending) { await ctx.editMessageText('⏰ Opção expirada. Transação salva como "outro".'); return; }

    if (method !== 'cred') {
      pendingPaymentUpdate.delete(transactionId);
      const methodMap = { deb: 'debito', pix: 'pix', din: 'dinheiro' };
      updateTransactionPayment(transactionId, methodMap[method], 1, 1, null, null);
      const labels = { deb: '🏦 Débito anotado!', pix: '⚡ Pix anotado!', din: '💵 Dinheiro anotado!' };
      await ctx.editMessageText(`${labels[method]}\n_Pelo menos não vai gerar fatura. 😌_`, { parse_mode: 'Markdown' });
      return;
    }

    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
    const cards = getAllCards(user.id);

    if (cards.length === 0) {
      pendingCardNameInput.set(ctx.from.id, { transactionId });
      await ctx.editMessageText('💳 Qual o nome desse cartão? _(ex: Nubank, Inter, XP)_', { parse_mode: 'Markdown' });
      return;
    }

    const cardButtons = cards.map((c) => [Markup.button.callback(`💳 ${c.name}`, `card_sel_${c.id}_${transactionId}`)]);
    cardButtons.push([Markup.button.callback('➕ Novo cartão', `card_new_${transactionId}`)]);
    await ctx.editMessageText('💳 Qual cartão foi usado?', Markup.inlineKeyboard(cardButtons));
  } catch (error) {
    console.error('[FinBot ERROR] Erro ao processar método de pagamento:', error.message);
  }
}

// ─── Cartão ───────────────────────────────────────────────────────────────────

async function handleCardSelection(ctx) {
  try {
    await ctx.answerCbQuery();
    const cardId = Number(ctx.match[1]);
    const transactionId = Number(ctx.match[2]);
    const pending = pendingPaymentUpdate.get(transactionId);
    if (!pending) { await ctx.editMessageText('⏰ Opção expirada.'); return; }

    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
    const cards = getAllCards(user.id);
    const card = cards.find((c) => c.id === cardId);
    if (!card) { await ctx.editMessageText('❌ Cartão não encontrado.'); return; }

    updateTransactionCard(transactionId, card.name);
    pending.cardName = card.name;

    if (pending.category === 'Assinaturas') {
      pendingPaymentUpdate.delete(transactionId);
      updateTransactionPayment(transactionId, 'credito', 1, 1, null, null);
      await ctx.editMessageText(`💳 *${card.name}* — assinatura no crédito anotada. 📺`, { parse_mode: 'Markdown' });
      return;
    }

    // Parcela em andamento (ex: 2/3) → aplicar as restantes com o cartão escolhido
    if (pending.ongoingHint) {
      pendingPaymentUpdate.delete(transactionId);
      await ctx.editMessageText(`💳 *${card.name}* selecionado!`, { parse_mode: 'Markdown' });
      await applyOngoingAndReply(ctx, transactionId, pending.ongoingHint.current, pending.ongoingHint.total, pending.transactionDate, user.id, card.name);
      return;
    }

    // Atalho: parcelas pré-informadas pelo usuário na mensagem
    if (pending.installmentsHint && pending.installmentsHint >= 2) {
      pendingPaymentUpdate.delete(transactionId);
      await ctx.editMessageText(`💳 *${card.name}* selecionado!`, { parse_mode: 'Markdown' });
      await applyInstallmentsAndReply(ctx, transactionId, pending.installmentsHint, pending.transactionDate, user.id, card.name);
      return;
    }
    if (pending.installmentsHint === 1) {
      pendingPaymentUpdate.delete(transactionId);
      updateTransactionPayment(transactionId, 'credito', 1, 1, null, null);
      await ctx.editMessageText(`💳 *${card.name}* — à vista no crédito. Anotado!`, { parse_mode: 'Markdown' });
      return;
    }

    await ctx.editMessageText(
      `💳 *${card.name}* selecionado! Compra parcelada?`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('1️⃣ À vista', `inst_av_${transactionId}`),
            Markup.button.callback('📅 Parcelado', `inst_pr_${transactionId}`),
          ],
        ]),
      }
    );
  } catch (error) {
    console.error('[FinBot ERROR] Erro ao selecionar cartão:', error.message);
  }
}

async function handleNewCard(ctx) {
  try {
    await ctx.answerCbQuery();
    const transactionId = Number(ctx.match[1]);
    pendingCardNameInput.set(ctx.from.id, { transactionId, forceNew: true });
    await ctx.editMessageText('💳 Qual o nome do novo cartão? _(ex: Nubank, Inter, XP)_', { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('[FinBot ERROR] Erro ao iniciar cadastro de cartão:', error.message);
  }
}

async function handleCardNameInput(ctx, text) {
  const userId = ctx.from.id;
  const pending = pendingCardNameInput.get(userId);
  if (!pending) return; // estado expirou

  // Consultar banco ANTES de aceitar o texto — evita cartões duplicados
  const user = getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
  const cards = getAllCards(user.id);

  if (cards.length > 0 && !pending.forceNew) {
    // Usuário já tem cartões: mostrar seleção inline em vez de criar novo
    pendingCardNameInput.delete(userId);
    const cardButtons = cards.map((c) => [
      Markup.button.callback(`💳 ${c.name}`, `card_sel_${c.id}_${pending.transactionId}`),
    ]);
    cardButtons.push([Markup.button.callback('➕ Novo cartão', `card_new_${pending.transactionId}`)]);
    await ctx.reply('💳 Você já tem cartões. Qual usar?', Markup.inlineKeyboard(cardButtons));
    return;
  }

  // Sem cartões cadastrados (ou forceNew) — aceitar nome digitado
  const name = text.trim();
  if (!name || name.length < 2 || name.length > 30) {
    await ctx.reply('😬 Nome inválido. Digite entre 2 e 30 caracteres (ex: Nubank).');
    return;
  }

  pendingCardNameInput.delete(userId);
  pendingCardDueDayInput.set(userId, { transactionId: pending.transactionId, cardName: name });
  await ctx.reply(`💳 *${name}* — qual o dia do vencimento? _(1 a 31)_`, { parse_mode: 'Markdown' });
}

async function handleCardDueDayInput(ctx, text) {
  const userId = ctx.from.id;
  const pending = pendingCardDueDayInput.get(userId);
  const day = parseInt(text.trim(), 10);

  if (isNaN(day) || day < 1 || day > 31) {
    await ctx.reply('😬 Dia inválido. Digite um número entre 1 e 31.');
    return;
  }

  pendingCardDueDayInput.delete(userId);

  const user = getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
  saveCard(user.id, pending.cardName, day);
  updateTransactionCard(pending.transactionId, pending.cardName);

  await ctx.reply(
    `✅ Cartão *${pending.cardName}* cadastrado! Vencimento todo dia *${day}*. Vou te avisar antes 😉`,
    { parse_mode: 'Markdown' }
  );

  // Atalho: cartão foi auto-cadastrado a partir da mensagem (parsed.card_name)
  if (pending.autoRegister) {
    if (pending.installmentsHint && pending.installmentsHint >= 2) {
      await applyInstallmentsAndReply(ctx, pending.transactionId, pending.installmentsHint, pending.transactionDate, user.id, pending.cardName);
      return;
    }
    // Sem parcelas informadas → à vista (auto-registro implica que tudo já estava na mensagem)
    updateTransactionPayment(pending.transactionId, 'credito', 1, 1, null, null);
    await ctx.reply(`💳 *${pending.cardName}* — à vista no crédito. Anotado!`, { parse_mode: 'Markdown' });
    return;
  }

  const paymentPending = pendingPaymentUpdate.get(pending.transactionId);

  // Parcela em andamento (ex: 2/3) aguardando cartão — aplicar agora com o cartão recém-cadastrado
  if (paymentPending?.ongoingHint) {
    pendingPaymentUpdate.delete(pending.transactionId);
    await applyOngoingAndReply(ctx, pending.transactionId, paymentPending.ongoingHint.current, paymentPending.ongoingHint.total, paymentPending.transactionDate, user.id, pending.cardName);
    return;
  }

  if (paymentPending?.category === 'Assinaturas') {
    pendingPaymentUpdate.delete(pending.transactionId);
    updateTransactionPayment(pending.transactionId, 'credito', 1, 1, null, null);
    await ctx.reply('📺 Assinatura no crédito — anotado!', { parse_mode: 'Markdown' });
    return;
  }

  // Cartão novo cadastrado via fluxo manual — pode haver installmentsHint vindo de processCreditFlow
  if (paymentPending?.installmentsHint && paymentPending.installmentsHint >= 2) {
    pendingPaymentUpdate.delete(pending.transactionId);
    await applyInstallmentsAndReply(ctx, pending.transactionId, paymentPending.installmentsHint, paymentPending.transactionDate, user.id, pending.cardName);
    return;
  }
  if (paymentPending?.installmentsHint === 1) {
    pendingPaymentUpdate.delete(pending.transactionId);
    updateTransactionPayment(pending.transactionId, 'credito', 1, 1, null, null);
    await ctx.reply(`💳 *${pending.cardName}* — à vista no crédito.`, { parse_mode: 'Markdown' });
    return;
  }

  await ctx.reply(
    `Compra parcelada?`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback('1️⃣ À vista', `inst_av_${pending.transactionId}`),
        Markup.button.callback('📅 Parcelado', `inst_pr_${pending.transactionId}`),
      ],
    ])
  );
}

// ─── À vista / Parcelado ──────────────────────────────────────────────────────

async function handleInstallmentChoice(ctx) {
  try {
    await ctx.answerCbQuery();
    const choice = ctx.match[1];
    const transactionId = Number(ctx.match[2]);
    const pending = pendingPaymentUpdate.get(transactionId);
    if (!pending) { await ctx.editMessageText('⏰ Opção expirada.'); return; }

    if (choice === 'av') {
      pendingPaymentUpdate.delete(transactionId);
      updateTransactionPayment(transactionId, 'credito', 1, 1, null, null);
      await ctx.editMessageText(`💳 À vista no crédito.\n_Pelo menos vai só no próximo mês. 😏_`, { parse_mode: 'Markdown' });
    } else {
      pendingInstallCount.set(pending.telegramUserId, { transactionId, ...pending });
      setTimeout(() => {
        const p = pendingInstallCount.get(pending.telegramUserId);
        if (p?.transactionId === transactionId) {
          pendingInstallCount.delete(pending.telegramUserId);
          pendingPaymentUpdate.delete(transactionId);
          updateTransactionPayment(transactionId, 'credito', 1, 1, null, null);
        }
      }, 5 * 60 * 1000);
      await ctx.editMessageText('📅 Em quantas vezes?\n_Digite só o número (ex: 12)_', { parse_mode: 'Markdown' });
    }
  } catch (error) {
    console.error('[FinBot ERROR] Erro ao processar parcelamento:', error.message);
  }
}

async function handleInstallmentCountInput(ctx, text) {
  const userId = ctx.from.id;
  const pending = pendingInstallCount.get(userId);
  const n = parseInt(text.trim(), 10);

  if (isNaN(n) || n < 2 || n > 120) {
    await ctx.reply('😬 Digite um número entre 2 e 120. Tente de novo.');
    return;
  }

  pendingInstallCount.delete(userId);
  pendingPaymentUpdate.delete(pending.transactionId);

  try {
    await applyInstallmentsAndReply(ctx, pending.transactionId, n, pending.transactionDate, userId);
  } catch (error) {
    console.error('[FinBot ERROR] Erro ao criar parcelas:', error.message);
    await ctx.reply('❌ Erro ao criar as parcelas. Tente novamente.');
  }
}

// ─── Handler de texto ─────────────────────────────────────────────────────────

async function handleTextMessage(ctx) {
  const text = ctx.message.text;
  if (text.startsWith('/')) return;

  const uid = ctx.from.id;

  if (pendingInstallCount.has(uid))      { await handleInstallmentCountInput(ctx, text); return; }
  if (pendingSubBillingDay.has(uid))     { await handleSubBillingDayInput(ctx, text); return; }
  if (pendingVariableBillDay.has(uid))    { await handleVariableBillDayInput(ctx, text); return; }
  if (pendingCardNameInput.has(uid))      { await handleCardNameInput(ctx, text); return; }
  if (pendingCardDueDayInput.has(uid))    { await handleCardDueDayInput(ctx, text); return; }

  // Resposta de valor para lembrete de conta variável
  const billPending = pendingBillAmount.get(uid);
  if (billPending) {
    await handlePendingBillAmount(ctx, text, billPending);
    return;
  }
  // Fallback DB (após restart do bot)
  try {
    const user = getOrCreateUser(uid, ctx.from.first_name, ctx.from.username);
    const dbBill = getUnresolvedPendingBill(user.id);
    if (dbBill) {
      await handlePendingBillAmount(ctx, text, {
        pendingBillId: dbBill.id, subId: dbBill.subscription_id,
        subName: dbBill.sub_name, category: dbBill.category, dbUserId: user.id,
      });
      return;
    }
  } catch { /* banco não inicializado ainda */ }

  try {
    const user = getOrCreateUser(uid, ctx.from.first_name, ctx.from.username);
    const result = await processMessage(text, user.id);

    if (!result.success) {
      const aiUnavailable = !process.env.GEMINI_API_KEY;
      await ctx.reply(
        aiUnavailable
          ? `⚙️ A IA está desabilitada no momento (GEMINI_API_KEY não configurada).\n\nUse os comandos disponíveis: /resumo, /saldo, /gastos, /metas ou /ajuda.`
          : `🤔 Não identifiquei uma transação financeira na sua mensagem.\n\nTente algo como:\n• _"Gastei 50 no mercado"_\n• _"Paguei 120 de internet"_\n• _"Recebi 2000 de freelance"_\n\nUse /ajuda para ver mais exemplos! 😊`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const { parsed } = result;

    if (result.needsConfirmation) {
      const key = `${user.id}_${Date.now()}`;
      pendingTransactions.set(key, { parsed, rawMessage: text, userId: user.id });
      setTimeout(() => pendingTransactions.delete(key), 5 * 60 * 1000);

      await ctx.reply(formatTransactionConfirm(parsed), {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Confirmar', `confirm_${key}`),
            Markup.button.callback('❌ Cancelar', 'cancel_transaction'),
          ],
          [Markup.button.callback('✏️ Corrigir categoria', `correct_${key}`)],
        ]),
      });
      return;
    }

    await saveAndReply(ctx, parsed, text, user.id);
  } catch (error) {
    console.error('[FinBot ERROR] Erro ao processar mensagem:', error.message);
    await ctx.reply('❌ Ocorreu um erro ao processar sua mensagem. Tente novamente em instantes.');
  }
}

// ─── Foto, Áudio, PDF ─────────────────────────────────────────────────────────

async function handlePhoto(ctx) {
  try {
    if (!process.env.GEMINI_API_KEY) { await ctx.reply('⚙️ IA não configurada.'); return; }
    await ctx.reply('🔍 Analisando o cupom... aguenta um segundo 🙄');
    const photos = ctx.message.photo;
    const base64 = await downloadTelegramFile(photos[photos.length - 1].file_id);
    const parsed = await analyzeImage(base64, 'image/jpeg');
    if (!parsed) { await ctx.reply('😬 Não consegui identificar uma transação nessa imagem.'); return; }
    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
    await saveAndReply(ctx, parsed, '[foto]', user.id);
  } catch (error) {
    console.error('[FinBot ERROR] Erro ao processar foto:', error.message);
    await ctx.reply('❌ Erro ao analisar a imagem. Tente novamente.');
  }
}

async function handleVoice(ctx) {
  try {
    if (!process.env.GEMINI_API_KEY) { await ctx.reply('⚙️ IA não configurada.'); return; }
    await ctx.reply('🎙️ Ouvindo seu áudio... esperamos que seja sobre dinheiro 😏');
    const { file_id, mime_type } = ctx.message.voice;
    const base64 = await downloadTelegramFile(file_id);
    const parsed = await analyzeAudio(base64, mime_type || 'audio/ogg');
    if (!parsed) { await ctx.reply('😬 Não consegui extrair uma transação do áudio.'); return; }
    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
    if (parsed.confidence >= 0.6) {
      await saveAndReply(ctx, parsed, '[áudio]', user.id);
    } else {
      const key = `${user.id}_${Date.now()}`;
      pendingTransactions.set(key, { parsed, rawMessage: '[áudio]', userId: user.id });
      setTimeout(() => pendingTransactions.delete(key), 5 * 60 * 1000);
      await ctx.reply(
        `🎙️ *Ouvi isso no seu áudio:*\n\n` + formatTransactionConfirm(parsed) + `\n\n_Tá certo isso? 🤔_`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('✅ Confirmar', `confirm_${key}`), Markup.button.callback('❌ Cancelar', 'cancel_transaction')],
          ]),
        }
      );
    }
  } catch (error) {
    console.error('[FinBot ERROR] Erro ao processar áudio:', error.message);
    await ctx.reply('❌ Erro ao analisar o áudio. Tente novamente.');
  }
}

async function handleDocument(ctx) {
  try {
    const doc = ctx.message.document;
    if (doc.mime_type !== 'application/pdf') { await ctx.reply('📎 Só consigo analisar arquivos PDF por enquanto.'); return; }
    if (!process.env.GEMINI_API_KEY) { await ctx.reply('⚙️ IA não configurada.'); return; }
    await ctx.reply('📄 Analisando o PDF... isso pode demorar um pouco ☕');
    const base64 = await downloadTelegramFile(doc.file_id);
    const transactions = await analyzePDF(base64);
    if (!transactions || transactions.length === 0) { await ctx.reply('😬 Não encontrei transações nesse PDF.'); return; }

    const totalExpenses = transactions.filter((t) => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
    const totalIncome = transactions.filter((t) => t.type === 'income').reduce((s, t) => s + t.amount, 0);

    let summary = `📄 *Encontrei ${transactions.length} transação(ões) no PDF:*\n\n`;
    for (const t of transactions.slice(0, 10)) {
      summary += `${t.type === 'expense' ? '💸' : '💰'} ${formatCurrency(t.amount)} — ${t.category} _(${t.description})_\n`;
    }
    if (transactions.length > 10) summary += `_...e mais ${transactions.length - 10} transação(ões)._\n`;
    summary += `\n💸 Gastos: *${formatCurrency(totalExpenses)}*\n💰 Receitas: *${formatCurrency(totalIncome)}*\n\n_Quer importar tudo? Sem volta, hein. 😏_`;

    const key = `${ctx.from.id}_${Date.now()}`;
    pendingPdfImports.set(key, { transactions, userId: ctx.from.id, firstName: ctx.from.first_name, username: ctx.from.username });
    setTimeout(() => pendingPdfImports.delete(key), 10 * 60 * 1000);

    await ctx.reply(summary, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Importar tudo', `pdf_imp_${key}`), Markup.button.callback('❌ Cancelar', `pdf_can_${key}`)],
      ]),
    });
  } catch (error) {
    console.error('[FinBot ERROR] Erro ao processar PDF:', error.message);
    await ctx.reply('❌ Erro ao analisar o PDF. Tente novamente.');
  }
}

async function handlePdfImport(ctx) {
  try {
    await ctx.answerCbQuery();
    const key = ctx.match[1];
    const pending = pendingPdfImports.get(key);
    if (!pending) { await ctx.editMessageText('⏰ Importação expirada. Envie o PDF novamente.'); return; }
    pendingPdfImports.delete(key);
    const user = getOrCreateUser(pending.userId, pending.firstName, pending.username);

    let saved = 0, failed = 0;
    const items = []; // gastos salvos, candidatos a virar Negócio
    for (const parsed of pending.transactions) {
      const result = await saveTransaction(user.id, parsed, '[PDF]');
      if (result.success) {
        saved++;
        if (parsed.type === 'expense') {
          items.push({ txId: result.transactionId, amount: parsed.amount, description: parsed.description || 'Sem descrição' });
        }
      } else {
        failed++;
      }
    }

    const msg = failed > 0
      ? `✅ *Importação concluída!*\n\n${saved} salvas, ${failed} falhou(aram). 😏`
      : `✅ *${saved} transação(ões) importada(s)!*\n\n_Seu saldo vai discordar. 🤡_`;
    await ctx.editMessageText(msg, { parse_mode: 'Markdown' });

    // Fluxo de revisão de gastos do negócio (só faz sentido se houver gastos)
    if (items.length === 0) return;

    const reviewKey = `${ctx.from.id}_${Date.now()}`;
    pendingBusinessReview.set(reviewKey, { dbUserId: user.id, items, selected: new Set(), page: 0 });
    setTimeout(() => pendingBusinessReview.delete(reviewKey), 10 * 60 * 1000);

    await ctx.reply(
      'Alguma dessas compras foi para a sua loja/negócio? 🏪',
      Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Sim, tem algumas', `biz_yes_${reviewKey}`),
          Markup.button.callback('❌ Não, todas pessoais', `biz_no_${reviewKey}`),
        ],
      ])
    );
  } catch (error) {
    console.error('[FinBot ERROR] Erro ao importar PDF:', error.message);
    await ctx.reply('❌ Erro ao importar as transações. Tente novamente.');
  }
}

// ─── Revisão: marcar gastos importados como Negócio ──────────────────────────

const BIZ_PER_PAGE = 10;

function truncateDesc(s, max = 24) {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function buildBusinessReviewKeyboard(key, review) {
  const { items, selected, page } = review;
  const start = page * BIZ_PER_PAGE;
  const pageItems = items.slice(start, start + BIZ_PER_PAGE);

  const rows = pageItems.map((it, i) => {
    const idx = start + i;
    const mark = selected.has(idx) ? '✅ ' : '▫️ ';
    const label = `${mark}${idx + 1}. ${formatCurrency(it.amount)} — ${truncateDesc(it.description)}`;
    return [Markup.button.callback(label, `biz_tog_${key}_${idx}`)];
  });

  const nav = [];
  if (page > 0) nav.push(Markup.button.callback('◀️ Anterior', `biz_page_${key}_${page - 1}`));
  if (start + BIZ_PER_PAGE < items.length) nav.push(Markup.button.callback('Próxima ▶️', `biz_page_${key}_${page + 1}`));
  if (nav.length) rows.push(nav);

  rows.push([Markup.button.callback(`✅ Confirmar seleção (${selected.size})`, `biz_ok_${key}`)]);
  return Markup.inlineKeyboard(rows);
}

async function handleBusinessReviewYes(ctx) {
  try {
    await ctx.answerCbQuery();
    const key = ctx.match[1];
    const review = pendingBusinessReview.get(key);
    if (!review) { await ctx.editMessageText('⏰ Revisão expirada.'); return; }
    await ctx.editMessageText(
      'Selecione as transações da loja _(toque para marcar/desmarcar; pode escolher várias)_:',
      { parse_mode: 'Markdown', ...buildBusinessReviewKeyboard(key, review) }
    );
  } catch (error) {
    console.error('[FinBot ERROR] Erro na revisão de negócio:', error.message);
  }
}

async function handleBusinessReviewNo(ctx) {
  try {
    await ctx.answerCbQuery();
    pendingBusinessReview.delete(ctx.match[1]);
    await ctx.editMessageText(
      '👍 *Ótimo!* Todas registradas como gastos pessoais.\n_Seu saldo agradece... ou não 😏_',
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('[FinBot ERROR] Erro ao recusar revisão de negócio:', error.message);
  }
}

async function handleBusinessReviewToggle(ctx) {
  try {
    await ctx.answerCbQuery();
    const key = ctx.match[1];
    const idx = Number(ctx.match[2]);
    const review = pendingBusinessReview.get(key);
    if (!review) { await ctx.editMessageText('⏰ Revisão expirada.'); return; }

    if (review.selected.has(idx)) review.selected.delete(idx);
    else review.selected.add(idx);

    await ctx.editMessageReplyMarkup(buildBusinessReviewKeyboard(key, review).reply_markup);
  } catch (error) {
    // Telegram lança erro se a markup for idêntica — ignorar silenciosamente
    if (!String(error.message).includes('message is not modified')) {
      console.error('[FinBot ERROR] Erro ao alternar seleção:', error.message);
    }
  }
}

async function handleBusinessReviewPage(ctx) {
  try {
    await ctx.answerCbQuery();
    const key = ctx.match[1];
    const page = Number(ctx.match[2]);
    const review = pendingBusinessReview.get(key);
    if (!review) { await ctx.editMessageText('⏰ Revisão expirada.'); return; }
    review.page = page;
    await ctx.editMessageReplyMarkup(buildBusinessReviewKeyboard(key, review).reply_markup);
  } catch (error) {
    if (!String(error.message).includes('message is not modified')) {
      console.error('[FinBot ERROR] Erro ao paginar revisão:', error.message);
    }
  }
}

async function handleBusinessReviewConfirm(ctx) {
  try {
    await ctx.answerCbQuery();
    const key = ctx.match[1];
    const review = pendingBusinessReview.get(key);
    if (!review) { await ctx.editMessageText('⏰ Revisão expirada.'); return; }
    pendingBusinessReview.delete(key);

    if (review.selected.size === 0) {
      await ctx.editMessageText(
        '🤷 Nenhuma selecionada. Tudo continua como gasto pessoal então.',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    let updated = 0;
    for (const idx of review.selected) {
      const item = review.items[idx];
      if (item && updateTransactionCategory(item.txId, review.dbUserId, 'Negócio')) updated++;
    }

    await ctx.editMessageText(
      `🏪 *Atualizei ${updated} transação(ões) para Negócio!*\n\n` +
      `_Misturando as finanças pessoais com as da loja... clássico empreendedor brasileiro 😏_`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('[FinBot ERROR] Erro ao confirmar revisão de negócio:', error.message);
    await ctx.reply('❌ Erro ao atualizar as categorias. Tente novamente.');
  }
}

async function handlePdfCancel(ctx) {
  try {
    await ctx.answerCbQuery('Cancelado.');
    pendingPdfImports.delete(ctx.match[1]);
    await ctx.editMessageText('❌ *Importação cancelada.*\n\n_O PDF foi ignorado. Por hoje. 😌_', { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('[FinBot ERROR] Erro ao cancelar importação PDF:', error.message);
  }
}

// ─── Confirmação texto/voz ────────────────────────────────────────────────────

async function handleConfirmCallback(ctx) {
  try {
    await ctx.answerCbQuery();
    const key = ctx.match[1];
    const pending = pendingTransactions.get(key);
    if (!pending) { await ctx.editMessageText('⏰ Confirmação expirada. Envie a mensagem novamente.'); return; }
    pendingTransactions.delete(key);

    const saveResult = await saveTransaction(pending.userId, pending.parsed, pending.rawMessage);
    if (!saveResult.success) { await ctx.editMessageText('❌ Erro ao salvar. Tente novamente.'); return; }

    const sarcasticText = await generateSarcasticResponse({
      type: pending.parsed.type, amount: pending.parsed.amount,
      category: pending.parsed.category, description: pending.parsed.description,
      categoryTotal: saveResult.categoryTotal,
    });

    const responseMsg = sarcasticText
      ? formatSarcasticSave(sarcasticText, pending.parsed, saveResult.categoryTotal)
      : `✅ *Confirmado!*\n\n${formatCurrency(pending.parsed.amount)} em ${pending.parsed.category}`;

    await ctx.editMessageText(responseMsg, { parse_mode: 'Markdown' });

    if (pending.parsed.type === 'expense') {
      const alerts = await runAlertsAfterExpense(pending.userId, pending.parsed.category, saveResult.categoryTotal);
      for (const alert of alerts) await ctx.reply(`${alert.emoji} ${alert.message}`, { parse_mode: 'Markdown' });

      if (pending.parsed.category === 'Assinaturas') {
        const skipPayment = await handleSubscriptionCheck(ctx, pending.parsed, saveResult.transactionId, pending.userId);
        if (skipPayment) return;
      }

      const variableService = detectVariableService(pending.parsed.description);
      if (variableService) {
        const skipPayment = await handleVariableBillCheck(ctx, pending.parsed, saveResult.transactionId, pending.userId, variableService);
        if (skipPayment) return;
      }

      await processPaymentData(ctx, saveResult, pending.parsed, pending.userId);
    }
  } catch (error) {
    console.error('[FinBot ERROR] Erro ao confirmar transação:', error.message);
    await ctx.reply('❌ Erro ao confirmar. Tente novamente.');
  }
}

async function handleCancelCallback(ctx) {
  try {
    await ctx.answerCbQuery('Transação cancelada.');
    await ctx.editMessageText('❌ *Transação cancelada.*\n\nSe quiser registrar, me envie a mensagem novamente.', { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('[FinBot ERROR] Erro ao cancelar transação:', error.message);
  }
}

// ─── Cancelamento de assinatura ───────────────────────────────────────────────

async function handleSubCancel(ctx) {
  try {
    await ctx.answerCbQuery();
    const subId = Number(ctx.match[1]);
    const sub = getSubscriptionById(subId);
    if (!sub) { await ctx.editMessageText('❌ Assinatura não encontrada.'); return; }
    await ctx.reply(
      `Cancelar o *${sub.name}*? Finalmente! 🎉`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Confirmar', `sub_cncl_yes_${subId}`),
            Markup.button.callback('❌ Manter', `sub_cncl_no_${subId}`),
          ],
        ]),
      }
    );
  } catch (error) {
    console.error('[FinBot ERROR] Erro ao iniciar cancelamento:', error.message);
  }
}

async function handleSubCancelConfirm(ctx) {
  try {
    await ctx.answerCbQuery();
    const subId = Number(ctx.match[1]);
    const sub = getSubscriptionById(subId);
    if (!sub) { await ctx.editMessageText('❌ Assinatura não encontrada.'); return; }
    deactivateSubscription(subId);
    await ctx.editMessageText(
      `✅ *${sub.name}* cancelado!\n\n_${formatCurrency(sub.my_amount)}/mês de volta ao bolso. Quem sabe por quanto tempo. 😏_`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('[FinBot ERROR] Erro ao confirmar cancelamento:', error.message);
  }
}

async function handleSubCancelKeep(ctx) {
  try {
    await ctx.answerCbQuery('Mantido!');
    const subId = Number(ctx.match[1]);
    const sub = getSubscriptionById(subId);
    await ctx.editMessageText(
      `👍 *${sub?.name || 'Assinatura'}* mantida.\n\n_Coragem de cancelar faltou. 🤡_`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('[FinBot ERROR] Erro ao manter assinatura:', error.message);
  }
}

// ─── /gerenciar ───────────────────────────────────────────────────────────────

const MGR_LABELS = {
  tx:    '🗑️ Limpar transações',
  cards: '💳 Limpar cartões',
  subs:  '📺 Limpar assinaturas',
  all:   '☢️ Limpar tudo',
};

async function handleGerenciarOption(ctx) {
  try {
    await ctx.answerCbQuery();
    const type = ctx.match[1];
    await ctx.editMessageText(
      `${MGR_LABELS[type]}\n\n_Tem certeza? Isso não tem volta...\nassim como seus gastos 😏_`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Confirmar', `mgr_ok_${type}`),
            Markup.button.callback('❌ Cancelar', 'mgr_cancel'),
          ],
        ]),
      }
    );
  } catch (error) {
    console.error('[FinBot ERROR] Erro no menu /gerenciar:', error.message);
  }
}

async function handleGerenciarConfirm(ctx) {
  try {
    await ctx.answerCbQuery();
    const type = ctx.match[1];
    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);

    const msgs = {
      tx:    'Pronto! Você está financeiramente virgem de novo 🫧',
      cards: 'Cartões apagados! Agora finja que não tem nenhum 💳',
      subs:  'Assinaturas removidas! Você vai cancelar de novo em 3... 2... 1... 📺',
      all:   'Tabula rasa! Zeramos tudo. Novo você, mesmos gastos 😏',
    };

    if (type === 'tx' || type === 'all') deleteAllTransactions(user.id);
    if (type === 'cards' || type === 'all') deleteAllCards(user.id);
    if (type === 'subs' || type === 'all') deleteAllSubscriptions(user.id);

    await ctx.editMessageText(`✅ *Feito!*\n\n_${msgs[type]}_`, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('[FinBot ERROR] Erro ao executar limpeza:', error.message);
    await ctx.reply('❌ Erro ao executar a limpeza. Tente novamente.');
  }
}

async function handleGerenciarCancel(ctx) {
  try {
    await ctx.answerCbQuery('Cancelado.');
    await ctx.editMessageText(
      '❌ *Cancelado.*\n\n_Seus dados continuam lá, julgando você em silêncio. 😌_',
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('[FinBot ERROR] Erro ao cancelar /gerenciar:', error.message);
  }
}

// ─── /limpar ──────────────────────────────────────────────────────────────────

async function handleLimparConfirmar(ctx) {
  try {
    await ctx.answerCbQuery();
    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
    const deleted = deleteAllTransactions(user.id);
    await ctx.editMessageText(
      `🗑️ *Feito. ${deleted} transação(ões) apagada(s).*\n\n_Conta zerada. Mesmos hábitos, provavelmente. 😏_`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('[FinBot ERROR] Erro ao limpar transações:', error.message);
    await ctx.reply('❌ Erro ao apagar as transações. Tente novamente.');
  }
}

async function handleLimparCancelar(ctx) {
  try {
    await ctx.answerCbQuery('Cancelado.');
    await ctx.editMessageText('👍 *Cancelado.* Suas transações estão seguras.\n\n_Por hoje você foi responsável. 😌_', { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('[FinBot ERROR] Erro ao cancelar /limpar:', error.message);
  }
}
