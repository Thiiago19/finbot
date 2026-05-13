# FinBot — Guia para Claude Code

## Objetivo do Projeto

FinBot é um assistente financeiro pessoal via Telegram que usa IA (Claude) para interpretar mensagens em linguagem natural, categorizar transações automaticamente e gerar insights financeiros personalizados.

## Stack Técnica

- **Runtime**: Node.js 20+ com ES Modules (`"type": "module"`)
- **Bot**: Telegraf v4
- **IA**: Anthropic SDK (`@anthropic-ai/sdk`) — modelo `claude-sonnet-4-20250514`
- **Banco de dados**: SQLite nativo do Node.js 24+ (`node:sqlite`, módulo built-in, síncrono, sem dependência externa)
- **Env vars**: `dotenv`
- **Linguagem**: JavaScript moderno com async/await

## Estrutura de Pastas

```
finbot/
├── src/
│   ├── index.js               ← entry point, inicializa DB e bot
│   ├── bot/
│   │   ├── commands.js        ← /start /resumo /saldo /gastos /metas /ajuda
│   │   ├── handlers.js        ← mensagens texto e callbacks inline
│   │   └── formatter.js       ← formatação de mensagens e moeda
│   ├── ai/
│   │   ├── claude.js          ← chamadas à API do Claude
│   │   └── prompts.js         ← system prompts centralizados
│   ├── db/
│   │   ├── database.js        ← conexão e init do SQLite
│   │   ├── schema.sql         ← DDL das tabelas
│   │   └── queries.js         ← todas as queries SQL
│   └── services/
│       ├── transactions.js    ← lógica de negócio de transações
│       ├── insights.js        ← orquestração de insights via IA
│       └── alerts.js          ← alertas de orçamento e fim de mês
```

## Variáveis de Ambiente

Copie `.env.example` para `.env` e preencha:

| Variável | Descrição |
|---|---|
| `TELEGRAM_TOKEN` | Token do bot obtido no BotFather |
| `ANTHROPIC_API_KEY` | Chave da API da Anthropic |
| `DATABASE_PATH` | Caminho do arquivo SQLite (padrão: `./finbot.db`) |
| `NODE_ENV` | `development` ou `production` |

**Nunca** commitar o `.env` — ele está no `.gitignore`.

## Como Rodar Localmente

```bash
npm install
cp .env.example .env
# editar .env com os tokens reais
node src/index.js
```

Para desenvolvimento com reload automático:

```bash
npm run dev
```

## Convenções de Código

- **ES Modules**: use `import/export`, nunca `require()`
- **Async/await**: nunca usar `.then()/.catch()` encadeados
- **Try/catch**: obrigatório em todos os handlers e chamadas externas
- **Logs**: prefixo `[FinBot]` para info, `[FinBot ERROR]` para erros
- **Segredos**: nunca logar valores de variáveis de ambiente
- **Idioma**: todas as respostas ao usuário em português brasileiro

## Banco de Dados

O banco é inicializado automaticamente na primeira execução. O arquivo `schema.sql` cria as tabelas se não existirem (`CREATE TABLE IF NOT EXISTS`). O `node:sqlite` (`DatabaseSync`) é síncrono — não use `await` nas queries. Não requer compilação nativa; é embutido no Node.js 24+.

## Categorias Válidas

`Alimentação`, `Transporte`, `Moradia`, `Saúde`, `Lazer`, `Assinaturas`, `Educação`, `Compras`, `Investimentos`, `Receita`, `Outros`

## Comandos do Bot

| Comando | Descrição |
|---|---|
| `/start` | Cadastra usuário e exibe boas-vindas |
| `/resumo` ou `/mes` | Resumo mensal com insights de IA |
| `/saldo` | Saldo rápido do mês |
| `/gastos` | Últimas 10 transações |
| `/metas` | Metas financeiras ativas |
| `/ajuda` | Ajuda completa com exemplos |

## Fluxo de Processamento de Mensagem

1. Usuário envia mensagem de texto livre
2. `handlers.js` captura e chama `processMessage()`
3. `transactions.js` chama `parseTransaction()` via `claude.js`
4. Claude retorna JSON com `{ type, amount, category, description, confidence }`
5. Se `confidence >= 0.6`: salva automaticamente e confirma ao usuário
6. Se `confidence < 0.6`: exibe card de confirmação com botões inline
7. Após salvar gasto: verifica alertas de orçamento via `alerts.js`
