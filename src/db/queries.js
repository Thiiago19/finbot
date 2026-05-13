import { getDatabase } from './database.js';

// ─── Usuários ───────────────────────────────────────────────────────────────

export function findUserByTelegramId(telegramId) {
  const db = getDatabase();
  return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
}

export function createUser(telegramId, firstName, username) {
  const db = getDatabase();
  const result = db
    .prepare('INSERT OR IGNORE INTO users (telegram_id, first_name, username) VALUES (?, ?, ?)')
    .run(telegramId, firstName, username || null);
  return result.lastInsertRowid;
}

export function getOrCreateUser(telegramId, firstName, username) {
  let user = findUserByTelegramId(telegramId);
  if (!user) {
    createUser(telegramId, firstName, username);
    user = findUserByTelegramId(telegramId);
  }
  return user;
}

// ─── Transações ─────────────────────────────────────────────────────────────

export function insertTransaction(userId, type, amount, category, description, rawMessage) {
  const db = getDatabase();
  const result = db
    .prepare(
      `INSERT INTO transactions (user_id, type, amount, category, description, raw_message)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(userId, type, amount, category, description || null, rawMessage || null);
  return result.lastInsertRowid;
}

export function getTransactionsByMonth(userId, year, month) {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT * FROM transactions
       WHERE user_id = ?
         AND strftime('%Y', created_at) = ?
         AND strftime('%m', created_at) = ?
       ORDER BY created_at DESC`
    )
    .all(userId, String(year), String(month).padStart(2, '0'));
}

export function getLastTransactions(userId, limit = 10) {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT * FROM transactions
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(userId, limit);
}

export function getMonthlySummary(userId, year, month) {
  const db = getDatabase();
  const monthStr = String(month).padStart(2, '0');

  const totals = db
    .prepare(
      `SELECT
         SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END) as total_income,
         SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) as total_expenses
       FROM transactions
       WHERE user_id = ?
         AND strftime('%Y', created_at) = ?
         AND strftime('%m', created_at) = ?`
    )
    .get(userId, String(year), monthStr);

  const byCategory = db
    .prepare(
      `SELECT category, SUM(amount) as total
       FROM transactions
       WHERE user_id = ?
         AND type = 'expense'
         AND strftime('%Y', created_at) = ?
         AND strftime('%m', created_at) = ?
       GROUP BY category
       ORDER BY total DESC`
    )
    .all(userId, String(year), monthStr);

  return {
    total_income: totals?.total_income || 0,
    total_expenses: totals?.total_expenses || 0,
    by_category: byCategory,
  };
}

export function getCategoryMonthTotal(userId, category, year, month) {
  const db = getDatabase();
  const monthStr = String(month).padStart(2, '0');
  const result = db
    .prepare(
      `SELECT SUM(amount) as total FROM transactions
       WHERE user_id = ?
         AND category = ?
         AND type = 'expense'
         AND strftime('%Y', created_at) = ?
         AND strftime('%m', created_at) = ?`
    )
    .get(userId, category, String(year), monthStr);
  return result?.total || 0;
}

export function getPreviousMonthSummary(userId) {
  const db = getDatabase();
  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth(); // 0-indexed, então mês anterior
  if (month === 0) {
    month = 12;
    year -= 1;
  }
  return getMonthlySummary(userId, year, month);
}

// ─── Orçamentos ─────────────────────────────────────────────────────────────

export function getBudget(userId, category) {
  const db = getDatabase();
  return db
    .prepare('SELECT * FROM budgets WHERE user_id = ? AND category = ?')
    .get(userId, category);
}

export function getAllBudgets(userId) {
  const db = getDatabase();
  return db.prepare('SELECT * FROM budgets WHERE user_id = ?').all(userId);
}

export function upsertBudget(userId, category, monthlyLimit) {
  const db = getDatabase();
  db
    .prepare(
      `INSERT INTO budgets (user_id, category, monthly_limit)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id, category) DO UPDATE SET monthly_limit = excluded.monthly_limit`
    )
    .run(userId, category, monthlyLimit);
}

// ─── Metas ──────────────────────────────────────────────────────────────────

export function getActiveGoals(userId) {
  const db = getDatabase();
  return db
    .prepare('SELECT * FROM goals WHERE user_id = ? AND completed_at IS NULL ORDER BY created_at')
    .all(userId);
}

export function createGoal(userId, name, targetAmount, deadline) {
  const db = getDatabase();
  const result = db
    .prepare(
      `INSERT INTO goals (user_id, name, target_amount, deadline)
       VALUES (?, ?, ?, ?)`
    )
    .run(userId, name, targetAmount, deadline || null);
  return result.lastInsertRowid;
}

export function updateGoalProgress(goalId, amount) {
  const db = getDatabase();
  db
    .prepare('UPDATE goals SET current_amount = current_amount + ? WHERE id = ?')
    .run(amount, goalId);

  const goal = db.prepare('SELECT * FROM goals WHERE id = ?').get(goalId);
  if (goal && goal.current_amount >= goal.target_amount) {
    db
      .prepare('UPDATE goals SET completed_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(goalId);
  }
}

export function getRecentTransactionsForInsights(userId, limit = 50) {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT type, amount, category, description, created_at
       FROM transactions
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(userId, limit);
}
