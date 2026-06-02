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
    `ALTER TABLE transactions ADD COLUMN transaction_date DATE`,
    `ALTER TABLE transactions ADD COLUMN card_name TEXT`,
    `ALTER TABLE subscriptions ADD COLUMN is_variable INTEGER DEFAULT 0`,
    `ALTER TABLE subscriptions ADD COLUMN default_category TEXT DEFAULT 'Assinaturas'`,
    `ALTER TABLE subscriptions ADD COLUMN billing_day INTEGER`,
    `ALTER TABLE subscriptions ADD COLUMN last_billed_at DATE`,
    `ALTER TABLE subscriptions ADD COLUMN is_active INTEGER DEFAULT 1`,
    `CREATE TABLE IF NOT EXISTS pending_bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      subscription_id INTEGER NOT NULL,
      category TEXT DEFAULT 'Moradia',
      reminder_sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      due_date DATE NOT NULL,
      resolved_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (subscription_id) REFERENCES subscriptions(id)
    )`,
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
  // Backfill: preencher transaction_date com a data de created_at nas linhas existentes
  try {
    db.exec(`UPDATE transactions SET transaction_date = DATE(created_at) WHERE transaction_date IS NULL`);
  } catch { /* ignorar se falhar */ }

  // Migration: incluir 'Negócio' no CHECK constraint da coluna category
  migrateAddNegocioCategory(db);
}

function migrateAddNegocioCategory(db) {
  // Verifica se 'Negócio' já está no CHECK lendo o DDL da tabela
  const tableInfo = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='transactions'"
  ).get();
  if (!tableInfo || tableInfo.sql.includes("'Negócio'")) return; // já migrou

  const cols = db.prepare("PRAGMA table_info(transactions)").all();
  const colList = cols.map((c) => c.name).join(', ');

  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE transactions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('expense', 'income')),
        amount REAL NOT NULL CHECK(amount > 0),
        category TEXT NOT NULL CHECK(category IN (
          'Alimentação', 'Transporte', 'Moradia', 'Saúde', 'Lazer',
          'Assinaturas', 'Educação', 'Compras', 'Investimentos', 'Receita', 'Negócio', 'Outros'
        )),
        description TEXT,
        raw_message TEXT,
        transaction_date DATE,
        payment_method TEXT DEFAULT 'outro',
        installments INTEGER DEFAULT 1,
        installment_number INTEGER DEFAULT 1,
        installment_group_id TEXT,
        total_amount REAL,
        card_name TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);
    db.exec(`INSERT INTO transactions_new (${colList}) SELECT ${colList} FROM transactions`);
    db.exec('DROP TABLE transactions');
    db.exec('ALTER TABLE transactions_new RENAME TO transactions');
    db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at)');
    db.exec('COMMIT');
    console.log('[FinBot] Migration: categoria Negócio adicionada à tabela transactions.');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function closeDatabase() {
  if (db) {
    db.close();
    db = null;
    console.log('[FinBot] Banco de dados encerrado.');
  }
}
