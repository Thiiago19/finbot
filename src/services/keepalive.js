// O Render gratuito hiberna o serviço após 15 min sem tráfego HTTP de entrada.
// O polling do Telegram é tráfego de saída e não conta, então o bot dormiria
// e só acordaria com uma requisição HTTP. Aqui o bot pinga a própria URL pública.

const INTERVAL_MS = 10 * 60 * 1000;

/** URL a pingar, ou null quando o keep-alive não deve rodar. */
export function getKeepAliveUrl(env = process.env) {
  if (env.KEEPALIVE === 'off') return null;
  const base = env.KEEPALIVE_URL || env.RENDER_EXTERNAL_URL;
  if (!base) return null;
  return `${base.replace(/\/+$/, '')}/health`;
}

export function startKeepAlive() {
  const url = getKeepAliveUrl();
  if (!url) return null;

  console.log('[FinBot] Keep-alive ativo (ping a cada 10 min).');
  const timer = setInterval(async () => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) console.error(`[FinBot ERROR] Keep-alive respondeu ${res.status}`);
    } catch (error) {
      console.error('[FinBot ERROR] Keep-alive falhou:', error.message);
    }
  }, INTERVAL_MS);
  timer.unref();
  return timer;
}
