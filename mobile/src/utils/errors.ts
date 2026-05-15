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
  /** Context label included in the message, e.g. "上傳影片". */
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

  // Network-level
  if (/Network request failed|net::ERR|Failed to fetch/i.test(raw)) {
    return `${action}無法連線到伺服器。請確認網路連線與 Settings 中的 Backend URL 是否正確。`;
  }
  if (/timeout|timed? out|逾時/i.test(raw)) {
    return `${action}連線逾時。可能是檔案太大或網路太慢，請改用較短的影片或切到「離線分析」模式再試。`;
  }
  if (/aborted|cancel/i.test(raw)) {
    return `${action}已取消。`;
  }

  // HTTP-level
  const httpMatch = raw.match(/(\d{3})/);
  if (httpMatch) {
    const code = parseInt(httpMatch[1], 10);
    if (code === 401 || code === 403) return `${action}伺服器拒絕請求（${code}）。`;
    if (code === 404) return `${action}找不到伺服器資源（404）。請確認 Backend URL。`;
    if (code === 413) return `${action}影片檔案過大，伺服器拒絕接收。請壓縮後再試。`;
    if (code >= 500 && code < 600) return `${action}伺服器內部錯誤（${code}）。請稍後再試。`;
  }

  // Already user-friendly Chinese — pass through with prefix
  if (/[一-鿿]/.test(raw)) return action ? `${action}${raw}` : raw;

  return action ? `${action}${raw}` : raw;
}
