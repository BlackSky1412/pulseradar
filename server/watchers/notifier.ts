import crypto from 'node:crypto';
import {
  buildWebhookPayload,
  type LivePlatform,
  type MatchType,
  type SocialPlatform,
  type WebhookFormat,
} from '../../src/utils/scannerEngine';
import { fetchWithTimeout } from '../liveCheckers/httpClient';
import type {
  NotificationResult,
  PendingDeviceNotification,
  SystemAlertPayload,
  WatcherEvent,
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

export interface NotifierWebhookTarget {
  url: string;
  format?: WebhookFormat;
  secretHeader?: string;
  ruleId?: string;
  matchType?: MatchType;
}

export interface NotifierOptions {
  webhookUrl?: string;
  webhookFormat?: WebhookFormat;
  secretHeader?: string;
  localBaseUrl?: string;
  webhookTargetsByPlatform?: Partial<Record<LivePlatform, NotifierWebhookTarget>>;
  resolveWebhookTarget?: (event: WatcherEvent) => NotifierWebhookTarget | null | undefined;
  androidCallbackUrl?: string;
  timeoutMs?: number;
  retryDelaysMs?: number[];
  fetchFn?: CustomFetchFn;
  onPendingNotification?: (notif: PendingDeviceNotification) => Promise<void> | void;
}

const LIVE_TO_SOCIAL_PLATFORM: Record<LivePlatform, SocialPlatform> = {
  TIKTOK: 'reddit',
  INSTAGRAM: 'hackernews',
  FACEBOOK: 'github',
  X: 'bluesky',
};

const PLATFORM_DOMAINS: Record<LivePlatform, string> = {
  TIKTOK: 'tiktok.com',
  INSTAGRAM: 'instagram.com',
  FACEBOOK: 'facebook.com',
  X: 'x.com',
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolvePlatform(event: WatcherEvent): LivePlatform {
  const p = String(event.platform || 'TIKTOK').toUpperCase();
  if (p === 'INSTAGRAM' || p === 'FACEBOOK' || p === 'X' || p === 'TIKTOK') {
    return p;
  }
  return 'TIKTOK';
}

export class Notifier {
  private webhookUrl?: string;
  private webhookFormat?: WebhookFormat;
  private secretHeader?: string;
  private localBaseUrl?: string;
  private webhookTargetsByPlatform?: Partial<Record<LivePlatform, NotifierWebhookTarget>>;
  private resolveWebhookTargetFn?: (
    event: WatcherEvent
  ) => NotifierWebhookTarget | null | undefined;
  private androidCallbackUrl?: string;
  private timeoutMs: number;
  private retryDelaysMs: number[];
  private fetchFn: CustomFetchFn;
  private onPendingNotification?: (notif: PendingDeviceNotification) => Promise<void> | void;

  constructor(options?: NotifierOptions) {
    this.webhookUrl = options?.webhookUrl;
    this.webhookFormat = options?.webhookFormat;
    this.secretHeader = options?.secretHeader;
    this.localBaseUrl = options?.localBaseUrl;
    this.webhookTargetsByPlatform = options?.webhookTargetsByPlatform;
    this.resolveWebhookTargetFn = options?.resolveWebhookTarget;
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

  updateConfig(
    partial: Partial<
      Pick<
        NotifierOptions,
        | 'webhookUrl'
        | 'webhookFormat'
        | 'secretHeader'
        | 'localBaseUrl'
        | 'webhookTargetsByPlatform'
        | 'resolveWebhookTarget'
        | 'androidCallbackUrl'
      >
    >
  ): void {
    if ('webhookUrl' in partial) this.webhookUrl = partial.webhookUrl;
    if ('webhookFormat' in partial) this.webhookFormat = partial.webhookFormat;
    if ('secretHeader' in partial) this.secretHeader = partial.secretHeader;
    if ('localBaseUrl' in partial) this.localBaseUrl = partial.localBaseUrl;
    if ('webhookTargetsByPlatform' in partial) {
      this.webhookTargetsByPlatform = partial.webhookTargetsByPlatform;
    }
    if ('resolveWebhookTarget' in partial) {
      this.resolveWebhookTargetFn = partial.resolveWebhookTarget;
    }
    if ('androidCallbackUrl' in partial) {
      this.androidCallbackUrl = partial.androidCallbackUrl;
    }
  }

  private resolveTargetUrl(rawUrl: string): string {
    const trimmed = rawUrl.trim();
    if (!trimmed) return '';
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    if (trimmed.startsWith('/') && this.localBaseUrl) {
      return `${this.localBaseUrl.replace(/\/+$/, '')}${trimmed}`;
    }
    return trimmed;
  }

  private resolveWebhookTargetForEvent(event: WatcherEvent): NotifierWebhookTarget | null {
    const platform = resolvePlatform(event);
    const customTarget = this.resolveWebhookTargetFn?.(event);
    if (customTarget && customTarget.url?.trim()) {
      return customTarget;
    }
    const platformTarget = this.webhookTargetsByPlatform?.[platform];
    if (platformTarget && platformTarget.url?.trim()) {
      return platformTarget;
    }
    if (this.webhookUrl && this.webhookUrl.trim()) {
      return {
        url: this.webhookUrl.trim(),
        format: this.webhookFormat,
        secretHeader: this.secretHeader,
      };
    }
    return null;
  }

  formatPayload(event: WatcherEvent): WebhookEventPayload {
    const platform = resolvePlatform(event);
    return {
      username: event.username,
      type: event.eventType,
      id: event.itemId,
      url: event.url,
      title: event.title,
      thumbnail_url: event.thumbnailUrl || null,
      stream_url: event.streamUrl || null,
      platform,
      detected_at: event.detectedAt,
    };
  }

  private buildFormattedPayload(
    event: WatcherEvent,
    target: NotifierWebhookTarget
  ): Record<string, unknown> | WebhookEventPayload {
    if (!target.format) {
      return this.formatPayload(event);
    }

    const platform = resolvePlatform(event);
    const socialPlatform = LIVE_TO_SOCIAL_PLATFORM[platform] || 'reddit';
    const cleanUser = event.username.replace(/^@/, '');
    const matchType: MatchType =
      target.matchType || (event.eventType === 'live' ? 'regex' : 'contains');
    const qualityInfo =
      typeof event.metadata?.qualityInfo === 'string'
        ? event.metadata.qualityInfo
        : undefined;
    const detectionMethod =
      typeof event.metadata?.method === 'string' ? event.metadata.method : undefined;

    return buildWebhookPayload(target.format, {
      ruleId: target.ruleId || `watcher_${platform.toLowerCase()}`,
      keyword: `@${cleanUser}`,
      matchType,
      platform: socialPlatform,
      sourceDomain: PLATFORM_DOMAINS[platform],
      activityType: event.eventType,
      author: cleanUser,
      title: event.title,
      contentSnippet: event.title || `${platform} ${event.eventType} (@${cleanUser})`,
      sourceUrl: event.url,
      detectedAt: event.detectedAt,
      streamUrl: event.streamUrl || undefined,
      livePlatform: platform,
      qualityInfo,
      detectionMethod,
    });
  }

  async notify(event: WatcherEvent): Promise<NotificationResult> {
    const platform = resolvePlatform(event);
    const target = this.resolveWebhookTargetForEvent(event);
    const hasPendingChannel =
      Boolean(this.onPendingNotification) &&
      (event.eventType === 'post' || event.eventType === 'story');

    if (!target && !this.androidCallbackUrl && !hasPendingChannel) {
      return {
        status: 'skipped',
        attempts: 0,
        error: 'No webhookUrl, androidCallbackUrl, or onPendingNotification configured',
      };
    }

    let webhookResult: NotificationResult | null = null;
    let pendingQueueResult: NotificationResult | null = null;
    let anyChannelAttempted = false;

    if (target) {
      const resolvedUrl = this.resolveTargetUrl(target.url);
      if (resolvedUrl) {
        anyChannelAttempted = true;
        const payload = this.buildFormattedPayload(event, target);
        webhookResult = await this.sendWithRetry(resolvedUrl, payload, {
          format: target.format,
          secretHeader: target.secretHeader,
        });
      }
    }

    // Android device bridge dispatch for live stream triggers
    if (this.androidCallbackUrl && event.eventType === 'live' && event.streamUrl) {
      anyChannelAttempted = true;
      await this.dispatchToAndroid(event).catch((err) => {
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
        platform,
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
        anyChannelAttempted = true;
        try {
          await this.onPendingNotification(deviceNotif);
          pendingQueueResult = { status: 'delivered', attempts: 1 };
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.warn('[Notifier] Failed to queue pending notification:', err);
          pendingQueueResult = { status: 'failed', attempts: 1, error: errMsg };
        }
      }

      if (this.androidCallbackUrl) {
        anyChannelAttempted = true;
        await this.dispatchNotificationToAndroid(deviceNotif).catch((err) => {
          console.warn(
            `[Notifier] Android direct notification dispatch error for @${event.username}:`,
            err
          );
        });
      }
    }

    if (webhookResult) {
      return webhookResult;
    }
    if (pendingQueueResult) {
      return pendingQueueResult;
    }
    if (anyChannelAttempted) {
      return { status: 'delivered', attempts: 1 };
    }
    return {
      status: 'skipped',
      attempts: 0,
      error: 'No applicable notification channel for event',
    };
  }

  async sendSystemAlert(
    collectorName: string,
    error: string,
    consecutiveErrors: number
  ): Promise<NotificationResult> {
    if (!this.webhookUrl) {
      return { status: 'skipped', attempts: 0, error: 'No webhookUrl configured' };
    }

    const resolvedUrl = this.resolveTargetUrl(this.webhookUrl);
    const triggeredAt = new Date().toISOString();

    let payload: unknown;
    if (this.webhookFormat === 'discord') {
      payload = {
        username: 'PulseRadar System Alert',
        content: `⚠️ **[COLLECTOR_FAILURE_THRESHOLD]** \`${collectorName}\` lỗi liên tiếp ${consecutiveErrors} lần: ${error}`,
        embeds: [
          {
            title: `Collector Failure Alert: ${collectorName}`,
            description: error.slice(0, 1000),
            color: 15548997,
            fields: [
              { name: 'Collector', value: collectorName, inline: true },
              { name: 'Consecutive Errors', value: String(consecutiveErrors), inline: true },
            ],
            timestamp: triggeredAt,
          },
        ],
      };
    } else if (this.webhookFormat === 'slack') {
      payload = {
        text: `[PulseRadar Alert] ${collectorName} failed ${consecutiveErrors} times: ${error}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*⚠️ Collector Failure Threshold*\n• *Collector:* \`${collectorName}\`\n• *Consecutive Errors:* ${consecutiveErrors}\n• *Error:* ${error}`,
            },
          },
        ],
      };
    } else if (this.webhookFormat === 'telegram') {
      const safeCollector = collectorName
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      const safeError = error
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      payload = {
        parse_mode: 'HTML',
        text: `⚠️ <b>[COLLECTOR_FAILURE_THRESHOLD]</b>\n<b>Collector:</b> <code>${safeCollector}</code>\n<b>Lỗi liên tiếp:</b> ${consecutiveErrors}\n<b>Chi tiết:</b> ${safeError}`,
      };
    } else {
      const alertPayload: SystemAlertPayload = {
        alert_type: 'COLLECTOR_FAILURE_THRESHOLD',
        collector_name: collectorName,
        consecutive_errors: consecutiveErrors,
        error_message: error,
        triggered_at: triggeredAt,
      };
      payload = alertPayload;
    }

    return this.sendWithRetry(resolvedUrl, payload, {
      format: this.webhookFormat,
      secretHeader: this.secretHeader,
      eventTypeHeader: 'system.collector_alert',
    });
  }

  private async dispatchToAndroid(event: WatcherEvent): Promise<void> {
    if (!this.androidCallbackUrl) return;
    const platform = resolvePlatform(event);

    const androidPayload = {
      canonicalKey: `${platform}::${event.username}`,
      platform,
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

  private async sendWithRetry(
    url: string,
    payload: unknown,
    opts?: { format?: WebhookFormat; secretHeader?: string; eventTypeHeader?: string }
  ): Promise<NotificationResult> {
    const bodyStr = JSON.stringify(payload);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    if (opts?.format || opts?.secretHeader) {
      headers['X-PulseBot-Event'] = opts.eventTypeHeader || 'social.keyword.detected';
      headers['X-PulseBot-Format'] = opts.format || 'json';
      headers['X-PulseBot-Signature'] = opts.secretHeader
        ? `sha256=${crypto
            .createHmac('sha256', opts.secretHeader)
            .update(bodyStr)
            .digest('hex')}`
        : 'unsigned';
    }

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
