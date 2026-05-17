import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let db;

export function getDatabase() {
  if (!db) {
    throw new Error('Banco de dados não inicializado. Chame initDatabase() primeiro.');
  }
  return db;
}

export function initDatabase() {
  const dbPath = process.env.DATABASE_PATH || './finbot.db';

  try {
    db = new DatabaseSync(dbPath);

    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');

    const schemaPath = join(__dirname, 'schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');

    db.exec(schema);
    runMigrations(db);

    console.log('[FinBot] Banco de dados inicializado com sucesso.');
    return db;
  } catch (error) {
    console.error('[FinBot ERROR] Falha ao inicializar banco de dados:', error.message);
    throw error;
  }
}

function runMigrations(db) {
  const newColumns = [
    `ALTER TABLE transactions ADD COLUMN payment_method TEXT DEFAULT 'outro'`,
    `ALTER TABLE transactions ADD COLUMN installments INTEGER DEFAULT 1`,
    `ALTER TABLE transactions ADD COLUMN installment_number INTEGER DEFAULT 1`,
    `ALTER TABLE transactions ADD COLUMN installment_group_id TEXT`,
    `ALTER TABLE transactions ADD COLUMN total_amount REAL`,
    `ALTER TABLE transactions ADD COLUMN card_name TEXT`,
    `CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      total_amount REAL NOT NULL,
      split_with INTEGER DEFAULT 1,
      my_amount REAL NOT NULL,
      is_split INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(user_id, name)
    )`,
    `CREATE TABLE IF NOT EXISTS cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      due_day INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )`,
  ];
  for (const sql of newColumns) {
    try { db.exec(sql); } catch { /* coluna já existe */ }
  }
}

export function closeDatabase() {
  if (db) {
    db.close();
    db = null;
    console.log('[FinBot] Banco de dados encerrado.');
  }
}
