import { getUsersWithCardsDueSoon, getCreditFaturaForCard } from '../db/queries.js';
import { formatCurrency } from '../bot/formatter.js';

async function runDueDateCheck(bot) {
  const target = new Date();
  target.setDate(target.getDate() + 3);
  const targetDay = target.getDate();
  const now = new Date();

  try {
    const cards = getUsersWithCardsDueSoon(targetDay);
    for (const card of cards) {
      const total = getCreditFaturaForCard(
        card.user_id, card.card_name, now.getFullYear(), now.getMonth() + 1
      );
      await bot.telegram.sendMessage(
        card.telegram_id,
        `⚠️ Lembrete: O *${card.card_name}* vence em 3 dias (dia ${card.due_day}).\n` +
        `💳 Fatura estimada: ${formatCurrency(total)}\n` +
        `Não diz que não avisei! 😏`,
        { parse_mode: 'Markdown' }
      );
    }
  } catch (error) {
    console.error('[FinBot ERROR] Erro no job de vencimento:', error.message);
  }
}

export function startNotificationJob(bot) {
  const ONE_DAY = 24 * 60 * 60 * 1000;
  setInterval(() => runDueDateCheck(bot), ONE_DAY);
  console.log('[FinBot] Job de notificação de vencimento iniciado.');
}
