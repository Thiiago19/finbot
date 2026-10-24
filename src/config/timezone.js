// Fixa o fuso horário do processo ANTES de qualquer outro módulo usar Date.
//
// Por quê: o Render (e a maioria dos servidores) roda em UTC. Sem isso,
// getDate()/getMonth()/getFullYear() devolvem o dia em UTC e, depois das 21h
// em Brasília, o bot passa a enxergar "amanhã".
//
// Este arquivo precisa ser o PRIMEIRO import de src/index.js: em ES Modules
// os imports são avaliados na ordem em que aparecem.

export const APP_TIMEZONE = process.env.APP_TIMEZONE || 'America/Sao_Paulo';

process.env.TZ = APP_TIMEZONE;
