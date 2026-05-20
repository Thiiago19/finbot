import { Markup } from 'telegraf';
import {
  getOrCreateUser, deleteAllTransactions,
  updateTransactionPayment, createInstallmentTransactions, updateTransactionAmount,
  getSubscription, findSubscriptionByDescription, saveSubscription,
  updateSubscriptionBillingDay, deactivateSubscription, getSubscriptionById,
  updateSubscriptionAmount, insertSubscriptionTransaction,
  insertPendingBill, getUnresolvedPendingBill, resolvePendingBill,
  getAllCards, saveCard, updateTransactionCard,
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

  bot.action('limpar_confirmar', handleLimparConfirmar);
  bot.action('limpar_cancelar', handleLimparCancelar);
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

    await askPaymentMethod(ctx, saveResult.transactionId, parsed.amount, parsed.category, parsed.description);
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

// ─── Método de pagamento ──────────────────────────────────────────────────────

async function askPaymentMethod(ctx, transactionId, amount, category, description) {
  pendingPaymentUpdate.set(transactionId, { amount, category, description, telegramUserId: ctx.from.id });
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
    pendingCardNameInput.set(ctx.from.id, { transactionId });
    await ctx.editMessageText('💳 Qual o nome do novo cartão? _(ex: Nubank, Inter, XP)_', { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('[FinBot ERROR] Erro ao iniciar cadastro de cartão:', error.message);
  }
}

async function handleCardNameInput(ctx, text) {
  const userId = ctx.from.id;
  const pending = pendingCardNameInput.get(userId);
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

  const paymentPending = pendingPaymentUpdate.get(pending.transactionId);
  if (paymentPending?.category === 'Assinaturas') {
    pendingPaymentUpdate.delete(pending.transactionId);
    updateTransactionPayment(pending.transactionId, 'credito', 1, 1, null, null);
    await ctx.reply('📺 Assinatura no crédito — anotado!', { parse_mode: 'Markdown' });
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
    const { installmentAmount } = createInstallmentTransactions(pending.transactionId, n, userId);
    await ctx.reply(
      `${n}x sem juros? _Mentira do universo._ 😏\n\nAnotei *${formatCurrency(installmentAmount)}/mês* pelos próximos *${n} meses*. 💳`,
      { parse_mode: 'Markdown' }
    );
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
    for (const parsed of pending.transactions) {
      const result = await saveTransaction(user.id, parsed, '[PDF]');
      result.success ? saved++ : failed++;
    }
    const msg = failed > 0
      ? `✅ *Importação concluída!*\n\n${saved} salvas, ${failed} falhou(aram). 😏`
      : `✅ *${saved} transação(ões) importada(s)!*\n\n_Seu saldo vai discordar. 🤡_`;
    await ctx.editMessageText(msg, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('[FinBot ERROR] Erro ao importar PDF:', error.message);
    await ctx.reply('❌ Erro ao importar as transações. Tente novamente.');
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

      await askPaymentMethod(ctx, saveResult.transactionId, pending.parsed.amount, pending.parsed.category, pending.parsed.description);
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
