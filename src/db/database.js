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
