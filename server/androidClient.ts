import type { LivePlatform } from '../src/utils/scannerEngine';
import type { AndroidDeviceState } from './stateStore';

export interface AndroidRecordRequest {
  eventId: string;
  platform: LivePlatform;
  username: string;
  usernameOrUrl: string;
  streamUrl: string;
  title: string;
  sourceUrl: string;
  qualityInfo?: string;
  ruleId?: string;
  detectedAt: string;
}

export interface AndroidClientOptions {
  timeoutMs?: number;
  retryDelayMs?: number;
  maxRetries?: number;
  fetchFn?: typeof fetch;
}

export interface AndroidRecordDispatchResult {
  ok: boolean;
  callbackUrl: string;
  httpStatus: number;
  androidStatus?: string;
  attempts: number;
  latencyMs: number;
  error: string | null;
}

export interface AndroidClient {
  dispatchRecord: (
    device: Pick<AndroidDeviceState, 'ip' | 'port' | 'callbackUrl'>,
    payload: AndroidRecordRequest
  ) => Promise<AndroidRecordDispatchResult>;
  getLastDispatchError: () => string | null;
  clearLastDispatchError: () => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function resolveAndroidCallbackUrl(
  device: Pick<AndroidDeviceState, 'ip' | 'port' | 'callbackUrl'>
): string {
  const raw = typeof device.callbackUrl === 'string' ? device.callbackUrl.trim() : '';
  if (raw) return raw;
  return `http://${device.ip}:${device.port}/record`;
}

export function createAndroidClient(options: AndroidClientOptions = {}): AndroidClient {
  const timeoutMs = options.timeoutMs ?? 5000;
  const retryDelayMs = options.retryDelayMs ?? 1000;
  const maxRetries = options.maxRetries ?? 1;
  const fetchFn = options.fetchFn ?? globalThis.fetch;

  let lastDispatchError: string | null = null;

  return {
    async dispatchRecord(
      device: Pick<AndroidDeviceState, 'ip' | 'port' | 'callbackUrl'>,
      payload: AndroidRecordRequest
    ): Promise<AndroidRecordDispatchResult> {
      const callbackUrl = resolveAndroidCallbackUrl(device);
      const startTime = Date.now();
      const totalAttempts = 1 + Math.max(0, maxRetries);

      let lastStatus = 0;
      let lastErrorMessage = 'Unknown dispatch error';

      for (let attempt = 1; attempt <= totalAttempts; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const res = await fetchFn(callbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal,
          });

          const text = await res.text().catch(() => '');
          let parsed: { status?: string; error?: string } | null = null;
          if (text) {
            try {
              parsed = JSON.parse(text) as { status?: string; error?: string };
            } catch {
              parsed = null;
            }
          }

          if (res.ok) {
            lastDispatchError = null;
            return {
              ok: true,
              callbackUrl,
              httpStatus: res.status,
              androidStatus: typeof parsed?.status === 'string' ? parsed.status : undefined,
              attempts: attempt,
              latencyMs: Math.max(1, Date.now() - startTime),
              error: null,
            };
          }

          lastStatus = res.status;
          const preview = parsed?.error || text.slice(0, 200) || res.statusText || `HTTP ${res.status}`;
          lastErrorMessage = `HTTP ${res.status}: ${preview}`;

          // Do not retry 4xx client/validation errors
          if (res.status >= 400 && res.status < 500) {
            lastDispatchError = lastErrorMessage;
            return {
              ok: false,
              callbackUrl,
              httpStatus: res.status,
              attempts: attempt,
              latencyMs: Math.max(1, Date.now() - startTime),
              error: lastErrorMessage,
            };
          }
        } catch (err) {
          lastStatus = 0;
          lastErrorMessage =
            err instanceof Error
              ? err.name === 'AbortError'
                ? `Request timed out after ${timeoutMs}ms`
                : err.message
              : 'Network connection error';
        } finally {
          clearTimeout(timer);
        }

        if (attempt < totalAttempts && retryDelayMs > 0) {
          await sleep(retryDelayMs);
        }
      }

      lastDispatchError = lastErrorMessage;
      return {
        ok: false,
        callbackUrl,
        httpStatus: lastStatus,
        attempts: totalAttempts,
        latencyMs: Math.max(1, Date.now() - startTime),
        error: lastErrorMessage,
      };
    },

    getLastDispatchError(): string | null {
      return lastDispatchError;
    },

    clearLastDispatchError(): void {
      lastDispatchError = null;
    },
  };
}
