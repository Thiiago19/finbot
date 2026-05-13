import Anthropic from '@anthropic-ai/sdk';
import { PARSE_TRANSACTION_PROMPT, INSIGHTS_PROMPT } from './prompts.js';

const MODEL = 'claude-sonnet-4-20250514';

function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

export async function parseTransaction(message, userId) {
  const client = getClient();
  if (!client) return null;
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 300,
      system: PARSE_TRANSACTION_PROMPT,
      messages: [
        {
          role: 'user',
          content: message,
        },
      ],
    });

    const rawText = response.content[0]?.text?.trim();
    if (!rawText) {
      console.log(`[FinBot] Claude retornou resposta vazia para userId=${userId}`);
      return null;
    }

    const parsed = JSON.parse(rawText);

    if (
      typeof parsed.type !== 'string' ||
      typeof parsed.amount !== 'number' ||
      typeof parsed.category !== 'string' ||
      typeof parsed.confidence !== 'number'
    ) {
      console.log(`[FinBot] Resposta do Claude com formato inválido para userId=${userId}`);
      return null;
    }

    if (parsed.amount <= 0 || parsed.confidence < 0.1) {
      return null;
    }

    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) {
      console.error('[FinBot ERROR] Claude retornou JSON inválido:', error.message);
    } else {
      console.error('[FinBot ERROR] Falha ao chamar Claude API:', error.message);
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
  .map((t) => `- ${t.type === 'expense' ? 'Gasto' : 'Receita'} de R$ ${t.amount.toFixed(2)} em ${t.category}: ${t.description || 'sem descrição'}`)
  .join('\n')}
`;

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 500,
      system: INSIGHTS_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Gere insights financeiros baseados nesses dados reais:\n${dataContext}`,
        },
      ],
    });

    return response.content[0]?.text?.trim() || null;
  } catch (error) {
    console.error('[FinBot ERROR] Falha ao gerar insights:', error.message);
    return null;
  }
}
