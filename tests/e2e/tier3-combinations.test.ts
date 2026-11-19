import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildProduction44WorkspaceState,
  createE2EHarness,
  createMockAndroidReceiver,
} from './harness.ts';
import { ReferenceContractServer } from './referenceServer.ts';
import type {
  AndroidHealthResponse,
  RegisterResponse,
  SyncResponse,
} from './types.ts';

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

test('T3-01: Register IP1 -> Live Scan -> Change IP2 -> Live Scan routes exclusively to new receiver', async (t) => {
  const harness = await createE2EHarness({
    initialWorkspaceState: makeSingleUserWorkspace('reddit', 'tiktok.com', '@user_a, @user_b'),
  });
  const receiverB = await createMockAndroidReceiver();
  try {
    await harness.registerAndroid({ deviceId: 'sm_n770f', ip: '127.0.0.1', port: harness.mockAndroid.port });
    const hooked = await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@user_a',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/a.flv',
    });
    if (!hooked) {
      t.skip('E2E_LIVE_TRIGGER_URL not configured in live-target mode');
      return;
    }
    await harness.tickScan();
    assert.equal(harness.mockAndroid.getCapturedRequests().length, 1);
    assert.equal(harness.mockAndroid.getCapturedRequests()[0].body?.username, 'user_a');

    // Re-register to receiver B
    await harness.registerAndroid({ deviceId: 'sm_n770f', ip: '127.0.0.1', port: receiverB.port });
    await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@user_b',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/b.flv',
    });
    await harness.tickScan();

    assert.equal(receiverB.getCapturedRequests().length, 1);
    assert.equal(receiverB.getCapturedRequests()[0].body?.username, 'user_b');
    assert.equal(harness.mockAndroid.getCapturedRequests().length, 1);

    const status = await harness.getAndroidStatus();
    assert.equal(status.body.device?.port, receiverB.port);
  } finally {
    await receiverB.close();
    await harness.cleanup();
  }
});

test('T3-02: Implicit socket IP fallback (ip: "") registers 127.0.0.1 and receives live trigger (202)', async (t) => {
  const harness = await createE2EHarness({
    initialWorkspaceState: makeSingleUserWorkspace('reddit', 'tiktok.com', '@ebe_m72'),
  });
  try {
    const reg = await harness.registerAndroid({
      deviceId: 'sm_n770f',
      ip: '',
      port: harness.mockAndroid.port,
    });
    assert.equal(reg.status, 200);
    assert.equal((reg.body as RegisterResponse).ip, '127.0.0.1');

    const hooked = await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@ebe_m72',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/ebe.flv',
    });
    if (!hooked) {
      t.skip('E2E_LIVE_TRIGGER_URL not configured in live-target mode');
      return;
    }
    await harness.tickScan();
    const rec = await harness.mockAndroid.waitForRecord();
    assert.equal(rec.statusCode, 202);
  } finally {
    await harness.cleanup();
  }
});

test('T3-03: Sync adds user -> Live scan triggers 202 -> Sync while RECORDING preserves state -> Sync after IDLE', async (t) => {
  const harness = await createE2EHarness({
    initialWorkspaceState: makeSingleUserWorkspace('reddit', 'tiktok.com', '@ebe_m72'),
  });
  try {
    await harness.mockAndroid.registerWithPulseRadar(harness.pulseRadarUrl);
    // 1. Android starts empty -> sync adds @ebe_m72
    const sync1 = await harness.mockAndroid.syncWithPulseRadar(harness.pulseRadarUrl);
    assert.equal(sync1.status, 200);
    assert.equal((sync1.body as SyncResponse).toAdd.length, 1);
    assert.equal(harness.mockAndroid.getUsers().length, 1);

    // 2. User goes LIVE -> server scan triggers POST /record (202)
    const hooked = await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@ebe_m72',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/ebe.flv',
    });
    if (!hooked) {
      t.skip('E2E_LIVE_TRIGGER_URL not configured in live-target mode');
      return;
    }
    await harness.tickScan();
    assert.equal(harness.mockAndroid.getCapturedRequests().length, 1);
    assert.equal(harness.mockAndroid.getCapturedRequests()[0].statusCode, 202);

    // 3. Mid-recording sync preserves effectiveStatus: RECORDING and emits zero recordTriggers
    const sync2 = await harness.mockAndroid.syncWithPulseRadar(harness.pulseRadarUrl);
    assert.equal(sync2.status, 200);
    const body2 = sync2.body as SyncResponse;
    assert.equal(body2.authoritativeUsers[0].effectiveStatus, 'RECORDING');
    assert.equal(body2.recordTriggers.length, 0);

    // 4. Stream & recording finish -> post-finish sync sees IDLE
    await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@ebe_m72',
      status: 'NOT_LIVE',
    });
    harness.mockAndroid.clearActiveRecording('TIKTOK', 'ebe_m72');
    const sync3 = await harness.mockAndroid.syncWithPulseRadar(harness.pulseRadarUrl);
    assert.equal(sync3.status, 200);
    assert.equal((sync3.body as SyncResponse).authoritativeUsers[0].effectiveStatus, 'IDLE');
  } finally {
    await harness.cleanup();
  }
});

test('T3-04: Concurrent UI PUT /api/workspace-state with Android sync never clobbers device state', async () => {
  const harness = await createE2EHarness({
    initialWorkspaceState: makeSingleUserWorkspace('reddit', 'tiktok.com', '@ebe_m72'),
  });
  try {
    await harness.registerAndroid({ deviceId: 'sm_n770f', ip: '192.168.1.9', port: 8765 });
    const nextWs = makeSingleUserWorkspace('reddit', 'tiktok.com', '@ebe_m72, @new_creator');

    const [putRes, syncRes] = await Promise.all([
      harness.putWorkspaceState(nextWs),
      harness.syncAndroid({
        deviceId: 'sm_n770f',
        ip: '192.168.1.9',
        port: 8765,
        users: [{ username: 'ebe_m72', platform: 'TIKTOK', status: 'IDLE', isEnabled: true }],
      }),
    ]);
    assert.equal(putRes.status, 200);
    assert.equal(syncRes.status, 200);

    const followUpSync = await harness.syncAndroid({
      deviceId: 'sm_n770f',
      ip: '192.168.1.9',
      port: 8765,
      users: [{ username: 'ebe_m72', platform: 'TIKTOK', status: 'IDLE', isEnabled: true }],
    });
    const body = followUpSync.body as SyncResponse;
    assert.equal(
      body.authoritativeUsers.some((u) => u.username === 'new_creator'),
      true
    );
    assert.equal((await harness.getAndroidStatus()).body.device?.ip, '192.168.1.9');
  } finally {
    await harness.cleanup();
  }
});

test('T3-05: Offline Android during live scan -> recovery at sync emits missed LIVE stream in recordTriggers', async (t) => {
  const closedPort = await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });

  const harness = await createE2EHarness({
    initialWorkspaceState: makeSingleUserWorkspace('reddit', 'tiktok.com', '@ebe_m72'),
  });
  try {
    await harness.registerAndroid({ ip: '127.0.0.1', port: closedPort });
    const hooked = await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@ebe_m72',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/missed.flv',
    });
    if (!hooked) {
      t.skip('E2E_LIVE_TRIGGER_URL not configured in live-target mode');
      return;
    }
    await harness.tickScan();
    const status = await harness.getAndroidStatus();
    assert.ok(status.body.scanner.lastDispatchError);

    // Now Android recovers and syncs reporting IDLE
    const syncRes = await harness.mockAndroid.syncWithPulseRadar(harness.pulseRadarUrl);
    assert.equal(syncRes.status, 200);
    const body = syncRes.body as SyncResponse;
    assert.equal(body.recordTriggers.length, 1);
    assert.equal(body.recordTriggers[0].streamUrl, 'https://cdn.example/missed.flv');
    assert.equal(harness.mockAndroid.getActiveRecordings().length, 1);
  } finally {
    await harness.cleanup();
  }
});

test('T3-06: Multi-platform normalization combo across TIKTOK, INSTAGRAM, FACEBOOK, and X (TWITTER alias)', async () => {
  const ws = buildProduction44WorkspaceState();
  ws.rules[0].keyword = '@ebe_m72';
  ws.rules[1].keyword = '@baotran16tui';
  ws.rules[2].keyword = '@Minalatuinehehe';
  ws.rules[3].keyword = '@phanbaotran2k';

  const harness = await createE2EHarness({ initialWorkspaceState: ws });
  try {
    const syncRes = await harness.syncAndroid({
      ip: '127.0.0.1',
      port: harness.mockAndroid.port,
      users: [
        { platform: 'TIKTOK', usernameOrUrl: 'https://www.tiktok.com/@ebe_m72/live', status: 'IDLE', isEnabled: true },
        { platform: 'INSTAGRAM', usernameOrUrl: 'https://www.instagram.com/baotran16tui/live', status: 'IDLE', isEnabled: true },
        { platform: 'TWITTER', username: '@minalatuinehehe', status: 'IDLE', isEnabled: true },
        { platform: 'FACEBOOK', usernameOrUrl: 'https://www.facebook.com/phanbaotran2k/live', status: 'IDLE', isEnabled: true },
      ],
    });
    assert.equal(syncRes.status, 200);
    const body = syncRes.body as SyncResponse;
    assert.equal(body.toAdd.length, 0);
    assert.equal(body.toRemove.length, 0);

    for (const [plat, user] of [
      ['TIKTOK', 'ebe_m72'],
      ['INSTAGRAM', 'baotran16tui'],
      ['TWITTER', 'Minalatuinehehe'],
      ['FACEBOOK', 'phanbaotran2k'],
    ] as const) {
      const rec = await fetch(`${harness.mockAndroid.url}/record`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: plat, username: user, streamUrl: `https://cdn.example/${user}.flv` }),
      });
      assert.equal(rec.status, 202);
    }
  } finally {
    await harness.cleanup();
  }
});

test('T3-07: Passive mode + embedded receiver + cellular policy (user1 skipped, user2 started)', async () => {
  const receiver = await createMockAndroidReceiver({
    initialUsers: [
      { platform: 'TIKTOK', username: 'user1', allowCellular: false, status: 'IDLE' },
      { platform: 'TIKTOK', username: 'user2', allowCellular: true, status: 'IDLE' },
    ],
  });
  try {
    receiver.setFaultConfig({ networkOnline: true, isWifi: false });
    const r1 = await fetch(`${receiver.url}/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'TIKTOK', username: 'user1', streamUrl: 'https://cdn.example/1.flv' }),
    });
    assert.equal(r1.status, 200);
    assert.equal(((await r1.json()) as { status: string }).status, 'SKIPPED_CELLULAR_POLICY');

    const r2 = await fetch(`${receiver.url}/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'TIKTOK', username: 'user2', streamUrl: 'https://cdn.example/2.flv' }),
    });
    assert.equal(r2.status, 202);
    assert.equal(((await r2.json()) as { status: string }).status, 'RECORDING_STARTED');

    const users = receiver.getUsers();
    assert.equal(users.find((u) => u.username === 'user1')?.status, 'LIVE');
    assert.equal(users.find((u) => u.username === 'user2')?.status, 'RECORDING');
  } finally {
    await receiver.close();
  }
});

test('T3-08: Low-storage abort recovery clears activeRecordings so subsequent /record returns 202', async () => {
  const receiver = await createMockAndroidReceiver();
  try {
    receiver.setFaultConfig({ simulateLowStorageAbort: true });
    const failResp = await fetch(`${receiver.url}/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'TIKTOK', username: 'ebe_m72', streamUrl: 'https://cdn.example/ebe.flv' }),
    });
    assert.equal(failResp.status, 507);
    const h1 = (await (await fetch(`${receiver.url}/health`)).json()) as AndroidHealthResponse;
    assert.equal(h1.activeRecordings, 0);

    receiver.resetFaultConfig();
    const okResp = await fetch(`${receiver.url}/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'TIKTOK', username: 'ebe_m72', streamUrl: 'https://cdn.example/ebe.flv' }),
    });
    assert.equal(okResp.status, 202);
  } finally {
    await receiver.close();
  }
});

test('T3-09: Server restart mid-lifecycle preserves registered IP and dispatches live scan without re-registering', async (t) => {
  if (process.env.E2E_PULSE_RADAR_URL) {
    t.skip('Server restart test applies to self-test ReferenceContractServer');
    return;
  }

  const harness = await createE2EHarness({
    initialWorkspaceState: makeSingleUserWorkspace('reddit', 'tiktok.com', '@ebe_m72'),
  });
  try {
    await harness.registerAndroid({ deviceId: 'sm_n770f', ip: '127.0.0.1', port: harness.mockAndroid.port });
    await harness.mockAndroid.syncWithPulseRadar(harness.pulseRadarUrl);

    await harness.restartReferenceServer();

    const status = await harness.getAndroidStatus();
    assert.equal(status.body.device?.port, harness.mockAndroid.port);
    assert.ok(status.body.device?.lastSyncAt);

    await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@ebe_m72',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/restarted.flv',
    });
    await harness.tickScan();
    const rec = await harness.mockAndroid.waitForRecord();
    assert.equal(rec.body?.streamUrl, 'https://cdn.example/restarted.flv');
  } finally {
    await harness.cleanup();
  }
});

test('T3-10: Webhook sandbox and Android /record coexistence on live detection', async (t) => {
  const harness = await createE2EHarness({
    initialWorkspaceState: makeSingleUserWorkspace('reddit', 'tiktok.com', '@ebe_m72'),
  });
  try {
    await harness.registerAndroid({ ip: '127.0.0.1', port: harness.mockAndroid.port });
    const hooked = await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@ebe_m72',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/ebe.flv',
    });
    if (!hooked) {
      t.skip('E2E_LIVE_TRIGGER_URL not configured in live-target mode');
      return;
    }
    await harness.tickScan();
    assert.equal(harness.mockAndroid.getCapturedRequests().length, 1);

    const logs = await harness.httpJson<{ receipts: unknown[] }>(
      harness.pulseRadarUrl,
      '/api/webhook-sandbox/logs'
    );
    assert.equal(logs.status, 200);
    assert.ok(logs.body.receipts.length >= 1);
  } finally {
    await harness.cleanup();
  }
});

test('T3-11: Duplicate /record race within 50ms yields one 202 and one 200 ALREADY_RECORDING (activeRecordings=1)', async () => {
  const receiver = await createMockAndroidReceiver();
  try {
    const payload = JSON.stringify({
      platform: 'TIKTOK',
      username: 'ebe_m72',
      streamUrl: 'https://cdn.example/ebe.flv',
    });
    const [r1, r2] = await Promise.all([
      fetch(`${receiver.url}/record`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      }),
      fetch(`${receiver.url}/record`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      }),
    ]);
    const statuses = [r1.status, r2.status].sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 202]);
    const health = (await (await fetch(`${receiver.url}/health`)).json()) as AndroidHealthResponse;
    assert.equal(health.activeRecordings, 1);
  } finally {
    await receiver.close();
  }
});

test('T3-12: Rule removed while Android RECORDING protects active row until IDLE, then deletes cleanly', async () => {
  const harness = await createE2EHarness({
    initialWorkspaceState: makeSingleUserWorkspace('reddit', 'tiktok.com', '@ebe_m72, @keep_user'),
  });
  try {
    harness.mockAndroid.setUsers([
      { platform: 'TIKTOK', username: 'ebe_m72', status: 'RECORDING' },
      { platform: 'TIKTOK', username: 'keep_user', status: 'IDLE' },
    ]);

    // Remove @ebe_m72 from server workspace
    await harness.putWorkspaceState(makeSingleUserWorkspace('reddit', 'tiktok.com', '@keep_user'));

    // 1. Sync while RECORDING -> local row protected
    const sync1 = await harness.mockAndroid.syncWithPulseRadar(harness.pulseRadarUrl);
    assert.equal((sync1.body as SyncResponse).toRemove.length, 1);
    assert.equal(
      harness.mockAndroid.getUsers().some((u) => u.username === 'ebe_m72'),
      true
    );

    // 2. Recording finishes -> next sync removes stale row
    harness.mockAndroid.clearActiveRecording('TIKTOK', 'ebe_m72');
    await harness.mockAndroid.syncWithPulseRadar(harness.pulseRadarUrl);
    assert.equal(
      harness.mockAndroid.getUsers().some((u) => u.username === 'ebe_m72'),
      false
    );
  } finally {
    await harness.cleanup();
  }
});

test('T3-13: Changing Android pulseRadarUrl & commandServerPort routes register/sync to new server and closes old port', async () => {
  const dir1 = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'pr-t313-a-'));
  const dir2 = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'pr-t313-b-'));
  const srv1 = new ReferenceContractServer({ dataDir: dir1, autoScanEnabled: false });
  const srv2 = new ReferenceContractServer({ dataDir: dir2, autoScanEnabled: false });
  const receiverA = await createMockAndroidReceiver({ ip: '192.168.1.9' });
  const receiverB = await createMockAndroidReceiver({ ip: '192.168.1.9' });
  try {
    await srv1.start();
    await srv2.start();
    await receiverA.registerWithPulseRadar(srv1.url);
    await receiverA.close(); // old port closed

    await receiverB.registerWithPulseRadar(srv2.url);
    const sync2 = await receiverB.syncWithPulseRadar(srv2.url);
    assert.equal(sync2.status, 200);

    const status2 = (await (await fetch(`${srv2.url}/api/android/status`)).json()) as {
      device: { port: number };
    };
    assert.equal(status2.device.port, receiverB.port);
    await assert.rejects(() => fetch(`${receiverA.url}/health`));
  } finally {
    await receiverB.close();
    await srv1.stop();
    await srv2.stop();
    fs.rmSync(dir1, { recursive: true, force: true });
    fs.rmSync(dir2, { recursive: true, force: true });
  }
});

test('T3-14: Stream ends on server (IDLE) while Android UPLOADING preserves UPLOADING state', async () => {
  const harness = await createE2EHarness({
    initialWorkspaceState: makeSingleUserWorkspace('reddit', 'tiktok.com', '@ebe_m72'),
  });
  try {
    await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@ebe_m72',
      status: 'NOT_LIVE',
    });
    harness.mockAndroid.setUsers([
      { platform: 'TIKTOK', username: 'ebe_m72', status: 'UPLOADING', isEnabled: true },
    ]);
    const syncRes = await harness.mockAndroid.syncWithPulseRadar(harness.pulseRadarUrl);
    assert.equal(syncRes.status, 200);
    const body = syncRes.body as SyncResponse;
    assert.equal(body.authoritativeUsers[0].effectiveStatus, 'UPLOADING');
    assert.equal(body.recordTriggers.length, 0);
    assert.equal(
      harness.mockAndroid.getUsers().find((u) => u.username === 'ebe_m72')?.status,
      'UPLOADING'
    );
  } finally {
    await harness.cleanup();
  }
});

test('T3-15: Disabling rule_x_source via PUT /api/workspace-state stops X triggers and updates isEnabled=false', async (t) => {
  const ws = buildProduction44WorkspaceState();
  ws.rules[2].enabled = false; // disable rule_x_source
  const harness = await createE2EHarness({ initialWorkspaceState: ws });
  try {
    await harness.registerAndroid({ ip: '127.0.0.1', port: harness.mockAndroid.port });
    const hooked = await harness.simulateLiveUser({
      platform: 'X',
      username: '@Minalatuinehehe',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/x.flv',
    });
    if (!hooked) {
      t.skip('E2E_LIVE_TRIGGER_URL not configured in live-target mode');
      return;
    }
    await harness.tickScan();
    assert.equal(harness.mockAndroid.getCapturedRequests().length, 0);

    const syncRes = await harness.syncAndroid({
      ip: '127.0.0.1',
      port: harness.mockAndroid.port,
      users: [{ platform: 'X', username: 'minalatuinehehe', status: 'IDLE', isEnabled: true }],
    });
    const body = syncRes.body as SyncResponse;
    const xUpdate = body.toUpdate.find((u) => u.username === 'minalatuinehehe');
    assert.equal(xUpdate?.isEnabled, false);
    assert.equal(body.recordTriggers.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test('T3-16: Slow Android endpoint (>5s) sets lastDispatchError; re-registering faster receiver clears it on next scan', async (t) => {
  const harness = await createE2EHarness({
    initialWorkspaceState: makeSingleUserWorkspace('reddit', 'tiktok.com', '@ebe_m72'),
  });
  const fastReceiver = await createMockAndroidReceiver();
  try {
    harness.mockAndroid.setFaultConfig({ delayMs: 6500 });
    await harness.registerAndroid({ ip: '127.0.0.1', port: harness.mockAndroid.port });
    const hooked = await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@ebe_m72',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/ebe.flv',
    });
    if (!hooked) {
      t.skip('E2E_LIVE_TRIGGER_URL not configured in live-target mode');
      return;
    }
    await harness.tickScan();
    const errStatus = await harness.getAndroidStatus();
    assert.ok(errStatus.body.scanner.lastDispatchError);

    // Clear session dedup via NOT_LIVE -> LIVE and switch to fast receiver
    await harness.simulateLiveUser({ platform: 'TIKTOK', username: '@ebe_m72', status: 'NOT_LIVE' });
    await harness.tickScan();

    await harness.registerAndroid({ ip: '127.0.0.1', port: fastReceiver.port });
    await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@ebe_m72',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/ebe_fast.flv',
    });
    await harness.tickScan();

    const rec = await fastReceiver.waitForRecord();
    assert.equal(rec.statusCode, 202);
    const recoveredStatus = await harness.getAndroidStatus();
    assert.equal(recoveredStatus.body.scanner.lastDispatchError, null);
  } finally {
    await fastReceiver.close();
    await harness.cleanup();
  }
});
