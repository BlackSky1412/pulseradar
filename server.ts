import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ViteDevServer } from 'vite';
import {
  matchKeywordRule,
  buildWebhookPayload,
  parseTrackedTargets,
  parseSourceMeta,
  isLiveUserTarget,
  resolveLivePlatformForTarget,
  type SocialPlatform,
  type LivePlatform,
  type MatchType,
  type WebhookFormat,
  type SocialPostCandidate,
  type ActivityEventType,
  type LiveTargetScanStatus,
  type MultiPlatformSettings,
  type PlatformTrackingConfig,
  type ScannerSettingsState,
  createDefaultMultiPlatformSettings,
  normalizeMultiPlatformSettings,
} from './src/utils/scannerEngine';
import {
  checkBatchLive,
  checkUserLive,
  type BatchLiveTarget,
  type PlatformCookies,
} from './server/liveCheckers/index';
import {
  createStateStore,
  createDefaultWorkspaceState,
  type StateStore,
  type WorkspaceState,
} from './server/stateStore';
import {
  createWatcherStateStore,
  type WatcherStateStore,
} from './server/watchers/stateStore';
import {
  TikTokWatcher,
  type TikTokWatcherOptions,
} from './server/watchers/tiktokWatcher';
import { Notifier } from './server/watchers/notifier';
import { resolveDriveStorageRoot } from './server/mediaDownloader';
import type { PendingDeviceNotification } from './server/watchers/types';
import {
  createAndroidClient,
  type AndroidClient,
  type AndroidClientOptions,
} from './server/androidClient';
import { createAutoScanner, type AutoScanner } from './server/autoScanner';
import {
  canonicalizeUsername,
  extractAuthoritativeUsers,
  makeCanonicalKey,
  mergeAndroidSyncUsers,
  normalizeAndroidStatus,
  parseStrictPlatform,
  reconcileAndroidSync,
  type NormalizedAndroidSyncUser,
} from './server/reconcile';

export function createTikTokWatcher(options: TikTokWatcherOptions): TikTokWatcher {
  return new TikTokWatcher(options);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STRICT_IPV4_REGEX =
  /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export interface SandboxWebhookReceipt {
  id: string;
  receivedAt: string;
  channel: string;
  signatureHeader: string;
  signatureVerified: boolean;
  eventHeader: string;
  userAgent: string;
  payload: unknown;
}

export interface CreateAppOptions {
  dataDir?: string;
  mountFrontend?: boolean;
  autoScanEnabled?: boolean;
  autoScanIntervalMs?: number;
  autoScanInitialDelayMs?: number;
  autoScanStaggerMs?: number;
  liveCheckBatchFn?: typeof checkBatchLive;
  androidClientOptions?: AndroidClientOptions;
  envCookies?: PlatformCookies;
  watcherStateStore?: WatcherStateStore;
  watcher?: TikTokWatcher;
  startWatcher?: boolean;
}

export interface CreatedApp {
  app: express.Express;
  stateStore: StateStore;
  androidClient: AndroidClient;
  autoScanner: AutoScanner;
  watcher: TikTokWatcher;
  watcherStateStore: WatcherStateStore;
  setListeningPort: (port: number) => void;
  getListeningPort: () => number;
  close: () => Promise<void>;
}

export interface StartServerOptions extends CreateAppOptions {
  port?: number;
  host?: string;
  startAutoScanner?: boolean;
  startWatcher?: boolean;
}

export interface StartedServer extends CreatedApp {
  server: http.Server;
  port: number;
  url: string;
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

export function extractValidIpv4(rawIp: unknown, remoteAddress?: string): string | null {
  if (rawIp !== undefined && rawIp !== null && typeof rawIp !== 'string') {
    return null;
  }
  const explicit = typeof rawIp === 'string' ? rawIp.trim() : '';
  let candidate = explicit || String(remoteAddress || '').trim();
  if (candidate.startsWith('::ffff:')) {
    candidate = candidate.slice('::ffff:'.length);
  }
  if (!net.isIPv4(candidate) || !STRICT_IPV4_REGEX.test(candidate)) {
    return null;
  }
  return candidate;
}

export function parseValidPort(rawPort: unknown): number | null {
  if (typeof rawPort !== 'number' || !Number.isInteger(rawPort)) {
    return null;
  }
  if (rawPort < 1 || rawPort > 65535) {
    return null;
  }
  return rawPort;
}

export function resolveEnvPort(rawPort: string | undefined = process.env.PORT): number {
  const parsedEnvPort = rawPort !== undefined && rawPort.trim() !== '' ? Number(rawPort) : NaN;
  return Number.isInteger(parsedEnvPort) && parsedEnvPort >= 0 && parsedEnvPort <= 65535
    ? parsedEnvPort
    : 3000;
}

async function dispatchWebhookHttp(params: {
  targetUrl: string;
  format: WebhookFormat;
  secretHeader: string;
  payload: Record<string, unknown>;
  port: number;
}): Promise<{
  delivered: boolean;
  httpStatusCode: number;
  latencyMs: number;
  responsePreview: string;
}> {
  const start = performance.now();
  const bodyString = JSON.stringify(params.payload);

  const signature = params.secretHeader
    ? `sha256=${crypto.createHmac('sha256', params.secretHeader).update(bodyString).digest('hex')}`
    : 'unsigned';

  const resolvedUrl = params.targetUrl.startsWith('/')
    ? `http://127.0.0.1:${params.port}${params.targetUrl}`
    : params.targetUrl;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);

  try {
    const res = await fetch(resolvedUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'PulseRadar-WebhookBot/2026.2',
        'X-PulseBot-Event': 'social.keyword.detected',
        'X-PulseBot-Format': params.format,
        'X-PulseBot-Signature': signature,
      },
      body: bodyString,
      signal: controller.signal,
    });
    const latencyMs = Math.max(1, Math.round(performance.now() - start));
    const text = await res.text().catch(() => '');
    return {
      delivered: res.ok,
      httpStatusCode: res.status,
      latencyMs,
      responsePreview: text.slice(0, 300) || res.statusText,
    };
  } catch (err) {
    const latencyMs = Math.max(1, Math.round(performance.now() - start));
    return {
      delivered: false,
      httpStatusCode: 502,
      latencyMs,
      responsePreview: err instanceof Error ? err.message : 'Network connection error',
    };
  } finally {
    clearTimeout(timer);
  }
}

const RETRYABLE_FS_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_RETRY_DELAYS_MS = [20, 40, 80, 160, 320];

function sleepFs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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
          await sleepFs(RENAME_RETRY_DELAYS_MS[attempt]);
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

export async function createApp(options: CreateAppOptions = {}): Promise<CreatedApp> {
  const app = express();
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });
  app.use(express.json({ limit: '1mb' }));

  const dataDir = options.dataDir ?? path.resolve(__dirname, 'data');
  const baseStateStore = createStateStore(dataDir);
  const workspaceQueues = new Map<string, Promise<unknown>>();
  function enqueueWorkspace<T>(task: () => Promise<T>): Promise<T> {
    const key = baseStateStore.workspaceFile;
    const prev = workspaceQueues.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(task);
    const tracked = next.catch(() => {});
    workspaceQueues.set(key, tracked);
    tracked.finally(() => {
      if (workspaceQueues.get(key) === tracked) {
        workspaceQueues.delete(key);
      }
    });
    return next;
  }

  const stateStore: StateStore = {
    ...baseStateStore,
    async readWorkspaceState(): Promise<any> {
      const state = await baseStateStore.readWorkspaceState();
      const raw = await readJsonFileIfExists(baseStateStore.workspaceFile);
      const rawObj = (raw && typeof raw === 'object' ? raw : {}) as {
        scannerSettings?: { platforms?: unknown };
        platforms?: unknown;
      };
      const incomingPlatforms =
        rawObj.scannerSettings?.platforms ?? rawObj.platforms;
      const platforms = normalizeMultiPlatformSettings(
        incomingPlatforms as Partial<MultiPlatformSettings> | undefined
      );
      return {
        ...state,
        scannerSettings: {
          ...state.scannerSettings,
          platforms,
        },
      };
    },
    async readWorkspaceStateIfExists(): Promise<any> {
      const state = await baseStateStore.readWorkspaceStateIfExists();
      if (!state) return null;
      const raw = await readJsonFileIfExists(baseStateStore.workspaceFile);
      const rawObj = (raw && typeof raw === 'object' ? raw : {}) as {
        scannerSettings?: { platforms?: unknown };
        platforms?: unknown;
      };
      const incomingPlatforms =
        rawObj.scannerSettings?.platforms ?? rawObj.platforms;
      const platforms = normalizeMultiPlatformSettings(
        incomingPlatforms as Partial<MultiPlatformSettings> | undefined
      );
      return {
        ...state,
        scannerSettings: {
          ...state.scannerSettings,
          platforms,
        },
      };
    },
    async writeWorkspaceState(partialOrFull: any): Promise<any> {
      return enqueueWorkspace(async () => {
        const rawExisting = await readJsonFileIfExists(baseStateStore.workspaceFile);
        const existing =
          rawExisting && typeof rawExisting === 'object' && !Array.isArray(rawExisting)
            ? (rawExisting as Record<string, any>)
            : {};

        const baseDef = createDefaultWorkspaceState();
        const existingRules = Array.isArray(existing.rules) ? existing.rules : baseDef.rules;
        const existingServers = Array.isArray(existing.servers) ? existing.servers : baseDef.servers;
        const existingAlerts = Array.isArray(existing.alerts) ? existing.alerts : baseDef.alerts;
        const existingSettings =
          existing.scannerSettings && typeof existing.scannerSettings === 'object'
            ? existing.scannerSettings
            : baseDef.scannerSettings;

        const incomingSettings = partialOrFull?.scannerSettings;
        const poll = incomingSettings?.pollIntervalSeconds;

        const incomingPlatforms =
          incomingSettings?.platforms ?? partialOrFull?.platforms;
        const existingPlatforms =
          existingSettings?.platforms ?? existing?.platforms;

        const platforms = normalizeMultiPlatformSettings(
          (incomingPlatforms !== undefined ? incomingPlatforms : existingPlatforms) as Partial<MultiPlatformSettings> | undefined
        );

        const next: WorkspaceState & { scannerSettings: ScannerSettingsState & { platforms: MultiPlatformSettings } } = {
          rules: Array.isArray(partialOrFull?.rules) ? partialOrFull.rules : existingRules,
          servers: Array.isArray(partialOrFull?.servers) ? partialOrFull.servers : existingServers,
          alerts: Array.isArray(partialOrFull?.alerts) ? partialOrFull.alerts : existingAlerts,
          scannerSettings: {
            cookies: {
              tiktok:
                typeof incomingSettings?.cookies?.tiktok === 'string'
                  ? incomingSettings.cookies.tiktok
                  : existingSettings.cookies?.tiktok ?? '',
              instagram:
                typeof incomingSettings?.cookies?.instagram === 'string'
                  ? incomingSettings.cookies.instagram
                  : existingSettings.cookies?.instagram ?? '',
              facebook:
                typeof incomingSettings?.cookies?.facebook === 'string'
                  ? incomingSettings.cookies.facebook
                  : existingSettings.cookies?.facebook ?? '',
              x:
                typeof incomingSettings?.cookies?.x === 'string'
                  ? incomingSettings.cookies.x
                  : existingSettings.cookies?.x ?? '',
            },
            pollIntervalSeconds:
              typeof poll === 'number' && Number.isFinite(poll) && poll >= 10
                ? poll
                : existingSettings.pollIntervalSeconds ?? 30,
            deduplicateLive:
              typeof incomingSettings?.deduplicateLive === 'boolean'
                ? incomingSettings.deduplicateLive
                : existingSettings.deduplicateLive ?? true,
            platforms,
          },
          updatedAt: new Date().toISOString(),
        };

        await atomicWriteJson(baseStateStore.workspaceFile, next);
        return next;
      });
    },
    async flush(): Promise<void> {
      await baseStateStore.flush();
      while (workspaceQueues.size > 0) {
        await Promise.allSettled(Array.from(workspaceQueues.values()));
      }
    },
  };

  const watcherStateStore =
    options.watcherStateStore ??
    createWatcherStateStore(path.resolve(dataDir, 'watcher-state.json'));

  const driveStorageRoot = resolveDriveStorageRoot();

  const watcher =
    options.watcher ??
    new TikTokWatcher({
      config: {
        targetUsers: [],
        liveIntervalSeconds: 60,
        postIntervalSeconds: 240,
        storyIntervalSeconds: 360,
        enableWarmup: true,
        tiktokSessionId: options.envCookies?.tiktok,
        autoDownloadMedia: true,
        driveStorageRoot,
      },
      stateStore: watcherStateStore,
      notifier: new Notifier({
        onPendingNotification: async notif => {
          await stateStore.updateAndroidState(st => {
            if (!Array.isArray(st.pendingNotifications)) {
              st.pendingNotifications = [];
            }
            st.pendingNotifications.push(notif);
            if (st.pendingNotifications.length > 100) {
              st.pendingNotifications = st.pendingNotifications.slice(-100);
            }
          });
        },
      }),
    });

  // Synchronize initial target users and watcher configuration from workspace state
  try {
    const initialState = await stateStore.readWorkspaceStateIfExists();
    if (initialState?.rules) {
      const authoritative = extractAuthoritativeUsers(initialState.rules, {});
      const tikTokUsers = Object.values(authoritative)
        .filter(u => u.platform === 'TIKTOK' && u.isEnabled)
        .map(u => u.username);
      watcher.setTargetUsers(tikTokUsers);
    }
    if (initialState?.scannerSettings?.cookies?.tiktok) {
      watcher.updateConfig({ tiktokSessionId: initialState.scannerSettings.cookies.tiktok });
    }
    const ttPlatforms = (initialState?.scannerSettings as any)?.platforms?.tiktok;
    if (ttPlatforms) {
      watcher.updateConfig({
        liveIntervalSeconds: ttPlatforms.liveIntervalSeconds,
        postIntervalSeconds: ttPlatforms.postIntervalSeconds,
        storyIntervalSeconds: ttPlatforms.storyIntervalSeconds,
      });
    }
  } catch {
    // Ignore initial state read errors on fresh uninitialized directories
  }

  const androidClient = createAndroidClient(options.androidClientOptions);
  const autoScanner = createAutoScanner({
    stateStore,
    androidClient,
    enabled: options.autoScanEnabled,
    intervalMsOverride: options.autoScanIntervalMs,
    initialDelayMs: options.autoScanInitialDelayMs,
    staggerMs: options.autoScanStaggerMs,
    liveCheckBatchFn: options.liveCheckBatchFn,
    envCookies: options.envCookies,
  });

  // Instance-scoped state (never shared across tests/app instances)
  const sandboxReceipts: SandboxWebhookReceipt[] = [];
  const activeLiveSessionMap = new Map<string, string>();
  let listeningPort = resolveEnvPort();
  let viteServer: ViteDevServer | null = null;

  // 0. Health & Introspection (Contract 4)
  app.get('/api/health', async (_req, res) => {
    try {
      const [ws, androidState] = await Promise.all([
        stateStore.readWorkspaceState(),
        stateStore.readAndroidState(),
      ]);
      const authoritativeUsers = extractAuthoritativeUsers(ws.rules, androidState.liveStatusMap);
      res.json({
        ok: true,
        port: listeningPort,
        autoScanEnabled: autoScanner.isEnabled(),
        autoScanRunning: autoScanner.isRunning(),
        androidDevice: androidState.device,
        trackedUsersCount: authoritativeUsers.length,
        serverTime: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to read server health',
      });
    }
  });

  // 0b. Dynamic Android IP Registration (Contract 1)
  app.post('/api/android/register', async (req, res) => {
    try {
      if (!isPlainObject(req.body)) {
        res.status(400).json({ ok: false, error: 'Invalid JSON body' });
        return;
      }

      const port = parseValidPort(req.body.port);
      if (port === null) {
        res.status(400).json({ ok: false, error: 'Invalid port: must be integer 1..65535' });
        return;
      }

      const ip = extractValidIpv4(req.body.ip, req.socket.remoteAddress);
      if (ip === null) {
        res.status(400).json({ ok: false, error: 'Invalid IPv4 address' });
        return;
      }

      if (
        req.body.deviceId !== undefined &&
        req.body.deviceId !== null &&
        typeof req.body.deviceId !== 'string'
      ) {
        res.status(400).json({ ok: false, error: 'Invalid deviceId' });
        return;
      }

      const existingAndroidState = await stateStore.readAndroidState();
      const explicitDeviceId =
        typeof req.body.deviceId === 'string' ? req.body.deviceId.trim() : '';
      const candidateDeviceId = explicitDeviceId || existingAndroidState.device?.deviceId || 'sm_n770f_default';
      const allowedIds = existingAndroidState.allowedDeviceIds || ['sm_n770f_default'];
      if (allowedIds.length > 0 && !allowedIds.includes('*') && !allowedIds.includes(candidateDeviceId)) {
        res.status(403).json({ ok: false, error: 'Device not authorized' });
        return;
      }

      const nowIso = new Date().toISOString();
      const callbackUrl = `http://${ip}:${port}/record`;
      let registeredDeviceId = 'sm_n770f_default';

      await stateStore.updateAndroidState(draft => {
        const existing = draft.device;
        const explicitDeviceId =
          typeof req.body.deviceId === 'string' ? req.body.deviceId.trim() : '';
        registeredDeviceId = explicitDeviceId || existing?.deviceId || 'sm_n770f_default';

        const endpointChanged = !existing || existing.ip !== ip || existing.port !== port;
        if (endpointChanged) {
          draft.scannerRuntime.lastDispatchError = null;
          androidClient.clearLastDispatchError();
        }

        draft.device = {
          deviceId: registeredDeviceId,
          ip,
          port,
          callbackUrl,
          appVersion:
            typeof req.body.appVersion === 'string'
              ? req.body.appVersion.trim()
              : existing?.appVersion ?? '',
          networkType:
            typeof req.body.networkType === 'string' && req.body.networkType.trim()
              ? req.body.networkType.trim()
              : existing?.networkType ?? 'UNKNOWN',
          registeredAt: existing?.registeredAt || nowIso,
          lastSeenAt: nowIso,
          lastSyncAt: existing?.lastSyncAt ?? null,
        };
      });

      res.status(200).json({
        ok: true,
        deviceId: registeredDeviceId,
        ip,
        port,
        callbackUrl,
        serverTime: nowIso,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to register Android device',
      });
    }
  });

  // 0c. Android & Autonomous Scanner Status (Contract 4)
  app.get('/api/android/status', async (_req, res) => {
    try {
      const [androidState, scannerStatus] = await Promise.all([
        stateStore.readAndroidState(),
        autoScanner.getStatus(),
      ]);
      res.status(200).json({
        ok: true,
        device: androidState.device,
        scanner: scannerStatus,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to read Android status',
      });
    }
  });

  // 0d. 10-Minute Authoritative Sync & Reconciliation (Contract 3)
  app.post('/api/android/sync', async (req, res) => {
    try {
      if (!isPlainObject(req.body)) {
        res.status(400).json({ ok: false, error: 'Invalid JSON body' });
        return;
      }

      if (!Array.isArray(req.body.users)) {
        res.status(400).json({ ok: false, error: 'Missing or invalid users array' });
        return;
      }

      if (
        req.body.deviceId !== undefined &&
        req.body.deviceId !== null &&
        typeof req.body.deviceId !== 'string'
      ) {
        res.status(400).json({ ok: false, error: 'Invalid deviceId' });
        return;
      }

      const existingAndroidState = await stateStore.readAndroidState();
      const candidateDeviceId =
        (typeof req.body.deviceId === 'string' ? req.body.deviceId.trim() : '') ||
        existingAndroidState.device?.deviceId ||
        'sm_n770f_default';
      const allowedIds = existingAndroidState.allowedDeviceIds || ['sm_n770f_default'];
      if (allowedIds.length > 0 && !allowedIds.includes('*') && !allowedIds.includes(candidateDeviceId)) {
        res.status(403).json({ ok: false, error: 'Device not authorized' });
        return;
      }

      // Validate explicit IP if supplied, otherwise fall back to socket/existing IP
      let resolvedIp: string | null = null;
      const hasExplicitIp =
        req.body.ip !== undefined &&
        req.body.ip !== null &&
        !(typeof req.body.ip === 'string' && req.body.ip.trim() === '');

      if (hasExplicitIp) {
        resolvedIp = extractValidIpv4(req.body.ip);
        if (resolvedIp === null) {
          res.status(400).json({ ok: false, error: 'Invalid IPv4 address' });
          return;
        }
      } else {
        resolvedIp =
          extractValidIpv4(undefined, req.socket.remoteAddress) ||
          existingAndroidState.device?.ip ||
          null;
      }

      let resolvedPort: number;
      if (req.body.port !== undefined && req.body.port !== null) {
        const parsedPort = parseValidPort(req.body.port);
        if (parsedPort === null) {
          res.status(400).json({ ok: false, error: 'Invalid port: must be integer 1..65535' });
          return;
        }
        resolvedPort = parsedPort;
      } else {
        resolvedPort = existingAndroidState.device?.port ?? 8765;
      }

      // Strictly validate all reported user entries before mutating state
      const validatedUsers: NormalizedAndroidSyncUser[] = [];
      for (let i = 0; i < req.body.users.length; i++) {
        const rawUser = req.body.users[i];
        if (!isPlainObject(rawUser)) {
          res.status(400).json({ ok: false, error: `Invalid user object at users[${i}]` });
          return;
        }

        const platform = parseStrictPlatform(rawUser.platform);
        if (!platform) {
          res.status(400).json({ ok: false, error: `Invalid platform at users[${i}]` });
          return;
        }

        if (
          rawUser.username !== undefined &&
          rawUser.username !== null &&
          typeof rawUser.username !== 'string'
        ) {
          res.status(400).json({ ok: false, error: `Invalid username at users[${i}]` });
          return;
        }

        if (
          rawUser.usernameOrUrl !== undefined &&
          rawUser.usernameOrUrl !== null &&
          typeof rawUser.usernameOrUrl !== 'string'
        ) {
          res.status(400).json({ ok: false, error: `Invalid usernameOrUrl at users[${i}]` });
          return;
        }

        const rawUsernameOrUrl =
          typeof rawUser.usernameOrUrl === 'string' ? rawUser.usernameOrUrl.trim() : '';
        const rawUsername = typeof rawUser.username === 'string' ? rawUser.username.trim() : '';
        const rawTarget = rawUsernameOrUrl || rawUsername;
        if (!rawTarget) {
          res.status(400).json({ ok: false, error: `Missing username or usernameOrUrl at users[${i}]` });
          return;
        }

        const canonicalUsername =
          canonicalizeUsername(rawTarget, platform) ||
          (rawUsername ? canonicalizeUsername(rawUsername, platform) : '');
        if (!canonicalUsername) {
          res.status(400).json({ ok: false, error: `Invalid username at users[${i}]` });
          return;
        }

        const status = normalizeAndroidStatus(rawUser.status);
        if (!status) {
          res.status(400).json({ ok: false, error: `Invalid status at users[${i}]` });
          return;
        }

        if (rawUser.isEnabled !== undefined && typeof rawUser.isEnabled !== 'boolean') {
          res.status(400).json({ ok: false, error: `Invalid isEnabled at users[${i}]` });
          return;
        }

        validatedUsers.push({
          canonicalKey: makeCanonicalKey(platform, canonicalUsername),
          username: canonicalUsername,
          usernameOrUrl: rawTarget,
          platform,
          status,
          isEnabled: rawUser.isEnabled === undefined ? true : Boolean(rawUser.isEnabled),
          allowCellular: Boolean(rawUser.allowCellular),
          lastStreamUrl: typeof rawUser.lastStreamUrl === 'string' ? rawUser.lastStreamUrl : null,
          lastCheckedTimestamp:
            typeof rawUser.lastCheckedTimestamp === 'number' &&
            Number.isFinite(rawUser.lastCheckedTimestamp)
              ? rawUser.lastCheckedTimestamp
              : null,
        });
      }

      const nowIso = new Date().toISOString();
      const nowMs = Date.now();

      const updatedAndroidState = await stateStore.updateAndroidState(draft => {
        const prevDevice = draft.device;
        if (resolvedIp) {
          const explicitDeviceId =
            typeof req.body.deviceId === 'string' ? req.body.deviceId.trim() : '';
          const deviceId = explicitDeviceId || prevDevice?.deviceId || 'sm_n770f_default';
          const callbackUrl = `http://${resolvedIp}:${resolvedPort}/record`;
          if (!prevDevice || prevDevice.ip !== resolvedIp || prevDevice.port !== resolvedPort) {
            draft.scannerRuntime.lastDispatchError = null;
            androidClient.clearLastDispatchError();
          }
          draft.device = {
            deviceId,
            ip: resolvedIp,
            port: resolvedPort,
            callbackUrl,
            appVersion:
              typeof req.body.appVersion === 'string'
                ? req.body.appVersion.trim()
                : prevDevice?.appVersion ?? '',
            networkType:
              typeof req.body.networkType === 'string' && req.body.networkType.trim()
                ? req.body.networkType.trim()
                : prevDevice?.networkType ?? 'UNKNOWN',
            registeredAt: prevDevice?.registeredAt || nowIso,
            lastSeenAt: nowIso,
            lastSyncAt: nowIso,
          };
        } else if (prevDevice) {
          draft.device = {
            ...prevDevice,
            lastSeenAt: nowIso,
            lastSyncAt: nowIso,
          };
        }

        const mergedUsers = mergeAndroidSyncUsers(validatedUsers);
        const nextReportedUsers: typeof draft.reportedUsers = {};
        for (const u of mergedUsers.values()) {
          nextReportedUsers[u.canonicalKey] = {
            canonicalKey: u.canonicalKey,
            platform: u.platform,
            username: u.username,
            usernameOrUrl: u.usernameOrUrl,
            status: u.status,
            isEnabled: u.isEnabled,
            allowCellular: u.allowCellular,
            lastStreamUrl: u.lastStreamUrl,
            lastCheckedTimestamp: u.lastCheckedTimestamp,
            reportedAt: nowIso,
          };
        }
        draft.reportedUsers = nextReportedUsers;
      });

      const ws = await stateStore.readWorkspaceState();
      const authoritativeUsers = extractAuthoritativeUsers(
        ws.rules,
        updatedAndroidState.liveStatusMap
      );
      const reconcileResult = reconcileAndroidSync(authoritativeUsers, validatedUsers, {
        syncedAt: nowIso,
        nowMs,
      });

      let deliveredNotifications: PendingDeviceNotification[] = [];
      await stateStore.updateAndroidState(draft => {
        if (Array.isArray(draft.pendingNotifications) && draft.pendingNotifications.length > 0) {
          deliveredNotifications = [...draft.pendingNotifications];
          draft.pendingNotifications = [];
        }
      });

      res.status(200).json({
        ok: true,
        syncedAt: nowIso,
        notifications: deliveredNotifications,
        ...reconcileResult,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to synchronize Android state',
      });
    }
  });

  // 0d-1. Manual / Programmatic Android Push Notification Dispatch
  app.post('/api/android/notify', async (req, res) => {
    try {
      const androidState = await stateStore.readAndroidState();
      const notif: PendingDeviceNotification = {
        id: `notif_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: req.body?.type || 'MEDIA_DOWNLOADED',
        eventType: req.body?.eventType || 'post',
        platform: req.body?.platform || 'TIKTOK',
        username: String(req.body?.username || ''),
        title: String(req.body?.title || 'PulseRadar Notification'),
        itemId: String(req.body?.itemId || ''),
        sourceUrl: typeof req.body?.sourceUrl === 'string' ? req.body.sourceUrl : undefined,
        mediaPath: typeof req.body?.mediaPath === 'string' ? req.body.mediaPath : undefined,
        fileName: typeof req.body?.fileName === 'string' ? req.body.fileName : undefined,
        fileSize: typeof req.body?.fileSize === 'number' ? req.body.fileSize : undefined,
        createdAt: new Date().toISOString(),
      };

      let directDispatched = false;
      if (androidState.device?.callbackUrl) {
        const notifyUrl = androidState.device.callbackUrl.includes('/record')
          ? androidState.device.callbackUrl.replace(/\/record\/?$/, '/notify')
          : `${androidState.device.callbackUrl.replace(/\/+$/, '')}/notify`;
        try {
          const pushResp = await fetch(notifyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(notif),
            signal: AbortSignal.timeout(3000),
          });
          directDispatched = pushResp.ok;
        } catch {
          // Direct push failed (normal if phone is behind NAT), fallback to 10-minute sync queue
        }
      }

      await stateStore.updateAndroidState(draft => {
        if (!Array.isArray(draft.pendingNotifications)) {
          draft.pendingNotifications = [];
        }
        draft.pendingNotifications.push(notif);
        if (draft.pendingNotifications.length > 100) {
          draft.pendingNotifications = draft.pendingNotifications.slice(-100);
        }
      });

      res.status(200).json({ ok: true, directDispatched, notification: notif });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 0d-2. Downloaded Media Listing (Google Drive / Local Storage)
  app.get('/api/media/downloaded', async (_req, res) => {
    try {
      const rootDir = resolveDriveStorageRoot();
      const results: Array<{
        username: string;
        eventType: string;
        fileName: string;
        size: number;
        mtime: string;
        localPath: string;
        downloadUrl: string;
      }> = [];

      if (fs.existsSync(rootDir)) {
        const userDirs = fs.readdirSync(rootDir);
        for (const user of userDirs) {
          const userPath = path.join(rootDir, user);
          if (!fs.statSync(userPath).isDirectory()) continue;
          for (const type of ['posts', 'stories']) {
            const typePath = path.join(userPath, type);
            if (fs.existsSync(typePath) && fs.statSync(typePath).isDirectory()) {
              const files = fs.readdirSync(typePath);
              for (const f of files) {
                const filePath = path.join(typePath, f);
                const stat = fs.statSync(filePath);
                if (stat.isFile()) {
                  results.push({
                    username: user,
                    eventType: type,
                    fileName: f,
                    size: stat.size,
                    mtime: stat.mtime.toISOString(),
                    localPath: filePath,
                    downloadUrl: `/api/media/file/${encodeURIComponent(user)}/${type}/${encodeURIComponent(f)}`,
                  });
                }
              }
            }
          }
        }
      }
      res.json({ ok: true, storageRoot: rootDir, count: results.length, media: results });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 0d-3. Safe Media Streaming & Download Route
  app.get('/api/media/file/:username/:type/:filename', (req, res) => {
    try {
      const { username, type, filename } = req.params;
      const rootDir = resolveDriveStorageRoot();
      const safeUser = path.basename(username);
      const safeType = path.basename(type);
      const safeFile = path.basename(filename);
      const targetPath = path.join(rootDir, safeUser, safeType, safeFile);

      if (!fs.existsSync(targetPath)) {
        res.status(404).json({ ok: false, error: 'File not found' });
        return;
      }

      res.sendFile(targetPath);
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 0d-4. Security Device Whitelist Management
  app.get('/api/security/device-whitelist', async (_req, res) => {
    try {
      const androidState = await stateStore.readAndroidState();
      res.json({ ok: true, allowedDeviceIds: androidState.allowedDeviceIds || ['sm_n770f_default'] });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.put('/api/security/device-whitelist', async (req, res) => {
    try {
      if (!isPlainObject(req.body) || !Array.isArray(req.body.allowedDeviceIds)) {
        res.status(400).json({ ok: false, error: 'allowedDeviceIds must be an array of string device IDs' });
        return;
      }
      const cleaned = (req.body.allowedDeviceIds as unknown[])
        .filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))
        .map(id => id.trim());

      const updated = await stateStore.updateAndroidState(draft => {
        draft.allowedDeviceIds = cleaned;
      });
      res.json({ ok: true, allowedDeviceIds: updated.allowedDeviceIds });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 0e. Local Workspace State Persistence (isolated from android-state.json)
  app.get('/api/workspace-state', async (_req, res) => {
    try {
      const state = await stateStore.readWorkspaceStateIfExists();
      res.json({ ok: true, state });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to read workspace state',
      });
    }
  });

  app.put('/api/workspace-state', async (req, res) => {
    try {
      const body = req.body;
      if (!isPlainObject(body)) {
        res.status(400).json({ ok: false, error: 'Invalid workspace state payload' });
        return;
      }
      if (body.rules !== undefined && !Array.isArray(body.rules)) {
        res.status(400).json({ ok: false, error: 'Invalid workspace state rules array' });
        return;
      }
      if (body.servers !== undefined && !Array.isArray(body.servers)) {
        res.status(400).json({ ok: false, error: 'Invalid workspace state servers array' });
        return;
      }
      if (body.alerts !== undefined && !Array.isArray(body.alerts)) {
        res.status(400).json({ ok: false, error: 'Invalid workspace state alerts array' });
        return;
      }

      const state = await stateStore.writeWorkspaceState(body);

      // Update watcher targets and configuration from saved workspace state
      if (Array.isArray(state.rules)) {
        const authoritative = extractAuthoritativeUsers(state.rules, {});
        const tikTokUsers = Object.values(authoritative)
          .filter(u => u.platform === 'TIKTOK' && u.isEnabled)
          .map(u => u.username);
        watcher.setTargetUsers(tikTokUsers);
      }
      if (state.scannerSettings?.cookies?.tiktok) {
        watcher.updateConfig({ tiktokSessionId: state.scannerSettings.cookies.tiktok });
      }
      const ttPlatforms = (state.scannerSettings as any)?.platforms?.tiktok;
      if (ttPlatforms) {
        watcher.updateConfig({
          liveIntervalSeconds: ttPlatforms.liveIntervalSeconds,
          postIntervalSeconds: ttPlatforms.postIntervalSeconds,
          storyIntervalSeconds: ttPlatforms.storyIntervalSeconds,
        });
      }

      res.json({ ok: true, state });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to save workspace state',
      });
    }
  });

  // 0f. TikTok Watcher Status & Health Inspection
  app.get('/api/watcher/status', async (_req, res) => {
    try {
      const health = await watcherStateStore.getHealthStatus();
      const watcherState = await watcherStateStore.getState();
      const seenEventsCount = Object.keys(watcherState.seenEvents || {}).length;
      const trackedUsersCount = Object.keys(watcherState.trackedUsers || {}).length;

      res.json({
        success: true,
        running: watcher.isRunning(),
        health,
        metrics: {
          seenEventsCount,
          trackedUsersCount,
        },
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to retrieve watcher status',
      });
    }
  });

  // 1. Built-in Webhook Sandbox Receiver
  app.post('/api/webhook-sandbox', (req, res) => {
    const sigHeader = String(req.headers['x-pulsebot-signature'] || '');
    const eventHeader = String(req.headers['x-pulsebot-event'] || 'social.keyword.detected');
    const userAgent = String(req.headers['user-agent'] || 'Unknown');
    const channel = String(req.query.channel || 'default');

    const receipt: SandboxWebhookReceipt = {
      id: `rcpt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      receivedAt: new Date().toISOString(),
      channel,
      signatureHeader: sigHeader || 'unsigned',
      signatureVerified: sigHeader.startsWith('sha256='),
      eventHeader,
      userAgent,
      payload: req.body,
    };

    sandboxReceipts.unshift(receipt);
    if (sandboxReceipts.length > 50) {
      sandboxReceipts.length = 50;
    }

    res.status(200).json({
      ok: true,
      server: 'PulseRadar Built-in Sandbox Receiver',
      receiptId: receipt.id,
      receivedAt: receipt.receivedAt,
      signatureVerified: receipt.signatureVerified,
    });
  });

  app.get('/api/webhook-sandbox/logs', (_req, res) => {
    res.json({ receipts: sandboxReceipts });
  });

  app.delete('/api/webhook-sandbox/logs', (_req, res) => {
    sandboxReceipts.length = 0;
    res.json({ ok: true, receipts: [] });
  });

  // 2. Direct Webhook Dispatch & Test Endpoint
  app.post('/api/webhook/dispatch', async (req, res) => {
    const { targetUrl, format = 'json', secretHeader = '', payload } = req.body || {};
    if (!targetUrl || typeof targetUrl !== 'string') {
      res.status(400).json({ error: 'Thiếu URL máy chủ nhận (targetUrl).' });
      return;
    }
    const result = await dispatchWebhookHttp({
      targetUrl,
      format: format as WebhookFormat,
      secretHeader: String(secretHeader || ''),
      payload: (payload && typeof payload === 'object' ? payload : { ping: true }) as Record<
        string,
        unknown
      >,
      port: listeningPort,
    });
    res.json(result);
  });

  // 3. Dedicated Real-Time Live Status Check Endpoint
  app.post('/api/live/check', async (req, res) => {
    try {
      const {
        target,
        targets,
        platform = 'TIKTOK',
        sourceDomain = '',
        cookies = {},
      } = req.body || {};

      const safeCookies: PlatformCookies = {
        tiktok: typeof cookies?.tiktok === 'string' ? cookies.tiktok : '',
        instagram: typeof cookies?.instagram === 'string' ? cookies.instagram : '',
        facebook: typeof cookies?.facebook === 'string' ? cookies.facebook : '',
        x: typeof cookies?.x === 'string' ? cookies.x : '',
      };

      if (typeof target === 'string' && target.trim().length > 0) {
        const result = await checkUserLive(target.trim(), {
          platform: String(platform),
          sourceDomain: String(sourceDomain),
          cookies: safeCookies,
        });
        res.json({
          ok: true,
          checkedAt: new Date().toISOString(),
          result,
        });
        return;
      }

      if (Array.isArray(targets) && targets.length > 0) {
        const batchInputs: BatchLiveTarget[] = targets
          .filter(t => t && typeof t.target === 'string' && t.target.trim().length > 0)
          .map(t => ({
            target: String(t.target).trim(),
            platform: String(t.platform || platform),
            sourceDomain: String(t.sourceDomain || sourceDomain),
            ruleId: t.ruleId ? String(t.ruleId) : undefined,
          }));

        const batchResults = await checkBatchLive(batchInputs, safeCookies, 250);
        res.json({
          ok: true,
          checkedAt: new Date().toISOString(),
          results: batchResults.map(item => ({
            target: item.target,
            ruleId: item.ruleId,
            ...item.result,
          })),
        });
        return;
      }

      res.status(400).json({ ok: false, error: 'Thiếu target hoặc danh sách targets để kiểm tra Live.' });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : 'Live check failed',
      });
    }
  });

  // 4. Unified Scanner Endpoint: Real Live User Scanning (TikTok, Instagram, Facebook, X) + Optional Simulator
  app.post('/api/scan', async (req, res) => {
    try {
      const {
        rules = [],
        servers = [],
        cookies = {},
        specificTargets,
        customSampleText = '',
        simulatedActivityType,
        isAutoScan = false,
        deduplicateLive = true,
      } = req.body || {};

      const activeRules = Array.isArray(rules) ? rules.filter(r => r && r.enabled) : [];
      const serverMap = new Map<
        string,
        { name: string; url: string; format: WebhookFormat; secretHeader: string; enabled: boolean }
      >();
      if (Array.isArray(servers)) {
        for (const s of servers) {
          if (s && s.id) serverMap.set(s.id, s);
        }
      }

      const safeCookies: PlatformCookies = {
        tiktok: typeof cookies?.tiktok === 'string' ? cookies.tiktok : '',
        instagram: typeof cookies?.instagram === 'string' ? cookies.instagram : '',
        facebook: typeof cookies?.facebook === 'string' ? cookies.facebook : '',
        x: typeof cookies?.x === 'string' ? cookies.x : '',
      };

      const detections: Array<{
        ruleId: string;
        keyword: string;
        platform: SocialPlatform;
        author: string;
        title: string;
        contentSnippet: string;
        sourceUrl: string;
        webhookServerName: string;
        webhookStatus: 'delivered' | 'failed' | 'pending';
        httpStatusCode: number;
        latencyMs: number;
        payloadJson: string;
        detectedAt: string;
      }> = [];

      const liveStatuses: LiveTargetScanStatus[] = [];
      const allQueriedSources = new Set<string>();
      let totalTargetsChecked = 0;

      // Branch A: Explicit Event Simulator
      const trimmedSample = typeof customSampleText === 'string' ? customSampleText.trim() : '';
      if (trimmedSample.length > 0) {
        for (const rule of activeRules) {
          const platforms = String(rule.platforms || 'reddit')
            .split(',')
            .map(p => p.trim().toLowerCase() as SocialPlatform)
            .filter(Boolean);
          const primaryPlatform = platforms[0] || 'reddit';
          const { sourceDomain } = parseSourceMeta(String(rule.excludedKeywords || ''), primaryPlatform);
          allQueriedSources.add(`${sourceDomain} (Simulator)`);

          const actType: ActivityEventType =
            simulatedActivityType === 'live' || simulatedActivityType === 'post'
              ? simulatedActivityType
              : trimmedSample.toLowerCase().includes('live')
              ? 'live'
              : 'post';

          const firstTarget = parseTrackedTargets(rule.keyword)[0] || '@creator';
          const livePlatform = resolveLivePlatformForTarget(firstTarget, primaryPlatform, sourceDomain);
          const candidate: SocialPostCandidate = {
            externalId: `sim_${Date.now()}`,
            platform: primaryPlatform,
            author: firstTarget.replace(/^@/, '') || 'creator_stream',
            activityType: actType,
            title:
              actType === 'live'
                ? `ĐANG LIVE [Giả lập]: ${trimmedSample.slice(0, 180)}`
                : `ĐĂNG BÀI MỚI [Giả lập]: ${trimmedSample.slice(0, 180)}`,
            contentSnippet: trimmedSample,
            sourceUrl: `https://${sourceDomain.split('/')[0].trim()}/@${encodeURIComponent(
              firstTarget.replace(/^@/, '')
            )}${actType === 'live' ? '/live' : ''}`,
            publishedAt: new Date().toISOString(),
            livePlatform,
          };

          totalTargetsChecked += 1;

          const matchResult = matchKeywordRule(candidate, {
            keyword: rule.keyword,
            excludedKeywords: rule.excludedKeywords || '',
            matchType: (rule.matchType || 'contains') as MatchType,
            platforms: rule.platforms,
            enabled: Boolean(rule.enabled),
          });

          const effectiveMatchedTerm = matchResult.matched
            ? matchResult.matchedTerm || firstTarget
            : firstTarget;

          const targetServer = serverMap.get(rule.webhookServerId) || {
            name: 'Máy chủ Xử lý Trung tâm (Webhook Sandbox)',
            url: '/api/webhook-sandbox',
            format: 'json' as WebhookFormat,
            secretHeader: 'whsec_pulseradar_default',
            enabled: true,
          };

          const detectedAt = new Date().toISOString();
          const displayKeywordTag = `[${actType === 'live' ? 'PHÁT LIVE' : 'ĐĂNG BÀI'}] ${effectiveMatchedTerm}`.slice(
            0,
            120
          );

          const webhookPayload = buildWebhookPayload(targetServer.format || 'json', {
            ruleId: rule.id,
            keyword: effectiveMatchedTerm,
            matchType: (rule.matchType || 'contains') as MatchType,
            platform: primaryPlatform,
            livePlatform,
            sourceDomain,
            activityType: actType,
            author: candidate.author,
            title: candidate.title,
            contentSnippet: candidate.contentSnippet,
            sourceUrl: candidate.sourceUrl,
            detectedAt,
          });

          const dispatchRes = await dispatchWebhookHttp({
            targetUrl: targetServer.url,
            format: targetServer.format || 'json',
            secretHeader: targetServer.secretHeader || '',
            payload: webhookPayload,
            port: listeningPort,
          });

          detections.push({
            ruleId: rule.id,
            keyword: displayKeywordTag,
            platform: primaryPlatform,
            author: candidate.author,
            title: candidate.title,
            contentSnippet: candidate.contentSnippet,
            sourceUrl: candidate.sourceUrl,
            webhookServerName: targetServer.name,
            webhookStatus: dispatchRes.delivered ? 'delivered' : 'failed',
            httpStatusCode: dispatchRes.httpStatusCode,
            latencyMs: dispatchRes.latencyMs,
            payloadJson: JSON.stringify(webhookPayload, null, 2).slice(0, 3900),
            detectedAt,
          });
        }

        res.json({
          ok: true,
          mode: 'simulator',
          scannedAt: new Date().toISOString(),
          totalRulesEvaluated: activeRules.length,
          totalPostsScanned: totalTargetsChecked,
          liveSourcesQueried: Array.from(allQueriedSources),
          liveStatuses,
          detections,
        });
        return;
      }

      // Branch B: REAL Live User Scanner (TikTok, Instagram, Facebook, X)
      interface RuleScanJob {
        rule: (typeof activeRules)[number];
        primaryPlatform: SocialPlatform;
        sourceDomain: string;
        excludedTerms: string[];
        target: string;
        livePlatform: LivePlatform;
      }

      const jobs: RuleScanJob[] = [];
      const specificTargetFilter =
        Array.isArray(specificTargets) && specificTargets.length > 0
          ? new Set(specificTargets.map(t => String(t).trim()))
          : null;

      for (const rule of activeRules) {
        const platforms = String(rule.platforms || 'reddit')
          .split(',')
          .map(p => p.trim().toLowerCase() as SocialPlatform)
          .filter(Boolean);
        const primaryPlatform = platforms[0] || 'reddit';
        const { sourceDomain, excludedTerms } = parseSourceMeta(
          String(rule.excludedKeywords || ''),
          primaryPlatform
        );
        allQueriedSources.add(sourceDomain);

        const parsedTargets = parseTrackedTargets(String(rule.keyword || ''));
        for (const t of parsedTargets) {
          if (specificTargetFilter && !specificTargetFilter.has(t)) continue;
          if (!isLiveUserTarget(t)) continue;
          const livePlatform = resolveLivePlatformForTarget(t, primaryPlatform, sourceDomain);
          jobs.push({
            rule,
            primaryPlatform,
            sourceDomain,
            excludedTerms,
            target: t,
            livePlatform,
          });
        }
      }

      totalTargetsChecked = jobs.length;

      const liveCheckFn = options.liveCheckBatchFn ?? checkBatchLive;
      const batchResults = await liveCheckFn(
        jobs.map(j => ({
          target: j.target,
          platform: j.livePlatform,
          sourceDomain: j.sourceDomain,
          ruleId: j.rule.id,
        })),
        safeCookies,
        250
      );

      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        const checkItem = batchResults[i];
        const result = checkItem.result;
        const sessionKey = `${job.rule.id}::${result.platform}::${result.username.toLowerCase()}`;

        if (result.status === 'NOT_LIVE') {
          activeLiveSessionMap.delete(sessionKey);
          liveStatuses.push({
            ruleId: job.rule.id,
            target: job.target,
            username: result.username,
            platform: result.platform,
            status: 'NOT_LIVE',
            sourceUrl: result.sourceUrl,
            checkedAt: result.checkedAt,
          });
          continue;
        }

        if (result.status === 'ERROR') {
          liveStatuses.push({
            ruleId: job.rule.id,
            target: job.target,
            username: result.username,
            platform: result.platform,
            status: 'ERROR',
            sourceUrl: result.sourceUrl,
            error: result.message,
            checkedAt: result.checkedAt,
          });
          continue;
        }

        const lowerTitle = `${result.title} ${result.username}`.toLowerCase();
        const isExcluded = job.excludedTerms.some(neg => neg && lowerTitle.includes(neg));

        const prevStreamUrl = activeLiveSessionMap.get(sessionKey);
        const isDuplicateInAutoScan =
          Boolean(isAutoScan) &&
          Boolean(deduplicateLive) &&
          prevStreamUrl !== undefined;

        activeLiveSessionMap.set(sessionKey, result.streamUrl);

        if (isExcluded || isDuplicateInAutoScan) {
          liveStatuses.push({
            ruleId: job.rule.id,
            target: job.target,
            username: result.username,
            platform: result.platform,
            status: 'LIVE',
            title: result.title,
            streamUrl: result.streamUrl,
            sourceUrl: result.sourceUrl,
            qualityInfo: result.qualityInfo,
            method: result.method,
            checkedAt: result.checkedAt,
            webhookDispatched: false,
            deduplicated: isDuplicateInAutoScan,
          });
          continue;
        }

        const targetServer = serverMap.get(job.rule.webhookServerId) || {
          name: 'Máy chủ Xử lý Trung tâm (Webhook Sandbox)',
          url: '/api/webhook-sandbox',
          format: 'json' as WebhookFormat,
          secretHeader: 'whsec_pulseradar_default',
          enabled: true,
        };

        const detectedAt = result.checkedAt;
        const displayKeywordTag = `[PHÁT LIVE] ${job.target}`.slice(0, 120);
        const contentSnippet = [
          `Phát hiện @${result.username} đang PHÁT TRỰC TIẾP trên ${result.platform}.`,
          result.qualityInfo ? `Chất lượng: ${result.qualityInfo}.` : null,
          result.method ? `Phương thức: ${result.method}.` : null,
          `Stream URL: ${result.streamUrl}`,
        ]
          .filter(Boolean)
          .join(' ')
          .slice(0, 1450);

        const webhookPayload = buildWebhookPayload(targetServer.format || 'json', {
          ruleId: job.rule.id,
          keyword: job.target,
          matchType: (job.rule.matchType || 'regex') as MatchType,
          platform: job.primaryPlatform,
          livePlatform: result.platform,
          sourceDomain: job.sourceDomain,
          activityType: 'live',
          author: result.username,
          title: result.title,
          contentSnippet,
          sourceUrl: result.sourceUrl,
          streamUrl: result.streamUrl,
          qualityInfo: result.qualityInfo,
          detectionMethod: result.method,
          detectedAt,
        });

        const dispatchRes = await dispatchWebhookHttp({
          targetUrl: targetServer.url,
          format: targetServer.format || 'json',
          secretHeader: targetServer.secretHeader || '',
          payload: webhookPayload,
          port: listeningPort,
        });

        liveStatuses.push({
          ruleId: job.rule.id,
          target: job.target,
          username: result.username,
          platform: result.platform,
          status: 'LIVE',
          title: result.title,
          streamUrl: result.streamUrl,
          sourceUrl: result.sourceUrl,
          qualityInfo: result.qualityInfo,
          method: result.method,
          checkedAt: result.checkedAt,
          webhookDispatched: dispatchRes.delivered,
        });

        detections.push({
          ruleId: job.rule.id,
          keyword: displayKeywordTag,
          platform: job.primaryPlatform,
          author: result.username,
          title: result.title,
          contentSnippet,
          sourceUrl: result.sourceUrl,
          webhookServerName: targetServer.name,
          webhookStatus: dispatchRes.delivered ? 'delivered' : 'failed',
          httpStatusCode: dispatchRes.httpStatusCode,
          latencyMs: dispatchRes.latencyMs,
          payloadJson: JSON.stringify(webhookPayload, null, 2).slice(0, 3900),
          detectedAt,
        });
      }

      res.json({
        ok: true,
        mode: 'live',
        scannedAt: new Date().toISOString(),
        totalRulesEvaluated: activeRules.length,
        totalPostsScanned: totalTargetsChecked,
        liveSourcesQueried: Array.from(allQueriedSources),
        liveStatuses,
        detections,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : 'Scan execution failed',
      });
    }
  });

  // Mount Vite in dev or static dist in production (skip in tests when mountFrontend === false)
  if (options.mountFrontend !== false) {
    const distPath = path.resolve(__dirname, 'dist');
    if (process.env.NODE_ENV === 'production' && fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.all('/api/*', (_req, res) => {
        res.status(404).json({ ok: false, error: 'Not found' });
      });
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    } else {
      const { createServer: createViteServer } = await import('vite');
      viteServer = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa',
      });
      app.use(viteServer.middlewares);
    }
  }

  return {
    app,
    stateStore,
    androidClient,
    autoScanner,
    watcher,
    watcherStateStore,
    setListeningPort(port: number) {
      listeningPort = port;
    },
    getListeningPort() {
      return listeningPort;
    },
    async close() {
      await autoScanner.stop();
      await watcher.stop();
      if (viteServer) {
        await viteServer.close();
        viteServer = null;
      }
      await stateStore.flush();
      await watcherStateStore.flush();
    },
  };
}

export async function startServer(options: StartServerOptions = {}): Promise<StartedServer> {
  const created = await createApp(options);
  const requestedPort = options.port ?? resolveEnvPort();
  const host = options.host ?? '0.0.0.0';
  const server = http.createServer(created.app);

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(requestedPort, host);
  });

  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : requestedPort;
  created.setListeningPort(boundPort);

  const shouldStartAutoScanner =
    options.startAutoScanner ?? (options.autoScanEnabled ?? process.env.AUTO_SCAN_ENABLED !== 'false');
  if (shouldStartAutoScanner) {
    created.autoScanner.start();
  }

  const shouldStartWatcher =
    options.startWatcher ?? (process.env.WATCHER_ENABLED === 'true');
  if (shouldStartWatcher) {
    created.watcher.start();
  }

  const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${boundPort}`;
  if (options.mountFrontend !== false) {
    console.log(`PulseRadar Live Scanner Server running on http://${host}:${boundPort}`);
  }

  return {
    ...created,
    server,
    port: boundPort,
    url,
    async close() {
      await created.close();
      await new Promise<void>((resolve, reject) => {
        server.close(err => (err ? reject(err) : resolve()));
      });
    },
  };
}

const isMainModule =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]).toLowerCase() === path.resolve(__filename).toLowerCase();

if (isMainModule) {
  void import('dotenv/config')
    .then(() => startServer())
    .then(instance => {
      let closing = false;
      const shutdown = async () => {
        if (closing) return;
        closing = true;
        await instance.close();
        process.exit(0);
      };
      process.once('SIGINT', () => {
        void shutdown();
      });
      process.once('SIGTERM', () => {
        void shutdown();
      });
    })
    .catch(err => {
      console.error('Failed to start PulseRadar server:', err);
      process.exit(1);
    });
}
