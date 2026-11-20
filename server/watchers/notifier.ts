import { fetchWithTimeout } from '../liveCheckers/httpClient';
import type {
  NotificationResult,
  PendingDeviceNotification,
  SystemAlertPayload,
  TikTokEvent,
  WebhookEventPayload,
} from './types';

export type CustomFetchFn = (
  url: string,
  options?: {
    method?: 'GET' | 'POST' | 'HEAD';
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  }
) => Promise<{ status: number; ok: boolean; text?: string }>;

export interface NotifierOptions {
  webhookUrl?: string;
  androidCallbackUrl?: string;
  timeoutMs?: number;
  retryDelaysMs?: number[];
  fetchFn?: CustomFetchFn;
  onPendingNotification?: (notif: PendingDeviceNotification) => Promise<void> | void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Notifier {
  private webhookUrl?: string;
  private androidCallbackUrl?: string;
  private timeoutMs: number;
  private retryDelaysMs: number[];
  private fetchFn: CustomFetchFn;
  private onPendingNotification?: (notif: PendingDeviceNotification) => Promise<void> | void;

  constructor(options?: NotifierOptions) {
    this.webhookUrl = options?.webhookUrl;
    this.androidCallbackUrl = options?.androidCallbackUrl;
    this.timeoutMs = options?.timeoutMs ?? 10000;
    this.retryDelaysMs = options?.retryDelaysMs ?? [1000, 2000, 4000];
    this.onPendingNotification = options?.onPendingNotification;
    this.fetchFn =
      options?.fetchFn ||
      (async (url, opts) => {
        const resp = await fetchWithTimeout(url, {
          method: opts?.method || 'POST',
          headers: opts?.headers,
          body: opts?.body,
          timeoutMs: opts?.timeoutMs ?? 10000,
        });
        return {
          status: resp.status,
          ok: resp.ok,
          text: resp.text,
        };
      });
  }

  formatPayload(event: TikTokEvent): WebhookEventPayload {
    return {
      username: event.username,
      type: event.eventType,
      id: event.itemId,
      url: event.url,
      title: event.title,
      thumbnail_url: event.thumbnailUrl || null,
      stream_url: event.streamUrl || null,
      platform: 'TIKTOK',
      detected_at: event.detectedAt,
    };
  }

  async notify(event: TikTokEvent): Promise<NotificationResult> {
    if (!this.webhookUrl && !this.androidCallbackUrl) {
      return { status: 'skipped', attempts: 0, error: 'No webhookUrl or androidCallbackUrl configured' };
    }

    let webhookResult: NotificationResult = { status: 'skipped', attempts: 0 };

    if (this.webhookUrl) {
      const payload = this.formatPayload(event);
      webhookResult = await this.sendWithRetry(this.webhookUrl, payload);
    }

    // Android device bridge dispatch for live stream triggers
    if (this.androidCallbackUrl && event.eventType === 'live' && event.streamUrl) {
      await this.dispatchToAndroid(event).catch((err) => {
        // Non-blocking for webhook delivery
        console.warn(`[Notifier] Android dispatch error for @${event.username}:`, err);
      });
    }

    // Android device notification for new Post or Story (with downloaded media info)
    if (event.eventType === 'post' || event.eventType === 'story') {
      const downloaded = event.metadata?.downloadedMedia as
        | { files?: Array<{ path: string; fileName: string; fileSize: number }> }
        | undefined;
      const primaryFile = downloaded?.files?.[0];

      const deviceNotif: PendingDeviceNotification = {
        id: `notif_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: event.eventType === 'story' ? 'STORY_DOWNLOADED' : 'POST_DOWNLOADED',
        eventType: event.eventType,
        platform: 'TIKTOK',
        username: event.username,
        title: event.title || `New ${event.eventType} from @${event.username}`,
        itemId: event.itemId,
        sourceUrl: event.url,
        mediaPath: primaryFile?.path,
        fileName: primaryFile?.fileName,
        fileSize: primaryFile?.fileSize,
        createdAt: new Date().toISOString(),
      };

      if (this.onPendingNotification) {
        try {
          await this.onPendingNotification(deviceNotif);
        } catch (err) {
          console.warn('[Notifier] Failed to queue pending notification:', err);
        }
      }

      if (this.androidCallbackUrl) {
        await this.dispatchNotificationToAndroid(deviceNotif).catch((err) => {
          console.warn(`[Notifier] Android direct notification dispatch error for @${event.username}:`, err);
        });
      }
    }

    return webhookResult;
  }

  async sendSystemAlert(
    collectorName: string,
    error: string,
    consecutiveErrors: number
  ): Promise<NotificationResult> {
    if (!this.webhookUrl) {
      return { status: 'skipped', attempts: 0, error: 'No webhookUrl configured' };
    }

    const payload: SystemAlertPayload = {
      alert_type: 'COLLECTOR_FAILURE_THRESHOLD',
      collector_name: collectorName,
      consecutive_errors: consecutiveErrors,
      error_message: error,
      triggered_at: new Date().toISOString(),
    };

    return this.sendWithRetry(this.webhookUrl, payload);
  }

  private async dispatchToAndroid(event: TikTokEvent): Promise<void> {
    if (!this.androidCallbackUrl) return;

    const androidPayload = {
      canonicalKey: `TIKTOK::${event.username}`,
      platform: 'TIKTOK',
      username: event.username,
      streamUrl: event.streamUrl,
      sourceUrl: event.url,
      title: event.title,
      detectedAt: event.detectedAt,
    };

    await this.fetchFn(this.androidCallbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(androidPayload),
      timeoutMs: this.timeoutMs,
    });
  }

  private async dispatchNotificationToAndroid(notif: PendingDeviceNotification): Promise<void> {
    if (!this.androidCallbackUrl) return;

    // Use /notify endpoint on companion if callback ends in /record, otherwise use raw callback
    const notifyUrl = this.androidCallbackUrl.includes('/record')
      ? this.androidCallbackUrl.replace(/\/record\/?$/, '/notify')
      : `${this.androidCallbackUrl.replace(/\/+$/, '')}/notify`;

    await this.fetchFn(notifyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(notif),
      timeoutMs: this.timeoutMs,
    });
  }

  private async sendWithRetry(url: string, payload: unknown): Promise<NotificationResult> {
    const bodyStr = JSON.stringify(payload);
    const headers = { 'Content-Type': 'application/json' };
    const maxAttempts = 1 + this.retryDelaysMs.length;
    let attempts = 0;
    let lastError: string | null = null;
    let lastHttpStatus: number | undefined;

    for (let i = 0; i < maxAttempts; i++) {
      attempts++;
      try {
        const resp = await this.fetchFn(url, {
          method: 'POST',
          headers,
          body: bodyStr,
          timeoutMs: this.timeoutMs,
        });

        lastHttpStatus = resp.status;

        if (resp.ok) {
          return {
            status: 'delivered',
            attempts,
            httpStatus: resp.status,
          };
        }

        // 4xx errors (client errors) should NOT be retried
        if (resp.status >= 400 && resp.status < 500) {
          return {
            status: 'failed',
            attempts,
            httpStatus: resp.status,
            error: `HTTP ${resp.status} Client Error: ${resp.text || 'No response body'}`,
          };
        }

        // 5xx errors: retry with backoff
        lastError = `HTTP ${resp.status} Server Error`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }

      // If more retries remain, sleep with exponential backoff delay
      if (i < this.retryDelaysMs.length) {
        await sleep(this.retryDelaysMs[i]);
      }
    }

    return {
      status: 'failed',
      attempts,
      httpStatus: lastHttpStatus,
      error: lastError || 'Max retries exceeded',
    };
  }
}
