import {
  isLiveUserTarget,
  parseSourceMeta,
  parseTrackedTargets,
  type KeywordRuleItem,
  type LivePlatform,
  type SocialPlatform,
} from '../src/utils/scannerEngine';
import { checkBatchLive, type BatchLiveTarget, type PlatformCookies } from './liveCheckers/index';
import type { AndroidClient, AndroidRecordRequest } from './androidClient';
import {
  canonicalizeUsername,
  makeCanonicalKey,
  normalizePlatformForRuleTarget,
} from './reconcile';
import type {
  AndroidDispatchLog,
  ServerLiveStatusRecord,
  StateStore,
} from './stateStore';

export interface AutoScannerStatus {
  enabled: boolean;
  running: boolean;
  scanning: boolean;
  pollIntervalSeconds: number;
  lastScanAt: string | null;
  activeLiveCount: number;
  lastDispatchError: string | null;
}

export interface ScanCycleResult {
  scannedAt: string;
  durationMs: number;
  targetsChecked: number;
  liveCount: number;
  dispatchedCount: number;
  skippedDeduplicatedCount: number;
  failedDispatchCount: number;
}

export interface AutoScannerOptions {
  stateStore: StateStore;
  androidClient: AndroidClient;
  enabled?: boolean;
  intervalMsOverride?: number;
  initialDelayMs?: number;
  staggerMs?: number;
  liveCheckBatchFn?: typeof checkBatchLive;
  envCookies?: PlatformCookies;
}

export interface AutoScanner {
  start: () => void;
  stop: () => Promise<void>;
  setEnabled: (enabled: boolean) => void;
  isEnabled: () => boolean;
  isRunning: () => boolean;
  isScanning: () => boolean;
  runOnce: () => Promise<ScanCycleResult>;
  getStatus: () => Promise<AutoScannerStatus>;
}

interface ScanJob {
  canonicalKey: string;
  canonicalUsername: string;
  rule: KeywordRuleItem;
  sourceDomain: string;
  excludedTerms: string[];
  target: string;
  livePlatform: LivePlatform;
}

export function createAutoScanner(options: AutoScannerOptions): AutoScanner {
  const {
    stateStore,
    androidClient,
    intervalMsOverride,
    initialDelayMs = 1000,
    staggerMs = 250,
    liveCheckBatchFn = checkBatchLive,
    envCookies,
  } = options;

  let enabled = options.enabled ?? process.env.AUTO_SCAN_ENABLED !== 'false';
  let loopActive = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlightPromise: Promise<ScanCycleResult> | null = null;

  function scheduleNext(delayMs: number): void {
    if (!enabled || stopped) {
      loopActive = false;
      return;
    }
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, Math.max(0, delayMs));
  }

  async function tick(): Promise<void> {
    if (!enabled || stopped) {
      loopActive = false;
      return;
    }
    try {
      await runOnce();
    } catch {
      // Never crash the autonomous scanner loop on unexpected cycle errors
    } finally {
      if (enabled && !stopped) {
        let nextDelayMs = intervalMsOverride;
        if (nextDelayMs === undefined) {
          try {
            const ws = await stateStore.readWorkspaceState();
            const seconds = Math.max(10, ws.scannerSettings?.pollIntervalSeconds ?? 30);
            nextDelayMs = seconds * 1000;
          } catch {
            nextDelayMs = 30_000;
          }
        }
        scheduleNext(nextDelayMs);
      } else {
        loopActive = false;
      }
    }
  }

  async function executeScanCycle(): Promise<ScanCycleResult> {
    const startMs = Date.now();
    const ws = await stateStore.readWorkspaceState();

    const cookies: PlatformCookies = {
      tiktok: ws.scannerSettings?.cookies?.tiktok || envCookies?.tiktok || process.env.TIKTOK_COOKIE || '',
      instagram:
        ws.scannerSettings?.cookies?.instagram || envCookies?.instagram || process.env.INSTAGRAM_COOKIE || '',
      facebook:
        ws.scannerSettings?.cookies?.facebook || envCookies?.facebook || process.env.FACEBOOK_COOKIE || '',
      x: ws.scannerSettings?.cookies?.x || envCookies?.x || process.env.X_COOKIE || '',
    };

    const jobsByKey = new Map<string, ScanJob>();
    for (const rule of ws.rules) {
      if (!rule || !rule.enabled) continue;
      const platforms = String(rule.platforms || 'reddit')
        .split(',')
        .map(p => p.trim().toLowerCase() as SocialPlatform)
        .filter(Boolean);
      const primarySocial = platforms[0] || 'reddit';
      const { sourceDomain, excludedTerms } = parseSourceMeta(
        String(rule.excludedKeywords || ''),
        primarySocial
      );
      const targets = parseTrackedTargets(String(rule.keyword || ''));

      for (const target of targets) {
        if (!isLiveUserTarget(target)) continue;
        const livePlatform = normalizePlatformForRuleTarget(
          target,
          String(rule.platforms || 'reddit'),
          sourceDomain
        );
        const canonicalUsername = canonicalizeUsername(target, livePlatform);
        if (!canonicalUsername) continue;
        const canonicalKey = makeCanonicalKey(livePlatform, canonicalUsername);

        if (!jobsByKey.has(canonicalKey)) {
          jobsByKey.set(canonicalKey, {
            canonicalKey,
            canonicalUsername,
            rule,
            sourceDomain,
            excludedTerms,
            target: target.trim(),
            livePlatform,
          });
        }
      }
    }

    const jobs = Array.from(jobsByKey.values());
    if (jobs.length === 0) {
      const finishedIso = new Date().toISOString();
      const durationMs = Math.max(1, Date.now() - startMs);
      await stateStore.updateAndroidState(draft => {
        draft.liveStatusMap = {};
        draft.activeSessions = {};
        draft.scannerRuntime.lastScanAt = finishedIso;
        draft.scannerRuntime.lastScanDurationMs = durationMs;
      });
      return {
        scannedAt: finishedIso,
        durationMs,
        targetsChecked: 0,
        liveCount: 0,
        dispatchedCount: 0,
        skippedDeduplicatedCount: 0,
        failedDispatchCount: 0,
      };
    }

    const batchInputs: BatchLiveTarget[] = jobs.map(j => ({
      target: j.target,
      platform: j.livePlatform,
      sourceDomain: j.sourceDomain,
      ruleId: j.rule.id,
    }));

    const batchResults = await liveCheckBatchFn(batchInputs, cookies, staggerMs);
    const deduplicateLive = ws.scannerSettings?.deduplicateLive ?? true;

    interface DispatchCandidate {
      canonicalKey: string;
      streamUrl: string;
      payload: AndroidRecordRequest;
    }

    const candidates: DispatchCandidate[] = [];
    let liveCount = 0;
    let skippedDeduplicatedCount = 0;

    // First atomic state update: update liveStatusMap, clear NOT_LIVE activeSessions, prune disabled/removed rules, identify candidates
    const updatedState = await stateStore.updateAndroidState(draft => {
      const nextLiveStatusMap: Record<string, ServerLiveStatusRecord> = {};

      for (const activeKey of Object.keys(draft.activeSessions)) {
        if (!jobsByKey.has(activeKey)) {
          delete draft.activeSessions[activeKey];
        }
      }
      for (const statusKey of Object.keys(draft.liveStatusMap)) {
        if (!jobsByKey.has(statusKey)) {
          delete draft.liveStatusMap[statusKey];
        }
      }

      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        const item = batchResults[i];
        if (!item) continue;
        const res = item.result;
        const checkedAt = res.checkedAt || new Date().toISOString();

        if (res.status === 'NOT_LIVE') {
          delete draft.activeSessions[job.canonicalKey];
          nextLiveStatusMap[job.canonicalKey] = {
            canonicalKey: job.canonicalKey,
            ruleId: job.rule.id,
            target: job.target,
            platform: res.platform,
            username: job.canonicalUsername,
            status: 'NOT_LIVE',
            sourceUrl: res.sourceUrl,
            checkedAt,
          };
          continue;
        }

        if (res.status === 'ERROR') {
          nextLiveStatusMap[job.canonicalKey] = {
            canonicalKey: job.canonicalKey,
            ruleId: job.rule.id,
            target: job.target,
            platform: res.platform,
            username: job.canonicalUsername,
            status: 'ERROR',
            sourceUrl: res.sourceUrl,
            error: res.message,
            checkedAt,
          };
          continue;
        }

        // res.status === 'LIVE'
        liveCount += 1;
        nextLiveStatusMap[job.canonicalKey] = {
          canonicalKey: job.canonicalKey,
          ruleId: job.rule.id,
          target: job.target,
          platform: res.platform,
          username: job.canonicalUsername,
          status: 'LIVE',
          title: res.title,
          streamUrl: res.streamUrl,
          sourceUrl: res.sourceUrl,
          qualityInfo: res.qualityInfo,
          method: res.method,
          checkedAt,
        };

        const lowerTitle = `${res.title || ''} ${res.username || ''}`.toLowerCase();
        const isExcluded = job.excludedTerms.some(neg => neg && lowerTitle.includes(neg));
        if (isExcluded) continue;

        const hasActiveSession = draft.activeSessions[job.canonicalKey] !== undefined;
        const androidReportedStatus = draft.reportedUsers[job.canonicalKey]?.status;
        const isAndroidBusy =
          androidReportedStatus === 'RECORDING' || androidReportedStatus === 'UPLOADING';

        if ((deduplicateLive && hasActiveSession) || isAndroidBusy) {
          skippedDeduplicatedCount += 1;
          continue;
        }

        if (!res.streamUrl || !res.streamUrl.trim()) {
          continue;
        }

        candidates.push({
          canonicalKey: job.canonicalKey,
          streamUrl: res.streamUrl.trim(),
          payload: {
            eventId: `evt_${Math.floor(Date.now() / 1000)}_${job.canonicalUsername}`,
            platform: res.platform,
            username: job.canonicalUsername,
            usernameOrUrl: job.target,
            streamUrl: res.streamUrl.trim(),
            title: res.title || `${res.platform} Live (@${job.canonicalUsername})`,
            sourceUrl: res.sourceUrl,
            ...(res.qualityInfo ? { qualityInfo: res.qualityInfo } : {}),
            ruleId: job.rule.id,
            detectedAt: checkedAt,
          },
        });
      }

      draft.liveStatusMap = nextLiveStatusMap;
      draft.scannerRuntime.lastScanAt = new Date().toISOString();
      draft.scannerRuntime.lastScanDurationMs = Math.max(1, Date.now() - startMs);
    });

    let dispatchedCount = 0;
    let failedDispatchCount = 0;

    if (candidates.length > 0 && updatedState.device) {
      for (const candidate of candidates) {
        // Re-read latest Android device registration before each dispatch in case IP changed mid-scan
        const latestState = await stateStore.readAndroidState();
        const device = latestState.device;
        if (!device || !device.ip || !device.port) {
          break;
        }

        const dispatchRes = await androidClient.dispatchRecord(device, candidate.payload);
        const nowIso = new Date().toISOString();

        const logEntry: AndroidDispatchLog = {
          eventId: candidate.payload.eventId,
          canonicalKey: candidate.canonicalKey,
          platform: candidate.payload.platform,
          username: candidate.payload.username,
          streamUrl: candidate.streamUrl,
          callbackUrl: dispatchRes.callbackUrl,
          dispatchedAt: nowIso,
          ok: dispatchRes.ok,
          httpStatus: dispatchRes.httpStatus,
          androidStatus: dispatchRes.androidStatus,
          error: dispatchRes.error,
          attempts: dispatchRes.attempts,
        };

        if (dispatchRes.ok) {
          dispatchedCount += 1;
        } else {
          failedDispatchCount += 1;
        }

        await stateStore.updateAndroidState(draft => {
          draft.recentDispatches.unshift(logEntry);
          if (draft.recentDispatches.length > 50) {
            draft.recentDispatches.length = 50;
          }
          draft.scannerRuntime.lastDispatchAt = nowIso;
          if (dispatchRes.ok) {
            draft.activeSessions[candidate.canonicalKey] = candidate.streamUrl;
            draft.scannerRuntime.lastDispatchError = null;
          } else {
            // Do NOT record activeSessions on failure so the next cycle retries
            draft.scannerRuntime.lastDispatchError = dispatchRes.error;
          }
        });
      }
    }

    const finishedIso = new Date().toISOString();
    return {
      scannedAt: finishedIso,
      durationMs: Math.max(1, Date.now() - startMs),
      targetsChecked: jobs.length,
      liveCount,
      dispatchedCount,
      skippedDeduplicatedCount,
      failedDispatchCount,
    };
  }

  async function runOnce(): Promise<ScanCycleResult> {
    if (inFlightPromise) {
      return inFlightPromise;
    }
    const promise = executeScanCycle().finally(() => {
      if (inFlightPromise === promise) {
        inFlightPromise = null;
      }
    });
    inFlightPromise = promise;
    return promise;
  }

  return {
    start(): void {
      stopped = false;
      enabled = true;
      if (loopActive) return;
      loopActive = true;
      scheduleNext(initialDelayMs);
    },

    async stop(): Promise<void> {
      stopped = true;
      enabled = false;
      loopActive = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (inFlightPromise) {
        await inFlightPromise.catch(() => {});
      }
    },

    setEnabled(nextEnabled: boolean): void {
      enabled = nextEnabled;
      if (!enabled) {
        loopActive = false;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      } else if (!loopActive) {
        stopped = false;
        loopActive = true;
        scheduleNext(initialDelayMs);
      }
    },

    isEnabled(): boolean {
      return enabled;
    },

    isRunning(): boolean {
      return (enabled && !stopped && loopActive) || inFlightPromise !== null;
    },

    isScanning(): boolean {
      return inFlightPromise !== null;
    },

    runOnce,

    async getStatus(): Promise<AutoScannerStatus> {
      const [ws, androidState] = await Promise.all([
        stateStore.readWorkspaceState(),
        stateStore.readAndroidState(),
      ]);
      const activeLiveCount = Object.values(androidState.liveStatusMap).filter(
        entry => entry.status === 'LIVE'
      ).length;

      return {
        enabled,
        running: (enabled && !stopped && loopActive) || inFlightPromise !== null,
        scanning: inFlightPromise !== null,
        pollIntervalSeconds: ws.scannerSettings?.pollIntervalSeconds ?? 30,
        lastScanAt: androidState.scannerRuntime.lastScanAt,
        activeLiveCount,
        lastDispatchError: androidState.scannerRuntime.lastDispatchError,
      };
    },
  };
}
