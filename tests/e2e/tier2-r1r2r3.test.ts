import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import {
  asTikTokEvent,
  createR1R2TestEnv,
  loadContractModule,
  makeRule,
  makeSandboxServer,
  startLocalHttpServer,
  type ContractCollectorFetchResult,
  type ContractPlatformCollector,
  type ContractStorageUploadParams,
  type ContractUserValidationResult,
  type ContractWatcherEvent,
  type ContractWatcherStatusResponse,
  type ContractWorkspaceState,
} from './r1r2r3Harness.ts';
import { createMediaDownloader, resolveHighQualityMedia } from '../../server/mediaDownloader';
import { createTelegramService } from '../../server/storage/index';
import type { StorageUploadParams } from '../../server/storage/types';
import { Notifier } from '../../server/watchers/notifier';
import { createWatcherStateStore } from '../../server/watchers/stateStore';

// ============================================================================
// Feature 1: R1 Validation/Format/Auth/Block/Cookie Boundary Cases (6 tests)
// ============================================================================

test('T2-F1-01: Reserved routes and invalid formats return INVALID_FORMAT with 0 upstream fetches', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  const invalidInputs = [
    { target: 'https://www.instagram.com/p/C123abc/', platform: 'INSTAGRAM' },
    { target: 'https://www.instagram.com/explore/', platform: 'INSTAGRAM' },
    { target: 'https://www.instagram.com/reels/xyz/', platform: 'INSTAGRAM' },
    { target: 'https://x.com/i/bookmarks', platform: 'X' },
    { target: 'https://www.facebook.com/watch/?v=99', platform: 'FACEBOOK' },
    { target: '@a', platform: 'TIKTOK' },
    { target: '@username_way_too_long_for_x', platform: 'X' },
  ];

  for (const inp of invalidInputs) {
    const resp = await env.apiJson<{ ok: boolean; result: ContractUserValidationResult }>(
      'POST',
      '/api/user/validate',
      inp
    );
    assert.equal(resp.status, 200);
    assert.equal(resp.data.result.valid, false, `Expected invalid for ${inp.target}`);
    assert.equal(resp.data.result.status, 'INVALID_FORMAT', `Expected INVALID_FORMAT for ${inp.target}`);
    assert.ok(resp.data.result.error && resp.data.result.error.length > 0);
  }

  assert.equal(env.recordedRequests.length, 0, 'Invalid/reserved formats must not trigger upstream HTTP fetches');
});

test('T2-F1-02: Malformed POST /api/user/validate payloads return 400 cleanly', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  const badBodies = [{}, { target: '' }, { target: '   ' }, { target: 12345 }, { target: null }];
  for (const body of badBodies) {
    const resp = await env.apiJson<{ ok: boolean; error: string }>('POST', '/api/user/validate', body);
    assert.equal(resp.status, 400, `Expected 400 for body ${JSON.stringify(body)}`);
    assert.equal(resp.data.ok, false);
    assert.ok(resp.data.error);
  }
});

test('T2-F1-03: 404 / missing user returns NOT_FOUND across all 4 platforms', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  // None of these usernames exist in env.mocks -> mock router returns 404 / UserUnavailable
  const cases = [
    { target: '@tt_t2_missing_404', platform: 'TIKTOK' },
    { target: '@ig_t2_missing_404', platform: 'INSTAGRAM' },
    { target: '@fb_t2_missing_404', platform: 'FACEBOOK' },
    { target: '@x_t2_miss_404', platform: 'X' },
  ];

  for (const c of cases) {
    const resp = await env.apiJson<{ ok: boolean; result: ContractUserValidationResult }>(
      'POST',
      '/api/user/validate',
      c
    );
    assert.equal(resp.status, 200);
    assert.equal(resp.data.result.valid, false, `Expected valid=false for ${c.platform}`);
    assert.equal(resp.data.result.status, 'NOT_FOUND', `Expected NOT_FOUND for ${c.platform}`);
    assert.ok(resp.data.result.error && resp.data.result.error.length > 0);
  }
});

test('T2-F1-04: 401/403/login-wall/challenge responses classify as AUTH_REQUIRED or BLOCKED', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  env.mocks.instagram.set('ig_t2_auth_wall', {
    id: '2001',
    nickname: 'IG Auth',
    avatarUrl: '',
    requireCookie: true,
  });
  env.mocks.facebook.set('fb_t2_login_wall', {
    id: '2002',
    nickname: 'FB Auth',
    avatarUrl: '',
    blockMode: 'login_wall',
  });
  env.mocks.x.set('x_t2_blk_403', {
    id: '2003',
    nickname: 'X Blocked',
    avatarUrl: '',
    blockMode: '403',
  });
  env.mocks.tiktok.set('tt_t2_challenge', {
    id: '2004',
    nickname: 'TT Challenge',
    avatarUrl: '',
    blockMode: 'challenge',
  });

  const igResp = await env.apiJson<{ ok: boolean; result: ContractUserValidationResult }>(
    'POST',
    '/api/user/validate',
    { target: '@ig_t2_auth_wall', platform: 'INSTAGRAM' }
  );
  assert.equal(igResp.data.result.valid, false);
  assert.ok(['AUTH_REQUIRED', 'BLOCKED'].includes(igResp.data.result.status || ''), `IG got ${igResp.data.result.status}`);

  const fbResp = await env.apiJson<{ ok: boolean; result: ContractUserValidationResult }>(
    'POST',
    '/api/user/validate',
    { target: '@fb_t2_login_wall', platform: 'FACEBOOK' }
  );
  assert.equal(fbResp.data.result.valid, false);
  assert.ok(['AUTH_REQUIRED', 'BLOCKED'].includes(fbResp.data.result.status || ''), `FB got ${fbResp.data.result.status}`);

  const xResp = await env.apiJson<{ ok: boolean; result: ContractUserValidationResult }>(
    'POST',
    '/api/user/validate',
    { target: '@x_t2_blk_403', platform: 'X' }
  );
  assert.equal(xResp.data.result.valid, false);
  assert.ok(['AUTH_REQUIRED', 'BLOCKED'].includes(xResp.data.result.status || ''), `X got ${xResp.data.result.status}`);

  const ttResp = await env.apiJson<{ ok: boolean; result: ContractUserValidationResult }>(
    'POST',
    '/api/user/validate',
    { target: '@tt_t2_challenge', platform: 'TIKTOK' }
  );
  assert.equal(ttResp.data.result.valid, false);
  assert.ok(['AUTH_REQUIRED', 'BLOCKED'].includes(ttResp.data.result.status || ''), `TT got ${ttResp.data.result.status}`);
});

test('T2-F1-05: anonymous: true forces guest mode even when workspace and envCookies exist', async (t) => {
  const env = await createR1R2TestEnv({
    envCookies: {
      instagram: 'sessionid=env_ig_secret; ds_user_id=9',
    },
  });
  t.after(() => env.cleanup());

  env.mocks.instagram.set('ig_t2_anon_override', {
    id: '2005',
    nickname: 'IG Anon',
    avatarUrl: 'https://cdn.example.test/ig_anon.jpg',
    requireCookie: true,
  });

  await env.apiJson('PUT', '/api/workspace-state', {
    rules: [],
    servers: [],
    alerts: [],
    scannerSettings: {
      cookies: { tiktok: '', instagram: 'sessionid=ws_ig_secret; ds_user_id=8', facebook: '', x: '' },
      pollIntervalSeconds: 30,
      deduplicateLive: true,
    },
  });

  const resp = await env.apiJson<{ ok: boolean; result: ContractUserValidationResult }>(
    'POST',
    '/api/user/validate',
    { target: '@ig_t2_anon_override', platform: 'INSTAGRAM', anonymous: true }
  );

  assert.equal(resp.status, 200);
  assert.equal(resp.data.result.authMode, 'anonymous');
  assert.equal(resp.data.result.valid, false);
  assert.ok(['AUTH_REQUIRED', 'BLOCKED'].includes(resp.data.result.status || ''));
  assert.equal(
    env.recordedRequests.some((r) => Boolean(r.headers.cookie)),
    false,
    'anonymous: true must not send Cookie header upstream'
  );
});

test('T2-F1-06: Upstream network rejection returns structured valid=false ERROR without 500 crash', async (t) => {
  const env = await createR1R2TestEnv({
    customHandler: (req) => {
      if (req.hostname.includes('instagram.com')) {
        return Promise.reject(new Error('ECONNRESET simulated upstream failure')) as unknown as Response;
      }
      return undefined;
    },
  });
  t.after(() => env.cleanup());

  const resp = await env.apiJson<{ ok: boolean; result: ContractUserValidationResult }>(
    'POST',
    '/api/user/validate',
    { target: '@ig_t2_neterr', platform: 'INSTAGRAM' }
  );

  assert.equal(resp.status, 200);
  assert.equal(resp.data.ok, true);
  assert.equal(resp.data.result.valid, false);
  assert.equal(resp.data.result.status, 'ERROR');
  assert.ok(resp.data.result.error);
});

// ============================================================================
// Feature 2: R1 Workspace State & targetProfiles Boundary Cases (5 tests)
// ============================================================================

test('T2-F2-01: Malformed PUT /api/workspace-state payloads return 400 validation errors', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  const badPayloads = [
    [],
    { rules: 'not_an_array' },
    { servers: 42 },
    { alerts: { bad: true } },
  ];

  for (const payload of badPayloads) {
    const resp = await env.apiJson<{ ok: boolean; error: string }>('PUT', '/api/workspace-state', payload);
    assert.equal(resp.status, 400);
    assert.equal(resp.data.ok, false);
    assert.ok(resp.data.error);
  }
});

test('T2-F2-02: PUT /api/workspace-state clamps extreme poll and platform intervals safely', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  const putResp = await env.apiJson<{ ok: boolean; state: ContractWorkspaceState }>(
    'PUT',
    '/api/workspace-state',
    {
      rules: [],
      servers: [],
      alerts: [],
      scannerSettings: {
        cookies: { tiktok: 'tt1', instagram: '', facebook: '', x: '' },
        pollIntervalSeconds: 2,
        deduplicateLive: true,
        platforms: {
          instagram: {
            liveEnabled: true,
            postEnabled: true,
            storyEnabled: true,
            liveIntervalSeconds: -10,
            postIntervalSeconds: 1,
            storyIntervalSeconds: 0,
          },
        },
      },
    }
  );

  assert.equal(putResp.status, 200);
  assert.ok(putResp.data.state.scannerSettings.pollIntervalSeconds >= 10);
  assert.ok((putResp.data.state.scannerSettings.platforms?.instagram.liveIntervalSeconds ?? 0) >= 5);
  assert.ok((putResp.data.state.scannerSettings.platforms?.instagram.postIntervalSeconds ?? 0) >= 5);
  assert.ok((putResp.data.state.scannerSettings.platforms?.instagram.storyIntervalSeconds ?? 0) >= 5);
  assert.equal(putResp.data.state.scannerSettings.cookies.tiktok, 'tt1');
});

test('T2-F2-03: PUT /api/workspace-state rejects non-object targetProfiles with 400 without corrupting state', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  const resp = await env.apiJson<{ ok: boolean; error: string }>(
    'PUT',
    '/api/workspace-state',
    {
      rules: [],
      servers: [],
      alerts: [],
      targetProfiles: ['invalid-array'],
    }
  );

  assert.equal(resp.status, 400);
  assert.equal(resp.data.ok, false);
  assert.ok(resp.data.error);
});

test('T2-F2-04: PUT /api/workspace-state keeps KeywordRuleItem clean when targetProfiles is empty', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  const rule = makeRule({ id: 'r_clean', keyword: '@u_clean', platform: 'reddit' });
  const resp = await env.apiJson<{ ok: boolean; state: ContractWorkspaceState }>(
    'PUT',
    '/api/workspace-state',
    {
      rules: [rule],
      servers: [],
      alerts: [],
      targetProfiles: {},
    }
  );

  assert.equal(resp.status, 200);
  assert.deepEqual(resp.data.state.rules[0], rule);
});

test('T2-F2-05: GET /api/workspace-state on fresh temp dataDir returns { ok: true, state: null }', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  const resp = await env.apiJson<{ ok: boolean; state: ContractWorkspaceState | null }>('GET', '/api/workspace-state');
  assert.equal(resp.status, 200);
  assert.equal(resp.data.ok, true);
  assert.equal(resp.data.state, null);
});

// ============================================================================
// Feature 3: R2 Collector Boundary & Corner Cases (6 tests)
// ============================================================================

test('T2-F3-01: XStoryCollector exposes supported=false and returns UNSUPPORTED without throwing', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  const mod = await loadContractModule<{
    XStoryCollector: new (opts?: { cookie?: string }) => ContractPlatformCollector;
  }>('server/watchers/collectors/xStory.ts');
  const collector = new mod.XStoryCollector();

  assert.equal(collector.supported, false);
  const events = await collector.fetch('x_any_user');
  assert.deepEqual(events, []);

  if (collector.fetchWithDiagnostics) {
    const diag = await collector.fetchWithDiagnostics('x_any_user');
    assert.equal(diag.status, 'UNSUPPORTED');
    assert.deepEqual(diag.events, []);
  }
  assert.equal(env.recordedRequests.length, 0, 'XStoryCollector must not issue unnecessary network calls');
});

test('T2-F3-02: InstagramPostCollector and InstagramStoryCollector report AUTH_REQUIRED on 401', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  env.mocks.instagram.set('ig_t2_col_401', {
    id: '2101',
    nickname: 'IG 401',
    avatarUrl: 'https://cdn.example.test/ig401.jpg',
    requireCookie: true,
    posts: [{ id: 'p1', title: 'Secret' }],
    stories: [{ id: 's1', title: 'Secret Story' }],
  });

  const postMod = await loadContractModule<{
    InstagramPostCollector: new (opts?: { cookie?: string }) => ContractPlatformCollector;
  }>('server/watchers/collectors/instagramPost.ts');
  const storyMod = await loadContractModule<{
    InstagramStoryCollector: new (opts?: { cookie?: string }) => ContractPlatformCollector;
  }>('server/watchers/collectors/instagramStory.ts');

  const postCol = new postMod.InstagramPostCollector();
  const storyCol = new storyMod.InstagramStoryCollector();

  assert.ok(postCol.fetchWithDiagnostics, 'Expected fetchWithDiagnostics on InstagramPostCollector');
  assert.ok(storyCol.fetchWithDiagnostics, 'Expected fetchWithDiagnostics on InstagramStoryCollector');

  const postDiag: ContractCollectorFetchResult = await postCol.fetchWithDiagnostics!('ig_t2_col_401');
  assert.ok(['AUTH_REQUIRED', 'BLOCKED'].includes(postDiag.status));
  assert.deepEqual(postDiag.events, []);

  const storyDiag: ContractCollectorFetchResult = await storyCol.fetchWithDiagnostics!('ig_t2_col_401');
  assert.ok(['AUTH_REQUIRED', 'BLOCKED'].includes(storyDiag.status));
  assert.deepEqual(storyDiag.events, []);
});

test('T2-F3-03: FacebookPostCollector and FacebookStoryCollector detect login_form as AUTH_REQUIRED/BLOCKED', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  env.mocks.facebook.set('fb_t2_col_wall', {
    id: '2102',
    nickname: 'FB Wall',
    avatarUrl: '',
    blockMode: 'login_wall',
  });

  const postMod = await loadContractModule<{
    FacebookPostCollector: new (opts?: { cookie?: string }) => ContractPlatformCollector;
  }>('server/watchers/collectors/facebookPost.ts');
  const storyMod = await loadContractModule<{
    FacebookStoryCollector: new (opts?: { cookie?: string }) => ContractPlatformCollector;
  }>('server/watchers/collectors/facebookStory.ts');

  const postCol = new postMod.FacebookPostCollector();
  const storyCol = new storyMod.FacebookStoryCollector();

  const postDiag = await postCol.fetchWithDiagnostics!('fb_t2_col_wall');
  assert.ok(['AUTH_REQUIRED', 'BLOCKED'].includes(postDiag.status));
  assert.deepEqual(postDiag.events, []);

  const storyDiag = await storyCol.fetchWithDiagnostics!('fb_t2_col_wall');
  assert.ok(['AUTH_REQUIRED', 'BLOCKED'].includes(storyDiag.status));
  assert.deepEqual(storyDiag.events, []);
});

test('T2-F3-04: XPostCollector distinguishes NOT_FOUND (404) and RATE_LIMITED/BLOCKED (429)', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  env.mocks.x.set('x_t2_429', {
    id: '2103',
    nickname: 'X 429',
    avatarUrl: '',
    blockMode: '429',
  });

  const mod = await loadContractModule<{
    XPostCollector: new (opts?: { cookie?: string }) => ContractPlatformCollector;
  }>('server/watchers/collectors/xPost.ts');
  const col = new mod.XPostCollector();

  const notFoundDiag = await col.fetchWithDiagnostics!('x_t2_nonexistent_404');
  assert.equal(notFoundDiag.status, 'NOT_FOUND');
  assert.deepEqual(notFoundDiag.events, []);

  const rateLimitDiag = await col.fetchWithDiagnostics!('x_t2_429');
  assert.ok(['RATE_LIMITED', 'BLOCKED', 'AUTH_REQUIRED'].includes(rateLimitDiag.status));
  assert.deepEqual(rateLimitDiag.events, []);
});

test('T2-F3-05: Collectors survive malformed/corrupted upstream HTML/JSON without throwing', async (t) => {
  let corruptStatus = 200;
  const env = await createR1R2TestEnv({
    customHandler: () =>
      new Response('<<<CORRUPTED_NOT_JSON_OR_VALID_HTML>>><script type="application/json">{broken</script>', {
        status: corruptStatus,
      }),
  });
  t.after(() => env.cleanup());

  const igMod = await loadContractModule<{
    InstagramPostCollector: new () => ContractPlatformCollector;
  }>('server/watchers/collectors/instagramPost.ts');
  const fbMod = await loadContractModule<{
    FacebookPostCollector: new () => ContractPlatformCollector;
  }>('server/watchers/collectors/facebookPost.ts');

  const igRes = await new igMod.InstagramPostCollector().fetchWithDiagnostics!('ig_t2_corrupt');
  assert.notEqual(igRes.status, 'OK');
  assert.deepEqual(igRes.events, []);

  // HTTP 200 unparseable HTML shell: FacebookPostCollector returns empty OK without throwing
  const fbRes = await new fbMod.FacebookPostCollector().fetchWithDiagnostics!('fb_t2_corrupt');
  assert.equal(fbRes.status, 'OK');
  assert.deepEqual(fbRes.events, []);

  // HTTP 502 corrupted response: FacebookPostCollector classifies as ERROR without throwing
  corruptStatus = 502;
  const fbErrRes = await new fbMod.FacebookPostCollector().fetchWithDiagnostics!('fb_t2_corrupt_502');
  assert.notEqual(fbErrRes.status, 'OK');
  assert.equal(fbErrRes.status, 'ERROR');
  assert.deepEqual(fbErrRes.events, []);
});

test('T2-F3-06: Collector setCookie("") clears cookie so subsequent fetches omit Cookie header', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  env.mocks.facebook.set('fb_t2_clear_ck', {
    id: '2105',
    nickname: 'FB Clear',
    avatarUrl: 'https://cdn.example.test/fb.jpg',
    posts: [{ id: 'p_clear_1', title: 'Public FB Post', videoUrl: 'https://cdn.example.test/p_clear.mp4' }],
  });

  const mod = await loadContractModule<{
    FacebookPostCollector: new (opts?: { cookie?: string }) => ContractPlatformCollector;
  }>('server/watchers/collectors/facebookPost.ts');
  const col = new mod.FacebookPostCollector({ cookie: 'c_user=999; xs=secret_abc' });

  await col.fetch('fb_t2_clear_ck');
  assert.ok(env.recordedRequests.some((r) => r.headers.cookie?.includes('xs=secret_abc')));

  env.clearRecordedRequests();
  col.setCookie?.('');
  await col.fetch('fb_t2_clear_ck');
  assert.equal(
    env.recordedRequests.some((r) => Boolean(r.headers.cookie)),
    false,
    'After setCookie(""), upstream requests must not carry Cookie header'
  );
});

// ============================================================================
// Feature 4: R2 Watcher Boundary & Corner Cases (5 tests)
// ============================================================================

test('T2-F4-01: X Story UNSUPPORTED across 10 watcher cycles logs 0 errors and 0 failure alerts', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  env.mocks.x.set('x_t2_story_unsup', {
    id: '2201',
    nickname: 'X Story Target',
    avatarUrl: 'https://pbs.twimg.com/profile_images/4/xst_normal.jpg',
  });

  await env.apiJson('PUT', '/api/workspace-state', {
    rules: [makeRule({ id: 'r_x_st', keyword: '@x_t2_story_unsup', platform: 'bluesky', sourceDomain: 'x.com' })],
    servers: [makeSandboxServer()],
    alerts: [],
  });

  for (let i = 0; i < 10; i++) {
    await env.triggerWatcherCycle('story');
  }

  const statusResp = await env.apiJson<ContractWatcherStatusResponse>('GET', '/api/watcher/status');
  assert.equal(statusResp.status, 200);

  const diagnostics = Array.isArray(statusResp.data.diagnostics) ? statusResp.data.diagnostics : [];
  const xStoryDiag = diagnostics.find(
    (d) => d.platform === 'X' && d.eventType === 'story' && d.status === 'UNSUPPORTED'
  );
  const xStoryHealthEntries = Object.values(statusResp.data.health || {}).filter(
    (h) => h.collectorName.toLowerCase().includes('x') && h.collectorName.toLowerCase().includes('story')
  );

  assert.ok(
    Boolean(xStoryDiag) || xStoryHealthEntries.length > 0,
    'Expected /api/watcher/status to record an executed X story entry in diagnostics or health'
  );
  if (diagnostics.length > 0 || xStoryHealthEntries.length === 0) {
    assert.ok(xStoryDiag, 'Expected diagnostics to include X story UNSUPPORTED entry');
  }
  for (const health of xStoryHealthEntries) {
    assert.equal(health.consecutiveErrors, 0, 'UNSUPPORTED X story must not increment consecutiveErrors');
  }

  const sandboxLogs = await env.apiJson<{ receipts: Array<{ payload: Record<string, unknown> }> }>(
    'GET',
    '/api/webhook-sandbox/logs'
  );
  const alerts = sandboxLogs.data.receipts.filter(
    (r) => r.payload?.alert_type === 'COLLECTOR_FAILURE_THRESHOLD'
  );
  assert.equal(alerts.length, 0, 'UNSUPPORTED X story must never fire COLLECTOR_FAILURE_THRESHOLD alerts');
});

test('T2-F4-02: Login-wall on one target isolates failure while healthy target succeeds in same cycle', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  env.mocks.instagram.set('ig_t2_walled_iso', {
    id: '2202',
    nickname: 'IG Walled',
    avatarUrl: 'https://cdn.example.test/walled.jpg',
    requireCookie: true,
    stories: [{ id: 'walled_st', title: 'Hidden' }],
  });
  env.mocks.instagram.set('ig_t2_healthy_iso', {
    id: '2203',
    nickname: 'IG Healthy',
    avatarUrl: 'https://cdn.example.test/healthy.jpg',
    stories: [{ id: 'healthy_st_1', title: 'Public Story', videoUrl: 'https://cdn.example.test/healthy_st_1.mp4' }],
  });

  await env.apiJson('PUT', '/api/workspace-state', {
    rules: [
      makeRule({
        id: 'r_ig_iso',
        keyword: '@ig_t2_walled_iso, @ig_t2_healthy_iso',
        platform: 'hackernews',
        sourceDomain: 'instagram.com',
      }),
    ],
    servers: [],
    alerts: [],
  });

  await env.triggerWatcherCycle('story');

  const mediaResp = await env.apiJson<{ ok: boolean; count: number; media: Array<{ fileName: string }> }>(
    'GET',
    '/api/media/downloaded'
  );
  assert.equal(mediaResp.data.count, 1, 'Healthy target story must still download despite sibling 401');
  assert.ok(mediaResp.data.media[0].fileName.includes('healthy_st_1'));
});

test('T2-F4-03: PUT /api/workspace-state clearing cookies to "" resets watcher to guest mode across all 4 platforms', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  env.mocks.tiktok.set('tt_t2_guest', { id: '2301', nickname: 'TT G', avatarUrl: 'https://cdn.example.test/a.jpg' });
  env.mocks.instagram.set('ig_t2_guest', { id: '2302', nickname: 'IG G', avatarUrl: 'https://cdn.example.test/b.jpg' });
  env.mocks.facebook.set('fb_t2_guest', { id: '2303', nickname: 'FB G', avatarUrl: 'https://cdn.example.test/c.jpg' });
  env.mocks.x.set('x_t2_guest', { id: '2304', nickname: 'X G', avatarUrl: 'https://pbs.twimg.com/profile_images/5/xg_normal.jpg' });

  const rules = [
    makeRule({ id: 'r_tt', keyword: '@tt_t2_guest', platform: 'reddit', sourceDomain: 'tiktok.com' }),
    makeRule({ id: 'r_ig', keyword: '@ig_t2_guest', platform: 'hackernews', sourceDomain: 'instagram.com' }),
    makeRule({ id: 'r_fb', keyword: '@fb_t2_guest', platform: 'github', sourceDomain: 'facebook.com' }),
    makeRule({ id: 'r_x', keyword: '@x_t2_guest', platform: 'bluesky', sourceDomain: 'x.com' }),
  ];

  // Step 1: Set cookies on all 4 platforms
  await env.apiJson('PUT', '/api/workspace-state', {
    rules,
    servers: [],
    alerts: [],
    scannerSettings: {
      cookies: {
        tiktok: 'sessionid=tt_old',
        instagram: 'sessionid=ig_old; ds_user_id=1',
        facebook: 'c_user=1; xs=fb_old',
        x: 'auth_token=x_old; ct0=ct0_old',
      },
      pollIntervalSeconds: 30,
      deduplicateLive: true,
    },
  });

  await env.triggerWatcherCycle('post');
  assert.ok(env.recordedRequests.some((r) => r.headers.cookie?.includes('tt_old')));
  assert.ok(env.recordedRequests.some((r) => r.headers.cookie?.includes('ig_old')));
  assert.ok(env.recordedRequests.some((r) => r.headers.cookie?.includes('fb_old')));
  assert.ok(env.recordedRequests.some((r) => r.headers.cookie?.includes('x_old')));

  // Step 2: Clear all cookies to ""
  env.clearRecordedRequests();
  await env.apiJson('PUT', '/api/workspace-state', {
    rules,
    servers: [],
    alerts: [],
    scannerSettings: {
      cookies: { tiktok: '', instagram: '', facebook: '', x: '' },
      pollIntervalSeconds: 30,
      deduplicateLive: true,
    },
  });

  await env.triggerWatcherCycle('post');
  assert.equal(
    env.recordedRequests.some((r) => Boolean(r.headers.cookie)),
    false,
    'Cleared cookies ("") must propagate to all 4 platform watchers with 0 Cookie headers sent'
  );
});

test('T2-F4-04: Disabled rules (enabled: false) are excluded from watcher cycles', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  env.mocks.instagram.set('ig_t2_disabled_rule', {
    id: '2401',
    nickname: 'IG Disabled',
    avatarUrl: 'https://cdn.example.test/ig_dis.jpg',
    stories: [{ id: 'st_dis_1', title: 'Should not scan', videoUrl: 'https://cdn.example.test/dis.mp4' }],
  });
  env.mocks.instagram.set('ig_t2_enabled_control', {
    id: '2402',
    nickname: 'IG Enabled Control',
    avatarUrl: 'https://cdn.example.test/ig_en.jpg',
    stories: [{ id: 'st_en_1', title: 'Should scan', videoUrl: 'https://cdn.example.test/en.mp4' }],
  });

  await env.apiJson('PUT', '/api/workspace-state', {
    rules: [
      makeRule({
        id: 'r_dis',
        keyword: '@ig_t2_disabled_rule',
        platform: 'hackernews',
        sourceDomain: 'instagram.com',
        enabled: false,
      }),
      makeRule({
        id: 'r_en_ctrl',
        keyword: '@ig_t2_enabled_control',
        platform: 'hackernews',
        sourceDomain: 'instagram.com',
        enabled: true,
      }),
    ],
    servers: [],
    alerts: [],
  });

  await env.triggerWatcherCycle('story');

  const enabledReqs = env.recordedRequests.filter(
    (r) =>
      r.hostname.includes('instagram.com') &&
      (r.url.includes('ig_t2_enabled_control') || r.url.includes('2402'))
  );
  const disabledReqs = env.recordedRequests.filter(
    (r) => r.url.includes('ig_t2_disabled_rule') || r.url.includes('2401')
  );
  assert.ok(enabledReqs.length > 0, 'Enabled sibling Instagram rule must be fetched during watcher cycle');
  assert.equal(disabledReqs.length, 0, 'Disabled rule must not trigger collector fetches');
});

test('T2-F4-05: WatcherStateStore recordFailure respects alert threshold and cooldown suppression', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  const store = createWatcherStateStore(path.join(env.tempDir, 'health-boundary.json'));
  const threshold = 3;
  const cooldownMs = 60000;

  const r1 = await store.recordFailure('instagram_post', 'HTTP 500', threshold, cooldownMs);
  const r2 = await store.recordFailure('instagram_post', 'HTTP 500', threshold, cooldownMs);
  const r3 = await store.recordFailure('instagram_post', 'HTTP 500', threshold, cooldownMs);
  const r4 = await store.recordFailure('instagram_post', 'HTTP 500', threshold, cooldownMs);

  assert.equal(r1.triggerAlert, false);
  assert.equal(r2.triggerAlert, false);
  assert.equal(r3.triggerAlert, true);
  assert.equal(r3.consecutiveErrors, 3);
  assert.equal(r4.triggerAlert, false, 'Immediate 4th error must be suppressed by cooldown');
  await store.flush();
});

// ============================================================================
// Feature 5: R2 Media, Storage & Notifier Boundary Cases (5 tests)
// ============================================================================

test('T2-F5-01: Non-TikTok MediaDownloader never invokes TikWM even without metadata media URLs', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  const nonTikTokEvents: ContractWatcherEvent[] = [
    {
      platform: 'INSTAGRAM',
      username: 'ig_notikwm',
      eventType: 'post',
      itemId: 'ig_nt_1',
      url: 'https://www.instagram.com/p/ig_nt_1/',
      title: 'IG No Metadata',
      thumbnailUrl: 'https://cdn.example.test/ig_thumb.jpg',
      detectedAt: new Date().toISOString(),
    },
    {
      platform: 'FACEBOOK',
      username: 'fb_notikwm',
      eventType: 'post',
      itemId: 'fb_nt_1',
      url: 'https://www.facebook.com/fb_notikwm/posts/1',
      title: 'FB No URLs',
      detectedAt: new Date().toISOString(),
    },
    {
      platform: 'X',
      username: 'x_notikwm',
      eventType: 'post',
      itemId: 'x_nt_1',
      url: 'https://x.com/x_notikwm/status/1',
      title: 'X No URLs',
      detectedAt: new Date().toISOString(),
    },
  ];

  const downloader = createMediaDownloader({ storageRoot: env.mediaDir, timeoutMs: 5000 });
  for (const evt of nonTikTokEvents) {
    await resolveHighQualityMedia(asTikTokEvent(evt), 3000);
    const res = await downloader.downloadEventMedia(asTikTokEvent(evt));
    if (evt.platform === 'INSTAGRAM') {
      assert.equal(res.success, true, 'Expected INSTAGRAM thumbnail fallback to download cleanly');
      assert.equal(res.files.length, 1);
    } else {
      assert.equal(res.success, false);
      assert.ok(res.error);
    }
  }

  const tikwmCalls = env.recordedRequests.filter((r) => r.hostname.includes('tikwm.com'));
  assert.equal(tikwmCalls.length, 0, 'Non-TikTok events must NEVER call tikwm.com');
});

test('T2-F5-02: CDN 403 and 0-byte responses fail cleanly and leave zero .tmp files', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  env.mocks.cdnAssets.set('https://cdn.example.test/forbidden_403.mp4', {
    status: 403,
    contentType: 'text/plain',
    body: 'Forbidden',
  });
  env.mocks.cdnAssets.set('https://cdn.example.test/empty_0byte.mp4', {
    status: 200,
    contentType: 'video/mp4',
    body: Buffer.alloc(0),
  });

  const downloader = createMediaDownloader({ storageRoot: env.mediaDir, timeoutMs: 5000 });

  const r403 = await downloader.downloadEventMedia(
    asTikTokEvent({
      platform: 'INSTAGRAM',
      username: 'ig_err_cdn',
      eventType: 'post',
      itemId: 'err_403',
      url: 'https://www.instagram.com/p/err_403/',
      title: '403 Test',
      detectedAt: new Date().toISOString(),
      metadata: { videoUrl: 'https://cdn.example.test/forbidden_403.mp4' },
    })
  );
  assert.equal(r403.success, false);
  assert.equal(r403.files.length, 0);
  assert.ok(r403.error);

  const rEmpty = await downloader.downloadEventMedia(
    asTikTokEvent({
      platform: 'X',
      username: 'x_err_cdn',
      eventType: 'post',
      itemId: 'err_empty',
      url: 'https://x.com/x_err_cdn/status/1',
      title: '0-byte Test',
      detectedAt: new Date().toISOString(),
      metadata: { videoUrl: 'https://cdn.example.test/empty_0byte.mp4' },
    })
  );
  assert.equal(rEmpty.success, false);
  assert.equal(rEmpty.files.length, 0);
  assert.ok(rEmpty.error);

  for (const dir of [r403.storageDir, rEmpty.storageDir]) {
    if (fs.existsSync(dir)) {
      const leftoverTmp = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
      assert.equal(leftoverTmp.length, 0, `Expected 0 .tmp files in ${dir}`);
    }
  }
});

test('T2-F5-03: TelegramService escapes HTML special chars and respects enabled=false gate', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  const localFile = path.join(env.tempDir, 'escape_test.mp4');
  fs.writeFileSync(localFile, Buffer.from('BYTES'));

  const disabledTg = createTelegramService({ botToken: 'tok_1', chatId: '-100123', enabled: false });
  const disabledRes = await disabledTg.uploadFile({
    localFilePath: localFile,
    fileName: 'escape_test.mp4',
    fileSize: 5,
    mimeType: 'video/mp4',
    username: 'tg_escape',
    eventType: 'post',
    platform: 'X',
  } as unknown as StorageUploadParams);

  assert.equal(disabledRes.success, false);
  assert.equal(
    env.recordedRequests.filter((r) => r.hostname === 'api.telegram.org').length,
    0,
    'Disabled TelegramService must not call api.telegram.org'
  );

  const enabledTg = createTelegramService({ botToken: 'tok_1', chatId: '-100123', enabled: true });
  const uploadParams: ContractStorageUploadParams = {
    localFilePath: localFile,
    fileName: 'escape_test.mp4',
    fileSize: 5,
    mimeType: 'video/mp4',
    username: 'tg_escape',
    eventType: 'post',
    platform: 'X',
    title: 'Breaking <script>alert(1)</script> & 100% > 50%',
    sourceUrl: 'https://x.com/tg_escape/status/1?a=1&b=2',
  };
  const enabledRes = await enabledTg.uploadFile(uploadParams as unknown as StorageUploadParams);
  assert.equal(enabledRes.success, true);

  const tgReq = env.recordedRequests.find((r) => r.hostname === 'api.telegram.org');
  assert.ok(tgReq);
  const caption = tgReq.formFields?.caption || '';
  assert.ok(!caption.includes('<script>'), 'Raw <script> tag must be escaped in HTML caption');
  assert.ok(caption.includes('&lt;script&gt;'), 'Expected &lt;script&gt; in caption');
  assert.ok(caption.includes('&amp;'), 'Expected &amp; in caption');
});

test('T2-F5-04: MediaDownloader sends platform Referer and metadata.downloadHeaders to CDN', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  const downloader = createMediaDownloader({ storageRoot: env.mediaDir, timeoutMs: 5000 });
  const cases = [
    { platform: 'INSTAGRAM' as const, expectedRef: 'instagram.com', url: 'https://cdn.example.test/ref_ig.mp4' },
    { platform: 'FACEBOOK' as const, expectedRef: 'facebook.com', url: 'https://cdn.example.test/ref_fb.mp4' },
    { platform: 'X' as const, expectedRef: 'x.com', url: 'https://cdn.example.test/ref_x.mp4' },
  ];

  for (const c of cases) {
    env.clearRecordedRequests();
    const res = await downloader.downloadEventMedia(
      asTikTokEvent({
        platform: c.platform,
        username: `ref_${c.platform.toLowerCase()}`,
        eventType: 'post',
        itemId: `ref_${c.platform}`,
        url: `https://${c.expectedRef}/item/1`,
        title: 'Referer Check',
        detectedAt: new Date().toISOString(),
        metadata: {
          videoUrl: c.url,
          downloadHeaders: { 'X-Custom-CDN': `hdr-${c.platform}` },
        },
      })
    );
    assert.equal(res.success, true);
    const cdnReq = env.recordedRequests.find((r) => r.url === c.url);
    assert.ok(cdnReq, `Expected CDN fetch to ${c.url}`);
    assert.ok(
      cdnReq.headers.referer?.includes(c.expectedRef),
      `Expected ${c.platform} Referer to include ${c.expectedRef}, got ${cdnReq.headers.referer}`
    );
    assert.equal(cdnReq.headers['x-custom-cdn'], `hdr-${c.platform}`);
  }
});

test('T2-F5-05: Notifier does not retry HTTP 400, retries 500, and survives onPendingNotification error', async (t) => {
  let attempts400 = 0;
  let attempts500 = 0;
  let mode: '400' | '500' = '400';

  const srv = await startLocalHttpServer((_req, _body, res) => {
    if (mode === '400') {
      attempts400 += 1;
      res.writeHead(400);
      res.end('Bad Request');
      return;
    }
    attempts500 += 1;
    if (attempts500 < 3) {
      res.writeHead(500);
      res.end('Server Error');
    } else {
      res.writeHead(200);
      res.end('OK');
    }
  });
  t.after(() => srv.close());

  const notifier = new Notifier({
    webhookUrl: `${srv.url}/hook`,
    retryDelaysMs: [5, 5],
    onPendingNotification: async () => {
      throw new Error('Simulated pending queue failure');
    },
  });

  const evt: ContractWatcherEvent = {
    platform: 'INSTAGRAM',
    username: 'ig_retry',
    eventType: 'post',
    itemId: 'retry_1',
    url: 'https://www.instagram.com/p/retry_1/',
    title: 'Retry Test',
    detectedAt: new Date().toISOString(),
  };

  mode = '400';
  const r400 = await notifier.notify(asTikTokEvent(evt));
  assert.equal(r400.status, 'failed');
  assert.equal(r400.attempts, 1, '4xx must not retry');
  assert.equal(attempts400, 1);

  mode = '500';
  const r500 = await notifier.notify(asTikTokEvent(evt));
  assert.equal(r500.status, 'delivered');
  assert.equal(r500.attempts, 3, '5xx must retry until delivered');
});
