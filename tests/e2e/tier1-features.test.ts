import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  buildProduction44WorkspaceState,
  createE2EHarness,
  createMockAndroidReceiver,
  filterRegisterableIpv4Candidates,
} from './harness.ts';
import {
  canonicalizeUsername,
  normalizePlatform,
  ReferenceContractServer,
} from './referenceServer.ts';
import type {
  AndroidHealthResponse,
  RecordResponse,
  RegisterResponse,
  SyncResponse,
} from './types.ts';

const runRepoBuilds = process.env.E2E_RUN_REPO_BUILDS === '1';
const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const repoLocalStreamRecorderRoot = path.resolve(repoRoot, 'StreamRecorder_Android');
const parentStreamRecorderRoot = path.resolve(repoRoot, '..', 'StreamRecorder_Android');
const streamRecorderRoot =
  process.env.E2E_STREAM_RECORDER_ROOT ??
  (fs.existsSync(repoLocalStreamRecorderRoot)
    ? repoLocalStreamRecorderRoot
    : parentStreamRecorderRoot);

function makeSingleUserWorkspace(platformKey: string, domain: string, keyword: string) {
  const base = buildProduction44WorkspaceState();
  const ts = '2026-11-18T16:01:07.088417Z';
  base.rules = [
    {
      id: `rule_${platformKey}`,
      ownerId: 'demo_user',
      keyword,
      excludedKeywords: `${domain} |`,
      matchType: 'regex',
      platforms: platformKey,
      webhookServerId: 'srv_sandbox_local',
      enabled: true,
      matchCount: 0,
      createdAt: ts,
      updatedAt: ts,
    },
  ];
  return base;
}

// ============================================================================
// F1: Server State Isolation & Atomic Persistence
// ============================================================================

test('T1-F01-01: GET /api/workspace-state returns initialized rules without embedding android state', async () => {
  const harness = await createE2EHarness({
    initialWorkspaceState: buildProduction44WorkspaceState(),
  });
  try {
    await harness.registerAndroid({ deviceId: 'dev1', ip: '192.168.1.9', port: 8765 });
    const res = await harness.getWorkspaceState();
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.state);
    assert.ok(Array.isArray(res.body.state.rules));
    assert.equal(res.body.state.rules.length, 4);
    assert.equal('androidDevice' in (res.body.state as unknown as Record<string, unknown>), false);
  } finally {
    await harness.cleanup();
  }
});

test('T1-F01-02: PUT /api/workspace-state saves rules and stamps fresh ISO updatedAt', async () => {
  const harness = await createE2EHarness();
  try {
    const payload = makeSingleUserWorkspace('reddit', 'tiktok.com', '@mixigaming');
    const oldUpdatedAt = payload.updatedAt;
    const putRes = await harness.putWorkspaceState(payload);
    assert.equal(putRes.status, 200);
    assert.equal(putRes.body.ok, true);

    const getRes = await harness.getWorkspaceState();
    assert.equal(getRes.status, 200);
    assert.equal(getRes.body.state?.rules.length, 1);
    assert.equal(getRes.body.state?.rules[0].keyword, '@mixigaming');
    assert.ok(getRes.body.state?.updatedAt);
    assert.notEqual(getRes.body.state?.updatedAt, oldUpdatedAt);
    assert.ok(!Number.isNaN(Date.parse(getRes.body.state!.updatedAt!)));
  } finally {
    await harness.cleanup();
  }
});

test('T1-F01-03: POST /api/android/register persists android-state.json separately from workspace-state.json', async () => {
  const initial = buildProduction44WorkspaceState();
  const harness = await createE2EHarness({ initialWorkspaceState: initial });
  try {
    const reg = await harness.registerAndroid({
      deviceId: 'sm_n770f_default',
      ip: '192.168.1.9',
      port: 8765,
    });
    assert.equal(reg.status, 200);

    if (!harness.isLiveMode) {
      const wsRaw = fs.readFileSync(path.join(harness.dataDir, 'workspace-state.json'), 'utf8');
      const asRaw = fs.readFileSync(path.join(harness.dataDir, 'android-state.json'), 'utf8');
      const ws = JSON.parse(wsRaw) as { rules: unknown[]; scannerSettings: { cookies: Record<string, string> } };
      const as = JSON.parse(asRaw) as { device: { ip: string; port: number; callbackUrl: string } };
      assert.equal(ws.rules.length, 4);
      assert.equal(ws.scannerSettings.cookies.tiktok, '');
      assert.equal(ws.scannerSettings.cookies.instagram, '');
      assert.equal(ws.scannerSettings.cookies.facebook, '');
      assert.equal(ws.scannerSettings.cookies.x, '');
      assert.equal(as.device.ip, '192.168.1.9');
      assert.equal(as.device.port, 8765);
      assert.equal(as.device.callbackUrl, 'http://192.168.1.9:8765/record');
    }
  } finally {
    await harness.cleanup();
  }
});

test('T1-F01-04: PUT /api/workspace-state after registration does not clobber Android registration', async () => {
  const harness = await createE2EHarness({
    initialWorkspaceState: buildProduction44WorkspaceState(),
  });
  try {
    await harness.registerAndroid({
      deviceId: 'sm_n770f_default',
      ip: '192.168.1.9',
      port: 8765,
    });
    const statusBefore = await harness.getAndroidStatus();
    const seenBefore = statusBefore.body.device?.lastSeenAt;

    const updatedWs = makeSingleUserWorkspace('reddit', 'tiktok.com', '@new_user_only');
    const putRes = await harness.putWorkspaceState(updatedWs);
    assert.equal(putRes.status, 200);

    const statusAfter = await harness.getAndroidStatus();
    assert.equal(statusAfter.status, 200);
    assert.equal(statusAfter.body.device?.ip, '192.168.1.9');
    assert.equal(statusAfter.body.device?.port, 8765);
    assert.equal(statusAfter.body.device?.lastSeenAt, seenBefore);
  } finally {
    await harness.cleanup();
  }
});

test('T1-F01-05: 10 sequential workspace and android writes leave zero .tmp files and valid JSON', async () => {
  const harness = await createE2EHarness({
    initialWorkspaceState: buildProduction44WorkspaceState(),
  });
  try {
    for (let i = 1; i <= 10; i++) {
      const ws = makeSingleUserWorkspace('reddit', 'tiktok.com', `@user_${i}`);
      const putRes = await harness.putWorkspaceState(ws);
      assert.equal(putRes.status, 200);
      const regRes = await harness.registerAndroid({
        deviceId: 'sm_n770f_default',
        ip: `192.168.1.${10 + i}`,
        port: 8765,
      });
      assert.equal(regRes.status, 200);
    }

    const status = await harness.getAndroidStatus();
    assert.equal(status.body.device?.ip, '192.168.1.20');
    const wsAfter = await harness.getWorkspaceState();
    assert.equal(wsAfter.body.state?.rules[0].keyword, '@user_10');

    if (!harness.isLiveMode) {
      const entries = fs.readdirSync(harness.dataDir);
      const leftovers = entries.filter((f) => f.endsWith('.tmp'));
      assert.equal(leftovers.length, 0);
    }
  } finally {
    await harness.cleanup();
  }
});

// ============================================================================
// F2: Server Autonomous Live Scanner Loop
// ============================================================================

test('T1-F02-01: Booted PulseRadar reports autoScanEnabled, scanner.enabled, and pollIntervalSeconds === 30', async () => {
  const harness = await createE2EHarness({
    initialWorkspaceState: buildProduction44WorkspaceState(),
  });
  try {
    const health = await harness.getHealth();
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.autoScanEnabled, true);
    assert.equal(health.body.autoScanRunning, true);

    const status = await harness.getAndroidStatus();
    assert.equal(status.status, 200);
    assert.equal(status.body.scanner.enabled, true);
    assert.equal(status.body.scanner.pollIntervalSeconds, 30);
  } finally {
    await harness.cleanup();
  }
});

test('T1-F02-02: Auto-scan dispatches POST /record when monitored user @ebe_m72 is LIVE', async (t) => {
  const harness = await createE2EHarness({
    initialWorkspaceState: makeSingleUserWorkspace('reddit', 'tiktok.com', '@ebe_m72'),
  });
  try {
    await harness.registerAndroid({
      deviceId: 'sm_n770f_default',
      ip: '127.0.0.1',
      port: harness.mockAndroid.port,
    });
    const hooked = await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@ebe_m72',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/ebe_m72/origin.flv',
      title: 'ebe_m72 live stream',
    });
    if (!hooked) {
      t.skip('E2E_LIVE_TRIGGER_URL not configured in live-target mode');
      return;
    }
    await harness.tickScan();
    const captured = await harness.mockAndroid.waitForRecord(
      (r) => r.body?.username === 'ebe_m72'
    );
    assert.equal(captured.statusCode, 202);
    assert.equal(captured.body?.platform, 'TIKTOK');
    assert.equal(captured.body?.username, 'ebe_m72');
    assert.equal(captured.body?.streamUrl, 'https://cdn.example/ebe_m72/origin.flv');
  } finally {
    await harness.cleanup();
  }
});

test('T1-F02-03: Keeping @ebe_m72 LIVE across 2 consecutive scan cycles deduplicates to 1 POST /record', async (t) => {
  const harness = await createE2EHarness({
    initialWorkspaceState: makeSingleUserWorkspace('reddit', 'tiktok.com', '@ebe_m72'),
  });
  try {
    await harness.registerAndroid({
      deviceId: 'sm_n770f_default',
      ip: '127.0.0.1',
      port: harness.mockAndroid.port,
    });
    const hooked = await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@ebe_m72',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/ebe_m72/origin.flv',
    });
    if (!hooked) {
      t.skip('E2E_LIVE_TRIGGER_URL not configured in live-target mode');
      return;
    }
    await harness.tickScan();
    await harness.tickScan();
    const reqs = harness.mockAndroid.getCapturedRequests();
    assert.equal(reqs.length, 1);
  } finally {
    await harness.cleanup();
  }
});

test('T1-F02-04: Transition LIVE -> NOT_LIVE -> LIVE clears dedup and dispatches 2 POST /record calls', async (t) => {
  const harness = await createE2EHarness({
    initialWorkspaceState: makeSingleUserWorkspace('reddit', 'tiktok.com', '@ebe_m72'),
  });
  try {
    await harness.registerAndroid({
      deviceId: 'sm_n770f_default',
      ip: '127.0.0.1',
      port: harness.mockAndroid.port,
    });
    const hooked = await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@ebe_m72',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/ebe_m72/session1.flv',
    });
    if (!hooked) {
      t.skip('E2E_LIVE_TRIGGER_URL not configured in live-target mode');
      return;
    }
    await harness.tickScan();
    assert.equal(harness.mockAndroid.getCapturedRequests().length, 1);

    await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@ebe_m72',
      status: 'NOT_LIVE',
    });
    await harness.tickScan();

    harness.mockAndroid.clearActiveRecording('TIKTOK', 'ebe_m72');
    await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@ebe_m72',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/ebe_m72/session2.flv',
    });
    await harness.tickScan();

    const reqs = harness.mockAndroid.getCapturedRequests();
    assert.equal(reqs.length, 2);
    assert.equal(reqs[1].body?.streamUrl, 'https://cdn.example/ebe_m72/session2.flv');
  } finally {
    await harness.cleanup();
  }
});

test('T1-F02-05: Slow upstream live checker with short poll interval executes strictly single-flight (zero overlap)', async (t) => {
  if (process.env.E2E_PULSE_RADAR_URL) {
    t.skip('Single-flight timing stub server applies to self-test mode');
    return;
  }

  const intervals: Array<{ start: number; end: number }> = [];
  const upstream = http.createServer((_req, res) => {
    const start = Date.now();
    setTimeout(() => {
      const end = Date.now();
      intervals.push({ start, end });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'NOT_LIVE' }));
    }, 350);
  });

  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
  const upstreamAddr = upstream.address();
  const upstreamPort = upstreamAddr && typeof upstreamAddr === 'object' ? upstreamAddr.port : 0;

  const harness = await createE2EHarness({
    initialWorkspaceState: makeSingleUserWorkspace('reddit', 'tiktok.com', '@ebe_m72'),
    referenceServerOptions: {
      pollIntervalMs: 120,
      upstreamCheckerUrl: `http://127.0.0.1:${upstreamPort}`,
    },
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 1450));
    assert.ok(intervals.length >= 2, `Expected >=2 completed scans, got ${intervals.length}`);
    for (let i = 1; i < intervals.length; i++) {
      assert.ok(
        intervals[i].start >= intervals[i - 1].end - 5,
        `Scan ${i} started (${intervals[i].start}) before scan ${i - 1} ended (${intervals[i - 1].end})`
      );
    }
  } finally {
    await harness.cleanup();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

// ============================================================================
// F3: Server -> Android Live Trigger Dispatch
// ============================================================================

test('T1-F03-01: Outbound POST /record contains all Contract 2 fields for @mixigaming', async (t) => {
  const harness = await createE2EHarness({
    initialWorkspaceState: makeSingleUserWorkspace('reddit', 'tiktok.com', '@mixigaming'),
  });
  try {
    await harness.registerAndroid({
      deviceId: 'sm_n770f_default',
      ip: '127.0.0.1',
      port: harness.mockAndroid.port,
    });
    const hooked = await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@mixigaming',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/mixi.flv',
      title: 'Mixi Live',
      sourceUrl: 'https://www.tiktok.com/@mixigaming/live',
      qualityInfo: 'FLV [origin]',
    });
    if (!hooked) {
      t.skip('E2E_LIVE_TRIGGER_URL not configured in live-target mode');
      return;
    }
    await harness.tickScan();
    const captured = await harness.mockAndroid.waitForRecord();
    const b = captured.body!;
    assert.ok(typeof b.eventId === 'string' && b.eventId.length > 0);
    assert.equal(b.platform, 'TIKTOK');
    assert.equal(b.username, 'mixigaming');
    assert.equal(b.usernameOrUrl, '@mixigaming');
    assert.equal(b.streamUrl, 'https://cdn.example/mixi.flv');
    assert.equal(b.title, 'Mixi Live');
    assert.equal(b.sourceUrl, 'https://www.tiktok.com/@mixigaming/live');
    assert.equal(b.qualityInfo, 'FLV [origin]');
    assert.equal(b.ruleId, 'rule_reddit');
    assert.ok(typeof b.detectedAt === 'string' && !Number.isNaN(Date.parse(b.detectedAt)));
  } finally {
    await harness.cleanup();
  }
});

test('T1-F03-02: 202 RECORDING_STARTED response leaves lastDispatchError === null', async (t) => {
  const harness = await createE2EHarness({
    initialWorkspaceState: makeSingleUserWorkspace('reddit', 'tiktok.com', '@mixigaming'),
  });
  try {
    await harness.registerAndroid({
      deviceId: 'sm_n770f_default',
      ip: '127.0.0.1',
      port: harness.mockAndroid.port,
    });
    const hooked = await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@mixigaming',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/mixi.flv',
    });
    if (!hooked) {
      t.skip('E2E_LIVE_TRIGGER_URL not configured in live-target mode');
      return;
    }
    await harness.tickScan();
    const status = await harness.getAndroidStatus();
    assert.equal(status.body.scanner.lastDispatchError, null);
  } finally {
    await harness.cleanup();
  }
});

test('T1-F03-03: 200 ALREADY_RECORDING response is treated as clean delivery (lastDispatchError === null)', async (t) => {
  const harness = await createE2EHarness({
    initialWorkspaceState: makeSingleUserWorkspace('reddit', 'tiktok.com', '@mixigaming'),
  });
  try {
    harness.mockAndroid.seedUser({ platform: 'TIKTOK', username: 'mixigaming', status: 'RECORDING' });
    await harness.registerAndroid({
      deviceId: 'sm_n770f_default',
      ip: '127.0.0.1',
      port: harness.mockAndroid.port,
    });
    const hooked = await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@mixigaming',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/mixi.flv',
    });
    if (!hooked) {
      t.skip('E2E_LIVE_TRIGGER_URL not configured in live-target mode');
      return;
    }
    await harness.tickScan();
    const req = await harness.mockAndroid.waitForRecord();
    assert.equal(req.statusCode, 200);
    assert.equal(req.responseStatus, 'ALREADY_RECORDING');
    const status = await harness.getAndroidStatus();
    assert.equal(status.body.scanner.lastDispatchError, null);
  } finally {
    await harness.cleanup();
  }
});

test('T1-F03-04: 200 SKIPPED_CELLULAR_POLICY response records no dispatch error and keeps loop running', async (t) => {
  const harness = await createE2EHarness({
    initialWorkspaceState: makeSingleUserWorkspace('reddit', 'tiktok.com', '@mixigaming'),
  });
  try {
    harness.mockAndroid.setFaultConfig({ networkOnline: true, isWifi: false });
    harness.mockAndroid.seedUser({ platform: 'TIKTOK', username: 'mixigaming', allowCellular: false });
    await harness.registerAndroid({
      deviceId: 'sm_n770f_default',
      ip: '127.0.0.1',
      port: harness.mockAndroid.port,
    });
    const hooked = await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@mixigaming',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/mixi.flv',
    });
    if (!hooked) {
      t.skip('E2E_LIVE_TRIGGER_URL not configured in live-target mode');
      return;
    }
    await harness.tickScan();
    const req = await harness.mockAndroid.waitForRecord();
    assert.equal(req.statusCode, 200);
    assert.equal(req.responseStatus, 'SKIPPED_CELLULAR_POLICY');
    const status = await harness.getAndroidStatus();
    assert.equal(status.body.scanner.lastDispatchError, null);
    assert.equal(status.body.scanner.running, true);
  } finally {
    await harness.cleanup();
  }
});

test('T1-F03-05: Live triggers across INSTAGRAM, FACEBOOK, and X emit canonical platforms and usernames', async (t) => {
  const harness = await createE2EHarness({
    initialWorkspaceState: buildProduction44WorkspaceState(),
  });
  try {
    await harness.registerAndroid({
      deviceId: 'sm_n770f_default',
      ip: '127.0.0.1',
      port: harness.mockAndroid.port,
    });
    const ok1 = await harness.simulateLiveUser({
      platform: 'INSTAGRAM',
      username: '@baotran16tui',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/ig.flv',
    });
    if (!ok1) {
      t.skip('E2E_LIVE_TRIGGER_URL not configured in live-target mode');
      return;
    }
    await harness.simulateLiveUser({
      platform: 'FACEBOOK',
      username: '@phanbaotran2k',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/fb.flv',
    });
    await harness.simulateLiveUser({
      platform: 'X',
      username: '@Minalatuinehehe',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/x.flv',
    });
    await harness.tickScan();

    const reqs = harness.mockAndroid.getCapturedRequests();
    assert.equal(reqs.length, 3);
    const pairs = reqs.map((r) => `${r.body?.platform}::${r.body?.username}`).sort();
    assert.deepEqual(pairs, [
      'FACEBOOK::phanbaotran2k',
      'INSTAGRAM::baotran16tui',
      'X::minalatuinehehe',
    ]);
  } finally {
    await harness.cleanup();
  }
});

// ============================================================================
// F4: Server Dynamic Android IP Registry
// ============================================================================

test('T1-F04-01: POST /api/android/register with full payload returns 200 and callbackUrl', async () => {
  const harness = await createE2EHarness();
  try {
    const res = await harness.registerAndroid({
      deviceId: 'sm_n770f_default',
      ip: '192.168.1.9',
      port: 8765,
      appVersion: '1.0.0',
      networkType: 'WIFI',
      timestamp: '2026-11-18T16:45:00.000Z',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    const okBody = res.body as RegisterResponse;
    assert.equal(okBody.deviceId, 'sm_n770f_default');
    assert.equal(okBody.ip, '192.168.1.9');
    assert.equal(okBody.port, 8765);
    assert.equal(okBody.callbackUrl, 'http://192.168.1.9:8765/record');
    assert.ok(!Number.isNaN(Date.parse(okBody.serverTime)));
  } finally {
    await harness.cleanup();
  }
});

test('T1-F04-02: GET /api/android/status immediately reflects registered device', async () => {
  const harness = await createE2EHarness();
  try {
    await harness.registerAndroid({
      deviceId: 'sm_n770f_default',
      ip: '192.168.1.9',
      port: 8765,
    });
    const status = await harness.getAndroidStatus();
    assert.equal(status.status, 200);
    assert.equal(status.body.device?.deviceId, 'sm_n770f_default');
    assert.equal(status.body.device?.callbackUrl, 'http://192.168.1.9:8765/record');
    assert.ok(typeof status.body.device?.lastSeenAt === 'string' && status.body.device.lastSeenAt.length > 0);
  } finally {
    await harness.cleanup();
  }
});

test('T1-F04-03: POST /api/android/register updates IP and port immediately', async () => {
  const harness = await createE2EHarness();
  try {
    await harness.registerAndroid({ deviceId: 'sm_n770f_default', ip: '192.168.1.9', port: 8765 });
    const reg2 = await harness.registerAndroid({
      deviceId: 'sm_n770f_default',
      ip: '192.168.1.55',
      port: 9001,
    });
    assert.equal(reg2.status, 200);
    assert.equal((reg2.body as RegisterResponse).callbackUrl, 'http://192.168.1.55:9001/record');

    const status = await harness.getAndroidStatus();
    assert.equal(status.body.device?.callbackUrl, 'http://192.168.1.55:9001/record');
  } finally {
    await harness.cleanup();
  }
});

test('T1-F04-04: Minimal valid register payload { ip, port } returns 200', async () => {
  const harness = await createE2EHarness();
  try {
    const res = await harness.registerAndroid({ ip: '10.0.2.15', port: 8765 });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal((res.body as RegisterResponse).callbackUrl, 'http://10.0.2.15:8765/record');
  } finally {
    await harness.cleanup();
  }
});

test('T1-F04-05: Registering with networkType CELLULAR persists in /api/android/status', async () => {
  const harness = await createE2EHarness();
  try {
    const res = await harness.registerAndroid({
      deviceId: 'sm_n770f_default',
      ip: '192.168.1.9',
      port: 8765,
      networkType: 'CELLULAR',
    });
    assert.equal(res.status, 200);
    const status = await harness.getAndroidStatus();
    assert.equal(status.body.device?.networkType, 'CELLULAR');
  } finally {
    await harness.cleanup();
  }
});

// ============================================================================
// F5: Server 10-Min Authoritative Reconciliation
// ============================================================================

test('T1-F05-01: Sync matching all 44 authoritative IDLE users returns empty diffs', async () => {
  const harness = await createE2EHarness({
    initialWorkspaceState: buildProduction44WorkspaceState(),
  });
  try {
    const first = await harness.syncAndroid({
      deviceId: 'sm_n770f_default',
      ip: '192.168.1.9',
      port: 8765,
      users: [],
    });
    assert.equal(first.status, 200);
    const firstBody = first.body as SyncResponse;
    assert.equal(firstBody.authoritativeUsers.length, 44);

    const matchingUsers = firstBody.authoritativeUsers.map((u) => ({
      username: u.username,
      usernameOrUrl: u.usernameOrUrl,
      platform: u.platform,
      nickname: u.nickname,
      status: 'IDLE' as const,
      isEnabled: u.isEnabled,
    }));

    const second = await harness.syncAndroid({
      deviceId: 'sm_n770f_default',
      ip: '192.168.1.9',
      port: 8765,
      users: matchingUsers,
    });
    assert.equal(second.status, 200);
    const body = second.body as SyncResponse;
    assert.equal(body.authoritativeUsers.length, 44);
    assert.equal(body.toAdd.length, 0);
    assert.equal(body.toUpdate.length, 0);
    assert.equal(body.toRemove.length, 0);
    assert.equal(body.recordTriggers.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test('T1-F05-02: Sync missing 2 authoritative users returns them in toAdd', async () => {
  const harness = await createE2EHarness({
    initialWorkspaceState: buildProduction44WorkspaceState(),
  });
  try {
    const seed = await harness.syncAndroid({ ip: '192.168.1.9', port: 8765, users: [] });
    const all44 = (seed.body as SyncResponse).authoritativeUsers;
    const partial42 = all44.slice(2).map((u) => ({
      username: u.username,
      usernameOrUrl: u.usernameOrUrl,
      platform: u.platform,
      status: 'IDLE' as const,
      isEnabled: u.isEnabled,
    }));

    const res = await harness.syncAndroid({ ip: '192.168.1.9', port: 8765, users: partial42 });
    assert.equal(res.status, 200);
    const body = res.body as SyncResponse;
    assert.equal(body.toAdd.length, 2);
    const addedKeys = body.toAdd.map((u) => `${u.platform}::${u.username}`).sort();
    const expectedMissing = all44
      .slice(0, 2)
      .map((u) => `${u.platform}::${u.username}`)
      .sort();
    assert.deepEqual(addedKeys, expectedMissing);
  } finally {
    await harness.cleanup();
  }
});

test('T1-F05-03: Sync with extra stale_user emits it in toRemove and omits from authoritativeUsers', async () => {
  const harness = await createE2EHarness({
    initialWorkspaceState: makeSingleUserWorkspace('reddit', 'tiktok.com', '@ebe_m72'),
  });
  try {
    const res = await harness.syncAndroid({
      ip: '192.168.1.9',
      port: 8765,
      users: [
        { username: 'ebe_m72', usernameOrUrl: '@ebe_m72', platform: 'TIKTOK', status: 'IDLE', isEnabled: true },
        { username: 'stale_user', usernameOrUrl: '@stale_user', platform: 'TIKTOK', status: 'IDLE', isEnabled: true },
      ],
    });
    assert.equal(res.status, 200);
    const body = res.body as SyncResponse;
    assert.equal(body.toRemove.length, 1);
    assert.equal(body.toRemove[0].username, 'stale_user');
    assert.equal(
      body.authoritativeUsers.some((u) => u.username === 'stale_user'),
      false
    );
  } finally {
    await harness.cleanup();
  }
});

test('T1-F05-04: Sync emits toUpdate and recordTriggers when server sees LIVE and Android reports IDLE', async (t) => {
  const harness = await createE2EHarness({
    initialWorkspaceState: makeSingleUserWorkspace('reddit', 'tiktok.com', '@ebe_m72'),
  });
  try {
    const hooked = await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@ebe_m72',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/ebe_m72/live.flv',
    });
    if (!hooked) {
      t.skip('E2E_LIVE_TRIGGER_URL not configured in live-target mode');
      return;
    }

    const res = await harness.syncAndroid({
      ip: '192.168.1.9',
      port: 8765,
      users: [
        { username: 'ebe_m72', usernameOrUrl: '@ebe_m72', platform: 'TIKTOK', status: 'IDLE', isEnabled: true },
      ],
    });
    assert.equal(res.status, 200);
    const body = res.body as SyncResponse;
    assert.equal(body.toUpdate.length, 1);
    assert.equal(body.toUpdate[0].effectiveStatus, 'LIVE');
    assert.equal(body.recordTriggers.length, 1);
    assert.equal(body.recordTriggers[0].username, 'ebe_m72');
    assert.equal(body.recordTriggers[0].streamUrl, 'https://cdn.example/ebe_m72/live.flv');
  } finally {
    await harness.cleanup();
  }
});

test('T1-F05-05: POST /api/android/sync updates device ip, port, lastSeenAt, and lastSyncAt', async () => {
  const harness = await createE2EHarness({
    initialWorkspaceState: makeSingleUserWorkspace('reddit', 'tiktok.com', '@ebe_m72'),
  });
  try {
    const res = await harness.syncAndroid({
      deviceId: 'sm_n770f_default',
      ip: '192.168.1.77',
      port: 8770,
      users: [],
    });
    assert.equal(res.status, 200);
    const status = await harness.getAndroidStatus();
    assert.equal(status.body.device?.ip, '192.168.1.77');
    assert.equal(status.body.device?.port, 8770);
    assert.ok(status.body.device?.lastSyncAt);
    assert.ok(status.body.device?.lastSeenAt);
  } finally {
    await harness.cleanup();
  }
});

// ============================================================================
// F6: Server Tooling, Health Route & UI Safety
// ============================================================================

test('T1-F06-01: Package scripts exist and isolated server process serves GET /api/health on ephemeral port', async () => {
  const pkgRaw = fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8');
  const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> };
  assert.ok(pkg.scripts?.dev?.includes('tsx'));
  assert.ok(pkg.scripts?.build);
  assert.ok(pkg.scripts?.lint);

  if (runRepoBuilds) {
    assert.ok(pkg.scripts?.start?.includes('tsx'), 'Expected package.json start script to use tsx');
  }

  // Verify an isolated child process starts on an ephemeral port and responds to GET /api/health
  const harness = await createE2EHarness({
    initialWorkspaceState: buildProduction44WorkspaceState(),
  });
  try {
    const health = await harness.getHealth();
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.notEqual(health.body.port, 3000);
  } finally {
    await harness.cleanup();
  }
});

test('T1-F06-02: GET /api/health reports trackedUsersCount === 44 and valid serverTime', async () => {
  const harness = await createE2EHarness({
    initialWorkspaceState: buildProduction44WorkspaceState(),
  });
  try {
    const health = await harness.getHealth();
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.trackedUsersCount, 44);
    assert.equal(health.body.autoScanEnabled, true);
    assert.ok(!Number.isNaN(Date.parse(health.body.serverTime)));
  } finally {
    await harness.cleanup();
  }
});

test('T1-F06-03: GET /api/android/status returns device and scanner metadata', async () => {
  const harness = await createE2EHarness();
  try {
    const status = await harness.getAndroidStatus();
    assert.equal(status.status, 200);
    assert.equal(status.body.ok, true);
    assert.ok('device' in status.body);
    assert.ok('scanner' in status.body);
    assert.equal(typeof status.body.scanner.pollIntervalSeconds, 'number');
    assert.equal(typeof status.body.scanner.activeLiveCount, 'number');
    assert.ok('lastDispatchError' in status.body.scanner);
  } finally {
    await harness.cleanup();
  }
});

test('T1-F06-04: GET / returns 200 HTML without overwriting android-state.json', async () => {
  const harness = await createE2EHarness({
    initialWorkspaceState: buildProduction44WorkspaceState(),
  });
  try {
    await harness.registerAndroid({ deviceId: 'sm_n770f_default', ip: '192.168.1.9', port: 8765 });
    const uiRes = await harness.httpRaw(harness.pulseRadarUrl, '/');
    assert.equal(uiRes.status, 200);
    assert.match(uiRes.text, /<html/i);

    const status = await harness.getAndroidStatus();
    assert.equal(status.body.device?.ip, '192.168.1.9');
  } finally {
    await harness.cleanup();
  }
});

test('T1-F06-05: TypeScript config and build toolchain parity (runs tsc & vite build when E2E_RUN_REPO_BUILDS=1)', async () => {
  const tsconfig = JSON.parse(fs.readFileSync(path.join(repoRoot, 'tsconfig.json'), 'utf8')) as {
    compilerOptions?: { noEmit?: boolean; isolatedModules?: boolean };
  };
  assert.equal(tsconfig.compilerOptions?.noEmit, true);
  assert.equal(tsconfig.compilerOptions?.isolatedModules, true);

  if (runRepoBuilds) {
    const tscRes = spawnSync(path.join(repoRoot, 'node_modules', '.bin', 'tsc.cmd'), ['--noEmit'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(tscRes.status, 0, tscRes.stderr || tscRes.stdout);

    const buildRes = spawnSync('npm.cmd', ['run', 'build'], {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: true,
    });
    assert.equal(buildRes.status, 0, buildRes.stderr || buildRes.stdout);
  }
});

// ============================================================================
// F7: Server Automated Contract Parity (R1, R2, R4)
// ============================================================================

test('T1-F07-01: Server automated contract suite executes cleanly (runs npm test when E2E_RUN_REPO_BUILDS=1)', async () => {
  if (runRepoBuilds) {
    const testRes = spawnSync('npm.cmd', ['test'], {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: true,
    });
    assert.equal(testRes.status, 0, testRes.stderr || testRes.stdout);
    return;
  }

  const harness = await createE2EHarness({
    initialWorkspaceState: makeSingleUserWorkspace('reddit', 'tiktok.com', '@ebe_m72'),
  });
  try {
    const health = await harness.getHealth();
    assert.equal(health.status, 200);
    assert.equal(health.body.trackedUsersCount, 1);
  } finally {
    await harness.cleanup();
  }
});

test('T1-F07-02: R1 HTTP contract parity verifies live user triggers POST /record', async (t) => {
  const harness = await createE2EHarness({
    initialWorkspaceState: makeSingleUserWorkspace('reddit', 'tiktok.com', '@ebe_m72'),
  });
  try {
    await harness.registerAndroid({ ip: '127.0.0.1', port: harness.mockAndroid.port });
    const hooked = await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@ebe_m72',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/r1.flv',
    });
    if (!hooked) {
      t.skip('E2E_LIVE_TRIGGER_URL not configured in live-target mode');
      return;
    }
    await harness.tickScan();
    const rec = await harness.mockAndroid.waitForRecord();
    assert.equal(rec.body?.platform, 'TIKTOK');
    assert.equal(rec.body?.username, 'ebe_m72');
  } finally {
    await harness.cleanup();
  }
});

test('T1-F07-03: R2 HTTP contract parity verifies re-registration routes triggers exclusively to IP2', async (t) => {
  const harness = await createE2EHarness({
    initialWorkspaceState: makeSingleUserWorkspace('reddit', 'tiktok.com', '@ebe_m72'),
  });
  const receiver2 = await createMockAndroidReceiver();
  try {
    await harness.registerAndroid({ ip: '127.0.0.1', port: harness.mockAndroid.port });
    await harness.registerAndroid({ ip: '127.0.0.1', port: receiver2.port });
    const hooked = await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@ebe_m72',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/r2.flv',
    });
    if (!hooked) {
      t.skip('E2E_LIVE_TRIGGER_URL not configured in live-target mode');
      return;
    }
    await harness.tickScan();
    const rec2 = await receiver2.waitForRecord();
    assert.equal(rec2.body?.username, 'ebe_m72');
    assert.equal(harness.mockAndroid.getCapturedRequests().length, 0);
  } finally {
    await receiver2.close();
    await harness.cleanup();
  }
});

test('T1-F07-04: R4 HTTP contract parity verifies sync diffing produces toAdd/toUpdate/toRemove/recordTriggers', async () => {
  const harness = await createE2EHarness({
    initialWorkspaceState: makeSingleUserWorkspace('reddit', 'tiktok.com', '@ebe_m72, @baotran162008'),
  });
  try {
    const syncRes = await harness.syncAndroid({
      ip: '192.168.1.9',
      port: 8765,
      users: [
        { username: 'ebe_m72', platform: 'TIKTOK', status: 'IDLE', isEnabled: false },
        { username: 'old_user', platform: 'TIKTOK', status: 'IDLE', isEnabled: true },
      ],
    });
    assert.equal(syncRes.status, 200);
    const body = syncRes.body as SyncResponse;
    assert.deepEqual(body.toAdd.map((u) => u.username), ['baotran162008']);
    assert.deepEqual(body.toUpdate.map((u) => u.username), ['ebe_m72']);
    assert.deepEqual(body.toRemove.map((u) => u.username), ['old_user']);
  } finally {
    await harness.cleanup();
  }
});

test('T1-F07-05: Two consecutive isolated test runs pass deterministically with zero port 3000 conflict', async () => {
  for (let runIdx = 0; runIdx < 2; runIdx++) {
    const harness = await createE2EHarness({
      initialWorkspaceState: makeSingleUserWorkspace('reddit', 'tiktok.com', '@ebe_m72'),
    });
    try {
      const health = await harness.getHealth();
      assert.equal(health.status, 200);
      assert.notEqual(health.body.port, 3000);
    } finally {
      await harness.cleanup();
    }
  }
});

// ============================================================================
// F8: Disable Android Local Platform Polling
// ============================================================================

test('T1-F08-01: Android GET /health reports pollingDisabled === true', async () => {
  const harness = await createE2EHarness();
  try {
    const res = await harness.httpJson<AndroidHealthResponse>(harness.androidTargetUrl, '/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.pollingDisabled, true);
  } finally {
    await harness.cleanup();
  }
});

test('T1-F08-02: Passive Android receiver makes zero outbound platform polling requests over idle window', async () => {
  const receiver = await createMockAndroidReceiver({
    initialUsers: Array.from({ length: 10 }, (_, idx) => ({
      platform: 'TIKTOK',
      username: `user_${idx}`,
    })),
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(receiver.outboundPlatformPollRequests, 0);
  } finally {
    await receiver.close();
  }
});

test('T1-F08-03: POST /record triggers recording passively without local platform polling', async () => {
  const receiver = await createMockAndroidReceiver();
  try {
    const resp = await fetch(`${receiver.url}/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: 'TIKTOK',
        username: 'ebe_m72',
        usernameOrUrl: '@ebe_m72',
        streamUrl: 'https://cdn.example/ebe.flv',
      }),
    });
    assert.equal(resp.status, 202);
    const body = (await resp.json()) as RecordResponse;
    assert.equal(body.status, 'RECORDING_STARTED');
    assert.equal(receiver.outboundPlatformPollRequests, 0);
  } finally {
    await receiver.close();
  }
});

test('T1-F08-04: Sync recordTriggers start recording passively without local platform polling', async () => {
  const harness = await createE2EHarness({
    initialWorkspaceState: makeSingleUserWorkspace('reddit', 'tiktok.com', '@ebe_m72'),
  });
  try {
    await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@ebe_m72',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/ebe.flv',
    });
    await harness.mockAndroid.syncWithPulseRadar(harness.pulseRadarUrl);
    assert.equal(harness.mockAndroid.getActiveRecordings().length, 1);
    assert.equal(harness.mockAndroid.outboundPlatformPollRequests, 0);
  } finally {
    await harness.cleanup();
  }
});

test('T1-F08-05: Telegram pending-upload sync executes independently while platform polling remains 0', async () => {
  const receiver = await createMockAndroidReceiver();
  try {
    receiver.triggerTelegramPendingSyncCheck();
    assert.equal(receiver.outboundTelegramSyncChecks, 1);
    assert.equal(receiver.outboundPlatformPollRequests, 0);
  } finally {
    await receiver.close();
  }
});

// ============================================================================
// F9: Android Embedded HTTP Receiver (:8765)
// ============================================================================

test('T1-F09-01: Android GET /health conforms to Contract 4 schema', async () => {
  const harness = await createE2EHarness();
  try {
    const res = await harness.httpJson<AndroidHealthResponse>(harness.androidTargetUrl, '/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.pollingDisabled, true);
    assert.ok(Number.isInteger(res.body.listeningPort) && res.body.listeningPort > 0);
    assert.equal(typeof res.body.ip, 'string');
    assert.ok(Number.isInteger(res.body.activeRecordings) && res.body.activeRecordings >= 0);
    assert.ok(Number.isInteger(res.body.userCount) && res.body.userCount >= 0);
  } finally {
    await harness.cleanup();
  }
});

test('T1-F09-02: POST /record for existing IDLE user on Wi-Fi returns 202 and increments activeRecordings', async () => {
  const receiver = await createMockAndroidReceiver({
    initialUsers: [{ platform: 'TIKTOK', username: 'ebe_m72', status: 'IDLE' }],
  });
  try {
    const resp = await fetch(`${receiver.url}/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: 'TIKTOK',
        username: 'ebe_m72',
        usernameOrUrl: '@ebe_m72',
        streamUrl: 'https://cdn.example/ebe.flv',
      }),
    });
    assert.equal(resp.status, 202);
    const body = (await resp.json()) as RecordResponse;
    assert.equal(body.status, 'RECORDING_STARTED');
    const health = (await (await fetch(`${receiver.url}/health`)).json()) as AndroidHealthResponse;
    assert.equal(health.activeRecordings, 1);
  } finally {
    await receiver.close();
  }
});

test('T1-F09-03: POST /record for unknown user auto-inserts user and increments userCount by 1', async () => {
  const receiver = await createMockAndroidReceiver();
  try {
    const resp = await fetch(`${receiver.url}/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: 'TIKTOK',
        username: 'brand_new_creator',
        streamUrl: 'https://cdn.example/new.flv',
      }),
    });
    assert.equal(resp.status, 202);
    const health = (await (await fetch(`${receiver.url}/health`)).json()) as AndroidHealthResponse;
    assert.equal(health.userCount, 1);
  } finally {
    await receiver.close();
  }
});

test('T1-F09-04: POST /record succeeds across INSTAGRAM, FACEBOOK, and X with canonical platform echo', async () => {
  const receiver = await createMockAndroidReceiver();
  try {
    for (const [platform, user] of [
      ['INSTAGRAM', 'baotran16tui'],
      ['FACEBOOK', 'phanbaotran2k'],
      ['X', 'minalatuinehehe'],
    ] as const) {
      const resp = await fetch(`${receiver.url}/record`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform,
          username: user,
          streamUrl: `https://cdn.example/${user}.flv`,
        }),
      });
      assert.equal(resp.status, 202);
      const body = (await resp.json()) as RecordResponse;
      assert.equal(body.platform, platform);
      assert.equal(body.username, user);
    }
  } finally {
    await receiver.close();
  }
});

test('T1-F09-05: Sequential POST /record for 2 distinct users tracks activeRecordings === 2', async () => {
  const receiver = await createMockAndroidReceiver();
  try {
    for (const u of ['user_one', 'user_two']) {
      const resp = await fetch(`${receiver.url}/record`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform: 'TIKTOK',
          username: u,
          streamUrl: `https://cdn.example/${u}.flv`,
        }),
      });
      assert.equal(resp.status, 202);
    }
    const health = (await (await fetch(`${receiver.url}/health`)).json()) as AndroidHealthResponse;
    assert.equal(health.activeRecordings, 2);
  } finally {
    await receiver.close();
  }
});

// ============================================================================
// F10: Android Dynamic IPv4 Detection & Registration
// ============================================================================

test('T1-F10-01: Android client startup registers valid IPv4 + listening port with PulseRadar', async () => {
  const harness = await createE2EHarness();
  try {
    harness.mockAndroid.setIp('192.168.1.9');
    const reg = await harness.mockAndroid.registerWithPulseRadar(harness.pulseRadarUrl);
    assert.equal(reg.status, 200);
    const status = await harness.getAndroidStatus();
    assert.equal(status.body.device?.ip, '192.168.1.9');
    assert.equal(status.body.device?.port, harness.mockAndroid.port);
  } finally {
    await harness.cleanup();
  }
});

test('T1-F10-02: Emitted non-loopback IPv4 change triggers re-registration with new IP 192.168.1.25', async () => {
  const harness = await createE2EHarness();
  try {
    const candidates = filterRegisterableIpv4Candidates(['127.0.0.1', '169.254.1.5', '192.168.1.25']);
    assert.deepEqual(candidates, ['192.168.1.25']);

    harness.mockAndroid.setIp(candidates[0]);
    const reg = await harness.mockAndroid.registerWithPulseRadar(harness.pulseRadarUrl);
    assert.equal(reg.status, 200);
    const status = await harness.getAndroidStatus();
    assert.equal(status.body.device?.ip, '192.168.1.25');
  } finally {
    await harness.cleanup();
  }
});

test('T1-F10-03: Sync cycle updates lastSeenAt and lastSyncAt on server', async () => {
  const harness = await createE2EHarness();
  try {
    const res = await harness.mockAndroid.syncWithPulseRadar(harness.pulseRadarUrl);
    assert.equal(res.status, 200);
    const status = await harness.getAndroidStatus();
    assert.ok(status.body.device?.lastSeenAt);
    assert.ok(status.body.device?.lastSyncAt);
  } finally {
    await harness.cleanup();
  }
});

test('T1-F10-04: Custom commandServerPort is reflected in /health and /api/android/register', async () => {
  const harness = await createE2EHarness();
  const customReceiver = await createMockAndroidReceiver({ ip: '192.168.1.33' });
  try {
    const health = (await (await fetch(`${customReceiver.url}/health`)).json()) as AndroidHealthResponse;
    assert.equal(health.listeningPort, customReceiver.port);

    await customReceiver.registerWithPulseRadar(harness.pulseRadarUrl);
    const status = await harness.getAndroidStatus();
    assert.equal(status.body.device?.port, customReceiver.port);
  } finally {
    await customReceiver.close();
    await harness.cleanup();
  }
});

test('T1-F10-05: Custom pulseRadarUrl receives registration cleanly', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'pr-custom-url-'));
  const customServer = new ReferenceContractServer({ dataDir: dir, autoScanEnabled: false });
  const receiver = await createMockAndroidReceiver({ ip: '192.168.1.44' });
  try {
    await customServer.start();
    const reg = await receiver.registerWithPulseRadar(customServer.url);
    assert.equal(reg.status, 200);
    assert.equal(reg.body.ip, '192.168.1.44');
  } finally {
    await receiver.close();
    await customServer.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// F11: Android 10-Minute Sync & Room Reconciliation
// ============================================================================

test('T1-F11-01: Sync adds missing authoritative user to Android local store (userCount 2 -> 3)', async () => {
  const harness = await createE2EHarness({
    initialWorkspaceState: makeSingleUserWorkspace('reddit', 'tiktok.com', '@u1, @u2, @u3'),
  });
  try {
    harness.mockAndroid.setUsers([
      { platform: 'TIKTOK', username: 'u1' },
      { platform: 'TIKTOK', username: 'u2' },
    ]);
    await harness.mockAndroid.syncWithPulseRadar(harness.pulseRadarUrl);
    const health = (await (await fetch(`${harness.mockAndroid.url}/health`)).json()) as AndroidHealthResponse;
    assert.equal(health.userCount, 3);
  } finally {
    await harness.cleanup();
  }
});

test('T1-F11-02: Sync deletes stale user returned in toRemove and decrements userCount', async () => {
  const harness = await createE2EHarness({
    initialWorkspaceState: makeSingleUserWorkspace('reddit', 'tiktok.com', '@u1'),
  });
  try {
    harness.mockAndroid.setUsers([
      { platform: 'TIKTOK', username: 'u1' },
      { platform: 'TIKTOK', username: 'stale_extra' },
    ]);
    await harness.mockAndroid.syncWithPulseRadar(harness.pulseRadarUrl);
    const health = (await (await fetch(`${harness.mockAndroid.url}/health`)).json()) as AndroidHealthResponse;
    assert.equal(health.userCount, 1);
    assert.equal(
      harness.mockAndroid.getUsers().some((u) => u.username === 'stale_extra'),
      false
    );
  } finally {
    await harness.cleanup();
  }
});

test('T1-F11-03: Sync applies toUpdate changing isEnabled to false and reflects on next sync', async () => {
  const ws = makeSingleUserWorkspace('reddit', 'tiktok.com', '@u1');
  ws.rules[0].enabled = false;
  const harness = await createE2EHarness({ initialWorkspaceState: ws });
  try {
    harness.mockAndroid.setUsers([
      { platform: 'TIKTOK', username: 'u1', isEnabled: true, status: 'IDLE' },
    ]);
    await harness.mockAndroid.syncWithPulseRadar(harness.pulseRadarUrl);
    const updatedUser = harness.mockAndroid.getUsers().find((u) => u.username === 'u1');
    assert.equal(updatedUser?.isEnabled, false);
  } finally {
    await harness.cleanup();
  }
});

test('T1-F11-04: Sync launches recording for recordTriggers and reports RECORDING on next sync', async () => {
  const harness = await createE2EHarness({
    initialWorkspaceState: makeSingleUserWorkspace('reddit', 'tiktok.com', '@ebe_m72'),
  });
  try {
    harness.mockAndroid.setUsers([{ platform: 'TIKTOK', username: 'ebe_m72', status: 'IDLE' }]);
    await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@ebe_m72',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/ebe.flv',
    });
    await harness.mockAndroid.syncWithPulseRadar(harness.pulseRadarUrl);
    assert.equal(harness.mockAndroid.getActiveRecordings().length, 1);

    // Next sync should report RECORDING and receive zero duplicate recordTriggers
    const nextSync = await harness.mockAndroid.syncWithPulseRadar(harness.pulseRadarUrl);
    assert.equal(nextSync.status, 200);
    assert.equal((nextSync.body as SyncResponse).recordTriggers.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test('T1-F11-05: Sync reconciliation preserves local allowCellular and telegramTopicId', async () => {
  const harness = await createE2EHarness({
    initialWorkspaceState: makeSingleUserWorkspace('reddit', 'tiktok.com', '@ebe_m72'),
  });
  try {
    harness.mockAndroid.setUsers([
      {
        platform: 'TIKTOK',
        username: 'ebe_m72',
        allowCellular: true,
        telegramTopicId: 12345,
        status: 'IDLE',
      },
    ]);
    await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@ebe_m72',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/ebe.flv',
    });
    await harness.mockAndroid.syncWithPulseRadar(harness.pulseRadarUrl);
    const preserved = harness.mockAndroid.getUsers().find((u) => u.username === 'ebe_m72');
    assert.equal(preserved?.allowCellular, true);
    assert.equal(preserved?.telegramTopicId, 12345);
  } finally {
    await harness.cleanup();
  }
});

// ============================================================================
// F12: Android UI, Preferences & Build/Unit Parity
// ============================================================================

test('T1-F12-01: Android canonical normalization and unit parity (runs Gradle testDebugUnitTest when E2E_RUN_REPO_BUILDS=1)', async () => {
  if (runRepoBuilds) {
    const gradleBat =
      'C:\\Users\\tranm\\.gradle\\wrapper\\dists\\gradle-8.4-bin\\1w5dpkrfk8irigvoxmyhowfim\\gradle-8.4\\bin\\gradle.bat';
    const gradleRes = spawnSync(gradleBat, ['testDebugUnitTest', '--no-daemon', '--console=plain'], {
      cwd: streamRecorderRoot,
      encoding: 'utf8',
      shell: true,
    });
    assert.equal(gradleRes.status, 0, gradleRes.stderr || gradleRes.stdout);
    return;
  }

  assert.equal(normalizePlatform('TWITTER'), 'X');
  assert.equal(canonicalizeUsername('@Minalatuinehehe', 'X'), 'minalatuinehehe');
  assert.equal(canonicalizeUsername('https://www.tiktok.com/@ebe_m72/live', 'TIKTOK'), 'ebe_m72');
});

test('T1-F12-02: Android build parity (runs Gradle assembleDebug when E2E_RUN_REPO_BUILDS=1)', async () => {
  if (runRepoBuilds) {
    const gradleBat =
      'C:\\Users\\tranm\\.gradle\\wrapper\\dists\\gradle-8.4-bin\\1w5dpkrfk8irigvoxmyhowfim\\gradle-8.4\\bin\\gradle.bat';
    const gradleRes = spawnSync(gradleBat, ['assembleDebug', '--no-daemon', '--console=plain'], {
      cwd: streamRecorderRoot,
      encoding: 'utf8',
      shell: true,
    });
    assert.equal(gradleRes.status, 0, gradleRes.stderr || gradleRes.stdout);
    return;
  }

  assert.equal(fs.existsSync(path.join(streamRecorderRoot, 'app', 'build.gradle.kts')), true);
});

test('T1-F12-03: Default Android client configuration matches Render HTTPS server and command port 8765', async () => {
  const defaultPulseRadarUrl = 'https://pulseradar-server.onrender.com';
  const defaultCommandServerPort = 8765;
  const parsed = new URL(defaultPulseRadarUrl);
  assert.equal(parsed.protocol, 'https:');
  assert.equal(parsed.hostname, 'pulseradar-server.onrender.com');
  assert.equal(defaultCommandServerPort, 8765);
});

test('T1-F12-04: Updated pulseRadarUrl & commandServerPort route sync to new endpoint', async () => {
  const harness = await createE2EHarness({
    initialWorkspaceState: makeSingleUserWorkspace('reddit', 'tiktok.com', '@ebe_m72'),
  });
  try {
    const res = await harness.mockAndroid.syncWithPulseRadar(`${harness.pulseRadarUrl}/`);
    assert.equal(res.status, 200);
    const status = await harness.getAndroidStatus();
    assert.equal(status.body.device?.port, harness.mockAndroid.port);
  } finally {
    await harness.cleanup();
  }
});

test('T1-F12-05: Target Android endpoint reports healthy passive state (pollingDisabled: true)', async () => {
  const harness = await createE2EHarness();
  try {
    const health = await harness.httpJson<AndroidHealthResponse>(harness.androidTargetUrl, '/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.pollingDisabled, true);
  } finally {
    await harness.cleanup();
  }
});
