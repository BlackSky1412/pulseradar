import fs from 'node:fs';
import path from 'node:path';
import {
  createDefaultMultiPlatformSettings,
  normalizeMultiPlatformSettings,
  resolvePlatformProfileUrl,
  type AlertDetectionItem,
  type KeywordRuleItem,
  type LivePlatform,
  type MultiPlatformSettings,
  type PlatformCookies,
  type TargetProfileMeta,
  type TargetStreamMeta,
  type TelegramStorageSettings,
  type WebhookServerItem,
} from '../src/utils/scannerEngine';
import { detectLivePlatform } from './liveCheckers/index';
import { canonicalizeUsername, makeCanonicalKey, parseStrictPlatform } from './reconcile';
import type { PendingDeviceNotification } from './watchers/types';

export type { TargetProfileMeta, TargetStreamMeta, TelegramStorageSettings };

export interface ScannerSettingsState {
  cookies: Required<PlatformCookies>;
  pollIntervalSeconds: number;
  deduplicateLive: boolean;
  platforms?: MultiPlatformSettings;
  telegram?: TelegramStorageSettings;
}

export interface WorkspaceState {
  rules: KeywordRuleItem[];
  servers: WebhookServerItem[];
  alerts: AlertDetectionItem[];
  scannerSettings: ScannerSettingsState;
  targetProfiles?: Record<string, TargetProfileMeta>;
  targetStreamMetaMap?: Record<string, TargetStreamMeta>;
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
  writeWorkspaceState: (
    partialOrFull: Partial<WorkspaceState> & { platforms?: unknown }
  ) => Promise<WorkspaceState>;
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
      platforms: createDefaultMultiPlatformSettings(),
      telegram: {
        botToken: '',
        chatId: '',
        enabled: true,
      },
    },
    targetProfiles: {},
    targetStreamMetaMap: {},
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
  fallback?: ScannerSettingsState,
  topLevelPlatforms?: unknown
): ScannerSettingsState {
  const base = fallback ?? createDefaultWorkspaceState().scannerSettings;
  const poll = incoming?.pollIntervalSeconds;
  const incomingPlatforms = incoming?.platforms ?? topLevelPlatforms;
  const basePlatforms = base.platforms ?? createDefaultMultiPlatformSettings();
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
    platforms: normalizeMultiPlatformSettings(
      incomingPlatforms as Partial<MultiPlatformSettings> | undefined,
      basePlatforms
    ),
    telegram: {
      botToken:
        typeof incoming?.telegram?.botToken === 'string'
          ? incoming.telegram.botToken.trim()
          : base.telegram?.botToken ?? '',
      chatId:
        typeof incoming?.telegram?.chatId === 'string'
          ? incoming.telegram.chatId.trim()
          : base.telegram?.chatId ?? '',
      enabled:
        typeof incoming?.telegram?.enabled === 'boolean'
          ? incoming.telegram.enabled
          : base.telegram?.enabled ?? true,
    },
  };
}

export function normalizeTargetStreamMetaMap(
  incoming: unknown,
  fallback?: Record<string, TargetStreamMeta>
): Record<string, TargetStreamMeta> {
  if (incoming === undefined) {
    return fallback ? normalizeTargetStreamMetaMap(fallback) : {};
  }
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return {};
  }
  const out: Record<string, TargetStreamMeta> = {};
  for (const [rawKey, rawVal] of Object.entries(incoming as Record<string, unknown>)) {
    const key = rawKey.trim();
    if (!key || key.length > 512) continue;
    if (!rawVal || typeof rawVal !== 'object' || Array.isArray(rawVal)) continue;
    if (Object.keys(out).length >= 2000 && !out[key]) continue;
    const v = rawVal as Record<string, unknown>;
    out[key] = {
      live: typeof v.live === 'boolean' ? v.live : true,
      post: typeof v.post === 'boolean' ? v.post : true,
      story: typeof v.story === 'boolean' ? v.story : true,
      warmup: typeof v.warmup === 'boolean' ? v.warmup : true,
    };
  }
  return out;
}

export function resolveTargetStreamMeta(
  metaMap: Record<string, TargetStreamMeta> | undefined,
  params: {
    ruleId?: string;
    rawTarget?: string;
    platform?: LivePlatform;
    canonicalUsername?: string;
  }
): TargetStreamMeta {
  const fallback: TargetStreamMeta = { live: true, post: true, story: true, warmup: true };
  if (!metaMap || typeof metaMap !== 'object') return fallback;

  const toResolved = (entry: TargetStreamMeta): TargetStreamMeta => ({
    live: entry.live !== false,
    post: entry.post !== false,
    story: entry.story !== false,
    warmup: entry.warmup !== false,
  });

  const rawTrimmed = typeof params.rawTarget === 'string' ? params.rawTarget.trim() : '';
  const canonicalFromParam =
    typeof params.canonicalUsername === 'string'
      ? params.canonicalUsername.trim().replace(/^@+/, '').toLowerCase()
      : '';
  const canonicalFromRaw = rawTrimmed
    ? params.platform
      ? canonicalizeUsername(rawTrimmed, params.platform)
      : canonicalizeUsername(rawTrimmed, detectLivePlatform(rawTrimmed, 'TIKTOK')) ||
        rawTrimmed.replace(/^@+/, '').toLowerCase()
    : '';
  const canonical = canonicalFromParam || canonicalFromRaw;

  const candidates: string[] = [];
  if (params.ruleId && rawTrimmed) {
    candidates.push(`${params.ruleId}::${rawTrimmed}`);
  }
  if (params.ruleId && canonical) {
    candidates.push(`${params.ruleId}::@${canonical}`);
    candidates.push(`${params.ruleId}::${canonical}`);
  }
  if (params.platform && canonical) {
    candidates.push(`${params.platform}::${canonical}`);
  }

  for (const key of candidates) {
    const entry = metaMap[key];
    if (entry && typeof entry === 'object') {
      return toResolved(entry);
    }
  }

  if (canonical) {
    const entries = Object.entries(metaMap);

    // Rule-scoped case-insensitive and canonicalized URL/handle match
    if (params.ruleId) {
      for (const [key, entry] of entries) {
        if (!entry || typeof entry !== 'object') continue;
        const sepIdx = key.indexOf('::');
        if (sepIdx <= 0) continue;
        const keyPrefix = key.slice(0, sepIdx).trim();
        if (keyPrefix !== params.ruleId) continue;
        const keyTarget = key.slice(sepIdx + 2).trim();
        if (!keyTarget) continue;

        if (keyTarget.replace(/^@+/, '').toLowerCase() === canonical) {
          return toResolved(entry);
        }

        const isExplicitUrl = /^https?:\/\//i.test(keyTarget);
        const targetPlatform = params.platform ?? detectLivePlatform(keyTarget, 'TIKTOK');
        if (params.platform && isExplicitUrl && detectLivePlatform(keyTarget, params.platform) !== params.platform) {
          continue;
        }
        if (canonicalizeUsername(keyTarget, targetPlatform) === canonical) {
          return toResolved(entry);
        }
      }
    }

    // Platform-scoped fallback (case-insensitive & canonicalized URL/handle)
    if (params.platform) {
      for (const [key, entry] of entries) {
        if (!entry || typeof entry !== 'object') continue;
        const sepIdx = key.indexOf('::');
        if (sepIdx <= 0) continue;
        const keyPrefix = key.slice(0, sepIdx).trim();
        if (keyPrefix.toUpperCase() !== params.platform) continue;
        const keyTarget = key.slice(sepIdx + 2).trim();
        if (!keyTarget) continue;

        if (
          keyTarget.replace(/^@+/, '').toLowerCase() === canonical ||
          canonicalizeUsername(keyTarget, params.platform) === canonical
        ) {
          return toResolved(entry);
        }
      }
    }
  }

  return fallback;
}

export function normalizeTargetProfiles(
  incoming: unknown,
  fallback?: Record<string, TargetProfileMeta>
): Record<string, TargetProfileMeta> {
  if (incoming === undefined) {
    return fallback ? normalizeTargetProfiles(fallback) : {};
  }
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return {};
  }

  const out: Record<string, TargetProfileMeta> = {};
  for (const [rawKey, rawVal] of Object.entries(incoming as Record<string, unknown>)) {
    if (!rawVal || typeof rawVal !== 'object' || Array.isArray(rawVal)) {
      continue;
    }
    const sepIdx = rawKey.indexOf('::');
    if (sepIdx <= 0) continue;
    const rawPlatform = rawKey.slice(0, sepIdx);
    const rawUsername = rawKey.slice(sepIdx + 2);
    const platform = parseStrictPlatform(rawPlatform);
    if (!platform) continue;
    const canonicalUsername = canonicalizeUsername(rawUsername, platform);
    if (!canonicalUsername) continue;

    const canonicalKey = makeCanonicalKey(platform, canonicalUsername);
    if (!out[canonicalKey] && Object.keys(out).length >= 1000) {
      continue;
    }

    const v = rawVal as Record<string, unknown>;
    const rawProfileUrl = typeof v.profileUrl === 'string' ? v.profileUrl.trim() : '';
    const profileUrl =
      /^https?:\/\//i.test(rawProfileUrl) && rawProfileUrl.length <= 2000
        ? rawProfileUrl
        : resolvePlatformProfileUrl(canonicalUsername, platform);

    const rawUpdatedAt = typeof v.updatedAt === 'string' ? v.updatedAt.trim() : '';
    const updatedAt = Number.isFinite(Date.parse(rawUpdatedAt))
      ? rawUpdatedAt
      : new Date(0).toISOString();

    const entry: TargetProfileMeta = {
      profileUrl,
      updatedAt,
    };

    if (typeof v.id === 'string') {
      const id = v.id.trim();
      if (id && id.length <= 128) entry.id = id;
    }
    if (typeof v.nickname === 'string') {
      const nickname = v.nickname.trim();
      if (nickname && nickname.length <= 200) entry.nickname = nickname;
    }
    if (typeof v.avatarUrl === 'string') {
      const avatarUrl = v.avatarUrl.trim();
      if (/^https?:\/\//i.test(avatarUrl) && avatarUrl.length <= 2000) {
        entry.avatarUrl = avatarUrl;
      }
    }
    if (typeof v.status === 'string') {
      const status = v.status.trim();
      if (status && status.length <= 40) entry.status = status;
    }
    if (v.authMode === 'anonymous' || v.authMode === 'cookie') {
      entry.authMode = v.authMode;
    }

    const existing = out[canonicalKey];
    if (!existing || Date.parse(entry.updatedAt) >= Date.parse(existing.updatedAt)) {
      out[canonicalKey] = entry;
    }
  }
  return out;
}

function normalizeWorkspaceState(raw: unknown): WorkspaceState {
  const def = createDefaultWorkspaceState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return def;
  }
  const obj = raw as Partial<WorkspaceState> & { platforms?: unknown };
  return {
    rules: Array.isArray(obj.rules) ? obj.rules : def.rules,
    servers: Array.isArray(obj.servers) ? obj.servers : def.servers,
    alerts: Array.isArray(obj.alerts) ? obj.alerts : def.alerts,
    scannerSettings: normalizeScannerSettings(
      obj.scannerSettings,
      def.scannerSettings,
      obj.platforms
    ),
    targetProfiles: normalizeTargetProfiles(obj.targetProfiles),
    targetStreamMetaMap: normalizeTargetStreamMetaMap(obj.targetStreamMetaMap),
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

    writeWorkspaceState(
      partialOrFull: Partial<WorkspaceState> & { platforms?: unknown }
    ): Promise<WorkspaceState> {
      return enqueue(workspaceFile, async () => {
        const rawExisting = await readJsonFileIfExists(workspaceFile);
        const existing = normalizeWorkspaceState(rawExisting);
        const next: WorkspaceState = {
          rules: Array.isArray(partialOrFull.rules) ? partialOrFull.rules : existing.rules,
          servers: Array.isArray(partialOrFull.servers) ? partialOrFull.servers : existing.servers,
          alerts: Array.isArray(partialOrFull.alerts) ? partialOrFull.alerts : existing.alerts,
          scannerSettings: normalizeScannerSettings(
            partialOrFull.scannerSettings,
            existing.scannerSettings,
            partialOrFull.platforms
          ),
          targetProfiles: normalizeTargetProfiles(partialOrFull.targetProfiles, existing.targetProfiles),
          targetStreamMetaMap: normalizeTargetStreamMetaMap(
            partialOrFull.targetStreamMetaMap,
            existing.targetStreamMetaMap
          ),
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

