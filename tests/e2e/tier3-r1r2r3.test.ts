import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  asTikTokEvent,
  createR1R2TestEnv,
  makeRule,
  makeSandboxServer,
  type ContractUserValidationResult,
  type ContractWatcherEvent,
  type ContractWatcherStatusResponse,
  type ContractWorkspaceState,
} from './r1r2r3Harness.ts';
import { createMediaDownloader } from '../../server/mediaDownloader';
import { createStorageManager, createTelegramService } from '../../server/storage/index';
import { Notifier } from '../../server/watchers/notifier';
import type { PendingDeviceNotification } from '../../server/watchers/types';

test('T3-01: PUT /api/workspace-state cookie update propagates to POST /api/user/validate and watcher cycles', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  env.mocks.instagram.set('ig_t3_pair1', {
    id: '3101',
    nickname: 'IG Pair 1',
    avatarUrl: 'https://cdn.example.test/ig31.jpg',
    requireCookie: true,
    stories: [{ id: 'ig_p1_st1', title: 'Pair Story', videoUrl: 'https://cdn.example.test/ig_p1_st1.mp4' }],
  });
  env.mocks.facebook.set('fb_t3_pair1', {
    id: '3102',
    nickname: 'FB Pair 1',
    avatarUrl: 'https://cdn.example.test/fb31.jpg',
    requireCookie: true,
    stories: [{ id: 'fb_p1_st1', title: 'FB Pair Story', videoUrl: 'https://cdn.example.test/fb_p1_st1.mp4' }],
  });

  const rules = [
    makeRule({ id: 'r_ig', keyword: '@ig_t3_pair1', platform: 'hackernews', sourceDomain: 'instagram.com' }),
    makeRule({ id: 'r_fb', keyword: '@fb_t3_pair1', platform: 'github', sourceDomain: 'facebook.com' }),
  ];

  // Phase 1: Set cookies via workspace-state
  await env.apiJson('PUT', '/api/workspace-state', {
    rules,
    servers: [],
    alerts: [],
    scannerSettings: {
      cookies: {
        tiktok: '',
        instagram: 'sessionid=ws_ig_301; ds_user_id=3101',
        facebook: 'c_user=3102; xs=ws_fb_301',
        x: '',
      },
      pollIntervalSeconds: 30,
      deduplicateLive: true,
    },
  });

  const valIg = await env.apiJson<{ ok: boolean; result: ContractUserValidationResult }>(
    'POST',
    '/api/user/validate',
    { target: '@ig_t3_pair1', platform: 'INSTAGRAM' }
  );
  assert.equal(valIg.data.result.valid, true);
  assert.equal(valIg.data.result.authMode, 'cookie');

  await env.triggerWatcherCycle('story');
  const media1 = await env.apiJson<{ ok: boolean; count: number }>('GET', '/api/media/downloaded');
  assert.equal(media1.data.count, 2, 'Both IG and FB stories should download once cookies are saved');

  // Phase 2: Clear cookies via workspace-state
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

  const valIgCleared = await env.apiJson<{ ok: boolean; result: ContractUserValidationResult }>(
    'POST',
    '/api/user/validate',
    { target: '@ig_t3_pair1', platform: 'INSTAGRAM' }
  );
  assert.equal(valIgCleared.data.result.authMode, 'anonymous');
  assert.equal(valIgCleared.data.result.valid, false);

  await env.triggerWatcherCycle('post');
  assert.equal(
    env.recordedRequests.some((r) => Boolean(r.headers.cookie)),
    false,
    'After clearing cookies, neither validate nor watcher should send Cookie header'
  );
});

test('T3-02: Cookie precedence body > workspace > envCookies, while anonymous: true overrides all', async (t) => {
  const env = await createR1R2TestEnv({
    envCookies: {
      x: 'auth_token=env_x; ct0=env_ct0',
    },
  });
  t.after(() => env.cleanup());

  env.mocks.x.set('x_t3_prec', {
    id: '3201',
    nickname: 'X Precedence',
    avatarUrl: 'https://pbs.twimg.com/profile_images/6/xp_normal.jpg',
    requireCookie: true,
  });

  // 1. Only envCookies present -> uses env_x
  env.clearRecordedRequests();
  const rEnv = await env.apiJson<{ ok: boolean; result: ContractUserValidationResult }>(
    'POST',
    '/api/user/validate',
    { target: '@x_t3_prec', platform: 'X' }
  );
  assert.equal(rEnv.data.result.valid, true);
  assert.equal(rEnv.data.result.authMode, 'cookie');
  assert.ok(env.recordedRequests.some((r) => r.headers.cookie?.includes('env_x')));

  // 2. Workspace cookie overrides envCookies
  await env.apiJson('PUT', '/api/workspace-state', {
    rules: [],
    servers: [],
    alerts: [],
    scannerSettings: {
      cookies: { tiktok: '', instagram: '', facebook: '', x: 'auth_token=ws_x; ct0=ws_ct0' },
      pollIntervalSeconds: 30,
      deduplicateLive: true,
    },
  });
  env.clearRecordedRequests();
  const rWs = await env.apiJson<{ ok: boolean; result: ContractUserValidationResult }>(
    'POST',
    '/api/user/validate',
    { target: '@x_t3_prec', platform: 'X' }
  );
  assert.equal(rWs.data.result.valid, true);
  assert.ok(env.recordedRequests.some((r) => r.headers.cookie?.includes('ws_x')));

  // 3. Explicit request cookie overrides workspace & envCookies
  env.clearRecordedRequests();
  const rReq = await env.apiJson<{ ok: boolean; result: ContractUserValidationResult }>(
    'POST',
    '/api/user/validate',
    { target: '@x_t3_prec', platform: 'X', cookie: 'auth_token=req_x; ct0=req_ct0' }
  );
  assert.equal(rReq.data.result.valid, true);
  assert.ok(env.recordedRequests.some((r) => r.headers.cookie?.includes('req_x')));

  // 4. anonymous: true overrides explicit cookie, workspace, AND envCookies
  env.clearRecordedRequests();
  const rAnon = await env.apiJson<{ ok: boolean; result: ContractUserValidationResult }>(
    'POST',
    '/api/user/validate',
    { target: '@x_t3_prec', platform: 'X', cookie: 'auth_token=req_x; ct0=req_ct0', anonymous: true }
  );
  assert.equal(rAnon.data.result.authMode, 'anonymous');
  assert.equal(rAnon.data.result.valid, false);
  assert.equal(env.recordedRequests.some((r) => Boolean(r.headers.cookie)), false);
});

test('T3-03: scannerSettings.platforms toggles selectively enable/disable live, post, story per platform', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  env.mocks.instagram.set('ig_t3_toggle', {
    id: '3301',
    nickname: 'IG Toggle',
    avatarUrl: 'https://cdn.example.test/ig33.jpg',
    posts: [{ id: 'ig_p_off', title: 'Disabled Post', videoUrl: 'https://cdn.example.test/ig_p_off.mp4' }],
    stories: [{ id: 'ig_s_on', title: 'Enabled Story', videoUrl: 'https://cdn.example.test/ig_s_on.mp4' }],
  });
  env.mocks.facebook.set('fb_t3_toggle', {
    id: '3302',
    nickname: 'FB Toggle',
    avatarUrl: 'https://cdn.example.test/fb33.jpg',
    posts: [{ id: 'fb_p_on', title: 'Enabled FB Post', videoUrl: 'https://cdn.example.test/fb_p_on.mp4' }],
    stories: [{ id: 'fb_s_off', title: 'Disabled FB Story', videoUrl: 'https://cdn.example.test/fb_s_off.mp4' }],
  });
  env.mocks.x.set('x_t3_toggle', {
    id: '3303',
    nickname: 'X Toggle',
    avatarUrl: 'https://pbs.twimg.com/profile_images/7/xt_normal.jpg',
    live: { broadcastId: '1dRKZlaqAbToggle', mediaKey: 'mk_t3', title: 'X Live On', streamUrl: 'https://cdn.example.test/x_t3.m3u8' },
    posts: [{ id: 'x_p_off', title: 'Disabled X Post', videoUrl: 'https://cdn.example.test/x_p_off.mp4' }],
  });

  await env.apiJson('PUT', '/api/workspace-state', {
    rules: [
      makeRule({ id: 'r_ig', keyword: '@ig_t3_toggle', platform: 'hackernews', sourceDomain: 'instagram.com' }),
      makeRule({ id: 'r_fb', keyword: '@fb_t3_toggle', platform: 'github', sourceDomain: 'facebook.com' }),
      makeRule({ id: 'r_x', keyword: '@x_t3_toggle', platform: 'bluesky', sourceDomain: 'x.com' }),
    ],
    servers: [],
    alerts: [],
    scannerSettings: {
      cookies: { tiktok: '', instagram: '', facebook: '', x: '' },
      pollIntervalSeconds: 30,
      deduplicateLive: true,
      platforms: {
        instagram: { liveEnabled: false, postEnabled: false, storyEnabled: true, liveIntervalSeconds: 60, postIntervalSeconds: 240, storyIntervalSeconds: 360 },
        facebook: { liveEnabled: false, postEnabled: true, storyEnabled: false, liveIntervalSeconds: 60, postIntervalSeconds: 240, storyIntervalSeconds: 360 },
        x: { liveEnabled: true, postEnabled: false, storyEnabled: false, liveIntervalSeconds: 60, postIntervalSeconds: 240, storyIntervalSeconds: 360 },
      },
    },
  });

  env.clearRecordedRequests();
  await env.triggerWatcherCycle('post');
  // IG postEnabled=false, X postEnabled=false; only FB postEnabled=true should run
  assert.equal(env.recordedRequests.some((r) => r.hostname.includes('instagram.com')), false);
  assert.equal(env.recordedRequests.some((r) => r.hostname.includes('x.com') || r.hostname.includes('twitter.com')), false);
  assert.equal(env.recordedRequests.some((r) => r.hostname.includes('facebook.com')), true);

  env.clearRecordedRequests();
  await env.triggerWatcherCycle('story');
  // FB storyEnabled=false; IG storyEnabled=true should run
  assert.equal(env.recordedRequests.some((r) => r.hostname.includes('facebook.com')), false);
  assert.equal(env.recordedRequests.some((r) => r.hostname.includes('instagram.com')), true);
});

test('T3-04: Warmup suppresses initial post & live while story downloads & notifies immediately across IG & FB', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  env.mocks.instagram.set('ig_t3_wu_pair', {
    id: '3401',
    nickname: 'IG WU Pair',
    avatarUrl: 'https://cdn.example.test/ig34.jpg',
    posts: [{ id: 'ig_base_post', title: 'Old Post', videoUrl: 'https://cdn.example.test/ig_base.mp4' }],
    stories: [{ id: 'ig_imm_story', title: 'Immediate IG Story', videoUrl: 'https://cdn.example.test/ig_imm_st.mp4' }],
    live: { broadcastId: '1803401', title: 'Baseline Live', streamUrl: 'https://cdn.example.test/ig_wu_live.mpd' },
  });
  env.mocks.facebook.set('fb_t3_wu_pair', {
    id: '3402',
    nickname: 'FB WU Pair',
    avatarUrl: 'https://cdn.example.test/fb34.jpg',
    posts: [{ id: 'fb_base_post', title: 'Old FB Post', videoUrl: 'https://cdn.example.test/fb_base.mp4' }],
    stories: [{ id: 'fb_imm_story', title: 'Immediate FB Story', videoUrl: 'https://cdn.example.test/fb_imm_st.mp4' }],
  });

  await env.apiJson('PUT', '/api/workspace-state', {
    rules: [
      makeRule({ id: 'r_ig', keyword: '@ig_t3_wu_pair', platform: 'hackernews', sourceDomain: 'instagram.com' }),
      makeRule({ id: 'r_fb', keyword: '@fb_t3_wu_pair', platform: 'github', sourceDomain: 'facebook.com' }),
    ],
    servers: [],
    alerts: [],
  });

  // Cycle 1: cold start across live, post, story
  await env.triggerWatcherCycle('live');
  await env.triggerWatcherCycle('post');
  await env.triggerWatcherCycle('story');

  const poll1 = await env.apiJson<{ ok: boolean; notifications: PendingDeviceNotification[] }>(
    'GET',
    '/api/android/poll?deviceId=sm_n770f_default'
  );
  const itemIds1 = poll1.data.notifications.map((n) => n.itemId);
  assert.ok(itemIds1.includes('ig_imm_story'), 'IG story must notify immediately without warmup suppression');
  assert.ok(itemIds1.includes('fb_imm_story'), 'FB story must notify immediately without warmup suppression');
  assert.equal(itemIds1.includes('ig_base_post'), false, 'Baseline IG post must be suppressed by warmup');
  assert.equal(itemIds1.includes('fb_base_post'), false, 'Baseline FB post must be suppressed by warmup');

  // Cycle 2: add new post on IG -> must notify now
  env.mocks.instagram.get('ig_t3_wu_pair')!.posts!.unshift({
    id: 'ig_fresh_post_2',
    title: 'Fresh Post After Warmup',
    videoUrl: 'https://cdn.example.test/ig_fresh2.mp4',
  });
  await env.triggerWatcherCycle('post');

  const poll2 = await env.apiJson<{ ok: boolean; notifications: PendingDeviceNotification[] }>(
    'GET',
    '/api/android/poll?deviceId=sm_n770f_default'
  );
  assert.ok(poll2.data.notifications.some((n) => n.itemId === 'ig_fresh_post_2'));
});

test('T3-05: Same username @sameuser across all 4 platforms keeps targetProfiles, dedup, and downloaded media isolated', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  const shared = 'sameuser_cross';
  const ttBytes = Buffer.from('CROSS_TT_BYTES_111');
  const igBytes = Buffer.from('CROSS_IG_BYTES_222');
  const fbBytes = Buffer.from('CROSS_FB_BYTES_333');
  const xBytes = Buffer.from('CROSS_X_BYTES_444');

  env.mocks.cdnAssets.set('https://cdn.example.test/cross_tt.mp4', { status: 200, contentType: 'video/mp4', body: ttBytes });
  env.mocks.cdnAssets.set('https://cdn.example.test/cross_ig.mp4', { status: 200, contentType: 'video/mp4', body: igBytes });
  env.mocks.cdnAssets.set('https://cdn.example.test/cross_fb.mp4', { status: 200, contentType: 'video/mp4', body: fbBytes });
  env.mocks.cdnAssets.set('https://cdn.example.test/cross_x.mp4', { status: 200, contentType: 'video/mp4', body: xBytes });

  env.mocks.tiktok.set(shared, {
    id: '41',
    nickname: 'Same TT',
    avatarUrl: 'https://cdn.example.test/c_tt.jpg',
    posts: [{ id: 'shared_item_1', title: 'TT Item', videoUrl: 'https://cdn.example.test/cross_tt.mp4' }],
  });
  env.mocks.instagram.set(shared, {
    id: '42',
    nickname: 'Same IG',
    avatarUrl: 'https://cdn.example.test/c_ig.jpg',
    posts: [{ id: 'shared_item_1', title: 'IG Item', videoUrl: 'https://cdn.example.test/cross_ig.mp4' }],
  });
  env.mocks.facebook.set(shared, {
    id: '43',
    nickname: 'Same FB',
    avatarUrl: 'https://cdn.example.test/c_fb.jpg',
    posts: [{ id: 'shared_item_1', title: 'FB Item', videoUrl: 'https://cdn.example.test/cross_fb.mp4' }],
  });
  env.mocks.x.set(shared, {
    id: '44',
    nickname: 'Same X',
    avatarUrl: 'https://pbs.twimg.com/profile_images/8/cx_normal.jpg',
    posts: [{ id: 'shared_item_1', title: 'X Item', videoUrl: 'https://cdn.example.test/cross_x.mp4' }],
  });

  const targetProfiles = {
    [`TIKTOK::${shared}`]: { id: '41', nickname: 'Same TT', avatarUrl: 'https://cdn.example.test/c_tt.jpg', profileUrl: `https://www.tiktok.com/@${shared}`, updatedAt: '2026-11-21T09:00:00.000Z' },
    [`INSTAGRAM::${shared}`]: { id: '42', nickname: 'Same IG', avatarUrl: 'https://cdn.example.test/c_ig.jpg', profileUrl: `https://www.instagram.com/${shared}/`, updatedAt: '2026-11-21T09:00:00.000Z' },
    [`FACEBOOK::${shared}`]: { id: '43', nickname: 'Same FB', avatarUrl: 'https://cdn.example.test/c_fb.jpg', profileUrl: `https://www.facebook.com/${shared}`, updatedAt: '2026-11-21T09:00:00.000Z' },
    [`X::${shared}`]: { id: '44', nickname: 'Same X', avatarUrl: 'https://cdn.example.test/c_x.jpg', profileUrl: `https://x.com/${shared}`, updatedAt: '2026-11-21T09:00:00.000Z' },
  };

  await env.apiJson('PUT', '/api/workspace-state', {
    rules: [
      makeRule({ id: 'r_tt', keyword: `@${shared}`, platform: 'reddit', sourceDomain: 'tiktok.com' }),
      makeRule({ id: 'r_ig', keyword: `@${shared}`, platform: 'hackernews', sourceDomain: 'instagram.com' }),
      makeRule({ id: 'r_fb', keyword: `@${shared}`, platform: 'github', sourceDomain: 'facebook.com' }),
      makeRule({ id: 'r_x', keyword: `@${shared}`, platform: 'bluesky', sourceDomain: 'x.com' }),
    ],
    servers: [],
    alerts: [],
    targetProfiles,
  });

  const ws = await env.apiJson<{ ok: boolean; state: ContractWorkspaceState }>('GET', '/api/workspace-state');
  assert.equal(Object.keys(ws.data.state.targetProfiles || {}).length, 4);

  // Download same itemId across all 4 platforms directly through MediaDownloader -> /api/media/downloaded
  const downloader = createMediaDownloader({ storageRoot: env.mediaDir, timeoutMs: 5000 });
  const payloads: Array<{ platform: 'TIKTOK' | 'INSTAGRAM' | 'FACEBOOK' | 'X'; url: string }> = [
    { platform: 'TIKTOK', url: 'https://cdn.example.test/cross_tt.mp4' },
    { platform: 'INSTAGRAM', url: 'https://cdn.example.test/cross_ig.mp4' },
    { platform: 'FACEBOOK', url: 'https://cdn.example.test/cross_fb.mp4' },
    { platform: 'X', url: 'https://cdn.example.test/cross_x.mp4' },
  ];

  for (const p of payloads) {
    const res = await downloader.downloadEventMedia(
      asTikTokEvent({
        platform: p.platform,
        username: shared,
        eventType: 'post',
        itemId: 'shared_item_1',
        url: `https://example.com/${p.platform}/shared_item_1`,
        title: `Post ${p.platform}`,
        detectedAt: new Date().toISOString(),
        metadata: { videoUrl: p.url },
      })
    );
    assert.equal(res.success, true);
  }

  const mediaList = await env.apiJson<{
    ok: boolean;
    count: number;
    media: Array<{ fileName: string; downloadUrl: string }>;
  }>('GET', '/api/media/downloaded');

  assert.equal(mediaList.data.count, 4, 'All 4 same-username same-itemId files across 4 platforms must coexist without overwriting');

  const downloadedTexts = await Promise.all(
    mediaList.data.media.map(async (m) => {
      const r = await fetch(`${env.server.url}${m.downloadUrl}`);
      assert.equal(r.status, 200);
      return Buffer.from(await r.arrayBuffer()).toString('utf-8');
    })
  );
  assert.ok(downloadedTexts.includes(ttBytes.toString('utf-8')));
  assert.ok(downloadedTexts.includes(igBytes.toString('utf-8')));
  assert.ok(downloadedTexts.includes(fbBytes.toString('utf-8')));
  assert.ok(downloadedTexts.includes(xBytes.toString('utf-8')));
});

test('T3-06: Notifier invokes onPendingNotification even when webhookUrl & androidCallbackUrl are unset', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  const captured: PendingDeviceNotification[] = [];
  const notifier = new Notifier({
    webhookUrl: undefined,
    androidCallbackUrl: undefined,
    onPendingNotification: async (notif) => {
      captured.push(notif);
      await env.apiJson('POST', '/api/android/notify', notif);
    },
  });

  const igPost: ContractWatcherEvent = {
    platform: 'INSTAGRAM',
    username: 'ig_t3_noop_url',
    eventType: 'post',
    itemId: 'ig_noop_1',
    url: 'https://www.instagram.com/p/ig_noop_1/',
    title: 'IG Post Without Webhook',
    detectedAt: new Date().toISOString(),
  };
  const fbStory: ContractWatcherEvent = {
    platform: 'FACEBOOK',
    username: 'fb_t3_noop_url',
    eventType: 'story',
    itemId: 'fb_noop_1',
    url: 'https://www.facebook.com/stories/fb_noop_1',
    title: 'FB Story Without Webhook',
    detectedAt: new Date().toISOString(),
  };

  await notifier.notify(asTikTokEvent(igPost));
  await notifier.notify(asTikTokEvent(fbStory));

  assert.equal(captured.length, 2, 'onPendingNotification must run even without webhookUrl/androidCallbackUrl');
  assert.equal(captured[0].platform, 'INSTAGRAM');
  assert.equal(captured[0].type, 'POST_DOWNLOADED');
  assert.equal(captured[1].platform, 'FACEBOOK');
  assert.equal(captured[1].type, 'STORY_DOWNLOADED');

  const poll = await env.apiJson<{ ok: boolean; notifications: PendingDeviceNotification[] }>(
    'GET',
    '/api/android/poll?deviceId=sm_n770f_default'
  );
  assert.equal(poll.data.notifications.length, 2);
});

test('T3-07: Validate + PUT workspace-state + POST /api/scan + GET /api/watcher/status integrate cleanly across 4 platforms', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  env.mocks.tiktok.set('tt_t3_int', {
    id: '3701',
    nickname: 'TT Int',
    avatarUrl: 'https://cdn.example.test/t37.jpg',
    stories: [{ id: 'tt_int_st1', title: 'TT Int Story', videoUrl: 'https://cdn.example.test/t37.mp4' }],
  });
  env.mocks.instagram.set('ig_t3_int', {
    id: '3702',
    nickname: 'IG Int',
    avatarUrl: 'https://cdn.example.test/i37.jpg',
    live: { broadcastId: '1803702', title: 'IG Live Now', streamUrl: 'https://cdn.example.test/ig37_live.mpd' },
  });
  env.mocks.facebook.set('fb_t3_int', {
    id: '3703',
    nickname: 'FB Int',
    avatarUrl: 'https://cdn.example.test/f37.jpg',
  });
  env.mocks.x.set('x_t3_int', {
    id: '3704',
    nickname: 'X Int',
    avatarUrl: 'https://pbs.twimg.com/profile_images/9/x37_normal.jpg',
  });

  const targets = [
    { target: '@tt_t3_int', platform: 'TIKTOK', rulePlatform: 'reddit' as const, domain: 'tiktok.com' },
    { target: '@ig_t3_int', platform: 'INSTAGRAM', rulePlatform: 'hackernews' as const, domain: 'instagram.com' },
    { target: '@fb_t3_int', platform: 'FACEBOOK', rulePlatform: 'github' as const, domain: 'facebook.com' },
    { target: '@x_t3_int', platform: 'X', rulePlatform: 'bluesky' as const, domain: 'x.com' },
  ];

  const targetProfiles: Record<string, unknown> = {};
  const rules = [];
  for (const item of targets) {
    const val = await env.apiJson<{ ok: boolean; result: ContractUserValidationResult }>(
      'POST',
      '/api/user/validate',
      { target: item.target, platform: item.platform }
    );
    assert.equal(val.data.result.valid, true);
    const key = `${item.platform}::${val.data.result.username.toLowerCase()}`;
    targetProfiles[key] = {
      id: val.data.result.id,
      nickname: val.data.result.nickname,
      avatarUrl: val.data.result.avatarUrl,
      profileUrl: val.data.result.profileUrl,
      status: val.data.result.status,
      authMode: val.data.result.authMode,
      updatedAt: new Date().toISOString(),
    };
    rules.push(
      makeRule({
        id: `rule_${item.platform.toLowerCase()}`,
        keyword: item.target,
        platform: item.rulePlatform,
        sourceDomain: item.domain,
      })
    );
  }

  const servers = [makeSandboxServer('srv_sandbox', 'json')];
  await env.apiJson('PUT', '/api/workspace-state', {
    rules,
    servers,
    alerts: [],
    targetProfiles,
  });

  const scanResp = await env.apiJson<{
    ok: boolean;
    mode: string;
    totalPostsScanned: number;
    liveStatuses: Array<{ platform: string; status: string }>;
  }>('POST', '/api/scan', { rules, servers });
  assert.equal(scanResp.status, 200);
  assert.equal(scanResp.data.mode, 'live');
  assert.equal(scanResp.data.totalPostsScanned, 4);
  const igLive = scanResp.data.liveStatuses.find((s) => s.platform === 'INSTAGRAM');
  assert.equal(igLive?.status, 'LIVE');

  await env.triggerWatcherCycle('story');
  const statusResp = await env.apiJson<ContractWatcherStatusResponse>('GET', '/api/watcher/status');
  assert.equal(statusResp.status, 200);
  assert.equal(statusResp.data.success, true);
  assert.ok(statusResp.data.metrics.seenEventsCount >= 1);
});

test('T3-08: MediaDownloader + TelegramService + Notifier chain forwards file metadata and platform tags', async (t) => {
  const env = await createR1R2TestEnv({
    telegram: { botToken: 'chain_bot', chatId: '-1004484723209', enabled: true },
  });
  t.after(() => env.cleanup());

  const videoPayload = Buffer.from('CHAIN_X_VIDEO_BYTES_9999');
  env.mocks.cdnAssets.set('https://cdn.example.test/chain_x.mp4', {
    status: 200,
    contentType: 'video/mp4',
    body: videoPayload,
  });

  const tg = createTelegramService({ botToken: 'chain_bot', chatId: '-1004484723209', enabled: true });
  const storage = createStorageManager({ telegramService: tg, localStorageRoot: env.mediaDir });
  const downloader = createMediaDownloader({ storageRoot: env.mediaDir, storageManager: storage, timeoutMs: 5000 });

  const xEvent: ContractWatcherEvent = {
    platform: 'X',
    username: 'x_chain_user',
    eventType: 'post',
    itemId: 'x_chain_1',
    url: 'https://x.com/x_chain_user/status/x_chain_1',
    title: 'Chain Post <Demo> & Live',
    detectedAt: '2026-11-21T09:05:00.000Z',
    metadata: { videoUrl: 'https://cdn.example.test/chain_x.mp4' },
  };

  const dlRes = await downloader.downloadEventMedia(asTikTokEvent(xEvent));
  assert.equal(dlRes.success, true);
  assert.equal(dlRes.files.length, 1);
  assert.ok(dlRes.files[0].telegramLink);

  const pending: PendingDeviceNotification[] = [];
  const notifier = new Notifier({
    onPendingNotification: async (n) => {
      pending.push(n);
    },
  });

  await notifier.notify(
    asTikTokEvent({
      ...xEvent,
      metadata: {
        ...xEvent.metadata,
        downloadedMedia: dlRes,
      },
    })
  );

  assert.equal(pending.length, 1);
  assert.equal(pending[0].platform, 'X');
  assert.equal(pending[0].fileName, dlRes.files[0].fileName);
  assert.equal(pending[0].fileSize, videoPayload.length);
});
