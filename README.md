# 🤖 FinBot — Assistente Financeiro Pessoal via Telegram

FinBot é um bot de Telegram que entende suas mensagens em linguagem natural para registrar gastos e receitas, categorizar automaticamente com IA, gerar insights financeiros personalizados e emitir alertas quando você se aproxima dos limites de orçamento.

## Funcionalidades

- 💬 **Linguagem natural**: diga "gastei 45 no iFood" e o bot entende e registra
- 🤖 **IA integrada**: Groq (texto e áudio) e Gemini (imagem e PDF) interpretam e categorizam suas transações, com fallback automático entre eles
- 🎙️ **Áudio, foto e PDF**: mande um áudio, a foto do cupom ou a fatura em PDF
- 💳 **Cartões, parcelas e assinaturas**: vencimentos, parcelas retroativas e cobranças recorrentes
- 🏪 **Pessoal × loja**: use a palavra "loja" para separar gastos do negócio
- 📊 **Resumo mensal**: receitas, gastos, saldo, top categorias e comparativo com o mês anterior
- 💡 **Insights personalizados**: análises geradas pela IA baseadas nos seus hábitos reais
- ⚠️ **Alertas inteligentes**: aviso quando você atinge 80% ou 100% do limite de uma categoria
- 🎯 **Metas financeiras**: acompanhe seu progresso em metas com barra de progresso

## Pré-requisitos

- [Node.js 22.13+](https://nodejs.org/) *(usa o SQLite embutido do Node — sem dependências nativas; recomendado 24)*
- Conta no Telegram
- Chave gratuita do [Groq](https://console.groq.com/keys) (texto e áudio)
- Chave gratuita do [Google AI Studio](https://aistudio.google.com/apikey) (imagem, PDF e reserva)

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

## Chaves de IA

| Provedor | Onde pegar | Usado para |
|---|---|---|
| Groq (`GROQ_API_KEY`) | [console.groq.com/keys](https://console.groq.com/keys) | Texto e áudio (principal) |
| Gemini (`GEMINI_API_KEY`) | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | Imagem, PDF e reserva do texto/áudio |

Os dois têm plano gratuito. Os limites são por modelo e aparecem no painel de cada um (Groq: *Settings → Limits*; Google: *AI Studio → Rate limits*). Se o Groq estourar a cota, o texto cai automaticamente para o Gemini.

## Arquivo .env

```env
TELEGRAM_TOKEN=1234567890:ABCdefGHIjklmNOPqrstUVwxyz
GROQ_API_KEY=gsk_...
GEMINI_API_KEY=AIza...
DATABASE_PATH=./finbot.db
NODE_ENV=development
```

Variáveis opcionais (modelos, ordem dos provedores, fuso) estão documentadas no `.env.example`.

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
| `/fatura` | Fatura do cartão |
| `/parcelas` | Compras parceladas em aberto |
| `/assinaturas` | Assinaturas e cobranças recorrentes |
| `/cartoes` | Cartões cadastrados |
| `/contas` | Contas variáveis (luz, água…) |
| `/negocio` | Gastos da loja |
| `/exportar` | Exporta as transações para Excel |
| `/limpar` / `/gerenciar` | Limpeza de dados |

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
| 🏪 | Negócio | Gastos da loja |
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
npm run dev   # reload automático
npm test      # testes automatizados (node:test)
```

## Estrutura do Projeto

```
finbot/
├── src/
│   ├── index.js               # Entry point
│   ├── config/timezone.js     # Fuso do app (America/Sao_Paulo)
│   ├── utils/date.js          # Datas no fuso do app
│   ├── bot/                   # commands, handlers, formatter
│   ├── ai/
│   │   ├── llm.js             # Roteador de IA de texto (Groq → Gemini)
│   │   ├── assistant.js       # Parse, resposta sarcástica, insights
│   │   ├── media.js           # Imagem, áudio, PDF
│   │   ├── prompts.js         # Prompts
│   │   └── providers/         # groq.js, gemini.js
│   ├── db/                    # database, schema.sql, queries
│   └── services/              # transactions, insights, alerts, scheduler, exporter…
├── test/                      # Testes (npm test)
└── .env.example
```

## Licença

MIT
