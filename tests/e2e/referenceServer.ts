import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AndroidDeviceRecord,
  AndroidStatusResponse,
  AndroidSyncUserInput,
  AndroidUserStatus,
  AuthoritativeUserItem,
  CanonicalPlatform,
  HealthResponse,
  LiveSimulationInput,
  RecordRequest,
  RecordTriggerItem,
  RegisterResponse,
  ServerLiveStatus,
  SyncRemoveItem,
  SyncResponse,
  SyncUpdateItem,
  WorkspaceRule,
  WorkspaceState,
} from './types.ts';

interface PersistedAndroidState {
  device: AndroidDeviceRecord | null;
  reportedStatuses: Record<string, AndroidUserStatus>;
  lastScanAt: string | null;
  activeLiveCount: number;
  lastDispatchError: string | null;
}

interface SimulatedLiveEntry {
  status: 'LIVE' | 'NOT_LIVE' | 'ERROR';
  streamUrl?: string;
  title?: string;
  sourceUrl?: string;
  qualityInfo?: string;
  errorMessage?: string;
  checkerDelayMs?: number;
}

interface SandboxReceipt {
  id: string;
  receivedAt: string;
  channel: string;
  signatureHeader: string;
  signatureVerified: boolean;
  eventHeader: string;
  userAgent: string;
  payload: unknown;
}

export interface ReferenceServerOptions {
  dataDir: string;
  pollIntervalMs?: number;
  dispatchTimeoutMs?: number;
  retryDelayMs?: number;
  autoScanEnabled?: boolean;
  upstreamCheckerUrl?: string | null;
}

const VALID_PLATFORMS = new Set<CanonicalPlatform>(['TIKTOK', 'INSTAGRAM', 'FACEBOOK', 'X']);

export function normalizePlatform(raw: unknown, sourceDomain = ''): CanonicalPlatform | null {
  const domain = sourceDomain.toLowerCase();
  if (domain.includes('instagram.com') || domain.includes('instagr.am')) return 'INSTAGRAM';
  if (domain.includes('facebook.com') || domain.includes('fb.com') || domain.includes('fb.watch')) return 'FACEBOOK';
  if (domain.includes('x.com') || domain.includes('twitter.com') || domain.includes('t.co')) return 'X';
  if (domain.includes('tiktok.com')) return 'TIKTOK';

  if (typeof raw !== 'string') return null;
  const upper = raw.trim().toUpperCase();
  if (upper === 'REDDIT') return 'TIKTOK';
  if (upper === 'HACKERNEWS') return 'INSTAGRAM';
  if (upper === 'BLUESKY') return 'X';
  if (upper === 'GITHUB') return 'FACEBOOK';
  if (upper === 'TWITTER') return 'X';
  if (VALID_PLATFORMS.has(upper as CanonicalPlatform)) {
    return upper as CanonicalPlatform;
  }
  return null;
}

export function resolveLivePlatformForTarget(
  target: string,
  rulePlatforms: string,
  excludedKeywords: string
): CanonicalPlatform {
  const lowerTarget = target.toLowerCase();
  if (lowerTarget.includes('instagram.com') || lowerTarget.includes('instagr.am')) return 'INSTAGRAM';
  if (lowerTarget.includes('facebook.com') || lowerTarget.includes('fb.com') || lowerTarget.includes('fb.watch')) {
    return 'FACEBOOK';
  }
  if (
    lowerTarget.includes('x.com') ||
    lowerTarget.includes('twitter.com') ||
    lowerTarget.includes('t.co') ||
    lowerTarget.startsWith('broadcast_')
  ) {
    return 'X';
  }
  if (lowerTarget.includes('tiktok.com')) return 'TIKTOK';

  const primary = rulePlatforms
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .find(Boolean) ?? 'reddit';

  const metaDomain = parseSourceMeta(excludedKeywords, primary).sourceDomain;
  return normalizePlatform(primary, metaDomain) ?? 'TIKTOK';
}

export function parseSourceMeta(
  excludedKeywords: string,
  primaryPlatform: string
): { sourceDomain: string; excludedTerms: string[] } {
  const defaultDomain =
    primaryPlatform === 'hackernews'
      ? 'instagram.com'
      : primaryPlatform === 'bluesky'
        ? 'x.com'
        : primaryPlatform === 'github'
          ? 'facebook.com'
          : 'tiktok.com';

  const raw = String(excludedKeywords || '').trim();
  if (!raw) {
    return { sourceDomain: defaultDomain, excludedTerms: [] };
  }
  const pipeIdx = raw.indexOf('|');
  if (pipeIdx === -1) {
    return {
      sourceDomain: defaultDomain,
      excludedTerms: raw
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    };
  }
  const domainPart = raw.slice(0, pipeIdx).trim() || defaultDomain;
  const negPart = raw.slice(pipeIdx + 1);
  return {
    sourceDomain: domainPart,
    excludedTerms: negPart
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  };
}

export function parseTrackedTargets(keyword: string): string[] {
  return String(keyword || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isLiveUserTarget(target: string): boolean {
  const trimmed = target.trim();
  if (!trimmed) return false;
  if (/^https?:\/\//i.test(trimmed)) return true;
  if (trimmed.includes('tiktok.com') || trimmed.includes('instagram.com') || trimmed.includes('facebook.com') || trimmed.includes('x.com') || trimmed.includes('twitter.com')) {
    return true;
  }
  return !/\s/.test(trimmed);
}

export function canonicalizeUsername(raw: string, platform?: CanonicalPlatform): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';

  const lower = trimmed.toLowerCase();
  const looksLikeUrl =
    /^https?:\/\//i.test(trimmed) ||
    lower.includes('tiktok.com/') ||
    lower.includes('instagram.com/') ||
    lower.includes('instagr.am/') ||
    lower.includes('facebook.com/') ||
    lower.includes('fb.com/') ||
    lower.includes('fb.watch/') ||
    lower.includes('x.com/') ||
    lower.includes('twitter.com/');

  if (looksLikeUrl) {
    const normalizedUrl = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
      const parsed = new URL(normalizedUrl);
      const host = parsed.hostname.toLowerCase();
      const segments = parsed.pathname
        .split('/')
        .map((s) => s.trim())
        .filter(Boolean);

      if (host.includes('tiktok.com') || platform === 'TIKTOK') {
        const atSeg = segments.find((s) => s.startsWith('@'));
        if (atSeg) return atSeg.slice(1).toLowerCase();
        if (segments[0]) return segments[0].replace(/^@/, '').toLowerCase();
      }

      if (host.includes('instagram.com') || host.includes('instagr.am') || platform === 'INSTAGRAM') {
        const reserved = new Set(['live', 'stories', 'reels', 'p', 'tv', 'explore']);
        const firstNonReserved = segments.find((s) => !reserved.has(s.toLowerCase()));
        if (firstNonReserved) return firstNonReserved.replace(/^@/, '').toLowerCase();
      }

      if (host.includes('facebook.com') || host.includes('fb.com') || host.includes('fb.watch') || platform === 'FACEBOOK') {
        const profileId = parsed.searchParams.get('id');
        if (parsed.pathname.toLowerCase().includes('profile.php') && profileId) {
          return profileId.trim().toLowerCase();
        }
        const watchVideo = parsed.searchParams.get('v');
        if (watchVideo) {
          return `video_${watchVideo.trim().toLowerCase()}`;
        }
        const videosIdx = segments.findIndex((s) => s.toLowerCase() === 'videos');
        if (videosIdx !== -1 && segments[videosIdx + 1]) {
          return `video_${segments[videosIdx + 1].toLowerCase()}`;
        }
        if (segments[0]) return segments[0].replace(/^@/, '').toLowerCase();
      }

      if (host.includes('x.com') || host.includes('twitter.com') || platform === 'X') {
        if (segments[0]?.toLowerCase() === 'i' && segments[1]?.toLowerCase() === 'broadcasts' && segments[2]) {
          return `broadcast_${segments[2].toLowerCase()}`;
        }
        if (segments[0]) return segments[0].replace(/^@/, '').toLowerCase();
      }
    } catch {
      // Fall through to plain handle normalization
    }
  }

  return trimmed
    .replace(/^@+/, '')
    .replace(/[/?#].*$/, '')
    .trim()
    .toLowerCase();
}

export function isValidIpv4(ip: string): boolean {
  if (!ip || typeof ip !== 'string') return false;
  const trimmed = ip.trim();
  const parts = trimmed.split('.');
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false;
    const num = Number(part);
    if (!Number.isInteger(num) || num < 0 || num > 255) return false;
  }
  return true;
}

export function extractSocketIpv4(remoteAddress: string | undefined): string | null {
  if (!remoteAddress) return null;
  const cleaned = remoteAddress.startsWith('::ffff:') ? remoteAddress.slice(7) : remoteAddress;
  return isValidIpv4(cleaned) ? cleaned : null;
}

export function isValidPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535;
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

export class ReferenceContractServer {
  private readonly dataDir: string;
  private readonly workspaceStateFile: string;
  private readonly androidStateFile: string;
  private readonly pollIntervalMs: number;
  private readonly dispatchTimeoutMs: number;
  private readonly retryDelayMs: number;
  private autoScanEnabled: boolean;
  private upstreamCheckerUrl: string | null;

  private server: http.Server | null = null;
  private listeningPort = 0;
  private closed = false;
  private autoScanTimer: NodeJS.Timeout | null = null;
  private scanInFlight: Promise<void> | null = null;

  private writeChains = new Map<string, Promise<void>>();
  private simulatedLiveMap = new Map<string, SimulatedLiveEntry>();
  private serverLiveStatusMap = new Map<
    string,
    {
      status: ServerLiveStatus;
      streamUrl: string | null;
      streamTitle: string | null;
      sourceUrl: string | null;
      qualityInfo: string | null;
    }
  >();
  private activeLiveSessionMap = new Map<string, string>();
  private sandboxReceipts: SandboxReceipt[] = [];
  private androidStateCache: PersistedAndroidState;

  constructor(options: ReferenceServerOptions) {
    this.dataDir = options.dataDir;
    this.workspaceStateFile = path.join(this.dataDir, 'workspace-state.json');
    this.androidStateFile = path.join(this.dataDir, 'android-state.json');
    this.pollIntervalMs = options.pollIntervalMs ?? 30_000;
    this.dispatchTimeoutMs = options.dispatchTimeoutMs ?? 5_000;
    this.retryDelayMs = options.retryDelayMs ?? 1_000;
    this.autoScanEnabled = options.autoScanEnabled ?? true;
    this.upstreamCheckerUrl = options.upstreamCheckerUrl ?? null;

    fs.mkdirSync(this.dataDir, { recursive: true });
    this.androidStateCache = this.loadAndroidStateFromDisk();
  }

  get port(): number {
    return this.listeningPort;
  }

  get url(): string {
    return `http://127.0.0.1:${this.listeningPort}`;
  }

  private loadWorkspaceStateFromDisk(): WorkspaceState | null {
    if (!fs.existsSync(this.workspaceStateFile)) return null;
    const raw = fs.readFileSync(this.workspaceStateFile, 'utf8');
    return JSON.parse(raw) as WorkspaceState;
  }

  private loadAndroidStateFromDisk(): PersistedAndroidState {
    if (!fs.existsSync(this.androidStateFile)) {
      return {
        device: null,
        reportedStatuses: {},
        lastScanAt: null,
        activeLiveCount: 0,
        lastDispatchError: null,
      };
    }
    const raw = fs.readFileSync(this.androidStateFile, 'utf8');
    const parsed = JSON.parse(raw) as Partial<PersistedAndroidState>;
    return {
      device: parsed.device ?? null,
      reportedStatuses: parsed.reportedStatuses ?? {},
      lastScanAt: parsed.lastScanAt ?? null,
      activeLiveCount: parsed.activeLiveCount ?? 0,
      lastDispatchError: parsed.lastDispatchError ?? null,
    };
  }

  private async atomicWriteJson(filePath: string, data: unknown): Promise<void> {
    const prev = this.writeChains.get(filePath) ?? Promise.resolve();
    const next = prev.then(() => {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
      const serialized = JSON.stringify(data, null, 2);
      fs.writeFileSync(tmpPath, serialized, 'utf8');
      fs.renameSync(tmpPath, filePath);
    });
    this.writeChains.set(
      filePath,
      next.catch(() => {
        // Keep queue alive for subsequent writes
      })
    );
    return next;
  }

  private async persistAndroidState(): Promise<void> {
    await this.atomicWriteJson(this.androidStateFile, this.androidStateCache);
  }

  private deriveAuthoritativeTargets(): Array<{
    key: string;
    platform: CanonicalPlatform;
    username: string;
    usernameOrUrl: string;
    isEnabled: boolean;
    rule: WorkspaceRule;
    sourceDomain: string;
    excludedTerms: string[];
  }> {
    const state = this.loadWorkspaceStateFromDisk();
    if (!state || !Array.isArray(state.rules)) return [];

    const byKey = new Map<
      string,
      {
        key: string;
        platform: CanonicalPlatform;
        username: string;
        usernameOrUrl: string;
        isEnabled: boolean;
        rule: WorkspaceRule;
        sourceDomain: string;
        excludedTerms: string[];
      }
    >();

    for (const rule of state.rules) {
      if (!rule || typeof rule.keyword !== 'string') continue;
      const primaryPlatform =
        String(rule.platforms || 'reddit')
          .split(',')
          .map((p) => p.trim().toLowerCase())
          .find(Boolean) ?? 'reddit';
      const { sourceDomain, excludedTerms } = parseSourceMeta(rule.excludedKeywords || '', primaryPlatform);
      const targets = parseTrackedTargets(rule.keyword);
      const ruleEnabled = Boolean(rule.enabled);

      for (const t of targets) {
        if (!isLiveUserTarget(t)) continue;
        const platform = resolveLivePlatformForTarget(t, rule.platforms || 'reddit', rule.excludedKeywords || '');
        const username = canonicalizeUsername(t, platform);
        if (!username) continue;
        const key = `${platform}::${username}`;
        const existing = byKey.get(key);
        if (!existing) {
          byKey.set(key, {
            key,
            platform,
            username,
            usernameOrUrl: t,
            isEnabled: ruleEnabled,
            rule,
            sourceDomain,
            excludedTerms,
          });
        } else if (ruleEnabled && !existing.isEnabled) {
          existing.isEnabled = true;
          existing.rule = rule;
          existing.sourceDomain = sourceDomain;
          existing.excludedTerms = excludedTerms;
        }
      }
    }

    return Array.from(byKey.values());
  }

  private async checkTargetLive(
    platform: CanonicalPlatform,
    username: string,
    target: string,
    sourceDomain: string
  ): Promise<{
    status: 'LIVE' | 'NOT_LIVE' | 'ERROR';
    streamUrl: string;
    title: string;
    sourceUrl: string;
    qualityInfo: string;
    errorMessage?: string;
  }> {
    const key = `${platform}::${username}`;
    const sim = this.simulatedLiveMap.get(key);
    if (sim?.checkerDelayMs && sim.checkerDelayMs > 0) {
      await sleep(sim.checkerDelayMs);
    }

    if (this.upstreamCheckerUrl) {
      const resp = await fetch(`${this.upstreamCheckerUrl}/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform, username, target, sourceDomain }),
      });
      if (resp.ok) {
        const data = (await resp.json()) as Partial<SimulatedLiveEntry> & { status?: string };
        const st = data.status === 'LIVE' ? 'LIVE' : data.status === 'ERROR' ? 'ERROR' : 'NOT_LIVE';
        return {
          status: st,
          streamUrl: data.streamUrl ?? `https://cdn.example/${username}/origin.flv`,
          title: data.title ?? `${username} live stream`,
          sourceUrl: data.sourceUrl ?? `https://${sourceDomain}/@${username}/live`,
          qualityInfo: data.qualityInfo ?? 'FLV [origin]',
          errorMessage: data.errorMessage,
        };
      }
    }

    if (sim) {
      return {
        status: sim.status,
        streamUrl: sim.streamUrl ?? `https://cdn.example/${username}/origin.flv`,
        title: sim.title ?? `${username} live stream`,
        sourceUrl: sim.sourceUrl ?? `https://${sourceDomain}/@${username}/live`,
        qualityInfo: sim.qualityInfo ?? 'FLV [origin]',
        errorMessage: sim.errorMessage,
      };
    }

    return {
      status: 'NOT_LIVE',
      streamUrl: '',
      title: '',
      sourceUrl: `https://${sourceDomain}/@${username}/live`,
      qualityInfo: '',
    };
  }

  private async dispatchRecordToAndroid(payload: RecordRequest): Promise<void> {
    const device = this.androidStateCache.device;
    if (!device) return;

    const targetUrl = device.callbackUrl || `http://${device.ip}:${device.port}/record`;
    const bodyText = JSON.stringify(payload);

    const attemptOnce = async (): Promise<{ ok: boolean; status: number; retryable: boolean; errorText: string }> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.dispatchTimeoutMs);
      try {
        const response = await fetch(targetUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: bodyText,
          signal: controller.signal,
        });
        if (response.status >= 200 && response.status < 300) {
          return { ok: true, status: response.status, retryable: false, errorText: '' };
        }
        if (response.status >= 500) {
          return {
            ok: false,
            status: response.status,
            retryable: true,
            errorText: `Android returned HTTP ${response.status}`,
          };
        }
        return {
          ok: false,
          status: response.status,
          retryable: false,
          errorText: `Android rejected trigger with HTTP ${response.status}`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          status: 0,
          retryable: true,
          errorText: msg,
        };
      } finally {
        clearTimeout(timeout);
      }
    };

    let result = await attemptOnce();
    if (!result.ok && result.retryable) {
      await sleep(this.retryDelayMs);
      result = await attemptOnce();
    }

    if (result.ok) {
      this.androidStateCache.lastDispatchError = null;
    } else {
      this.androidStateCache.lastDispatchError = result.errorText;
    }
    await this.persistAndroidState();
  }

  async runSingleScanCycle(): Promise<void> {
    if (this.scanInFlight) {
      return this.scanInFlight;
    }

    const cycle = (async () => {
      const targets = this.deriveAuthoritativeTargets().filter((t) => t.isEnabled);
      let activeLiveCount = 0;

      for (const item of targets) {
        if (this.closed) break;
        const result = await this.checkTargetLive(
          item.platform,
          item.username,
          item.usernameOrUrl,
          item.sourceDomain
        );

        const sessionKey = `${item.rule.id}::${item.platform}::${item.username}`;

        if (result.status === 'NOT_LIVE') {
          this.activeLiveSessionMap.delete(sessionKey);
          this.serverLiveStatusMap.set(item.key, {
            status: 'IDLE',
            streamUrl: null,
            streamTitle: null,
            sourceUrl: result.sourceUrl,
            qualityInfo: null,
          });
          continue;
        }

        if (result.status === 'ERROR') {
          this.serverLiveStatusMap.set(item.key, {
            status: 'ERROR',
            streamUrl: null,
            streamTitle: null,
            sourceUrl: result.sourceUrl,
            qualityInfo: null,
          });
          continue;
        }

        // LIVE
        activeLiveCount += 1;
        this.serverLiveStatusMap.set(item.key, {
          status: 'LIVE',
          streamUrl: result.streamUrl,
          streamTitle: result.title,
          sourceUrl: result.sourceUrl,
          qualityInfo: result.qualityInfo,
        });

        const lowerTitle = `${result.title} ${item.username}`.toLowerCase();
        const isExcluded = item.excludedTerms.some((neg) => neg && lowerTitle.includes(neg));
        if (isExcluded) continue;

        const knownAndroidStatus = this.androidStateCache.reportedStatuses[item.key];
        const isAndroidBusy = knownAndroidStatus === 'RECORDING' || knownAndroidStatus === 'UPLOADING';
        const alreadyDispatched = this.activeLiveSessionMap.has(sessionKey);

        if (alreadyDispatched || isAndroidBusy) {
          continue;
        }

        this.activeLiveSessionMap.set(sessionKey, result.streamUrl);

        if (this.androidStateCache.device) {
          await this.dispatchRecordToAndroid({
            eventId: `evt_${Date.now()}_${item.username}`,
            platform: item.platform,
            username: item.username,
            usernameOrUrl: item.usernameOrUrl,
            streamUrl: result.streamUrl,
            title: result.title,
            sourceUrl: result.sourceUrl,
            qualityInfo: result.qualityInfo,
            ruleId: item.rule.id,
            detectedAt: new Date().toISOString(),
          });
        }

        // Also dispatch sandbox webhook if configured to /api/webhook-sandbox
        const state = this.loadWorkspaceStateFromDisk();
        const targetServer = state?.servers?.find((s) => s.id === item.rule.webhookServerId);
        if (targetServer && targetServer.enabled && targetServer.url === '/api/webhook-sandbox') {
          this.sandboxReceipts.unshift({
            id: `rcpt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            receivedAt: new Date().toISOString(),
            channel: 'auto-scan',
            signatureHeader: 'unsigned',
            signatureVerified: false,
            eventHeader: 'social.live.detected',
            userAgent: 'PulseRadar-AutoScan/1.0',
            payload: {
              ruleId: item.rule.id,
              platform: item.platform,
              username: item.username,
              streamUrl: result.streamUrl,
            },
          });
        }
      }

      this.androidStateCache.lastScanAt = new Date().toISOString();
      this.androidStateCache.activeLiveCount = activeLiveCount;
      await this.persistAndroidState();
    })();

    this.scanInFlight = cycle.finally(() => {
      this.scanInFlight = null;
    });
    return this.scanInFlight;
  }

  private scheduleNextAutoScan(): void {
    if (this.closed || !this.autoScanEnabled) return;
    if (this.autoScanTimer) clearTimeout(this.autoScanTimer);
    this.autoScanTimer = setTimeout(async () => {
      try {
        await this.runSingleScanCycle();
      } catch {
        // Resilient background loop
      } finally {
        this.scheduleNextAutoScan();
      }
    }, this.pollIntervalMs);
    this.autoScanTimer.unref();
  }

  async start(): Promise<void> {
    this.closed = false;
    this.server = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
        const pathname = reqUrl.pathname;
        const method = (req.method || 'GET').toUpperCase();

        if (method === 'GET' && pathname === '/') {
          const html = '<!doctype html><html><head><title>PulseRadar</title></head><body><div id="root">PulseRadar</div></body></html>';
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
          return;
        }

        if (method === 'GET' && pathname === '/api/health') {
          const tracked = this.deriveAuthoritativeTargets();
          const state = this.loadWorkspaceStateFromDisk();
          const pollSec = state?.scannerSettings?.pollIntervalSeconds ?? 30;
          const body: HealthResponse = {
            ok: true,
            port: this.listeningPort,
            autoScanEnabled: this.autoScanEnabled,
            autoScanRunning: this.autoScanEnabled && !this.closed,
            androidDevice: this.androidStateCache.device,
            trackedUsersCount: tracked.length,
            serverTime: new Date().toISOString(),
          };
          void pollSec;
          sendJson(res, 200, body);
          return;
        }

        if (method === 'GET' && pathname === '/api/android/status') {
          const state = this.loadWorkspaceStateFromDisk();
          const pollSec = state?.scannerSettings?.pollIntervalSeconds ?? 30;
          const body: AndroidStatusResponse = {
            ok: true,
            device: this.androidStateCache.device,
            scanner: {
              enabled: this.autoScanEnabled,
              running: this.autoScanEnabled && !this.closed,
              pollIntervalSeconds: pollSec,
              lastScanAt: this.androidStateCache.lastScanAt,
              activeLiveCount: this.androidStateCache.activeLiveCount,
              lastDispatchError: this.androidStateCache.lastDispatchError,
            },
          };
          sendJson(res, 200, body);
          return;
        }

        if (method === 'GET' && pathname === '/api/workspace-state') {
          const state = this.loadWorkspaceStateFromDisk();
          sendJson(res, 200, { ok: true, state });
          return;
        }

        if (method === 'PUT' && pathname === '/api/workspace-state') {
          const raw = await readRawBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            sendJson(res, 400, { ok: false, error: 'Malformed JSON body' });
            return;
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            sendJson(res, 400, { ok: false, error: 'Invalid workspace state payload' });
            return;
          }

          // Isolate workspace state: strip any rogue androidDevice/androidState field
          const obj = { ...(parsed as Record<string, unknown>) };
          delete obj.androidDevice;
          delete obj.androidState;
          obj.updatedAt = new Date().toISOString();

          await this.atomicWriteJson(this.workspaceStateFile, obj);
          sendJson(res, 200, { ok: true });
          return;
        }

        if (method === 'POST' && pathname === '/api/android/register') {
          const raw = await readRawBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            sendJson(res, 400, { ok: false, error: 'Malformed JSON body' });
            return;
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            sendJson(res, 400, { ok: false, error: 'Invalid register payload' });
            return;
          }
          const body = parsed as Record<string, unknown>;
          if (!isValidPort(body.port)) {
            sendJson(res, 400, { ok: false, error: 'Invalid port: must be integer 1..65535' });
            return;
          }

          let resolvedIp: string | null = null;
          if (body.ip === undefined || body.ip === null || body.ip === '') {
            resolvedIp = extractSocketIpv4(req.socket.remoteAddress);
          } else if (typeof body.ip === 'string' && isValidIpv4(body.ip.trim())) {
            resolvedIp = body.ip.trim();
          }

          if (!resolvedIp) {
            sendJson(res, 400, { ok: false, error: 'Invalid IPv4 address' });
            return;
          }

          const deviceId =
            typeof body.deviceId === 'string' && body.deviceId.trim().length > 0
              ? body.deviceId.trim()
              : this.androidStateCache.device?.deviceId || 'sm_n770f_default';

          const now = new Date().toISOString();
          const callbackUrl = `http://${resolvedIp}:${body.port}/record`;
          const nextDevice: AndroidDeviceRecord = {
            deviceId,
            ip: resolvedIp,
            port: body.port,
            callbackUrl,
            appVersion:
              typeof body.appVersion === 'string'
                ? body.appVersion
                : this.androidStateCache.device?.appVersion,
            networkType:
              typeof body.networkType === 'string'
                ? body.networkType
                : this.androidStateCache.device?.networkType,
            lastSeenAt: now,
            lastSyncAt: this.androidStateCache.device?.lastSyncAt ?? null,
          };

          this.androidStateCache.device = nextDevice;
          await this.persistAndroidState();

          const resp: RegisterResponse = {
            ok: true,
            deviceId,
            ip: resolvedIp,
            port: body.port,
            callbackUrl,
            serverTime: now,
          };
          sendJson(res, 200, resp);
          return;
        }

        if (method === 'POST' && pathname === '/api/android/sync') {
          const raw = await readRawBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            sendJson(res, 400, { ok: false, error: 'Malformed JSON body' });
            return;
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            sendJson(res, 400, { ok: false, error: 'Invalid sync payload' });
            return;
          }
          const body = parsed as Record<string, unknown>;
          if (!Array.isArray(body.users)) {
            sendJson(res, 400, { ok: false, error: 'Missing or non-array users field' });
            return;
          }

          // Validate port
          let resolvedPort: number | null = null;
          if (body.port !== undefined) {
            if (!isValidPort(body.port)) {
              sendJson(res, 400, { ok: false, error: 'Invalid port: must be integer 1..65535' });
              return;
            }
            resolvedPort = body.port;
          } else if (this.androidStateCache.device?.port) {
            resolvedPort = this.androidStateCache.device.port;
          } else {
            sendJson(res, 400, { ok: false, error: 'Missing port in sync payload' });
            return;
          }

          // Validate IP
          let resolvedIp: string | null = null;
          if (body.ip === undefined || body.ip === null || body.ip === '') {
            resolvedIp =
              extractSocketIpv4(req.socket.remoteAddress) ??
              this.androidStateCache.device?.ip ??
              null;
          } else if (typeof body.ip === 'string' && isValidIpv4(body.ip.trim())) {
            resolvedIp = body.ip.trim();
          }

          if (!resolvedIp) {
            sendJson(res, 400, { ok: false, error: 'Invalid IPv4 address in sync payload' });
            return;
          }

          const now = new Date().toISOString();
          const deviceId =
            typeof body.deviceId === 'string' && body.deviceId.trim().length > 0
              ? body.deviceId.trim()
              : this.androidStateCache.device?.deviceId || 'sm_n770f_default';

          // Map Android reported users by canonical key
          const androidUserMap = new Map<string, AndroidSyncUserInput & { canonicalPlatform: CanonicalPlatform; canonicalUsername: string }>();
          const reportedStatuses: Record<string, AndroidUserStatus> = {};

          for (const rawUser of body.users as AndroidSyncUserInput[]) {
            if (!rawUser || typeof rawUser !== 'object') continue;
            const cPlatform = normalizePlatform(rawUser.platform);
            if (!cPlatform) continue;
            const rawName = (rawUser.username && rawUser.username.trim()) || rawUser.usernameOrUrl || '';
            const cUsername = canonicalizeUsername(rawName, cPlatform);
            if (!cUsername) continue;
            const key = `${cPlatform}::${cUsername}`;
            androidUserMap.set(key, {
              ...rawUser,
              canonicalPlatform: cPlatform,
              canonicalUsername: cUsername,
            });
            reportedStatuses[key] = rawUser.status;
          }

          this.androidStateCache.device = {
            deviceId,
            ip: resolvedIp,
            port: resolvedPort,
            callbackUrl: `http://${resolvedIp}:${resolvedPort}/record`,
            appVersion: this.androidStateCache.device?.appVersion,
            networkType: this.androidStateCache.device?.networkType,
            lastSeenAt: now,
            lastSyncAt: now,
          };
          this.androidStateCache.reportedStatuses = reportedStatuses;
          await this.persistAndroidState();

          const authoritativeTargets = this.deriveAuthoritativeTargets();
          const authoritativeUsers: AuthoritativeUserItem[] = [];
          const toAdd: AuthoritativeUserItem[] = [];
          const toUpdate: SyncUpdateItem[] = [];
          const toRemove: SyncRemoveItem[] = [];
          const recordTriggers: RecordTriggerItem[] = [];

          const authKeySet = new Set<string>();

          for (const auth of authoritativeTargets) {
            authKeySet.add(auth.key);
            const liveInfo = this.serverLiveStatusMap.get(auth.key);
            const serverStatus: ServerLiveStatus = liveInfo?.status ?? 'IDLE';
            const androidEntry = androidUserMap.get(auth.key);
            const isActiveOnAndroid =
              androidEntry?.status === 'RECORDING' || androidEntry?.status === 'UPLOADING';

            const effectiveStatus: AndroidUserStatus = isActiveOnAndroid
              ? androidEntry!.status
              : serverStatus;

            const authItem: AuthoritativeUserItem = {
              username: auth.username,
              usernameOrUrl: auth.usernameOrUrl,
              platform: auth.platform,
              nickname: auth.username,
              isEnabled: auth.isEnabled,
              serverStatus,
              effectiveStatus,
              streamUrl: liveInfo?.streamUrl ?? null,
              streamTitle: liveInfo?.streamTitle ?? null,
              sourceUrl: liveInfo?.sourceUrl ?? `https://${auth.sourceDomain}/@${auth.username}/live`,
              qualityInfo: liveInfo?.qualityInfo ?? null,
            };
            authoritativeUsers.push(authItem);

            if (!androidEntry) {
              toAdd.push(authItem);
            } else {
              const statusDiffers = !isActiveOnAndroid && androidEntry.status !== effectiveStatus;
              const enabledDiffers = Boolean(androidEntry.isEnabled) !== auth.isEnabled;
              if (statusDiffers || enabledDiffers) {
                toUpdate.push({
                  username: auth.username,
                  usernameOrUrl: auth.usernameOrUrl,
                  platform: auth.platform,
                  isEnabled: auth.isEnabled,
                  status: effectiveStatus,
                  effectiveStatus,
                  streamUrl: authItem.streamUrl,
                  streamTitle: authItem.streamTitle,
                  sourceUrl: authItem.sourceUrl,
                  qualityInfo: authItem.qualityInfo,
                });
              }
            }

            if (
              auth.isEnabled &&
              serverStatus === 'LIVE' &&
              authItem.streamUrl &&
              authItem.streamUrl.trim().length > 0 &&
              !isActiveOnAndroid
            ) {
              recordTriggers.push({
                eventId: `sync_${Date.now()}_${auth.username}`,
                platform: auth.platform,
                username: auth.username,
                usernameOrUrl: auth.usernameOrUrl,
                streamUrl: authItem.streamUrl,
                title: authItem.streamTitle || `${auth.username} live stream`,
                sourceUrl: authItem.sourceUrl || `https://${auth.sourceDomain}/@${auth.username}/live`,
                qualityInfo: authItem.qualityInfo || 'FLV [origin]',
                detectedAt: now,
              });
            }
          }

          for (const [key, androidEntry] of androidUserMap.entries()) {
            if (!authKeySet.has(key)) {
              toRemove.push({
                username: androidEntry.canonicalUsername,
                usernameOrUrl: androidEntry.usernameOrUrl || androidEntry.canonicalUsername,
                platform: androidEntry.canonicalPlatform,
              });
            }
          }

          const resp: SyncResponse = {
            ok: true,
            syncedAt: now,
            authoritativeUsers,
            toAdd,
            toUpdate,
            toRemove,
            recordTriggers,
          };
          sendJson(res, 200, resp);
          return;
        }

        // Existing sandbox / live check / scan endpoints
        if (method === 'POST' && pathname === '/api/webhook-sandbox') {
          const raw = await readRawBody(req);
          let payload: unknown = raw;
          try {
            payload = raw ? JSON.parse(raw) : {};
          } catch {
            // Keep raw text
          }
          const sigHeader = String(req.headers['x-pulsebot-signature'] || '');
          const receipt: SandboxReceipt = {
            id: `rcpt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            receivedAt: new Date().toISOString(),
            channel: reqUrl.searchParams.get('channel') || 'default',
            signatureHeader: sigHeader || 'unsigned',
            signatureVerified: sigHeader.startsWith('sha256='),
            eventHeader: String(req.headers['x-pulsebot-event'] || 'social.keyword.detected'),
            userAgent: String(req.headers['user-agent'] || 'Unknown'),
            payload,
          };
          this.sandboxReceipts.unshift(receipt);
          if (this.sandboxReceipts.length > 50) this.sandboxReceipts.length = 50;
          sendJson(res, 200, {
            ok: true,
            server: 'PulseRadar Built-in Sandbox Receiver',
            receiptId: receipt.id,
            receivedAt: receipt.receivedAt,
            signatureVerified: receipt.signatureVerified,
          });
          return;
        }

        if (method === 'GET' && pathname === '/api/webhook-sandbox/logs') {
          sendJson(res, 200, { receipts: this.sandboxReceipts });
          return;
        }

        if (method === 'DELETE' && pathname === '/api/webhook-sandbox/logs') {
          this.sandboxReceipts.length = 0;
          sendJson(res, 200, { ok: true, receipts: [] });
          return;
        }

        if (method === 'POST' && pathname === '/api/webhook/dispatch') {
          const raw = await readRawBody(req);
          const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
          if (!body.targetUrl || typeof body.targetUrl !== 'string') {
            sendJson(res, 400, { error: 'Missing targetUrl' });
            return;
          }
          const resolvedUrl = body.targetUrl.startsWith('/')
            ? `${this.url}${body.targetUrl}`
            : body.targetUrl;
          const startedAt = Date.now();
          try {
            const resp = await fetch(resolvedUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body.payload ?? { ping: true }),
            });
            sendJson(res, 200, {
              delivered: resp.ok,
              httpStatusCode: resp.status,
              latencyMs: Date.now() - startedAt,
            });
          } catch (err) {
            sendJson(res, 200, {
              delivered: false,
              httpStatusCode: 502,
              latencyMs: Date.now() - startedAt,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          return;
        }

        if (method === 'POST' && pathname === '/api/live/check') {
          const raw = await readRawBody(req);
          let body: Record<string, unknown>;
          try {
            body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
          } catch {
            sendJson(res, 400, { ok: false, error: 'Invalid JSON' });
            return;
          }
          const target = typeof body.target === 'string' ? body.target.trim() : '';
          const targets = Array.isArray(body.targets) ? body.targets : [];
          if (!target && targets.length === 0) {
            sendJson(res, 400, { ok: false, error: 'Missing target or targets' });
            return;
          }
          const platform = normalizePlatform(body.platform || 'TIKTOK') ?? 'TIKTOK';
          if (target) {
            const username = canonicalizeUsername(target, platform);
            const result = await this.checkTargetLive(platform, username, target, 'tiktok.com');
            sendJson(res, 200, {
              ok: true,
              checkedAt: new Date().toISOString(),
              result: {
                platform,
                username,
                status: result.status,
                streamUrl: result.streamUrl,
                title: result.title,
                sourceUrl: result.sourceUrl,
                qualityInfo: result.qualityInfo,
                checkedAt: new Date().toISOString(),
              },
            });
            return;
          }
          sendJson(res, 200, {
            ok: true,
            checkedAt: new Date().toISOString(),
            results: [],
          });
          return;
        }

        if (method === 'POST' && pathname === '/api/scan') {
          const raw = await readRawBody(req);
          const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
          const customSampleText =
            typeof body.customSampleText === 'string' ? body.customSampleText.trim() : '';
          const rules = Array.isArray(body.rules) ? (body.rules as WorkspaceRule[]) : [];
          const activeRules = rules.filter((r) => r && r.enabled);
          if (customSampleText.length > 0) {
            const detections = activeRules.map((rule) => ({
              ruleId: rule.id,
              keyword: `[SIMULATOR] ${rule.keyword.split(',')[0]?.trim() || '@creator'}`,
              platform: rule.platforms,
              author: (rule.keyword.split(',')[0]?.trim() || 'creator').replace(/^@/, ''),
              title: customSampleText,
              contentSnippet: customSampleText,
              sourceUrl: 'https://tiktok.com/@creator/live',
              webhookServerName: 'Sandbox',
              webhookStatus: 'delivered' as const,
              httpStatusCode: 200,
              latencyMs: 1,
              payloadJson: JSON.stringify({ sample: customSampleText }),
              detectedAt: new Date().toISOString(),
            }));
            sendJson(res, 200, {
              ok: true,
              mode: 'simulator',
              scannedAt: new Date().toISOString(),
              totalRulesEvaluated: activeRules.length,
              totalPostsScanned: activeRules.length,
              liveSourcesQueried: ['Simulator'],
              liveStatuses: [],
              detections,
            });
            return;
          }

          await this.runSingleScanCycle();
          sendJson(res, 200, {
            ok: true,
            mode: 'live',
            scannedAt: new Date().toISOString(),
            totalRulesEvaluated: activeRules.length,
            totalPostsScanned: this.deriveAuthoritativeTargets().filter((t) => t.isEnabled).length,
            liveSourcesQueried: [],
            liveStatuses: [],
            detections: [],
          });
          return;
        }

        // E2E-only deterministic hooks (self-test mode only)
        if (method === 'POST' && pathname === '/__e2e__/simulate-live') {
          const raw = await readRawBody(req);
          const input = JSON.parse(raw) as LiveSimulationInput;
          const platform = normalizePlatform(input.platform) ?? 'TIKTOK';
          const username = canonicalizeUsername(input.username, platform);
          const key = `${platform}::${username}`;
          if (input.status === 'NOT_LIVE') {
            this.simulatedLiveMap.delete(key);
            this.serverLiveStatusMap.set(key, {
              status: 'IDLE',
              streamUrl: null,
              streamTitle: null,
              sourceUrl: input.sourceUrl ?? null,
              qualityInfo: null,
            });
          } else {
            this.simulatedLiveMap.set(key, {
              status: input.status,
              streamUrl: input.streamUrl,
              title: input.title,
              sourceUrl: input.sourceUrl,
              qualityInfo: input.qualityInfo,
              errorMessage: input.errorMessage,
              checkerDelayMs: input.checkerDelayMs,
            });
            this.serverLiveStatusMap.set(key, {
              status: input.status === 'LIVE' ? 'LIVE' : 'ERROR',
              streamUrl: input.status === 'LIVE' ? input.streamUrl ?? `https://cdn.example/${username}/origin.flv` : null,
              streamTitle: input.title ?? null,
              sourceUrl: input.sourceUrl ?? null,
              qualityInfo: input.qualityInfo ?? null,
            });
          }
          sendJson(res, 200, { ok: true, key, status: input.status });
          return;
        }

        if (method === 'POST' && pathname === '/__e2e__/tick-scan') {
          await this.runSingleScanCycle();
          sendJson(res, 200, { ok: true, lastScanAt: this.androidStateCache.lastScanAt });
          return;
        }

        if (method === 'POST' && pathname === '/__e2e__/config') {
          const raw = await readRawBody(req);
          const cfg = JSON.parse(raw) as { upstreamCheckerUrl?: string | null; autoScanEnabled?: boolean };
          if (cfg.upstreamCheckerUrl !== undefined) {
            this.upstreamCheckerUrl = cfg.upstreamCheckerUrl;
          }
          if (cfg.autoScanEnabled !== undefined) {
            this.autoScanEnabled = cfg.autoScanEnabled;
          }
          sendJson(res, 200, { ok: true });
          return;
        }

        sendJson(res, 404, { ok: false, error: `Not found: ${method} ${pathname}` });
      } catch (err) {
        sendJson(res, 500, {
          ok: false,
          error: err instanceof Error ? err.message : 'Internal server error',
        });
      }
    });

    await new Promise<void>((resolve, reject) => {
      if (!this.server) return reject(new Error('Server missing'));
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server?.address();
        if (addr && typeof addr === 'object') {
          this.listeningPort = addr.port;
        }
        resolve();
      });
    });

    if (this.autoScanEnabled) {
      this.scheduleNextAutoScan();
    }
  }

  async stop(): Promise<void> {
    this.closed = true;
    if (this.autoScanTimer) {
      clearTimeout(this.autoScanTimer);
      this.autoScanTimer = null;
    }
    if (this.scanInFlight) {
      await this.scanInFlight.catch(() => {});
    }
    if (this.server) {
      const srv = this.server;
      this.server = null;
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  }
}
