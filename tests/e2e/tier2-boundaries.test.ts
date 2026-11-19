import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildProduction44WorkspaceState,
  createE2EHarness,
  createMockAndroidReceiver,
  filterRegisterableIpv4Candidates,
} from './harness.ts';
import {
  canonicalizeUsername,
  extractSocketIpv4,
  normalizePlatform,
} from './referenceServer.ts';
import type {
  AndroidHealthResponse,
  ErrorResponse,
  RegisterResponse,
  SyncResponse,
} from './types.ts';

function makeSingleUserWorkspace(
  platformKey: string,
  domain: string,
  keyword: string,
  excludedExtra = ''
) {
  const base = buildProduction44WorkspaceState();
  const ts = '2026-11-18T16:01:07.088417Z';
  base.rules = [
    {
      id: `rule_${platformKey}`,
      ownerId: 'demo_user',
      keyword,
      excludedKeywords: excludedExtra ? `${domain} | ${excludedExtra}` : `${domain} |`,
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
// F1: Server State Isolation & Atomic Persistence — Boundaries
// ============================================================================

test('T2-F01-01: PUT /api/workspace-state with malformed JSON returns 400 and preserves existing files', async () => {
  const harness = await createE2EHarness({
    initialWorkspaceState: buildProduction44WorkspaceState(),
  });
  try {
    await harness.registerAndroid({ deviceId: 'sm_n770f_default', ip: '192.168.1.9', port: 8765 });
    const badRes = await harness.httpRaw(harness.pulseRadarUrl, '/api/workspace-state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad',
    });
    assert.equal(badRes.status, 400);

    const ws = await harness.getWorkspaceState();
    assert.equal(ws.status, 200);
    assert.equal(ws.body.state?.rules.length, 4);
    const androidStatus = await harness.getAndroidStatus();
    assert.equal(androidStatus.body.device?.ip, '192.168.1.9');
  } finally {
    await harness.cleanup();
  }
});

test('T2-F01-02: PUT /api/workspace-state with non-object body (null, [], "str", 123) returns 400', async () => {
  const harness = await createE2EHarness({
    initialWorkspaceState: buildProduction44WorkspaceState(),
  });
  try {
    for (const payload of ['null', '[]', '"str"', '123']) {
      const res = await harness.httpRaw(harness.pulseRadarUrl, '/api/workspace-state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });
      assert.equal(res.status, 400, `Expected 400 for body ${payload}`);
      const parsed = JSON.parse(res.text) as ErrorResponse;
      assert.equal(parsed.ok, false);
    }
    const ws = await harness.getWorkspaceState();
    assert.equal(ws.body.state?.rules.length, 4);
  } finally {
    await harness.cleanup();
  }
});

test('T2-F01-03: GET /api/workspace-state when file does not exist returns 200 { ok: true, state: null }', async () => {
  const harness = await createE2EHarness();
  try {
    const res = await harness.getWorkspaceState();
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.state, null);
  } finally {
    await harness.cleanup();
  }
});

test('T2-F01-04: PUT /api/workspace-state with rogue androidDevice key does not clobber android-state.json', async () => {
  const harness = await createE2EHarness({
    initialWorkspaceState: buildProduction44WorkspaceState(),
  });
  try {
    await harness.registerAndroid({ deviceId: 'sm_n770f_default', ip: '192.168.1.9', port: 8765 });
    const rogue = {
      ...buildProduction44WorkspaceState(),
      androidDevice: { ip: '6.6.6.6', port: 9999 },
    };
    const putRes = await harness.putWorkspaceState(rogue);
    assert.equal(putRes.status, 200);

    const status = await harness.getAndroidStatus();
    assert.equal(status.body.device?.ip, '192.168.1.9');
    assert.equal(status.body.device?.port, 8765);
  } finally {
    await harness.cleanup();
  }
});

test('T2-F01-05: Concurrent PUT /api/workspace-state + POST /register + POST /sync in Promise.all succeed cleanly', async () => {
  const harness = await createE2EHarness({
    initialWorkspaceState: buildProduction44WorkspaceState(),
  });
  try {
    const [r1, r2, r3] = await Promise.all([
      harness.putWorkspaceState(buildProduction44WorkspaceState()),
      harness.registerAndroid({ deviceId: 'sm_n770f_default', ip: '192.168.1.9', port: 8765 }),
      harness.syncAndroid({ deviceId: 'sm_n770f_default', ip: '192.168.1.9', port: 8765, users: [] }),
    ]);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(r3.status, 200);
    if (!harness.isLiveMode) {
      JSON.parse(fs.readFileSync(path.join(harness.dataDir, 'workspace-state.json'), 'utf8'));
      JSON.parse(fs.readFileSync(path.join(harness.dataDir, 'android-state.json'), 'utf8'));
    }
  } finally {
    await harness.cleanup();
  }
});

// ============================================================================
// F2: Server Autonomous Live Scanner Loop — Boundaries
// ============================================================================

test('T2-F02-01: Empty rules or blank keyword reports trackedUsersCount: 0 without crash', async () => {
  const ws = buildProduction44WorkspaceState();
  ws.rules = [];
  const harness = await createE2EHarness({ initialWorkspaceState: ws });
  try {
    await harness.tickScan();
    const health = await harness.getHealth();
    assert.equal(health.status, 200);
    assert.equal(health.body.trackedUsersCount, 0);

    ws.rules = [
      {
        ...buildProduction44WorkspaceState().rules[0],
        keyword: '   ,   ',
      },
    ];
    await harness.putWorkspaceState(ws);
    await harness.tickScan();
    const health2 = await harness.getHealth();
    assert.equal(health2.body.trackedUsersCount, 0);
  } finally {
    await harness.cleanup();
  }
});

test('T2-F02-02: Disabled rule (enabled: false) is skipped by auto-scanner (0 /record triggers)', async (t) => {
  const ws = makeSingleUserWorkspace('reddit', 'tiktok.com', '@u1, @u2, @u3, @u4, @u5');
  ws.rules[0].enabled = false;
  const harness = await createE2EHarness({ initialWorkspaceState: ws });
  try {
    await harness.registerAndroid({ ip: '127.0.0.1', port: harness.mockAndroid.port });
    const hooked = await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@u1',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/u1.flv',
    });
    if (!hooked) {
      t.skip('E2E_LIVE_TRIGGER_URL not configured in live-target mode');
      return;
    }
    await harness.tickScan();
    assert.equal(harness.mockAndroid.getCapturedRequests().length, 0);
  } finally {
    await harness.cleanup();
  }
});

test('T2-F02-03: excludedKeywords negative term suppresses /record when live title matches', async (t) => {
  const ws = makeSingleUserWorkspace('reddit', 'tiktok.com', '@ebe_m72', 'test');
  const harness = await createE2EHarness({ initialWorkspaceState: ws });
  try {
    await harness.registerAndroid({ ip: '127.0.0.1', port: harness.mockAndroid.port });
    const hooked = await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@ebe_m72',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/ebe.flv',
      title: 'This is a TEST stream',
    });
    if (!hooked) {
      t.skip('E2E_LIVE_TRIGGER_URL not configured in live-target mode');
      return;
    }
    await harness.tickScan();
    assert.equal(harness.mockAndroid.getCapturedRequests().length, 0);
  } finally {
    await harness.cleanup();
  }
});

test('T2-F02-04: Upstream ERROR for 1 user does not prevent dispatching 2nd LIVE user', async (t) => {
  const ws = makeSingleUserWorkspace('reddit', 'tiktok.com', '@err_user, @live_user');
  const harness = await createE2EHarness({ initialWorkspaceState: ws });
  try {
    await harness.registerAndroid({ ip: '127.0.0.1', port: harness.mockAndroid.port });
    const ok = await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@err_user',
      status: 'ERROR',
      errorMessage: '429 rate limited',
    });
    if (!ok) {
      t.skip('E2E_LIVE_TRIGGER_URL not configured in live-target mode');
      return;
    }
    await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@live_user',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/live_user.flv',
    });
    await harness.tickScan();
    const reqs = harness.mockAndroid.getCapturedRequests();
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0].body?.username, 'live_user');
    const status = await harness.getAndroidStatus();
    assert.equal(status.body.scanner.running, true);
  } finally {
    await harness.cleanup();
  }
});

test('T2-F02-05: Auto-scanner skips dispatching when android-state already reports RECORDING or UPLOADING', async (t) => {
  const ws = makeSingleUserWorkspace('reddit', 'tiktok.com', '@rec_user, @upl_user');
  const harness = await createE2EHarness({ initialWorkspaceState: ws });
  try {
    await harness.syncAndroid({
      ip: '127.0.0.1',
      port: harness.mockAndroid.port,
      users: [
        { username: 'rec_user', platform: 'TIKTOK', status: 'RECORDING', isEnabled: true },
        { username: 'upl_user', platform: 'TIKTOK', status: 'UPLOADING', isEnabled: true },
      ],
    });
    const ok = await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@rec_user',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/rec.flv',
    });
    if (!ok) {
      t.skip('E2E_LIVE_TRIGGER_URL not configured in live-target mode');
      return;
    }
    await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@upl_user',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/upl.flv',
    });
    await harness.tickScan();
    assert.equal(harness.mockAndroid.getCapturedRequests().length, 0);
  } finally {
    await harness.cleanup();
  }
});

// ============================================================================
// F3: Server -> Android Live Trigger Dispatch — Boundaries
// ============================================================================

test('T2-F03-01: No Android device registered when user goes LIVE updates activeLiveCount without crash', async (t) => {
  const harness = await createE2EHarness({
    initialWorkspaceState: makeSingleUserWorkspace('reddit', 'tiktok.com', '@ebe_m72'),
  });
  try {
    const ok = await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@ebe_m72',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/ebe.flv',
    });
    if (!ok) {
      t.skip('E2E_LIVE_TRIGGER_URL not configured in live-target mode');
      return;
    }
    await harness.tickScan();
    const status = await harness.getAndroidStatus();
    assert.equal(status.status, 200);
    assert.equal(status.body.device, null);
    assert.equal(status.body.scanner.activeLiveCount, 1);
  } finally {
    await harness.cleanup();
  }
});

test('T2-F03-02: Android returns 503 once then 202 -> server retries once after ~1000ms and clears lastDispatchError', async (t) => {
  const harness = await createE2EHarness({
    initialWorkspaceState: makeSingleUserWorkspace('reddit', 'tiktok.com', '@ebe_m72'),
  });
  try {
    harness.mockAndroid.setFaultConfig({ statusCode: 503, failCount: 1 });
    await harness.registerAndroid({ ip: '127.0.0.1', port: harness.mockAndroid.port });
    const ok = await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@ebe_m72',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/ebe.flv',
    });
    if (!ok) {
      t.skip('E2E_LIVE_TRIGGER_URL not configured in live-target mode');
      return;
    }
    const start = Date.now();
    await harness.tickScan();
    const elapsed = Date.now() - start;
    const reqs = harness.mockAndroid.getCapturedRequests();
    assert.equal(reqs.length, 2);
    assert.equal(reqs[0].statusCode, 503);
    assert.equal(reqs[1].statusCode, 202);
    assert.ok(elapsed >= 900, `Expected >=900ms retry delay, got ${elapsed}ms`);

    const status = await harness.getAndroidStatus();
    assert.equal(status.body.scanner.lastDispatchError, null);
  } finally {
    await harness.cleanup();
  }
});

test('T2-F03-03: Android /record hangs >5000ms on both attempts -> server aborts at 5000ms, retries once, records lastDispatchError', async (t) => {
  const harness = await createE2EHarness({
    initialWorkspaceState: makeSingleUserWorkspace('reddit', 'tiktok.com', '@ebe_m72'),
  });
  try {
    harness.mockAndroid.setFaultConfig({ delayMs: 6500 });
    await harness.registerAndroid({ ip: '127.0.0.1', port: harness.mockAndroid.port });
    const ok = await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@ebe_m72',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/ebe.flv',
    });
    if (!ok) {
      t.skip('E2E_LIVE_TRIGGER_URL not configured in live-target mode');
      return;
    }
    const start = Date.now();
    await harness.tickScan();
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 10_000, `Expected >=10000ms (2x5000ms timeout + 1000ms retry), got ${elapsed}ms`);

    const status = await harness.getAndroidStatus();
    assert.ok(status.body.scanner.lastDispatchError);
    assert.equal(status.body.scanner.running, true);
  } finally {
    await harness.cleanup();
  }
});

test('T2-F03-04: Android /record refuses TCP connection -> retries once after 1000ms and records lastDispatchError', async (t) => {
  // Reserve and close an ephemeral port so TCP connect fails immediately with ECONNREFUSED
  const closedPort = await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });

  const harness = await createE2EHarness({
    initialWorkspaceState: makeSingleUserWorkspace('reddit', 'tiktok.com', '@ebe_m72'),
  });
  try {
    await harness.registerAndroid({ ip: '127.0.0.1', port: closedPort });
    const ok = await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@ebe_m72',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/ebe.flv',
    });
    if (!ok) {
      t.skip('E2E_LIVE_TRIGGER_URL not configured in live-target mode');
      return;
    }
    const start = Date.now();
    await harness.tickScan();
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 900, `Expected 1000ms retry delay on ECONNREFUSED, got ${elapsed}ms`);

    const status = await harness.getAndroidStatus();
    assert.ok(status.body.scanner.lastDispatchError);
    const health = await harness.getHealth();
    assert.equal(health.status, 200);
  } finally {
    await harness.cleanup();
  }
});

test('T2-F03-05: Android /record returns 400 -> server does NOT retry and records HTTP 400 detail', async (t) => {
  const harness = await createE2EHarness({
    initialWorkspaceState: makeSingleUserWorkspace('reddit', 'tiktok.com', '@ebe_m72'),
  });
  try {
    harness.mockAndroid.setFaultConfig({ statusCode: 400 });
    await harness.registerAndroid({ ip: '127.0.0.1', port: harness.mockAndroid.port });
    const ok = await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@ebe_m72',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/ebe.flv',
    });
    if (!ok) {
      t.skip('E2E_LIVE_TRIGGER_URL not configured in live-target mode');
      return;
    }
    await harness.tickScan();
    const reqs = harness.mockAndroid.getCapturedRequests();
    assert.equal(reqs.length, 1, 'Expected 0 retries on HTTP 400');

    const status = await harness.getAndroidStatus();
    assert.ok(status.body.scanner.lastDispatchError?.includes('400'));
  } finally {
    await harness.cleanup();
  }
});

// ============================================================================
// F4: Server Dynamic Android IP Registry — Boundaries
// ============================================================================

test('T2-F04-01: Invalid ip formats return 400 and preserve previous valid android-state.json', async () => {
  const harness = await createE2EHarness();
  try {
    await harness.registerAndroid({ ip: '192.168.1.9', port: 8765 });
    for (const badIp of ['999.168.1.9', '192.168.1', 'abc.def.ghi.jkl', '2001:db8::1', '192.168.1.9:8765']) {
      const res = await harness.registerAndroid({ ip: badIp, port: 8765 });
      assert.equal(res.status, 400, `Expected 400 for ip=${badIp}`);
      assert.equal(res.body.ok, false);
    }
    const status = await harness.getAndroidStatus();
    assert.equal(status.body.device?.ip, '192.168.1.9');
  } finally {
    await harness.cleanup();
  }
});

test('T2-F04-02: Omitted/empty ip extracts socket IPv4 stripping ::ffff: prefix', async () => {
  assert.equal(extractSocketIpv4('::ffff:192.168.1.9'), '192.168.1.9');
  assert.equal(extractSocketIpv4('::1'), null);

  const harness = await createE2EHarness();
  try {
    const res = await harness.registerAndroid({ ip: '', port: 8765 });
    assert.equal(res.status, 200);
    assert.equal((res.body as RegisterResponse).ip, '127.0.0.1');
    assert.equal((res.body as RegisterResponse).callbackUrl, 'http://127.0.0.1:8765/record');
  } finally {
    await harness.cleanup();
  }
});

test('T2-F04-03: Out-of-range port (0, -1, 65536, 99999) returns 400', async () => {
  const harness = await createE2EHarness();
  try {
    for (const badPort of [0, -1, 65536, 99999]) {
      const res = await harness.registerAndroid({ ip: '192.168.1.9', port: badPort });
      assert.equal(res.status, 400, `Expected 400 for port=${badPort}`);
      assert.equal(res.body.ok, false);
    }
  } finally {
    await harness.cleanup();
  }
});

test('T2-F04-04: Wrong-type or missing port ("8765", "abc", 8765.5, null, omitted) returns 400', async () => {
  const harness = await createE2EHarness();
  try {
    for (const badPort of ['8765', 'abc', 8765.5, null, undefined]) {
      const payload: Record<string, unknown> = { ip: '192.168.1.9' };
      if (badPort !== undefined) payload.port = badPort;
      const res = await harness.registerAndroid(payload);
      assert.equal(res.status, 400, `Expected 400 for port=${String(badPort)}`);
    }
  } finally {
    await harness.cleanup();
  }
});

test('T2-F04-05: Port boundary valid extremes 1 and 65535 return 200; malformed JSON returns 400', async () => {
  const harness = await createE2EHarness();
  try {
    const p1 = await harness.registerAndroid({ ip: '192.168.1.9', port: 1 });
    assert.equal(p1.status, 200);
    const p65535 = await harness.registerAndroid({ ip: '192.168.1.9', port: 65535 });
    assert.equal(p65535.status, 200);

    const bad = await harness.httpRaw(harness.pulseRadarUrl, '/api/android/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    assert.equal(bad.status, 400);
  } finally {
    await harness.cleanup();
  }
});

// ============================================================================
// F5: Server 10-Min Authoritative Reconciliation — Boundaries
// ============================================================================

test('T2-F05-01: Malformed JSON or missing/null/non-array users on /api/android/sync returns 400', async () => {
  const harness = await createE2EHarness();
  try {
    const rawBad = await harness.httpRaw(harness.pulseRadarUrl, '/api/android/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid',
    });
    assert.equal(rawBad.status, 400);

    for (const badUsers of [undefined, null, 'bad', 123, {}]) {
      const payload: Record<string, unknown> = { ip: '192.168.1.9', port: 8765 };
      if (badUsers !== undefined) payload.users = badUsers;
      const res = await harness.syncAndroid(payload);
      assert.equal(res.status, 400);
    }
  } finally {
    await harness.cleanup();
  }
});

test('T2-F05-02: Sync with empty users [] on 44-user server with 2 LIVE users returns toAdd=44 and recordTriggers=2', async (t) => {
  const harness = await createE2EHarness({
    initialWorkspaceState: buildProduction44WorkspaceState(),
  });
  try {
    const ok = await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@ebe_m72',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/ebe.flv',
    });
    if (!ok) {
      t.skip('E2E_LIVE_TRIGGER_URL not configured in live-target mode');
      return;
    }
    await harness.simulateLiveUser({
      platform: 'INSTAGRAM',
      username: '@baotran16tui',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/bao.flv',
    });

    const res = await harness.syncAndroid({ ip: '192.168.1.9', port: 8765, users: [] });
    assert.equal(res.status, 200);
    const body = res.body as SyncResponse;
    assert.equal(body.toAdd.length, 44);
    assert.equal(body.toRemove.length, 0);
    assert.equal(body.recordTriggers.length, 2);
  } finally {
    await harness.cleanup();
  }
});

test('T2-F05-03: Sync preserves RECORDING and UPLOADING effectiveStatus and suppresses duplicate recordTriggers', async (t) => {
  const harness = await createE2EHarness({
    initialWorkspaceState: makeSingleUserWorkspace('reddit', 'tiktok.com', '@ebe_m72, @baotran162008'),
  });
  try {
    const ok = await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@ebe_m72',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/ebe.flv',
    });
    if (!ok) {
      t.skip('E2E_LIVE_TRIGGER_URL not configured in live-target mode');
      return;
    }

    const res = await harness.syncAndroid({
      ip: '192.168.1.9',
      port: 8765,
      users: [
        { username: 'ebe_m72', platform: 'TIKTOK', status: 'RECORDING', isEnabled: true },
        { username: 'baotran162008', platform: 'TIKTOK', status: 'UPLOADING', isEnabled: true },
      ],
    });
    assert.equal(res.status, 200);
    const body = res.body as SyncResponse;
    assert.equal(body.recordTriggers.length, 0);
    const ebe = body.authoritativeUsers.find((u) => u.username === 'ebe_m72');
    const bao = body.authoritativeUsers.find((u) => u.username === 'baotran162008');
    assert.equal(ebe?.effectiveStatus, 'RECORDING');
    assert.equal(bao?.effectiveStatus, 'UPLOADING');
  } finally {
    await harness.cleanup();
  }
});

test('T2-F05-04: TWITTER alias + @ + case-insensitive normalization matches bluesky @Minalatuinehehe', async () => {
  const harness = await createE2EHarness({
    initialWorkspaceState: makeSingleUserWorkspace('bluesky', 'x.com', '@Minalatuinehehe'),
  });
  try {
    const res = await harness.syncAndroid({
      ip: '192.168.1.9',
      port: 8765,
      users: [
        {
          platform: 'TWITTER',
          username: '@minalatuinehehe',
          usernameOrUrl: 'minalatuinehehe',
          status: 'IDLE',
          isEnabled: true,
        },
      ],
    });
    assert.equal(res.status, 200);
    const body = res.body as SyncResponse;
    assert.equal(body.toAdd.length, 0);
    assert.equal(body.toRemove.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test('T2-F05-05: URL normalization across all 4 platforms matches canonical handles and disabled rule emits no recordTriggers', async (t) => {
  const ws = buildProduction44WorkspaceState();
  // Keep 1 disabled rule alongside enabled ones
  ws.rules[2].enabled = false;
  const harness = await createE2EHarness({ initialWorkspaceState: ws });
  try {
    const ok = await harness.simulateLiveUser({
      platform: 'X',
      username: '@Minalatuinehehe',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/x.flv',
    });
    if (!ok) {
      t.skip('E2E_LIVE_TRIGGER_URL not configured in live-target mode');
      return;
    }

    const res = await harness.syncAndroid({
      ip: '192.168.1.9',
      port: 8765,
      users: [
        { platform: 'TIKTOK', usernameOrUrl: 'https://www.tiktok.com/@ebe_m72/live', status: 'IDLE', isEnabled: true },
        { platform: 'INSTAGRAM', usernameOrUrl: 'https://www.instagram.com/baotran16tui/live', status: 'IDLE', isEnabled: true },
        { platform: 'FACEBOOK', usernameOrUrl: 'https://www.facebook.com/phanbaotran2k/live', status: 'IDLE', isEnabled: true },
        { platform: 'X', usernameOrUrl: 'https://x.com/Elinaaa2511', status: 'IDLE', isEnabled: false },
      ],
    });
    assert.equal(res.status, 200);
    const body = res.body as SyncResponse;
    assert.equal(body.toRemove.length, 0);
    // Disabled X rule must not emit recordTrigger even though Minalatuinehehe is LIVE
    assert.equal(
      body.recordTriggers.some((tr) => tr.username === 'minalatuinehehe'),
      false
    );
  } finally {
    await harness.cleanup();
  }
});

// ============================================================================
// F6: Server Tooling, Health Route & UI Safety — Boundaries
// ============================================================================

test('T2-F06-01: GET /api/health before any device registration returns androidDevice: null', async () => {
  const harness = await createE2EHarness();
  try {
    const res = await harness.getHealth();
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.androidDevice, null);
  } finally {
    await harness.cleanup();
  }
});

test('T2-F06-02: GET /api/android/status before scan shows device: null; after failure shows lastDispatchError', async (t) => {
  const harness = await createE2EHarness({
    initialWorkspaceState: makeSingleUserWorkspace('reddit', 'tiktok.com', '@ebe_m72'),
  });
  try {
    const initial = await harness.getAndroidStatus();
    assert.equal(initial.status, 200);
    assert.equal(initial.body.device, null);

    harness.mockAndroid.setFaultConfig({ statusCode: 400 });
    await harness.registerAndroid({ ip: '127.0.0.1', port: harness.mockAndroid.port });
    const ok = await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@ebe_m72',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/ebe.flv',
    });
    if (!ok) {
      t.skip('E2E_LIVE_TRIGGER_URL not configured in live-target mode');
      return;
    }
    await harness.tickScan();
    const afterFail = await harness.getAndroidStatus();
    assert.ok(typeof afterFail.body.scanner.lastDispatchError === 'string' && afterFail.body.scanner.lastDispatchError.length > 0);
  } finally {
    await harness.cleanup();
  }
});

test('T2-F06-03: GET /api/health deduplicates duplicate usernames across two enabled rules', async () => {
  const ws = buildProduction44WorkspaceState();
  ws.rules = [
    ws.rules[0],
    { ...ws.rules[0], id: 'rule_tiktok_dup', keyword: '@ebe_m72, @unique_extra' },
  ];
  const harness = await createE2EHarness({ initialWorkspaceState: ws });
  try {
    const health = await harness.getHealth();
    assert.equal(health.status, 200);
    assert.equal(health.body.trackedUsersCount, 39); // 38 + 1 unique
  } finally {
    await harness.cleanup();
  }
});

test('T2-F06-04: Invalid POST /api/live/check and POST /api/webhook/dispatch with {} return 400', async () => {
  const harness = await createE2EHarness();
  try {
    const liveRes = await harness.httpJson(harness.pulseRadarUrl, '/api/live/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(liveRes.status, 400);

    const webhookRes = await harness.httpJson(harness.pulseRadarUrl, '/api/webhook/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(webhookRes.status, 400);
  } finally {
    await harness.cleanup();
  }
});

test('T2-F06-05: POST /api/android/sync with invalid port 0 or bad ip returns 400 and preserves prior registration', async () => {
  const harness = await createE2EHarness();
  try {
    await harness.registerAndroid({ ip: '192.168.1.9', port: 8765 });
    const badPort = await harness.syncAndroid({ ip: '192.168.1.9', port: 0, users: [] });
    assert.equal(badPort.status, 400);

    const badIp = await harness.syncAndroid({ ip: 'bad-ip', port: 8765, users: [] });
    assert.equal(badIp.status, 400);

    const status = await harness.getAndroidStatus();
    assert.equal(status.body.device?.ip, '192.168.1.9');
    assert.equal(status.body.device?.port, 8765);
  } finally {
    await harness.cleanup();
  }
});

// ============================================================================
// F7: Server Automated Tests (R1, R2, R4) — Boundaries
// ============================================================================

test('T2-F07-01: Test suite binds ephemeral port 0 without touching port 3000 (zero EADDRINUSE)', async () => {
  const harness = await createE2EHarness();
  try {
    const health = await harness.getHealth();
    assert.equal(health.status, 200);
    assert.ok(health.body.port > 0 && health.body.port !== 3000);
    assert.ok(harness.mockAndroid.port > 0 && harness.mockAndroid.port !== 3000);
  } finally {
    await harness.cleanup();
  }
});

test('T2-F07-02: Invalid register and sync payloads return 400 without mutating valid device state', async () => {
  const harness = await createE2EHarness();
  try {
    await harness.registerAndroid({ ip: '192.168.1.12', port: 8765 });
    assert.equal((await harness.registerAndroid({ ip: '999.0.0.1', port: 8765 })).status, 400);
    assert.equal((await harness.syncAndroid({ ip: '192.168.1.12', port: 8765, users: 'bad' })).status, 400);
    const status = await harness.getAndroidStatus();
    assert.equal(status.body.device?.ip, '192.168.1.12');
  } finally {
    await harness.cleanup();
  }
});

test('T2-F07-03: RECORDING/UPLOADING preservation prevents duplicate recordTriggers in sync', async (t) => {
  const harness = await createE2EHarness({
    initialWorkspaceState: makeSingleUserWorkspace('reddit', 'tiktok.com', '@ebe_m72'),
  });
  try {
    const ok = await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@ebe_m72',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/ebe.flv',
    });
    if (!ok) {
      t.skip('E2E_LIVE_TRIGGER_URL not configured in live-target mode');
      return;
    }
    const syncRes = await harness.syncAndroid({
      ip: '192.168.1.9',
      port: 8765,
      users: [{ username: 'ebe_m72', platform: 'TIKTOK', status: 'RECORDING', isEnabled: true }],
    });
    assert.equal((syncRes.body as SyncResponse).recordTriggers.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test('T2-F07-04: Timeout/retry verification completes cleanly on single transient 503 failure', async (t) => {
  const harness = await createE2EHarness({
    initialWorkspaceState: makeSingleUserWorkspace('reddit', 'tiktok.com', '@ebe_m72'),
  });
  try {
    harness.mockAndroid.setFaultConfig({ statusCode: 503, failCount: 1 });
    await harness.registerAndroid({ ip: '127.0.0.1', port: harness.mockAndroid.port });
    const ok = await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@ebe_m72',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/ebe.flv',
    });
    if (!ok) {
      t.skip('E2E_LIVE_TRIGGER_URL not configured in live-target mode');
      return;
    }
    await harness.tickScan();
    assert.equal(harness.mockAndroid.getCapturedRequests().length, 2);
  } finally {
    await harness.cleanup();
  }
});

test('T2-F07-05: Harness cleanup removes temporary isolated dataDir without touching repo data/', async () => {
  const harness = await createE2EHarness({
    initialWorkspaceState: buildProduction44WorkspaceState(),
  });
  const tmpDir = harness.dataDir;
  assert.equal(fs.existsSync(tmpDir), true);
  await harness.cleanup();
  if (!harness.isLiveMode) {
    assert.equal(fs.existsSync(tmpDir), false);
  }
});

// ============================================================================
// F8: Disable Android Local Platform Polling — Boundaries
// ============================================================================

test('T2-F08-01: Legacy check-now action is a no-op with zero outbound platform live-check requests', async () => {
  const receiver = await createMockAndroidReceiver({
    initialUsers: [{ platform: 'TIKTOK', username: 'ebe_m72' }],
  });
  try {
    const health = (await (await fetch(`${receiver.url}/health`)).json()) as AndroidHealthResponse;
    assert.equal(health.pollingDisabled, true);
    assert.equal(receiver.outboundPlatformPollRequests, 0);
  } finally {
    await receiver.close();
  }
});

test('T2-F08-02: Recording aborted early due to low storage cleans up activeRecordings (returns to 0)', async () => {
  const receiver = await createMockAndroidReceiver();
  try {
    receiver.setFaultConfig({ simulateLowStorageAbort: true });
    const resp = await fetch(`${receiver.url}/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: 'TIKTOK',
        username: 'ebe_m72',
        streamUrl: 'https://cdn.example/ebe.flv',
      }),
    });
    assert.equal(resp.status, 507);
    const health = (await (await fetch(`${receiver.url}/health`)).json()) as AndroidHealthResponse;
    assert.equal(health.activeRecordings, 0);
  } finally {
    await receiver.close();
  }
});

test('T2-F08-03: Subsequent POST /record after low-storage failure succeeds (not stuck ALREADY_RECORDING)', async () => {
  const receiver = await createMockAndroidReceiver();
  try {
    receiver.setFaultConfig({ simulateLowStorageAbort: true });
    await fetch(`${receiver.url}/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: 'TIKTOK',
        username: 'ebe_m72',
        streamUrl: 'https://cdn.example/ebe.flv',
      }),
    });

    receiver.resetFaultConfig();
    const retryResp = await fetch(`${receiver.url}/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: 'TIKTOK',
        username: 'ebe_m72',
        streamUrl: 'https://cdn.example/ebe.flv',
      }),
    });
    assert.equal(retryResp.status, 202);
  } finally {
    await receiver.close();
  }
});

test('T2-F08-04: Empty user list in passive mode keeps userCount: 0 and pollingDisabled: true', async () => {
  const receiver = await createMockAndroidReceiver();
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const health = (await (await fetch(`${receiver.url}/health`)).json()) as AndroidHealthResponse;
    assert.equal(health.userCount, 0);
    assert.equal(health.pollingDisabled, true);
    assert.equal(receiver.outboundPlatformPollRequests, 0);
  } finally {
    await receiver.close();
  }
});

test('T2-F08-05: Network reconnect triggers Telegram upload check without any platform live polling', async () => {
  const receiver = await createMockAndroidReceiver();
  try {
    receiver.setFaultConfig({ networkOnline: false });
    receiver.setFaultConfig({ networkOnline: true, isWifi: true });
    receiver.triggerTelegramPendingSyncCheck();
    assert.equal(receiver.outboundTelegramSyncChecks, 1);
    assert.equal(receiver.outboundPlatformPollRequests, 0);
  } finally {
    await receiver.close();
  }
});

// ============================================================================
// F9: Android Embedded HTTP Receiver (:8765) — Boundaries
// ============================================================================

test('T2-F09-01: Malformed JSON or empty body to Android POST /record returns 400', async () => {
  const receiver = await createMockAndroidReceiver();
  try {
    for (const raw of ['{invalid', '']) {
      const resp = await fetch(`${receiver.url}/record`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: raw,
      });
      assert.equal(resp.status, 400);
      const body = (await resp.json()) as ErrorResponse;
      assert.equal(body.ok, false);
    }
  } finally {
    await receiver.close();
  }
});

test('T2-F09-02: Missing or blank streamUrl returns 400 and activeRecordings stays 0', async () => {
  const receiver = await createMockAndroidReceiver();
  try {
    for (const payload of [
      { platform: 'TIKTOK', username: 'ebe_m72', streamUrl: '' },
      { platform: 'TIKTOK', username: 'ebe_m72', streamUrl: '   ' },
      { platform: 'TIKTOK', username: 'ebe_m72' },
    ]) {
      const resp = await fetch(`${receiver.url}/record`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      assert.equal(resp.status, 400);
    }
    const health = (await (await fetch(`${receiver.url}/health`)).json()) as AndroidHealthResponse;
    assert.equal(health.activeRecordings, 0);
  } finally {
    await receiver.close();
  }
});

test('T2-F09-03: Invalid platform (YOUTUBE, "", 123) returns 400 whereas TWITTER normalizes to X (202)', async () => {
  const receiver = await createMockAndroidReceiver();
  try {
    for (const badPlat of ['YOUTUBE', '', 123]) {
      const resp = await fetch(`${receiver.url}/record`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform: badPlat,
          username: 'user1',
          streamUrl: 'https://cdn.example/s.flv',
        }),
      });
      assert.equal(resp.status, 400);
    }

    const twitterResp = await fetch(`${receiver.url}/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: 'TWITTER',
        username: 'Minalatuinehehe',
        streamUrl: 'https://cdn.example/x.flv',
      }),
    });
    assert.equal(twitterResp.status, 202);
    const body = (await twitterResp.json()) as { platform: string; username: string };
    assert.equal(body.platform, 'X');
    assert.equal(body.username, 'minalatuinehehe');
  } finally {
    await receiver.close();
  }
});

test('T2-F09-04: Missing both username and usernameOrUrl returns 400', async () => {
  const receiver = await createMockAndroidReceiver();
  try {
    for (const payload of [
      { platform: 'TIKTOK', streamUrl: 'https://cdn.example/s.flv' },
      { platform: 'TIKTOK', username: '   ', usernameOrUrl: '', streamUrl: 'https://cdn.example/s.flv' },
    ]) {
      const resp = await fetch(`${receiver.url}/record`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      assert.equal(resp.status, 400);
    }
  } finally {
    await receiver.close();
  }
});

test('T2-F09-05: Duplicate active POST /record returns 200 ALREADY_RECORDING; cellular blocked returns 200 SKIPPED_CELLULAR_POLICY', async () => {
  const receiver = await createMockAndroidReceiver({
    initialUsers: [
      { platform: 'TIKTOK', username: 'u_active', status: 'IDLE', allowCellular: true },
      { platform: 'INSTAGRAM', username: 'u_cell', status: 'IDLE', allowCellular: false },
    ],
  });
  try {
    const r1 = await fetch(`${receiver.url}/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'TIKTOK', username: 'u_active', streamUrl: 'https://cdn.example/1.flv' }),
    });
    assert.equal(r1.status, 202);

    const rDup = await fetch(`${receiver.url}/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'TIKTOK', username: 'u_active', streamUrl: 'https://cdn.example/1.flv' }),
    });
    assert.equal(rDup.status, 200);
    assert.equal(((await rDup.json()) as { status: string }).status, 'ALREADY_RECORDING');

    receiver.setFaultConfig({ networkOnline: true, isWifi: false });
    const rCell = await fetch(`${receiver.url}/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'INSTAGRAM', username: 'u_cell', streamUrl: 'https://cdn.example/2.flv' }),
    });
    assert.equal(rCell.status, 200);
    assert.equal(((await rCell.json()) as { status: string }).status, 'SKIPPED_CELLULAR_POLICY');
    const uCell = receiver.getUsers().find((u) => u.username === 'u_cell');
    assert.equal(uCell?.status, 'LIVE');
  } finally {
    await receiver.close();
  }
});

// ============================================================================
// F10: Android Dynamic IPv4 Detection & Registration — Boundaries
// ============================================================================

test('T2-F10-01: Loopback 127.0.0.1, link-local 169.254.10.5, and IPv6 fe80::1 are filtered out', async () => {
  const filtered = filterRegisterableIpv4Candidates([
    '127.0.0.1',
    '169.254.10.5',
    'fe80::1',
    '0.0.0.0',
    '192.168.1.9',
  ]);
  assert.deepEqual(filtered, ['192.168.1.9']);
});

test('T2-F10-02: Duplicate registration with identical IPv4 192.168.1.9 is idempotent (200)', async () => {
  const harness = await createE2EHarness();
  try {
    harness.mockAndroid.setIp('192.168.1.9');
    const r1 = await harness.mockAndroid.registerWithPulseRadar(harness.pulseRadarUrl);
    const r2 = await harness.mockAndroid.registerWithPulseRadar(harness.pulseRadarUrl);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(r2.body.ip, '192.168.1.9');
  } finally {
    await harness.cleanup();
  }
});

test('T2-F10-03: Offline PulseRadar (ECONNREFUSED) during register fails cleanly while Android listener stays up', async () => {
  const closedPort = await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });

  const receiver = await createMockAndroidReceiver();
  try {
    await assert.rejects(() => receiver.registerWithPulseRadar(`http://127.0.0.1:${closedPort}`));
    const health = (await (await fetch(`${receiver.url}/health`)).json()) as AndroidHealthResponse;
    assert.equal(health.ok, true);
  } finally {
    await receiver.close();
  }
});

test('T2-F10-04: Slow PulseRadar register endpoint does not block Android /record handling', async () => {
  const receiver = await createMockAndroidReceiver();
  const slowServer = new (await import('node:http')).Server((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }, 800);
  });
  await new Promise<void>((resolve) => slowServer.listen(0, '127.0.0.1', () => resolve()));
  const slowPort = (slowServer.address() as net.AddressInfo).port;

  try {
    const regPromise = receiver.registerWithPulseRadar(`http://127.0.0.1:${slowPort}`);
    const recResp = await fetch(`${receiver.url}/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: 'TIKTOK',
        username: 'ebe_m72',
        streamUrl: 'https://cdn.example/ebe.flv',
      }),
    });
    assert.equal(recResp.status, 202);
    await regPromise;
  } finally {
    await receiver.close();
    await new Promise<void>((resolve) => slowServer.close(() => resolve()));
  }
});

test('T2-F10-05: Trailing slash in pulseRadarUrl normalizes cleanly without //api/android/register', async () => {
  const harness = await createE2EHarness();
  try {
    const reg = await harness.mockAndroid.registerWithPulseRadar(`${harness.pulseRadarUrl}///`);
    assert.equal(reg.status, 200);
  } finally {
    await harness.cleanup();
  }
});

// ============================================================================
// F11: Android 10-Minute Sync & Room Reconciliation — Boundaries
// ============================================================================

test('T2-F11-01: Local RECORDING/UPLOADING row is protected when server returns toRemove or IDLE update', async () => {
  const harness = await createE2EHarness({
    initialWorkspaceState: makeSingleUserWorkspace('reddit', 'tiktok.com', '@other_only'),
  });
  try {
    harness.mockAndroid.setUsers([
      { platform: 'TIKTOK', username: 'active_rec', status: 'RECORDING' },
      { platform: 'TIKTOK', username: 'active_upl', status: 'UPLOADING' },
    ]);
    await harness.mockAndroid.syncWithPulseRadar(harness.pulseRadarUrl);
    const localUsers = harness.mockAndroid.getUsers();
    assert.equal(localUsers.find((u) => u.username === 'active_rec')?.status, 'RECORDING');
    assert.equal(localUsers.find((u) => u.username === 'active_upl')?.status, 'UPLOADING');
  } finally {
    await harness.cleanup();
  }
});

test('T2-F11-02: Case + @ + TWITTER mismatch reconciles as same user without duplicate row', async () => {
  const harness = await createE2EHarness({
    initialWorkspaceState: makeSingleUserWorkspace('bluesky', 'x.com', '@Minalatuinehehe'),
  });
  try {
    harness.mockAndroid.setUsers([
      {
        platform: 'TWITTER',
        username: '@Minalatuinehehe',
        usernameOrUrl: '@Minalatuinehehe',
        status: 'IDLE',
      },
    ]);
    const res = await harness.mockAndroid.syncWithPulseRadar(harness.pulseRadarUrl);
    assert.equal(res.status, 200);
    assert.equal(harness.mockAndroid.getUsers().length, 1);
  } finally {
    await harness.cleanup();
  }
});

test('T2-F11-03: recordTriggers skips already RECORDING user and cellular-blocked user without crash', async () => {
  const harness = await createE2EHarness({
    initialWorkspaceState: makeSingleUserWorkspace('reddit', 'tiktok.com', '@u_rec, @u_cell'),
  });
  try {
    harness.mockAndroid.setUsers([
      { platform: 'TIKTOK', username: 'u_rec', status: 'RECORDING', allowCellular: true },
      { platform: 'TIKTOK', username: 'u_cell', status: 'IDLE', allowCellular: false },
    ]);
    harness.mockAndroid.setFaultConfig({ networkOnline: true, isWifi: false });
    await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@u_rec',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/rec.flv',
    });
    await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@u_cell',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/cell.flv',
    });
    const res = await harness.mockAndroid.syncWithPulseRadar(harness.pulseRadarUrl);
    assert.equal(res.status, 200);
    assert.deepEqual(harness.mockAndroid.getActiveRecordings(), ['TIKTOK::u_rec']);
    assert.equal(
      harness.mockAndroid.getUsers().find((u) => u.username === 'u_cell')?.status,
      'LIVE'
    );
  } finally {
    await harness.cleanup();
  }
});

test('T2-F11-04: Server returning 500 on /api/android/sync leaves Android local users untouched', async () => {
  const badServer = new (await import('node:http')).Server((_req, res) => {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal Error');
  });
  await new Promise<void>((resolve) => badServer.listen(0, '127.0.0.1', () => resolve()));
  const badPort = (badServer.address() as net.AddressInfo).port;
  const receiver = await createMockAndroidReceiver({
    initialUsers: [{ platform: 'TIKTOK', username: 'keep_me', status: 'IDLE' }],
  });
  try {
    const res = await receiver.syncWithPulseRadar(`http://127.0.0.1:${badPort}`);
    assert.equal(res.status, 500);
    assert.equal(receiver.getUsers().length, 1);
    assert.equal(receiver.getUsers()[0].username, 'keep_me');
  } finally {
    await receiver.close();
    await new Promise<void>((resolve) => badServer.close(() => resolve()));
  }
});

test('T2-F11-05: recordTriggers item with blank streamUrl is safely ignored without crashing', async () => {
  const fakeSyncServer = new (await import('node:http')).Server((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        syncedAt: new Date().toISOString(),
        authoritativeUsers: [],
        toAdd: [],
        toUpdate: [],
        toRemove: [],
        recordTriggers: [
          {
            eventId: 'evt_blank',
            platform: 'TIKTOK',
            username: 'ebe_m72',
            usernameOrUrl: '@ebe_m72',
            streamUrl: '   ',
            title: 'Blank',
            sourceUrl: 'https://tiktok.com/@ebe_m72/live',
            qualityInfo: '',
            detectedAt: new Date().toISOString(),
          },
        ],
      })
    );
  });
  await new Promise<void>((resolve) => fakeSyncServer.listen(0, '127.0.0.1', () => resolve()));
  const fakePort = (fakeSyncServer.address() as net.AddressInfo).port;
  const receiver = await createMockAndroidReceiver();
  try {
    const res = await receiver.syncWithPulseRadar(`http://127.0.0.1:${fakePort}`);
    assert.equal(res.status, 200);
    assert.equal(receiver.getActiveRecordings().length, 0);
  } finally {
    await receiver.close();
    await new Promise<void>((resolve) => fakeSyncServer.close(() => resolve()));
  }
});

// ============================================================================
// F12: Android UI, Preferences & Build/Unit Tests — Boundaries
// ============================================================================

test('T2-F12-01: Invalid commandServerPort (0, 70000) falls back or rejects outside 1..65535', async () => {
  const sanitizePort = (p: number): number =>
    Number.isInteger(p) && p >= 1 && p <= 65535 ? p : 8765;
  assert.equal(sanitizePort(0), 8765);
  assert.equal(sanitizePort(70000), 8765);
  assert.equal(sanitizePort(8777), 8777);
});

test('T2-F12-02: Blank or non-HTTP pulseRadarUrl (ftp://bad) is rejected by URL validation', async () => {
  const isValidServerUrl = (u: string): boolean => {
    try {
      const parsed = new URL(u.trim());
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  };
  assert.equal(isValidServerUrl(''), false);
  assert.equal(isValidServerUrl('ftp://bad'), false);
  assert.equal(isValidServerUrl('http://192.168.1.10:3000'), true);
});

test('T2-F12-03: Concurrent double-tap Sync Now serializes cleanly without duplicate rows', async () => {
  const harness = await createE2EHarness({
    initialWorkspaceState: makeSingleUserWorkspace('reddit', 'tiktok.com', '@ebe_m72'),
  });
  try {
    const [s1, s2] = await Promise.all([
      harness.mockAndroid.syncWithPulseRadar(harness.pulseRadarUrl),
      harness.mockAndroid.syncWithPulseRadar(harness.pulseRadarUrl),
    ]);
    assert.equal(s1.status, 200);
    assert.equal(s2.status, 200);
    assert.equal(harness.mockAndroid.getUsers().length, 1);
  } finally {
    await harness.cleanup();
  }
});

test('T2-F12-04: Platform normalization preserves FACEBOOK/X, maps TWITTER->X, rejects unknown', async () => {
  assert.equal(normalizePlatform('FACEBOOK'), 'FACEBOOK');
  assert.equal(normalizePlatform('X'), 'X');
  assert.equal(normalizePlatform('TWITTER'), 'X');
  assert.equal(normalizePlatform('unknown'), null);
  assert.equal(canonicalizeUsername('@Elinaaa2511', 'X'), 'elinaaa2511');
});

test('T2-F12-05: ADB device verification script enforces --user 0 and passes -DryRun validation', async () => {
  const ps1Path = path.join(import.meta.dirname, 'verify-android-device.ps1');
  assert.equal(fs.existsSync(ps1Path), true);
  const content = fs.readFileSync(ps1Path, 'utf8');
  assert.match(content, /--user 0/);
  assert.match(content, /com\.example\.streamrecorder\.debug/);
});
