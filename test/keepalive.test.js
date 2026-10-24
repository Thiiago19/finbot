import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getKeepAliveUrl } from '../src/services/keepalive.js';

test('usa RENDER_EXTERNAL_URL e aponta para /health', () => {
  assert.equal(getKeepAliveUrl({ RENDER_EXTERNAL_URL: 'https://finbot.onrender.com/' }), 'https://finbot.onrender.com/health');
});

test('KEEPALIVE_URL tem prioridade', () => {
  assert.equal(
    getKeepAliveUrl({ RENDER_EXTERNAL_URL: 'https://a.onrender.com', KEEPALIVE_URL: 'https://b.example' }),
    'https://b.example/health'
  );
});

test('desligado fora do Render ou com KEEPALIVE=off', () => {
  assert.equal(getKeepAliveUrl({}), null);
  assert.equal(getKeepAliveUrl({ RENDER_EXTERNAL_URL: 'https://a.onrender.com', KEEPALIVE: 'off' }), null);
});
