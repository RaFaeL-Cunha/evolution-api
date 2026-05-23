import i18next from '@utils/i18n';

function extractErrorText(error: unknown): string {
  if (!error) {
    return '';
  }

  if (typeof error === 'string') {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'object') {
    const err = error as Record<string, unknown>;

    if (Array.isArray(err.message)) {
      return err.message.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join(' ');
    }

    if (typeof err.message === 'string') {
      return err.message;
    }
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function matches(text: string, patterns: string[]): boolean {
  const normalized = text.toLowerCase();
  return patterns.some((pattern) => normalized.includes(pattern.toLowerCase()));
}

function parseRetryAttempts(text: string): number | null {
  const match = text.match(/falhou ap[oó]s (\d+) tentativas/i);
  if (!match) {
    return null;
  }

  const attempts = parseInt(match[1], 10);
  return Number.isNaN(attempts) ? null : attempts;
}

function resolveFriendlyMessageKey(errorText: string, errObj?: Record<string, unknown>): string {
  if (
    errObj?.status === 400 &&
    Array.isArray(errObj.message) &&
    (errObj.message[0] as Record<string, unknown>)?.exists === false
  ) {
    return 'cw.message.numbernotinwhatsapp';
  }

  if (
    errObj?.exists === false ||
    matches(errorText, [
      'not registered',
      'not on whatsapp',
      'not on whats app',
      'nao esta cadastrado',
      'nao esta no whatsapp',
      'number not exists',
      'invalid number',
      'not a valid',
      'numero invalido',
    ])
  ) {
    return 'cw.error.numberNotExists';
  }

  if (
    matches(errorText, [
      'connection closed',
      'not connected',
      'disconnected',
      'presencesubscribe',
      'client not connected',
      'reconectando',
      'instance not found',
      'logout',
      'ws closed',
      'onwhatsapp',
      'cannot read properties',
    ])
  ) {
    return 'cw.error.instanceDisconnected';
  }

  if (
    matches(errorText, ['upload', 'too large', 'file too big', 'attachment', 'arquivo muito grande', 'media upload'])
  ) {
    return 'cw.error.uploadFailed';
  }

  if (
    matches(errorText, [
      'invalid media',
      'corrupt',
      'invalid file',
      'formato invalido',
      'invalid image',
      'invalid document',
    ])
  ) {
    return 'cw.error.invalidMedia';
  }

  if (
    matches(errorText, [
      'timeout',
      'timed out',
      'tempo esgotado',
      'rate limit',
      'too many requests',
      'muitas mensagens',
      'econnreset',
      'etimedout',
    ])
  ) {
    return 'cw.error.retryFailed';
  }

  if (matches(errorText, ['connection', 'network', 'socket', 'econnrefused', 'fetch failed'])) {
    return 'cw.error.connectionFailed';
  }

  return 'cw.error.generic';
}

/**
 * Maps send-message errors to user-friendly i18n messages for Chatwoot private notes.
 * Technical details must be logged by the caller — never exposed to agents here.
 */
export function getChatwootSendErrorMessage(error?: unknown): string {
  const errorText = extractErrorText(error);
  const errObj = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : undefined;
  const attempts = parseRetryAttempts(errorText);
  const friendlyMessage = i18next.t(resolveFriendlyMessageKey(errorText, errObj));

  if (attempts !== null) {
    return `${i18next.t('cw.error.afterAttempts', { attempts })}\n\n${friendlyMessage}`;
  }

  return friendlyMessage;
}
