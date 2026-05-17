import { Markup } from 'telegraf';
import {
  getOrCreateUser, deleteAllTransactions,
  updateTransactionPayment, createInstallmentTransactions, updateTransactionAmount,
  getSubscription, saveSubscription,
  getAllCards, saveCard, updateTransactionCard,
} from '../db/queries.js';
import { processMessage, saveTransaction } from '../services/transactions.js';
import { runAlertsAfterExpense } from '../services/alerts.js';
import { generateSarcasticResponse } from '../ai/gemini.js';
import { downloadTelegramFile, analyzeImage, analyzeAudio, analyzePDF } from '../ai/media.js';
import {
  formatCurrency,
  formatTransactionConfirm,
  formatSarcasticSave,
} from './formatter.js';

// ─── Detecção de serviços de streaming ───────────────────────────────────────

const STREAMING_SERVICES = [
  ['spotify', 'Spotify'], ['netflix', 'Netflix'], ['disney', 'Disney+'],
  ['hbo max', 'Max'], ['max', 'Max'], ['globoplay', 'Globoplay'],
  ['amazon prime', 'Amazon Prime'], ['prime video', 'Amazon Prime'],
  ['youtube premium', 'YouTube Premium'], ['apple tv', 'Apple TV+'],
  ['paramount', 'Paramount+'], ['apple music', 'Apple Music'], ['deezer', 'Deezer'],
];

function detectServiceName(description) {
  if (!description) return { key: 'assinatura', display: 'Assinatura' };
  const lower = description.toLowerCase();
  for (const [key, display] of STREAMING_SERVICES) {
    if (lower.includes(key)) return { key, display };
  }
  const word = description.replace(/[^\w\s]/g, '').split(/\s+/)[0];
  return { key: word.toLowerCase(), display: word };
}

// ─── State maps ───────────────────────────────────────────────────────────────

const pendingTransactions  = new Map(); // confirmação texto/voz
const pendingPdfImports    = new Map(); // importação PDF
const pendingPaymentUpdate = new Map(); // transactionId → dados método pagamento
const pendingInstallCount  = new Map(); // userId → aguarda nº parcelas (texto)
const pendingSubSplit      = new Map(); // transactionId → aguarda solo/dividido
const pendingSubCount      = new Map(); // userId → aguarda nº pessoas (texto)
const pendingCardNameInput = new Map(); // userId → aguarda nome do cartão (texto)
const pendingCardDueDayInput = new Map(); // userId → aguarda dia vencimento (texto)

export function registerHandlers(bot) {
  bot.on('text', handleTextMessage);
  bot.on('photo', handlePhoto);
  bot.on('voice', handleVoice);
  bot.on('document', handleDocument);

  bot.action(/^confirm_(.+)$/, handleConfirmCallback);
  bot.action('cancel_transaction', handleCancelCallback);

  bot.action(/^pay_(cred|deb|pix|din)_(\d+)$/, handlePaymentMethod);
  bot.action(/^inst_(av|pr)_(\d+)$/, handleInstallmentChoice);

  bot.action(/^sub_(solo|split)_(\d+)$/, handleSubscriptionSplit);
  bot.action(/^card_sel_(\d+)_(\d+)$/, handleCardSelection);
  bot.action(/^card_new_(\d+)$/, handleNewCard);

  bot.action(/^pdf_imp_(.+)$/, handlePdfImport);
  bot.action(/^pdf_can_(.+)$/, handlePdfCancel);

  bot.action('limpar_confirmar', handleLimparConfirmar);
  bot.action('limpar_cancelar', handleLimparCancelar);
}

// ─── Helper central: salvar → sarcasmo → alertas → assinatura/pagamento ─────

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

  const responseMsg = sarcasticText
    ? formatSarcasticSave(sarcasticText, parsed, saveResult.categoryTotal)
    : `✅ *Registrado!*\n\n${formatCurrency(parsed.amount)} em ${parsed.category}`;

  await ctx.reply(responseMsg, { parse_mode: 'Markdown' });

  if (parsed.type === 'expense') {
    const alerts = await runAlertsAfterExpense(userId, parsed.category, saveResult.categoryTotal);
    for (const alert of alerts) {
      await ctx.reply(`${alert.emoji} ${alert.message}`, { parse_mode: 'Markdown' });
    }

    if (parsed.category === 'Assinaturas') {
      const skipPayment = await handleSubscriptionCheck(ctx, parsed, saveResult.transactionId, userId);
      if (skipPayment) return;
    }

    await askPaymentMethod(ctx, saveResult.transactionId, parsed.amount, parsed.category, parsed.description);
  }
}

// ─── Assinatura: verificar se já existe ou perguntar sobre divisão ────────────

async function handleSubscriptionCheck(ctx, parsed, transactionId, userId) {
  const { key, display } = detectServiceName(parsed.description);
  const sub = getSubscription(userId, display);

  if (sub) {
    await ctx.reply(
      `Ah, o *${sub.name}* de novo. ${formatCurrency(sub.my_amount)}/mês debitado da sua consciência 😏`,
      { parse_mode: 'Markdown' }
    );
    return false; // continua para perguntar método de pagamento
  }

  pendingSubSplit.set(transactionId, {
    key, display, totalAmount: parsed.amount, telegramUserId: ctx.from.id,
  });
  setTimeout(() => {
    const p = pendingSubSplit.get(transactionId);
    if (p) {
      pendingSubSplit.delete(transactionId);
      const user = getOrCreateUser(p.telegramUserId, '', null);
      saveSubscription(user.id, p.display, p.totalAmount, 1, p.totalAmount, false);
    }
  }, 5 * 60 * 1000);

  await ctx.reply(
    `📺 *${display}* — você divide com alguém?`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('👤 Só eu', `sub_solo_${transactionId}`),
          Markup.button.callback('👥 Dividido', `sub_split_${transactionId}`),
        ],
      ]),
    }
  );
  return true; // fluxo de assinatura vai perguntar método de pagamento depois
}

async function handleSubscriptionSplit(ctx) {
  try {
    await ctx.answerCbQuery();
    const choice = ctx.match[1];
    const transactionId = Number(ctx.match[2]);
    const pending = pendingSubSplit.get(transactionId);
    if (!pending) { await ctx.editMessageText('⏰ Opção expirada.'); return; }

    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);

    if (choice === 'solo') {
      pendingSubSplit.delete(transactionId);
      saveSubscription(user.id, pending.display, pending.totalAmount, 1, pending.totalAmount, false);
      await ctx.editMessageText(
        `👤 Entendido! Vou registrar *${formatCurrency(pending.totalAmount)}/mês* como sua parte do ${pending.display}. Combinado! 📺`,
        { parse_mode: 'Markdown' }
      );
      await askPaymentMethod(ctx, transactionId, pending.totalAmount, 'Assinaturas', pending.display);
    } else {
      pendingSubCount.set(ctx.from.id, { transactionId, ...pending, dbUserId: user.id });
      await ctx.editMessageText(
        '👥 Com quantas pessoas no total? _(incluindo você, ex: 3)_',
        { parse_mode: 'Markdown' }
      );
    }
  } catch (error) {
    console.error('[FinBot ERROR] Erro no fluxo de assinatura:', error.message);
  }
}

async function handleSubscriptionCountInput(ctx, text) {
  const userId = ctx.from.id;
  const pending = pendingSubCount.get(userId);
  const n = parseInt(text.trim(), 10);

  if (isNaN(n) || n < 2 || n > 50) {
    await ctx.reply('😬 Digite um número entre 2 e 50. Quantas pessoas dividem ao total?');
    return;
  }

  pendingSubCount.delete(userId);
  pendingSubSplit.delete(pending.transactionId);

  const myAmount = Math.round((pending.totalAmount / n) * 100) / 100;
  saveSubscription(pending.dbUserId, pending.display, pending.totalAmount, n, myAmount, true);
  updateTransactionAmount(pending.transactionId, myAmount);

  await ctx.reply(
    `Entendido! Vou registrar *${formatCurrency(myAmount)}/mês* como sua parte do ${pending.display} _(dividido por ${n})_. Combinado! 📺`,
    { parse_mode: 'Markdown' }
  );

  await askPaymentMethod(ctx, pending.transactionId, myAmount, 'Assinaturas', pending.display);
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

    // Crédito: verificar cartões cadastrados
    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
    const cards = getAllCards(user.id);

    if (cards.length === 0) {
      pendingCardNameInput.set(ctx.from.id, { transactionId });
      await ctx.editMessageText('💳 Qual o nome desse cartão? _(ex: Nubank, Inter, XP)_', { parse_mode: 'Markdown' });
      return;
    }

    const cardButtons = cards.map((c) => [
      Markup.button.callback(`💳 ${c.name}`, `card_sel_${c.id}_${transactionId}`),
    ]);
    cardButtons.push([Markup.button.callback('➕ Novo cartão', `card_new_${transactionId}`)]);
    await ctx.editMessageText('💳 Qual cartão foi usado?', Markup.inlineKeyboard(cardButtons));
  } catch (error) {
    console.error('[FinBot ERROR] Erro ao processar método de pagamento:', error.message);
  }
}

// ─── Seleção / cadastro de cartão ────────────────────────────────────────────

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
    await ctx.reply('😬 Nome inválido. Digite um nome entre 2 e 30 caracteres (ex: Nubank).');
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

// ─── À vista / Parcelado ─────────────────────────────────────────────────────

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

// ─── Handler de texto: verifica todos os estados pendentes ───────────────────

async function handleTextMessage(ctx) {
  const text = ctx.message.text;
  if (text.startsWith('/')) return;

  const uid = ctx.from.id;

  if (pendingInstallCount.has(uid))    { await handleInstallmentCountInput(ctx, text); return; }
  if (pendingSubCount.has(uid))         { await handleSubscriptionCountInput(ctx, text); return; }
  if (pendingCardNameInput.has(uid))    { await handleCardNameInput(ctx, text); return; }
  if (pendingCardDueDayInput.has(uid))  { await handleCardDueDayInput(ctx, text); return; }

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

// ─── Foto ────────────────────────────────────────────────────────────────────

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

// ─── Áudio ───────────────────────────────────────────────────────────────────

async function handleVoice(ctx) {
  try {
    if (!process.env.GEMINI_API_KEY) { await ctx.reply('⚙️ IA não configurada.'); return; }
    await ctx.reply('🎙️ Ouvindo seu áudio... esperamos que seja sobre dinheiro 😏');
    const { file_id, mime_type } = ctx.message.voice;
    const base64 = await downloadTelegramFile(file_id);
    const parsed = await analyzeAudio(base64, mime_type || 'audio/ogg');
    if (!parsed) { await ctx.reply('😬 Não consegui extrair uma transação do áudio.', { parse_mode: 'Markdown' }); return; }
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

// ─── PDF ─────────────────────────────────────────────────────────────────────

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
