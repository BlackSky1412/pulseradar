import fs from 'node:fs';
import path from 'node:path';
import type {
  AlertDetectionItem,
  KeywordRuleItem,
  LivePlatform,
  PlatformCookies,
  WebhookServerItem,
} from '../src/utils/scannerEngine';
import type { PendingDeviceNotification } from './watchers/types';

export interface ScannerSettingsState {
  cookies: Required<PlatformCookies>;
  pollIntervalSeconds: number;
  deduplicateLive: boolean;
}

export interface WorkspaceState {
  rules: KeywordRuleItem[];
  servers: WebhookServerItem[];
  alerts: AlertDetectionItem[];
  scannerSettings: ScannerSettingsState;
  updatedAt: string;
}

export interface AndroidDeviceState {
  deviceId: string;
  ip: string;
  port: number;
  callbackUrl: string;
  appVersion: string;
  networkType: string;
  registeredAt: string;
  lastSeenAt: string;
  lastSyncAt: string | null;
}

export interface AndroidReportedUser {
  canonicalKey: string;
  platform: LivePlatform;
  username: string;
  usernameOrUrl: string;
  status: string;
  isEnabled: boolean;
  allowCellular: boolean;
  lastStreamUrl: string | null;
  lastCheckedTimestamp: number | null;
  reportedAt: string;
}

export interface ServerLiveStatusRecord {
  canonicalKey: string;
  ruleId: string;
  target: string;
  platform: LivePlatform;
  username: string;
  status: 'LIVE' | 'NOT_LIVE' | 'ERROR';
  title?: string;
  streamUrl?: string;
  sourceUrl: string;
  qualityInfo?: string;
  method?: string;
  error?: string;
  checkedAt: string;
}

export interface AndroidDispatchLog {
  eventId: string;
  canonicalKey: string;
  platform: LivePlatform;
  username: string;
  streamUrl: string;
  callbackUrl: string;
  dispatchedAt: string;
  ok: boolean;
  httpStatus: number;
  androidStatus?: string;
  error: string | null;
  attempts: number;
}

export interface AndroidScannerRuntime {
  lastScanAt: string | null;
  lastScanDurationMs: number | null;
  lastDispatchError: string | null;
  lastDispatchAt: string | null;
}

export interface PendingRecordCommand {
  commandId?: string;
  eventId: string;
  canonicalKey: string;
  platform: LivePlatform;
  username: string;
  usernameOrUrl: string;
  streamUrl: string;
  title: string;
  sourceUrl?: string;
  qualityInfo?: string;
  ruleId?: string;
  detectedAt?: string;
  queuedAt: string;
  deliveryAttempts?: number;
  lastDeliveredAt?: string | null;
}

export interface AndroidState {
  device: AndroidDeviceState | null;
  reportedUsers: Record<string, AndroidReportedUser>;
  liveStatusMap: Record<string, ServerLiveStatusRecord>;
  activeSessions: Record<string, string>;
  scannerRuntime: AndroidScannerRuntime;
  recentDispatches: AndroidDispatchLog[];
  pendingNotifications: PendingDeviceNotification[];
  pendingRecordCommands: PendingRecordCommand[];
  recentAckedCommandIds?: string[];
  allowedDeviceIds: string[];
  updatedAt: string;
}

export interface StateStore {
  dataDir: string;
  workspaceFile: string;
  androidFile: string;
  readWorkspaceState: () => Promise<WorkspaceState>;
  readWorkspaceStateIfExists: () => Promise<WorkspaceState | null>;
  writeWorkspaceState: (partialOrFull: Partial<WorkspaceState>) => Promise<WorkspaceState>;
  readAndroidState: () => Promise<AndroidState>;
  updateAndroidState: (mutator: (current: AndroidState) => AndroidState | void) => Promise<AndroidState>;
  flush: () => Promise<void>;
}

const RETRYABLE_FS_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_RETRY_DELAYS_MS = [20, 40, 80, 160, 320];

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function createDefaultWorkspaceState(): WorkspaceState {
  return {
    rules: [],
    servers: [],
    alerts: [],
    scannerSettings: {
      cookies: {
        tiktok: '',
        instagram: '',
        facebook: '',
        x: '',
      },
      pollIntervalSeconds: 30,
      deduplicateLive: true,
    },
    updatedAt: new Date(0).toISOString(),
  };
}

export function createDefaultAndroidState(): AndroidState {
  return {
    device: null,
    reportedUsers: {},
    liveStatusMap: {},
    activeSessions: {},
    scannerRuntime: {
      lastScanAt: null,
      lastScanDurationMs: null,
      lastDispatchError: null,
      lastDispatchAt: null,
    },
    recentDispatches: [],
    pendingNotifications: [],
    pendingRecordCommands: [],
    recentAckedCommandIds: [],
    allowedDeviceIds: process.env.ALLOWED_DEVICE_IDS
      ? process.env.ALLOWED_DEVICE_IDS.split(',').map(s => s.trim()).filter(Boolean)
      : ['*'],
    updatedAt: new Date(0).toISOString(),
  };
}

function normalizeScannerSettings(
  incoming?: Partial<ScannerSettingsState> | null,
  fallback?: ScannerSettingsState
): ScannerSettingsState {
  const base = fallback ?? createDefaultWorkspaceState().scannerSettings;
  const poll = incoming?.pollIntervalSeconds;
  return {
    cookies: {
      tiktok: typeof incoming?.cookies?.tiktok === 'string' ? incoming.cookies.tiktok : base.cookies.tiktok,
      instagram:
        typeof incoming?.cookies?.instagram === 'string'
          ? incoming.cookies.instagram
          : base.cookies.instagram,
      facebook:
        typeof incoming?.cookies?.facebook === 'string'
          ? incoming.cookies.facebook
          : base.cookies.facebook,
      x: typeof incoming?.cookies?.x === 'string' ? incoming.cookies.x : base.cookies.x,
    },
    pollIntervalSeconds: typeof poll === 'number' && Number.isFinite(poll) && poll >= 10 ? poll : base.pollIntervalSeconds,
    deduplicateLive:
      typeof incoming?.deduplicateLive === 'boolean' ? incoming.deduplicateLive : base.deduplicateLive,
  };
}

function normalizeWorkspaceState(raw: unknown): WorkspaceState {
  const def = createDefaultWorkspaceState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return def;
  }
  const obj = raw as Partial<WorkspaceState>;
  return {
    rules: Array.isArray(obj.rules) ? obj.rules : def.rules,
    servers: Array.isArray(obj.servers) ? obj.servers : def.servers,
    alerts: Array.isArray(obj.alerts) ? obj.alerts : def.alerts,
    scannerSettings: normalizeScannerSettings(obj.scannerSettings, def.scannerSettings),
    updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : def.updatedAt,
  };
}

export function normalizeAndroidState(raw: unknown): AndroidState {
  const def = createDefaultAndroidState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return def;
  }
  const obj = raw as Partial<AndroidState>;
  const normalizedCommands: PendingRecordCommand[] = Array.isArray(obj.pendingRecordCommands)
    ? obj.pendingRecordCommands
        .filter((item): item is PendingRecordCommand => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
        .slice(-100)
        .map(cmd => {
          const rawCmdId = typeof cmd.commandId === 'string' ? cmd.commandId.trim() : '';
          const rawEvtId = typeof cmd.eventId === 'string' ? cmd.eventId.trim() : '';
          const rawCanonical = typeof cmd.canonicalKey === 'string' ? cmd.canonicalKey.trim() : '';
          const commandId = rawCmdId || rawEvtId || `cmd_legacy_${rawCanonical || 'unknown'}`;
          const deliveryAttempts =
            typeof cmd.deliveryAttempts === 'number' &&
            Number.isFinite(cmd.deliveryAttempts) &&
            cmd.deliveryAttempts >= 0
              ? Math.floor(cmd.deliveryAttempts)
              : 0;
          const lastDeliveredAt =
            typeof cmd.lastDeliveredAt === 'string' && cmd.lastDeliveredAt.trim()
              ? cmd.lastDeliveredAt.trim()
              : null;

          return {
            ...cmd,
            commandId,
            deliveryAttempts,
            lastDeliveredAt,
          };
        })
    : [];

  const normalizedRecentAckedIds: string[] = Array.isArray(obj.recentAckedCommandIds)
    ? obj.recentAckedCommandIds
        .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
        .map(id => id.trim())
        .slice(-200)
    : [];

  return {
    device: obj.device && typeof obj.device === 'object' ? obj.device : null,
    reportedUsers:
      obj.reportedUsers && typeof obj.reportedUsers === 'object' && !Array.isArray(obj.reportedUsers)
        ? obj.reportedUsers
        : {},
    liveStatusMap:
      obj.liveStatusMap && typeof obj.liveStatusMap === 'object' && !Array.isArray(obj.liveStatusMap)
        ? obj.liveStatusMap
        : {},
    activeSessions:
      obj.activeSessions && typeof obj.activeSessions === 'object' && !Array.isArray(obj.activeSessions)
        ? obj.activeSessions
        : {},
    scannerRuntime: {
      lastScanAt: typeof obj.scannerRuntime?.lastScanAt === 'string' ? obj.scannerRuntime.lastScanAt : null,
      lastScanDurationMs:
        typeof obj.scannerRuntime?.lastScanDurationMs === 'number'
          ? obj.scannerRuntime.lastScanDurationMs
          : null,
      lastDispatchError:
        typeof obj.scannerRuntime?.lastDispatchError === 'string' ? obj.scannerRuntime.lastDispatchError : null,
      lastDispatchAt:
        typeof obj.scannerRuntime?.lastDispatchAt === 'string' ? obj.scannerRuntime.lastDispatchAt : null,
    },
    recentDispatches: Array.isArray(obj.recentDispatches) ? obj.recentDispatches.slice(0, 50) : [],
    pendingNotifications: Array.isArray(obj.pendingNotifications)
      ? obj.pendingNotifications.slice(0, 100)
      : [],
    pendingRecordCommands: normalizedCommands,
    recentAckedCommandIds: normalizedRecentAckedIds,
    allowedDeviceIds: Array.isArray(obj.allowedDeviceIds)
      ? obj.allowedDeviceIds.filter(id => typeof id === 'string' && id.trim())
      : process.env.ALLOWED_DEVICE_IDS
        ? process.env.ALLOWED_DEVICE_IDS.split(',').map(s => s.trim()).filter(Boolean)
        : ['*'],
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

export function createStateStore(dataDir: string): StateStore {
  const resolvedDir = path.resolve(dataDir);
  const workspaceFile = path.join(resolvedDir, 'workspace-state.json');
  const androidFile = path.join(resolvedDir, 'android-state.json');

  const queues = new Map<string, Promise<unknown>>();

  function enqueue<T>(filePath: string, task: () => Promise<T>): Promise<T> {
    const key = path.resolve(filePath);
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

  return {
    dataDir: resolvedDir,
    workspaceFile,
    androidFile,

    readWorkspaceState(): Promise<WorkspaceState> {
      return enqueue(workspaceFile, async () => {
        const raw = await readJsonFileIfExists(workspaceFile);
        return normalizeWorkspaceState(raw);
      });
    },

    readWorkspaceStateIfExists(): Promise<WorkspaceState | null> {
      return enqueue(workspaceFile, async () => {
        const raw = await readJsonFileIfExists(workspaceFile);
        if (raw === null) return null;
        return normalizeWorkspaceState(raw);
      });
    },

    writeWorkspaceState(partialOrFull: Partial<WorkspaceState>): Promise<WorkspaceState> {
      return enqueue(workspaceFile, async () => {
        const rawExisting = await readJsonFileIfExists(workspaceFile);
        const existing = normalizeWorkspaceState(rawExisting);
        const next: WorkspaceState = {
          rules: Array.isArray(partialOrFull.rules) ? partialOrFull.rules : existing.rules,
          servers: Array.isArray(partialOrFull.servers) ? partialOrFull.servers : existing.servers,
          alerts: Array.isArray(partialOrFull.alerts) ? partialOrFull.alerts : existing.alerts,
          scannerSettings: normalizeScannerSettings(partialOrFull.scannerSettings, existing.scannerSettings),
          updatedAt: new Date().toISOString(),
        };
        await atomicWriteJson(workspaceFile, next);
        return next;
      });
    },

    readAndroidState(): Promise<AndroidState> {
      return enqueue(androidFile, async () => {
        const raw = await readJsonFileIfExists(androidFile);
        return normalizeAndroidState(raw);
      });
    },

    updateAndroidState(mutator: (current: AndroidState) => AndroidState | void): Promise<AndroidState> {
      return enqueue(androidFile, async () => {
        const rawExisting = await readJsonFileIfExists(androidFile);
        const current = normalizeAndroidState(rawExisting);
        const clone: AndroidState = {
          device: current.device ? { ...current.device } : null,
          reportedUsers: { ...current.reportedUsers },
          liveStatusMap: { ...current.liveStatusMap },
          activeSessions: { ...current.activeSessions },
          scannerRuntime: { ...current.scannerRuntime },
          recentDispatches: [...current.recentDispatches],
          pendingNotifications: Array.isArray(current.pendingNotifications)
            ? [...current.pendingNotifications]
            : [],
          pendingRecordCommands: Array.isArray(current.pendingRecordCommands)
            ? current.pendingRecordCommands.map(cmd => ({ ...cmd }))
            : [],
          recentAckedCommandIds: Array.isArray(current.recentAckedCommandIds)
            ? [...current.recentAckedCommandIds]
            : [],
          allowedDeviceIds: Array.isArray(current.allowedDeviceIds)
            ? [...current.allowedDeviceIds]
            : ['sm_n770f_default'],
          updatedAt: current.updatedAt,
        };
        const mutated = mutator(clone);
        const finalState = normalizeAndroidState(mutated ?? clone);
        finalState.updatedAt = new Date().toISOString();
        finalState.recentDispatches = finalState.recentDispatches.slice(0, 50);
        await atomicWriteJson(androidFile, finalState);
        return finalState;
      });
    },

    async flush(): Promise<void> {
      while (queues.size > 0) {
        await Promise.allSettled(Array.from(queues.values()));
      }
    },
  };
}

