// Erro padronizado dos provedores de IA.
// retryable = vale tentar outro provedor (cota, rede, 5xx).
export class ProviderError extends Error {
  constructor(provider, message, { status = null, retryable = false } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.status = status;
    this.retryable = retryable;
  }
}
