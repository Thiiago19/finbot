// Helpers de data no fuso do app (ver src/config/timezone.js).
//
// Regra do projeto: NUNCA usar toISOString() para obter "a data de hoje".
// toISOString() converte para UTC e, à noite em Brasília, devolve o dia seguinte.

import { APP_TIMEZONE } from '../config/timezone.js';

// Formatter 'en-CA' produz YYYY-MM-DD. Usa o fuso explicitamente, então
// funciona mesmo que process.env.TZ tenha sido alterado por fora.
const ymdFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: APP_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Data (YYYY-MM-DD) de um instante, no fuso do app. */
export function toLocalDateStr(date = new Date()) {
  return ymdFormatter.format(date);
}

/** Data de hoje (YYYY-MM-DD) no fuso do app. */
export function todayStr() {
  return toLocalDateStr(new Date());
}

/** Ano corrente no fuso do app. */
export function currentYear() {
  return Number(todayStr().slice(0, 4));
}
