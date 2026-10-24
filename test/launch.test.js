import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getLaunchMode } from '../src/bot/launch.js';

const TOKEN = '123:abc';

test('sem URL pública usa polling', () => {
  assert.deepEqual(getLaunchMode({ TELEGRAM_TOKEN: TOKEN }), { mode: 'polling' });
});

test('no Render usa webhook com caminho e segredo derivados do token', () => {
  const m = getLaunchMode({ TELEGRAM_TOKEN: TOKEN, RENDER_EXTERNAL_URL: 'https://finbot.onrender.com/' });
  assert.equal(m.mode, 'webhook');
  assert.equal(m.domain, 'https://finbot.onrender.com');
  assert.match(m.path, /^\/telegram\/[0-9a-f]{32}$/);
  assert.match(m.secretToken, /^[0-9a-f]{32}$/);
  assert.ok(!m.path.includes(TOKEN) && !m.secretToken.includes(TOKEN));
});

test('mesmo token gera o mesmo caminho (estável entre deploys)', () => {
  const env = { TELEGRAM_TOKEN: TOKEN, RENDER_EXTERNAL_URL: 'https://a.onrender.com' };
  assert.deepEqual(getLaunchMode(env), getLaunchMode({ ...env }));
});

test('BOT_MODE=polling força polling e WEBHOOK_DOMAIN tem prioridade', () => {
  assert.equal(getLaunchMode({ TELEGRAM_TOKEN: TOKEN, RENDER_EXTERNAL_URL: 'https://a.onrender.com', BOT_MODE: 'polling' }).mode, 'polling');
  assert.equal(
    getLaunchMode({ TELEGRAM_TOKEN: TOKEN, RENDER_EXTERNAL_URL: 'https://a.onrender.com', WEBHOOK_DOMAIN: 'https://b.example' }).domain,
    'https://b.example'
  );
});
