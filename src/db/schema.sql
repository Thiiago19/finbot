CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER UNIQUE NOT NULL,
  first_name TEXT NOT NULL,
  username TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('expense', 'income')),
  amount REAL NOT NULL CHECK(amount > 0),
  category TEXT NOT NULL CHECK(category IN (
    'Alimentação', 'Transporte', 'Moradia', 'Saúde', 'Lazer',
    'Assinaturas', 'Educação', 'Compras', 'Investimentos', 'Receita', 'Outros'
  )),
  description TEXT,
  raw_message TEXT,
  payment_method TEXT DEFAULT 'outro',
  installments INTEGER DEFAULT 1,
  installment_number INTEGER DEFAULT 1,
  installment_group_id TEXT,
  total_amount REAL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS budgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  category TEXT NOT NULL CHECK(category IN (
    'Alimentação', 'Transporte', 'Moradia', 'Saúde', 'Lazer',
    'Assinaturas', 'Educação', 'Compras', 'Investimentos', 'Receita', 'Outros'
  )),
  monthly_limit REAL NOT NULL CHECK(monthly_limit > 0),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  UNIQUE(user_id, category)
);

CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  target_amount REAL NOT NULL CHECK(target_amount > 0),
  current_amount REAL NOT NULL DEFAULT 0 CHECK(current_amount >= 0),
  deadline DATE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  total_amount REAL NOT NULL,
  split_with INTEGER DEFAULT 1,
  my_amount REAL NOT NULL,
  is_split INTEGER DEFAULT 0,
  is_variable INTEGER DEFAULT 0,
  default_category TEXT DEFAULT 'Assinaturas',
  billing_day INTEGER,
  last_billed_at DATE,
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  UNIQUE(user_id, name)
);

CREATE TABLE IF NOT EXISTS pending_bills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  subscription_id INTEGER NOT NULL,
  category TEXT DEFAULT 'Moradia',
  reminder_sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  due_date DATE NOT NULL,
  resolved_at DATETIME,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (subscription_id) REFERENCES subscriptions(id)
);

CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  due_day INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_budgets_user_id ON budgets(user_id);
CREATE INDEX IF NOT EXISTS idx_goals_user_id ON goals(user_id);
