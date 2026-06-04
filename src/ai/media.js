import { GoogleGenerativeAI } from '@google/generative-ai';
import axios from 'axios';

const MODEL = 'gemini-2.5-flash-lite';

const VALID_CATEGORIES = [
  'Alimentação', 'Transporte', 'Moradia', 'Saúde', 'Lazer',
  'Assinaturas', 'Educação', 'Compras', 'Investimentos', 'Receita', 'Outros',
];

function getModel() {
  if (!process.env.GEMINI_API_KEY) return null;
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return genAI.getGenerativeModel({ model: MODEL });
}

function extractJSON(text) {
  const block = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const content = block ? block[1].trim() : text.trim();
  const obj = content.match(/\{[\s\S]*\}/);
  if (obj) return JSON.parse(obj[0]);
  return JSON.parse(content);
}

function extractJSONArray(text) {
  const block = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const content = block ? block[1].trim() : text.trim();
  const arr = content.match(/\[[\s\S]*\]/);
  if (arr) return JSON.parse(arr[0]);
  return JSON.parse(content);
}

function normalizeTransaction(parsed) {
  if (!parsed || typeof parsed.amount !== 'number' || parsed.amount <= 0) return null;
  return {
    type: parsed.type === 'income' ? 'income' : 'expense',
    amount: parsed.amount,
    category: VALID_CATEGORIES.includes(parsed.category) ? parsed.category : 'Outros',
    description: parsed.description || '',
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
  };
}

// Baixa um arquivo do Telegram e retorna como base64
export async function downloadTelegramFile(fileId) {
  const token = process.env.TELEGRAM_TOKEN;

  const infoRes = await axios.get(`https://api.telegram.org/bot${token}/getFile`, {
    params: { file_id: fileId },
  });
  const filePath = infoRes.data.result.file_path;

  const fileRes = await axios.get(
    `https://api.telegram.org/file/bot${token}/${filePath}`,
    { responseType: 'arraybuffer' }
  );

  return Buffer.from(fileRes.data).toString('base64');
}

export async function analyzeImage(base64, mimeType = 'image/jpeg') {
  const model = getModel();
  if (!model) return null;

  const prompt = `Analise esta imagem de cupom fiscal, nota ou comprovante.
Extraia: valor total, estabelecimento e categoria (Alimentação, Transporte, Moradia, Saúde, Lazer, Assinaturas, Educação, Compras, Investimentos).
Retorne SOMENTE JSON, sem texto adicional:
{ "type": "expense", "amount": 00.00, "category": "categoria", "description": "estabelecimento", "confidence": 0.0 }`;

  try {
    const result = await model.generateContent([
      { inlineData: { data: base64, mimeType } },
      prompt,
    ]);
    return normalizeTransaction(extractJSON(result.response.text()));
  } catch (error) {
    console.error('[FinBot ERROR] Falha ao analisar imagem:', error.message);
    return null;
  }
}

export async function analyzeAudio(base64, mimeType = 'audio/ogg') {
  const model = getModel();
  if (!model) return null;

  const prompt = `Transcreva este áudio em português e extraia uma transação financeira.
Retorne SOMENTE JSON, sem texto adicional:
{ "type": "expense|income", "amount": 00.00, "category": "Alimentação|Transporte|Moradia|Saúde|Lazer|Assinaturas|Educação|Compras|Investimentos|Receita|Outros", "description": "descrição curta", "confidence": 0.0 }
Se não houver transação identificável, retorne confidence abaixo de 0.5.`;

  try {
    const result = await model.generateContent([
      { inlineData: { data: base64, mimeType } },
      prompt,
    ]);
    return normalizeTransaction(extractJSON(result.response.text()));
  } catch (error) {
    console.error('[FinBot ERROR] Falha ao analisar áudio:', error.message);
    return null;
  }
}

export async function analyzePDF(base64) {
  const model = getModel();
  if (!model) return null;

  const prompt = `Analise este extrato ou documento financeiro.
Liste as transações encontradas.

Ao analisar faturas de cartão de crédito, IGNORE completamente os seguintes tipos de lançamento:
- Pagamento de fatura (ex: "Pagamento recebido", "Payment", "Pgto fatura", "Pagamento efetuado")
- Estorno de pagamento
- Crédito de limite
- Saldo anterior
- Encargos zerados
- Qualquer lançamento que represente o pagamento da fatura em si

Esses são movimentações internas do cartão, não gastos ou receitas reais do usuário.
Retorne APENAS as compras e gastos reais realizados pelo titular do cartão.

Retorne SOMENTE um array JSON, sem texto adicional:
[{ "type": "expense|income", "amount": 00.00, "category": "Alimentação|Transporte|Moradia|Saúde|Lazer|Assinaturas|Educação|Compras|Investimentos|Receita|Negócio|Outros", "description": "descrição", "confidence": 0.0 }]
Se não encontrar transações reais, retorne um array vazio: []`;

  try {
    const result = await model.generateContent([
      { inlineData: { data: base64, mimeType: 'application/pdf' } },
      prompt,
    ]);
    const raw = extractJSONArray(result.response.text());
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeTransaction).filter(Boolean);
  } catch (error) {
    console.error('[FinBot ERROR] Falha ao analisar PDF:', error.message);
    return null;
  }
}
