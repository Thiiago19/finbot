import 'dotenv/config';
import { createServer } from 'http';
import { Telegraf } from 'telegraf';
import { initDatabase, closeDatabase } from './db/database.js';
import { registerCommands } from './bot/commands.js';
import { registerHandlers } from './bot/handlers.js';
import { startNotificationJob } from './services/notifications.js';
import { startSubscriptionScheduler } from './services/scheduler.js';

// Servidor HTTP iniciado imediatamente — antes de qualquer outra coisa
const port = process.env.PORT || 3000;
createServer((_, res) => res.end('OK')).listen(port, () => {
  console.log(`[FinBot] Servidor HTTP ouvindo na porta ${port}`);
});

function validateEnv() {
  if (!process.env.TELEGRAM_TOKEN) {
    throw new Error('Variável de ambiente ausente: TELEGRAM_TOKEN');
  }
  if (!process.env.GEMINI_API_KEY) {
    console.log('[FinBot] GEMINI_API_KEY não configurada — funcionalidades de IA desabilitadas.');
  }
}

async function main() {
  console.log('[FinBot] Iniciando...');

  validateEnv();
  initDatabase();

  const bot = new Telegraf(process.env.TELEGRAM_TOKEN);

  registerCommands(bot);
  registerHandlers(bot);

  bot.catch((error, ctx) => {
    console.error(`[FinBot ERROR] Erro não tratado para ${ctx.updateType}:`, error.message);
  });

  process.once('SIGINT', () => shutdown(bot));
  process.once('SIGTERM', () => shutdown(bot));

  await bot.launch();
  console.log('[FinBot] Bot iniciado com sucesso! Aguardando mensagens...');
  startNotificationJob(bot);
  startSubscriptionScheduler(bot);
}

function shutdown(bot) {
  console.log('[FinBot] Encerrando bot...');
  bot.stop('SIGINT');
  closeDatabase();
  process.exit(0);
}

main().catch((error) => {
  console.error('[FinBot ERROR] Falha fatal ao iniciar:', error.message);
  process.exit(1);
});
