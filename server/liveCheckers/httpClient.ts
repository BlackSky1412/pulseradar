export interface FetchResponseResult {
  ok: boolean;
  status: number;
  url: string;
  text: string;
}

export async function fetchWithTimeout(
  url: string,
  options: {
    method?: 'GET' | 'POST' | 'HEAD';
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  } = {}
): Promise<FetchResponseResult> {
  const { method = 'GET', headers = {}, body, timeoutMs = 10000 } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      redirect: 'follow',
      signal: controller.signal,
    });
    const text = method === 'HEAD' ? '' : await res.text().catch(() => '');
    return {
      ok: res.ok,
      status: res.status,
      url: res.url || url,
      text,
    };
  } catch (err: unknown) {
    const msg = (err as Error)?.message || '';
    const causeMsg = String((err as { cause?: { message?: string } })?.cause?.message || '');
    if (msg.includes('redirect count exceeded') || causeMsg.includes('redirect count exceeded')) {
      return {
        ok: false,
        status: 302,
        url,
        text: 'REDIRECT_LOOP: Cookie session invalid or expired',
      };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function safeJsonParse<T = Record<string, unknown>>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
