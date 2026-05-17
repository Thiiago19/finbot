import { Markup } from 'telegraf';
import {
  getOrCreateUser, deleteAllTransactions,
  updateTransactionPayment, createInstallmentTransactions,
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

const pendingTransactions = new Map();   // key: string → confirmação de texto/voz
const pendingPdfImports = new Map();     // key: string → importação de PDF
const pendingPaymentUpdate = new Map();  // key: transactionId → dados para método de pagamento
const pendingInstallmentCount = new Map(); // key: userId → aguardando texto com nº de parcelas

export function registerHandlers(bot) {
  bot.on('text', handleTextMessage);
  bot.on('photo', handlePhoto);
  bot.on('voice', handleVoice);
  bot.on('document', handleDocument);

  bot.action(/^confirm_(.+)$/, handleConfirmCallback);
  bot.action('cancel_transaction', handleCancelCallback);

  bot.action(/^pay_(cred|deb|pix|din)_(\d+)$/, handlePaymentMethod);
  bot.action(/^inst_(av|pr)_(\d+)$/, handleInstallmentChoice);

  bot.action(/^pdf_imp_(.+)$/, handlePdfImport);
  bot.action(/^pdf_can_(.+)$/, handlePdfCancel);

  bot.action('limpar_confirmar', handleLimparConfirmar);
  bot.action('limpar_cancelar', handleLimparCancelar);
}

// ─── Helper: salvar + responder sarcástico + pedir método ────────────────────

async function saveAndReply(ctx, parsed, rawSource, userId) {
  const saveResult = await saveTransaction(userId, parsed, rawSource);
  if (!saveResult.success) {
    await ctx.reply('❌ Erro ao salvar a transação. Tente novamente.');
    return;
  }

  const sarcasticText = await generateSarcasticResponse({
    type: parsed.type,
    amount: parsed.amount,
    category: parsed.category,
    description: parsed.description,
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
    await askPaymentMethod(ctx, saveResult.transactionId, parsed.amount, parsed.category, parsed.description);
  }
}

async function askPaymentMethod(ctx, transactionId, amount, category, description) {
  pendingPaymentUpdate.set(transactionId, { amount, category, description, userId: ctx.from.id });
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

// ─── Texto ───────────────────────────────────────────────────────────────────

async function handleTextMessage(ctx) {
  const text = ctx.message.text;
  if (text.startsWith('/')) return;

  // Verificar se usuário está aguardando número de parcelas
  if (pendingInstallmentCount.has(ctx.from.id)) {
    await handleInstallmentCountInput(ctx, text);
    return;
  }

  try {
    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
    const result = await processMessage(text, user.id);

    if (!result.success) {
      const aiUnavailable = !process.env.GEMINI_API_KEY;
      if (aiUnavailable) {
        await ctx.reply(
          `⚙️ A IA está desabilitada no momento (GEMINI_API_KEY não configurada).\n\n` +
          `Use os comandos disponíveis: /resumo, /saldo, /gastos, /metas ou /ajuda.`,
          { parse_mode: 'Markdown' }
        );
      } else {
        await ctx.reply(
          `🤔 Não identifiquei uma transação financeira na sua mensagem.\n\n` +
          `Tente algo como:\n` +
          `• _"Gastei 50 no mercado"_\n` +
          `• _"Paguei 120 de internet"_\n` +
          `• _"Recebi 2000 de freelance"_\n\n` +
          `Use /ajuda para ver mais exemplos! 😊`,
          { parse_mode: 'Markdown' }
        );
      }
      return;
    }

    const { parsed } = result;

    if (result.needsConfirmation) {
      const key = `${user.id}_${Date.now()}`;
      pendingTransactions.set(key, { parsed, rawMessage: text, userId: user.id });
      setTimeout(() => pendingTransactions.delete(key), 5 * 60 * 1000);

      await ctx.reply(
        formatTransactionConfirm(parsed),
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('✅ Confirmar', `confirm_${key}`),
              Markup.button.callback('❌ Cancelar', 'cancel_transaction'),
            ],
            [Markup.button.callback('✏️ Corrigir categoria', `correct_${key}`)],
          ]),
        }
      );
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
    if (!process.env.GEMINI_API_KEY) {
      await ctx.reply('⚙️ IA não configurada. Adicione a GEMINI_API_KEY para usar esta função.');
      return;
    }
    await ctx.reply('🔍 Analisando o cupom... aguenta um segundo 🙄');
    const photos = ctx.message.photo;
    const base64 = await downloadTelegramFile(photos[photos.length - 1].file_id);
    const parsed = await analyzeImage(base64, 'image/jpeg');
    if (!parsed) {
      await ctx.reply('😬 Não consegui identificar uma transação nessa imagem.\nTente uma foto mais clara do cupom ou nota fiscal.');
      return;
    }
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
    if (!process.env.GEMINI_API_KEY) {
      await ctx.reply('⚙️ IA não configurada. Adicione a GEMINI_API_KEY para usar esta função.');
      return;
    }
    await ctx.reply('🎙️ Ouvindo seu áudio... esperamos que seja sobre dinheiro 😏');
    const { file_id, mime_type } = ctx.message.voice;
    const base64 = await downloadTelegramFile(file_id);
    const parsed = await analyzeAudio(base64, mime_type || 'audio/ogg');
    if (!parsed) {
      await ctx.reply('😬 Não consegui extrair uma transação do áudio.\nTente falar: _"gastei cinquenta reais no mercado"_', { parse_mode: 'Markdown' });
      return;
    }
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
            [
              Markup.button.callback('✅ Confirmar', `confirm_${key}`),
              Markup.button.callback('❌ Cancelar', 'cancel_transaction'),
            ],
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
    if (doc.mime_type !== 'application/pdf') {
      await ctx.reply('📎 Só consigo analisar arquivos PDF por enquanto.\nPara outros tipos, tente descrever a transação em texto.');
      return;
    }
    if (!process.env.GEMINI_API_KEY) {
      await ctx.reply('⚙️ IA não configurada. Adicione a GEMINI_API_KEY para usar esta função.');
      return;
    }
    await ctx.reply('📄 Analisando o PDF... isso pode demorar um pouco ☕');
    const base64 = await downloadTelegramFile(doc.file_id);
    const transactions = await analyzePDF(base64);
    if (!transactions || transactions.length === 0) {
      await ctx.reply('😬 Não encontrei transações financeiras nesse PDF.\nTente um extrato bancário ou fatura de cartão.');
      return;
    }
    const totalExpenses = transactions.filter((t) => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
    const totalIncome = transactions.filter((t) => t.type === 'income').reduce((s, t) => s + t.amount, 0);

    let summary = `📄 *Encontrei ${transactions.length} transação(ões) no PDF:*\n\n`;
    for (const t of transactions.slice(0, 10)) {
      summary += `${t.type === 'expense' ? '💸' : '💰'} ${formatCurrency(t.amount)} — ${t.category} _(${t.description})_\n`;
    }
    if (transactions.length > 10) summary += `_...e mais ${transactions.length - 10} transação(ões)._\n`;
    summary += `\n💸 Gastos: *${formatCurrency(totalExpenses)}*\n`;
    summary += `💰 Receitas: *${formatCurrency(totalIncome)}*\n\n`;
    summary += `_Quer importar tudo? Sem volta, hein. 😏_`;

    const key = `${ctx.from.id}_${Date.now()}`;
    pendingPdfImports.set(key, {
      transactions, userId: ctx.from.id,
      firstName: ctx.from.first_name, username: ctx.from.username,
    });
    setTimeout(() => pendingPdfImports.delete(key), 10 * 60 * 1000);

    await ctx.reply(summary, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Importar tudo', `pdf_imp_${key}`),
          Markup.button.callback('❌ Cancelar', `pdf_can_${key}`),
        ],
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
    if (!pending) { await ctx.editMessageText('⏰ Essa importação expirou. Envie o PDF novamente.'); return; }
    pendingPdfImports.delete(key);
    const user = getOrCreateUser(pending.userId, pending.firstName, pending.username);
    let saved = 0, failed = 0;
    for (const parsed of pending.transactions) {
      const result = await saveTransaction(user.id, parsed, '[PDF]');
      result.success ? saved++ : failed++;
    }
    const msg = failed > 0
      ? `✅ *Importação concluída!*\n\n${saved} salvas, ${failed} falhou(aram).\n_Vida que segue. 😏_`
      : `✅ *${saved} transação(ões) importada(s)!*\n\n_Seu histórico agradece. Seu saldo, talvez não. 🤡_`;
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

// ─── Confirmação de texto/voz ─────────────────────────────────────────────────

async function handleConfirmCallback(ctx) {
  try {
    await ctx.answerCbQuery();
    const key = ctx.match[1];
    const pending = pendingTransactions.get(key);
    if (!pending) { await ctx.editMessageText('⏰ Essa confirmação expirou. Por favor, envie a mensagem novamente.'); return; }
    pendingTransactions.delete(key);

    const saveResult = await saveTransaction(pending.userId, pending.parsed, pending.rawMessage);
    if (!saveResult.success) { await ctx.editMessageText('❌ Erro ao salvar a transação. Tente novamente.'); return; }

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
      await askPaymentMethod(ctx, saveResult.transactionId, pending.parsed.amount, pending.parsed.category, pending.parsed.description);
    }
  } catch (error) {
    console.error('[FinBot ERROR] Erro ao confirmar transação:', error.message);
    await ctx.reply('❌ Erro ao confirmar. Tente enviar a mensagem novamente.');
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

// ─── Método de pagamento ──────────────────────────────────────────────────────

async function handlePaymentMethod(ctx) {
  try {
    await ctx.answerCbQuery();
    const method = ctx.match[1];
    const transactionId = Number(ctx.match[2]);
    const pending = pendingPaymentUpdate.get(transactionId);

    if (!pending) {
      await ctx.editMessageText('⏰ Opção expirada. A transação foi salva como "outro".');
      return;
    }

    if (method === 'cred') {
      await ctx.editMessageText(
        '💳 Crédito! Agora me conta: foi parcelado?',
        Markup.inlineKeyboard([
          [
            Markup.button.callback('1️⃣ À vista', `inst_av_${transactionId}`),
            Markup.button.callback('📅 Parcelado', `inst_pr_${transactionId}`),
          ],
        ])
      );
      return;
    }

    pendingPaymentUpdate.delete(transactionId);
    const methodMap = { deb: 'debito', pix: 'pix', din: 'dinheiro' };
    const paymentMethod = methodMap[method] || 'outro';
    updateTransactionPayment(transactionId, paymentMethod, 1, 1, null, null);

    const labels = { deb: '🏦 Débito anotado!', pix: '⚡ Pix anotado!', din: '💵 Dinheiro anotado!' };
    await ctx.editMessageText(
      `${labels[method] || '✅ Anotado!'}\n_Pelo menos não vai gerar fatura. 😌_`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('[FinBot ERROR] Erro ao processar método de pagamento:', error.message);
  }
}

async function handleInstallmentChoice(ctx) {
  try {
    await ctx.answerCbQuery();
    const choice = ctx.match[1];
    const transactionId = Number(ctx.match[2]);
    const pending = pendingPaymentUpdate.get(transactionId);

    if (!pending) {
      await ctx.editMessageText('⏰ Opção expirada.');
      return;
    }

    if (choice === 'av') {
      pendingPaymentUpdate.delete(transactionId);
      updateTransactionPayment(transactionId, 'credito', 1, 1, null, null);
      await ctx.editMessageText(
        `💳 À vista no crédito.\n_Pelo menos vai só no próximo mês. 😏_`,
        { parse_mode: 'Markdown' }
      );
    } else {
      // Parcelado: aguardar texto com número de parcelas
      pendingInstallmentCount.set(pending.userId, { transactionId, ...pending });
      setTimeout(() => {
        if (pendingInstallmentCount.get(pending.userId)?.transactionId === transactionId) {
          pendingInstallmentCount.delete(pending.userId);
          pendingPaymentUpdate.delete(transactionId);
          updateTransactionPayment(transactionId, 'credito', 1, 1, null, null);
        }
      }, 5 * 60 * 1000);

      await ctx.editMessageText(
        '📅 Em quantas vezes?\n_Digite só o número (ex: 12)_',
        { parse_mode: 'Markdown' }
      );
    }
  } catch (error) {
    console.error('[FinBot ERROR] Erro ao processar parcelamento:', error.message);
  }
}

async function handleInstallmentCountInput(ctx, text) {
  const userId = ctx.from.id;
  const pending = pendingInstallmentCount.get(userId);
  const n = parseInt(text.trim(), 10);

  if (isNaN(n) || n < 2 || n > 120) {
    await ctx.reply('😬 Digite um número entre 2 e 120. Tente de novo.');
    return;
  }

  pendingInstallmentCount.delete(userId);
  pendingPaymentUpdate.delete(pending.transactionId);

  try {
    const { installmentAmount } = createInstallmentTransactions(pending.transactionId, n, userId);
    await ctx.reply(
      `${n}x sem juros? _Mentira do universo._ 😏\n\n` +
      `Anotei *${formatCurrency(installmentAmount)}/mês* pelos próximos *${n} meses*. 💳`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('[FinBot ERROR] Erro ao criar parcelas:', error.message);
    await ctx.reply('❌ Erro ao criar as parcelas. Tente novamente.');
  }
}

// ─── /limpar ──────────────────────────────────────────────────────────────────

async function handleLimparConfirmar(ctx) {
  try {
    await ctx.answerCbQuery();
    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
    const deleted = deleteAllTransactions(user.id);
    await ctx.editMessageText(
      `🗑️ *Feito. ${deleted} transação(ões) apagada(s).*\n\n_Conta zerada. Vida nova. Mesmos hábitos, provavelmente. 😏_`,
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
    await ctx.editMessageText('👍 *Cancelado.* Suas transações estão salvas e seguras.\n\n_Por hoje você foi responsável. 😌_', { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('[FinBot ERROR] Erro ao cancelar /limpar:', error.message);
  }
}
