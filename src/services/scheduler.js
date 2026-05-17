import {
  getActiveSubscriptionsForBilling,
  insertSubscriptionTransaction,
  updateSubscriptionBilledAt,
  insertPendingBill,
} from '../db/queries.js';
import { formatCurrency } from '../bot/formatter.js';
import { pendingBillAmount } from '../state.js';

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
      const effectiveDay = sub.billing_day > lastDay ? lastDay : sub.billing_day;
      if (effectiveDay !== todayDay) continue;
      if (sub.last_billed_at && sub.last_billed_at.startsWith(todayStr)) continue;

      updateSubscriptionBilledAt(sub.id, todayStr);

      if (sub.is_variable) {
        // Conta variável: enviar lembrete e aguardar valor
        const pendingBillId = insertPendingBill(sub.user_id, sub.id, todayStr, sub.default_category);

        pendingBillAmount.set(sub.telegram_id, {
          pendingBillId,
          subId: sub.id,
          subName: sub.name,
          category: sub.default_category || 'Moradia',
          dbUserId: sub.user_id,
        });

        console.log(`[FinBot] Lembrete enviado para conta variável ${sub.name} — usuário ${sub.telegram_id}`);

        await bot.telegram.sendMessage(
          sub.telegram_id,
          `📋 Lembrete: A conta de *${sub.name}* vence hoje!\n` +
          `Quanto veio esse mês? Me manda o valor que eu anoto 😏`,
          { parse_mode: 'Markdown' }
        );
      } else {
        // Valor fixo: registrar automaticamente
        insertSubscriptionTransaction(sub.user_id, sub.name, sub.my_amount, sub.default_category || 'Assinaturas');

        console.log(`[FinBot] Assinatura ${sub.name} registrada automaticamente para usuário ${sub.telegram_id}`);

        await bot.telegram.sendMessage(
          sub.telegram_id,
          `📺 *${sub.name}* registrado automaticamente!\n` +
          `💸 ${formatCurrency(sub.my_amount)} — Como se você fosse cancelar algum dia 😏\n\n` +
          `💡 Use /assinaturas para ver todas as suas cobranças`,
          { parse_mode: 'Markdown' }
        );
      }
    } catch (error) {
      console.error(`[FinBot ERROR] Scheduler: falha ao processar ${sub.name}:`, error.message);
    }
  }
}

export function startSubscriptionScheduler(bot) {
  const ONE_DAY = 24 * 60 * 60 * 1000;
  runSubscriptionBilling(bot);
  setInterval(() => runSubscriptionBilling(bot), ONE_DAY);
  console.log('[FinBot] Scheduler de assinaturas iniciado.');
}
