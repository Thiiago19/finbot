# 🤖 FinBot — Assistente Financeiro Pessoal via Telegram

FinBot é um bot de Telegram que entende suas mensagens em linguagem natural para registrar gastos e receitas, categorizar automaticamente com IA, gerar insights financeiros personalizados e emitir alertas quando você se aproxima dos limites de orçamento.

## Funcionalidades

- 💬 **Linguagem natural**: diga "gastei 45 no iFood" e o bot entende e registra
- 🤖 **IA integrada**: Claude interpreta e categoriza suas transações
- 📊 **Resumo mensal**: receitas, gastos, saldo, top categorias e comparativo com o mês anterior
- 💡 **Insights personalizados**: análises geradas pela IA baseadas nos seus hábitos reais
- ⚠️ **Alertas inteligentes**: aviso quando você atinge 80% ou 100% do limite de uma categoria
- 🎯 **Metas financeiras**: acompanhe seu progresso em metas com barra de progresso

## Pré-requisitos

- [Node.js 24+](https://nodejs.org/) *(usa o SQLite embutido do Node.js 24 — sem dependências nativas)*
- Conta no Telegram
- Conta na [Anthropic](https://console.anthropic.com/) com créditos de API

## Instalação

### 1. Clone o repositório

```bash
git clone <url-do-repositorio>
cd finbot
```

### 2. Instale as dependências

```bash
npm install
```

### 3. Configure as variáveis de ambiente

```bash
cp .env.example .env
```

Edite o arquivo `.env` com suas credenciais (veja instruções abaixo).

### 4. Execute o bot

```bash
node src/index.js
```

O banco de dados SQLite é criado automaticamente na primeira execução.

## Como obter o Token do Telegram

1. Abra o Telegram e procure por **@BotFather**
2. Envie `/newbot`
3. Escolha um nome para o bot (ex: "Meu FinBot")
4. Escolha um username único terminado em `bot` (ex: `meufinbot_bot`)
5. O BotFather enviará seu token no formato: `1234567890:ABCdefGHIjklmNOPqrstUVwxyz`
6. Copie esse token para a variável `TELEGRAM_TOKEN` no `.env`

## Como obter a API Key da Anthropic

1. Acesse [console.anthropic.com](https://console.anthropic.com/)
2. Crie uma conta ou faça login
3. Vá em **API Keys** → **Create Key**
4. Copie a chave para a variável `ANTHROPIC_API_KEY` no `.env`

> **Nota**: A API da Anthropic é paga por uso. O FinBot usa `max_tokens: 300` para parsing e `max_tokens: 500` para insights, mantendo custos baixos.

## Arquivo .env

```env
TELEGRAM_TOKEN=1234567890:ABCdefGHIjklmNOPqrstUVwxyz
ANTHROPIC_API_KEY=sk-ant-...
DATABASE_PATH=./finbot.db
NODE_ENV=development
```

## Exemplos de Uso

### Registrar gastos

```
"Gastei 45 no iFood"
"Paguei 150 de Uber esse mês"
"Farmácia 67,90"
"Cinema com a família 80 reais"
"Aluguel 1200"
"Netflix 45,90"
```

### Registrar receitas

```
"Recebi meu salário de 3500"
"Freelance de 800 reais"
"Recebi 200 de transferência"
```

### Comandos

| Comando | O que faz |
|---|---|
| `/start` | Boas-vindas e cadastro |
| `/resumo` | Resumo completo do mês com insights de IA |
| `/mes` | Igual ao /resumo |
| `/saldo` | Saldo rápido (receitas − gastos) |
| `/gastos` | Últimas 10 transações registradas |
| `/metas` | Metas financeiras com barra de progresso |
| `/ajuda` | Ajuda completa com exemplos |

## Categorias Reconhecidas

| Emoji | Categoria | Exemplos |
|---|---|---|
| 🍽️ | Alimentação | iFood, mercado, restaurante |
| 🚗 | Transporte | Uber, gasolina, ônibus |
| 🏠 | Moradia | Aluguel, luz, internet |
| 💊 | Saúde | Farmácia, médico, plano |
| 🎉 | Lazer | Cinema, bar, viagem |
| 📺 | Assinaturas | Netflix, Spotify |
| 📚 | Educação | Cursos, livros |
| 🛍️ | Compras | Roupas, eletrônicos |
| 📈 | Investimentos | Ações, fundos |
| 💰 | Receita | Salário, freelance |
| 📦 | Outros | Tudo o mais |

## Limites de Orçamento Padrão (mensais)

Se você não definir limites personalizados, o FinBot usa:

| Categoria | Limite Padrão |
|---|---|
| Alimentação | R$ 800 |
| Transporte | R$ 400 |
| Lazer | R$ 300 |
| Assinaturas | R$ 200 |
| Saúde | R$ 300 |
| Compras | R$ 500 |
| Moradia | R$ 1.500 |
| Educação | R$ 400 |

## Desenvolvimento

```bash
# Rodar com reload automático (Node.js 20+)
npm run dev
```

## Estrutura do Projeto

```
finbot/
├── src/
│   ├── index.js          # Entry point
│   ├── bot/
│   │   ├── commands.js   # Comandos do bot
│   │   ├── handlers.js   # Handler de mensagens
│   │   └── formatter.js  # Formatação das respostas
│   ├── ai/
│   │   ├── claude.js     # Integração com Claude API
│   │   └── prompts.js    # System prompts
│   ├── db/
│   │   ├── database.js   # Conexão SQLite
│   │   ├── schema.sql    # Schema do banco
│   │   └── queries.js    # Queries SQL
│   └── services/
│       ├── transactions.js  # Lógica de transações
│       ├── insights.js      # Geração de insights
│       └── alerts.js        # Sistema de alertas
└── .env.example
```

## Licença

MIT
