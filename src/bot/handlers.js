import { Markup } from 'telegraf';
import { getOrCreateUser, deleteAllTransactions } from '../db/queries.js';
import { processMessage, saveTransaction } from '../services/transactions.js';
import { runAlertsAfterExpense } from '../services/alerts.js';
import { generateSarcasticResponse } from '../ai/gemini.js';
import {
  formatCurrency,
  formatTransactionConfirm,
  formatSarcasticSave,
} from './formatter.js';

// Armazenamento temporário de transações pendentes de confirmação (em memória)
const pendingTransactions = new Map();

export function registerHandlers(bot) {
  bot.on('text', handleTextMessage);
  bot.action(/^confirm_(.+)$/, handleConfirmCallback);
  bot.action('cancel_transaction', handleCancelCallback);
  bot.action('limpar_confirmar', handleLimparConfirmar);
  bot.action('limpar_cancelar', handleLimparCancelar);
}

async function handleTextMessage(ctx) {
  const text = ctx.message.text;

  if (text.startsWith('/')) return;

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

    const saveResult = await saveTransaction(user.id, parsed, text);

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
      const alerts = await runAlertsAfterExpense(user.id, parsed.category, saveResult.categoryTotal);
      for (const alert of alerts) {
        await ctx.reply(`${alert.emoji} ${alert.message}`, { parse_mode: 'Markdown' });
      }
    }
  } catch (error) {
    console.error('[FinBot ERROR] Erro ao processar mensagem:', error.message);
    await ctx.reply('❌ Ocorreu um erro ao processar sua mensagem. Tente novamente em instantes.');
  }
}

async function handleConfirmCallback(ctx) {
  try {
    await ctx.answerCbQuery();
    const key = ctx.match[1];
    const pending = pendingTransactions.get(key);

    if (!pending) {
      await ctx.editMessageText('⏰ Essa confirmação expirou. Por favor, envie a mensagem novamente.');
      return;
    }

    pendingTransactions.delete(key);

    const saveResult = await saveTransaction(pending.userId, pending.parsed, pending.rawMessage);

    if (!saveResult.success) {
      await ctx.editMessageText('❌ Erro ao salvar a transação. Tente novamente.');
      return;
    }

    const sarcasticText = await generateSarcasticResponse({
      type: pending.parsed.type,
      amount: pending.parsed.amount,
      category: pending.parsed.category,
      description: pending.parsed.description,
      categoryTotal: saveResult.categoryTotal,
    });

    const responseMsg = sarcasticText
      ? formatSarcasticSave(sarcasticText, pending.parsed, saveResult.categoryTotal)
      : `✅ *Confirmado!*\n\n${formatCurrency(pending.parsed.amount)} em ${pending.parsed.category}`;

    await ctx.editMessageText(responseMsg, { parse_mode: 'Markdown' });

    if (pending.parsed.type === 'expense') {
      const alerts = await runAlertsAfterExpense(
        pending.userId,
        pending.parsed.category,
        saveResult.categoryTotal
      );
      for (const alert of alerts) {
        await ctx.reply(`${alert.emoji} ${alert.message}`, { parse_mode: 'Markdown' });
      }
    }
  } catch (error) {
    console.error('[FinBot ERROR] Erro ao confirmar transação:', error.message);
    await ctx.reply('❌ Erro ao confirmar. Tente enviar a mensagem novamente.');
  }
}

async function handleCancelCallback(ctx) {
  try {
    await ctx.answerCbQuery('Transação cancelada.');
    await ctx.editMessageText('❌ *Transação cancelada.*\n\nSe quiser registrar, me envie a mensagem novamente.', {
      parse_mode: 'Markdown',
    });
  } catch (error) {
    console.error('[FinBot ERROR] Erro ao cancelar transação:', error.message);
  }
}

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
    await ctx.editMessageText('👍 *Cancelado.* Suas transações estão salvas e seguras.\n\n_Por hoje você foi responsável. 😌_', {
      parse_mode: 'Markdown',
    });
  } catch (error) {
    console.error('[FinBot ERROR] Erro ao cancelar /limpar:', error.message);
  }
}
