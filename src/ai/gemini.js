import { GoogleGenerativeAI } from '@google/generative-ai';
import { PARSE_TRANSACTION_PROMPT, INSIGHTS_PROMPT, SARCASTIC_RESPONSE_PROMPT } from './prompts.js';

function getModel() {
  if (!process.env.GEMINI_API_KEY) return null;
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
}

function extractJSON(text) {
  const block = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (block) return JSON.parse(block[1].trim());
  const obj = text.match(/\{[\s\S]*\}/);
  if (obj) return JSON.parse(obj[0]);
  return JSON.parse(text.trim());
}

export async function parseTransaction(message, userId) {
  const model = getModel();
  if (!model) return null;

  const prompt = `${PARSE_TRANSACTION_PROMPT}

Mensagem do usuário: "${message}"

Retorne SOMENTE o JSON, sem texto adicional.`;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text();

    const parsed = extractJSON(text);

    if (
      typeof parsed.type !== 'string' ||
      typeof parsed.amount !== 'number' ||
      typeof parsed.category !== 'string' ||
      typeof parsed.confidence !== 'number'
    ) {
      console.log(`[FinBot] Resposta do Gemini com formato inválido para userId=${userId}`);
      return null;
    }

    if (parsed.amount <= 0 || parsed.confidence < 0.1) {
      return null;
    }

    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) {
      console.error('[FinBot ERROR] Gemini retornou JSON inválido:', error.message);
    } else {
      console.error('[FinBot ERROR] Falha ao chamar Gemini API:', error.message);
    }
    return null;
  }
}

export async function generateSarcasticResponse({ type, amount, category, description, categoryTotal }) {
  const model = getModel();
  if (!model) return null;

  const { formatCurrency } = await import('../bot/formatter.js');

  const prompt = `${SARCASTIC_RESPONSE_PROMPT}

Dados da transação:
- Tipo: ${type === 'expense' ? 'gasto' : 'receita'}
- Valor: ${formatCurrency(amount)}
- Categoria: ${category}
- Descrição: ${description || category}
- Total em ${category} este mês (incluindo este): ${formatCurrency(categoryTotal)}

Gere a resposta sarcástica agora.`;

  try {
    const result = await model.generateContent(prompt);
    return result.response.text().trim() || null;
  } catch (error) {
    console.error('[FinBot ERROR] Falha ao gerar resposta sarcástica:', error.message);
    return null;
  }
}

export async function generateInsights(userData) {
  const model = getModel();
  if (!model) return null;

  const { summary, previousSummary, recentTransactions, firstName } = userData;

  const prompt = `${INSIGHTS_PROMPT}

Dados financeiros reais do usuário ${firstName}:
- Receitas do mês: R$ ${summary.total_income.toFixed(2)}
- Gastos do mês: R$ ${summary.total_expenses.toFixed(2)}
- Saldo: R$ ${(summary.total_income - summary.total_expenses).toFixed(2)}
- Gastos por categoria: ${JSON.stringify(summary.by_category)}
- Receitas mês anterior: R$ ${previousSummary.total_income.toFixed(2)}
- Gastos mês anterior: R$ ${previousSummary.total_expenses.toFixed(2)}
- Últimas transações:
${recentTransactions
  .slice(0, 10)
  .map(
    (t) =>
      `  - ${t.type === 'expense' ? 'Gasto' : 'Receita'} de R$ ${t.amount.toFixed(2)} em ${t.category}: ${t.description || 'sem descrição'}`
  )
  .join('\n')}`;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text();
    return text.trim() || null;
  } catch (error) {
    console.error('[FinBot ERROR] Falha ao gerar insights com Gemini:', error.message);
    return null;
  }
}
