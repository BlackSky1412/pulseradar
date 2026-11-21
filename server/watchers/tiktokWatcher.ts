import { BaseCollector } from './collectors/base';
import { TikTokLiveCollector } from './collectors/tiktokLive';
import { TikTokPostCollector } from './collectors/tiktokPost';
import { TikTokStoryCollector } from './collectors/tiktokStory';
import { Notifier } from './notifier';
import { createWatcherStateStore, WatcherStateStore } from './stateStore';
import { createMediaDownloader, MediaDownloader } from '../mediaDownloader';
import type {
  CollectorHealthRecord,
  NotificationResult,
  TikTokEvent,
  WatcherConfig,
  WatcherEventType,
} from './types';

export interface WatcherCycleReport {
  eventType: WatcherEventType;
  targetsChecked: number;
  newEventsFound: number;
  notificationsDispatched: number;
  warmedUpTargets: number;
  errors: Array<{ username: string; error: string }>;
  durationMs: number;
}

export interface WatcherStatusReport {
  isRunning: boolean;
  targetUsers: string[];
  intervals: {
    live: number;
    post: number;
    story: number;
  };
  health: Record<string, CollectorHealthRecord>;
  lastReports: Record<WatcherEventType, WatcherCycleReport | null>;
}

export interface TikTokWatcherOptions {
  config: WatcherConfig;
  stateStore?: WatcherStateStore;
  notifier?: Notifier;
  mediaDownloader?: MediaDownloader;
  liveCollector?: BaseCollector;
  postCollector?: BaseCollector;
  storyCollector?: BaseCollector;
}

function randomInRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export class TikTokWatcher {
  private config: WatcherConfig;
  private stateStore: WatcherStateStore;
  private notifier: Notifier;
  private mediaDownloader: MediaDownloader;

  private collectors: Record<WatcherEventType, BaseCollector>;
  private isRunningState = false;
  private stopController: AbortController | null = null;
  private activeLoops: Promise<void>[] = [];

  private lastReports: Record<WatcherEventType, WatcherCycleReport | null> = {
    live: null,
    post: null,
    story: null,
  };

  constructor(options: TikTokWatcherOptions) {
    this.config = {
      ...options.config,
      tiktokSessionId:
        typeof options.config.tiktokSessionId === 'string'
          ? options.config.tiktokSessionId.trim()
          : '',
    };
    this.stateStore = options.stateStore || createWatcherStateStore();
    this.mediaDownloader =
      options.mediaDownloader ||
      createMediaDownloader({ storageRoot: this.config.driveStorageRoot });
    this.notifier =
      options.notifier ||
      new Notifier({
        webhookUrl: this.config.webhookUrl,
        androidCallbackUrl: this.config.androidCallbackUrl,
      });

    this.collectors = {
      live:
        options.liveCollector ||
        new TikTokLiveCollector({
          cookie: this.config.tiktokSessionId,
        }),
      post:
        options.postCollector ||
        new TikTokPostCollector({
          cookie: this.config.tiktokSessionId,
        }),
      story:
        options.storyCollector ||
        new TikTokStoryCollector({
          cookie: this.config.tiktokSessionId,
        }),
    };
  }

  isRunning(): boolean {
    return this.isRunningState;
  }

  setTargetUsers(users: string[]): void {
    this.config.targetUsers = [...users];
  }

  updateConfig(partial: Partial<WatcherConfig>): void {
    this.config = { ...this.config, ...partial };
    if ('tiktokSessionId' in partial) {
      const nextCookie =
        typeof partial.tiktokSessionId === 'string' ? partial.tiktokSessionId.trim() : '';
      this.config.tiktokSessionId = nextCookie;
      for (const collector of Object.values(this.collectors)) {
        collector.setCookie?.(nextCookie);
      }
    }
  }

  async runCycle(eventType: WatcherEventType): Promise<WatcherCycleReport> {
    const startTime = Date.now();
    const collector = this.collectors[eventType];
    const targets = this.config.targetUsers || [];
    const report: WatcherCycleReport = {
      eventType,
      targetsChecked: 0,
      newEventsFound: 0,
      notificationsDispatched: 0,
      warmedUpTargets: 0,
      errors: [],
      durationMs: 0,
    };

    if (!collector || targets.length === 0) {
      report.durationMs = Date.now() - startTime;
      this.lastReports[eventType] = report;
      return report;
    }

    const staggerRange = this.config.staggerRangeMs ?? [1500, 4000];

    for (let i = 0; i < targets.length; i++) {
      if (this.stopController?.signal.aborted) {
        break;
      }

      const username = targets[i];
      report.targetsChecked++;

      // Stagger inter-target calls
      if (i > 0 && staggerRange[1] > 0) {
        const staggerDelay = randomInRange(staggerRange[0], staggerRange[1]);
        await this.sleepOrAbort(staggerDelay);
        if (this.stopController?.signal.aborted) break;
      }

      try {
        const initialized = await this.stateStore.isInitialized('TIKTOK', username, eventType);

        // First-run warmup: sync current baseline without dispatching alerts
        // Stories only last 24h, so active stories should be captured immediately rather than suppressed.
        if (!initialized && this.config.enableWarmup !== false && eventType !== 'story') {
          const baselineItems = await collector.fetch(username);
          await this.stateStore.warmupUser(
            'TIKTOK',
            username,
            eventType,
            baselineItems.map((e) => ({ itemId: e.itemId, title: e.title, url: e.url }))
          );
          report.warmedUpTargets++;
          await this.stateStore.recordSuccess(collector.name);
          continue;
        }

        // Target already initialized: detect new items and notify
        const currentItems = await collector.fetch(username);
        await this.stateStore.recordSuccess(collector.name);

        for (const event of currentItems) {
          const isNew = await this.stateStore.isNewAndMark(
            'TIKTOK',
            username,
            eventType,
            event.itemId,
            { title: event.title, url: event.url }
          );

          if (isNew) {
            report.newEventsFound++;

            // Auto-download media for new Post or Story events into Google Drive folder
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
                  `[TikTokWatcher] Failed to auto-download media for @${username} ${eventType} ${event.itemId}:`,
                  dlErr
                );
              }
            }

            const notifResult: NotificationResult = await this.notifier.notify(event);
            if (notifResult.status === 'delivered') {
              report.notificationsDispatched++;
            }
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        report.errors.push({ username, error: errMsg });

        // Health tracking & system alert threshold
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

    // Retention cleanup for stories
    if (eventType === 'story') {
      await this.stateStore.pruneExpiredStories(48).catch(() => {});
    }

    report.durationMs = Date.now() - startTime;
    this.lastReports[eventType] = report;
    return report;
  }

  start(): void {
    if (this.isRunningState) {
      return;
    }

    this.isRunningState = true;
    this.stopController = new AbortController();

    const loopTypes: WatcherEventType[] = ['live', 'post', 'story'];
    this.activeLoops = loopTypes.map((type) => this.runLoop(type));
  }

  async stop(): Promise<void> {
    if (!this.isRunningState) {
      return;
    }

    this.isRunningState = false;
    this.stopController?.abort();

    await Promise.allSettled(this.activeLoops);
    this.activeLoops = [];
    this.stopController = null;
    await this.stateStore.flush();
  }

  async getStatus(): Promise<WatcherStatusReport> {
    const health = await this.stateStore.getHealthStatus();
    return {
      isRunning: this.isRunningState,
      targetUsers: [...(this.config.targetUsers || [])],
      intervals: {
        live: this.config.liveIntervalSeconds ?? 60,
        post: this.config.postIntervalSeconds ?? 240,
        story: this.config.storyIntervalSeconds ?? 360,
      },
      health,
      lastReports: { ...this.lastReports },
    };
  }

  private async runLoop(eventType: WatcherEventType): Promise<void> {
    const baseIntervalSec =
      eventType === 'live'
        ? this.config.liveIntervalSeconds ?? 60
        : eventType === 'post'
        ? this.config.postIntervalSeconds ?? 240
        : this.config.storyIntervalSeconds ?? 360;

    while (this.isRunningState && !this.stopController?.signal.aborted) {
      try {
        await this.runCycle(eventType);
      } catch (err) {
        console.error(`[TikTokWatcher] Unexpected error in ${eventType} cycle:`, err);
      }

      if (!this.isRunningState || this.stopController?.signal.aborted) {
        break;
      }

      // Add 10-20% random jitter to interval sleep
      const jitterFactor = 1 + randomInRange(0.1, 0.2);
      const sleepDurationMs = baseIntervalSec * 1000 * jitterFactor;

      await this.sleepOrAbort(sleepDurationMs);
    }
  }

  private sleepOrAbort(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const signal = this.stopController?.signal;
      if (signal?.aborted) {
        resolve();
        return;
      }

      let timer: NodeJS.Timeout | null = null;
      const onAbort = () => {
        if (timer) clearTimeout(timer);
        resolve();
      };

      timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);

      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

