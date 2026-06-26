/**
 * Centralised error → user-friendly message mapping.
 *
 * Anywhere we surface an error to the UI we should pass it through
 * `friendlyError(e)` so the user sees a clear, actionable Chinese message
 * instead of `[object Object]`, "Network request failed", or a stack trace.
 */

export const ERR_USER_CANCELLED = 'USER_CANCELLED';

export class UserCancelledError extends Error {
  constructor(message = '已取消') {
    super(message);
    this.name = ERR_USER_CANCELLED;
  }
}

export function isCancellation(e: unknown): boolean {
  if (!e) return false;
  if (e instanceof UserCancelledError) return true;
  const name = (e as any)?.name ?? '';
  return name === ERR_USER_CANCELLED || name === 'AbortError';
}

interface FriendlyOptions {
  /** Context label included in the message, e.g. "本機分析". */
  action?: string;
}

/**
 * Convert anything thrown / rejected into a one-line user-facing string.
 * Returns `null` for cancellations (caller usually wants to render nothing).
 */
export function friendlyError(e: unknown, opts: FriendlyOptions = {}): string | null {
  if (isCancellation(e)) return null;

  const action = opts.action ? `${opts.action}失敗：` : '';
  const raw =
    e instanceof Error ? e.message :
    typeof e === 'string' ? e :
    JSON.stringify(e ?? {});

  if (/aborted|cancel/i.test(raw)) {
    return `${action}已取消。`;
  }

  // Already user-friendly Chinese — pass through with prefix
  if (/[一-鿿]/.test(raw)) return action ? `${action}${raw}` : raw;

  return action ? `${action}${raw}` : raw;
}
