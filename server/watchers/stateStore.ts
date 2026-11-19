import fs from 'node:fs';
import path from 'node:path';
import type {
  CollectorHealthRecord,
  SeenEventRecord,
  TrackedUserRecord,
  WatcherEventType,
  WatcherState,
} from './types';

const RETRYABLE_FS_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_RETRY_DELAYS_MS = [20, 40, 80, 160, 320];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createDefaultWatcherState(): WatcherState {
  return {
    seenEvents: {},
    trackedUsers: {},
    collectorHealth: {},
    updatedAt: new Date(0).toISOString(),
  };
}

function normalizeWatcherState(raw: unknown): WatcherState {
  const def = createDefaultWatcherState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return def;
  }
  const obj = raw as Partial<WatcherState>;
  return {
    seenEvents:
      obj.seenEvents && typeof obj.seenEvents === 'object' && !Array.isArray(obj.seenEvents)
        ? (obj.seenEvents as Record<string, SeenEventRecord>)
        : {},
    trackedUsers:
      obj.trackedUsers && typeof obj.trackedUsers === 'object' && !Array.isArray(obj.trackedUsers)
        ? (obj.trackedUsers as Record<string, TrackedUserRecord>)
        : {},
    collectorHealth:
      obj.collectorHealth && typeof obj.collectorHealth === 'object' && !Array.isArray(obj.collectorHealth)
        ? (obj.collectorHealth as Record<string, CollectorHealthRecord>)
        : {},
    updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : def.updatedAt,
  };
}

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  const payload = JSON.stringify(data, null, 2);

  try {
    await fs.promises.writeFile(tmpPath, payload, 'utf-8');
    let attempt = 0;
    while (true) {
      try {
        await fs.promises.rename(tmpPath, filePath);
        return;
      } catch (err) {
        const code = (err as { code?: string } | null)?.code;
        if (code && RETRYABLE_FS_CODES.has(code) && attempt < RENAME_RETRY_DELAYS_MS.length) {
          await sleep(RENAME_RETRY_DELAYS_MS[attempt]);
          attempt += 1;
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    await fs.promises.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

async function readJsonFileIfExists(filePath: string): Promise<unknown | null> {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

export function buildSeenEventKey(
  platform: string,
  username: string,
  eventType: string,
  itemId: string
): string {
  return `${platform.trim().toUpperCase()}::${username.trim().toLowerCase()}::${eventType
    .trim()
    .toLowerCase()}::${itemId.trim()}`;
}

export function buildTrackedUserKey(
  platform: string,
  username: string,
  eventType: string
): string {
  return `${platform.trim().toUpperCase()}::${username.trim().toLowerCase()}::${eventType
    .trim()
    .toLowerCase()}`;
}

export interface WatcherStateStore {
  readonly filePath: string;
  isInitialized(platform: string, username: string, eventType: string): Promise<boolean>;
  markInitialized(platform: string, username: string, eventType: string): Promise<void>;
  warmupUser(
    platform: string,
    username: string,
    eventType: string,
    items: Array<{ itemId: string; title?: string; url?: string }>
  ): Promise<void>;
  isNewAndMark(
    platform: string,
    username: string,
    eventType: string,
    itemId: string,
    extra?: { title?: string; url?: string }
  ): Promise<boolean>;
  recordSuccess(collectorName: string): Promise<void>;
  recordFailure(
    collectorName: string,
    error: string,
    alertThreshold?: number,
    cooldownMs?: number
  ): Promise<{ triggerAlert: boolean; consecutiveErrors: number }>;
  getHealthStatus(): Promise<Record<string, CollectorHealthRecord>>;
  pruneExpiredStories(maxAgeHours?: number): Promise<number>;
  getState(): Promise<WatcherState>;
  clear(): Promise<void>;
  flush(): Promise<void>;
}

export function createWatcherStateStore(filePath?: string): WatcherStateStore {
  const resolvedPath = path.resolve(filePath || path.join('data', 'watcher-state.json'));
  const queues = new Map<string, Promise<unknown>>();

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const key = resolvedPath;
    const prev = queues.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(task);
    const tracked = next.catch(() => {});
    queues.set(key, tracked);
    tracked.finally(() => {
      if (queues.get(key) === tracked) {
        queues.delete(key);
      }
    });
    return next;
  }

  async function loadState(): Promise<WatcherState> {
    const raw = await readJsonFileIfExists(resolvedPath);
    return normalizeWatcherState(raw);
  }

  return {
    filePath: resolvedPath,

    isInitialized(platform: string, username: string, eventType: string): Promise<boolean> {
      return enqueue(async () => {
        const state = await loadState();
        const userKey = buildTrackedUserKey(platform, username, eventType);
        return Boolean(state.trackedUsers[userKey]);
      });
    },

    markInitialized(platform: string, username: string, eventType: string): Promise<void> {
      return enqueue(async () => {
        const state = await loadState();
        const userKey = buildTrackedUserKey(platform, username, eventType);
        state.trackedUsers[userKey] = {
          platform: platform.trim().toUpperCase(),
          username: username.trim().toLowerCase(),
          eventType: eventType.trim().toLowerCase() as WatcherEventType,
          initializedAt: new Date().toISOString(),
        };
        state.updatedAt = new Date().toISOString();
        await atomicWriteJson(resolvedPath, state);
      });
    },

    warmupUser(
      platform: string,
      username: string,
      eventType: string,
      items: Array<{ itemId: string; title?: string; url?: string }>
    ): Promise<void> {
      return enqueue(async () => {
        const state = await loadState();
        const userKey = buildTrackedUserKey(platform, username, eventType);
        const normPlatform = platform.trim().toUpperCase();
        const normUsername = username.trim().toLowerCase();
        const normEventType = eventType.trim().toLowerCase() as WatcherEventType;
        const now = new Date().toISOString();

        for (const item of items) {
          if (!item.itemId) continue;
          const seenKey = buildSeenEventKey(normPlatform, normUsername, normEventType, item.itemId);
          if (!state.seenEvents[seenKey]) {
            state.seenEvents[seenKey] = {
              platform: normPlatform,
              username: normUsername,
              eventType: normEventType,
              itemId: item.itemId.trim(),
              createdAt: now,
              title: item.title,
              url: item.url,
            };
          }
        }

        state.trackedUsers[userKey] = {
          platform: normPlatform,
          username: normUsername,
          eventType: normEventType,
          initializedAt: now,
        };
        state.updatedAt = now;

        await atomicWriteJson(resolvedPath, state);
      });
    },

    isNewAndMark(
      platform: string,
      username: string,
      eventType: string,
      itemId: string,
      extra?: { title?: string; url?: string }
    ): Promise<boolean> {
      return enqueue(async () => {
        const state = await loadState();
        const normPlatform = platform.trim().toUpperCase();
        const normUsername = username.trim().toLowerCase();
        const normEventType = eventType.trim().toLowerCase() as WatcherEventType;
        const seenKey = buildSeenEventKey(normPlatform, normUsername, normEventType, itemId);

        if (state.seenEvents[seenKey]) {
          return false;
        }

        const now = new Date().toISOString();
        state.seenEvents[seenKey] = {
          platform: normPlatform,
          username: normUsername,
          eventType: normEventType,
          itemId: itemId.trim(),
          createdAt: now,
          title: extra?.title,
          url: extra?.url,
        };
        state.updatedAt = now;

        await atomicWriteJson(resolvedPath, state);
        return true;
      });
    },

    recordSuccess(collectorName: string): Promise<void> {
      return enqueue(async () => {
        const state = await loadState();
        const now = new Date().toISOString();
        const current = state.collectorHealth[collectorName];
        state.collectorHealth[collectorName] = {
          collectorName,
          consecutiveErrors: 0,
          lastErrorMessage: current?.lastErrorMessage ?? null,
          lastAlertSentAt: current?.lastAlertSentAt ?? null,
          lastSuccessAt: now,
          updatedAt: now,
        };
        state.updatedAt = now;
        await atomicWriteJson(resolvedPath, state);
      });
    },

    recordFailure(
      collectorName: string,
      error: string,
      alertThreshold: number = 5,
      cooldownMs: number = 3600000
    ): Promise<{ triggerAlert: boolean; consecutiveErrors: number }> {
      return enqueue(async () => {
        const state = await loadState();
        const now = new Date();
        const current = state.collectorHealth[collectorName];
        const consecutiveErrors = (current?.consecutiveErrors ?? 0) + 1;

        let triggerAlert = false;
        let lastAlertSentAt = current?.lastAlertSentAt ?? null;

        if (consecutiveErrors >= alertThreshold) {
          const lastAlertTimestamp = lastAlertSentAt ? new Date(lastAlertSentAt).getTime() : 0;
          if (now.getTime() - lastAlertTimestamp >= cooldownMs) {
            triggerAlert = true;
            lastAlertSentAt = now.toISOString();
          }
        }

        state.collectorHealth[collectorName] = {
          collectorName,
          consecutiveErrors,
          lastErrorMessage: error,
          lastAlertSentAt,
          lastSuccessAt: current?.lastSuccessAt ?? null,
          updatedAt: now.toISOString(),
        };
        state.updatedAt = now.toISOString();
        await atomicWriteJson(resolvedPath, state);

        return { triggerAlert, consecutiveErrors };
      });
    },

    getHealthStatus(): Promise<Record<string, CollectorHealthRecord>> {
      return enqueue(async () => {
        const state = await loadState();
        return { ...state.collectorHealth };
      });
    },

    pruneExpiredStories(maxAgeHours: number = 48): Promise<number> {
      return enqueue(async () => {
        const state = await loadState();
        const cutoffTime = Date.now() - maxAgeHours * 3600 * 1000;
        let prunedCount = 0;

        for (const [key, record] of Object.entries(state.seenEvents)) {
          if (record.eventType === 'story') {
            const createdAtTime = new Date(record.createdAt).getTime();
            if (!Number.isNaN(createdAtTime) && createdAtTime < cutoffTime) {
              delete state.seenEvents[key];
              prunedCount++;
            }
          }
        }

        if (prunedCount > 0) {
          state.updatedAt = new Date().toISOString();
          await atomicWriteJson(resolvedPath, state);
        }

        return prunedCount;
      });
    },

    getState(): Promise<WatcherState> {
      return enqueue(async () => {
        return loadState();
      });
    },

    clear(): Promise<void> {
      return enqueue(async () => {
        const empty = createDefaultWatcherState();
        await atomicWriteJson(resolvedPath, empty);
      });
    },

    async flush(): Promise<void> {
      while (queues.size > 0) {
        await Promise.allSettled(Array.from(queues.values()));
      }
    },
  };
}
