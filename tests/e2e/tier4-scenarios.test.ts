import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {
  buildProduction44WorkspaceState,
  createE2EHarness,
  createMockAndroidReceiver,
  PRODUCTION_TIKTOK_HANDLES,
} from './harness.ts';
import type {
  AndroidHealthResponse,
  SyncResponse,
} from './types.ts';

test('T4-01: Full 44-User Production Workload (38 TikTok, 2 IG, 2 X, 2 FB)', async (t) => {
  const harness = await createE2EHarness({
    initialWorkspaceState: buildProduction44WorkspaceState(),
  });
  try {
    const health = await harness.getHealth();
    assert.equal(health.status, 200);
    assert.equal(health.body.trackedUsersCount, 44);

    await harness.mockAndroid.registerWithPulseRadar(harness.pulseRadarUrl);

    // 1. Initial sync with empty Android populates all 44 in toAdd
    const sync1 = await harness.mockAndroid.syncWithPulseRadar(harness.pulseRadarUrl);
    assert.equal(sync1.status, 200);
    const body1 = sync1.body as SyncResponse;
    assert.equal(body1.toAdd.length, 44);
    assert.equal(body1.authoritativeUsers.length, 44);

    // 2. Subsequent sync with all 44 returns empty diffs
    const sync2 = await harness.mockAndroid.syncWithPulseRadar(harness.pulseRadarUrl);
    assert.equal(sync2.status, 200);
    const body2 = sync2.body as SyncResponse;
    assert.equal(body2.toAdd.length, 0);
    assert.equal(body2.toUpdate.length, 0);
    assert.equal(body2.toRemove.length, 0);

    const aHealth = (await (await fetch(`${harness.mockAndroid.url}/health`)).json()) as AndroidHealthResponse;
    assert.equal(aHealth.userCount, 44);

    // 3. Live user on each of the 4 platforms triggers POST /record with Contract 2 JSON
    const ok = await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@ebe_m72',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/tt.flv',
    });
    if (!ok) {
      t.skip('E2E_LIVE_TRIGGER_URL not configured in live-target mode');
      return;
    }
    await harness.simulateLiveUser({
      platform: 'INSTAGRAM',
      username: '@baotran16tui',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/ig.flv',
    });
    await harness.simulateLiveUser({
      platform: 'X',
      username: '@Minalatuinehehe',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/x.flv',
    });
    await harness.simulateLiveUser({
      platform: 'FACEBOOK',
      username: '@phanbaotran2k',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/fb.flv',
    });

    await harness.tickScan();
    const reqs = harness.mockAndroid.getCapturedRequests();
    assert.equal(reqs.length, 4);
    assert.deepEqual(
      reqs.map((r) => `${r.body?.platform}::${r.body?.username}`).sort(),
      [
        'FACEBOOK::phanbaotran2k',
        'INSTAGRAM::baotran16tui',
        'TIKTOK::ebe_m72',
        'X::minalatuinehehe',
      ]
    );
  } finally {
    await harness.cleanup();
  }
});

test('T4-02: Server Boot Auto-Scan with Pre-Registered Device automatically dispatches 2 LIVE users', async (t) => {
  if (process.env.E2E_PULSE_RADAR_URL) {
    t.skip('Boot auto-scan test with pre-persisted android-state.json applies to self-test mode');
    return;
  }

  const harness = await createE2EHarness({
    initialWorkspaceState: buildProduction44WorkspaceState(),
    referenceServerOptions: {
      pollIntervalMs: 120,
      autoScanEnabled: true,
    },
  });
  try {
    await harness.registerAndroid({
      deviceId: 'sm_n770f_default',
      ip: '127.0.0.1',
      port: harness.mockAndroid.port,
    });
    await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@ebe_m72',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/boot1.flv',
    });
    await harness.simulateLiveUser({
      platform: 'INSTAGRAM',
      username: '@baotran16tui',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/boot2.flv',
    });

    // Restart server cleanly so it boots with pre-persisted workspace-state.json and android-state.json
    await harness.restartReferenceServer();
    await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@ebe_m72',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/boot1.flv',
    });
    await harness.simulateLiveUser({
      platform: 'INSTAGRAM',
      username: '@baotran16tui',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/boot2.flv',
    });

    // Wait for autonomous boot scan cycle WITHOUT manual tickScan or /api/scan
    await harness.mockAndroid.waitForRecord((r) => r.body?.username === 'ebe_m72', 3000);
    await harness.mockAndroid.waitForRecord((r) => r.body?.username === 'baotran16tui', 3000);

    const health = await harness.getHealth();
    assert.equal(health.body.autoScanEnabled, true);
    assert.equal(health.body.autoScanRunning, true);
  } finally {
    await harness.cleanup();
  }
});

test('T4-03: Mid-Session DHCP IP Change routes subsequent LIVE triggers exclusively to new receiver', async (t) => {
  const harness = await createE2EHarness({
    initialWorkspaceState: buildProduction44WorkspaceState(),
  });
  const receiverAfterDhcp = await createMockAndroidReceiver({ ip: '192.168.1.42' });
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
      streamUrl: 'https://cdn.example/ebe.flv',
    });
    if (!hooked) {
      t.skip('E2E_LIVE_TRIGGER_URL not configured in live-target mode');
      return;
    }
    await harness.tickScan();
    assert.equal(harness.mockAndroid.getCapturedRequests().length, 1);

    // DHCP change -> Android registers new endpoint
    await harness.registerAndroid({
      deviceId: 'sm_n770f_default',
      ip: '127.0.0.1',
      port: receiverAfterDhcp.port,
    });

    await harness.simulateLiveUser({
      platform: 'FACEBOOK',
      username: '@luvtint',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/luvtint.flv',
    });
    await harness.tickScan();

    assert.equal(receiverAfterDhcp.getCapturedRequests().length, 1);
    assert.equal(receiverAfterDhcp.getCapturedRequests()[0].body?.username, 'luvtint');
    // Stale endpoint received zero additional requests
    assert.equal(harness.mockAndroid.getCapturedRequests().length, 1);
  } finally {
    await receiverAfterDhcp.close();
    await harness.cleanup();
  }
});

test('T4-04: Missed Live Trigger Recovery at 10-Min Sync for @baotran16tui (Instagram)', async (t) => {
  const closedPort = await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });

  const harness = await createE2EHarness({
    initialWorkspaceState: buildProduction44WorkspaceState(),
  });
  try {
    // Populate Android with 44 users first
    await harness.mockAndroid.syncWithPulseRadar(harness.pulseRadarUrl);
    // Simulate Wi-Fi drop via unreachable registered port
    await harness.registerAndroid({ ip: '127.0.0.1', port: closedPort });

    const hooked = await harness.simulateLiveUser({
      platform: 'INSTAGRAM',
      username: '@baotran16tui',
      status: 'LIVE',
      streamUrl: 'https://cdn.example/bao_live.flv',
    });
    if (!hooked) {
      t.skip('E2E_LIVE_TRIGGER_URL not configured in live-target mode');
      return;
    }
    await harness.tickScan();
    const errStatus = await harness.getAndroidStatus();
    assert.ok(errStatus.body.scanner.lastDispatchError !== null);

    // Wi-Fi returns and 10-min sync runs
    const syncRes = await harness.mockAndroid.syncWithPulseRadar(harness.pulseRadarUrl);
    assert.equal(syncRes.status, 200);
    const body = syncRes.body as SyncResponse;
    assert.equal(body.recordTriggers.length, 1);
    assert.equal(body.recordTriggers[0].username, 'baotran16tui');
    assert.equal(body.recordTriggers[0].platform, 'INSTAGRAM');
    assert.equal(body.recordTriggers[0].streamUrl, 'https://cdn.example/bao_live.flv');

    const aHealth = (await (await fetch(`${harness.mockAndroid.url}/health`)).json()) as AndroidHealthResponse;
    assert.equal(aHealth.activeRecordings, 1);
  } finally {
    await harness.cleanup();
  }
});

test('T4-05: Process Restart Persistence Across Both Nodes retains 44 users, IP, lastSyncAt, and cookies', async (t) => {
  if (process.env.E2E_PULSE_RADAR_URL) {
    t.skip('Restart persistence test applies to self-test mode');
    return;
  }

  const initial = buildProduction44WorkspaceState();
  const harness = await createE2EHarness({ initialWorkspaceState: initial });
  try {
    await harness.mockAndroid.registerWithPulseRadar(harness.pulseRadarUrl);
    await harness.mockAndroid.syncWithPulseRadar(harness.pulseRadarUrl);
    const statusBefore = await harness.getAndroidStatus();
    const syncAtBefore = statusBefore.body.device?.lastSyncAt;
    assert.ok(syncAtBefore);

    await harness.restartReferenceServer();

    const statusAfter = await harness.getAndroidStatus();
    assert.equal(statusAfter.body.device?.port, harness.mockAndroid.port);
    assert.equal(statusAfter.body.device?.lastSyncAt, syncAtBefore);

    const wsAfter = await harness.getWorkspaceState();
    assert.equal(wsAfter.body.state?.scannerSettings.cookies.instagram, 'test_ig_cookie');

    // UI PUT /api/workspace-state must not erase Android state
    await harness.putWorkspaceState(initial);
    const statusPostPut = await harness.getAndroidStatus();
    assert.equal(statusPostPut.body.device?.lastSyncAt, syncAtBefore);
    assert.equal((await harness.getHealth()).body.trackedUsersCount, 44);
  } finally {
    await harness.cleanup();
  }
});

test('T4-06: Cellular vs Wi-Fi Mixed User Policies (2 allowCellular=true, 3 allowCellular=false)', async (t) => {
  const harness = await createE2EHarness({
    initialWorkspaceState: buildProduction44WorkspaceState(),
  });
  try {
    await harness.mockAndroid.syncWithPulseRadar(harness.pulseRadarUrl);
    const users = harness.mockAndroid.getUsers();
    const fiveTargets = PRODUCTION_TIKTOK_HANDLES.slice(0, 5).map((h) => h.replace(/^@/, ''));

    // Seed 2 allowCellular: true and 3 allowCellular: false
    harness.mockAndroid.setUsers(
      users.map((u) => ({
        ...u,
        allowCellular: u.username === fiveTargets[0] || u.username === fiveTargets[1],
      }))
    );

    // Switch device to Cellular
    harness.mockAndroid.setFaultConfig({ networkOnline: true, isWifi: false });
    await harness.registerAndroid({
      ip: '127.0.0.1',
      port: harness.mockAndroid.port,
      networkType: 'CELLULAR',
    });

    const hooked = await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: fiveTargets[0],
      status: 'LIVE',
      streamUrl: 'https://cdn.example/0.flv',
    });
    if (!hooked) {
      t.skip('E2E_LIVE_TRIGGER_URL not configured in live-target mode');
      return;
    }
    for (let i = 1; i < 5; i++) {
      await harness.simulateLiveUser({
        platform: 'TIKTOK',
        username: fiveTargets[i],
        status: 'LIVE',
        streamUrl: `https://cdn.example/${i}.flv`,
      });
    }

    await harness.tickScan();
    const reqs = harness.mockAndroid.getCapturedRequests();
    assert.equal(reqs.length, 5);
    const startedCount = reqs.filter((r) => r.statusCode === 202 && r.responseStatus === 'RECORDING_STARTED').length;
    const skippedCount = reqs.filter((r) => r.statusCode === 200 && r.responseStatus === 'SKIPPED_CELLULAR_POLICY').length;
    assert.equal(startedCount, 2);
    assert.equal(skippedCount, 3);
    assert.equal(harness.mockAndroid.getActiveRecordings().length, 2);

    // Switch back to Wi-Fi and run 10-min sync -> remaining 3 unrecorded LIVE users trigger via recordTriggers
    harness.mockAndroid.setFaultConfig({ networkOnline: true, isWifi: true });
    const syncRes = await harness.mockAndroid.syncWithPulseRadar(harness.pulseRadarUrl);
    assert.equal(syncRes.status, 200);
    const body = syncRes.body as SyncResponse;
    assert.equal(body.recordTriggers.length, 3);
    assert.equal(harness.mockAndroid.getActiveRecordings().length, 5);
  } finally {
    await harness.cleanup();
  }
});

test('T4-07: Live Multi-User Concurrent Lifecycle & Rule Churn (44 -> 45 users)', async (t) => {
  const ws = buildProduction44WorkspaceState();
  const harness = await createE2EHarness({ initialWorkspaceState: ws });
  try {
    await harness.mockAndroid.registerWithPulseRadar(harness.pulseRadarUrl);
    await harness.mockAndroid.syncWithPulseRadar(harness.pulseRadarUrl);

    const handles = PRODUCTION_TIKTOK_HANDLES.map((h) => h.replace(/^@/, ''));
    // Set custom telegramTopicId and active states: 2 RECORDING, 1 UPLOADING, 1 ERROR
    harness.mockAndroid.setUsers(
      harness.mockAndroid.getUsers().map((u) => {
        if (u.username === handles[0] || u.username === handles[1]) {
          return { ...u, status: 'RECORDING', telegramTopicId: 9001 };
        }
        if (u.username === handles[2]) {
          return { ...u, status: 'UPLOADING', telegramTopicId: 9002 };
        }
        if (u.username === handles[3]) {
          return { ...u, status: 'ERROR', telegramTopicId: 9003 };
        }
        return { ...u, telegramTopicId: 9999 };
      })
    );
    await harness.mockAndroid.syncWithPulseRadar(harness.pulseRadarUrl);

    // Operator removes 1 old user (handles[10]) and adds 2 new users -> 45 total
    const nextWs = buildProduction44WorkspaceState();
    const updatedTikTok = PRODUCTION_TIKTOK_HANDLES.filter((h) => h !== `@${handles[10]}`);
    updatedTikTok.push('@fresh_creator_1' as never, '@fresh_creator_2' as never);
    nextWs.rules[0].keyword = updatedTikTok.join(', ');
    await harness.putWorkspaceState(nextWs);

    // 2 RECORDING + 1 UPLOADING + 2 newly LIVE IDLE users are LIVE on server
    const hooked = await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: handles[0],
      status: 'LIVE',
      streamUrl: 'https://cdn.example/h0.flv',
    });
    if (!hooked) {
      t.skip('E2E_LIVE_TRIGGER_URL not configured in live-target mode');
      return;
    }
    await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: handles[2],
      status: 'LIVE',
      streamUrl: 'https://cdn.example/h2.flv',
    });
    await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: handles[4],
      status: 'LIVE',
      streamUrl: 'https://cdn.example/h4.flv',
    });
    await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: handles[5],
      status: 'LIVE',
      streamUrl: 'https://cdn.example/h5.flv',
    });

    await harness.tickScan();

    // Auto-scan skipped handles[0] (RECORDING) & handles[2] (UPLOADING), dispatched only handles[4] & handles[5]
    const dispatched = harness.mockAndroid.getCapturedRequests().map((r) => r.body?.username).sort();
    assert.deepEqual(dispatched, [handles[4], handles[5]].sort());

    // 10-min sync converges to 45 users, adds 2, removes 1, preserves RECORDING/UPLOADING & telegramTopicId
    const syncRes = await harness.mockAndroid.syncWithPulseRadar(harness.pulseRadarUrl);
    assert.equal(syncRes.status, 200);
    const body = syncRes.body as SyncResponse;
    assert.equal(body.toAdd.length, 2);
    assert.equal(body.toRemove.length, 1);
    assert.equal(body.toRemove[0].username, handles[10]);

    const finalUsers = harness.mockAndroid.getUsers();
    assert.equal(finalUsers.length, 45);
    assert.equal(finalUsers.find((u) => u.username === handles[0])?.status, 'RECORDING');
    assert.equal(finalUsers.find((u) => u.username === handles[0])?.telegramTopicId, 9001);
    assert.equal(finalUsers.find((u) => u.username === handles[2])?.status, 'UPLOADING');
    assert.equal(finalUsers.find((u) => u.username === handles[2])?.telegramTopicId, 9002);

    const aHealth = (await (await fetch(`${harness.mockAndroid.url}/health`)).json()) as AndroidHealthResponse;
    assert.equal(aHealth.userCount, 45);
  } finally {
    await harness.cleanup();
  }
});
