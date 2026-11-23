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
  type KeywordRuleItem,
  type WebhookServerItem,
  type SocialPlatform,
  type LivePlatform,
  type MatchType,
  type WebhookFormat,
  type SocialPostCandidate,
  type ActivityEventType,
  type LiveTargetScanStatus,
  type TargetStreamMeta,
} from './src/utils/scannerEngine';
import {
  checkBatchLive,
  checkUserLive,
  detectLivePlatform,
  type BatchLiveTarget,
  type PlatformCookies,
} from './server/liveCheckers/index';
import {
  createStateStore,
  type AndroidState,
  type StateStore,
  type WorkspaceState,
  type PendingRecordCommand,
} from './server/stateStore';
import {
  createWatcherStateStore,
  type WatcherStateStore,
} from './server/watchers/stateStore';
import {
  TikTokWatcher,
  type TikTokWatcherOptions,
} from './server/watchers/tiktokWatcher';
import {
  MultiPlatformWatcher,
  type MultiPlatformWatcherOptions,
} from './server/watchers/multiPlatformWatcher';
import { instagramUserIdCache } from './server/watchers/collectors/instagramShared';
import { Notifier } from './server/watchers/notifier';
import { createMediaDownloader, resolveDriveStorageRoot } from './server/mediaDownloader';
import { createStorageManager } from './server/storage/index';
import type { PendingDeviceNotification, WatcherEvent } from './server/watchers/types';
import {
  createAndroidClient,
  type AndroidClient,
  type AndroidClientOptions,
} from './server/androidClient';
import { createAutoScanner, type AutoScanner } from './server/autoScanner';
import { validateTargetUser } from './server/userValidator';
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
  watcher?: TikTokWatcher | MultiPlatformWatcher;
  startWatcher?: boolean;
  commandTtlMs?: number;
}

export interface CreatedApp {
  app: express.Express;
  stateStore: StateStore;
  androidClient: AndroidClient;
  autoScanner: AutoScanner;
  watcher: TikTokWatcher | MultiPlatformWatcher;
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

function normalizeCookieValue(val: unknown): string {
  return typeof val === 'string' ? val.trim() : '';
}

class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

function normalizeIdArray(raw: unknown, fieldName: string): string[] | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (!Array.isArray(raw)) {
    throw new ValidationError(`Invalid ${fieldName}: must be an array of strings`);
  }
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed.length > 0) {
        seen.add(trimmed);
      }
    }
  }
  return Array.from(seen);
}

function pruneExpiredByTtl(draft: AndroidState, nowMs: number, ttlMs: number): void {
  if (Array.isArray(draft.pendingRecordCommands)) {
    draft.pendingRecordCommands = draft.pendingRecordCommands.filter(cmd => {
      const queuedMs = Date.parse(cmd.queuedAt);
      if (!Number.isFinite(queuedMs)) return true;
      return ttlMs === 0 ? nowMs < queuedMs : nowMs - queuedMs <= ttlMs;
    });
  }
  if (Array.isArray(draft.pendingNotifications)) {
    draft.pendingNotifications = draft.pendingNotifications.filter(notif => {
      const createdMs = Date.parse(notif.createdAt);
      if (!Number.isFinite(createdMs)) return true;
      return ttlMs === 0 ? nowMs < createdMs : nowMs - createdMs <= ttlMs;
    });
  }
}

interface AckResultItem {
  commandId?: string;
  eventId?: string;
  status?: string;
}

function acknowledgePendingCommands(
  draft: AndroidState,
  params: {
    commandIds?: string[];
    eventIds?: string[];
    results?: AckResultItem[];
    nowIso: string;
    callbackUrl?: string;
  }
): { ackedCount: number; alreadyAckedCount: number; remainingPendingCount: number } {
  const commandIdSet = new Set<string>(params.commandIds ?? []);
  const eventIdSet = new Set<string>(params.eventIds ?? []);
  const statusByCommandId = new Map<string, string>();
  const statusByEventId = new Map<string, string>();
  const resultPairs: Array<{ commandId: string; eventId: string }> = [];

  if (Array.isArray(params.results)) {
    for (const item of params.results) {
      const cId = typeof item.commandId === 'string' ? item.commandId.trim() : '';
      const eId = typeof item.eventId === 'string' ? item.eventId.trim() : '';
      const st = typeof item.status === 'string' ? item.status.trim() : '';
      if (cId) {
        commandIdSet.add(cId);
        if (st) statusByCommandId.set(cId, st);
      }
      if (eId) {
        eventIdSet.add(eId);
        if (st) statusByEventId.set(eId, st);
      }
      if (cId || eId) {
        resultPairs.push({ commandId: cId, eventId: eId });
      }
    }
  }

  const recentAcked = Array.isArray(draft.recentAckedCommandIds)
    ? [...draft.recentAckedCommandIds]
    : [];
  const recentAckedSet = new Set<string>(recentAcked);

  const existingPending = Array.isArray(draft.pendingRecordCommands)
    ? draft.pendingRecordCommands
    : [];
  const remaining: PendingRecordCommand[] = [];
  const matchedIds = new Set<string>();

  let ackedCount = 0;
  let alreadyAckedCount = 0;

  for (const cmd of existingPending) {
    const cmdId = typeof cmd.commandId === 'string' ? cmd.commandId.trim() : '';
    const evtId = typeof cmd.eventId === 'string' ? cmd.eventId.trim() : '';
    const isMatched =
      (cmdId.length > 0 && commandIdSet.has(cmdId)) ||
      (evtId.length > 0 && eventIdSet.has(evtId));

    if (!isMatched) {
      remaining.push(cmd);
      continue;
    }

    if (cmdId) matchedIds.add(cmdId);
    if (evtId) matchedIds.add(evtId);

    const wasAlreadyAcked =
      (cmdId.length > 0 && recentAckedSet.has(cmdId)) ||
      (evtId.length > 0 && recentAckedSet.has(evtId));

    if (wasAlreadyAcked) {
      alreadyAckedCount += 1;
      continue;
    }

    ackedCount += 1;
    draft.activeSessions[cmd.canonicalKey] = cmd.streamUrl;

    const reportedStatus =
      (cmdId && statusByCommandId.get(cmdId)) ||
      (evtId && statusByEventId.get(evtId)) ||
      'RECORDING_TRIGGERED';

    draft.recentDispatches.unshift({
      eventId: cmd.eventId,
      canonicalKey: cmd.canonicalKey,
      platform: cmd.platform,
      username: cmd.username,
      streamUrl: cmd.streamUrl,
      callbackUrl: params.callbackUrl ?? 'ACTIVE_POLL_ACK',
      dispatchedAt: params.nowIso,
      ok: true,
      httpStatus: 200,
      androidStatus: reportedStatus,
      error: null,
      attempts: Math.max(1, cmd.deliveryAttempts ?? 1),
    });

    if (cmdId && !recentAckedSet.has(cmdId)) {
      recentAcked.push(cmdId);
      recentAckedSet.add(cmdId);
    }
    if (evtId && !recentAckedSet.has(evtId)) {
      recentAcked.push(evtId);
      recentAckedSet.add(evtId);
    }
  }

  const checkedDuplicateIds = new Set<string>();
  for (const pair of resultPairs) {
    const cMatched = pair.commandId && matchedIds.has(pair.commandId);
    const eMatched = pair.eventId && matchedIds.has(pair.eventId);
    if (!cMatched && !eMatched) {
      const cDup = pair.commandId && recentAckedSet.has(pair.commandId);
      const eDup = pair.eventId && recentAckedSet.has(pair.eventId);
      if (cDup || eDup) {
        alreadyAckedCount += 1;
      }
    }
    if (pair.commandId) checkedDuplicateIds.add(pair.commandId);
    if (pair.eventId) checkedDuplicateIds.add(pair.eventId);
  }

  for (const id of commandIdSet) {
    if (!matchedIds.has(id) && !checkedDuplicateIds.has(id) && recentAckedSet.has(id)) {
      alreadyAckedCount += 1;
      checkedDuplicateIds.add(id);
    }
  }
  for (const id of eventIdSet) {
    if (!matchedIds.has(id) && !checkedDuplicateIds.has(id) && recentAckedSet.has(id)) {
      alreadyAckedCount += 1;
      checkedDuplicateIds.add(id);
    }
  }

  draft.pendingRecordCommands = remaining;
  if (draft.recentDispatches.length > 50) {
    draft.recentDispatches.length = 50;
  }
  draft.recentAckedCommandIds = recentAcked.slice(-200);
  if (ackedCount > 0) {
    draft.scannerRuntime.lastDispatchAt = params.nowIso;
    draft.scannerRuntime.lastDispatchError = null;
  }

  return {
    ackedCount,
    alreadyAckedCount,
    remainingPendingCount: remaining.length,
  };
}

function acknowledgeNotifications(draft: AndroidState, notificationIds: string[]): void {
  if (notificationIds.length === 0 || !Array.isArray(draft.pendingNotifications)) {
    return;
  }
  const idSet = new Set(notificationIds);
  draft.pendingNotifications = draft.pendingNotifications.filter(n => !idSet.has(n.id));
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

export async function createApp(options: CreateAppOptions = {}): Promise<CreatedApp> {
  const app = express();
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });
  app.use(express.json({ limit: '1mb' }));

  const dataDir = options.dataDir ?? path.resolve(__dirname, 'data');
  const stateStore: StateStore = createStateStore(dataDir);

  const watcherStateStore =
    options.watcherStateStore ??
    createWatcherStateStore(path.resolve(dataDir, 'watcher-state.json'));

  const driveStorageRoot = resolveDriveStorageRoot();

  const commandTtlMs =
    typeof options.commandTtlMs === 'number' &&
    Number.isFinite(options.commandTtlMs) &&
    options.commandTtlMs >= 0
      ? options.commandTtlMs
      : 30 * 60 * 1000;

  // Instance-scoped state (never shared across tests/app instances)
  const sandboxReceipts: SandboxWebhookReceipt[] = [];
  const activeLiveSessionMap = new Map<string, string>();
  let listeningPort = resolveEnvPort();
  let viteServer: ViteDevServer | null = null;
  let latestWorkspaceRules: KeywordRuleItem[] = [];
  let latestWorkspaceServers: WebhookServerItem[] = [];

  const defaultEnvCookies: Required<PlatformCookies> = {
    tiktok: normalizeCookieValue(options.envCookies?.tiktok ?? process.env.TIKTOK_COOKIE ?? process.env.TIKTOK_SESSION_ID),
    instagram: normalizeCookieValue(options.envCookies?.instagram ?? process.env.INSTAGRAM_COOKIE ?? process.env.INSTAGRAM_SESSION_ID),
    facebook: normalizeCookieValue(options.envCookies?.facebook ?? process.env.FACEBOOK_COOKIE),
    x: normalizeCookieValue(options.envCookies?.x ?? process.env.X_COOKIE ?? process.env.TWITTER_COOKIE),
  };

  function createWebhookTargetResolver(
    getRules: () => KeywordRuleItem[],
    getServers: () => WebhookServerItem[]
  ) {
    return (event: WatcherEvent) => {
      const targetPlatform = String(event.platform || 'TIKTOK').toUpperCase() as LivePlatform;
      const targetUser =
        canonicalizeUsername(event.username || '', targetPlatform) ||
        String(event.username || '').replace(/^@+/, '').toLowerCase();
      const serverById = new Map<string, WebhookServerItem>();
      for (const srv of getServers()) {
        if (srv && srv.id) serverById.set(srv.id, srv);
      }
      let fallbackRule: KeywordRuleItem | null = null;
      for (const rule of getRules()) {
        if (!rule || !rule.enabled) continue;
        const users = extractAuthoritativeUsers([rule], {});
        const platformUsers = users.filter(u => u.platform === targetPlatform);
        if (platformUsers.length === 0) continue;
        if (platformUsers.some(u => u.username.toLowerCase() === targetUser)) {
          const srv = serverById.get(rule.webhookServerId);
          if (srv && srv.enabled && srv.url?.trim()) {
            return {
              url: srv.url.trim(),
              format: srv.format,
              secretHeader: srv.secretHeader,
              ruleId: rule.id,
              matchType: rule.matchType,
            };
          }
          return null;
        }
        if (!fallbackRule) fallbackRule = rule;
      }
      if (fallbackRule) {
        const srv = serverById.get(fallbackRule.webhookServerId);
        if (srv && srv.enabled && srv.url?.trim()) {
          return {
            url: srv.url.trim(),
            format: srv.format,
            secretHeader: srv.secretHeader,
            ruleId: fallbackRule.id,
            matchType: fallbackRule.matchType,
          };
        }
      }
      return null;
    };
  }

  async function pushPendingAndroidNotification(notif: PendingDeviceNotification): Promise<void> {
    await stateStore.updateAndroidState(st => {
      if (!Array.isArray(st.pendingNotifications)) {
        st.pendingNotifications = [];
      }
      st.pendingNotifications.push(notif);
      if (st.pendingNotifications.length > 100) {
        st.pendingNotifications = st.pendingNotifications.slice(-100);
      }
    });
  }

  const watcherMediaDownloader = createMediaDownloader({
    storageRoot: driveStorageRoot,
    cookies: { ...defaultEnvCookies },
  });

  const watcherNotifier = new Notifier({
    localBaseUrl: `http://127.0.0.1:${listeningPort}`,
    resolveWebhookTarget: createWebhookTargetResolver(
      () => latestWorkspaceRules,
      () => latestWorkspaceServers
    ),
    onPendingNotification: pushPendingAndroidNotification,
  });

  const watcher =
    options.watcher ??
    new MultiPlatformWatcher({
      config: {
        targetsByPlatform: { TIKTOK: [], INSTAGRAM: [], FACEBOOK: [], X: [] },
        cookies: { ...defaultEnvCookies },
        enableWarmup: true,
        autoDownloadMedia: true,
        driveStorageRoot,
      },
      stateStore: watcherStateStore,
      mediaDownloader: watcherMediaDownloader,
      notifier: watcherNotifier,
    });

  function syncNotifierConfig(
    rules: KeywordRuleItem[],
    servers: WebhookServerItem[],
    androidCallbackUrl?: string | null
  ): void {
    latestWorkspaceRules = Array.isArray(rules) ? [...rules] : [];
    latestWorkspaceServers = Array.isArray(servers) ? [...servers] : [];
    const firstEnabledServer = latestWorkspaceServers.find(
      s => s && s.enabled && typeof s.url === 'string' && s.url.trim()
    );
    watcherNotifier.updateConfig({
      webhookUrl: firstEnabledServer?.url?.trim() || undefined,
      webhookFormat: firstEnabledServer?.format,
      secretHeader: firstEnabledServer?.secretHeader,
      ...(androidCallbackUrl !== undefined
        ? { androidCallbackUrl: androidCallbackUrl || undefined }
        : {}),
    });
    if (!options.watcher && androidCallbackUrl !== undefined) {
      watcher.updateConfig({ androidCallbackUrl: androidCallbackUrl || undefined } as any);
    }
  }

  function syncWatcherTargetsFromState(
    rules: KeywordRuleItem[],
    targetStreamMetaMap?: Record<string, TargetStreamMeta>
  ): void {
    const authoritative = extractAuthoritativeUsers(rules, {});
    const targetsByPlatform: Record<LivePlatform, string[]> = {
      TIKTOK: [],
      INSTAGRAM: [],
      FACEBOOK: [],
      X: [],
    };
    for (const u of authoritative) {
      if (u.isEnabled && targetsByPlatform[u.platform as LivePlatform]) {
        targetsByPlatform[u.platform as LivePlatform].push(u.username);
      }
    }
    if (typeof (watcher as any).setTargetsByPlatform === 'function') {
      (watcher as any).setTargetsByPlatform(targetsByPlatform);
    }
    watcher.setTargetUsers?.(targetsByPlatform.TIKTOK);

    const targetRuleMap: Record<string, string> = {};
    for (const rule of rules) {
      if (!rule || !rule.enabled) continue;
      const users = extractAuthoritativeUsers([rule], {});
      for (const u of users) {
        const key = `${u.platform}::${u.username.toLowerCase()}`;
        if (!targetRuleMap[key]) {
          targetRuleMap[key] = rule.id;
        }
      }
    }
    if (typeof (watcher as any).setTargetStreamConfig === 'function') {
      (watcher as any).setTargetStreamConfig(targetStreamMetaMap, targetRuleMap);
    }
  }

  // Synchronize initial target users and watcher configuration from workspace state
  try {
    const [initialState, initialAndroid] = await Promise.all([
      stateStore.readWorkspaceStateIfExists(),
      stateStore.readAndroidState().catch(() => null),
    ]);
    syncNotifierConfig(
      initialState?.rules ?? [],
      initialState?.servers ?? [],
      initialAndroid?.device?.callbackUrl ?? undefined
    );
    if (initialState?.rules) {
      syncWatcherTargetsFromState(initialState.rules, initialState.targetStreamMetaMap);
    } else if (initialState?.targetStreamMetaMap && typeof (watcher as any).setTargetStreamConfig === 'function') {
      (watcher as any).setTargetStreamConfig(initialState.targetStreamMetaMap, {});
    }
    const wsCookies: Partial<PlatformCookies> = initialState?.scannerSettings?.cookies ?? {};
    const mergedCookies: Required<PlatformCookies> = {
      tiktok: normalizeCookieValue(wsCookies.tiktok) || defaultEnvCookies.tiktok,
      instagram: normalizeCookieValue(wsCookies.instagram) || defaultEnvCookies.instagram,
      facebook: normalizeCookieValue(wsCookies.facebook) || defaultEnvCookies.facebook,
      x: normalizeCookieValue(wsCookies.x) || defaultEnvCookies.x,
    };
    if (mergedCookies.tiktok || mergedCookies.instagram || mergedCookies.facebook || mergedCookies.x || initialState?.scannerSettings?.cookies) {
      if (typeof (watcher as any).updateCookies === 'function') {
        (watcher as any).updateCookies(mergedCookies);
      }
      watcher.updateConfig({
        tiktokSessionId: mergedCookies.tiktok,
        cookies: mergedCookies,
      } as any);
    }
    const platformsCfg = initialState?.scannerSettings?.platforms;
    if (platformsCfg) {
      watcher.updateConfig({
        platformSettings: platformsCfg,
        liveIntervalSeconds: platformsCfg.tiktok?.liveIntervalSeconds,
        postIntervalSeconds: platformsCfg.tiktok?.postIntervalSeconds,
        storyIntervalSeconds: platformsCfg.tiktok?.storyIntervalSeconds,
      } as any);
    }
    const teleCfg = initialState?.scannerSettings?.telegram;
    if (teleCfg) {
      watcherMediaDownloader
        .getStorageManager()
        .getTelegramService()
        .updateConfig({
          botToken: teleCfg.botToken,
          chatId: teleCfg.chatId,
          enabled: teleCfg.enabled,
        });
    }
    if (initialState?.targetProfiles) {
      for (const [key, profile] of Object.entries(initialState.targetProfiles)) {
        if (key.startsWith('INSTAGRAM::') && (profile as any)?.id) {
          const uname = key.slice(11).toLowerCase();
          instagramUserIdCache.set(uname, String((profile as any).id));
        }
      }
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

      watcherNotifier.updateConfig({ androidCallbackUrl: callbackUrl });
      if (!options.watcher) {
        watcher.updateConfig({ androidCallbackUrl: callbackUrl } as any);
      }

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

      let ackedCommandIds: string[] | null = null;
      let ackedEventIds: string[] | null = null;
      let ackedNotificationIds: string[] | null = null;
      try {
        ackedCommandIds = normalizeIdArray(req.body.ackedCommandIds, 'ackedCommandIds');
        ackedEventIds = normalizeIdArray(req.body.ackedEventIds, 'ackedEventIds');
        ackedNotificationIds = normalizeIdArray(req.body.ackedNotificationIds, 'ackedNotificationIds');
      } catch (validationErr) {
        res.status(400).json({
          ok: false,
          error: validationErr instanceof Error ? validationErr.message : 'Invalid ACK fields',
        });
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

        if ((ackedCommandIds && ackedCommandIds.length > 0) || (ackedEventIds && ackedEventIds.length > 0)) {
          acknowledgePendingCommands(draft, {
            commandIds: ackedCommandIds ?? [],
            eventIds: ackedEventIds ?? [],
            nowIso,
            callbackUrl: 'ANDROID_SYNC_PIGGYBACK_ACK',
          });
        }
        if (ackedNotificationIds && ackedNotificationIds.length > 0) {
          acknowledgeNotifications(draft, ackedNotificationIds);
        }
      });

      const clientSupportsNotifAck =
        req.body.supportsNotificationAck === true ||
        Array.isArray(req.body.ackedNotificationIds);

      const ws = await stateStore.readWorkspaceState();
      const authoritativeUsers = extractAuthoritativeUsers(
        ws.rules,
        updatedAndroidState.liveStatusMap
      );
      const reconcileResult = reconcileAndroidSync(authoritativeUsers, validatedUsers, {
        syncedAt: nowIso,
        nowMs,
      });

      if (updatedAndroidState.device?.callbackUrl) {
        watcherNotifier.updateConfig({ androidCallbackUrl: updatedAndroidState.device.callbackUrl });
        if (!options.watcher) {
          watcher.updateConfig({ androidCallbackUrl: updatedAndroidState.device.callbackUrl } as any);
        }
      }

      let deliveredNotifications: PendingDeviceNotification[] = [];
      await stateStore.updateAndroidState(draft => {
        pruneExpiredByTtl(draft, nowMs, commandTtlMs);
        if (Array.isArray(draft.pendingNotifications) && draft.pendingNotifications.length > 0) {
          deliveredNotifications = draft.pendingNotifications.map(n => ({ ...n }));
          if (!clientSupportsNotifAck) {
            draft.pendingNotifications = [];
          }
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

  // 0d-0. High-Frequency Active Device Polling (Outbound Pull for Real-Time Live Recording Commands)
  const handleAndroidPoll = async (req: express.Request, res: express.Response) => {
    try {
      const bodyObj = isPlainObject(req.body) ? req.body : null;
      if (
        req.method === 'POST' &&
        req.body !== undefined &&
        req.body !== null &&
        !bodyObj
      ) {
        res.status(400).json({ ok: false, error: 'Invalid JSON body' });
        return;
      }

      if (
        bodyObj &&
        bodyObj.deviceId !== undefined &&
        bodyObj.deviceId !== null &&
        typeof bodyObj.deviceId !== 'string'
      ) {
        res.status(400).json({ ok: false, error: 'Invalid deviceId' });
        return;
      }

      let ackedCommandIds: string[] | null = null;
      let ackedEventIds: string[] | null = null;
      let ackedNotificationIds: string[] | null = null;
      if (bodyObj) {
        try {
          ackedCommandIds = normalizeIdArray(bodyObj.ackedCommandIds, 'ackedCommandIds');
          ackedEventIds = normalizeIdArray(bodyObj.ackedEventIds, 'ackedEventIds');
          ackedNotificationIds = normalizeIdArray(bodyObj.ackedNotificationIds, 'ackedNotificationIds');
        } catch (validationErr) {
          res.status(400).json({
            ok: false,
            error: validationErr instanceof Error ? validationErr.message : 'Invalid ACK fields',
          });
          return;
        }
      }

      const explicitDeviceId =
        typeof bodyObj?.deviceId === 'string'
          ? bodyObj.deviceId.trim()
          : typeof req.query?.deviceId === 'string'
          ? (req.query.deviceId as string).trim()
          : '';

      const existingAndroidState = await stateStore.readAndroidState();
      const candidateDeviceId =
        explicitDeviceId || existingAndroidState.device?.deviceId || 'sm_n770f_default';

      const allowedIds = existingAndroidState.allowedDeviceIds || ['sm_n770f_default'];
      if (
        allowedIds.length > 0 &&
        !allowedIds.includes('*') &&
        !allowedIds.includes(candidateDeviceId)
      ) {
        res.status(403).json({ ok: false, error: 'Device not authorized' });
        return;
      }

      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      let deliveredCommands: PendingRecordCommand[] = [];
      let deliveredNotifications: PendingDeviceNotification[] = [];

      await stateStore.updateAndroidState(draft => {
        if (draft.device) {
          draft.device.lastSeenAt = nowIso;
        }

        if ((ackedCommandIds && ackedCommandIds.length > 0) || (ackedEventIds && ackedEventIds.length > 0)) {
          acknowledgePendingCommands(draft, {
            commandIds: ackedCommandIds ?? [],
            eventIds: ackedEventIds ?? [],
            nowIso,
            callbackUrl: 'ACTIVE_POLL_PIGGYBACK_ACK',
          });
        }

        if (ackedNotificationIds && ackedNotificationIds.length > 0) {
          acknowledgeNotifications(draft, ackedNotificationIds);
        }

        pruneExpiredByTtl(draft, nowMs, commandTtlMs);

        if (Array.isArray(draft.pendingRecordCommands) && draft.pendingRecordCommands.length > 0) {
          deliveredCommands = draft.pendingRecordCommands.map(cmd => {
            const nextAttempts = (typeof cmd.deliveryAttempts === 'number' ? cmd.deliveryAttempts : 0) + 1;
            cmd.deliveryAttempts = nextAttempts;
            cmd.lastDeliveredAt = nowIso;
            return { ...cmd };
          });
        }

        if (Array.isArray(draft.pendingNotifications) && draft.pendingNotifications.length > 0) {
          deliveredNotifications = draft.pendingNotifications.map(n => ({ ...n }));
        }
      });

      res.status(200).json({
        ok: true,
        serverTime: nowIso,
        commands: deliveredCommands,
        notifications: deliveredNotifications,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to poll Android commands',
      });
    }
  };

  app.post('/api/android/poll', handleAndroidPoll);
  app.get('/api/android/poll', handleAndroidPoll);

  app.post('/api/android/poll/ack', async (req, res) => {
    try {
      if (!isPlainObject(req.body)) {
        res.status(400).json({ ok: false, error: 'Invalid JSON body' });
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

      let commandIds: string[] | null = null;
      let eventIds: string[] | null = null;
      let notificationIds: string[] | null = null;
      try {
        commandIds = normalizeIdArray(req.body.commandIds, 'commandIds');
        eventIds = normalizeIdArray(req.body.eventIds, 'eventIds');
        notificationIds = normalizeIdArray(req.body.notificationIds, 'notificationIds');
      } catch (validationErr) {
        res.status(400).json({
          ok: false,
          error: validationErr instanceof Error ? validationErr.message : 'Invalid ACK arrays',
        });
        return;
      }

      let parsedResults: AckResultItem[] | null = null;
      if (req.body.results !== undefined && req.body.results !== null) {
        if (!Array.isArray(req.body.results)) {
          res.status(400).json({ ok: false, error: 'Invalid results: must be an array' });
          return;
        }
        parsedResults = [];
        for (let i = 0; i < req.body.results.length; i++) {
          const entry = req.body.results[i];
          if (!isPlainObject(entry)) {
            res.status(400).json({ ok: false, error: `Invalid results[${i}]: must be an object` });
            return;
          }
          parsedResults.push({
            commandId: typeof entry.commandId === 'string' ? entry.commandId : undefined,
            eventId: typeof entry.eventId === 'string' ? entry.eventId : undefined,
            status: typeof entry.status === 'string' ? entry.status : undefined,
          });
        }
      }

      if (
        commandIds === null &&
        eventIds === null &&
        notificationIds === null &&
        parsedResults === null
      ) {
        res.status(400).json({
          ok: false,
          error: 'Missing commandIds, eventIds, notificationIds, or results array',
        });
        return;
      }

      const existingAndroidState = await stateStore.readAndroidState();
      const explicitDeviceId =
        typeof req.body.deviceId === 'string' ? req.body.deviceId.trim() : '';
      const candidateDeviceId =
        explicitDeviceId || existingAndroidState.device?.deviceId || 'sm_n770f_default';

      const allowedIds = existingAndroidState.allowedDeviceIds || ['sm_n770f_default'];
      if (
        allowedIds.length > 0 &&
        !allowedIds.includes('*') &&
        !allowedIds.includes(candidateDeviceId)
      ) {
        res.status(403).json({ ok: false, error: 'Device not authorized' });
        return;
      }

      const nowIso = new Date().toISOString();
      let ackResult = { ackedCount: 0, alreadyAckedCount: 0, remainingPendingCount: 0 };

      await stateStore.updateAndroidState(draft => {
        if (draft.device) {
          draft.device.lastSeenAt = nowIso;
        }
        ackResult = acknowledgePendingCommands(draft, {
          commandIds: commandIds ?? [],
          eventIds: eventIds ?? [],
          results: parsedResults ?? [],
          nowIso,
          callbackUrl: 'ACTIVE_POLL_ACK',
        });
        if (notificationIds && notificationIds.length > 0) {
          acknowledgeNotifications(draft, notificationIds);
        }
      });

      res.status(200).json({
        ok: true,
        ackedCount: ackResult.ackedCount,
        alreadyAckedCount: ackResult.alreadyAckedCount,
        remainingPendingCount: ackResult.remainingPendingCount,
        serverTime: nowIso,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to acknowledge Android poll commands',
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

  // 0d-3b. Multi-Cloud Storage Status (Google Drive API & Telegram)
  app.get('/api/storage/status', (_req, res) => {
    try {
      const storageManager = watcherMediaDownloader.getStorageManager();
      res.json({ ok: true, status: storageManager.getStatus() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 0d-3c. Test Telegram Bot Connection & Optional Save
  app.post('/api/storage/telegram/test', async (req, res) => {
    try {
      const body = isPlainObject(req.body) ? req.body : {};
      const botToken = typeof body.botToken === 'string' ? body.botToken.trim() : undefined;
      const chatId = typeof body.chatId === 'string' ? body.chatId.trim() : undefined;
      const saveIfOk = body.save === true;

      const telegramService = watcherMediaDownloader.getStorageManager().getTelegramService();
      const testRes = await telegramService.testConnection({ botToken, chatId });

      if (testRes.ok && saveIfOk && botToken && chatId) {
        telegramService.updateConfig({ botToken, chatId, enabled: true });
        const existingWs = await stateStore.readWorkspaceState();
        await stateStore.writeWorkspaceState({
          ...existingWs,
          scannerSettings: {
            ...existingWs.scannerSettings,
            telegram: {
              botToken,
              chatId,
              enabled: true,
            },
          },
        });
      }

      res.json({
        ...testRes,
        status: watcherMediaDownloader.getStorageManager().getStatus(),
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 0d-3d. Manual Push Downloaded Local File to Cloud (Telegram / Google Drive)
  app.post('/api/media/push-cloud', async (req, res) => {
    try {
      const body = isPlainObject(req.body) ? req.body : {};
      const rawUsername = typeof body.username === 'string' ? body.username.trim() : '';
      const rawType = typeof body.eventType === 'string' ? body.eventType.trim() : '';
      const rawFileName = typeof body.fileName === 'string' ? body.fileName.trim() : '';

      if (!rawUsername || !rawType || !rawFileName) {
        res.status(400).json({ ok: false, error: 'Missing username, eventType, or fileName' });
        return;
      }

      const rootDir = resolveDriveStorageRoot();
      const safeUser = path.basename(rawUsername);
      const safeType = path.basename(rawType);
      const safeFile = path.basename(rawFileName);
      const targetPath = path.join(rootDir, safeUser, safeType, safeFile);

      if (!fs.existsSync(targetPath)) {
        res.status(404).json({ ok: false, error: 'File not found on server disk' });
        return;
      }

      const stat = fs.statSync(targetPath);
      const lower = safeFile.toLowerCase();
      const mimeType = lower.endsWith('.mp4')
        ? 'video/mp4'
        : lower.endsWith('.png')
        ? 'image/png'
        : lower.endsWith('.webp')
        ? 'image/webp'
        : 'image/jpeg';
      const platform: LivePlatform = lower.startsWith('instagram_')
        ? 'INSTAGRAM'
        : lower.startsWith('facebook_')
        ? 'FACEBOOK'
        : lower.startsWith('x_')
        ? 'X'
        : 'TIKTOK';
      const normEventType = safeType === 'stories' || safeType === 'story' ? 'story' : 'post';

      const storageManager = watcherMediaDownloader.getStorageManager();
      const uploadResult = await storageManager.uploadMedia({
        platform,
        localFilePath: targetPath,
        fileName: safeFile,
        fileSize: stat.size,
        mimeType,
        username: safeUser,
        eventType: normEventType,
        title: `${normEventType.toUpperCase()} từ @${safeUser} (${safeFile})`,
      });

      const failedProviders = uploadResult.results.filter(
        r => !r.success && r.provider !== 'local'
      );
      const anyCloudSuccess = uploadResult.results.some(
        r => (r.provider === 'telegram' || r.provider === 'google_drive') && r.success
      );

      res.json({
        ok: anyCloudSuccess,
        uploadResult,
        error:
          failedProviders.length > 0
            ? failedProviders.map(f => `${f.provider}: ${f.error}`).join('; ')
            : !anyCloudSuccess
            ? 'Chưa cấu hình Telegram Bot hoặc Google Drive API.'
            : undefined,
      });
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
      if (body.targetProfiles !== undefined && !isPlainObject(body.targetProfiles)) {
        res.status(400).json({ ok: false, error: 'Invalid workspace state targetProfiles map' });
        return;
      }
      if (body.targetStreamMetaMap !== undefined && !isPlainObject(body.targetStreamMetaMap)) {
        res.status(400).json({ ok: false, error: 'Invalid workspace state targetStreamMetaMap map' });
        return;
      }

      const state = await stateStore.writeWorkspaceState(body);

      // Update watcher targets, notifier servers, and configuration from saved workspace state
      syncNotifierConfig(state.rules ?? [], state.servers ?? []);
      if (Array.isArray(state.rules)) {
        syncWatcherTargetsFromState(state.rules, state.targetStreamMetaMap);
      } else if (state.targetStreamMetaMap && typeof (watcher as any).setTargetStreamConfig === 'function') {
        (watcher as any).setTargetStreamConfig(state.targetStreamMetaMap, {});
      }
      const wsCookies: Partial<PlatformCookies> = state.scannerSettings?.cookies ?? {};
      const mergedCookies: Required<PlatformCookies> = {
        tiktok: normalizeCookieValue(wsCookies.tiktok) || defaultEnvCookies.tiktok,
        instagram: normalizeCookieValue(wsCookies.instagram) || defaultEnvCookies.instagram,
        facebook: normalizeCookieValue(wsCookies.facebook) || defaultEnvCookies.facebook,
        x: normalizeCookieValue(wsCookies.x) || defaultEnvCookies.x,
      };
      if (mergedCookies.tiktok || mergedCookies.instagram || mergedCookies.facebook || mergedCookies.x || state.scannerSettings?.cookies) {
        if (typeof (watcher as any).updateCookies === 'function') {
          (watcher as any).updateCookies(mergedCookies);
        }
        watcher.updateConfig({
          tiktokSessionId: mergedCookies.tiktok,
          cookies: mergedCookies,
        } as any);
      }
      const platformsCfg = state.scannerSettings?.platforms;
      if (platformsCfg) {
        watcher.updateConfig({
          platformSettings: platformsCfg,
          liveIntervalSeconds: platformsCfg.tiktok?.liveIntervalSeconds,
          postIntervalSeconds: platformsCfg.tiktok?.postIntervalSeconds,
          storyIntervalSeconds: platformsCfg.tiktok?.storyIntervalSeconds,
        } as any);
      }
      const teleCfg = state.scannerSettings?.telegram;
      if (teleCfg) {
        watcherMediaDownloader
          .getStorageManager()
          .getTelegramService()
          .updateConfig({
            botToken: teleCfg.botToken,
            chatId: teleCfg.chatId,
            enabled: teleCfg.enabled,
          });
      }
      if (state.targetProfiles) {
        for (const [key, profile] of Object.entries(state.targetProfiles)) {
          if (key.startsWith('INSTAGRAM::') && (profile as any)?.id) {
            const uname = key.slice(11).toLowerCase();
            instagramUserIdCache.set(uname, String((profile as any).id));
          }
        }
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

      const diagnostics = typeof (watcher as any).getDiagnostics === 'function'
        ? (watcher as any).getDiagnostics()
        : [];
      const platforms = typeof (watcher as any).getPlatformsSummary === 'function'
        ? (watcher as any).getPlatformsSummary()
        : {};

      res.json({
        success: true,
        running: watcher.isRunning(),
        health,
        metrics: {
          seenEventsCount,
          trackedUsersCount,
        },
        diagnostics,
        platforms,
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

  // 2b. Dedicated User Existence & Syntax Validation Endpoint
  app.post('/api/user/validate', async (req, res) => {
    try {
      const body = isPlainObject(req.body) ? req.body : {};
      const target = body.target;
      if (typeof target !== 'string' || !target.trim()) {
        res.status(400).json({ ok: false, error: 'Target username is required' });
        return;
      }

      const trimmedTarget = target.trim();
      const rawPlatform =
        typeof body.platform === 'string' && body.platform.trim()
          ? body.platform.trim()
          : 'TIKTOK';
      const isAnonymous = body.anonymous === true;
      const resolvedPlatform = detectLivePlatform(trimmedTarget, rawPlatform);

      const PLATFORM_TO_COOKIE_KEY: Record<LivePlatform, keyof PlatformCookies> = {
        TIKTOK: 'tiktok',
        INSTAGRAM: 'instagram',
        FACEBOOK: 'facebook',
        X: 'x',
      };
      const PLATFORM_TO_ENV_VAR: Record<LivePlatform, string> = {
        TIKTOK: 'TIKTOK_COOKIE',
        INSTAGRAM: 'INSTAGRAM_COOKIE',
        FACEBOOK: 'FACEBOOK_COOKIE',
        X: 'X_COOKIE',
      };

      const cookieKey = PLATFORM_TO_COOKIE_KEY[resolvedPlatform];
      let resolvedCookie = '';
      if (!isAnonymous) {
        const explicitCookie = normalizeCookieValue(body.cookie);
        let wsCookie = '';
        if (!explicitCookie) {
          const ws = await stateStore.readWorkspaceStateIfExists();
          wsCookie = normalizeCookieValue(ws?.scannerSettings?.cookies?.[cookieKey]);
        }
        const envOptionCookie = normalizeCookieValue(options.envCookies?.[cookieKey]);
        const processEnvCookie = normalizeCookieValue(
          process.env[PLATFORM_TO_ENV_VAR[resolvedPlatform]]
        );
        resolvedCookie = explicitCookie || wsCookie || envOptionCookie || processEnvCookie;
      }

      const result = await validateTargetUser(trimmedTarget, resolvedPlatform, resolvedCookie);
      res.json({
        ok: true,
        result: {
          ...result,
          authMode: result.authMode ?? (resolvedCookie ? 'cookie' : 'anonymous'),
        },
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
        tiktok: typeof cookies?.tiktok === 'string' ? cookies.tiktok.trim() : '',
        instagram: typeof cookies?.instagram === 'string' ? cookies.instagram.trim() : '',
        facebook: typeof cookies?.facebook === 'string' ? cookies.facebook.trim() : '',
        x: typeof cookies?.x === 'string' ? cookies.x.trim() : '',
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
        activityType,
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
        tiktok: typeof cookies?.tiktok === 'string' ? cookies.tiktok.trim() : '',
        instagram: typeof cookies?.instagram === 'string' ? cookies.instagram.trim() : '',
        facebook: typeof cookies?.facebook === 'string' ? cookies.facebook.trim() : '',
        x: typeof cookies?.x === 'string' ? cookies.x.trim() : '',
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
            simulatedActivityType === 'live' ||
            simulatedActivityType === 'post' ||
            simulatedActivityType === 'story'
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

      // Branch C: REAL Post / Story Collector Scan via MultiPlatformWatcher
      if (activityType === 'post' || activityType === 'story') {
        const specificTargetFilter =
          Array.isArray(specificTargets) && specificTargets.length > 0
            ? new Set(specificTargets.map(t => String(t).trim()))
            : null;
        const scopedTargetsByPlatform: Record<LivePlatform, string[]> = {
          TIKTOK: [],
          INSTAGRAM: [],
          FACEBOOK: [],
          X: [],
        };
        const scopedRuleMap: Record<string, string> = {};
        const scopedPlatformSet = new Set<LivePlatform>();

        for (const rule of activeRules) {
          const platforms = String(rule.platforms || 'reddit')
            .split(',')
            .map(p => p.trim().toLowerCase() as SocialPlatform)
            .filter(Boolean);
          const primaryPlatform = platforms[0] || 'reddit';
          const { sourceDomain } = parseSourceMeta(
            String(rule.excludedKeywords || ''),
            primaryPlatform
          );
          allQueriedSources.add(sourceDomain);

          const parsedTargets = parseTrackedTargets(String(rule.keyword || ''));
          for (const t of parsedTargets) {
            if (specificTargetFilter && !specificTargetFilter.has(t)) continue;
            if (!isLiveUserTarget(t)) continue;
            const livePlatform = resolveLivePlatformForTarget(t, primaryPlatform, sourceDomain);
            const canonicalUser = canonicalizeUsername(t, livePlatform);
            if (!canonicalUser) continue;
            scopedPlatformSet.add(livePlatform);
            if (!scopedTargetsByPlatform[livePlatform].includes(canonicalUser)) {
              scopedTargetsByPlatform[livePlatform].push(canonicalUser);
            }
            const rKey = `${livePlatform}::${canonicalUser.toLowerCase()}`;
            if (!scopedRuleMap[rKey]) {
              scopedRuleMap[rKey] = rule.id;
            }
          }
        }

        const scopedPlatforms = Array.from(scopedPlatformSet);
        const [wsSnapshot, androidSnapshot] = await Promise.all([
          stateStore.readWorkspaceStateIfExists().catch(() => null),
          stateStore.readAndroidState().catch(() => null),
        ]);
        const wsCookies: Partial<PlatformCookies> = wsSnapshot?.scannerSettings?.cookies ?? {};
        const scopedCookies: Required<PlatformCookies> = {
          tiktok:
            normalizeCookieValue(safeCookies.tiktok) ||
            normalizeCookieValue(wsCookies.tiktok) ||
            defaultEnvCookies.tiktok,
          instagram:
            normalizeCookieValue(safeCookies.instagram) ||
            normalizeCookieValue(wsCookies.instagram) ||
            defaultEnvCookies.instagram,
          facebook:
            normalizeCookieValue(safeCookies.facebook) ||
            normalizeCookieValue(wsCookies.facebook) ||
            defaultEnvCookies.facebook,
          x:
            normalizeCookieValue(safeCookies.x) ||
            normalizeCookieValue(wsCookies.x) ||
            defaultEnvCookies.x,
        };

        const scopedServers: WebhookServerItem[] =
          Array.isArray(servers) && servers.length > 0
            ? servers
            : wsSnapshot?.servers ?? latestWorkspaceServers;
        const firstEnabledServer = scopedServers.find(
          s => s && s.enabled && typeof s.url === 'string' && s.url.trim()
        );
        const scopedAndroidCallbackUrl = androidSnapshot?.device?.callbackUrl ?? undefined;

        const scopedNotifier = new Notifier({
          localBaseUrl: `http://127.0.0.1:${listeningPort}`,
          webhookUrl: firstEnabledServer?.url?.trim() || undefined,
          webhookFormat: firstEnabledServer?.format,
          secretHeader: firstEnabledServer?.secretHeader,
          androidCallbackUrl: scopedAndroidCallbackUrl,
          resolveWebhookTarget: createWebhookTargetResolver(
            () => activeRules,
            () => scopedServers
          ),
          onPendingNotification: pushPendingAndroidNotification,
        });

        const scopedPlatformsCfg = wsSnapshot?.scannerSettings?.platforms;
        const baseWatcherCfg = (watcher as any).config as
          | {
              enableWarmup?: boolean;
              autoDownloadMedia?: boolean;
              staggerRangeMs?: [number, number];
            }
          | undefined;

        const scopedWatcher = new MultiPlatformWatcher({
          config: {
            targetsByPlatform: scopedTargetsByPlatform,
            cookies: scopedCookies,
            platformSettings: scopedPlatformsCfg,
            targetStreamMetaMap: wsSnapshot?.targetStreamMetaMap,
            targetRuleMap: scopedRuleMap,
            manageLiveLoop: false,
            enableWarmup: baseWatcherCfg?.enableWarmup ?? true,
            autoDownloadMedia: baseWatcherCfg?.autoDownloadMedia ?? true,
            driveStorageRoot,
            staggerRangeMs: baseWatcherCfg?.staggerRangeMs ?? [1000, 3000],
            androidCallbackUrl: scopedAndroidCallbackUrl,
            ...(scopedPlatformsCfg?.tiktok
              ? {
                  liveIntervalSeconds: scopedPlatformsCfg.tiktok.liveIntervalSeconds,
                  postIntervalSeconds: scopedPlatformsCfg.tiktok.postIntervalSeconds,
                  storyIntervalSeconds: scopedPlatformsCfg.tiktok.storyIntervalSeconds,
                }
              : {}),
          },
          stateStore: watcherStateStore,
          mediaDownloader: watcherMediaDownloader,
          notifier: scopedNotifier,
        });

        const report = await scopedWatcher.runCycle(activityType, {
          platforms: scopedPlatforms.length > 0 ? scopedPlatforms : undefined,
        });
        const diagnostics = scopedWatcher.getDiagnostics();

        res.json({
          ok: true,
          mode: activityType,
          scannedAt: new Date().toISOString(),
          totalRulesEvaluated: activeRules.length,
          totalPostsScanned: report.targetsChecked,
          liveSourcesQueried: Array.from(allQueriedSources),
          liveStatuses: [],
          detections,
          diagnostics,
          report,
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
      watcherNotifier.updateConfig({ localBaseUrl: `http://127.0.0.1:${port}` });
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
    options.startWatcher ?? (process.env.WATCHER_ENABLED !== 'false');
  if (shouldStartWatcher) {
    if (shouldStartAutoScanner && typeof (created.watcher as any).updateConfig === 'function') {
      (created.watcher as any).updateConfig({ manageLiveLoop: false });
    }
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

