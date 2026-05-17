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

export function deleteAllTransactions(userId) {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM transactions WHERE user_id = ?').run(userId);
  return result.changes;
}

// ─── Método de pagamento e parcelas ─────────────────────────────────────────

export function getTransactionById(transactionId) {
  const db = getDatabase();
  return db.prepare('SELECT * FROM transactions WHERE id = ?').get(transactionId);
}

export function updateTransactionPayment(transactionId, paymentMethod, installments, installmentNumber, installmentGroupId, totalAmount) {
  const db = getDatabase();
  db.prepare(
    `UPDATE transactions
     SET payment_method = ?, installments = ?, installment_number = ?,
         installment_group_id = ?, total_amount = ?
     WHERE id = ?`
  ).run(paymentMethod, installments, installmentNumber, installmentGroupId, totalAmount, transactionId);
}

export function createInstallmentTransactions(transactionId, totalInstallments, userId) {
  const db = getDatabase();
  const original = db.prepare('SELECT * FROM transactions WHERE id = ?').get(transactionId);
  if (!original) throw new Error('Transação não encontrada');

  const totalAmount = original.amount;
  const installmentAmount = Math.round((totalAmount / totalInstallments) * 100) / 100;
  const groupId = `${userId}_${Date.now()}`;
  const baseDate = new Date(original.created_at);

  db.prepare(
    `UPDATE transactions
     SET amount = ?, installments = ?, installment_number = 1,
         installment_group_id = ?, total_amount = ?, payment_method = 'credito'
     WHERE id = ?`
  ).run(installmentAmount, totalInstallments, groupId, totalAmount, transactionId);

  for (let i = 2; i <= totalInstallments; i++) {
    const d = new Date(baseDate.getFullYear(), baseDate.getMonth() + (i - 1), baseDate.getDate());
    const dateStr = d.toISOString().replace('T', ' ').substring(0, 19);
    db.prepare(
      `INSERT INTO transactions
         (user_id, type, amount, category, description, raw_message,
          payment_method, installments, installment_number, installment_group_id, total_amount, created_at)
       VALUES (?, ?, ?, ?, ?, '[parcelado]', 'credito', ?, ?, ?, ?, ?)`
    ).run(
      original.user_id, original.type, installmentAmount,
      original.category, original.description,
      totalInstallments, i, groupId, totalAmount, dateStr
    );
  }

  return { installmentAmount, groupId };
}

export function getCreditFatura(userId, year, month) {
  const db = getDatabase();
  const y = String(year);
  const m = String(month).padStart(2, '0');

  const avista = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) as total FROM transactions
     WHERE user_id = ? AND type = 'expense' AND payment_method = 'credito'
       AND (installments IS NULL OR installments = 1)
       AND strftime('%Y', created_at) = ? AND strftime('%m', created_at) = ?`
  ).get(userId, y, m);

  const parcelas = db.prepare(
    `SELECT * FROM transactions
     WHERE user_id = ? AND type = 'expense' AND payment_method = 'credito'
       AND installments > 1
       AND strftime('%Y', created_at) = ? AND strftime('%m', created_at) = ?
     ORDER BY installment_group_id, installment_number`
  ).all(userId, y, m);

  const totalParcelas = parcelas.reduce((s, t) => s + t.amount, 0);
  return { avista: avista.total, parcelas, totalParcelas, total: avista.total + totalParcelas };
}

export function getFutureInstallments(userId, months = 6) {
  const db = getDatabase();
  const now = new Date();
  const result = [];

  for (let i = 0; i < months; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const y = String(d.getFullYear());
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const rows = db.prepare(
      `SELECT * FROM transactions
       WHERE user_id = ? AND type = 'expense' AND payment_method = 'credito'
         AND installments > 1
         AND strftime('%Y', created_at) = ? AND strftime('%m', created_at) = ?
       ORDER BY installment_group_id, installment_number`
    ).all(userId, y, m);

    if (rows.length > 0) {
      result.push({
        year: d.getFullYear(),
        month: d.getMonth() + 1,
        transactions: rows,
        total: rows.reduce((s, t) => s + t.amount, 0),
      });
    }
  }
  return result;
}

export function getPaymentMethodBreakdown(userId, year, month) {
  const db = getDatabase();
  return db.prepare(
    `SELECT payment_method, SUM(amount) as total, COUNT(*) as count
     FROM transactions
     WHERE user_id = ? AND type = 'expense'
       AND strftime('%Y', created_at) = ? AND strftime('%m', created_at) = ?
     GROUP BY payment_method
     ORDER BY total DESC`
  ).all(userId, String(year), String(month).padStart(2, '0'));
}

// ─── Assinaturas ────────────────────────────────────────────────────────────

export function getSubscription(userId, name) {
  const db = getDatabase();
  return db.prepare(
    `SELECT * FROM subscriptions WHERE user_id = ? AND LOWER(name) = LOWER(?)`
  ).get(userId, name);
}

export function saveSubscription(userId, name, totalAmount, splitWith, myAmount, isSplit) {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO subscriptions (user_id, name, total_amount, split_with, my_amount, is_split)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, name) DO UPDATE SET
       total_amount = excluded.total_amount,
       split_with = excluded.split_with,
       my_amount = excluded.my_amount,
       is_split = excluded.is_split`
  ).run(userId, name, totalAmount, splitWith, myAmount, isSplit ? 1 : 0);
}

export function getAllSubscriptions(userId) {
  const db = getDatabase();
  return db.prepare(
    `SELECT * FROM subscriptions WHERE user_id = ? ORDER BY name`
  ).all(userId);
}

export function updateTransactionAmount(transactionId, newAmount) {
  const db = getDatabase();
  db.prepare('UPDATE transactions SET amount = ? WHERE id = ?').run(newAmount, transactionId);
}

// ─── Cartões ──────────────────────────────────────────────────────────────────

export function getAllCards(userId) {
  const db = getDatabase();
  return db.prepare('SELECT * FROM cards WHERE user_id = ? ORDER BY name').all(userId);
}

export function saveCard(userId, name, dueDay) {
  const db = getDatabase();
  const result = db.prepare(
    `INSERT INTO cards (user_id, name, due_day) VALUES (?, ?, ?)`
  ).run(userId, name, dueDay);
  return result.lastInsertRowid;
}

export function updateTransactionCard(transactionId, cardName) {
  const db = getDatabase();
  db.prepare('UPDATE transactions SET card_name = ? WHERE id = ?').run(cardName, transactionId);
}

export function getFaturaByCard(userId, year, month) {
  const db = getDatabase();
  const y = String(year);
  const m = String(month).padStart(2, '0');
  return db.prepare(
    `SELECT COALESCE(card_name, 'Sem cartão') as card_name, SUM(amount) as total
     FROM transactions
     WHERE user_id = ? AND type = 'expense' AND payment_method = 'credito'
       AND strftime('%Y', created_at) = ? AND strftime('%m', created_at) = ?
     GROUP BY COALESCE(card_name, 'Sem cartão')
     ORDER BY total DESC`
  ).all(userId, y, m);
}

export function getUsersWithCardsDueSoon(targetDay) {
  const db = getDatabase();
  return db.prepare(
    `SELECT c.id, c.name as card_name, c.due_day, c.user_id, u.telegram_id
     FROM cards c JOIN users u ON c.user_id = u.id
     WHERE c.due_day = ?`
  ).all(targetDay);
}

export function getCreditFaturaForCard(userId, cardName, year, month) {
  const db = getDatabase();
  const y = String(year);
  const m = String(month).padStart(2, '0');
  const result = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) as total FROM transactions
     WHERE user_id = ? AND type = 'expense' AND payment_method = 'credito'
       AND (card_name = ? OR (card_name IS NULL AND ? = 'Sem cartão'))
       AND strftime('%Y', created_at) = ? AND strftime('%m', created_at) = ?`
  ).get(userId, cardName, cardName, y, m);
  return result?.total || 0;
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
