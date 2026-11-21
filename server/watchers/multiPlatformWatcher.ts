import { BaseCollector, normalizeUsername } from './collectors/base';
import { TikTokLiveCollector } from './collectors/tiktokLive';
import { TikTokPostCollector } from './collectors/tiktokPost';
import { TikTokStoryCollector } from './collectors/tiktokStory';
import {
  FacebookLiveCollector,
  InstagramLiveCollector,
  XLiveCollector,
} from './collectors/platformLive';
import { InstagramPostCollector } from './collectors/instagramPost';
import { InstagramStoryCollector } from './collectors/instagramStory';
import { FacebookPostCollector } from './collectors/facebookPost';
import { FacebookStoryCollector } from './collectors/facebookStory';
import { XPostCollector } from './collectors/xPost';
import { XStoryCollector } from './collectors/xStory';
import { Notifier } from './notifier';
import { createWatcherStateStore, WatcherStateStore } from './stateStore';
import { createMediaDownloader, MediaDownloader } from '../mediaDownloader';
import type { LivePlatform, PlatformCookies } from '../liveCheckers/types';
import type { MultiPlatformSettings } from '../../src/utils/scannerEngine';
import type {
  CollectorFetchResult,
  CollectorHealthRecord,
  MultiPlatformWatcherConfig,
  PlatformCollector,
  TargetCollectorDiagnostic,
  WatcherConfig,
  WatcherEvent,
  WatcherEventType,
} from './types';
import type { WatcherCycleReport } from './tiktokWatcher';

export interface MultiPlatformWatcherOptions {
  config?: Partial<MultiPlatformWatcherConfig> & Partial<WatcherConfig>;
  stateStore?: WatcherStateStore;
  notifier?: Notifier;
  mediaDownloader?: MediaDownloader;
  collectors?: Partial<Record<LivePlatform, Partial<Record<WatcherEventType, PlatformCollector>>>>;
}

const ALL_PLATFORMS: LivePlatform[] = ['TIKTOK', 'INSTAGRAM', 'FACEBOOK', 'X'];

function randomInRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export class MultiPlatformWatcher {
  private config: MultiPlatformWatcherConfig;
  private stateStore: WatcherStateStore;
  private notifier: Notifier;
  private mediaDownloader: MediaDownloader;

  private collectors: Record<LivePlatform, Record<WatcherEventType, PlatformCollector>>;
  private isRunningState = false;
  private stopController: AbortController | null = null;
  private activeLoops: Promise<void>[] = [];

  private diagnosticsMap = new Map<string, TargetCollectorDiagnostic>();
  private lastReports: Record<WatcherEventType, WatcherCycleReport | null> = {
    live: null,
    post: null,
    story: null,
  };

  constructor(options?: MultiPlatformWatcherOptions) {
    const rawCfg = options?.config || {};
    const initialTargets: Record<LivePlatform, string[]> = {
      TIKTOK: [],
      INSTAGRAM: [],
      FACEBOOK: [],
      X: [],
      ...(rawCfg.targetsByPlatform || {}),
    };

    if (Array.isArray(rawCfg.targetUsers) && rawCfg.targetUsers.length > 0) {
      const merged = new Set([...(initialTargets.TIKTOK || []), ...rawCfg.targetUsers]);
      initialTargets.TIKTOK = Array.from(merged);
    }

    const initialCookies: PlatformCookies = {
      tiktok: rawCfg.cookies?.tiktok || rawCfg.tiktokSessionId || '',
      instagram: rawCfg.cookies?.instagram || '',
      facebook: rawCfg.cookies?.facebook || '',
      x: rawCfg.cookies?.x || '',
    };

    this.config = {
      targetsByPlatform: initialTargets,
      cookies: initialCookies,
      platformSettings: rawCfg.platformSettings,
      enableWarmup: rawCfg.enableWarmup !== false,
      autoDownloadMedia: rawCfg.autoDownloadMedia !== false,
      driveStorageRoot: rawCfg.driveStorageRoot,
      webhookUrl: rawCfg.webhookUrl,
      androidCallbackUrl: rawCfg.androidCallbackUrl,
      staggerRangeMs: rawCfg.staggerRangeMs ?? [1000, 3000],
      alertErrorThreshold: rawCfg.alertErrorThreshold ?? 5,
      alertCooldownSeconds: rawCfg.alertCooldownSeconds ?? 3600,
    };

    this.stateStore = options?.stateStore || createWatcherStateStore();
    this.mediaDownloader =
      options?.mediaDownloader ||
      createMediaDownloader({ storageRoot: this.config.driveStorageRoot });
    this.notifier =
      options?.notifier ||
      new Notifier({
        webhookUrl: this.config.webhookUrl,
        androidCallbackUrl: this.config.androidCallbackUrl,
      });

    const custom = options?.collectors;
    this.collectors = {
      TIKTOK: {
        live: custom?.TIKTOK?.live || new TikTokLiveCollector({ cookie: this.getCookie('TIKTOK') }),
        post: custom?.TIKTOK?.post || new TikTokPostCollector({ cookie: this.getCookie('TIKTOK') }),
        story: custom?.TIKTOK?.story || new TikTokStoryCollector({ cookie: this.getCookie('TIKTOK') }),
      },
      INSTAGRAM: {
        live: custom?.INSTAGRAM?.live || new InstagramLiveCollector({ cookie: this.getCookie('INSTAGRAM') }),
        post: custom?.INSTAGRAM?.post || new InstagramPostCollector({ cookie: this.getCookie('INSTAGRAM') }),
        story: custom?.INSTAGRAM?.story || new InstagramStoryCollector({ cookie: this.getCookie('INSTAGRAM') }),
      },
      FACEBOOK: {
        live: custom?.FACEBOOK?.live || new FacebookLiveCollector({ cookie: this.getCookie('FACEBOOK') }),
        post: custom?.FACEBOOK?.post || new FacebookPostCollector({ cookie: this.getCookie('FACEBOOK') }),
        story: custom?.FACEBOOK?.story || new FacebookStoryCollector({ cookie: this.getCookie('FACEBOOK') }),
      },
      X: {
        live: custom?.X?.live || new XLiveCollector({ cookie: this.getCookie('X') }),
        post: custom?.X?.post || new XPostCollector({ cookie: this.getCookie('X') }),
        story: custom?.X?.story || new XStoryCollector({ cookie: this.getCookie('X') }),
      },
    };
  }

  isRunning(): boolean {
    return this.isRunningState;
  }

  getCookie(platform: LivePlatform): string {
    const p = platform.toLowerCase() as keyof PlatformCookies;
    const c = this.config.cookies?.[p];
    return typeof c === 'string' ? c.trim() : '';
  }

  setCookie(platform: LivePlatform, cookie: string): void {
    const val = typeof cookie === 'string' ? cookie.trim() : '';
    if (!this.config.cookies) {
      this.config.cookies = { tiktok: '', instagram: '', facebook: '', x: '' };
    }
    const p = platform.toLowerCase() as keyof PlatformCookies;
    this.config.cookies[p] = val;
    const cols = this.collectors[platform];
    if (cols) {
      for (const col of Object.values(cols)) {
        col.setCookie?.(val);
      }
    }
  }

  updateCookies(cookies: Partial<PlatformCookies>): void {
    for (const [p, val] of Object.entries(cookies)) {
      if (typeof val === 'string') {
        const plat = p.toUpperCase() as LivePlatform;
        if (ALL_PLATFORMS.includes(plat)) {
          this.setCookie(plat, val);
        }
      }
    }
  }

  setTargetUsers(users: string[]): void {
    if (!this.config.targetsByPlatform) {
      this.config.targetsByPlatform = { TIKTOK: [], INSTAGRAM: [], FACEBOOK: [], X: [] };
    }
    this.config.targetsByPlatform.TIKTOK = [...users];
  }

  setTargetsByPlatform(targets: Partial<Record<LivePlatform, string[]>>): void {
    if (!this.config.targetsByPlatform) {
      this.config.targetsByPlatform = { TIKTOK: [], INSTAGRAM: [], FACEBOOK: [], X: [] };
    }
    for (const p of ALL_PLATFORMS) {
      if (targets[p]) {
        this.config.targetsByPlatform[p] = [...(targets[p] || [])];
      }
    }
  }

  updateConfig(partial: Partial<MultiPlatformWatcherConfig> & Partial<WatcherConfig>): void {
    if (partial.targetsByPlatform) {
      this.setTargetsByPlatform(partial.targetsByPlatform);
    }
    if (Array.isArray(partial.targetUsers)) {
      this.setTargetUsers(partial.targetUsers);
    }
    if (partial.cookies) {
      this.updateCookies(partial.cookies);
    }
    if (typeof partial.tiktokSessionId === 'string') {
      this.setCookie('TIKTOK', partial.tiktokSessionId);
    }
    if (partial.platformSettings) {
      this.config.platformSettings = {
        ...this.config.platformSettings,
        ...partial.platformSettings,
      };
    }
    if (partial.enableWarmup !== undefined) {
      this.config.enableWarmup = partial.enableWarmup;
    }
    if (partial.autoDownloadMedia !== undefined) {
      this.config.autoDownloadMedia = partial.autoDownloadMedia;
    }
    if (partial.staggerRangeMs !== undefined) {
      this.config.staggerRangeMs = partial.staggerRangeMs;
    }
    if (partial.alertErrorThreshold !== undefined) {
      this.config.alertErrorThreshold = partial.alertErrorThreshold;
    }
    if (partial.alertCooldownSeconds !== undefined) {
      this.config.alertCooldownSeconds = partial.alertCooldownSeconds;
    }
    if (partial.webhookUrl !== undefined) {
      this.config.webhookUrl = partial.webhookUrl;
    }
    if (partial.androidCallbackUrl !== undefined) {
      this.config.androidCallbackUrl = partial.androidCallbackUrl;
    }
  }

  isEventEnabled(platform: LivePlatform, eventType: WatcherEventType): boolean {
    const pKey = platform.toLowerCase() as keyof MultiPlatformSettings;
    const pCfg = this.config.platformSettings?.[pKey];
    if (!pCfg) return true;
    if (eventType === 'live') return pCfg.liveEnabled !== false;
    if (eventType === 'post') return pCfg.postEnabled !== false;
    if (eventType === 'story') return pCfg.storyEnabled !== false;
    return true;
  }

  private recordDiagnostic(diag: TargetCollectorDiagnostic): void {
    const key = `${diag.platform}::${diag.username.toLowerCase()}::${diag.eventType}`;
    this.diagnosticsMap.set(key, diag);
  }

  getDiagnostics(): TargetCollectorDiagnostic[] {
    return Array.from(this.diagnosticsMap.values());
  }

  getPlatformsSummary(): Record<string, unknown> {
    const summary: Record<string, unknown> = {};
    for (const p of ALL_PLATFORMS) {
      const pKey = p.toLowerCase();
      const targets = this.config.targetsByPlatform?.[p] || [];
      const hasCookie = Boolean(this.getCookie(p));
      summary[pKey] = {
        platform: p,
        targetsCount: targets.length,
        targets,
        hasCookie,
        liveEnabled: this.isEventEnabled(p, 'live'),
        postEnabled: this.isEventEnabled(p, 'post'),
        storyEnabled: this.isEventEnabled(p, 'story'),
      };
    }
    return summary;
  }

  getWatchers(): MultiPlatformWatcher[] {
    return [this];
  }

  async runCycle(eventType: WatcherEventType): Promise<WatcherCycleReport> {
    const startTime = Date.now();
    const report: WatcherCycleReport = {
      eventType,
      targetsChecked: 0,
      newEventsFound: 0,
      notificationsDispatched: 0,
      warmedUpTargets: 0,
      errors: [],
      durationMs: 0,
    };

    const staggerRange = this.config.staggerRangeMs ?? [0, 0];

    for (const platform of ALL_PLATFORMS) {
      if (this.stopController?.signal.aborted) break;

      if (!this.isEventEnabled(platform, eventType)) {
        continue;
      }

      const targets = this.config.targetsByPlatform?.[platform] || [];
      if (targets.length === 0) {
        continue;
      }

      const collector = this.collectors[platform]?.[eventType];
      if (!collector) {
        continue;
      }

      const usedCookie = Boolean(this.getCookie(platform));

      // Check unsupported capabilities (e.g. X story)
      if (collector.supported === false) {
        for (const target of targets) {
          const username = normalizeUsername(target, platform) || target.replace(/^@+/, '');
          report.targetsChecked++;
          this.recordDiagnostic({
            platform,
            username,
            eventType,
            status: 'UNSUPPORTED',
            reason: `${platform} không hỗ trợ ${eventType}`,
            usedCookie,
            itemCount: 0,
            checkedAt: new Date().toISOString(),
          });
        }
        continue;
      }

      for (let i = 0; i < targets.length; i++) {
        if (this.stopController?.signal.aborted) break;

        const rawTarget = targets[i];
        const username = normalizeUsername(rawTarget, platform) || rawTarget.replace(/^@+/, '');
        if (!username) continue;

        report.targetsChecked++;

        if (i > 0 && staggerRange[1] > 0) {
          const staggerDelay = randomInRange(staggerRange[0], staggerRange[1]);
          await this.sleepOrAbort(staggerDelay);
          if (this.stopController?.signal.aborted) break;
        }

        try {
          let diagResult: CollectorFetchResult<WatcherEvent>;
          if (typeof collector.fetchWithDiagnostics === 'function') {
            diagResult = await collector.fetchWithDiagnostics(username);
          } else {
            const events = await collector.fetch(username);
            diagResult = {
              status: 'OK',
              events,
              usedCookie,
            };
          }

          if (diagResult.status !== 'OK') {
            this.recordDiagnostic({
              platform,
              username,
              eventType,
              status: diagResult.status,
              reason: diagResult.reason,
              httpStatus: diagResult.httpStatus,
              usedCookie: Boolean(diagResult.usedCookie ?? usedCookie),
              itemCount: 0,
              checkedAt: new Date().toISOString(),
            });

            report.errors.push({
              username: `${platform}:${username}`,
              error: diagResult.reason || diagResult.status,
            });

            // Isolate errors - only record failure on unexpected HTTP/network errors
            if (diagResult.status === 'ERROR' || diagResult.status === 'RATE_LIMITED') {
              const threshold = this.config.alertErrorThreshold ?? 5;
              const cooldown = (this.config.alertCooldownSeconds ?? 3600) * 1000;
              const { triggerAlert, consecutiveErrors } = await this.stateStore.recordFailure(
                collector.name,
                diagResult.reason || diagResult.status,
                threshold,
                cooldown
              );
              if (triggerAlert) {
                await this.notifier
                  .sendSystemAlert(collector.name, diagResult.reason || diagResult.status, consecutiveErrors)
                  .catch(() => {});
              }
            }
            continue;
          }

          // Status is OK
          const events = diagResult.events || [];
          const initialized = await this.stateStore.isInitialized(platform, username, eventType);

          // Warmup logic: stories must not be suppressed by warmup, posts/live are baseline-suppressed
          if (!initialized && this.config.enableWarmup !== false && eventType !== 'story') {
            await this.stateStore.warmupUser(
              platform,
              username,
              eventType,
              events.map((e) => ({ itemId: e.itemId, title: e.title, url: e.url }))
            );
            report.warmedUpTargets++;
            await this.stateStore.recordSuccess(collector.name);
            this.recordDiagnostic({
              platform,
              username,
              eventType,
              status: 'WARMED_UP',
              usedCookie: Boolean(diagResult.usedCookie ?? usedCookie),
              itemCount: events.length,
              checkedAt: new Date().toISOString(),
            });
            continue;
          }

          await this.stateStore.recordSuccess(collector.name);
          this.recordDiagnostic({
            platform,
            username,
            eventType,
            status: 'OK',
            usedCookie: Boolean(diagResult.usedCookie ?? usedCookie),
            itemCount: events.length,
            checkedAt: new Date().toISOString(),
          });

          for (const event of events) {
            event.platform = platform;
            const isNew = await this.stateStore.isNewAndMark(
              platform,
              username,
              eventType,
              event.itemId,
              { title: event.title, url: event.url }
            );

            if (isNew) {
              report.newEventsFound++;

              if (
                (eventType === 'post' || eventType === 'story') &&
                this.config.autoDownloadMedia !== false
              ) {
                try {
                  const downloadResult = await this.mediaDownloader.downloadEventMedia(event);
                  event.metadata = {
                    ...event.metadata,
                    downloadedMedia: downloadResult,
                  };
                } catch (dlErr) {
                  console.warn(
                    `[MultiPlatformWatcher] Failed to download media for ${platform}:${username} ${eventType} ${event.itemId}:`,
                    dlErr
                  );
                }
              }

              const notifResult = await this.notifier.notify(event);
              if (notifResult.status === 'delivered') {
                report.notificationsDispatched++;
              }
            }
          }
        } catch (targetErr) {
          const errMsg = targetErr instanceof Error ? targetErr.message : String(targetErr);
          this.recordDiagnostic({
            platform,
            username,
            eventType,
            status: 'ERROR',
            reason: errMsg,
            usedCookie,
            itemCount: 0,
            checkedAt: new Date().toISOString(),
          });

          report.errors.push({ username: `${platform}:${username}`, error: errMsg });

          const threshold = this.config.alertErrorThreshold ?? 5;
          const cooldown = (this.config.alertCooldownSeconds ?? 3600) * 1000;
          const { triggerAlert, consecutiveErrors } = await this.stateStore.recordFailure(
            collector.name,
            errMsg,
            threshold,
            cooldown
          );
          if (triggerAlert) {
            await this.notifier.sendSystemAlert(collector.name, errMsg, consecutiveErrors).catch(() => {});
          }
        }
      }
    }

    if (eventType === 'story') {
      await this.stateStore.pruneExpiredStories(48).catch(() => {});
    }

    report.durationMs = Date.now() - startTime;
    this.lastReports[eventType] = report;
    return report;
  }

  start(): void {
    if (this.isRunningState) return;
    this.isRunningState = true;
    this.stopController = new AbortController();

    const eventTypes: WatcherEventType[] = ['live', 'post', 'story'];
    this.activeLoops = eventTypes.map((eventType) =>
      this.runPeriodicLoop(eventType, this.stopController!.signal)
    );
  }

  async stop(): Promise<void> {
    if (!this.isRunningState) return;
    this.isRunningState = false;
    this.stopController?.abort();
    await Promise.allSettled(this.activeLoops);
    this.activeLoops = [];
    this.stopController = null;
  }

  private async runPeriodicLoop(eventType: WatcherEventType, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.runCycle(eventType);
      } catch (err) {
        console.error(`[MultiPlatformWatcher] Cycle unhandled error (${eventType}):`, err);
      }

      if (signal.aborted) break;

      const intervalSec = this.resolveInterval(eventType);
      await this.sleepOrAbort(intervalSec * 1000);
    }
  }

  private resolveInterval(eventType: WatcherEventType): number {
    const defaults = { live: 60, post: 240, story: 360 };
    return defaults[eventType] ?? 120;
  }

  private async sleepOrAbort(ms: number): Promise<void> {
    if (ms <= 0) return;
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.stopController?.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
    });
  }
}
