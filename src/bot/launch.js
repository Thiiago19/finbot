import { createHash } from 'crypto';

// No Render o bot usa webhook: o Telegram chama a URL pública do serviço.
// Assim não há dois processos disputando o polling durante o deploy (erro 409),
// e uma mensagem nova é tráfego de entrada, o que também acorda o serviço.
// Localmente (sem URL pública) continua o polling.

/** Decide entre webhook e polling a partir das variáveis de ambiente. */
export function getLaunchMode(env = process.env) {
  const domain = env.WEBHOOK_DOMAIN || env.RENDER_EXTERNAL_URL;
  if (env.BOT_MODE === 'polling' || !domain || !env.TELEGRAM_TOKEN) {
    return { mode: 'polling' };
  }
  // Segredo derivado do token: estável entre deploys e nunca exposto em log.
  const secret = createHash('sha256').update(`finbot-webhook:${env.TELEGRAM_TOKEN}`).digest('hex');
  return {
    mode: 'webhook',
    domain: domain.replace(/\/+$/, ''),
    path: `/telegram/${secret.slice(0, 32)}`,
    secretToken: secret.slice(32),
  };
}

/**
 * Inicia o bot. No modo webhook devolve o handler HTTP que o servidor
 * do index.js deve chamar para POSTs no caminho do webhook.
 */
export async function startBot(bot, launch = getLaunchMode()) {
  if (launch.mode === 'webhook') {
    const handler = await bot.createWebhook({
      domain: launch.domain,
      path: launch.path,
      secret_token: launch.secretToken,
    });
    console.log('[FinBot] Bot iniciado via webhook. Aguardando mensagens...');
    return handler;
  }

  // Polling: a promessa só resolve quando o bot para, por isso não é aguardada aqui.
  bot
    .launch(() => console.log('[FinBot] Bot iniciado via polling. Aguardando mensagens...'))
    .catch((error) => {
      console.error('[FinBot ERROR] Polling parou:', error.message);
      process.exit(1);
    });
  return null;
}
