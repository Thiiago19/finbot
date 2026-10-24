# FinBot — Guia para Claude Code

## Objetivo

Assistente financeiro pessoal via Telegram. Interpreta mensagens em linguagem natural (texto, áudio, foto de cupom, PDF de fatura), categoriza com IA e separa gastos pessoais dos da loja (palavra-chave `loja` → categoria `Negócio`). Tom sarcástico em todas as respostas.

## Stack

- **Runtime**: Node.js 22.13+ (produção no Render usa 24) com ES Modules
- **Bot**: Telegraf v4
- **IA de texto**: Groq (`openai/gpt-oss-120b`) com fallback para Gemini — ver `src/ai/llm.js`
- **Áudio**: Whisper no Groq (`whisper-large-v3-turbo`) → mesmo parser do texto; fallback Gemini
- **Imagem e PDF**: Gemini (`gemini-2.5-flash-lite`, configurável por `GEMINI_MODEL`)
- **Banco**: Turso (réplica `libsql`) quando há `TURSO_DATABASE_URL`; senão `node:sqlite` local. Os dois são síncronos e têm a mesma API (`prepare/run/get/all/exec`). Sem better-sqlite3.
- **Deploy**: Render (web service gratuito) + GitHub

## Estrutura

```
src/
├── index.js                 ← entry point; servidor HTTP p/ o Render; boot do bot
├── config/timezone.js       ← fixa process.env.TZ (PRIMEIRO import do index.js)
├── utils/date.js            ← todayStr(), toLocalDateStr(), currentYear()
├── state.js                 ← estado em memória compartilhado
├── ai/
│   ├── llm.js               ← roteador de texto (ordem em AI_TEXT_PROVIDERS)
│   ├── assistant.js         ← parseTransaction, generateSarcasticResponse, generateInsights
│   ├── media.js             ← analyzeImage, analyzeAudio, analyzePDF, downloadTelegramFile
│   ├── prompts.js           ← prompts; buildParseTransactionPrompt({ today, year })
│   ├── json.js              ← extractJSON / extractJSONArray
│   └── providers/           ← groq.js, gemini.js, errors.js (ProviderError)
├── bot/                     ← commands.js, handlers.js, formatter.js
├── db/                      ← database.js, schema.sql, queries.js
└── services/                ← transactions, insights, alerts, notifications, scheduler, exporter
test/                        ← node:test (npm test)
```

## Variáveis de ambiente

| Variável | Obrigatória | Descrição |
|---|---|---|
| `TELEGRAM_TOKEN` | sim | Token do BotFather |
| `GROQ_API_KEY` | recomendada | Texto e áudio (principal) |
| `GEMINI_API_KEY` | recomendada | Imagem, PDF e reserva |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | em produção | Banco persistente no Turso (réplica local em `TURSO_REPLICA_PATH`) |
| `DATABASE_PATH` | não | SQLite local quando não há Turso. Padrão `./finbot.db` |
| `GROQ_MODEL`, `GROQ_STT_MODEL`, `GROQ_REASONING_EFFORT`, `GEMINI_MODEL`, `AI_TEXT_PROVIDERS`, `APP_TIMEZONE` | não | Ver `.env.example` |

Nunca commitar o `.env`. Nunca logar valores de variáveis de ambiente.

## Rodar e testar

```bash
npm install
cp .env.example .env   # preencher
npm run dev            # reload automático
npm test               # testes (node:test)
```

## Regras que já custaram bugs

- **Datas**: NUNCA usar `toISOString()` para "hoje" (vira o dia seguinte à noite). Use `todayStr()` / `toLocalDateStr()` de `src/utils/date.js`. O servidor roda em UTC; quem garante o fuso é `src/config/timezone.js`.
- **Ano no prompt**: nunca fixar o ano; `buildParseTransactionPrompt` recebe `today` e `year`.
- **Envio de arquivo no Telegram**: usar `fetch` + `FormData` + `Blob` (o `sendDocument` do Telegraf dava socket hang-up). Ver exportação em `commands.js`.
- **Modelos de IA**: não fixar nome de modelo fora de `src/ai/providers/`; trocar por variável de ambiente. A família Gemini 1.5 foi desligada.
- **Banco no Render gratuito**: o disco é efêmero e o plano não aceita disco persistente. Em produção o banco é o Turso (`TURSO_DATABASE_URL`). Escolha do driver em `resolveDbConfig()` (`src/db/database.js`).
- **Assinaturas por PDF**: o Thiago prefere registrar manualmente (evita duplicidade e mantém controle de valores divididos).

## Convenções

- ES Modules (`import/export`), `async/await`, `try/catch` em todo handler e chamada externa
- Logs: `[FinBot]` para info, `[FinBot ERROR]` para erros
- Respostas ao usuário sempre em português brasileiro
- O banco é síncrono (`node:sqlite` e `libsql`): não usar `await` nas queries. Use só a API comum aos dois.

## Categorias

`Alimentação`, `Transporte`, `Moradia`, `Saúde`, `Lazer`, `Assinaturas`, `Educação`, `Compras`, `Investimentos`, `Receita`, `Negócio`, `Outros`

## Comandos

`/start`, `/resumo` (`/mes`), `/saldo`, `/gastos`, `/metas`, `/ajuda`, `/fatura`, `/parcelas`, `/assinaturas`, `/cartoes`, `/contas`, `/negocio`, `/exportar`, `/limpar`, `/gerenciar`

## Fluxo de uma mensagem

1. `handlers.js` recebe o texto → `processMessage()` (`services/transactions.js`)
2. `parseTransaction()` (`ai/assistant.js`) → `llm.generateText()` → Groq, ou Gemini se falhar
3. JSON `{ type, amount, category, description, confidence, date, payment_method, card_name, installments, ... }`
4. `confidence >= 0.6` salva direto; abaixo disso mostra card com Confirmar / Cancelar / Corrigir categoria
5. Após salvar: resposta sarcástica (IA) e alertas de orçamento (`services/alerts.js`)
