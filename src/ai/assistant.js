// Funções de IA de texto do FinBot (parse, resposta sarcástica, insights).
// Independe de provedor: quem decide Groq/Gemini é src/ai/llm.js.

import { generateText } from './llm.js';
import { extractJSON } from './json.js';
import { buildParseTransactionPrompt, INSIGHTS_PROMPT, SARCASTIC_RESPONSE_PROMPT } from './prompts.js';
import { todayStr, currentYear } from '../utils/date.js';

export async function parseTransaction(message, userId) {
  const prompt = `${buildParseTransactionPrompt({ today: todayStr(), year: currentYear() })}

Mensagem do usuário: "${message}"

Retorne SOMENTE o JSON, sem texto adicional.`;

  try {
    const result = await generateText(prompt, { task: 'parse', temperature: 0 });
    if (!result) return null;

    const parsed = extractJSON(result.text);

    if (
      typeof parsed.type !== 'string' ||
      typeof parsed.amount !== 'number' ||
      typeof parsed.category !== 'string' ||
      typeof parsed.confidence !== 'number'
    ) {
      console.log(`[FinBot] Resposta da IA (${result.provider}) com formato inválido para userId=${userId}`);
      return null;
    }

    if (parsed.amount <= 0 || parsed.confidence < 0.1) {
      return null;
    }

    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) {
      console.error('[FinBot ERROR] IA retornou JSON inválido:', error.message);
    } else {
      console.error('[FinBot ERROR] Falha ao interpretar transação:', error.message);
    }
    return null;
  }
}

export async function generateSarcasticResponse({ type, amount, category, description, categoryTotal }) {
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
    const result = await generateText(prompt, { task: 'sarcasmo', temperature: 0.9, maxTokens: 512 });
    return result?.text || null;
  } catch (error) {
    console.error('[FinBot ERROR] Falha ao gerar resposta sarcástica:', error.message);
    return null;
  }
}

export async function generateInsights(userData) {
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
    const result = await generateText(prompt, { task: 'insights', temperature: 0.8 });
    return result?.text || null;
  } catch (error) {
    console.error('[FinBot ERROR] Falha ao gerar insights:', error.message);
    return null;
  }
}
