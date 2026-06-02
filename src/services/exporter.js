import ExcelJS from 'exceljs';

const MONTH_NAMES = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

const PAYMENT_LABELS = {
  credito: 'Crédito', debito: 'Débito', pix: 'Pix', dinheiro: 'Dinheiro', outro: 'Outro',
};

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A3A5C' } };
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' } };
const EVEN_ROW_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } };
const RED_FONT = { color: { argb: 'FFC00000' }, bold: true };
const GREEN_FONT = { color: { argb: 'FF00803F' }, bold: true };

function parseDateOnly(str) {
  const clean = String(str).split('T')[0].split(' ')[0];
  const [y, m, d] = clean.split('-').map(Number);
  return { y, m, d, formatted: `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}` };
}

function installmentLabel(tx) {
  if (tx.installments && tx.installments > 1) return `${tx.installment_number}/${tx.installments}`;
  return 'À vista';
}

export function buildExportLabel(parsed) {
  const parts = ['FinBot'];
  if (parsed.scope === 'business') parts.push('Negocio');
  else if (parsed.scope === 'personal') parts.push('Pessoal');
  if (parsed.period === 'month') parts.push(MONTH_NAMES[parsed.month - 1], String(parsed.year));
  else if (parsed.period === 'year') parts.push(String(parsed.year));
  else parts.push('Tudo');
  return parts.join('_');
}

export function buildExportTitle(parsed) {
  const scopeLabel = parsed.scope === 'business' ? ' (Negócio)' : parsed.scope === 'personal' ? ' (Pessoal)' : '';
  if (parsed.period === 'month') return `${MONTH_NAMES[parsed.month - 1]}/${parsed.year}${scopeLabel}`;
  if (parsed.period === 'year') return `${parsed.year}${scopeLabel}`;
  return `Histórico Completo${scopeLabel}`;
}

export async function generateExportXlsx(transactions, parsed, filePath) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'FinBot';
  wb.created = new Date();

  // ─── Aba 1: Transações ─────────────────────────────────────────────────────
  const txSheet = wb.addWorksheet('Transações');
  txSheet.columns = [
    { header: 'Data', key: 'date', width: 12 },
    { header: 'Descrição', key: 'description', width: 36 },
    { header: 'Categoria', key: 'category', width: 16 },
    { header: 'Tipo', key: 'type', width: 10 },
    { header: 'Valor', key: 'amount', width: 14 },
    { header: 'Método de Pagamento', key: 'payment_method', width: 20 },
    { header: 'Cartão', key: 'card', width: 16 },
    { header: 'Parcela', key: 'installment', width: 12 },
  ];

  // Estilizar cabeçalho
  const headerRow = txSheet.getRow(1);
  headerRow.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  txSheet.views = [{ state: 'frozen', ySplit: 1 }];
  txSheet.autoFilter = { from: 'A1', to: 'H1' };

  // Linhas de dados
  for (const tx of transactions) {
    const { formatted } = parseDateOnly(tx.transaction_date || tx.created_at);
    const row = txSheet.addRow({
      date: formatted,
      description: tx.description || '',
      category: tx.category,
      type: tx.type === 'expense' ? 'Gasto' : 'Receita',
      amount: tx.amount,
      payment_method: PAYMENT_LABELS[tx.payment_method] || tx.payment_method || '',
      card: tx.card_name || '',
      installment: installmentLabel(tx),
    });

    if (row.number % 2 === 0) {
      row.eachCell((cell) => { cell.fill = EVEN_ROW_FILL; });
    }
    const amountCell = row.getCell('amount');
    amountCell.numFmt = '"R$" #,##0.00';
    amountCell.font = tx.type === 'expense' ? RED_FONT : GREEN_FONT;
  }

  // Totais
  const totalIncome = transactions.filter((t) => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const totalExpenses = transactions.filter((t) => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
  const balance = totalIncome - totalExpenses;

  txSheet.addRow([]);
  const totals = [
    ['', '', '', 'Total Receitas', totalIncome],
    ['', '', '', 'Total Gastos', totalExpenses],
    ['', '', '', 'Saldo', balance],
  ];
  for (const [, , , label, value] of totals) {
    const r = txSheet.addRow({ type: label, amount: value });
    r.font = { bold: true };
    r.getCell('amount').numFmt = '"R$" #,##0.00';
    if (label === 'Total Receitas') r.getCell('amount').font = GREEN_FONT;
    else if (label === 'Total Gastos') r.getCell('amount').font = RED_FONT;
    else r.getCell('amount').font = balance >= 0 ? GREEN_FONT : RED_FONT;
  }

  // ─── Aba 2: Resumo ─────────────────────────────────────────────────────────
  const resumoSheet = wb.addWorksheet('Resumo');
  resumoSheet.columns = [
    { header: 'Item', key: 'item', width: 36 },
    { header: 'Valor', key: 'value', width: 16 },
    { header: 'Detalhe', key: 'detail', width: 24 },
  ];
  const resumoHeader = resumoSheet.getRow(1);
  resumoHeader.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });

  const addSectionTitle = (title) => {
    resumoSheet.addRow([]);
    const r = resumoSheet.addRow({ item: title });
    r.font = { bold: true, size: 12, color: { argb: 'FF1A3A5C' } };
  };
  const addDataRow = (item, value, detail = '') => {
    const r = resumoSheet.addRow({ item, value, detail });
    if (typeof value === 'number') {
      r.getCell('value').numFmt = '"R$" #,##0.00';
    }
    return r;
  };

  // Por categoria
  addSectionTitle('💸 Total por categoria');
  const byCategory = {};
  for (const tx of transactions) {
    if (tx.type === 'expense') {
      byCategory[tx.category] = (byCategory[tx.category] || 0) + tx.amount;
    }
  }
  const sortedCats = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
  for (const [cat, total] of sortedCats) {
    const pct = totalExpenses > 0 ? (total / totalExpenses * 100).toFixed(1) : '0';
    addDataRow(cat, total, `${pct}%`);
  }

  // Por método de pagamento
  addSectionTitle('💳 Por método de pagamento');
  const byPayment = {};
  for (const tx of transactions) {
    if (tx.type === 'expense') {
      const m = tx.payment_method || 'outro';
      byPayment[m] = (byPayment[m] || 0) + tx.amount;
    }
  }
  for (const [m, total] of Object.entries(byPayment).sort((a, b) => b[1] - a[1])) {
    addDataRow(PAYMENT_LABELS[m] || m, total);
  }

  // Por cartão
  const byCard = {};
  for (const tx of transactions) {
    if (tx.type === 'expense' && tx.card_name) {
      byCard[tx.card_name] = (byCard[tx.card_name] || 0) + tx.amount;
    }
  }
  if (Object.keys(byCard).length > 0) {
    addSectionTitle('🏦 Por cartão');
    for (const [card, total] of Object.entries(byCard).sort((a, b) => b[1] - a[1])) {
      addDataRow(card, total);
    }
  }

  // Maior gasto
  addSectionTitle('📊 Destaques');
  const expenses = transactions.filter((t) => t.type === 'expense');
  if (expenses.length > 0) {
    const maxExp = expenses.reduce((max, t) => (t.amount > max.amount ? t : max), expenses[0]);
    addDataRow('Maior gasto do período', maxExp.amount, `${maxExp.category} · ${maxExp.description || '-'}`);

    // Média diária
    const expenseDates = new Set(
      expenses.map((t) => parseDateOnly(t.transaction_date || t.created_at).formatted)
    );
    const avgDaily = totalExpenses / expenseDates.size;
    addDataRow('Média diária de gastos', avgDaily, `${expenseDates.size} dia(s) com gastos`);
  }

  // Salvar arquivo
  await wb.xlsx.writeFile(filePath);
  return filePath;
}
