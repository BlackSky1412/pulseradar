import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { startServer, type StartedServer } from '../server';
import { createStateStore } from './stateStore';
import { createAndroidClient } from './androidClient';
import {
  canonicalizeUsername,
  extractAuthoritativeUsers,
  makeCanonicalKey,
  parseStrictPlatform,
  reconcileAndroidSync,
} from './reconcile';
import type { KeywordRuleItem } from '../src/utils/scannerEngine';
import type { BatchLiveCheckItem, BatchLiveTarget, PlatformCookies } from './liveCheckers/index';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

interface CapturedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

async function createMockAndroidReceiver(
  handler?: (
    req: CapturedRequest,
    index: number
  ) => { status?: number; body?: Record<string, unknown> }
): Promise<{
  port: number;
  url: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      let parsed: Record<string, unknown> = {};
      try {
        parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        parsed = {};
      }
      const captured: CapturedRequest = {
        method: req.method || 'GET',
        url: req.url || '/',
        headers: req.headers,
        body: parsed,
      };
      const idx = requests.push(captured) - 1;
      const responseSpec = handler
        ? handler(captured, idx)
        : {
            status: 202,
            body: {
              ok: true,
              status: 'RECORDING_STARTED',
              platform: parsed.platform,
              username: parsed.username,
            },
          };

      const status = responseSpec.status ?? 202;
      const body = responseSpec.body ?? { ok: true, status: 'RECORDING_STARTED' };
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(err => (err ? reject(err) : resolve()));
      }),
  };
}

function makeRule(overrides: Partial<KeywordRuleItem> = {}): KeywordRuleItem {
  return {
    id: 'rule_tiktok_source',
    ownerId: 'demo_user',
    keyword: '@mixigaming',
    excludedKeywords: 'tiktok.com |',
    matchType: 'regex',
    platforms: 'reddit',
    webhookServerId: 'srv_sandbox_local',
    enabled: true,
    matchCount: 0,
    createdAt: '2026-11-18T00:00:00.000Z',
    updatedAt: '2026-11-18T00:00:00.000Z',
    ...overrides,
  };
}

function createTempDir(t: test.TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulseradar-m1-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

async function startTestPulseRadar(
  t: test.TestContext,
  dataDir: string,
  options: Parameters<typeof startServer>[0] = {}
): Promise<StartedServer> {
  const instance = await startServer({
    port: 0,
    host: '127.0.0.1',
    dataDir,
    mountFrontend: false,
    autoScanEnabled: false,
    startAutoScanner: false,
    autoScanStaggerMs: 0,
    androidClientOptions: {
      timeoutMs: 1500,
      retryDelayMs: 25,
      maxRetries: 1,
    },
    ...options,
  });
  t.after(async () => {
    await instance.close();
  });
  return instance;
}

test('T1: canonical normalization, rule extraction (44 workspace users, disabled + OR merge), and reconcileAndroidSync', () => {
  assert.equal(parseStrictPlatform('reddit'), 'TIKTOK');
  assert.equal(parseStrictPlatform('hackernews'), 'INSTAGRAM');
  assert.equal(parseStrictPlatform('bluesky'), 'X');
  assert.equal(parseStrictPlatform('TWITTER'), 'X');
  assert.equal(parseStrictPlatform('github'), 'FACEBOOK');
  assert.equal(parseStrictPlatform('youtube'), null);

  assert.equal(canonicalizeUsername('@MixiGaming', 'TIKTOK'), 'mixigaming');
  assert.equal(canonicalizeUsername('mixigaming', 'TIKTOK'), 'mixigaming');
  assert.equal(canonicalizeUsername('https://www.tiktok.com/@MixiGaming/live', 'TIKTOK'), 'mixigaming');
  assert.equal(canonicalizeUsername('https://www.instagram.com/@baotran16tui', 'INSTAGRAM'), 'baotran16tui');
  assert.equal(canonicalizeUsername('https://x.com/@Minalatuinehehe', 'X'), 'minalatuinehehe');
  assert.equal(canonicalizeUsername('https://facebook.com/@phanbaotran2k', 'FACEBOOK'), 'phanbaotran2k');
  assert.equal(
    canonicalizeUsername('https://www.facebook.com/profile.php?id=100064789123456', 'FACEBOOK'),
    '100064789123456'
  );

  // Verify real workspace-state.json (read-only) extracts all 44 users cleanly
  const realWorkspacePath = path.join(PROJECT_ROOT, 'data', 'workspace-state.json');
  const realWorkspace = JSON.parse(fs.readFileSync(realWorkspacePath, 'utf-8')) as {
    rules: KeywordRuleItem[];
  };
  const realUsers = extractAuthoritativeUsers(realWorkspace.rules, {});
  assert.equal(realUsers.length, 44);
  assert.equal(realUsers.filter(u => u.platform === 'TIKTOK').length, 38);
  assert.equal(realUsers.filter(u => u.platform === 'INSTAGRAM').length, 2);
  assert.equal(realUsers.filter(u => u.platform === 'X').length, 2);
  assert.equal(realUsers.filter(u => u.platform === 'FACEBOOK').length, 2);

  // Disabled rule + OR merge + liveStatusMap attachment
  const rules: KeywordRuleItem[] = [
    makeRule({ id: 'r1', keyword: '@MixiGaming, @disabled_user', platforms: 'reddit', enabled: false }),
    makeRule({ id: 'r2', keyword: 'https://www.tiktok.com/@mixigaming/live', platforms: 'reddit', enabled: true }),
    makeRule({ id: 'r3', keyword: '@Minalatuinehehe', platforms: 'bluesky', excludedKeywords: 'x.com |', enabled: true }),
  ];

  const liveMap = {
    [makeCanonicalKey('TIKTOK', 'mixigaming')]: {
      platform: 'TIKTOK' as const,
      username: 'mixigaming',
      status: 'LIVE' as const,
      title: 'Mixi Live!',
      streamUrl: 'https://cdn.example/mixi.flv',
      sourceUrl: 'https://www.tiktok.com/@mixigaming/live',
      qualityInfo: 'FLV [origin]',
    },
    [makeCanonicalKey('TIKTOK', 'disabled_user')]: {
      platform: 'TIKTOK' as const,
      username: 'disabled_user',
      status: 'LIVE' as const,
      title: 'Disabled Live',
      streamUrl: 'https://cdn.example/disabled.flv',
    },
  };

  const authUsers = extractAuthoritativeUsers(rules, liveMap);
  assert.equal(authUsers.length, 3);

  const mixi = authUsers.find(u => u.username === 'mixigaming');
  assert.ok(mixi);
  assert.equal(mixi.isEnabled, true); // OR merge: enabled rule wins
  assert.equal(mixi.serverStatus, 'LIVE');

  const disabled = authUsers.find(u => u.username === 'disabled_user');
  assert.ok(disabled);
  assert.equal(disabled.isEnabled, false);
  assert.equal(disabled.serverStatus, 'LIVE');

  const reconcile = reconcileAndroidSync(
    authUsers,
    [
      { username: 'mixigaming', usernameOrUrl: '@mixigaming', platform: 'TIKTOK', status: 'RECORDING', isEnabled: true },
      { username: 'disabled_user', usernameOrUrl: '@disabled_user', platform: 'TIKTOK', status: 'LIVE', isEnabled: true },
      { username: 'stale_user', usernameOrUrl: 'stale_user', platform: 'TIKTOK', status: 'IDLE', isEnabled: true },
    ],
    { syncedAt: '2026-11-18T17:00:00.000Z', nowMs: 1763485200000 }
  );

  // mixigaming is RECORDING on Android -> preserved, not in toUpdate, no duplicate trigger
  const recMixi = reconcile.authoritativeUsers.find(u => u.username === 'mixigaming');
  assert.equal(recMixi?.effectiveStatus, 'RECORDING');
  assert.equal(reconcile.recordTriggers.length, 0);
  assert.deepEqual(
    reconcile.toAdd.map(u => `${u.platform}::${u.username}`),
    ['X::minalatuinehehe']
  );
  assert.deepEqual(
    reconcile.toUpdate.map(u => `${u.platform}::${u.username}`),
    ['TIKTOK::disabled_user']
  );
  assert.deepEqual(
    reconcile.toRemove.map(u => `${u.platform}::${u.username}`),
    ['TIKTOK::stale_user']
  );
});

test('T2: POST /api/android/register validates IPv4/port, supports socket ::ffff: fallback, and updates GET /api/android/status', async t => {
  const dataDir = createTempDir(t);
  const server = await startTestPulseRadar(t, dataDir);

  // Invalid ports -> 400
  for (const badPort of [0, -1, 65536, 80.5, 'abc']) {
    const res = await fetch(`${server.url}/api/android/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip: '192.168.1.9', port: badPort }),
    });
    assert.equal(res.status, 400);
  }

  // Invalid IPv4 -> 400
  for (const badIp of ['not-an-ip', '999.1.2.3', '::1', 12345]) {
    const res = await fetch(`${server.url}/api/android/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip: badIp, port: 8765 }),
    });
    assert.equal(res.status, 400);
  }

  // Valid explicit IPv4 + port
  const okRes = await fetch(`${server.url}/api/android/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deviceId: 'sm_n770f_test',
      ip: '192.168.1.9',
      port: 8765,
      appVersion: '1.2.0',
      networkType: 'WIFI',
    }),
  });
  assert.equal(okRes.status, 200);
  const okBody = (await okRes.json()) as Record<string, unknown>;
  assert.equal(okBody.ok, true);
  assert.equal(okBody.deviceId, 'sm_n770f_test');
  assert.equal(okBody.callbackUrl, 'http://192.168.1.9:8765/record');

  // Omitted IP -> socket remoteAddress fallback (127.0.0.1)
  const fallbackRes = await fetch(`${server.url}/api/android/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ port: 9001 }),
  });
  assert.equal(fallbackRes.status, 200);
  const fallbackBody = (await fallbackRes.json()) as Record<string, unknown>;
  assert.equal(fallbackBody.ip, '127.0.0.1');
  assert.equal(fallbackBody.callbackUrl, 'http://127.0.0.1:9001/record');

  const statusRes = await fetch(`${server.url}/api/android/status`);
  assert.equal(statusRes.status, 200);
  const statusBody = (await statusRes.json()) as {
    ok: boolean;
    device: { callbackUrl: string; ip: string; port: number };
  };
  assert.equal(statusBody.ok, true);
  assert.equal(statusBody.device.ip, '127.0.0.1');
  assert.equal(statusBody.device.port, 9001);
  assert.equal(statusBody.device.callbackUrl, 'http://127.0.0.1:9001/record');
});

test('T3: Autonomous live scan dispatches Contract 2 POST /record, deduplicates, resets on NOT_LIVE, respects Android RECORDING, and coalesces single-flight', async t => {
  const dataDir = createTempDir(t);
  const receiver = await createMockAndroidReceiver();
  t.after(() => receiver.close());

  let liveMode: 'LIVE' | 'NOT_LIVE' = 'LIVE';
  let checkCalls = 0;
  let capturedCookies: PlatformCookies = {};
  let holdFirstCheck: (() => void) | null = null;
  let holdPromise: Promise<void> | null = null;

  const mockBatchCheck = async (
    targets: BatchLiveTarget[],
    cookies: PlatformCookies = {}
  ): Promise<BatchLiveCheckItem[]> => {
    checkCalls += 1;
    capturedCookies = cookies;
    if (holdPromise) {
      await holdPromise;
    }
    return targets.map(item => ({
      target: item.target,
      ruleId: item.ruleId,
      result:
        liveMode === 'LIVE'
          ? {
              status: 'LIVE',
              platform: 'TIKTOK',
              username: 'mixigaming',
              title: 'Mixi Stream Night',
              streamUrl: 'https://cdn.example/origin.flv',
              sourceUrl: 'https://www.tiktok.com/@mixigaming/live',
              qualityInfo: 'FLV [origin]',
              method: 'mock',
              checkedAt: '2026-11-18T17:01:00.000Z',
            }
          : {
              status: 'NOT_LIVE',
              platform: 'TIKTOK',
              username: 'mixigaming',
              sourceUrl: 'https://www.tiktok.com/@mixigaming/live',
              checkedAt: '2026-11-18T17:02:00.000Z',
            },
    }));
  };

  const server = await startTestPulseRadar(t, dataDir, {
    liveCheckBatchFn: mockBatchCheck,
    envCookies: { instagram: 'env_ig_cookie' },
  });

  await server.stateStore.writeWorkspaceState({
    rules: [makeRule({ id: 'rule_tiktok_source', keyword: '@mixigaming', platforms: 'reddit', enabled: true })],
    scannerSettings: {
      cookies: { tiktok: 'ws_tt_cookie', instagram: '', facebook: '', x: '' },
      pollIntervalSeconds: 30,
      deduplicateLive: true,
    },
  });

  // Register Android receiver
  const regRes = await fetch(`${server.url}/api/android/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: 'sm_n770f_1', ip: '127.0.0.1', port: receiver.port }),
  });
  assert.equal(regRes.status, 200);

  // Single-flight test: hold first check and call runOnce() twice concurrently
  holdPromise = new Promise<void>(resolve => {
    holdFirstCheck = resolve;
  });
  const p1 = server.autoScanner.runOnce();
  const p2 = server.autoScanner.runOnce();
  assert.equal(server.autoScanner.isScanning(), true);
  holdFirstCheck!();
  holdPromise = null;
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(checkCalls, 1);
  assert.equal(r1.dispatchedCount, 1);
  assert.equal(r2.dispatchedCount, 1);
  assert.equal(capturedCookies.tiktok, 'ws_tt_cookie');
  assert.equal(capturedCookies.instagram, 'env_ig_cookie');

  // Verify Contract 2 payload
  assert.equal(receiver.requests.length, 1);
  const payload = receiver.requests[0].body;
  assert.equal(receiver.requests[0].url, '/record');
  assert.equal(payload.platform, 'TIKTOK');
  assert.equal(payload.username, 'mixigaming');
  assert.equal(payload.usernameOrUrl, '@mixigaming');
  assert.equal(payload.streamUrl, 'https://cdn.example/origin.flv');
  assert.equal(payload.title, 'Mixi Stream Night');
  assert.equal(payload.sourceUrl, 'https://www.tiktok.com/@mixigaming/live');
  assert.equal(payload.qualityInfo, 'FLV [origin]');
  assert.equal(payload.ruleId, 'rule_tiktok_source');
  assert.ok(typeof payload.eventId === 'string' && payload.eventId.length > 0);
  assert.ok(typeof payload.detectedAt === 'string' && payload.detectedAt.length > 0);

  // Second scan while still LIVE -> deduplicated (0 new requests)
  const r3 = await server.autoScanner.runOnce();
  assert.equal(r3.dispatchedCount, 0);
  assert.equal(r3.skippedDeduplicatedCount, 1);
  assert.equal(receiver.requests.length, 1);

  // Transition NOT_LIVE -> clears activeSession -> back to LIVE -> dispatches again
  liveMode = 'NOT_LIVE';
  await server.autoScanner.runOnce();
  liveMode = 'LIVE';
  await server.autoScanner.runOnce();
  assert.equal(receiver.requests.length, 2);

  // If NOT_LIVE resets activeSessions, but Android reports RECORDING via /api/android/sync, next LIVE scan skips dispatch
  liveMode = 'NOT_LIVE';
  await server.autoScanner.runOnce();
  await fetch(`${server.url}/api/android/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ip: '127.0.0.1',
      port: receiver.port,
      users: [
        { username: 'mixigaming', usernameOrUrl: '@mixigaming', platform: 'TIKTOK', status: 'RECORDING', isEnabled: true },
      ],
    }),
  });
  liveMode = 'LIVE';
  const rBusy = await server.autoScanner.runOnce();
  assert.equal(rBusy.skippedDeduplicatedCount, 1);
  assert.equal(receiver.requests.length, 2);
});

test('T4: Dynamic IP re-registration routes subsequent live triggers to new Android IP/port', async t => {
  const dataDir = createTempDir(t);
  const receiverA = await createMockAndroidReceiver();
  const receiverB = await createMockAndroidReceiver();
  t.after(async () => {
    await receiverA.close();
    await receiverB.close();
  });

  let activeTarget = '@mixigaming';
  const mockBatchCheck = async (targets: BatchLiveTarget[]): Promise<BatchLiveCheckItem[]> =>
    targets.map(item => ({
      target: item.target,
      ruleId: item.ruleId,
      result:
        item.target === activeTarget
          ? {
              status: 'LIVE',
              platform: 'TIKTOK',
              username: activeTarget.replace(/^@/, ''),
              title: `${activeTarget} Live`,
              streamUrl: `https://cdn.example/${activeTarget.replace(/^@/, '')}.flv`,
              sourceUrl: `https://www.tiktok.com/${activeTarget}/live`,
              checkedAt: '2026-11-18T17:05:00.000Z',
            }
          : {
              status: 'NOT_LIVE',
              platform: 'TIKTOK',
              username: item.target.replace(/^@/, ''),
              sourceUrl: `https://www.tiktok.com/${item.target}/live`,
              checkedAt: '2026-11-18T17:05:00.000Z',
            },
    }));

  const server = await startTestPulseRadar(t, dataDir, { liveCheckBatchFn: mockBatchCheck });
  await server.stateStore.writeWorkspaceState({
    rules: [makeRule({ keyword: '@mixigaming, @vtv24', platforms: 'reddit', enabled: true })],
  });

  // Register Receiver A
  await fetch(`${server.url}/api/android/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ip: '127.0.0.1', port: receiverA.port }),
  });
  await server.autoScanner.runOnce();
  assert.equal(receiverA.requests.length, 1);
  assert.equal(receiverA.requests[0].body.username, 'mixigaming');
  assert.equal(receiverB.requests.length, 0);

  // Re-register Receiver B
  const reReg = await fetch(`${server.url}/api/android/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ip: '127.0.0.1', port: receiverB.port }),
  });
  assert.equal(reReg.status, 200);

  // New live detection @vtv24
  activeTarget = '@vtv24';
  await server.autoScanner.runOnce();
  assert.equal(receiverA.requests.length, 1);
  assert.equal(receiverB.requests.length, 1);
  assert.equal(receiverB.requests[0].body.username, 'vtv24');
});

test('T5: Android dispatch retries once on 5xx/network error, does not retry 4xx, and records lastDispatchError without crashing', async t => {
  const dataDir = createTempDir(t);

  // 1) 500 on attempt 1, 202 on attempt 2 -> succeeds on retry
  let flakeyCalls = 0;
  const flakeyReceiver = await createMockAndroidReceiver(() => {
    flakeyCalls += 1;
    if (flakeyCalls === 1) {
      return { status: 500, body: { ok: false, error: 'Transient error' } };
    }
    return { status: 202, body: { ok: true, status: 'RECORDING_STARTED' } };
  });
  t.after(() => flakeyReceiver.close());

  const mockLive = async (targets: BatchLiveTarget[]): Promise<BatchLiveCheckItem[]> =>
    targets.map(item => ({
      target: item.target,
      ruleId: item.ruleId,
      result: {
        status: 'LIVE',
        platform: 'TIKTOK',
        username: 'mixigaming',
        title: 'Live Retry Test',
        streamUrl: 'https://cdn.example/retry.flv',
        sourceUrl: 'https://www.tiktok.com/@mixigaming/live',
        checkedAt: '2026-11-18T17:10:00.000Z',
      },
    }));

  const server = await startTestPulseRadar(t, dataDir, { liveCheckBatchFn: mockLive });
  await server.stateStore.writeWorkspaceState({
    rules: [makeRule({ keyword: '@mixigaming', enabled: true })],
  });
  await fetch(`${server.url}/api/android/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ip: '127.0.0.1', port: flakeyReceiver.port }),
  });

  const retryCycle = await server.autoScanner.runOnce();
  assert.equal(flakeyCalls, 2);
  assert.equal(retryCycle.dispatchedCount, 1);
  assert.equal(retryCycle.failedDispatchCount, 0);

  // 2) Unit test 400 -> no retry (attempts === 1)
  let badCalls = 0;
  const badReceiver = await createMockAndroidReceiver(() => {
    badCalls += 1;
    return { status: 400, body: { ok: false, error: 'Blank streamUrl' } };
  });
  t.after(() => badReceiver.close());

  const client = createAndroidClient({ timeoutMs: 1000, retryDelayMs: 20, maxRetries: 1 });
  const badRes = await client.dispatchRecord(
    { ip: '127.0.0.1', port: badReceiver.port, callbackUrl: `${badReceiver.url}/record` },
    {
      eventId: 'evt_bad',
      platform: 'TIKTOK',
      username: 'mixigaming',
      usernameOrUrl: '@mixigaming',
      streamUrl: 'https://cdn.example/retry.flv',
      title: 'Test',
      sourceUrl: 'https://www.tiktok.com/@mixigaming/live',
      detectedAt: '2026-11-18T17:10:00.000Z',
    }
  );
  assert.equal(badRes.ok, false);
  assert.equal(badRes.httpStatus, 400);
  assert.equal(badRes.attempts, 1);
  assert.equal(badCalls, 1);
  assert.ok(client.getLastDispatchError()?.includes('HTTP 400'));

  // 3) Unreachable receiver -> autoScanner doesn't throw, records lastDispatchError, doesn't lock activeSessions
  const deadReceiver = await createMockAndroidReceiver();
  const deadPort = deadReceiver.port;
  await deadReceiver.close();

  const dataDir2 = createTempDir(t);
  const server2 = await startTestPulseRadar(t, dataDir2, { liveCheckBatchFn: mockLive });
  await server2.stateStore.writeWorkspaceState({
    rules: [makeRule({ keyword: '@mixigaming', enabled: true })],
  });
  await fetch(`${server2.url}/api/android/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ip: '127.0.0.1', port: deadPort }),
  });

  const failCycle = await server2.autoScanner.runOnce();
  assert.equal(failCycle.dispatchedCount, 0);
  assert.equal(failCycle.failedDispatchCount, 1);

  const statusRes = await fetch(`${server2.url}/api/android/status`);
  const statusJson = (await statusRes.json()) as {
    scanner: { lastDispatchError: string | null };
  };
  assert.ok(statusJson.scanner.lastDispatchError && statusJson.scanner.lastDispatchError.length > 0);
  const stateAfterFail = await server2.stateStore.readAndroidState();
  assert.equal(stateAfterFail.activeSessions['TIKTOK::mixigaming'], undefined);
});

test('T6: POST /api/android/sync performs server-authoritative reconciliation, preserves RECORDING, emits recordTriggers, and validates payloads', async t => {
  const dataDir = createTempDir(t);
  const server = await startTestPulseRadar(t, dataDir);

  await server.stateStore.writeWorkspaceState({
    rules: [
      makeRule({
        id: 'rule_enabled',
        keyword: '@mixigaming, @ebe_m72, @new_user, @rec_user',
        platforms: 'reddit',
        enabled: true,
      }),
      makeRule({
        id: 'rule_disabled',
        keyword: '@disabled_user',
        platforms: 'reddit',
        enabled: false,
      }),
    ],
  });

  await server.stateStore.updateAndroidState(draft => {
    draft.liveStatusMap = {
      'TIKTOK::mixigaming': {
        canonicalKey: 'TIKTOK::mixigaming',
        ruleId: 'rule_enabled',
        target: '@mixigaming',
        platform: 'TIKTOK',
        username: 'mixigaming',
        status: 'LIVE',
        title: 'Mixi Live',
        streamUrl: 'https://cdn.example/mixi.flv',
        sourceUrl: 'https://www.tiktok.com/@mixigaming/live',
        qualityInfo: 'FLV [origin]',
        checkedAt: '2026-11-18T17:15:00.000Z',
      },
      'TIKTOK::rec_user': {
        canonicalKey: 'TIKTOK::rec_user',
        ruleId: 'rule_enabled',
        target: '@rec_user',
        platform: 'TIKTOK',
        username: 'rec_user',
        status: 'LIVE',
        title: 'Rec User Live',
        streamUrl: 'https://cdn.example/rec.flv',
        sourceUrl: 'https://www.tiktok.com/@rec_user/live',
        checkedAt: '2026-11-18T17:15:00.000Z',
      },
      'TIKTOK::disabled_user': {
        canonicalKey: 'TIKTOK::disabled_user',
        ruleId: 'rule_disabled',
        target: '@disabled_user',
        platform: 'TIKTOK',
        username: 'disabled_user',
        status: 'LIVE',
        title: 'Disabled Live',
        streamUrl: 'https://cdn.example/disabled.flv',
        sourceUrl: 'https://www.tiktok.com/@disabled_user/live',
        checkedAt: '2026-11-18T17:15:00.000Z',
      },
    };
  });

  // Malformed payload -> 400
  const badSyncRes = await fetch(`${server.url}/api/android/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ip: '192.168.1.9', port: 8765, users: 'not-array' }),
  });
  assert.equal(badSyncRes.status, 400);

  const badPlatformRes = await fetch(`${server.url}/api/android/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ip: '192.168.1.9',
      port: 8765,
      users: [{ username: 'abc', platform: 'TWITCH', status: 'IDLE' }],
    }),
  });
  assert.equal(badPlatformRes.status, 400);

  // Valid sync payload
  const syncRes = await fetch(`${server.url}/api/android/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deviceId: 'sm_n770f_sync',
      ip: '192.168.1.42',
      port: 8765,
      users: [
        { username: 'ebe_m72', usernameOrUrl: '@ebe_m72', platform: 'TIKTOK', status: 'IDLE', isEnabled: true },
        { username: 'mixigaming', usernameOrUrl: '@mixigaming', platform: 'TIKTOK', status: 'IDLE', isEnabled: true },
        { username: 'stale_user', usernameOrUrl: 'stale_user', platform: 'TIKTOK', status: 'IDLE', isEnabled: true },
        { username: 'rec_user', usernameOrUrl: '@rec_user', platform: 'TIKTOK', status: 'RECORDING', isEnabled: true },
        { username: 'disabled_user', usernameOrUrl: '@disabled_user', platform: 'TIKTOK', status: 'LIVE', isEnabled: true },
      ],
    }),
  });
  assert.equal(syncRes.status, 200);
  const syncBody = (await syncRes.json()) as {
    ok: boolean;
    syncedAt: string;
    authoritativeUsers: Array<{ username: string; effectiveStatus: string; isEnabled: boolean }>;
    toAdd: Array<{ username: string }>;
    toUpdate: Array<{ username: string; isEnabled: boolean }>;
    toRemove: Array<{ username: string }>;
    recordTriggers: Array<{ username: string; streamUrl: string }>;
  };

  assert.equal(syncBody.ok, true);
  assert.deepEqual(syncBody.toAdd.map(u => u.username), ['new_user']);
  assert.deepEqual(syncBody.toRemove.map(u => u.username), ['stale_user']);
  assert.deepEqual(syncBody.recordTriggers.map(tItem => tItem.username), ['mixigaming']);
  assert.equal(
    syncBody.authoritativeUsers.find(u => u.username === 'rec_user')?.effectiveStatus,
    'RECORDING'
  );
  assert.ok(syncBody.toUpdate.some(u => u.username === 'disabled_user' && u.isEnabled === false));
  assert.ok(!syncBody.toUpdate.some(u => u.username === 'rec_user'));

  const statusRes = await fetch(`${server.url}/api/android/status`);
  const statusBody = (await statusRes.json()) as {
    device: { ip: string; port: number; lastSyncAt: string | null };
  };
  assert.equal(statusBody.device.ip, '192.168.1.42');
  assert.equal(statusBody.device.lastSyncAt, syncBody.syncedAt);
});

test('T7: State isolation, concurrent queue writes without .tmp leaks, PUT /api/workspace-state non-clobbering, and autonomous boot loop', async t => {
  const dataDir = createTempDir(t);
  const store = createStateStore(dataDir);

  // Concurrent writes to both files
  await Promise.all([
    store.writeWorkspaceState({ rules: [makeRule({ keyword: '@u1' })] }),
    store.writeWorkspaceState({ rules: [makeRule({ keyword: '@u1, @u2' })] }),
    store.updateAndroidState(d => {
      d.activeSessions['TIKTOK::u1'] = 'https://cdn.example/1.flv';
    }),
    store.updateAndroidState(d => {
      d.activeSessions['TIKTOK::u2'] = 'https://cdn.example/2.flv';
    }),
  ]);
  await store.flush();

  const files = fs.readdirSync(dataDir);
  assert.equal(files.some(f => f.endsWith('.tmp')), false);
  const wsAfter = await store.readWorkspaceState();
  const androidAfter = await store.readAndroidState();
  assert.equal(wsAfter.rules[0].keyword, '@u1, @u2');
  assert.equal(androidAfter.activeSessions['TIKTOK::u1'], 'https://cdn.example/1.flv');
  assert.equal(androidAfter.activeSessions['TIKTOK::u2'], 'https://cdn.example/2.flv');

  // Boot server with autonomous scanner enabled on ephemeral port in a fresh temp dataDir
  const dataDir2 = createTempDir(t);
  const store2 = createStateStore(dataDir2);
  await store2.writeWorkspaceState({ rules: [makeRule({ keyword: '@u1, @u2' })] });

  const receiver = await createMockAndroidReceiver();
  t.after(() => receiver.close());

  const server = await startTestPulseRadar(t, dataDir2, {
    autoScanEnabled: true,
    startAutoScanner: true,
    autoScanIntervalMs: 50,
    autoScanInitialDelayMs: 15,
    liveCheckBatchFn: async (targets: BatchLiveTarget[]): Promise<BatchLiveCheckItem[]> =>
      targets.map(item => ({
        target: item.target,
        ruleId: item.ruleId,
        result: {
          status: 'LIVE',
          platform: 'TIKTOK',
          username: item.target.replace(/^@/, ''),
          title: 'Boot Loop Live',
          streamUrl: `https://cdn.example/${item.target.replace(/^@/, '')}.flv`,
          sourceUrl: `https://www.tiktok.com/${item.target}/live`,
          checkedAt: new Date().toISOString(),
        },
      })),
  });

  // Register Android device
  await fetch(`${server.url}/api/android/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: 'sm_boot', ip: '127.0.0.1', port: receiver.port }),
  });

  // Wait deterministically for autonomous loop to scan and dispatch @u1 and @u2
  const deadline = Date.now() + 2000;
  while (receiver.requests.length < 2 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 20));
  }

  // PUT /api/workspace-state must NOT clobber android-state.json
  const putRes = await fetch(`${server.url}/api/workspace-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rules: [makeRule({ keyword: '@u1, @u2, @u3' })],
      servers: [],
      alerts: [],
      scannerSettings: {
        cookies: { tiktok: '', instagram: '', facebook: '', x: '' },
        pollIntervalSeconds: 30,
        deduplicateLive: true,
      },
    }),
  });
  assert.equal(putRes.status, 200);

  const healthRes = await fetch(`${server.url}/api/health`);
  assert.equal(healthRes.status, 200);
  const healthBody = (await healthRes.json()) as {
    ok: boolean;
    port: number;
    autoScanEnabled: boolean;
    autoScanRunning: boolean;
    androidDevice: { deviceId: string } | null;
    trackedUsersCount: number;
  };
  assert.equal(healthBody.ok, true);
  assert.equal(healthBody.port, server.port);
  assert.equal(healthBody.autoScanEnabled, true);
  assert.equal(healthBody.autoScanRunning, true);
  assert.equal(healthBody.androidDevice?.deviceId, 'sm_boot');
  assert.equal(healthBody.trackedUsersCount, 3);

  const statusRes = await fetch(`${server.url}/api/android/status`);
  const statusBody = (await statusRes.json()) as {
    ok: boolean;
    device: { deviceId: string } | null;
    scanner: { enabled: boolean; running: boolean };
  };
  assert.equal(statusBody.ok, true);
  assert.equal(statusBody.device?.deviceId, 'sm_boot');
  assert.equal(statusBody.scanner.enabled, true);
  assert.equal(statusBody.scanner.running, true);
  assert.ok(receiver.requests.length >= 2);
});

test('T8: Regression — duplicate [RECORDING, IDLE] sync merges by priority, rejects non-string usernames, and rejects bare URLs', async t => {
  // (c) canonicalizeUsername rejects bare URLs
  assert.equal(canonicalizeUsername('https://www.tiktok.com/', 'TIKTOK'), '');
  assert.equal(canonicalizeUsername('https://www.tiktok.com', 'TIKTOK'), '');
  assert.equal(canonicalizeUsername('https://www.instagram.com/', 'INSTAGRAM'), '');
  assert.equal(canonicalizeUsername('https://www.facebook.com/', 'FACEBOOK'), '');
  assert.equal(canonicalizeUsername('https://x.com/', 'X'), '');

  // Also verify reconcileAndroidSync ignores non-string username objects
  const safeReconcile = reconcileAndroidSync(
    [],
    [{ username: { bad: 1 } as unknown as string, platform: 'TIKTOK', status: 'IDLE' }]
  );
  assert.equal(safeReconcile.toRemove.length, 0);

  const dataDir = createTempDir(t);
  const receiver = await createMockAndroidReceiver();
  t.after(() => receiver.close());

  const server = await startTestPulseRadar(t, dataDir, {
    liveCheckBatchFn: async (targets: BatchLiveTarget[]): Promise<BatchLiveCheckItem[]> =>
      targets.map(item => ({
        target: item.target,
        ruleId: item.ruleId,
        result: {
          status: 'LIVE',
          platform: 'TIKTOK',
          username: 'mixigaming',
          title: 'Mixi Live',
          streamUrl: 'https://cdn.example/mixi.flv',
          sourceUrl: 'https://www.tiktok.com/@mixigaming/live',
          checkedAt: '2026-11-18T17:20:00.000Z',
        },
      })),
  });

  await server.stateStore.writeWorkspaceState({
    rules: [makeRule({ id: 'rule_mixi', keyword: '@mixigaming', platforms: 'reddit', enabled: true })],
  });

  await fetch(`${server.url}/api/android/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: 'sm_dup', ip: '127.0.0.1', port: receiver.port }),
  });

  // (b) Reject non-string username / usernameOrUrl and bare URLs with HTTP 400
  for (const badUser of [
    { username: { bad: 1 }, platform: 'TIKTOK', status: 'IDLE' },
    { username: ['arr'], platform: 'TIKTOK', status: 'IDLE' },
    { username: 123, platform: 'TIKTOK', status: 'IDLE' },
    { username: 'mixigaming', usernameOrUrl: { bad: 1 }, platform: 'TIKTOK', status: 'IDLE' },
    { usernameOrUrl: 'https://www.tiktok.com/', platform: 'TIKTOK', status: 'IDLE' },
  ]) {
    const badRes = await fetch(`${server.url}/api/android/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ip: '127.0.0.1',
        port: receiver.port,
        users: [badUser],
      }),
    });
    assert.equal(badRes.status, 400);
  }

  // (a) Duplicate [RECORDING, IDLE] sync rows persist RECORDING and suppress duplicate autoScanner dispatch
  const dupSyncRes = await fetch(`${server.url}/api/android/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deviceId: 'sm_dup',
      ip: '127.0.0.1',
      port: receiver.port,
      users: [
        { username: '@MixiGaming', platform: 'TIKTOK', status: 'RECORDING', isEnabled: true },
        { username: 'mixigaming', platform: 'TIKTOK', status: 'IDLE', isEnabled: true },
      ],
    }),
  });
  assert.equal(dupSyncRes.status, 200);
  const dupBody = (await dupSyncRes.json()) as {
    authoritativeUsers: Array<{ username: string; effectiveStatus: string }>;
    recordTriggers: unknown[];
  };
  assert.equal(
    dupBody.authoritativeUsers.find(u => u.username === 'mixigaming')?.effectiveStatus,
    'RECORDING'
  );
  assert.equal(dupBody.recordTriggers.length, 0);

  const persistedState = await server.stateStore.readAndroidState();
  assert.equal(persistedState.reportedUsers['TIKTOK::mixigaming']?.status, 'RECORDING');

  const scanRes = await server.autoScanner.runOnce();
  assert.equal(scanRes.liveCount, 1);
  assert.equal(scanRes.skippedDeduplicatedCount, 1);
  assert.equal(scanRes.dispatchedCount, 0);
  assert.equal(receiver.requests.length, 0);
});

test('T9: Regression — PORT=0 env binds an ephemeral non-3000 port in startServer()', async t => {
  const dataDir = createTempDir(t);
  const prevPort = process.env.PORT;
  const restorePort = () => {
    if (prevPort === undefined) {
      delete process.env.PORT;
    } else {
      process.env.PORT = prevPort;
    }
  };
  t.after(restorePort);

  process.env.PORT = '0';
  let server: StartedServer;
  try {
    server = await startServer({
      host: '127.0.0.1',
      dataDir,
      mountFrontend: false,
      autoScanEnabled: false,
      startAutoScanner: false,
    });
  } finally {
    restorePort();
  }

  t.after(async () => {
    await server.close();
  });

  assert.ok(server.port > 0);
  assert.notEqual(server.port, 3000);

  const healthRes = await fetch(`${server.url}/api/health`);
  assert.equal(healthRes.status, 200);
  const healthBody = (await healthRes.json()) as { ok: boolean; port: number };
  assert.equal(healthBody.ok, true);
  assert.equal(healthBody.port, server.port);
});

test('T10: Regression — disabling or emptying rules clears stale activeSessions and liveStatusMap', async t => {
  const dataDir = createTempDir(t);
  const receiver = await createMockAndroidReceiver();
  t.after(() => receiver.close());

  const server = await startTestPulseRadar(t, dataDir, {
    liveCheckBatchFn: async (targets: BatchLiveTarget[]): Promise<BatchLiveCheckItem[]> =>
      targets.map(item => {
        const uname = item.target.replace(/^@/, '').toLowerCase();
        return {
          target: item.target,
          ruleId: item.ruleId,
          result: {
            status: 'LIVE',
            platform: 'TIKTOK',
            username: uname,
            title: `${uname} Live`,
            streamUrl: `https://cdn.example/${uname}.flv`,
            sourceUrl: `https://www.tiktok.com/@${uname}/live`,
            checkedAt: '2026-11-18T17:25:00.000Z',
          },
        };
      }),
  });

  await fetch(`${server.url}/api/android/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: 'sm_prune', ip: '127.0.0.1', port: receiver.port }),
  });

  const ruleMixi = makeRule({ id: 'rule_mixi', keyword: '@mixigaming', platforms: 'reddit', enabled: true });
  const ruleVtv = makeRule({ id: 'rule_vtv', keyword: '@vtv24', platforms: 'reddit', enabled: true });
  await server.stateStore.writeWorkspaceState({ rules: [ruleMixi, ruleVtv] });

  const firstScan = await server.autoScanner.runOnce();
  assert.equal(firstScan.dispatchedCount, 2);
  assert.equal(receiver.requests.length, 2);

  // Disable rule_mixi while both are LIVE -> mixigaming pruned from activeSessions & liveStatusMap
  await server.stateStore.writeWorkspaceState({
    rules: [{ ...ruleMixi, enabled: false }, ruleVtv],
  });
  const secondScan = await server.autoScanner.runOnce();
  assert.equal(secondScan.targetsChecked, 1);
  assert.equal(secondScan.dispatchedCount, 0);
  assert.equal(secondScan.skippedDeduplicatedCount, 1);

  const afterDisable = await server.stateStore.readAndroidState();
  assert.equal(afterDisable.activeSessions['TIKTOK::mixigaming'], undefined);
  assert.equal(afterDisable.liveStatusMap['TIKTOK::mixigaming'], undefined);
  assert.ok(afterDisable.activeSessions['TIKTOK::vtv24']);
  assert.equal(afterDisable.liveStatusMap['TIKTOK::vtv24']?.status, 'LIVE');

  // Re-enable rule_mixi while mixigaming is still LIVE -> should dispatch again (not suppressed)
  await server.stateStore.writeWorkspaceState({
    rules: [{ ...ruleMixi, enabled: true }, ruleVtv],
  });
  const thirdScan = await server.autoScanner.runOnce();
  assert.equal(thirdScan.dispatchedCount, 1);
  assert.equal(thirdScan.skippedDeduplicatedCount, 1);
  assert.equal(receiver.requests.length, 3);
  assert.equal(receiver.requests[2].body.username, 'mixigaming');

  // Disable all rules (jobs.length === 0) -> clears liveStatusMap and activeSessions completely
  await server.stateStore.writeWorkspaceState({
    rules: [
      { ...ruleMixi, enabled: false },
      { ...ruleVtv, enabled: false },
    ],
  });
  const emptyScan = await server.autoScanner.runOnce();
  assert.equal(emptyScan.targetsChecked, 0);

  const afterEmpty = await server.stateStore.readAndroidState();
  assert.deepEqual(afterEmpty.activeSessions, {});
  assert.deepEqual(afterEmpty.liveStatusMap, {});
});
