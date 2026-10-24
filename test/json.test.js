import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJSON, extractJSONArray } from '../src/ai/json.js';

test('extrai JSON puro, com cerca de código e com texto em volta', () => {
  assert.deepEqual(extractJSON('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJSON('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJSON('Claro! {"a":1} pronto'), { a: 1 });
});

test('extrai array', () => {
  assert.deepEqual(extractJSONArray('```\n[{"a":1}]\n```'), [{ a: 1 }]);
  assert.deepEqual(extractJSONArray('[]'), []);
});

test('JSON inválido lança SyntaxError', () => {
  assert.throws(() => extractJSON('sem json aqui'), SyntaxError);
});
