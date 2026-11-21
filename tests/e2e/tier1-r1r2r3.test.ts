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
import { createMediaDownloader } from '../../server/mediaDownloader';
import { createStorageManager, createTelegramService } from '../../server/storage/index';
import { Notifier } from '../../server/watchers/notifier';
import type { StorageUploadParams } from '../../server/storage/types';
import type { PendingDeviceNotification, WebhookEventPayload } from '../../server/watchers/types';

// ============================================================================
// Feature 1: R1 Profile & Avatar Validation + Cookie Resolution (6 tests)
// ============================================================================

test('T1-F1-01: POST /api/user/validate extracts valid TikTok profile and avatar', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  env.mocks.tiktok.set('tt_t1_valid1', {
    id: '7100000000000000001',
    nickname: 'Bao Tran TT',
    avatarUrl: 'https://cdn.example.test/tt_avatar_1.jpg',
  });

  const resp = await env.apiJson<{ ok: boolean; result: ContractUserValidationResult }>(
    'POST',
    '/api/user/validate',
    { target: '@tt_t1_valid1', platform: 'TIKTOK' }
  );

  assert.equal(resp.status, 200);
  assert.equal(resp.data.ok, true);
  assert.equal(resp.data.result.valid, true);
  assert.equal(resp.data.result.status, 'VALID');
  assert.equal(resp.data.result.authMode, 'anonymous');
  assert.equal(resp.data.result.username, 'tt_t1_valid1');
  assert.equal(resp.data.result.id, '7100000000000000001');
  assert.equal(resp.data.result.nickname, 'Bao Tran TT');
  assert.equal(resp.data.result.avatarUrl, 'https://cdn.example.test/tt_avatar_1.jpg');
  assert.equal(resp.data.result.profileUrl, 'https://www.tiktok.com/@tt_t1_valid1');
});

test('T1-F1-02: POST /api/user/validate extracts valid Instagram profile with bare sessionid cookie', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  env.mocks.instagram.set('ig_t1_valid_cookie', {
    id: '50160641448',
    nickname: 'Bao Tran IG',
    avatarUrl: 'https://cdn.example.test/ig_avatar_1.jpg',
    requireCookie: true,
  });

  const resp = await env.apiJson<{ ok: boolean; result: ContractUserValidationResult }>(
    'POST',
    '/api/user/validate',
    {
      target: 'https://www.instagram.com/ig_t1_valid_cookie/',
      platform: 'INSTAGRAM',
      cookie: '50160%3Asecret_t1',
    }
  );

  assert.equal(resp.status, 200);
  assert.equal(resp.data.ok, true);
  assert.equal(resp.data.result.valid, true);
  assert.equal(resp.data.result.status, 'VALID');
  assert.equal(resp.data.result.authMode, 'cookie');
  assert.equal(resp.data.result.username, 'ig_t1_valid_cookie');
  assert.equal(resp.data.result.id, '50160641448');
  assert.equal(resp.data.result.nickname, 'Bao Tran IG');
  assert.equal(resp.data.result.avatarUrl, 'https://cdn.example.test/ig_avatar_1.jpg');
  assert.equal(resp.data.result.profileUrl, 'https://www.instagram.com/ig_t1_valid_cookie/');

  const igReqs = env.recordedRequests.filter((r) => r.hostname.includes('instagram.com'));
  assert.ok(igReqs.length >= 1, 'Expected at least 1 upstream Instagram request');
  assert.ok(
    igReqs.some((r) => r.headers.cookie?.includes('sessionid=50160%3Asecret_t1') && r.headers.cookie?.includes('ds_user_id=50160')),
    'Expected formatted Instagram Cookie header with sessionid and ds_user_id'
  );
});

test('T1-F1-03: POST /api/user/validate resolves Facebook slug and numeric profile.php?id= profiles', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  env.mocks.facebook.set('fb_t1_slug', {
    id: '100011122233344',
    nickname: 'FB Slug Creator',
    avatarUrl: 'https://cdn.example.test/fb_slug.jpg',
  });
  env.mocks.facebook.set('100064789123456', {
    id: '100064789123456',
    nickname: 'FB Numeric Profile',
    avatarUrl: 'https://cdn.example.test/fb_num.jpg',
  });

  const slugResp = await env.apiJson<{ ok: boolean; result: ContractUserValidationResult }>(
    'POST',
    '/api/user/validate',
    { target: '@fb_t1_slug', platform: 'FACEBOOK' }
  );
  assert.equal(slugResp.status, 200);
  assert.equal(slugResp.data.result.valid, true);
  assert.equal(slugResp.data.result.status, 'VALID');
  assert.equal(slugResp.data.result.username, 'fb_t1_slug');
  assert.equal(slugResp.data.result.id, '100011122233344');
  assert.equal(slugResp.data.result.nickname, 'FB Slug Creator');
  assert.equal(slugResp.data.result.avatarUrl, 'https://cdn.example.test/fb_slug.jpg');
  assert.equal(slugResp.data.result.profileUrl, 'https://www.facebook.com/fb_t1_slug');

  const numResp = await env.apiJson<{ ok: boolean; result: ContractUserValidationResult }>(
    'POST',
    '/api/user/validate',
    { target: 'https://www.facebook.com/profile.php?id=100064789123456', platform: 'FACEBOOK' }
  );
  assert.equal(numResp.status, 200);
  assert.equal(numResp.data.result.valid, true);
  assert.equal(numResp.data.result.status, 'VALID');
  assert.equal(numResp.data.result.username, '100064789123456');
  assert.equal(numResp.data.result.id, '100064789123456');
  assert.equal(numResp.data.result.nickname, 'FB Numeric Profile');
  assert.equal(numResp.data.result.avatarUrl, 'https://cdn.example.test/fb_num.jpg');
  assert.equal(numResp.data.result.profileUrl, 'https://www.facebook.com/profile.php?id=100064789123456');
});

test('T1-F1-04: POST /api/user/validate extracts X profile, upgrades _normal avatar, and derives x-csrf-token', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  env.mocks.x.set('x_t1_valid', {
    id: '190000000000001',
    nickname: 'Mina X',
    avatarUrl: 'https://pbs.twimg.com/profile_images/12345/avatar_normal.jpg',
    requireCookie: true,
  });

  const resp = await env.apiJson<{ ok: boolean; result: ContractUserValidationResult }>(
    'POST',
    '/api/user/validate',
    {
      target: 'https://x.com/x_t1_valid',
      platform: 'X',
      cookie: 'auth_token=atk_t1; ct0=csrf_t1_abc',
    }
  );

  assert.equal(resp.status, 200);
  assert.equal(resp.data.result.valid, true);
  assert.equal(resp.data.result.status, 'VALID');
  assert.equal(resp.data.result.authMode, 'cookie');
  assert.equal(resp.data.result.username, 'x_t1_valid');
  assert.equal(resp.data.result.id, '190000000000001');
  assert.equal(resp.data.result.nickname, 'Mina X');
  assert.ok(resp.data.result.avatarUrl?.includes('_400x400.jpg'), 'Expected _normal avatar upgraded to _400x400');
  assert.equal(resp.data.result.profileUrl, 'https://x.com/x_t1_valid');

  const xReqs = env.recordedRequests.filter(
    (r) => r.hostname.includes('twitter.com') || r.hostname.includes('x.com')
  );
  assert.ok(
    xReqs.some(
      (r) => r.headers.cookie?.includes('auth_token=atk_t1') && r.headers['x-csrf-token'] === 'csrf_t1_abc'
    ),
    'Expected upstream X request with Cookie and derived x-csrf-token'
  );
});

test('T1-F1-05: POST /api/user/validate resolves workspace-state cookie when request omits cookie', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  env.mocks.instagram.set('ig_t1_ws_cookie', {
    id: '50160641499',
    nickname: 'WS Cookie IG',
    avatarUrl: 'https://cdn.example.test/ig_ws.jpg',
    requireCookie: true,
  });

  const putResp = await env.apiJson('PUT', '/api/workspace-state', {
    rules: [],
    servers: [],
    alerts: [],
    scannerSettings: {
      cookies: {
        tiktok: '',
        instagram: 'sessionid=ws_ig_secret; ds_user_id=50160',
        facebook: '',
        x: '',
      },
      pollIntervalSeconds: 30,
      deduplicateLive: true,
    },
  });
  assert.equal(putResp.status, 200);

  const valResp = await env.apiJson<{ ok: boolean; result: ContractUserValidationResult }>(
    'POST',
    '/api/user/validate',
    { target: '@ig_t1_ws_cookie', platform: 'INSTAGRAM' }
  );

  assert.equal(valResp.status, 200);
  assert.equal(valResp.data.result.valid, true);
  assert.equal(valResp.data.result.status, 'VALID');
  assert.equal(valResp.data.result.authMode, 'cookie');
  assert.ok(
    env.recordedRequests.some((r) => r.headers.cookie?.includes('ws_ig_secret')),
    'Expected workspace Instagram cookie to be sent upstream'
  );
});

test('T1-F1-06: POST /api/user/validate supports internal platform aliases and instagr.am/fb.com URLs', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  env.mocks.tiktok.set('alias_tt', { id: '101', nickname: 'TT Alias', avatarUrl: 'https://cdn.example.test/tt.jpg' });
  env.mocks.instagram.set('alias_ig', { id: '102', nickname: 'IG Alias', avatarUrl: 'https://cdn.example.test/ig.jpg' });
  env.mocks.facebook.set('alias_fb', { id: '103', nickname: 'FB Alias', avatarUrl: 'https://cdn.example.test/fb.jpg' });
  env.mocks.x.set('alias_x', { id: '104', nickname: 'X Alias', avatarUrl: 'https://cdn.example.test/x_normal.jpg' });

  const checks = [
    { target: '@alias_tt', platform: 'reddit', expectedUrl: 'https://www.tiktok.com/@alias_tt', expectedName: 'alias_tt' },
    { target: 'https://instagr.am/@alias_ig/', platform: 'hackernews', expectedUrl: 'https://www.instagram.com/alias_ig/', expectedName: 'alias_ig' },
    { target: 'https://fb.com/alias_fb', platform: 'github', expectedUrl: 'https://www.facebook.com/alias_fb', expectedName: 'alias_fb' },
    { target: '@alias_x', platform: 'bluesky', expectedUrl: 'https://x.com/alias_x', expectedName: 'alias_x' },
  ];

  for (const c of checks) {
    const resp = await env.apiJson<{ ok: boolean; result: ContractUserValidationResult }>(
      'POST',
      '/api/user/validate',
      { target: c.target, platform: c.platform }
    );
    assert.equal(resp.status, 200);
    assert.equal(resp.data.result.valid, true);
    assert.equal(resp.data.result.status, 'VALID');
    assert.equal(resp.data.result.username, c.expectedName);
    assert.equal(resp.data.result.profileUrl, c.expectedUrl);
  }
});

// ============================================================================
// Feature 2: R1 Workspace Profile Metadata Persistence (5 tests)
// ============================================================================

test('T1-F2-01: PUT /api/workspace-state persists targetProfiles without altering KeywordRuleItem schema', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  const rule = makeRule({
    id: 'rule_ig_1',
    keyword: '@ig_t1_profile',
    platform: 'hackernews',
    sourceDomain: 'instagram.com',
  });
  const nowIso = '2026-11-21T09:00:00.000Z';

  const putResp = await env.apiJson<{ ok: boolean; state: ContractWorkspaceState }>(
    'PUT',
    '/api/workspace-state',
    {
      rules: [rule],
      servers: [makeSandboxServer()],
      alerts: [],
      targetProfiles: {
        'INSTAGRAM::ig_t1_profile': {
          id: '5016001',
          nickname: 'IG Creator',
          avatarUrl: 'https://cdn.example.test/ig_p.jpg',
          profileUrl: 'https://www.instagram.com/ig_t1_profile/',
          status: 'VALID',
          authMode: 'anonymous',
          updatedAt: nowIso,
        },
      },
    }
  );

  assert.equal(putResp.status, 200);
  assert.equal(putResp.data.ok, true);
  assert.deepEqual(putResp.data.state.rules[0], rule);
  assert.equal(putResp.data.state.targetProfiles?.['INSTAGRAM::ig_t1_profile']?.nickname, 'IG Creator');
  assert.equal(putResp.data.state.targetProfiles?.['INSTAGRAM::ig_t1_profile']?.avatarUrl, 'https://cdn.example.test/ig_p.jpg');
});

test('T1-F2-02: GET /api/workspace-state preserves targetProfiles across all 4 platforms', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  const targetProfiles = {
    'TIKTOK::u1': { id: '1', nickname: 'TT1', avatarUrl: 'https://cdn.example.test/1.jpg', profileUrl: 'https://www.tiktok.com/@u1', status: 'VALID', authMode: 'anonymous' as const, updatedAt: '2026-11-21T09:00:00.000Z' },
    'INSTAGRAM::u2': { id: '2', nickname: 'IG2', avatarUrl: 'https://cdn.example.test/2.jpg', profileUrl: 'https://www.instagram.com/u2/', status: 'VALID', authMode: 'cookie' as const, updatedAt: '2026-11-21T09:00:00.000Z' },
    'FACEBOOK::u3': { id: '3', nickname: 'FB3', avatarUrl: 'https://cdn.example.test/3.jpg', profileUrl: 'https://www.facebook.com/u3', status: 'VALID', authMode: 'anonymous' as const, updatedAt: '2026-11-21T09:00:00.000Z' },
    'X::u4': { id: '4', nickname: 'X4', avatarUrl: 'https://cdn.example.test/4.jpg', profileUrl: 'https://x.com/u4', status: 'VALID', authMode: 'cookie' as const, updatedAt: '2026-11-21T09:00:00.000Z' },
  };

  await env.apiJson('PUT', '/api/workspace-state', {
    rules: [],
    servers: [],
    alerts: [],
    targetProfiles,
  });

  const getResp = await env.apiJson<{ ok: boolean; state: ContractWorkspaceState }>('GET', '/api/workspace-state');
  assert.equal(getResp.status, 200);
  assert.deepEqual(getResp.data.state.targetProfiles, targetProfiles);
});

test('T1-F2-03: Subsequent PUT /api/workspace-state omitting targetProfiles preserves existing targetProfiles', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  const initialProfiles = {
    'FACEBOOK::100064789123456': {
      id: '100064789123456',
      nickname: 'Preserved FB',
      avatarUrl: 'https://cdn.example.test/fb_pres.jpg',
      profileUrl: 'https://www.facebook.com/profile.php?id=100064789123456',
      status: 'VALID',
      authMode: 'anonymous' as const,
      updatedAt: '2026-11-21T09:00:00.000Z',
    },
  };

  await env.apiJson('PUT', '/api/workspace-state', {
    rules: [],
    servers: [],
    alerts: [],
    targetProfiles: initialProfiles,
  });

  await env.apiJson('PUT', '/api/workspace-state', {
    rules: [makeRule({ id: 'r2', keyword: '@new_user', platform: 'reddit' })],
  });

  const getResp = await env.apiJson<{ ok: boolean; state: ContractWorkspaceState }>('GET', '/api/workspace-state');
  assert.equal(getResp.status, 200);
  assert.equal(getResp.data.state.rules.length, 1);
  assert.deepEqual(getResp.data.state.targetProfiles, initialProfiles);
});

test('T1-F2-04: Validate-to-Workspace persistence round-trip preserves exact avatar and profile metadata', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  env.mocks.x.set('x_roundtrip', {
    id: '99887766',
    nickname: 'Roundtrip X',
    avatarUrl: 'https://pbs.twimg.com/profile_images/99/rt_normal.jpg',
  });

  const val = await env.apiJson<{ ok: boolean; result: ContractUserValidationResult }>(
    'POST',
    '/api/user/validate',
    { target: '@x_roundtrip', platform: 'X' }
  );
  assert.equal(val.data.result.valid, true);

  const key = `X::${val.data.result.username.toLowerCase()}`;
  const meta = {
    id: val.data.result.id,
    nickname: val.data.result.nickname,
    avatarUrl: val.data.result.avatarUrl,
    profileUrl: val.data.result.profileUrl,
    status: val.data.result.status,
    authMode: val.data.result.authMode,
    updatedAt: new Date().toISOString(),
  };

  await env.apiJson('PUT', '/api/workspace-state', {
    rules: [makeRule({ id: 'rule_x_rt', keyword: '@x_roundtrip', platform: 'bluesky', sourceDomain: 'x.com' })],
    targetProfiles: { [key]: meta },
  });

  const ws = await env.apiJson<{ ok: boolean; state: ContractWorkspaceState }>('GET', '/api/workspace-state');
  assert.deepEqual(ws.data.state.targetProfiles?.[key], meta);
});

test('T1-F2-05: PUT /api/workspace-state saves multi-platform cookies and tracking settings alongside targetProfiles', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  const putResp = await env.apiJson<{ ok: boolean; state: ContractWorkspaceState }>('PUT', '/api/workspace-state', {
    rules: [],
    servers: [],
    alerts: [],
    scannerSettings: {
      cookies: {
        tiktok: 'sessionid=tt_ck',
        instagram: 'sessionid=ig_ck; ds_user_id=1',
        facebook: 'c_user=1; xs=fb_ck',
        x: 'auth_token=x_ck; ct0=csrf_ck',
      },
      pollIntervalSeconds: 45,
      deduplicateLive: false,
      platforms: {
        instagram: { liveEnabled: true, postEnabled: true, storyEnabled: true, liveIntervalSeconds: 30, postIntervalSeconds: 120, storyIntervalSeconds: 180 },
      },
    },
    targetProfiles: {
      'TIKTOK::creator_a': {
        profileUrl: 'https://www.tiktok.com/@creator_a',
        updatedAt: '2026-11-21T09:00:00.000Z',
      },
    },
  });

  assert.equal(putResp.status, 200);
  assert.equal(putResp.data.state.scannerSettings.cookies.instagram, 'sessionid=ig_ck; ds_user_id=1');
  assert.equal(putResp.data.state.scannerSettings.cookies.facebook, 'c_user=1; xs=fb_ck');
  assert.equal(putResp.data.state.scannerSettings.cookies.x, 'auth_token=x_ck; ct0=csrf_ck');
  assert.equal(putResp.data.state.scannerSettings.platforms?.instagram.postIntervalSeconds, 120);
  assert.ok(putResp.data.state.targetProfiles?.['TIKTOK::creator_a']);
});

// ============================================================================
// Feature 3: R2 Multi-Platform Collectors (6 tests)
// ============================================================================

test('T1-F3-01: InstagramPostCollector parses posts/reels and returns OK diagnostics with cookie', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  env.mocks.instagram.set('ig_post_col', {
    id: '5511001',
    nickname: 'IG Post Creator',
    avatarUrl: 'https://cdn.example.test/ig_pc.jpg',
    requireCookie: true,
    posts: [
      {
        id: '33001122',
        title: 'Reel New Launch',
        videoUrl: 'https://cdn.example.test/ig_reel_33001122.mp4',
        coverUrl: 'https://cdn.example.test/ig_reel_33001122.jpg',
      },
    ],
  });

  const mod = await loadContractModule<{
    InstagramPostCollector: new (opts?: { cookie?: string }) => ContractPlatformCollector;
  }>('server/watchers/collectors/instagramPost.ts');
  const collector = new mod.InstagramPostCollector({ cookie: 'sessionid=ig_col_ck; ds_user_id=5511001' });

  const diag: ContractCollectorFetchResult = collector.fetchWithDiagnostics
    ? await collector.fetchWithDiagnostics('ig_post_col')
    : { status: 'OK', events: await collector.fetch('ig_post_col') };

  assert.equal(diag.status, 'OK');
  assert.ok(diag.events.length >= 1, 'Expected at least 1 Instagram post event');
  assert.equal(diag.events[0].platform, 'INSTAGRAM');
  assert.equal(diag.events[0].eventType, 'post');
  assert.equal(diag.events[0].itemId, '33001122');
  assert.equal(diag.events[0].title, 'Reel New Launch');
  assert.equal(diag.events[0].url, 'https://www.instagram.com/p/IG_33001122/');
  assert.equal(diag.events[0].metadata?.videoUrl, 'https://cdn.example.test/ig_reel_33001122.mp4');
  assert.ok(env.recordedRequests.some((r) => r.headers.cookie?.includes('ig_col_ck')));
});

test('T1-F3-02: InstagramStoryCollector resolves userId and parses story media', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  env.mocks.instagram.set('ig_story_col', {
    id: '5511002',
    nickname: 'IG Story Creator',
    avatarUrl: 'https://cdn.example.test/ig_sc.jpg',
    requireCookie: true,
    stories: [
      {
        id: '99110022',
        title: 'Morning IG Story',
        videoUrl: 'https://cdn.example.test/ig_story_99110022.mp4',
        coverUrl: 'https://cdn.example.test/ig_story_99110022.jpg',
      },
    ],
  });

  const mod = await loadContractModule<{
    InstagramStoryCollector: new (opts?: { cookie?: string }) => ContractPlatformCollector;
  }>('server/watchers/collectors/instagramStory.ts');
  const collector = new mod.InstagramStoryCollector({ cookie: 'sessionid=ig_story_ck; ds_user_id=5511002' });

  const diag: ContractCollectorFetchResult = collector.fetchWithDiagnostics
    ? await collector.fetchWithDiagnostics('ig_story_col')
    : { status: 'OK', events: await collector.fetch('ig_story_col') };

  assert.equal(diag.status, 'OK');
  assert.equal(diag.events.length, 1);
  assert.equal(diag.events[0].platform, 'INSTAGRAM');
  assert.equal(diag.events[0].eventType, 'story');
  assert.equal(diag.events[0].itemId, '99110022');
  assert.ok(diag.events[0].title && diag.events[0].title.includes('@ig_story_col'));
  assert.equal(diag.events[0].url, 'https://www.instagram.com/stories/ig_story_col/99110022/');
  assert.equal(diag.events[0].metadata?.videoUrl, 'https://cdn.example.test/ig_story_99110022.mp4');
  assert.ok(
    env.recordedRequests.some(
      (r) => r.hostname.includes('instagram.com') && r.headers.cookie?.includes('ig_story_ck')
    ),
    'Expected Instagram story request to include Cookie header with ig_story_ck'
  );
});

test('T1-F3-03: FacebookPostCollector parses posts with cookie and Sec-Fetch headers', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  env.mocks.facebook.set('fb_post_col', {
    id: '100088001',
    nickname: 'FB Post Creator',
    avatarUrl: 'https://cdn.example.test/fb_pc.jpg',
    requireCookie: true,
    posts: [
      {
        id: 'pfbid02post1',
        title: 'FB Video Post',
        videoUrl: 'https://cdn.example.test/fb_post1.mp4',
      },
    ],
  });

  const mod = await loadContractModule<{
    FacebookPostCollector: new (opts?: { cookie?: string }) => ContractPlatformCollector;
  }>('server/watchers/collectors/facebookPost.ts');
  const collector = new mod.FacebookPostCollector({ cookie: 'c_user=100088001; xs=fb_secret' });

  const diag: ContractCollectorFetchResult = collector.fetchWithDiagnostics
    ? await collector.fetchWithDiagnostics('fb_post_col')
    : { status: 'OK', events: await collector.fetch('fb_post_col') };

  assert.equal(diag.status, 'OK');
  assert.ok(diag.events.length >= 1, 'Expected at least 1 Facebook post event');
  assert.equal(diag.events[0].platform, 'FACEBOOK');
  assert.equal(diag.events[0].eventType, 'post');
  assert.equal(diag.events[0].itemId, 'pfbid02post1');
  assert.equal(diag.events[0].title, 'FB Video Post');
  assert.equal(diag.events[0].metadata?.videoUrl, 'https://cdn.example.test/fb_post1.mp4');
  assert.ok(
    env.recordedRequests.some(
      (r) =>
        r.hostname.includes('facebook.com') &&
        r.headers.cookie?.includes('c_user=100088001') &&
        r.headers['sec-fetch-mode'] === 'navigate' &&
        r.headers['sec-fetch-site'] === 'none' &&
        r.headers['sec-fetch-dest'] === 'document'
    ),
    'Expected Facebook post request with Cookie and Sec-Fetch-Mode/Site/Dest headers'
  );
});

test('T1-F3-04: FacebookStoryCollector parses story bucket items with cookie', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  env.mocks.facebook.set('fb_story_col', {
    id: '100088002',
    nickname: 'FB Story Creator',
    avatarUrl: 'https://cdn.example.test/fb_sc.jpg',
    requireCookie: true,
    stories: [
      {
        id: 'fb_story_771',
        title: 'FB Daily Story',
        videoUrl: 'https://cdn.example.test/fb_story_771.mp4',
      },
    ],
  });

  const mod = await loadContractModule<{
    FacebookStoryCollector: new (opts?: { cookie?: string }) => ContractPlatformCollector;
  }>('server/watchers/collectors/facebookStory.ts');
  const collector = new mod.FacebookStoryCollector({ cookie: 'c_user=100088002; xs=fb_st_secret' });

  const diag: ContractCollectorFetchResult = collector.fetchWithDiagnostics
    ? await collector.fetchWithDiagnostics('fb_story_col')
    : { status: 'OK', events: await collector.fetch('fb_story_col') };

  assert.equal(diag.status, 'OK');
  assert.ok(diag.events.length >= 1, 'Expected at least 1 Facebook story event');
  assert.equal(diag.events[0].platform, 'FACEBOOK');
  assert.equal(diag.events[0].eventType, 'story');
  assert.equal(diag.events[0].itemId, 'fb_story_771');
  assert.equal(diag.events[0].metadata?.videoUrl, 'https://cdn.example.test/fb_story_771.mp4');
  assert.ok(
    env.recordedRequests.some(
      (r) => r.hostname.includes('facebook.com') && r.headers.cookie?.includes('c_user=100088002')
    ),
    'Expected Facebook story request to include Cookie header with c_user=100088002'
  );
});

test('T1-F3-05: XPostCollector skips pinned tweets and extracts highest-bitrate video tweet', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  env.mocks.x.set('x_post_col', {
    id: '190000000000099',
    nickname: 'X Creator',
    avatarUrl: 'https://pbs.twimg.com/profile_images/1/x_normal.jpg',
    requireCookie: true,
    posts: [
      {
        id: '1800000000000000001',
        title: 'Pinned Announcement',
        isPinned: true,
        photoUrls: ['https://cdn.example.test/pinned.jpg'],
      },
      {
        id: '1800000000000000002',
        title: 'Fresh Video Tweet',
        isPinned: false,
        videoUrl: 'https://cdn.example.test/x_hd_1800000000000000002.mp4',
      },
    ],
  });

  const mod = await loadContractModule<{
    XPostCollector: new (opts?: { cookie?: string; skipPinned?: boolean }) => ContractPlatformCollector;
  }>('server/watchers/collectors/xPost.ts');
  const collector = new mod.XPostCollector({ cookie: 'auth_token=atk_col; ct0=csrf_col', skipPinned: true });

  const diag: ContractCollectorFetchResult = collector.fetchWithDiagnostics
    ? await collector.fetchWithDiagnostics('x_post_col')
    : { status: 'OK', events: await collector.fetch('x_post_col') };

  assert.equal(diag.status, 'OK');
  assert.equal(diag.events.length, 1, 'Pinned tweet must be skipped, leaving only the new unpinned tweet');
  assert.equal(diag.events[0].platform, 'X');
  assert.equal(diag.events[0].eventType, 'post');
  assert.equal(diag.events[0].itemId, '1800000000000000002');
  assert.equal(diag.events[0].metadata?.videoUrl, 'https://cdn.example.test/x_hd_1800000000000000002.mp4');
});

test('T1-F3-06: Multi-platform live collectors emit live events with platform and stable itemId', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  env.mocks.instagram.set('ig_live_col', {
    id: '5511009',
    nickname: 'IG Live',
    avatarUrl: 'https://cdn.example.test/ig_live.jpg',
    live: { broadcastId: '18099887766', title: 'IG Live Q&A', streamUrl: 'https://cdn.example.test/ig_live.mpd' },
  });
  env.mocks.facebook.set('fb_live_col', {
    id: '100088009',
    nickname: 'FB Live',
    avatarUrl: 'https://cdn.example.test/fb_live.jpg',
    live: { title: 'FB Live Stream', streamUrl: 'https://cdn.example.test/fb_live.mpd' },
  });
  env.mocks.x.set('x_live_col', {
    id: '190000000000109',
    nickname: 'X Live',
    avatarUrl: 'https://pbs.twimg.com/profile_images/2/xlive_normal.jpg',
    live: {
      broadcastId: '1dRKZlaqAbCxB',
      mediaKey: '28_180998877',
      title: 'X Live Broadcast',
      streamUrl: 'https://cdn.example.test/x_live.m3u8',
    },
  });

  const mod = await loadContractModule<{
    InstagramLiveCollector: new (opts?: { cookie?: string }) => ContractPlatformCollector;
    FacebookLiveCollector: new (opts?: { cookie?: string }) => ContractPlatformCollector;
    XLiveCollector: new (opts?: { cookie?: string }) => ContractPlatformCollector;
  }>('server/watchers/collectors/platformLive.ts');

  const igEvents1 = await new mod.InstagramLiveCollector().fetch('ig_live_col');
  const igEvents2 = await new mod.InstagramLiveCollector().fetch('ig_live_col');
  assert.equal(igEvents1.length, 1);
  assert.equal(igEvents1[0].platform, 'INSTAGRAM');
  assert.equal(igEvents1[0].eventType, 'live');
  assert.ok(igEvents1[0].streamUrl);
  assert.equal(igEvents1[0].itemId, igEvents2[0].itemId, 'Live itemId must be deterministic across repeated polls');

  const fbEvents1 = await new mod.FacebookLiveCollector().fetch('fb_live_col');
  const fbEvents2 = await new mod.FacebookLiveCollector().fetch('fb_live_col');
  assert.equal(fbEvents1.length, 1);
  assert.equal(fbEvents1[0].platform, 'FACEBOOK');
  assert.equal(fbEvents1[0].eventType, 'live');
  assert.ok(fbEvents1[0].streamUrl);
  assert.equal(fbEvents1[0].itemId, fbEvents2[0].itemId);

  const xEvents1 = await new mod.XLiveCollector().fetch('x_live_col');
  const xEvents2 = await new mod.XLiveCollector().fetch('x_live_col');
  assert.equal(xEvents1.length, 1);
  assert.equal(xEvents1[0].platform, 'X');
  assert.equal(xEvents1[0].eventType, 'live');
  assert.ok(xEvents1[0].streamUrl);
  assert.equal(xEvents1[0].itemId, xEvents2[0].itemId);
});

// ============================================================================
// Feature 4: R2 MultiPlatformWatcher Scheduling, Warmup, Dedup & Status (5 tests)
// ============================================================================

test('T1-F4-01: Server-wired watcher scans posts and stories across all 4 platforms and downloads media', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  env.mocks.tiktok.set('tt_w1', {
    id: '701',
    nickname: 'TT W1',
    avatarUrl: 'https://cdn.example.test/tt_w1.jpg',
    stories: [{ id: 'tt_st_1', title: 'TT Story 1', videoUrl: 'https://cdn.example.test/tt_st_1.mp4' }],
  });
  env.mocks.instagram.set('ig_w1', {
    id: '702',
    nickname: 'IG W1',
    avatarUrl: 'https://cdn.example.test/ig_w1.jpg',
    stories: [{ id: 'ig_st_1', title: 'IG Story 1', videoUrl: 'https://cdn.example.test/ig_st_1.mp4' }],
  });
  env.mocks.facebook.set('fb_w1', {
    id: '703',
    nickname: 'FB W1',
    avatarUrl: 'https://cdn.example.test/fb_w1.jpg',
    stories: [{ id: 'fb_st_1', title: 'FB Story 1', videoUrl: 'https://cdn.example.test/fb_st_1.mp4' }],
  });
  env.mocks.x.set('x_w1', {
    id: '704',
    nickname: 'X W1',
    avatarUrl: 'https://pbs.twimg.com/profile_images/3/xw1_normal.jpg',
    posts: [{ id: 'x_post_1', title: 'X Post 1', videoUrl: 'https://cdn.example.test/x_post_1.mp4' }],
  });

  await env.apiJson('PUT', '/api/workspace-state', {
    rules: [
      makeRule({ id: 'r_tt', keyword: '@tt_w1', platform: 'reddit', sourceDomain: 'tiktok.com' }),
      makeRule({ id: 'r_ig', keyword: '@ig_w1', platform: 'hackernews', sourceDomain: 'instagram.com' }),
      makeRule({ id: 'r_fb', keyword: '@fb_w1', platform: 'github', sourceDomain: 'facebook.com' }),
      makeRule({ id: 'r_x', keyword: '@x_w1', platform: 'bluesky', sourceDomain: 'x.com' }),
    ],
    servers: [makeSandboxServer()],
    alerts: [],
  });

  // Stories capture immediately (no warmup suppression); posts warm up on cycle 1 then detect new on cycle 2
  await env.triggerWatcherCycle('story');
  await env.triggerWatcherCycle('post');

  env.mocks.x.get('x_w1')!.posts!.push({
    id: 'x_post_2',
    title: 'X Post 2 New',
    videoUrl: 'https://cdn.example.test/x_post_2.mp4',
  });
  await env.triggerWatcherCycle('post');

  const mediaResp = await env.apiJson<{ ok: boolean; count: number; media: Array<{ fileName: string; downloadUrl: string }> }>(
    'GET',
    '/api/media/downloaded'
  );
  assert.equal(mediaResp.status, 200);
  assert.ok(
    mediaResp.data.count >= 4,
    `Expected >= 4 downloaded media files across TT/IG/FB stories and X post, got ${mediaResp.data.count}`
  );
});

test('T1-F4-02: MultiPlatformWatcher warms up initial posts without alerts, then notifies on new post', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  env.mocks.instagram.set('ig_warmup_u1', {
    id: '801',
    nickname: 'IG Warmup',
    avatarUrl: 'https://cdn.example.test/ig_wu.jpg',
    posts: [{ id: 'ig_old_1', title: 'Baseline Old Post', videoUrl: 'https://cdn.example.test/ig_old_1.mp4' }],
  });

  await env.apiJson('PUT', '/api/workspace-state', {
    rules: [makeRule({ id: 'r_ig_wu', keyword: '@ig_warmup_u1', platform: 'hackernews', sourceDomain: 'instagram.com' })],
    servers: [makeSandboxServer()],
    alerts: [],
  });

  await env.triggerWatcherCycle('post');

  const pollAfterWarmup = await env.apiJson<{ ok: boolean; notifications: PendingDeviceNotification[] }>(
    'GET',
    '/api/android/poll?deviceId=sm_n770f_default'
  );
  assert.equal(pollAfterWarmup.data.notifications.length, 0, 'Warmup cycle must not queue notifications');

  // Add a brand new post and run cycle 2
  env.mocks.instagram.get('ig_warmup_u1')!.posts!.unshift({
    id: 'ig_new_2',
    title: 'New IG Post',
    videoUrl: 'https://cdn.example.test/ig_new_2.mp4',
  });
  await env.triggerWatcherCycle('post');

  const pollAfterNew = await env.apiJson<{ ok: boolean; notifications: PendingDeviceNotification[] }>(
    'GET',
    '/api/android/poll?deviceId=sm_n770f_default'
  );
  assert.equal(pollAfterNew.data.notifications.length, 1);
  assert.equal(pollAfterNew.data.notifications[0].platform, 'INSTAGRAM');
  assert.equal(pollAfterNew.data.notifications[0].itemId, 'ig_new_2');
});

test('T1-F4-03: MultiPlatformWatcher deduplicates repeated story and post itemIds across cycles', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  env.mocks.facebook.set('fb_dedup_u1', {
    id: '802',
    nickname: 'FB Dedup',
    avatarUrl: 'https://cdn.example.test/fb_dd.jpg',
    stories: [{ id: 'fb_dedup_st1', title: 'Single Story', videoUrl: 'https://cdn.example.test/fb_dd_st1.mp4' }],
  });

  await env.apiJson('PUT', '/api/workspace-state', {
    rules: [makeRule({ id: 'r_fb_dd', keyword: '@fb_dedup_u1', platform: 'github', sourceDomain: 'facebook.com' })],
    servers: [makeSandboxServer()],
    alerts: [],
  });

  await env.triggerWatcherCycle('story');
  await env.triggerWatcherCycle('story');

  const poll = await env.apiJson<{ ok: boolean; notifications: PendingDeviceNotification[] }>(
    'GET',
    '/api/android/poll?deviceId=sm_n770f_default'
  );
  const matching = poll.data.notifications.filter((n) => n.itemId === 'fb_dedup_st1');
  assert.equal(matching.length, 1, 'Duplicate story itemId must only notify once');
});

test('T1-F4-04: GET /api/watcher/status preserves legacy fields and reports multi-platform diagnostics', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  env.mocks.instagram.set('ig_stat_u1', {
    id: '803',
    nickname: 'IG Status',
    avatarUrl: 'https://cdn.example.test/ig_st.jpg',
    stories: [{ id: 'ig_st_stat1', title: 'Status Story', videoUrl: 'https://cdn.example.test/ig_st_stat1.mp4' }],
  });

  await env.apiJson('PUT', '/api/workspace-state', {
    rules: [makeRule({ id: 'r_ig_stat', keyword: '@ig_stat_u1', platform: 'hackernews', sourceDomain: 'instagram.com' })],
    servers: [makeSandboxServer()],
    alerts: [],
  });

  await env.triggerWatcherCycle('story');

  const statusResp = await env.apiJson<ContractWatcherStatusResponse>('GET', '/api/watcher/status');
  assert.equal(statusResp.status, 200);
  assert.equal(statusResp.data.success, true);
  assert.equal(typeof statusResp.data.running, 'boolean');
  assert.ok(statusResp.data.health && typeof statusResp.data.health === 'object');
  assert.equal(typeof statusResp.data.metrics.seenEventsCount, 'number');
  assert.equal(typeof statusResp.data.metrics.trackedUsersCount, 'number');
  assert.ok(statusResp.data.metrics.seenEventsCount >= 1);
  assert.ok(
    Array.isArray(statusResp.data.diagnostics) || Boolean(statusResp.data.platforms),
    'Expected /api/watcher/status to expose diagnostics or platforms summary'
  );
});

test('T1-F4-05: MultiPlatformWatcher honors scannerSettings.platforms intervals and enabled flags', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  env.mocks.instagram.set('ig_cfg_u1', {
    id: '804',
    nickname: 'IG Cfg',
    avatarUrl: 'https://cdn.example.test/ig_cfg.jpg',
    stories: [{ id: 'ig_cfg_st1', title: 'Story', videoUrl: 'https://cdn.example.test/ig_cfg_st1.mp4' }],
  });

  await env.apiJson('PUT', '/api/workspace-state', {
    rules: [makeRule({ id: 'r_ig_cfg', keyword: '@ig_cfg_u1', platform: 'hackernews', sourceDomain: 'instagram.com' })],
    servers: [],
    alerts: [],
    scannerSettings: {
      cookies: { tiktok: '', instagram: '', facebook: '', x: '' },
      pollIntervalSeconds: 30,
      deduplicateLive: true,
      platforms: {
        instagram: {
          liveEnabled: false,
          postEnabled: true,
          storyEnabled: true,
          liveIntervalSeconds: 75,
          postIntervalSeconds: 150,
          storyIntervalSeconds: 210,
        },
      },
    },
  });

  await env.triggerWatcherCycle('live');
  const igLiveReqs = env.recordedRequests.filter((r) => r.hostname.includes('instagram.com'));
  assert.equal(igLiveReqs.length, 0, 'Disabled Instagram liveEnabled=false must skip IG live polling');

  await env.triggerWatcherCycle('story');
  const igStoryReqs = env.recordedRequests.filter((r) => r.hostname.includes('instagram.com'));
  assert.ok(igStoryReqs.length > 0, 'Enabled Instagram storyEnabled=true must poll IG stories');
});

// ============================================================================
// Feature 5: R2 Platform-Aware MediaDownloader, Storage & Notifier (5 tests)
// ============================================================================

test('T1-F5-01: MediaDownloader downloads multi-platform media and /api/media/file streams exact bytes', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  const igBytes = Buffer.from('IG_REEL_MP4_PAYLOAD_001');
  const fbBytes = Buffer.from('FB_STORY_MP4_PAYLOAD_002');
  const xBytes = Buffer.from('X_TWEET_MP4_PAYLOAD_003');
  env.mocks.cdnAssets.set('https://cdn.example.test/t1_ig.mp4', { status: 200, contentType: 'video/mp4', body: igBytes });
  env.mocks.cdnAssets.set('https://cdn.example.test/t1_fb.mp4', { status: 200, contentType: 'video/mp4', body: fbBytes });
  env.mocks.cdnAssets.set('https://cdn.example.test/t1_x.mp4', { status: 200, contentType: 'video/mp4', body: xBytes });

  const downloader = createMediaDownloader({ storageRoot: env.mediaDir, timeoutMs: 5000 });

  const events: ContractWatcherEvent[] = [
    {
      platform: 'INSTAGRAM',
      username: 'ig_dl_u1',
      eventType: 'post',
      itemId: 'ig_dl_1',
      url: 'https://www.instagram.com/p/ig_dl_1/',
      title: 'IG Post',
      detectedAt: new Date().toISOString(),
      metadata: { videoUrl: 'https://cdn.example.test/t1_ig.mp4' },
    },
    {
      platform: 'FACEBOOK',
      username: 'fb_dl_u1',
      eventType: 'story',
      itemId: 'fb_dl_1',
      url: 'https://www.facebook.com/stories/fb_dl_1',
      title: 'FB Story',
      detectedAt: new Date().toISOString(),
      metadata: { videoUrl: 'https://cdn.example.test/t1_fb.mp4' },
    },
    {
      platform: 'X',
      username: 'x_dl_u1',
      eventType: 'post',
      itemId: 'x_dl_1',
      url: 'https://x.com/x_dl_u1/status/x_dl_1',
      title: 'X Video',
      detectedAt: new Date().toISOString(),
      metadata: { videoUrl: 'https://cdn.example.test/t1_x.mp4' },
    },
  ];

  for (const ev of events) {
    const res = await downloader.downloadEventMedia(asTikTokEvent(ev));
    assert.equal(res.success, true);
    assert.equal(res.files.length, 1);
    assert.ok(fs.existsSync(res.files[0].path));
  }

  const listResp = await env.apiJson<{
    ok: boolean;
    count: number;
    media: Array<{ fileName: string; downloadUrl: string; size: number }>;
  }>('GET', '/api/media/downloaded');

  assert.equal(listResp.status, 200);
  assert.equal(listResp.data.count, 3);

  const allText = await Promise.all(
    listResp.data.media.map(async (m) => {
      const r = await fetch(`${env.server.url}${m.downloadUrl}`);
      assert.equal(r.status, 200);
      return Buffer.from(await r.arrayBuffer()).toString('utf-8');
    })
  );

  assert.ok(allText.includes(igBytes.toString('utf-8')));
  assert.ok(allText.includes(fbBytes.toString('utf-8')));
  assert.ok(allText.includes(xBytes.toString('utf-8')));
});

test('T1-F5-02: StorageManager + TelegramService uploads media with platform badge in HTML caption', async (t) => {
  const env = await createR1R2TestEnv({
    telegram: { botToken: 'mock_bot_token', chatId: '-1004484723209', enabled: true },
  });
  t.after(() => env.cleanup());

  const sampleFile = path.join(env.tempDir, 'ig_clip.mp4');
  fs.writeFileSync(sampleFile, Buffer.from('TELEGRAM_UPLOAD_VIDEO_BYTES'));

  const tg = createTelegramService({ botToken: 'mock_bot_token', chatId: '-1004484723209', enabled: true });
  const storage = createStorageManager({ telegramService: tg, localStorageRoot: env.mediaDir });

  const uploadParams: ContractStorageUploadParams = {
    localFilePath: sampleFile,
    fileName: 'ig_clip.mp4',
    fileSize: fs.statSync(sampleFile).size,
    mimeType: 'video/mp4',
    username: 'tg_creator',
    eventType: 'post',
    platform: 'INSTAGRAM',
    title: 'New IG Video',
    sourceUrl: 'https://www.instagram.com/p/abc/',
  };

  const res = await storage.uploadMedia(uploadParams as unknown as StorageUploadParams);
  assert.ok(res.telegramLink, 'Expected telegramLink from successful Telegram upload');

  const tgReq = env.recordedRequests.find((r) => r.hostname === 'api.telegram.org');
  assert.ok(tgReq, 'Expected POST request to api.telegram.org');
  assert.equal(tgReq.formFields?.chat_id, '-1004484723209');
  assert.equal(tgReq.formFields?.parse_mode, 'HTML');
  assert.equal(tgReq.formFiles?.length, 1);
  assert.equal(tgReq.formFiles?.[0]?.name, 'ig_clip.mp4');
  assert.ok(
    tgReq.formFields?.caption?.toUpperCase().includes('INSTAGRAM'),
    `Expected Telegram caption to include platform INSTAGRAM, got: ${tgReq.formFields?.caption}`
  );
  assert.ok(
    tgReq.formFields?.caption?.includes('@tg_creator'),
    `Expected Telegram caption to include @tg_creator, got: ${tgReq.formFields?.caption}`
  );
  assert.ok(
    tgReq.formFields?.caption?.includes('New IG Video'),
    `Expected Telegram caption to include 'New IG Video', got: ${tgReq.formFields?.caption}`
  );
});

test('T1-F5-03: Notifier tags WebhookEventPayload and PendingDeviceNotification with event platform', async (t) => {
  const receivedWebhooks: WebhookEventPayload[] = [];
  const webhookSrv = await startLocalHttpServer((_req, bodyText, res) => {
    receivedWebhooks.push(JSON.parse(bodyText) as WebhookEventPayload);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
  t.after(() => webhookSrv.close());

  const queuedPending: PendingDeviceNotification[] = [];
  const notifier = new Notifier({
    webhookUrl: `${webhookSrv.url}/hook`,
    retryDelaysMs: [10],
    onPendingNotification: async (notif) => {
      queuedPending.push(notif);
    },
  });

  const platforms = ['INSTAGRAM', 'FACEBOOK', 'X', 'TIKTOK'] as const;
  for (const p of platforms) {
    const evt: ContractWatcherEvent = {
      platform: p,
      username: `u_${p.toLowerCase()}`,
      eventType: 'post',
      itemId: `id_${p}`,
      url: `https://example.com/${p}/id_${p}`,
      title: `Title ${p}`,
      detectedAt: '2026-11-21T09:00:00.000Z',
    };
    const res = await notifier.notify(asTikTokEvent(evt));
    assert.equal(res.status, 'delivered');
  }

  assert.deepEqual(
    receivedWebhooks.map((w) => w.platform),
    ['INSTAGRAM', 'FACEBOOK', 'X', 'TIKTOK']
  );
  assert.deepEqual(
    queuedPending.map((n) => n.platform),
    ['INSTAGRAM', 'FACEBOOK', 'X', 'TIKTOK']
  );
});

test('T1-F5-04: POST /api/scan dispatches multi-platform webhook formats to /api/webhook-sandbox', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  const formats = ['json', 'discord', 'slack', 'telegram'] as const;
  const servers = formats.map((fmt) => makeSandboxServer(`srv_${fmt}`, fmt));
  const rules = [
    makeRule({ id: 'r_json', keyword: '@u_ig', platform: 'hackernews', sourceDomain: 'instagram.com', webhookServerId: 'srv_json' }),
    makeRule({ id: 'r_discord', keyword: '@u_fb', platform: 'github', sourceDomain: 'facebook.com', webhookServerId: 'srv_discord' }),
    makeRule({ id: 'r_slack', keyword: '@u_x', platform: 'bluesky', sourceDomain: 'x.com', webhookServerId: 'srv_slack' }),
    makeRule({ id: 'r_tg', keyword: '@u_tt', platform: 'reddit', sourceDomain: 'tiktok.com', webhookServerId: 'srv_telegram' }),
  ];

  const scanResp = await env.apiJson<{ ok: boolean; detections: Array<{ webhookStatus: string; httpStatusCode: number }> }>(
    'POST',
    '/api/scan',
    {
      rules,
      servers,
      customSampleText: 'Test multi-platform broadcast @u_ig @u_fb @u_x @u_tt',
      simulatedActivityType: 'post',
    }
  );

  assert.equal(scanResp.status, 200);
  assert.equal(scanResp.data.ok, true);
  assert.equal(scanResp.data.detections.length, 4);
  for (const det of scanResp.data.detections) {
    assert.equal(det.webhookStatus, 'delivered');
    assert.equal(det.httpStatusCode, 200);
  }

  const logsResp = await env.apiJson<{ receipts: Array<{ channel: string; payload: Record<string, unknown> }> }>(
    'GET',
    '/api/webhook-sandbox/logs'
  );
  assert.equal(logsResp.status, 200);
  assert.equal(logsResp.data.receipts.length, 4);

  const jsonReceipt = logsResp.data.receipts.find((r) => r.channel === 'json');
  const discordReceipt = logsResp.data.receipts.find((r) => r.channel === 'discord');
  const slackReceipt = logsResp.data.receipts.find((r) => r.channel === 'slack');
  const telegramReceipt = logsResp.data.receipts.find((r) => r.channel === 'telegram');

  assert.ok(jsonReceipt, 'Expected json receipt');
  assert.equal(jsonReceipt.payload.event, 'social.keyword.detected');
  assert.ok(jsonReceipt.payload.activity && typeof jsonReceipt.payload.activity === 'object');

  assert.ok(discordReceipt, 'Expected discord receipt');
  assert.ok(Array.isArray(discordReceipt.payload.embeds) && discordReceipt.payload.embeds.length >= 1);

  assert.ok(slackReceipt, 'Expected slack receipt');
  assert.ok(typeof slackReceipt.payload.text === 'string' && slackReceipt.payload.text.length > 0);
  assert.ok(Array.isArray(slackReceipt.payload.blocks) && slackReceipt.payload.blocks.length >= 1);

  assert.ok(telegramReceipt, 'Expected telegram receipt');
  assert.equal(telegramReceipt.payload.parse_mode, 'HTML');
  assert.ok(typeof telegramReceipt.payload.text === 'string' && telegramReceipt.payload.text.length > 0);
});

test('T1-F5-05: Android sync/poll/ack flow delivers and acknowledges multi-platform media notifications', async (t) => {
  const env = await createR1R2TestEnv();
  t.after(() => env.cleanup());

  env.mocks.facebook.set('fb_android_u1', {
    id: '905',
    nickname: 'FB Android',
    avatarUrl: 'https://cdn.example.test/fb_and.jpg',
    stories: [{ id: 'fb_and_st1', title: 'FB Story For Android', videoUrl: 'https://cdn.example.test/fb_and_st1.mp4' }],
  });

  await env.apiJson('POST', '/api/android/register', {
    deviceId: 'sm_n770f_default',
    ip: '192.168.1.50',
    port: 8765,
    appVersion: '2.0.0',
  });

  await env.apiJson('PUT', '/api/workspace-state', {
    rules: [makeRule({ id: 'r_fb_and', keyword: '@fb_android_u1', platform: 'github', sourceDomain: 'facebook.com' })],
    servers: [],
    alerts: [],
  });

  await env.triggerWatcherCycle('story');

  const poll = await env.apiJson<{ ok: boolean; notifications: PendingDeviceNotification[] }>(
    'GET',
    '/api/android/poll?deviceId=sm_n770f_default'
  );
  assert.equal(poll.status, 200);
  const fbNotif = poll.data.notifications.find((n) => n.itemId === 'fb_and_st1');
  assert.ok(fbNotif, 'Expected Facebook story notification in /api/android/poll response');
  assert.equal(fbNotif.platform, 'FACEBOOK');
  assert.equal(fbNotif.type, 'STORY_DOWNLOADED');

  const ackResp = await env.apiJson<{ ok: boolean }>('POST', '/api/android/poll/ack', {
    deviceId: 'sm_n770f_default',
    notificationIds: [fbNotif.id],
  });
  assert.equal(ackResp.status, 200);

  const pollAfterAck = await env.apiJson<{ ok: boolean; notifications: PendingDeviceNotification[] }>(
    'GET',
    '/api/android/poll?deviceId=sm_n770f_default'
  );
  assert.equal(pollAfterAck.data.notifications.some((n) => n.id === fbNotif.id), false);

  // Also verify /api/android/sync delivers queued notifications and drains them
  await env.apiJson('POST', '/api/android/notify', {
    type: 'POST_DOWNLOADED',
    eventType: 'post',
    platform: 'FACEBOOK',
    username: 'fb_android_u1',
    title: 'Sync Post Check',
    itemId: 'fb_and_sync_1',
  });
  const syncResp = await env.apiJson<{ ok: boolean; notifications: PendingDeviceNotification[] }>(
    'POST',
    '/api/android/sync',
    { deviceId: 'sm_n770f_default', users: [] }
  );
  assert.equal(syncResp.status, 200);
  assert.ok(syncResp.data.notifications.some((n) => n.itemId === 'fb_and_sync_1'));
});
