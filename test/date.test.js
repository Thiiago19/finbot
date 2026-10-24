import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'UTC'; // simula o servidor do Render
const { toLocalDateStr, currentYear } = await import('../src/utils/date.js');

test('fixa o fuso do processo em America/Sao_Paulo', () => {
  assert.equal(process.env.TZ, 'America/Sao_Paulo');
});

test('22h30 em Brasília continua sendo o mesmo dia (UTC já virou)', () => {
  const instante = new Date('2026-10-25T01:30:00Z'); // 24/10 22:30 BRT
  assert.equal(toLocalDateStr(instante), '2026-10-24');
});

test('virada do ano: 31/12 23h em Brasília ainda é o ano anterior', () => {
  const instante = new Date('2027-01-01T02:00:00Z');
  assert.equal(toLocalDateStr(instante), '2026-12-31');
});

test('currentYear devolve número de 4 dígitos', () => {
  assert.match(String(currentYear()), /^\d{4}$/);
});
