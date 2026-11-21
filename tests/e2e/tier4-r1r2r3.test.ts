import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  createR1R2TestEnv,
  makeRule,
  makeSandboxServer,
  type ContractUserValidationResult,
  type ContractWatcherStatusResponse,
  type ContractWorkspaceState,
} from './r1r2r3Harness.ts';
import type { PendingDeviceNotification } from '../../server/watchers/types';

test('T4-01: Multi-Platform Creator Onboarding -> Avatar Persistence -> Post/Story Auto-Archive & /api/media/* Streaming', async (t) => {
  const env = await createR1R2TestEnv({
    telegram: { botToken: 't4_bot_token', chatId: '-1004484723209', enabled: true },
  });
  t.after(() => env.cleanup());

  const payloads = {
    ttStory: Buffer.from('T4_TT_STORY_BYTES'),
    igPost: Buffer.from('T4_IG_POST_BYTES'),
    igStory: Buffer.from('T4_IG_STORY_BYTES'),
    fbStory: Buffer.from('T4_FB_STORY_BYTES'),
    xPost: Buffer.from('T4_X_POST_BYTES'),
  };

  env.mocks.cdnAssets.set('https://cdn.example.test/t4_tt_st1.mp4', { status: 200, contentType: 'video/mp4', body: payloads.ttStory });
  env.mocks.cdnAssets.set('https://cdn.example.test/t4_ig_p2.mp4', { status: 200, contentType: 'video/mp4', body: payloads.igPost });
  env.mocks.cdnAssets.set('https://cdn.example.test/t4_ig_st1.mp4', { status: 200, contentType: 'video/mp4', body: payloads.igStory });
  env.mocks.cdnAssets.set('https://cdn.example.test/t4_fb_st1.mp4', { status: 200, contentType: 'video/mp4', body: payloads.fbStory });
  env.mocks.cdnAssets.set('https://cdn.example.test/t4_x_p2.mp4', { status: 200, contentType: 'video/mp4', body: payloads.xPost });

  env.mocks.tiktok.set('tt_t4_idol', {
    id: '4001',
    nickname: 'TT Idol',
    avatarUrl: 'https://cdn.example.test/av_tt.jpg',
    posts: [{ id: 'tt_base', title: 'TT Base', videoUrl: 'https://cdn.example.test/tt_base.mp4' }],
    stories: [{ id: 't4_tt_st1', title: 'TT Story', videoUrl: 'https://cdn.example.test/t4_tt_st1.mp4' }],
  });
  env.mocks.instagram.set('ig_t4_idol', {
    id: '4002',
    nickname: 'IG Idol',
    avatarUrl: 'https://cdn.example.test/av_ig.jpg',
    requireCookie: true,
    posts: [{ id: 'ig_base', title: 'IG Base', videoUrl: 'https://cdn.example.test/ig_base.mp4' }],
    stories: [{ id: 't4_ig_st1', title: 'IG Story', videoUrl: 'https://cdn.example.test/t4_ig_st1.mp4' }],
  });
  env.mocks.facebook.set('fb_t4_idol', {
    id: '4003',
    nickname: 'FB Idol',
    avatarUrl: 'https://cdn.example.test/av_fb.jpg',
    requireCookie: true,
    posts: [{ id: 'fb_base', title: 'FB Base', videoUrl: 'https://cdn.example.test/fb_base.mp4' }],
    stories: [{ id: 't4_fb_st1', title: 'FB Story', videoUrl: 'https://cdn.example.test/t4_fb_st1.mp4' }],
  });
  env.mocks.x.set('x_t4_idol', {
    id: '4004',
    nickname: 'X Idol',
    avatarUrl: 'https://pbs.twimg.com/profile_images/4004/idol_normal.jpg',
    requireCookie: true,
    posts: [{ id: 'x_base', title: 'X Base', videoUrl: 'https://cdn.example.test/x_base.mp4' }],
  });

  const cookies = {
    tiktok: '',
    instagram: 'sessionid=ig_t4_ck; ds_user_id=4002',
    facebook: 'c_user=4003; xs=fb_t4_ck',
    x: 'auth_token=x_t4_ck; ct0=x_t4_ct0',
  };

  // Step 1: Validate all 4 creators
  const vTT = await env.apiJson<{ ok: boolean; result: ContractUserValidationResult }>('POST', '/api/user/validate', { target: '@tt_t4_idol', platform: 'TIKTOK' });
  const vIG = await env.apiJson<{ ok: boolean; result: ContractUserValidationResult }>('POST', '/api/user/validate', { target: '@ig_t4_idol', platform: 'INSTAGRAM', cookie: cookies.instagram });
  const vFB = await env.apiJson<{ ok: boolean; result: ContractUserValidationResult }>('POST', '/api/user/validate', { target: '@fb_t4_idol', platform: 'FACEBOOK', cookie: cookies.facebook });
  const vX = await env.apiJson<{ ok: boolean; result: ContractUserValidationResult }>('POST', '/api/user/validate', { target: '@x_t4_idol', platform: 'X', cookie: cookies.x });

  for (const v of [vTT, vIG, vFB, vX]) {
    assert.equal(v.data.result.valid, true);
    assert.equal(v.data.result.status, 'VALID');
    assert.ok(v.data.result.avatarUrl);
    assert.ok(v.data.result.nickname);
  }

  // Step 2: Save rules + targetProfiles + cookies
  await env.apiJson('PUT', '/api/workspace-state', {
    rules: [
      makeRule({ id: 'r_tt', keyword: '@tt_t4_idol', platform: 'reddit', sourceDomain: 'tiktok.com' }),
      makeRule({ id: 'r_ig', keyword: '@ig_t4_idol', platform: 'hackernews', sourceDomain: 'instagram.com' }),
      makeRule({ id: 'r_fb', keyword: '@fb_t4_idol', platform: 'github', sourceDomain: 'facebook.com' }),
      makeRule({ id: 'r_x', keyword: '@x_t4_idol', platform: 'bluesky', sourceDomain: 'x.com' }),
    ],
    servers: [makeSandboxServer()],
    alerts: [],
    scannerSettings: { cookies, pollIntervalSeconds: 30, deduplicateLive: true },
    targetProfiles: {
      'TIKTOK::tt_t4_idol': { id: vTT.data.result.id, nickname: vTT.data.result.nickname, avatarUrl: vTT.data.result.avatarUrl, profileUrl: vTT.data.result.profileUrl, status: 'VALID', authMode: vTT.data.result.authMode, updatedAt: new Date().toISOString() },
      'INSTAGRAM::ig_t4_idol': { id: vIG.data.result.id, nickname: vIG.data.result.nickname, avatarUrl: vIG.data.result.avatarUrl, profileUrl: vIG.data.result.profileUrl, status: 'VALID', authMode: vIG.data.result.authMode, updatedAt: new Date().toISOString() },
      'FACEBOOK::fb_t4_idol': { id: vFB.data.result.id, nickname: vFB.data.result.nickname, avatarUrl: vFB.data.result.avatarUrl, profileUrl: vFB.data.result.profileUrl, status: 'VALID', authMode: vFB.data.result.authMode, updatedAt: new Date().toISOString() },
      'X::x_t4_idol': { id: vX.data.result.id, nickname: vX.data.result.nickname, avatarUrl: vX.data.result.avatarUrl, profileUrl: vX.data.result.profileUrl, status: 'VALID', authMode: vX.data.result.authMode, updatedAt: new Date().toISOString() },
    },
  });

  // Step 3: Warmup post cycle + immediate story cycle
  await env.triggerWatcherCycle('post');
  await env.triggerWatcherCycle('story');

  // Publish new posts on IG and X and run post cycle 2
  env.mocks.instagram.get('ig_t4_idol')!.posts!.unshift({ id: 't4_ig_p2', title: 'New IG Post', videoUrl: 'https://cdn.example.test/t4_ig_p2.mp4' });
  env.mocks.x.get('x_t4_idol')!.posts!.unshift({ id: 't4_x_p2', title: 'New X Post', videoUrl: 'https://cdn.example.test/t4_x_p2.mp4' });
  await env.triggerWatcherCycle('post');

  // Step 4: Verify persisted avatars, /api/media/* streaming, Telegram uploads, Android poll & status
  const wsGet = await env.apiJson<{ ok: boolean; state: ContractWorkspaceState }>('GET', '/api/workspace-state');
  assert.equal(Object.keys(wsGet.data.state.targetProfiles || {}).length, 4);

  const mediaResp = await env.apiJson<{ ok: boolean; count: number; media: Array<{ fileName: string; downloadUrl: string }> }>(
    'GET',
    '/api/media/downloaded'
  );
  assert.equal(mediaResp.data.count, 5, 'Expected 3 stories (TT/IG/FB) + 2 new posts (IG/X) downloaded');

  const streamedBodies = await Promise.all(
    mediaResp.data.media.map(async (m) => {
      const r = await fetch(`${env.server.url}${m.downloadUrl}`);
      assert.equal(r.status, 200);
      return Buffer.from(await r.arrayBuffer()).toString('utf-8');
    })
  );
  for (const expectedBuf of Object.values(payloads)) {
    assert.ok(streamedBodies.includes(expectedBuf.toString('utf-8')));
  }

  const poll = await env.apiJson<{ ok: boolean; notifications: PendingDeviceNotification[] }>(
    'GET',
    '/api/android/poll?deviceId=sm_n770f_default'
  );
  const notifPlatforms = new Set(poll.data.notifications.map((n) => n.platform));
  assert.ok(notifPlatforms.has('TIKTOK'));
  assert.ok(notifPlatforms.has('INSTAGRAM'));
  assert.ok(notifPlatforms.has('FACEBOOK'));
  assert.ok(notifPlatforms.has('X'));

  const tgCalls = env.recordedRequests.filter((r) => r.hostname === 'api.telegram.org');
  assert.ok(tgCalls.length >= 5, 'Expected Telegram uploads for each downloaded media file');

  const statusResp = await env.apiJson<ContractWatcherStatusResponse>('GET', '/api/watcher/status');
  assert.equal(statusResp.status, 200);
  assert.equal(statusResp.data.success, true);
});

test('T4-02: Anonymous Blocked (AUTH_REQUIRED/BLOCKED) -> User Adds Cookies -> Validation & Watcher Recovery', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  env.mocks.instagram.set('ig_t4_private_rec', {
    id: '4101',
    nickname: 'Private IG',
    avatarUrl: 'https://cdn.example.test/ig_rec.jpg',
    requireCookie: true,
    stories: [{ id: 'ig_rec_st1', title: 'Unlocked IG Story', videoUrl: 'https://cdn.example.test/ig_rec_st1.mp4' }],
  });
  env.mocks.facebook.set('fb_t4_walled_rec', {
    id: '4102',
    nickname: 'Walled FB',
    avatarUrl: 'https://cdn.example.test/fb_rec.jpg',
    requireCookie: true,
    stories: [{ id: 'fb_rec_st1', title: 'Unlocked FB Story', videoUrl: 'https://cdn.example.test/fb_rec_st1.mp4' }],
  });

  const rules = [
    makeRule({ id: 'r_ig_rec', keyword: '@ig_t4_private_rec', platform: 'hackernews', sourceDomain: 'instagram.com' }),
    makeRule({ id: 'r_fb_rec', keyword: '@fb_t4_walled_rec', platform: 'github', sourceDomain: 'facebook.com' }),
  ];

  // Step 1: Anonymous validation fails cleanly with AUTH_REQUIRED/BLOCKED
  const anonIg = await env.apiJson<{ ok: boolean; result: ContractUserValidationResult }>('POST', '/api/user/validate', { target: '@ig_t4_private_rec', platform: 'INSTAGRAM' });
  const anonFb = await env.apiJson<{ ok: boolean; result: ContractUserValidationResult }>('POST', '/api/user/validate', { target: '@fb_t4_walled_rec', platform: 'FACEBOOK' });
  assert.equal(anonIg.data.result.valid, false);
  assert.ok(['AUTH_REQUIRED', 'BLOCKED'].includes(anonIg.data.result.status || ''));
  assert.equal(anonFb.data.result.valid, false);
  assert.ok(['AUTH_REQUIRED', 'BLOCKED'].includes(anonFb.data.result.status || ''));

  // Step 2: Watcher runs anonymously -> records errors/diagnostics without crashing
  await env.apiJson('PUT', '/api/workspace-state', { rules, servers: [], alerts: [] });
  await env.triggerWatcherCycle('story');

  const mediaBefore = await env.apiJson<{ ok: boolean; count: number }>('GET', '/api/media/downloaded');
  assert.equal(mediaBefore.data.count, 0);

  // Step 3: User configures cookies via PUT /api/workspace-state
  await env.apiJson('PUT', '/api/workspace-state', {
    rules,
    servers: [],
    alerts: [],
    scannerSettings: {
      cookies: {
        tiktok: '',
        instagram: 'sessionid=ig_unlock_ck; ds_user_id=4101',
        facebook: 'c_user=4102; xs=fb_unlock_ck',
        x: '',
      },
      pollIntervalSeconds: 30,
      deduplicateLive: true,
    },
  });

  // Step 4: Re-validate & re-run watcher -> both recover cleanly
  const recIg = await env.apiJson<{ ok: boolean; result: ContractUserValidationResult }>('POST', '/api/user/validate', { target: '@ig_t4_private_rec', platform: 'INSTAGRAM' });
  const recFb = await env.apiJson<{ ok: boolean; result: ContractUserValidationResult }>('POST', '/api/user/validate', { target: '@fb_t4_walled_rec', platform: 'FACEBOOK' });
  assert.equal(recIg.data.result.valid, true);
  assert.equal(recIg.data.result.authMode, 'cookie');
  assert.equal(recFb.data.result.valid, true);
  assert.equal(recFb.data.result.authMode, 'cookie');

  await env.triggerWatcherCycle('story');
  const mediaAfter = await env.apiJson<{ ok: boolean; count: number }>('GET', '/api/media/downloaded');
  assert.equal(mediaAfter.data.count, 2, 'Watcher must download unlocked IG & FB stories after cookies are configured');
});

test('T4-03: Simultaneous Multi-Platform Live + Post + Story Stream -> Webhook Sandbox & Android Queue Dispatch', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  env.mocks.instagram.set('ig_t4_live_stream', {
    id: '4201',
    nickname: 'IG Streamer',
    avatarUrl: 'https://cdn.example.test/ig42.jpg',
    live: { broadcastId: '1804201001', title: 'IG Live Concert', streamUrl: 'https://cdn.example.test/ig42.mpd' },
  });
  env.mocks.facebook.set('fb_t4_story_stream', {
    id: '4202',
    nickname: 'FB Storyteller',
    avatarUrl: 'https://cdn.example.test/fb42.jpg',
    stories: [{ id: 'fb_4202_st1', title: 'FB Breaking Story', videoUrl: 'https://cdn.example.test/fb42_st1.mp4' }],
  });
  env.mocks.x.set('x_t4_post_stream', {
    id: '4203',
    nickname: 'X Reporter',
    avatarUrl: 'https://pbs.twimg.com/profile_images/4203/xr_normal.jpg',
    posts: [{ id: 'x_4203_p1', title: 'Baseline Tweet', videoUrl: 'https://cdn.example.test/x42_p1.mp4' }],
  });

  const servers = [makeSandboxServer('srv_sandbox', 'json')];
  const rules = [
    makeRule({ id: 'r_ig', keyword: '@ig_t4_live_stream', platform: 'hackernews', sourceDomain: 'instagram.com' }),
    makeRule({ id: 'r_fb', keyword: '@fb_t4_story_stream', platform: 'github', sourceDomain: 'facebook.com' }),
    makeRule({ id: 'r_x', keyword: '@x_t4_post_stream', platform: 'bluesky', sourceDomain: 'x.com' }),
  ];

  await env.apiJson('POST', '/api/android/register', {
    deviceId: 'sm_n770f_default',
    ip: '192.168.1.77',
    port: 8765,
    appVersion: '2.0.0',
  });
  await env.apiJson('PUT', '/api/workspace-state', { rules, servers, alerts: [] });

  // Warmup post cycle for X, then publish new Video Tweet
  await env.triggerWatcherCycle('post');
  env.mocks.x.get('x_t4_post_stream')!.posts!.unshift({
    id: 'x_4203_p2',
    title: 'Breaking Video Tweet',
    videoUrl: 'https://cdn.example.test/x42_p2.mp4',
  });

  // Trigger live scan + watcher post & story cycles
  const scanResp = await env.apiJson<{ ok: boolean; liveStatuses: Array<{ platform: string; status: string }> }>(
    'POST',
    '/api/scan',
    { rules, servers }
  );
  assert.equal(scanResp.status, 200);
  assert.equal(scanResp.data.liveStatuses.find((s) => s.platform === 'INSTAGRAM')?.status, 'LIVE');

  await env.triggerWatcherCycle('story');
  await env.triggerWatcherCycle('post');

  const logs = await env.apiJson<{ receipts: Array<{ payload: Record<string, unknown> }> }>(
    'GET',
    '/api/webhook-sandbox/logs'
  );
  assert.ok(logs.data.receipts.length >= 1, 'Expected live detection webhook receipt in sandbox');

  const poll = await env.apiJson<{ ok: boolean; notifications: PendingDeviceNotification[] }>(
    'GET',
    '/api/android/poll?deviceId=sm_n770f_default'
  );
  const fbNotif = poll.data.notifications.find((n) => n.platform === 'FACEBOOK' && n.itemId === 'fb_4202_st1');
  const xNotif = poll.data.notifications.find((n) => n.platform === 'X' && n.itemId === 'x_4203_p2');
  assert.ok(fbNotif && fbNotif.type === 'STORY_DOWNLOADED');
  assert.ok(xNotif && xNotif.type === 'POST_DOWNLOADED');
});

test('T4-04: Selective Cookie Revocation (Guest Mode Reset on IG & X while TT & FB Remain Authenticated)', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  env.mocks.tiktok.set('tt_t4_rev', { id: '4301', nickname: 'TT Rev', avatarUrl: 'https://cdn.example.test/t43.jpg', requireCookie: true });
  env.mocks.instagram.set('ig_t4_rev', { id: '4302', nickname: 'IG Rev', avatarUrl: 'https://cdn.example.test/i43.jpg', requireCookie: true });
  env.mocks.facebook.set('fb_t4_rev', { id: '4303', nickname: 'FB Rev', avatarUrl: 'https://cdn.example.test/f43.jpg', requireCookie: true });
  env.mocks.x.set('x_t4_rev', { id: '4304', nickname: 'X Rev', avatarUrl: 'https://pbs.twimg.com/profile_images/4304/xr_normal.jpg', requireCookie: true });

  const rules = [
    makeRule({ id: 'r_tt', keyword: '@tt_t4_rev', platform: 'reddit', sourceDomain: 'tiktok.com' }),
    makeRule({ id: 'r_ig', keyword: '@ig_t4_rev', platform: 'hackernews', sourceDomain: 'instagram.com' }),
    makeRule({ id: 'r_fb', keyword: '@fb_t4_rev', platform: 'github', sourceDomain: 'facebook.com' }),
    makeRule({ id: 'r_x', keyword: '@x_t4_rev', platform: 'bluesky', sourceDomain: 'x.com' }),
  ];

  // Phase 1: All 4 authenticated
  await env.apiJson('PUT', '/api/workspace-state', {
    rules,
    servers: [],
    alerts: [],
    scannerSettings: {
      cookies: {
        tiktok: 'sessionid=tt_keep',
        instagram: 'sessionid=ig_drop; ds_user_id=4302',
        facebook: 'c_user=4303; xs=fb_keep',
        x: 'auth_token=x_drop; ct0=x_ct0_drop',
      },
      pollIntervalSeconds: 30,
      deduplicateLive: true,
    },
  });

  for (const [target, platform] of [['@tt_t4_rev', 'TIKTOK'], ['@ig_t4_rev', 'INSTAGRAM'], ['@fb_t4_rev', 'FACEBOOK'], ['@x_t4_rev', 'X']]) {
    const res = await env.apiJson<{ ok: boolean; result: ContractUserValidationResult }>('POST', '/api/user/validate', { target, platform });
    assert.equal(res.data.result.valid, true, `Expected ${platform} valid with cookie`);
  }

  // Phase 2: Revoke only IG & X cookies (set to "")
  env.clearRecordedRequests();
  await env.apiJson('PUT', '/api/workspace-state', {
    rules,
    servers: [],
    alerts: [],
    scannerSettings: {
      cookies: {
        tiktok: 'sessionid=tt_keep',
        instagram: '',
        facebook: 'c_user=4303; xs=fb_keep',
        x: '',
      },
      pollIntervalSeconds: 30,
      deduplicateLive: true,
    },
  });

  const vTT = await env.apiJson<{ ok: boolean; result: ContractUserValidationResult }>('POST', '/api/user/validate', { target: '@tt_t4_rev', platform: 'TIKTOK' });
  const vFB = await env.apiJson<{ ok: boolean; result: ContractUserValidationResult }>('POST', '/api/user/validate', { target: '@fb_t4_rev', platform: 'FACEBOOK' });
  const vIG = await env.apiJson<{ ok: boolean; result: ContractUserValidationResult }>('POST', '/api/user/validate', { target: '@ig_t4_rev', platform: 'INSTAGRAM' });
  const vX = await env.apiJson<{ ok: boolean; result: ContractUserValidationResult }>('POST', '/api/user/validate', { target: '@x_t4_rev', platform: 'X' });

  assert.equal(vTT.data.result.valid, true);
  assert.equal(vFB.data.result.valid, true);
  assert.equal(vIG.data.result.valid, false);
  assert.equal(vIG.data.result.authMode, 'anonymous');
  assert.equal(vX.data.result.valid, false);
  assert.equal(vX.data.result.authMode, 'anonymous');

  env.clearRecordedRequests();
  await env.triggerWatcherCycle('post');
  const igCookiesSent = env.recordedRequests.filter((r) => r.hostname.includes('instagram.com') && Boolean(r.headers.cookie));
  const xCookiesSent = env.recordedRequests.filter((r) => (r.hostname.includes('x.com') || r.hostname.includes('twitter.com')) && Boolean(r.headers.cookie));
  const ttCookiesSent = env.recordedRequests.filter((r) => r.hostname.includes('tiktok.com') && r.headers.cookie?.includes('tt_keep'));
  const fbCookiesSent = env.recordedRequests.filter((r) => r.hostname.includes('facebook.com') && r.headers.cookie?.includes('fb_keep'));

  assert.equal(igCookiesSent.length, 0);
  assert.equal(xCookiesSent.length, 0);
  assert.ok(ttCookiesSent.length > 0);
  assert.ok(fbCookiesSent.length > 0);
});

test('T4-05: Production-Scale Mixed-Outcome Batch Audit Simulation across All 4 Platforms', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  // Seed a realistic mixed batch: public valid, cookie-only, 404 missing, login-walled/blocked, X story unsupported
  env.mocks.tiktok.set('tt_audit_pub', {
    id: '4501',
    nickname: 'TT Pub',
    avatarUrl: 'https://cdn.example.test/tt_a.jpg',
    stories: [{ id: 'tt_a_st1', title: 'TT Audit Story', videoUrl: 'https://cdn.example.test/tt_a_st1.mp4' }],
  });
  env.mocks.tiktok.set('tt_audit_chal', { id: '4502', nickname: 'TT Chal', avatarUrl: '', blockMode: 'challenge' });

  env.mocks.instagram.set('ig_audit_pub', {
    id: '4503',
    nickname: 'IG Pub',
    avatarUrl: 'https://cdn.example.test/ig_a.jpg',
    stories: [{ id: 'ig_a_st1', title: 'IG Audit Story', videoUrl: 'https://cdn.example.test/ig_a_st1.mp4' }],
  });
  env.mocks.instagram.set('ig_audit_priv', { id: '4504', nickname: 'IG Priv', avatarUrl: 'https://cdn.example.test/ig_p.jpg', requireCookie: true });

  env.mocks.facebook.set('fb_audit_pub', { id: '4505', nickname: 'FB Pub', avatarUrl: 'https://cdn.example.test/fb_a.jpg' });
  env.mocks.facebook.set('fb_audit_wall', { id: '4506', nickname: 'FB Wall', avatarUrl: '', blockMode: 'login_wall' });

  env.mocks.x.set('x_audit_pub', {
    id: '4507',
    nickname: 'X Pub',
    avatarUrl: 'https://pbs.twimg.com/profile_images/4507/xa_normal.jpg',
    posts: [{ id: 'x_a_p1', title: 'X Audit Post', videoUrl: 'https://cdn.example.test/x_a_p1.mp4' }],
  });

  const auditTargets = [
    { target: '@tt_audit_pub', platform: 'TIKTOK', expected: 'VALID' },
    { target: '@tt_audit_chal', platform: 'TIKTOK', expected: 'AUTH_OR_BLOCK' },
    { target: '@tt_audit_missing_404', platform: 'TIKTOK', expected: 'NOT_FOUND' },
    { target: '@ig_audit_pub', platform: 'INSTAGRAM', expected: 'VALID' },
    { target: '@ig_audit_priv', platform: 'INSTAGRAM', expected: 'AUTH_OR_BLOCK' },
    { target: '@ig_audit_missing_404', platform: 'INSTAGRAM', expected: 'NOT_FOUND' },
    { target: '@fb_audit_pub', platform: 'FACEBOOK', expected: 'VALID' },
    { target: '@fb_audit_wall', platform: 'FACEBOOK', expected: 'AUTH_OR_BLOCK' },
    { target: '@fb_audit_missing_404', platform: 'FACEBOOK', expected: 'NOT_FOUND' },
    { target: '@x_audit_pub', platform: 'X', expected: 'VALID' },
    { target: '@x_aud_miss_404', platform: 'X', expected: 'NOT_FOUND' },
  ] as const;

  for (const item of auditTargets) {
    const res = await env.apiJson<{ ok: boolean; result: ContractUserValidationResult }>(
      'POST',
      '/api/user/validate',
      { target: item.target, platform: item.platform, anonymous: true }
    );
    assert.equal(res.status, 200);
    if (item.expected === 'VALID') {
      assert.equal(res.data.result.valid, true, `Expected VALID for ${item.target}`);
      assert.equal(res.data.result.status, 'VALID');
    } else if (item.expected === 'NOT_FOUND') {
      assert.equal(res.data.result.valid, false, `Expected NOT_FOUND for ${item.target}`);
      assert.equal(res.data.result.status, 'NOT_FOUND');
    } else {
      assert.equal(res.data.result.valid, false, `Expected AUTH_REQUIRED/BLOCKED for ${item.target}`);
      assert.ok(['AUTH_REQUIRED', 'BLOCKED'].includes(res.data.result.status || ''), `Got ${res.data.result.status} for ${item.target}`);
    }
  }

  // Save full batch into workspace and run all 3 watcher event cycles
  await env.apiJson('PUT', '/api/workspace-state', {
    rules: [
      makeRule({ id: 'r_tt', keyword: '@tt_audit_pub, @tt_audit_chal, @tt_audit_missing_404', platform: 'reddit', sourceDomain: 'tiktok.com' }),
      makeRule({ id: 'r_ig', keyword: '@ig_audit_pub, @ig_audit_priv, @ig_audit_missing_404', platform: 'hackernews', sourceDomain: 'instagram.com' }),
      makeRule({ id: 'r_fb', keyword: '@fb_audit_pub, @fb_audit_wall, @fb_audit_missing_404', platform: 'github', sourceDomain: 'facebook.com' }),
      makeRule({ id: 'r_x', keyword: '@x_audit_pub, @x_aud_miss_404', platform: 'bluesky', sourceDomain: 'x.com' }),
    ],
    servers: [makeSandboxServer()],
    alerts: [],
  });

  await env.triggerWatcherCycle('live');
  await env.triggerWatcherCycle('post');
  await env.triggerWatcherCycle('story');

  const statusResp = await env.apiJson<ContractWatcherStatusResponse>('GET', '/api/watcher/status');
  assert.equal(statusResp.status, 200);
  assert.equal(statusResp.data.success, true);

  const mediaResp = await env.apiJson<{ ok: boolean; count: number }>('GET', '/api/media/downloaded');
  assert.equal(mediaResp.data.count, 2, 'Expected TT & IG public stories downloaded despite mixed errors/blocks/X-unsupported');
});
