import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  canonicalizeUsername,
  normalizePlatform,
  ReferenceContractServer,
  type ReferenceServerOptions,
} from './referenceServer.ts';
import type {
  AndroidHealthResponse,
  AndroidStatusResponse,
  AndroidSyncUserInput,
  AndroidUserStatus,
  CanonicalPlatform,
  CapturedRecordRequest,
  E2EHarness,
  ErrorResponse,
  HealthResponse,
  HttpJsonResult,
  LiveSimulationInput,
  MockAndroidReceiver,
  MockAndroidUserState,
  MockFaultConfig,
  PollAckRequest,
  PollAckResponse,
  PollRequest,
  PollResponse,
  RegisterRequest,
  RegisterResponse,
  SyncRequest,
  SyncResponse,
  WorkspaceState,
} from './types.ts';

export const PRODUCTION_TIKTOK_HANDLES = [
  '@ebe_m72', '@baotran162008', '@baochan162008', '@quyenquiday', '@vitammyn_133',
  '@quynanhtran._', '@lytran.1309', '@myckuyaa', '@embephamandi', '@lanvu269',
  '@linhchipham2', '@sylviaxoxo__', '@_nguyenhongthuong', '@natho1199', '@thaomy_xinhiu21',
  '@daisytran.__', '@anbinh02030708', '@jonly_nhieen', '@founrin', '@dau.do9',
  '@noiynu99', '@xuongmaytini', '@naneeclothing', '@celestranpt', '@maimailienn',
  '@babibeo4', '@sunny318318', '@tiennugovap', '@tiennugozap', '@hvtl108',
  '@quyenquibaby.naau', '@bedau68685', '@_hyn1105', '@dh.huyenn', '@zanggxinh_',
  '@diemiune205', '@ttthuyvan._iu', '@niegym22tq',
] as const;

export const PRODUCTION_INSTAGRAM_HANDLES = ['@baotran16tui', '@panbaozhen16'] as const;
export const PRODUCTION_X_HANDLES = ['@Minalatuinehehe', '@Elinaaa2511'] as const;
export const PRODUCTION_FACEBOOK_HANDLES = ['@phanbaotran2k', '@luvtint'] as const;

export function buildProduction44WorkspaceState(): WorkspaceState {
  const ts = '2026-11-18T16:01:07.088417Z';
  return {
    rules: [
      {
        id: 'rule_tiktok_source',
        ownerId: 'demo_user',
        keyword: PRODUCTION_TIKTOK_HANDLES.join(', '),
        excludedKeywords: 'tiktok.com |',
        matchType: 'regex',
        platforms: 'reddit',
        webhookServerId: 'srv_sandbox_local',
        enabled: true,
        matchCount: 0,
        createdAt: ts,
        updatedAt: ts,
      },
      {
        id: 'rule_instagram_source',
        ownerId: 'demo_user',
        keyword: PRODUCTION_INSTAGRAM_HANDLES.join(', '),
        excludedKeywords: 'instagram.com |',
        matchType: 'regex',
        platforms: 'hackernews',
        webhookServerId: 'srv_sandbox_local',
        enabled: true,
        matchCount: 0,
        createdAt: ts,
        updatedAt: ts,
      },
      {
        id: 'rule_x_source',
        ownerId: 'demo_user',
        keyword: PRODUCTION_X_HANDLES.join(', '),
        excludedKeywords: 'x.com |',
        matchType: 'regex',
        platforms: 'bluesky',
        webhookServerId: 'srv_sandbox_local',
        enabled: true,
        matchCount: 0,
        createdAt: ts,
        updatedAt: ts,
      },
      {
        id: 'rule_facebook_source',
        ownerId: 'demo_user',
        keyword: PRODUCTION_FACEBOOK_HANDLES.join(', '),
        excludedKeywords: 'facebook.com |',
        matchType: 'regex',
        platforms: 'github',
        webhookServerId: 'srv_sandbox_local',
        enabled: true,
        matchCount: 0,
        createdAt: ts,
        updatedAt: ts,
      },
    ],
    servers: [
      {
        id: 'srv_sandbox_local',
        ownerId: 'demo_user',
        name: 'Sandbox Local (/api/webhook-sandbox)',
        url: '/api/webhook-sandbox',
        format: 'json',
        secretHeader: '',
        enabled: true,
        createdAt: ts,
        updatedAt: ts,
      },
    ],
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
    updatedAt: ts,
  };
}

export function isNonLoopbackNonLinkLocalIpv4(address: string): boolean {
  const trimmed = address.trim();
  const parts = trimmed.split('.');
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : -1));
  if (nums.some((n) => n < 0 || n > 255)) return false;
  if (nums[0] === 127) return false; // loopback 127.0.0.0/8
  if (nums[0] === 169 && nums[1] === 254) return false; // link-local 169.254.0.0/16
  if (nums[0] === 0) return false;
  return true;
}

export function filterRegisterableIpv4Candidates(addresses: string[]): string[] {
  return addresses.filter((addr) => isNonLoopbackNonLinkLocalIpv4(addr));
}

function readRawBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function createMockAndroidReceiver(options?: {
  ip?: string;
  initialUsers?: Array<Omit<Partial<MockAndroidUserState>, 'platform'> & { platform: string; username: string }>;
}): Promise<MockAndroidReceiver> {
  let currentIp = options?.ip ?? '127.0.0.1';
  let listeningPort = 0;
  let lastSyncAt: string | null = null;
  let outboundPlatformPollRequests = 0;
  let outboundTelegramSyncChecks = 0;

  let faultConfig: MockFaultConfig = {
    networkOnline: true,
    isWifi: true,
    simulateLowStorageAbort: false,
  };
  let remainingForcedFailures = 0;

  const activeRecordings = new Set<string>();
  const users = new Map<string, MockAndroidUserState>();
  const capturedRequests: CapturedRecordRequest[] = [];
  const waiters: Array<{
    predicate: (req: CapturedRecordRequest) => boolean;
    resolve: (req: CapturedRecordRequest) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  const seedOne = (u: Omit<Partial<MockAndroidUserState>, 'platform'> & { platform: string; username: string }): void => {
    const platform = normalizePlatform(u.platform) ?? 'TIKTOK';
    const username = canonicalizeUsername(u.username, platform);
    const key = `${platform}::${username}`;
    const status: AndroidUserStatus = u.status ?? 'IDLE';
    if (status === 'RECORDING') {
      activeRecordings.add(key);
    }
    users.set(key, {
      platform,
      username,
      usernameOrUrl: u.usernameOrUrl ?? (u.username.startsWith('@') ? u.username : `@${username}`),
      nickname: u.nickname ?? username,
      isEnabled: u.isEnabled ?? true,
      allowCellular: u.allowCellular ?? false,
      telegramTopicId: u.telegramTopicId ?? null,
      status,
      lastStreamUrl: u.lastStreamUrl ?? null,
      lastCheckedTimestamp: u.lastCheckedTimestamp ?? Date.now(),
    });
  };

  if (options?.initialUsers) {
    for (const u of options.initialUsers) seedOne(u);
  }

  const notifyCapture = (entry: CapturedRecordRequest): void => {
    capturedRequests.push(entry);
    for (let i = waiters.length - 1; i >= 0; i--) {
      const waiter = waiters[i];
      if (waiter.predicate(entry)) {
        clearTimeout(waiter.timer);
        waiters.splice(i, 1);
        waiter.resolve(entry);
      }
    }
  };

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const method = (req.method || 'GET').toUpperCase();

    if (method === 'GET' && reqUrl.pathname === '/health') {
      const health: AndroidHealthResponse = {
        ok: true,
        pollingDisabled: true,
        listeningPort,
        ip: currentIp,
        activeRecordings: activeRecordings.size,
        userCount: users.size,
        lastSyncAt,
      };
      sendJson(res, 200, health);
      return;
    }

    if (method === 'POST' && reqUrl.pathname === '/record') {
      const rawBody = await readRawBody(req);

      if (faultConfig.delayMs && faultConfig.delayMs > 0) {
        await sleep(faultConfig.delayMs);
        if (res.destroyed || req.destroyed) {
          return;
        }
      }

      if (remainingForcedFailures > 0 || (faultConfig.statusCode && faultConfig.failCount === undefined)) {
        if (remainingForcedFailures > 0) remainingForcedFailures -= 1;
        const code = faultConfig.statusCode ?? 503;
        const bodyOut = faultConfig.customBody ?? { ok: false, error: `Injected HTTP ${code}` };
        const captured: CapturedRecordRequest = {
          receivedAt: new Date().toISOString(),
          headers: req.headers,
          rawBody,
          body: null,
          statusCode: code,
          responseStatus: `INJECTED_${code}`,
        };
        try {
          captured.body = JSON.parse(rawBody) as Record<string, unknown>;
        } catch {
          // leave null
        }
        notifyCapture(captured);
        sendJson(res, code, bodyOut);
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        const captured: CapturedRecordRequest = {
          receivedAt: new Date().toISOString(),
          headers: req.headers,
          rawBody,
          body: null,
          statusCode: 400,
          responseStatus: 'INVALID_JSON',
        };
        notifyCapture(captured);
        sendJson(res, 400, { ok: false, error: 'INVALID_JSON' });
        return;
      }

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        const captured: CapturedRecordRequest = {
          receivedAt: new Date().toISOString(),
          headers: req.headers,
          rawBody,
          body: null,
          statusCode: 400,
          responseStatus: 'INVALID_JSON',
        };
        notifyCapture(captured);
        sendJson(res, 400, { ok: false, error: 'INVALID_JSON' });
        return;
      }

      const body = parsed as Record<string, unknown>;
      const platform = normalizePlatform(body.platform);
      if (!platform) {
        const captured: CapturedRecordRequest = {
          receivedAt: new Date().toISOString(),
          headers: req.headers,
          rawBody,
          body,
          statusCode: 400,
          responseStatus: 'INVALID_PLATFORM',
        };
        notifyCapture(captured);
        sendJson(res, 400, { ok: false, error: 'INVALID_PLATFORM' });
        return;
      }

      const rawUser =
        (typeof body.username === 'string' && body.username.trim()) ||
        (typeof body.usernameOrUrl === 'string' && body.usernameOrUrl.trim()) ||
        '';
      const canonicalUsername = canonicalizeUsername(rawUser, platform);
      if (!canonicalUsername) {
        const captured: CapturedRecordRequest = {
          receivedAt: new Date().toISOString(),
          headers: req.headers,
          rawBody,
          body,
          statusCode: 400,
          responseStatus: 'MISSING_USERNAME',
        };
        notifyCapture(captured);
        sendJson(res, 400, { ok: false, error: 'MISSING_USERNAME' });
        return;
      }

      const streamUrl = typeof body.streamUrl === 'string' ? body.streamUrl.trim() : '';
      if (!streamUrl) {
        const captured: CapturedRecordRequest = {
          receivedAt: new Date().toISOString(),
          headers: req.headers,
          rawBody,
          body,
          statusCode: 400,
          responseStatus: 'MISSING_STREAM_URL',
        };
        notifyCapture(captured);
        sendJson(res, 400, { ok: false, error: 'MISSING_STREAM_URL' });
        return;
      }

      const key = `${platform}::${canonicalUsername}`;
      let user = users.get(key);
      if (!user) {
        user = {
          platform,
          username: canonicalUsername,
          usernameOrUrl:
            typeof body.usernameOrUrl === 'string' && body.usernameOrUrl.trim()
              ? body.usernameOrUrl.trim()
              : `@${canonicalUsername}`,
          nickname: canonicalUsername,
          isEnabled: true,
          allowCellular: false,
          telegramTopicId: null,
          status: 'IDLE',
          lastStreamUrl: null,
          lastCheckedTimestamp: Date.now(),
        };
        users.set(key, user);
      }

      if (activeRecordings.has(key)) {
        const resp = {
          ok: true,
          status: 'ALREADY_RECORDING',
          platform,
          username: canonicalUsername,
        };
        notifyCapture({
          receivedAt: new Date().toISOString(),
          headers: req.headers,
          rawBody,
          body,
          statusCode: 200,
          responseStatus: 'ALREADY_RECORDING',
        });
        sendJson(res, 200, resp);
        return;
      }

      const online = faultConfig.networkOnline !== false;
      const isWifi = faultConfig.isWifi !== false;
      if (!online || (!isWifi && !user.allowCellular)) {
        user.status = 'LIVE';
        user.lastStreamUrl = streamUrl;
        const resp = {
          ok: true,
          status: 'SKIPPED_CELLULAR_POLICY',
          platform,
          username: canonicalUsername,
        };
        notifyCapture({
          receivedAt: new Date().toISOString(),
          headers: req.headers,
          rawBody,
          body,
          statusCode: 200,
          responseStatus: 'SKIPPED_CELLULAR_POLICY',
        });
        sendJson(res, 200, resp);
        return;
      }

      if (faultConfig.simulateLowStorageAbort) {
        // Simulate low storage abort: try to start, clean up activeRecordings in finally
        activeRecordings.add(key);
        try {
          user.status = 'ERROR';
          const resp = { ok: false, error: 'INSUFFICIENT_STORAGE' };
          notifyCapture({
            receivedAt: new Date().toISOString(),
            headers: req.headers,
            rawBody,
            body,
            statusCode: 507,
            responseStatus: 'LOW_STORAGE_ABORT',
          });
          sendJson(res, 507, resp);
        } finally {
          activeRecordings.delete(key);
        }
        return;
      }

      activeRecordings.add(key);
      user.status = 'RECORDING';
      user.lastStreamUrl = streamUrl;
      user.lastCheckedTimestamp = Date.now();
      const resp = {
        ok: true,
        status: 'RECORDING_STARTED',
        platform,
        username: canonicalUsername,
      };
      notifyCapture({
        receivedAt: new Date().toISOString(),
        headers: req.headers,
        rawBody,
        body,
        statusCode: 202,
        responseStatus: 'RECORDING_STARTED',
      });
      sendJson(res, 202, resp);
      return;
    }

    sendJson(res, 404, { ok: false, error: `Not found: ${method} ${reqUrl.pathname}` });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        listeningPort = addr.port;
      }
      resolve();
    });
  });

  return {
    get port() {
      return listeningPort;
    },
    get ip() {
      return currentIp;
    },
    get url() {
      return `http://127.0.0.1:${listeningPort}`;
    },
    get outboundPlatformPollRequests() {
      return outboundPlatformPollRequests;
    },
    get outboundTelegramSyncChecks() {
      return outboundTelegramSyncChecks;
    },
    setIp(ip: string) {
      currentIp = ip;
    },
    setFaultConfig(config: Partial<MockFaultConfig>) {
      faultConfig = { ...faultConfig, ...config };
      if (typeof config.failCount === 'number') {
        remainingForcedFailures = config.failCount;
      }
      if (Array.isArray(config.activeRecordings)) {
        activeRecordings.clear();
        for (const k of config.activeRecordings) activeRecordings.add(k);
      }
    },
    resetFaultConfig() {
      faultConfig = {
        networkOnline: true,
        isWifi: true,
        simulateLowStorageAbort: false,
      };
      remainingForcedFailures = 0;
    },
    seedUser(u) {
      seedOne(u);
    },
    setUsers(list) {
      users.clear();
      activeRecordings.clear();
      for (const u of list) seedOne(u);
    },
    getUsers() {
      return Array.from(users.values()).map((u) => ({ ...u }));
    },
    setUserStatus(platformRaw: string, usernameRaw: string, status: AndroidUserStatus) {
      const p = normalizePlatform(platformRaw) ?? 'TIKTOK';
      const u = canonicalizeUsername(usernameRaw, p);
      const key = `${p}::${u}`;
      const existing = users.get(key);
      if (existing) {
        existing.status = status;
      }
      if (status === 'RECORDING') {
        activeRecordings.add(key);
      } else {
        activeRecordings.delete(key);
      }
    },
    clearActiveRecording(platformRaw: string, usernameRaw: string) {
      const p = normalizePlatform(platformRaw) ?? 'TIKTOK';
      const u = canonicalizeUsername(usernameRaw, p);
      const key = `${p}::${u}`;
      activeRecordings.delete(key);
      const existing = users.get(key);
      if (existing && existing.status === 'RECORDING') {
        existing.status = 'IDLE';
      }
    },
    getActiveRecordings() {
      return Array.from(activeRecordings);
    },
    setLastSyncAt(iso: string | null) {
      lastSyncAt = iso;
    },
    getCapturedRequests() {
      return [...capturedRequests];
    },
    clearCapturedRequests() {
      capturedRequests.length = 0;
    },
    waitForRecord(predicate = () => true, timeoutMs = 5_000) {
      const existing = capturedRequests.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise<CapturedRecordRequest>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.findIndex((w) => w.timer === timer);
          if (idx !== -1) waiters.splice(idx, 1);
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for /record request`));
        }, timeoutMs);
        waiters.push({ predicate, resolve, reject, timer });
      });
    },
    triggerTelegramPendingSyncCheck() {
      outboundTelegramSyncChecks += 1;
    },
    async registerWithPulseRadar(pulseRadarUrl: string, overrides?: Partial<RegisterRequest>) {
      const cleanBase = pulseRadarUrl.replace(/\/+$/, '');
      const payload: RegisterRequest = {
        deviceId: 'sm_n770f_default',
        ip: currentIp,
        port: listeningPort,
        appVersion: '1.0.0',
        networkType: faultConfig.isWifi === false ? 'CELLULAR' : 'WIFI',
        timestamp: new Date().toISOString(),
        ...overrides,
      };
      const resp = await fetch(`${cleanBase}/api/android/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = (await resp.json()) as Record<string, unknown>;
      return { status: resp.status, body };
    },
    async syncWithPulseRadar(pulseRadarUrl: string, overrides?: Partial<SyncRequest>) {
      const cleanBase = pulseRadarUrl.replace(/\/+$/, '');
      const reportedUsers: AndroidSyncUserInput[] = Array.from(users.values()).map((u) => {
        const key = `${u.platform}::${u.username}`;
        const effectiveStatus: AndroidUserStatus = activeRecordings.has(key)
          ? 'RECORDING'
          : u.status;
        return {
          username: u.username,
          usernameOrUrl: u.usernameOrUrl,
          platform: u.platform,
          nickname: u.nickname,
          status: effectiveStatus,
          isEnabled: u.isEnabled,
          allowCellular: u.allowCellular,
          lastStreamUrl: u.lastStreamUrl,
          lastCheckedTimestamp: u.lastCheckedTimestamp,
        };
      });

      const payload: SyncRequest = {
        deviceId: 'sm_n770f_default',
        ip: currentIp,
        port: listeningPort,
        reportedAt: new Date().toISOString(),
        users: reportedUsers,
        ...overrides,
      };

      const resp = await fetch(`${cleanBase}/api/android/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const raw = await resp.text();
      let parsedBody: SyncResponse | ErrorResponse;
      try {
        parsedBody = JSON.parse(raw) as SyncResponse | ErrorResponse;
      } catch {
        return { status: resp.status, body: { ok: false, error: 'Malformed JSON from server' } };
      }

      if (resp.ok && 'ok' in parsedBody && parsedBody.ok) {
        // Apply @Transaction-equivalent Room reconciliation preserving local allowCellular, telegramTopicId, and active states
        lastSyncAt = parsedBody.syncedAt;

        for (const rem of parsedBody.toRemove) {
          const p = normalizePlatform(rem.platform) ?? 'TIKTOK';
          const u = canonicalizeUsername(rem.username || rem.usernameOrUrl, p);
          const key = `${p}::${u}`;
          const existing = users.get(key);
          if (existing && (existing.status === 'RECORDING' || existing.status === 'UPLOADING' || activeRecordings.has(key))) {
            continue; // protect active row until recording/upload finishes
          }
          users.delete(key);
        }

        for (const add of parsedBody.toAdd) {
          const p = normalizePlatform(add.platform) ?? 'TIKTOK';
          const u = canonicalizeUsername(add.username || add.usernameOrUrl, p);
          const key = `${p}::${u}`;
          if (!users.has(key)) {
            users.set(key, {
              platform: p,
              username: u,
              usernameOrUrl: add.usernameOrUrl || `@${u}`,
              nickname: add.nickname || u,
              isEnabled: add.isEnabled,
              allowCellular: false,
              telegramTopicId: null,
              status: add.effectiveStatus,
              lastStreamUrl: add.streamUrl,
              lastCheckedTimestamp: Date.now(),
            });
          }
        }

        for (const upd of parsedBody.toUpdate) {
          const p = normalizePlatform(upd.platform) ?? 'TIKTOK';
          const u = canonicalizeUsername(upd.username || upd.usernameOrUrl, p);
          const key = `${p}::${u}`;
          const existing = users.get(key);
          if (existing) {
            existing.isEnabled = upd.isEnabled;
            if (existing.status !== 'RECORDING' && existing.status !== 'UPLOADING' && !activeRecordings.has(key)) {
              existing.status = upd.effectiveStatus;
            }
            if (upd.streamUrl) {
              existing.lastStreamUrl = upd.streamUrl;
            }
          }
        }

        // Launch recordings for recordTriggers respecting active dedup, blank streamUrl, and cellular policy
        const online = faultConfig.networkOnline !== false;
        const isWifi = faultConfig.isWifi !== false;
        for (const trigger of parsedBody.recordTriggers) {
          if (!trigger.streamUrl || trigger.streamUrl.trim().length === 0) continue;
          const p = normalizePlatform(trigger.platform) ?? 'TIKTOK';
          const u = canonicalizeUsername(trigger.username || trigger.usernameOrUrl, p);
          const key = `${p}::${u}`;
          if (activeRecordings.has(key)) continue;
          const existing = users.get(key);
          if (existing && (existing.status === 'RECORDING' || existing.status === 'UPLOADING')) continue;
          const allowCellular = existing?.allowCellular ?? false;
          if (!online || (!isWifi && !allowCellular)) {
            if (existing) existing.status = 'LIVE';
            continue;
          }
          activeRecordings.add(key);
          if (existing) {
            existing.status = 'RECORDING';
            existing.lastStreamUrl = trigger.streamUrl;
          }
        }
      }

      return { status: resp.status, body: parsedBody };
    },
    async close() {
      for (const w of waiters) {
        clearTimeout(w.timer);
        w.reject(new Error('MockAndroidReceiver closed'));
      }
      waiters.length = 0;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export async function createE2EHarness(options?: {
  initialWorkspaceState?: WorkspaceState | null;
  referenceServerOptions?: Omit<ReferenceServerOptions, 'dataDir'>;
  mockAndroidIp?: string;
}): Promise<E2EHarness> {
  const envUrl = process.env.E2E_PULSE_RADAR_URL?.trim();
  const isLiveMode = Boolean(envUrl);
  const envDataDir = process.env.E2E_DATA_DIR?.trim();
  const dataDir =
    envDataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'pulseradar-e2e-'));
  const ownsDataDir = !envDataDir;

  if (options?.initialWorkspaceState && !isLiveMode) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, 'workspace-state.json'),
      JSON.stringify(options.initialWorkspaceState, null, 2),
      'utf8'
    );
  }

  let refServer: ReferenceContractServer | null = null;
  if (!isLiveMode) {
    refServer = new ReferenceContractServer({
      dataDir,
      ...options?.referenceServerOptions,
    });
    await refServer.start();
  }

  const mockAndroid = await createMockAndroidReceiver({
    ip: options?.mockAndroidIp ?? '127.0.0.1',
  });

  let currentPulseRadarUrl = envUrl ? envUrl.replace(/\/+$/, '') : refServer!.url;
  const androidTargetUrl =
    process.env.E2E_ANDROID_URL?.trim().replace(/\/+$/, '') || mockAndroid.url;

  const httpRaw = async (
    baseUrl: string,
    pathname: string,
    init?: RequestInit
  ): Promise<{ status: number; text: string; headers: Headers }> => {
    const cleanBase = baseUrl.replace(/\/+$/, '');
    const cleanPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
    const resp = await fetch(`${cleanBase}${cleanPath}`, init);
    const text = await resp.text();
    return { status: resp.status, text, headers: resp.headers };
  };

  const httpJson = async <T = Record<string, unknown>>(
    baseUrl: string,
    pathname: string,
    init?: RequestInit
  ): Promise<HttpJsonResult<T>> => {
    const { status, text, headers } = await httpRaw(baseUrl, pathname, init);
    let body: T;
    try {
      body = JSON.parse(text) as T;
    } catch {
      throw new Error(`Expected JSON from ${baseUrl}${pathname} (status ${status}), got: ${text.slice(0, 200)}`);
    }
    return { status, headers, body, rawText: text };
  };

  if (isLiveMode && options?.initialWorkspaceState) {
    await httpJson(currentPulseRadarUrl, '/api/workspace-state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options.initialWorkspaceState),
    });
  }

  const harness: E2EHarness = {
    mode: isLiveMode ? 'live-target' : 'self-test',
    get pulseRadarUrl() {
      return currentPulseRadarUrl;
    },
    androidTargetUrl,
    dataDir,
    mockAndroid,
    isLiveMode,
    httpJson,
    httpRaw,
    getHealth: () => httpJson<HealthResponse>(currentPulseRadarUrl, '/api/health'),
    getAndroidStatus: () => httpJson<AndroidStatusResponse>(currentPulseRadarUrl, '/api/android/status'),
    getWorkspaceState: () =>
      httpJson<{ ok: boolean; state: WorkspaceState | null }>(currentPulseRadarUrl, '/api/workspace-state'),
    putWorkspaceState: (state: unknown) =>
      httpJson<{ ok: boolean; error?: string }>(currentPulseRadarUrl, '/api/workspace-state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: typeof state === 'string' ? state : JSON.stringify(state),
      }),
    registerAndroid: (payload: Record<string, unknown>) =>
      httpJson<RegisterResponse | ErrorResponse>(currentPulseRadarUrl, '/api/android/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    syncAndroid: (payload: Record<string, unknown>) =>
      httpJson<SyncResponse | ErrorResponse>(currentPulseRadarUrl, '/api/android/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    pollAndroid: (payload: PollRequest = { deviceId: 'sm_n770f_default' }) =>
      httpJson<PollResponse | ErrorResponse>(currentPulseRadarUrl, '/api/android/poll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    ackAndroidPoll: (payload: PollAckRequest) =>
      httpJson<PollAckResponse | ErrorResponse>(currentPulseRadarUrl, '/api/android/poll/ack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    async simulateLiveUser(input: LiveSimulationInput): Promise<boolean> {
      if (!isLiveMode) {
        const res = await httpJson<{ ok: boolean }>(currentPulseRadarUrl, '/__e2e__/simulate-live', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        return res.status === 200 && res.body.ok;
      }
      const hookUrl = process.env.E2E_LIVE_TRIGGER_URL?.trim();
      if (!hookUrl) return false;
      const resp = await fetch(hookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      return resp.ok;
    },
    async tickScan(): Promise<boolean> {
      if (!isLiveMode) {
        const res = await httpJson<{ ok: boolean }>(currentPulseRadarUrl, '/__e2e__/tick-scan', {
          method: 'POST',
        });
        return res.status === 200 && res.body.ok;
      }
      const res = await httpJson<{ ok: boolean }>(currentPulseRadarUrl, '/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isAutoScan: true }),
      });
      return res.status === 200;
    },
    async restartReferenceServer(): Promise<void> {
      if (!refServer) return;
      await refServer.stop();
      refServer = new ReferenceContractServer({
        dataDir,
        ...options?.referenceServerOptions,
      });
      await refServer.start();
      currentPulseRadarUrl = refServer.url;
    },
    async cleanup(): Promise<void> {
      await mockAndroid.close();
      if (refServer) {
        await refServer.stop();
      }
      if (ownsDataDir && fs.existsSync(dataDir)) {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    },
  };

  return harness;
}
