import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import Libsql from 'libsql';
import { resolveDbConfig, setupSchema } from '../src/db/database.js';

test('sem TURSO_DATABASE_URL usa SQLite local com DATABASE_PATH', () => {
  assert.deepEqual(resolveDbConfig({ DATABASE_PATH: '/data/x.db' }), { driver: 'local', path: '/data/x.db' });
  assert.deepEqual(resolveDbConfig({}), { driver: 'local', path: './finbot.db' });
});

test('com TURSO_DATABASE_URL usa réplica do Turso em arquivo separado', () => {
  const cfg = resolveDbConfig({
    TURSO_DATABASE_URL: 'libsql://finbot-x.turso.io',
    TURSO_AUTH_TOKEN: 'tok',
    DATABASE_PATH: './finbot.db',
  });
  assert.equal(cfg.driver, 'turso');
  assert.equal(cfg.syncUrl, 'libsql://finbot-x.turso.io');
  assert.equal(cfg.authToken, 'tok');
  assert.equal(cfg.path, './finbot-replica.db'); // não reaproveita o finbot.db local
});

for (const [nome, abrir] of [
  ['node:sqlite', () => new DatabaseSync(':memory:')],
  ['libsql', () => new Libsql(':memory:')],
]) {
  test(`schema e migrações rodam com ${nome} (e rodar de novo não quebra)`, () => {
    const conn = abrir();
    setupSchema(conn);
    setupSchema(conn);

    const ddl = conn.prepare("SELECT sql FROM sqlite_master WHERE name = 'transactions'").get().sql;
    assert.ok(ddl.includes("'Negócio'"));

    conn.prepare("INSERT INTO users (telegram_id, first_name) VALUES (?, ?)").run(123, 'Thiago');
    const user = conn.prepare('SELECT id FROM users WHERE telegram_id = ?').get(123);
    const r = conn
      .prepare("INSERT INTO transactions (user_id, type, amount, category, transaction_date) VALUES (?, 'expense', ?, 'Negócio', ?)")
      .run(user.id, 10.5, '2026-10-24');
    assert.equal(r.changes, 1);
    assert.equal(Number(r.lastInsertRowid), 1);
    conn.close();
  });
}
