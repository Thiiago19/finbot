import {
  getActiveSubscriptionsForBilling,
  insertSubscriptionTransaction,
  updateSubscriptionBilledAt,
} from '../db/queries.js';
import { formatCurrency } from '../bot/formatter.js';

function getLastDayOfMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

async function runSubscriptionBilling(bot) {
  const today = new Date();
  const todayDay = today.getDate();
  const lastDay = getLastDayOfMonth(today.getFullYear(), today.getMonth());
  const todayStr = today.toISOString().split('T')[0];

  let subs;
  try {
    subs = getActiveSubscriptionsForBilling();
  } catch (error) {
    console.error('[FinBot ERROR] Scheduler: falha ao buscar assinaturas:', error.message);
    return;
  }

  for (const sub of subs) {
    try {
      // Ajusta billing_day para meses com menos dias (ex: 31 em fevereiro → 28)
      const effectiveDay = sub.billing_day > lastDay ? lastDay : sub.billing_day;
      if (effectiveDay !== todayDay) continue;

      // Verifica se já foi cobrada hoje
      if (sub.last_billed_at && sub.last_billed_at.startsWith(todayStr)) continue;

      insertSubscriptionTransaction(sub.user_id, sub.name, sub.my_amount);
      updateSubscriptionBilledAt(sub.id, todayStr);

      console.log(`[FinBot] Assinatura ${sub.name} registrada automaticamente para usuário ${sub.telegram_id}`);

      await bot.telegram.sendMessage(
        sub.telegram_id,
        `📺 *${sub.name}* registrado automaticamente!\n` +
        `💸 ${formatCurrency(sub.my_amount)} — Como se você fosse cancelar algum dia 😏\n\n` +
        `💡 Use /assinaturas para ver todas as suas cobranças`,
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      console.error(`[FinBot ERROR] Scheduler: falha ao processar assinatura ${sub.name}:`, error.message);
    }
  }
}

export function startSubscriptionScheduler(bot) {
  const ONE_DAY = 24 * 60 * 60 * 1000;
  runSubscriptionBilling(bot); // roda imediatamente ao iniciar
  setInterval(() => runSubscriptionBilling(bot), ONE_DAY);
  console.log('[FinBot] Scheduler de assinaturas iniciado.');
}
