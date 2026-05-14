import { GoogleGenerativeAI } from '@google/generative-ai';
import { PARSE_TRANSACTION_PROMPT, INSIGHTS_PROMPT } from './prompts.js';

const MODEL = 'gemini-1.5-flash';

function getClient() {
  if (!process.env.GEMINI_API_KEY) return null;
  return new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
}

export async function parseTransaction(message, userId) {
  const client = getClient();
  if (!client) return null;

  try {
    const model = client.getGenerativeModel({
      model: MODEL,
      systemInstruction: PARSE_TRANSACTION_PROMPT,
      generationConfig: {
        maxOutputTokens: 300,
        temperature: 0.1,
        responseMimeType: 'application/json',
      },
    });

    const result = await model.generateContent(message);
    const rawText = result.response.text().trim();

    if (!rawText) {
      console.log(`[FinBot] Gemini retornou resposta vazia para userId=${userId}`);
      return null;
    }

    const parsed = JSON.parse(rawText);

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

export async function generateInsights(userData) {
  const client = getClient();
  if (!client) return null;

  try {
    const { summary, previousSummary, recentTransactions, firstName } = userData;

    const dataContext = `
Usuário: ${firstName}
Mês atual:
- Receitas totais: R$ ${summary.total_income.toFixed(2)}
- Gastos totais: R$ ${summary.total_expenses.toFixed(2)}
- Saldo: R$ ${(summary.total_income - summary.total_expenses).toFixed(2)}
- Gastos por categoria: ${JSON.stringify(summary.by_category)}

Mês anterior:
- Receitas: R$ ${previousSummary.total_income.toFixed(2)}
- Gastos: R$ ${previousSummary.total_expenses.toFixed(2)}

Últimas transações:
${recentTransactions
  .slice(0, 10)
  .map(
    (t) =>
      `- ${t.type === 'expense' ? 'Gasto' : 'Receita'} de R$ ${t.amount.toFixed(2)} em ${t.category}: ${t.description || 'sem descrição'}`
  )
  .join('\n')}
`;

    const model = client.getGenerativeModel({
      model: MODEL,
      systemInstruction: INSIGHTS_PROMPT,
      generationConfig: {
        maxOutputTokens: 500,
        temperature: 0.7,
      },
    });

    const result = await model.generateContent(
      `Gere insights financeiros baseados nesses dados reais:\n${dataContext}`
    );

    return result.response.text().trim() || null;
  } catch (error) {
    console.error('[FinBot ERROR] Falha ao gerar insights com Gemini:', error.message);
    return null;
  }
}
