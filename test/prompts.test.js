import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildParseTransactionPrompt } from '../src/ai/prompts.js';

test('prompt de parse usa o ano e a data informados (sem ano fixo)', () => {
  const p = buildParseTransactionPrompt({ today: '2030-03-10', year: 2030 });
  assert.match(p, /DATA DE HOJE: 2030-03-10/);
  assert.match(p, /"2030-01-16"/);
  assert.doesNotMatch(p, /2026/);
});
