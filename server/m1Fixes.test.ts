import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApp, startServer } from '../server';
import { createAutoScanner } from './autoScanner';
import { createAndroidClient } from './androidClient';
import { checkFacebookLive } from './liveCheckers/facebookChecker';
import { checkInstagramLive } from './liveCheckers/instagramChecker';
import { checkTikTokLive } from './liveCheckers/tiktokChecker';
import { checkXBroadcastById, checkXLive } from './liveCheckers/xChecker';
import { createMediaDownloader } from './mediaDownloader';
import { createStateStore, resolveTargetStreamMeta } from './stateStore';
import { StorageManager } from './storage/storageManager';
import { TelegramService } from './storage/telegramService';
import { TikTokStoryCollector } from './watchers/collectors/tiktokStory';
import { XPostCollector } from './watchers/collectors/xPost';
import { clearXGuestTokenCache } from './watchers/collectors/xShared';
import { MultiPlatformWatcher } from './watchers/multiPlatformWatcher';
import { Notifier } from './watchers/notifier';
import { createWatcherStateStore } from './watchers/stateStore';
import type { WatcherEvent } from './watchers/types';

function makeTempDir(t: test.TestContext, prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pulseradar_m1_${prefix}_`));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

// ==========================================
// F2: StateStore Queue, Platforms, TargetStreamMetaMap & Cookie Shadowing
// ==========================================
test('F2: stateStore normalizes platforms, top-level platforms alias, targetStreamMetaMap, and serializes concurrent writes', async (t) => {
  const dir = makeTempDir(t, 'f2_state');
  const store = createStateStore(dir);

  const writes = await Promise.all([
    store.writeWorkspaceState({
      platforms: {
        tiktok: {
          liveEnabled: true,
          postEnabled: true,
          storyEnabled: false,
          liveIntervalSeconds: 45,
          postIntervalSeconds: 180,
          storyIntervalSeconds: 300,
        },
      },
      targetStreamMetaMap: {
        'r1::@alice': { live: true, post: false, story: true, warmup: false },
      },
    } as any),
    store.writeWorkspaceState({
      rules: [
        {
          id: 'r1',
          ownerId: 'demo_user',
          keyword: '@alice',
          excludedKeywords: 'tiktok.com |',
          matchType: 'contains',
          platforms: 'reddit',
          webhookServerId: 'srv_1',
          enabled: true,
          matchCount: 0,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
      ],
    }),
  ]);

  assert.ok(writes[1].updatedAt !== new Date(0).toISOString());
  const finalState = await store.readWorkspaceState();
  assert.equal(finalState.scannerSettings.platforms?.tiktok.liveIntervalSeconds, 45);
  assert.equal(finalState.scannerSettings.platforms?.tiktok.storyEnabled, false);
  assert.equal(finalState.rules.length, 1);
  assert.deepEqual(finalState.targetStreamMetaMap?.['r1::@alice'], {
    live: true,
    post: false,
    story: true,
    warmup: false,
  });
});

test('F2: empty workspace cookie does not shadow envCookies when envCookies is set', async (t) => {
  const dir = makeTempDir(t, 'f2_cookie');
  const store = createStateStore(dir);
  await store.writeWorkspaceState({
    scannerSettings: {
      cookies: { tiktok: '', instagram: '', facebook: '', x: '' },
      pollIntervalSeconds: 30,
      deduplicateLive: true,
    },
  });

  const created = await createApp({
    dataDir: dir,
    mountFrontend: false,
    autoScanEnabled: false,
    envCookies: { tiktok: 'env_tt_session_123' },
  });
  t.after(() => created.close());

  const mpWatcher = created.watcher as MultiPlatformWatcher;
  assert.equal(mpWatcher.getCookie('TIKTOK'), 'env_tt_session_123');
});

// ==========================================
// F3: Watcher Lifecycle, Intervals, Notifier & Target Toggles
// ==========================================
test('F3: MultiPlatformWatcher resolveInterval honors platformSettings and manageLiveLoop=false skips periodic live loop', async (t) => {
  const dir = makeTempDir(t, 'f3_watcher');
  const wsStore = createWatcherStateStore(path.join(dir, 'watcher-state.json'));

  let liveCalls = 0;
  let postCalls = 0;
  let storyCalls = 0;

  const watcher = new MultiPlatformWatcher({
    config: {
      targetsByPlatform: { TIKTOK: ['creator1'], INSTAGRAM: [], FACEBOOK: [], X: [] },
      manageLiveLoop: false,
      enableWarmup: false,
      autoDownloadMedia: false,
      staggerRangeMs: [0, 0],
      platformSettings: {
        tiktok: {
          liveEnabled: true,
          postEnabled: true,
          storyEnabled: true,
          liveIntervalSeconds: 45,
          postIntervalSeconds: 150,
          storyIntervalSeconds: 210,
        },
        instagram: {
          liveEnabled: true,
          postEnabled: false,
          storyEnabled: true,
          liveIntervalSeconds: 90,
          postIntervalSeconds: 240,
          storyIntervalSeconds: 360,
        },
      },
    },
    stateStore: wsStore,
    collectors: {
      TIKTOK: {
        live: {
          name: 'tt_live',
          eventType: 'live',
          fetch: async () => {
            liveCalls++;
            return [];
          },
        },
        post: {
          name: 'tt_post',
          eventType: 'post',
          fetch: async () => {
            postCalls++;
            return [];
          },
        },
        story: {
          name: 'tt_story',
          eventType: 'story',
          fetch: async () => {
            storyCalls++;
            return [];
          },
        },
      },
    },
  });

  assert.equal(watcher.resolveInterval('live'), 45);
  assert.equal(watcher.resolveInterval('post'), 150);
  assert.equal(watcher.resolveInterval('story'), 210);

  watcher.start();
  await new Promise((r) => setTimeout(r, 80));
  await watcher.stop();

  assert.equal(liveCalls, 0, 'manageLiveLoop: false must skip periodic live loop');
  assert.ok(postCalls >= 1, 'post loop should still run');
  assert.ok(storyCalls >= 1, 'story loop should still run');

  // Direct runCycle('live') must still work on demand
  await watcher.runCycle('live');
  assert.equal(liveCalls, 1);
});

test('F3: autoScanner and MultiPlatformWatcher honor targetStreamMetaMap toggles and warmup=false', async (t) => {
  const dir = makeTempDir(t, 'f3_toggles');
  const store = createStateStore(dir);
  const wsStore = createWatcherStateStore(path.join(dir, 'watcher-state.json'));

  const metaMap = {
    'rule_tt::@skip_live': { live: false, post: true, story: true, warmup: false },
    'rule_tt::@run_live': { live: true, post: false, story: false, warmup: true },
  };

  await store.writeWorkspaceState({
    rules: [
      {
        id: 'rule_tt',
        ownerId: 'demo',
        keyword: '@skip_live, @run_live',
        excludedKeywords: 'tiktok.com |',
        matchType: 'contains',
        platforms: 'reddit',
        webhookServerId: 'srv_1',
        enabled: true,
        matchCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
    targetStreamMetaMap: metaMap,
  });

  const checkedLiveTargets: string[] = [];
  const scanner = createAutoScanner({
    stateStore: store,
    androidClient: createAndroidClient(),
    enabled: false,
    staggerMs: 0,
    liveCheckBatchFn: async (targets) => {
      for (const tgt of targets) checkedLiveTargets.push(tgt.target);
      return targets.map((tgt) => ({
        target: tgt.target,
        ruleId: tgt.ruleId,
        result: {
          status: 'NOT_LIVE',
          platform: 'TIKTOK',
          username: tgt.target.replace(/^@/, ''),
          sourceUrl: 'https://www.tiktok.com',
          checkedAt: new Date().toISOString(),
        },
      }));
    },
  });

  await scanner.runOnce();
  assert.deepEqual(checkedLiveTargets, ['@run_live']);

  const checkedPostUsers: string[] = [];
  const notifiedIds: string[] = [];
  const watcher = new MultiPlatformWatcher({
    config: {
      targetsByPlatform: { TIKTOK: ['skip_live', 'run_live'], INSTAGRAM: [], FACEBOOK: [], X: [] },
      targetStreamMetaMap: metaMap,
      targetRuleMap: { 'TIKTOK::skip_live': 'rule_tt', 'TIKTOK::run_live': 'rule_tt' },
      enableWarmup: true,
      autoDownloadMedia: false,
      staggerRangeMs: [0, 0],
    },
    stateStore: wsStore,
    notifier: new Notifier({
      webhookUrl: 'https://example.invalid/hook',
      fetchFn: async (_url, opts) => {
        const body = JSON.parse(opts?.body || '{}');
        notifiedIds.push(body.id);
        return { status: 200, ok: true };
      },
    }),
    collectors: {
      TIKTOK: {
        post: {
          name: 'tt_post',
          eventType: 'post',
          fetchWithDiagnostics: async (u) => {
            checkedPostUsers.push(u);
            return {
              status: 'OK',
              usedCookie: false,
              events: [
                {
                  platform: 'TIKTOK',
                  username: u,
                  eventType: 'post',
                  itemId: `post_${u}`,
                  url: `https://www.tiktok.com/@${u}/video/1`,
                  title: 'First post',
                  detectedAt: new Date().toISOString(),
                },
              ],
            };
          },
          fetch: async () => [],
        },
      },
    },
  });

  const postReport = await watcher.runCycle('post');
  assert.deepEqual(checkedPostUsers, ['skip_live']);
  assert.equal(postReport.warmedUpTargets, 0, 'warmup=false should skip warmup suppression');
  assert.deepEqual(notifiedIds, ['post_skip_live']);

  assert.equal(
    resolveTargetStreamMeta(metaMap, { ruleId: 'rule_tt', rawTarget: '@unknown' }).live,
    true
  );
});

// ==========================================
// F4: Collector & LiveChecker Misclassifications
// ==========================================
test('F4: TikTokStoryCollector classifies NOT_FOUND, PRIVATE, challenge BLOCKED, API errors, and unparsed HTML accurately', async () => {
  const origFetch = globalThis.fetch;
  try {
    const collector = new TikTokStoryCollector();

    // 1. statusCode 10221 without user -> NOT_FOUND
    globalThis.fetch = (async () =>
      new Response(
        `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify({
          __DEFAULT_SCOPE__: { 'webapp.user-detail': { statusCode: 10221 } },
        })}</script>`,
        { status: 200 }
      )) as typeof fetch;
    assert.equal((await collector.fetchWithDiagnostics('missing_tt')).status, 'NOT_FOUND');

    // 2. privateAccount: true -> PRIVATE
    globalThis.fetch = (async () =>
      new Response(
        `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify({
          __DEFAULT_SCOPE__: {
            'webapp.user-detail': {
              statusCode: 0,
              userInfo: { user: { id: '999000111222333444', privateAccount: true } },
            },
          },
        })}</script>`,
        { status: 200 }
      )) as typeof fetch;
    assert.equal((await collector.fetchWithDiagnostics('priv_tt')).status, 'PRIVATE');

    // 3. Challenge shell containing a 19-digit "id" -> BLOCKED (not OK)
    globalThis.fetch = (async () =>
      new Response('<html><body>Please verify captcha {"id":"1234567890123456789"}</body></html>', {
        status: 200,
      })) as typeof fetch;
    assert.equal((await collector.fetchWithDiagnostics('chal_tt')).status, 'BLOCKED');

    // 4. Story API HTTP 403 -> BLOCKED (not swallowed to OK)
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/story/item_list/')) {
        return new Response('Forbidden WAF', { status: 403 });
      }
      return new Response(
        `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify({
          __DEFAULT_SCOPE__: {
            'webapp.user-detail': {
              statusCode: 0,
              userInfo: { user: { id: '7777777777777777777', UserStoryStatus: 1 } },
            },
          },
        })}</script>`,
        { status: 200 }
      );
    }) as typeof fetch;
    assert.equal((await collector.fetchWithDiagnostics('api_err_tt')).status, 'BLOCKED');

    // 5. Large HTML without profile markers -> ERROR (never OK)
    globalThis.fetch = (async () =>
      new Response(`<html><body>${'x'.repeat(20000)}</body></html>`, { status: 200 })) as typeof fetch;
    assert.equal((await collector.fetchWithDiagnostics('unparsed_tt')).status, 'ERROR');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('F4: XPostCollector prioritizes age-restricted AUTH_REQUIRED over Suspended BLOCKED and handles NotFound/Protected', async () => {
  clearXGuestTokenCache();
  const origFetch = globalThis.fetch;
  try {
    const collector = new XPostCollector();
    const cases: Array<{ reason: string; message?: string; expected: string }> = [
      { reason: 'Suspended', message: 'User is age-restricted', expected: 'AUTH_REQUIRED' },
      { reason: 'NotFound', expected: 'NOT_FOUND' },
      { reason: 'Protected', expected: 'PRIVATE' },
      { reason: 'Suspended', expected: 'BLOCKED' },
    ];

    for (const c of cases) {
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('guest/activate.json')) {
          return new Response(JSON.stringify({ guest_token: 'gt_f4' }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            data: {
              user: {
                result: {
                  __typename: 'UserUnavailable',
                  reason: c.reason,
                  ...(c.message ? { message: c.message } : {}),
                },
              },
            },
          }),
          { status: 200 }
        );
      }) as typeof fetch;

      const res = await collector.fetchWithDiagnostics('test_x_user');
      assert.equal(res.status, c.expected, `Failed for ${JSON.stringify(c)}`);
    }
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('F4: liveCheckers return ERROR with HTTP status on 403/429/login walls while keeping bare 200 HTML as NOT_LIVE', async () => {
  const origFetch = globalThis.fetch;
  try {
    // All tiers return HTTP 429
    globalThis.fetch = (async () => new Response('Too Many Requests', { status: 429 })) as typeof fetch;
    const ttErr = await checkTikTokLive('tt_rl');
    assert.equal(ttErr.status, 'ERROR');
    assert.match(ttErr.message, /HTTP 429/);

    const igErr = await checkInstagramLive('ig_rl');
    assert.equal(igErr.status, 'ERROR');
    assert.match(igErr.message, /HTTP 429/);

    const fbErr = await checkFacebookLive('fb_rl');
    assert.equal(fbErr.status, 'ERROR');
    assert.match(fbErr.message, /HTTP 429/);

    // FB login wall on HTTP 200 -> ERROR
    globalThis.fetch = (async () =>
      new Response('<html><form id="login_form">You must log in</form></html>', {
        status: 200,
      })) as typeof fetch;
    const fbWall = await checkFacebookLive('fb_login_wall');
    assert.equal(fbWall.status, 'ERROR');

    // X broadcast API 403 propagated from profile check
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('guest/activate.json')) {
        return new Response(JSON.stringify({ guest_token: 'gt_xerr' }), { status: 200 });
      }
      if (url.includes('broadcasts/show.json')) {
        return new Response('Forbidden', { status: 403 });
      }
      return new Response('<html><a href="/i/broadcasts/1kvJpmapzboxE">Live</a></html>', {
        status: 200,
      });
    }) as typeof fetch;
    const xErr = await checkXLive('x_bcast_err');
    assert.equal(xErr.status, 'ERROR');
    assert.match(xErr.message, /HTTP 403/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ==========================================
// F5: MediaDownloader Cookies, Telegram Timeout, Watcher Error Propagation
// ==========================================
test('F5: MediaDownloader forwards cookies to CDN (never tikwm), surfaces cloud errors, and TelegramService enforces timeout', async (t) => {
  const dir = makeTempDir(t, 'f5_media');
  const origFetch = globalThis.fetch;
  try {
    const seenHeaders: Array<{ url: string; cookie?: string }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const hdrs = (init?.headers || {}) as Record<string, string>;
      seenHeaders.push({ url, cookie: hdrs.Cookie || hdrs.cookie });
      if (url.includes('cdn.instagram.test')) {
        return new Response(Buffer.from('fake-mp4-bytes'), {
          status: 200,
          headers: { 'content-type': 'video/mp4' },
        });
      }
      if (url.includes('api.telegram.org') || url.includes('telegram-bot-api') || url.includes('telegram')) {
        return new Response('<html>502 Bad Gateway</html>', { status: 502 });
      }
      return new Response('', { status: 404 });
    }) as typeof fetch;

    const tg = new TelegramService({ botToken: '123:tok', chatId: '-1001', enabled: true });
    const storageMgr = new StorageManager({ telegramService: tg, localStorageRoot: dir });
    const downloader = createMediaDownloader({
      storageRoot: dir,
      storageManager: storageMgr,
      cookies: { instagram: '50160%3Amysecret' },
    });

    const igEvent: WatcherEvent = {
      platform: 'INSTAGRAM',
      username: 'ig_star',
      eventType: 'story',
      itemId: 'st_9001',
      url: 'https://www.instagram.com/stories/ig_star/st_9001/',
      title: 'Story',
      detectedAt: new Date().toISOString(),
      metadata: { videoUrl: 'https://cdn.instagram.test/story.mp4' },
    };

    const res = await downloader.downloadEventMedia(igEvent);
    assert.equal(res.success, true);
    assert.equal(seenHeaders[0].cookie, 'sessionid=50160%3Amysecret; ds_user_id=50160');
    assert.ok(res.cloudUploadError?.includes('telegram'));
    assert.ok(res.cloudUploadError?.includes('502'));

    // Telegram timeout test
    const slowServer = http.createServer((_req, _res) => {
      // intentionally hang
    });
    await new Promise<void>((resolve) => slowServer.listen(0, '127.0.0.1', resolve));
    t.after(() => slowServer.close());
    const slowAddr = slowServer.address() as { port: number };

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      return origFetch(`http://127.0.0.1:${slowAddr.port}/bot/sendVideo`, init);
    }) as typeof fetch;

    const fastTimeoutTg = new TelegramService({
      botToken: '123:tok',
      chatId: '-1001',
      enabled: true,
      timeoutMs: 120,
    });
    const timeoutRes = await fastTimeoutTg.uploadFile({
      localFilePath: res.files[0].path,
      fileName: res.files[0].fileName,
      fileSize: res.files[0].fileSize,
      mimeType: 'video/mp4',
      username: 'ig_star',
      eventType: 'story',
    });
    assert.equal(timeoutRes.success, false);
    assert.ok(timeoutRes.error);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('F5: MultiPlatformWatcher does not mark failed story downloads seen or dispatch misleading notifications', async (t) => {
  const dir = makeTempDir(t, 'f5_watcher_err');
  const wsStore = createWatcherStateStore(path.join(dir, 'watcher-state.json'));
  const origFetch = globalThis.fetch;

  try {
    let downloadStatus = 403;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('cdn.story.test')) {
        if (downloadStatus !== 200) {
          return new Response('Forbidden', { status: downloadStatus });
        }
        return new Response(Buffer.from('ok-video-bytes'), { status: 200 });
      }
      return new Response('', { status: 404 });
    }) as typeof fetch;

    const notifications: WatcherEvent[] = [];
    const notifier = new Notifier({ webhookUrl: 'https://example.invalid/hook' });
    notifier.notify = async (ev) => {
      notifications.push(ev);
      return { status: 'delivered', attempts: 1 };
    };

    const watcher = new MultiPlatformWatcher({
      config: {
        targetsByPlatform: { INSTAGRAM: ['story_u'], TIKTOK: [], FACEBOOK: [], X: [] },
        autoDownloadMedia: true,
        driveStorageRoot: dir,
        staggerRangeMs: [0, 0],
      },
      stateStore: wsStore,
      notifier,
      collectors: {
        INSTAGRAM: {
          story: {
            name: 'ig_story',
            eventType: 'story',
            fetchWithDiagnostics: async (u) => ({
              status: 'OK',
              usedCookie: false,
              events: [
                {
                  platform: 'INSTAGRAM',
                  username: u,
                  eventType: 'story',
                  itemId: 'st_retry_1',
                  url: 'https://www.instagram.com/stories/story_u/st_retry_1/',
                  title: 'Story 1',
                  detectedAt: new Date().toISOString(),
                  metadata: { videoUrl: 'https://cdn.story.test/st_retry_1.mp4' },
                },
              ],
            }),
            fetch: async () => [],
          },
        },
      },
    });

    // Cycle 1: 403 download failure -> error recorded, 0 notifications, item NOT marked seen
    const r1 = await watcher.runCycle('story');
    assert.equal(r1.errors.length, 1);
    assert.equal(r1.notificationsDispatched, 0);
    assert.equal(notifications.length, 0);
    assert.equal(watcher.getDiagnostics()[0].status, 'ERROR');

    // Cycle 2: CDN returns 200 -> item retries, downloads, notifies, and marks seen
    downloadStatus = 200;
    const r2 = await watcher.runCycle('story');
    assert.equal(r2.errors.length, 0);
    assert.equal(r2.notificationsDispatched, 1);
    assert.equal(notifications.length, 1);
    assert.equal(watcher.getDiagnostics()[0].status, 'OK');
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ==========================================
// F6 & F7: Android Busy TTL, Sync ACK Retention, /api/scan Branch C
// ==========================================
test('F6: autoScanner unblocks stale RECORDING users beyond androidBusyTtlMs while skipping fresh ones', async (t) => {
  const dir = makeTempDir(t, 'f6_ttl');
  const store = createStateStore(dir);

  await store.writeWorkspaceState({
    rules: [
      {
        id: 'r_tt',
        ownerId: 'demo',
        keyword: '@stale_user, @fresh_user',
        excludedKeywords: 'tiktok.com |',
        matchType: 'contains',
        platforms: 'reddit',
        webhookServerId: 'srv_1',
        enabled: true,
        matchCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
  });

  const staleIso = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const freshIso = new Date(Date.now() - 60 * 1000).toISOString();

  await store.updateAndroidState((draft) => {
    draft.device = {
      deviceId: 'sm_n770f_default',
      ip: '127.0.0.1',
      port: 8765,
      callbackUrl: 'http://127.0.0.1:8765/record',
      appVersion: '2.0.0',
      networkType: 'WIFI',
      registeredAt: staleIso,
      lastSeenAt: freshIso,
      lastSyncAt: freshIso,
    };
    draft.reportedUsers = {
      'TIKTOK::stale_user': {
        canonicalKey: 'TIKTOK::stale_user',
        platform: 'TIKTOK',
        username: 'stale_user',
        usernameOrUrl: '@stale_user',
        status: 'RECORDING',
        isEnabled: true,
        allowCellular: false,
        lastStreamUrl: null,
        lastCheckedTimestamp: Date.now() - 30 * 60 * 1000,
        reportedAt: staleIso,
      },
      'TIKTOK::fresh_user': {
        canonicalKey: 'TIKTOK::fresh_user',
        platform: 'TIKTOK',
        username: 'fresh_user',
        usernameOrUrl: '@fresh_user',
        status: 'RECORDING',
        isEnabled: true,
        allowCellular: false,
        lastStreamUrl: null,
        lastCheckedTimestamp: Date.now() - 60 * 1000,
        reportedAt: freshIso,
      },
    };
  });

  const dispatchedUsernames: string[] = [];
  const mockAndroidServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      dispatchedUsernames.push(parsed.username);
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, status: 'RECORDING_STARTED' }));
    });
  });
  await new Promise<void>((resolve) => mockAndroidServer.listen(0, '127.0.0.1', resolve));
  t.after(() => mockAndroidServer.close());
  const addr = mockAndroidServer.address() as { port: number };
  await store.updateAndroidState((draft) => {
    draft.device!.port = addr.port;
    draft.device!.callbackUrl = `http://127.0.0.1:${addr.port}/record`;
  });

  const scanner = createAutoScanner({
    stateStore: store,
    androidClient: createAndroidClient({ timeoutMs: 2000, maxRetries: 1 }),
    enabled: false,
    staggerMs: 0,
    androidBusyTtlMs: 20 * 60 * 1000,
    liveCheckBatchFn: async (targets) =>
      targets.map((tgt) => ({
        target: tgt.target,
        ruleId: tgt.ruleId,
        result: {
          status: 'LIVE',
          platform: 'TIKTOK',
          username: tgt.target.replace(/^@/, ''),
          title: 'Live',
          streamUrl: `https://cdn.example/${tgt.target.replace(/^@/, '')}.flv`,
          sourceUrl: 'https://www.tiktok.com',
          checkedAt: new Date().toISOString(),
        },
      })),
  });

  const cycle = await scanner.runOnce();
  assert.deepEqual(dispatchedUsernames, ['stale_user']);
  assert.equal(cycle.skippedDeduplicatedCount, 1);

  const afterAndroid = await store.readAndroidState();
  assert.equal(afterAndroid.reportedUsers['TIKTOK::stale_user'].status, 'IDLE');
  assert.equal(afterAndroid.reportedUsers['TIKTOK::fresh_user'].status, 'RECORDING');
});

test('F6 & F7: /api/android/sync retains notifications when supportsNotificationAck=true and /api/scan runs real Branch C story scan', async (t) => {
  const dir = makeTempDir(t, 'f6_f7_server');
  const server = await startServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    mountFrontend: false,
    autoScanEnabled: false,
    startAutoScanner: false,
    startWatcher: false,
  });
  t.after(() => server.close());

  // 1. Queue notification
  const notifyRes = await fetch(`${server.url}/api/android/notify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'STORY_DOWNLOADED',
      eventType: 'story',
      platform: 'TIKTOK',
      username: 'creator_ack',
      title: 'Story Ready',
      itemId: 'st_ack_1',
    }),
  });
  const notifyData = (await notifyRes.json()) as { notification: { id: string } };
  const notifId = notifyData.notification.id;

  // 2. Sync with supportsNotificationAck: true -> retains notification until ACKed
  const sync1 = await fetch(`${server.url}/api/android/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deviceId: 'sm_n770f_default',
      users: [],
      supportsNotificationAck: true,
    }),
  });
  const sync1Json = (await sync1.json()) as { notifications: Array<{ id: string }> };
  assert.equal(sync1Json.notifications.length, 1);
  assert.equal(sync1Json.notifications[0].id, notifId);

  // 3. Second sync WITHOUT ACK still retains it; WITH ackedNotificationIds clears it
  const sync2 = await fetch(`${server.url}/api/android/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deviceId: 'sm_n770f_default',
      users: [],
      supportsNotificationAck: true,
    }),
  });
  assert.equal(((await sync2.json()) as { notifications: unknown[] }).notifications.length, 1);

  const sync3 = await fetch(`${server.url}/api/android/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deviceId: 'sm_n770f_default',
      users: [],
      supportsNotificationAck: true,
      ackedNotificationIds: [notifId],
    }),
  });
  assert.equal(((await sync3.json()) as { notifications: unknown[] }).notifications.length, 0);

  // 4. POST /api/scan Branch C for X story (UNSUPPORTED via real collector, NOT simulator!)
  const scanRes = await fetch(`${server.url}/api/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      activityType: 'story',
      rules: [
        {
          id: 'r_x_branch_c',
          ownerId: 'demo',
          keyword: '@elonmusk',
          excludedKeywords: 'x.com |',
          matchType: 'contains',
          platforms: 'bluesky',
          webhookServerId: 'srv_1',
          enabled: true,
          matchCount: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      servers: [],
    }),
  });
  const scanJson = (await scanRes.json()) as {
    ok: boolean;
    mode: string;
    diagnostics: Array<{ platform: string; eventType: string; status: string }>;
  };
  assert.equal(scanJson.ok, true);
  assert.equal(scanJson.mode, 'story');
  assert.ok(
    scanJson.diagnostics.some(
      (d) => d.platform === 'X' && d.eventType === 'story' && d.status === 'UNSUPPORTED'
    )
  );
});

// ==========================================
// Iteration 2 Regressions (Branch C Isolation, URL/Mixed-Case Meta, Cookies, Collectors, Checkers, Media, AutoScanner)
// ==========================================

test('Iter2: concurrent PUT /api/workspace-state during active POST /api/scan Branch C is NOT reverted', async (t) => {
  const dir = makeTempDir(t, 'iter2_branch_c_isolation');
  const server = await startServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    mountFrontend: false,
    autoScanEnabled: false,
    startAutoScanner: false,
    startWatcher: false,
  });
  t.after(() => server.close());

  // Seed initial state before scan
  await fetch(`${server.url}/api/workspace-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rules: [
        {
          id: 'r_initial',
          ownerId: 'demo',
          keyword: '@initial_target',
          excludedKeywords: 'tiktok.com |',
          matchType: 'contains',
          platforms: 'reddit',
          webhookServerId: 'srv_1',
          enabled: true,
          matchCount: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      scannerSettings: {
        cookies: { tiktok: 'initial_tt_cookie', instagram: '', facebook: '', x: '' },
        pollIntervalSeconds: 30,
        deduplicateLive: true,
      },
    }),
  });

  const origFetch = globalThis.fetch;
  let markScanStarted!: () => void;
  const scanStarted = new Promise<void>((resolve) => {
    markScanStarted = resolve;
  });
  let releaseScan!: () => void;
  const scanGate = new Promise<void>((resolve) => {
    releaseScan = resolve;
  });

  try {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
        return origFetch(input, init);
      }
      if (url.includes('tiktok.com/@branchc_target')) {
        markScanStarted();
        await scanGate;
        return new Response(
          `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify({
            __DEFAULT_SCOPE__: {
              'webapp.user-detail': {
                statusCode: 0,
                userInfo: { user: { id: '123456', privateAccount: false } },
                itemInfo: { itemList: [] },
              },
            },
          })}</script>`,
          { status: 200 }
        );
      }
      return new Response('', { status: 404 });
    }) as typeof fetch;

    const scanPromise = origFetch(`${server.url}/api/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        activityType: 'post',
        rules: [
          {
            id: 'r_branchc',
            ownerId: 'demo',
            keyword: '@branchc_target',
            excludedKeywords: 'tiktok.com |',
            matchType: 'contains',
            platforms: 'reddit',
            webhookServerId: 'srv_bc',
            enabled: true,
            matchCount: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        servers: [
          {
            id: 'srv_bc',
            ownerId: 'demo',
            name: 'BC Server',
            url: '/api/webhook-sandbox?channel=bc',
            format: 'json',
            secretHeader: 'sec_bc',
            enabled: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        cookies: { tiktok: 'branchc_temp_cookie' },
      }),
    });

    await scanStarted;

    // While Branch C is mid-flight, update workspace state via PUT /api/workspace-state
    const putRes = await origFetch(`${server.url}/api/workspace-state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rules: [
          {
            id: 'r_updated',
            ownerId: 'demo',
            keyword: '@updated_live_user',
            excludedKeywords: 'tiktok.com |',
            matchType: 'contains',
            platforms: 'reddit',
            webhookServerId: 'srv_upd',
            enabled: true,
            matchCount: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        scannerSettings: {
          cookies: { tiktok: 'updated_tt_cookie', instagram: '', facebook: '', x: '' },
          pollIntervalSeconds: 45,
          deduplicateLive: true,
        },
      }),
    });
    assert.equal(putRes.status, 200);

    // Confirm background singleton was NOT mutated by Branch C while in flight
    const mpWatcher = server.watcher as MultiPlatformWatcher;
    assert.equal(mpWatcher.getCookie('TIKTOK'), 'updated_tt_cookie');
    assert.deepEqual(
      (mpWatcher.getPlatformsSummary().tiktok as { targets: string[] }).targets,
      ['updated_live_user']
    );

    // Let Branch C complete and verify PUT state is NOT reverted
    releaseScan();
    const scanResp = await scanPromise;
    assert.equal(scanResp.status, 200);
    const scanBody = (await scanResp.json()) as { ok: boolean; mode: string; totalPostsScanned: number };
    assert.equal(scanBody.ok, true);
    assert.equal(scanBody.mode, 'post');
    assert.equal(scanBody.totalPostsScanned, 1);

    assert.equal(mpWatcher.getCookie('TIKTOK'), 'updated_tt_cookie');
    assert.deepEqual(
      (mpWatcher.getPlatformsSummary().tiktok as { targets: string[] }).targets,
      ['updated_live_user']
    );

    const watcherStatusRes = await origFetch(`${server.url}/api/watcher/status`);
    const watcherStatus = (await watcherStatusRes.json()) as {
      platforms: { tiktok: { targets: string[]; hasCookie: boolean } };
    };
    assert.deepEqual(watcherStatus.platforms.tiktok.targets, ['updated_live_user']);
    assert.equal(watcherStatus.platforms.tiktok.hasCookie, true);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Iter2: targetStreamMetaMap URL and mixed-case keys honored by resolveTargetStreamMeta, MultiPlatformWatcher, and Branch C', async (t) => {
  const dir = makeTempDir(t, 'iter2_meta_url_case');
  const metaMap = {
    'rule_url::https://www.tiktok.com/@UrlSkipPost': {
      live: true,
      post: false,
      story: true,
      warmup: false,
    },
    'rule_url::@MixedCase': {
      live: true,
      post: true,
      story: false,
      warmup: false,
    },
    'TIKTOK::https://www.tiktok.com/@PlatUrlSkip': {
      live: false,
      post: false,
      story: true,
      warmup: true,
    },
  };

  // Direct unit checks on resolveTargetStreamMeta
  assert.deepEqual(
    resolveTargetStreamMeta(metaMap, {
      ruleId: 'rule_url',
      rawTarget: 'urlskippost',
      platform: 'TIKTOK',
      canonicalUsername: 'urlskippost',
    }),
    { live: true, post: false, story: true, warmup: false }
  );
  assert.deepEqual(
    resolveTargetStreamMeta(metaMap, {
      ruleId: 'rule_url',
      rawTarget: 'mixedcase',
      platform: 'TIKTOK',
      canonicalUsername: 'mixedcase',
    }),
    { live: true, post: true, story: false, warmup: false }
  );
  assert.deepEqual(
    resolveTargetStreamMeta(metaMap, {
      rawTarget: 'platurlskip',
      platform: 'TIKTOK',
      canonicalUsername: 'platurlskip',
    }),
    { live: false, post: false, story: true, warmup: true }
  );

  // Integration check with startServer, MultiPlatformWatcher, and Branch C
  const server = await startServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    mountFrontend: false,
    autoScanEnabled: false,
    startAutoScanner: false,
    startWatcher: false,
  });
  t.after(() => server.close());

  const rules = [
    {
      id: 'rule_url',
      ownerId: 'demo',
      keyword: 'https://www.tiktok.com/@UrlSkipPost, @MixedCase, @ActiveUser',
      excludedKeywords: 'tiktok.com |',
      matchType: 'contains' as const,
      platforms: 'reddit' as const,
      webhookServerId: 'srv_1',
      enabled: true,
      matchCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];

  await fetch(`${server.url}/api/workspace-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rules,
      targetStreamMetaMap: metaMap,
    }),
  });

  const origFetch = globalThis.fetch;
  const fetchedUsers: string[] = [];
  try {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
        return origFetch(input, init);
      }
      const m = url.match(/tiktok\.com\/@([^/?#]+)/i);
      if (m?.[1]) {
        fetchedUsers.push(m[1].toLowerCase());
      }
      return new Response(
        `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify({
          __DEFAULT_SCOPE__: {
            'webapp.user-detail': {
              statusCode: 0,
              userInfo: { user: { id: '777', privateAccount: false, UserStoryStatus: 0 } },
              itemInfo: { itemList: [] },
            },
          },
        })}</script>`,
        { status: 200 }
      );
    }) as typeof fetch;

    // 1. Background MultiPlatformWatcher post cycle should skip UrlSkipPost (post: false)
    const mpWatcher = server.watcher as MultiPlatformWatcher;
    mpWatcher.updateConfig({ staggerRangeMs: [0, 0] });
    await mpWatcher.runCycle('post');
    assert.deepEqual(fetchedUsers, ['mixedcase', 'activeuser']);

    // 2. Branch C story cycle should skip MixedCase (story: false) and scan UrlSkipPost + ActiveUser
    fetchedUsers.length = 0;
    const scanRes = await origFetch(`${server.url}/api/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        activityType: 'story',
        rules,
        servers: [],
      }),
    });
    assert.equal(scanRes.status, 200);
    assert.deepEqual(fetchedUsers, ['urlskippost', 'activeuser']);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Iter2: Branch C preserves workspace cookies when req.body.cookies is omitted', async (t) => {
  const dir = makeTempDir(t, 'iter2_branch_c_cookies');
  const envKeys = ['TIKTOK_COOKIE', 'TIKTOK_SESSION_ID'] as const;
  const savedEnv: Record<string, string | undefined> = {};
  for (const k of envKeys) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  t.after(() => {
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  const server = await startServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    mountFrontend: false,
    autoScanEnabled: false,
    startAutoScanner: false,
    startWatcher: false,
  });
  t.after(() => server.close());

  const rules = [
    {
      id: 'r_cookie_bc',
      ownerId: 'demo',
      keyword: '@cookie_check_user',
      excludedKeywords: 'tiktok.com |',
      matchType: 'contains' as const,
      platforms: 'reddit' as const,
      webhookServerId: 'srv_1',
      enabled: true,
      matchCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];

  await fetch(`${server.url}/api/workspace-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rules,
      scannerSettings: {
        cookies: { tiktok: 'ws_saved_cookie_999', instagram: '', facebook: '', x: '' },
        pollIntervalSeconds: 30,
        deduplicateLive: true,
      },
    }),
  });

  const origFetch = globalThis.fetch;
  let observedCookieHeader: string | undefined;
  try {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
        return origFetch(input, init);
      }
      const hdrs = (init?.headers || {}) as Record<string, string>;
      observedCookieHeader = hdrs.Cookie || hdrs.cookie;
      return new Response(
        `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify({
          __DEFAULT_SCOPE__: {
            'webapp.user-detail': {
              statusCode: 0,
              userInfo: { user: { id: '555', privateAccount: false } },
              itemInfo: { itemList: [] },
            },
          },
        })}</script>`,
        { status: 200 }
      );
    }) as typeof fetch;

    const scanRes = await origFetch(`${server.url}/api/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        activityType: 'post',
        rules,
        servers: [],
      }),
    });
    assert.equal(scanRes.status, 200);
    assert.equal(observedCookieHeader, 'sessionid=ws_saved_cookie_999');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Iter2: xChecker populates httpStatus on ERROR and classifies HTTP 200 login wall as ERROR while keeping bare 200 as NOT_LIVE', async () => {
  const origFetch = globalThis.fetch;
  try {
    // 1. checkXLive profile HTTP 429 -> ERROR with httpStatus: 429
    globalThis.fetch = (async () => new Response('Too Many Requests', { status: 429 })) as typeof fetch;
    const rlRes = await checkXLive('x_rl_user');
    assert.equal(rlRes.status, 'ERROR');
    assert.equal(rlRes.httpStatus, 429);

    // 2. checkXBroadcastById HTTP 403 -> ERROR with httpStatus: 403
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('guest/activate.json')) {
        return new Response(JSON.stringify({ guest_token: 'gt_iter2' }), { status: 200 });
      }
      return new Response('Forbidden', { status: 403 });
    }) as typeof fetch;
    const bcastErr = await checkXBroadcastById('1kvJpmapzboxE');
    assert.equal(bcastErr.status, 'ERROR');
    assert.equal(bcastErr.httpStatus, 403);

    // 3. HTTP 200 login wall -> ERROR with httpStatus: 401
    globalThis.fetch = (async () =>
      new Response('<html><form id="login_form">You must log in</form></html>', {
        status: 200,
      })) as typeof fetch;
    const wallRes = await checkXLive('x_login_wall');
    assert.equal(wallRes.status, 'ERROR');
    assert.equal(wallRes.httpStatus, 401);

    // 4. Bare HTTP 200 -> NOT_LIVE
    globalThis.fetch = (async () =>
      new Response('<html><body></body></html>', { status: 200 })) as typeof fetch;
    const bareRes = await checkXLive('x_bare_ok');
    assert.equal(bareRes.status, 'NOT_LIVE');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Iter2: TikTokStoryCollector handles statusCode 10221 with empty storyList and non-JSON HTML shell on /api/story/item_list/', async () => {
  const origFetch = globalThis.fetch;
  try {
    const collector = new TikTokStoryCollector();

    // 1. statusCode: 10221 with empty storyList: [] -> NOT_FOUND
    globalThis.fetch = (async () =>
      new Response(
        `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify({
          __DEFAULT_SCOPE__: {
            'webapp.user-detail': {
              statusCode: 10221,
              userInfo: {},
              storyInfo: { storyList: [] },
            },
          },
        })}</script>`,
        { status: 200 }
      )) as typeof fetch;
    const notFoundRes = await collector.fetchWithDiagnostics('u_10221_empty');
    assert.equal(notFoundRes.status, 'NOT_FOUND');

    // 2. /api/story/item_list/ returns HTTP 200 non-JSON challenge HTML -> BLOCKED
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/story/item_list/')) {
        return new Response('<html><body>Please verify captcha</body></html>', { status: 200 });
      }
      return new Response(
        `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify({
          __DEFAULT_SCOPE__: {
            'webapp.user-detail': {
              statusCode: 0,
              userInfo: { user: { id: '8888888888888888888', UserStoryStatus: 1 } },
            },
          },
        })}</script>`,
        { status: 200 }
      );
    }) as typeof fetch;
    const apiBlockedRes = await collector.fetchWithDiagnostics('u_api_html_chal');
    assert.equal(apiBlockedRes.status, 'BLOCKED');

    // 3. /api/story/item_list/ returns HTTP 200 large non-JSON HTML -> ERROR
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/story/item_list/')) {
        return new Response(`<html><body>${'x'.repeat(20000)}</body></html>`, { status: 200 });
      }
      return new Response(
        `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify({
          __DEFAULT_SCOPE__: {
            'webapp.user-detail': {
              statusCode: 0,
              userInfo: { user: { id: '8888888888888888888', UserStoryStatus: 1 } },
            },
          },
        })}</script>`,
        { status: 200 }
      );
    }) as typeof fetch;
    const apiErrRes = await collector.fetchWithDiagnostics('u_api_html_large');
    assert.equal(apiErrRes.status, 'ERROR');

    // 4. /api/story/item_list/ returns HTTP 200 empty body "" -> OK
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/story/item_list/')) {
        return new Response('', { status: 200 });
      }
      return new Response(
        `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify({
          __DEFAULT_SCOPE__: {
            'webapp.user-detail': {
              statusCode: 0,
              userInfo: { user: { id: '8888888888888888888', UserStoryStatus: 1 } },
            },
          },
        })}</script>`,
        { status: 200 }
      );
    }) as typeof fetch;
    const apiEmptyRes = await collector.fetchWithDiagnostics('u_api_empty');
    assert.equal(apiEmptyRes.status, 'OK');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Iter2: MediaDownloader strips downloadHeaders.Cookie on tikwm.com URLs', async (t) => {
  const dir = makeTempDir(t, 'iter2_tikwm_dlheaders');
  const origFetch = globalThis.fetch;
  try {
    let seenHeaders: Record<string, string> = {};
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      seenHeaders = { ...((init?.headers || {}) as Record<string, string>) };
      return new Response(Buffer.from('mp4-bytes'), {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      });
    }) as typeof fetch;

    const downloader = createMediaDownloader({
      storageRoot: dir,
      cookies: { tiktok: 'secret_tt_cookie' },
    });

    const res = await downloader.downloadEventMedia({
      platform: 'TIKTOK',
      username: 'tt_user',
      eventType: 'post',
      itemId: 'item_tikwm_1',
      url: 'https://www.tiktok.com/@tt_user/video/item_tikwm_1',
      title: 'TikWM Test',
      detectedAt: new Date().toISOString(),
      metadata: {
        videoUrl: 'https://v16.tikwm.com/video/hd_123.mp4',
        downloadHeaders: {
          Cookie: 'sessionid=leaked_from_dlheaders',
          'X-Custom-Header': 'keep-me',
        },
      },
    });

    assert.equal(res.success, true);
    const headerKeysLower = Object.keys(seenHeaders).map((k) => k.toLowerCase());
    assert.equal(headerKeysLower.includes('cookie'), false);
    assert.equal(seenHeaders['X-Custom-Header'], 'keep-me');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Iter2: autoScanner resets expired RECORDING/UPLOADING reportedUsers to IDLE even on NOT_LIVE while preserving fresh UPLOADING', async (t) => {
  const dir = makeTempDir(t, 'iter2_autoscanner_notlive_reset');
  const store = createStateStore(dir);

  await store.writeWorkspaceState({
    rules: [
      {
        id: 'r_nl',
        ownerId: 'demo',
        keyword: '@stale_not_live, @fresh_uploading_nl',
        excludedKeywords: 'tiktok.com |',
        matchType: 'contains',
        platforms: 'reddit',
        webhookServerId: 'srv_1',
        enabled: true,
        matchCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
  });

  const staleIso = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const freshIso = new Date(Date.now() - 60 * 1000).toISOString();

  await store.updateAndroidState((draft) => {
    draft.reportedUsers = {
      'TIKTOK::stale_not_live': {
        canonicalKey: 'TIKTOK::stale_not_live',
        platform: 'TIKTOK',
        username: 'stale_not_live',
        usernameOrUrl: '@stale_not_live',
        status: 'RECORDING',
        isEnabled: true,
        allowCellular: false,
        lastStreamUrl: null,
        lastCheckedTimestamp: Date.now() - 30 * 60 * 1000,
        reportedAt: staleIso,
      },
      'TIKTOK::fresh_uploading_nl': {
        canonicalKey: 'TIKTOK::fresh_uploading_nl',
        platform: 'TIKTOK',
        username: 'fresh_uploading_nl',
        usernameOrUrl: '@fresh_uploading_nl',
        status: 'UPLOADING',
        isEnabled: true,
        allowCellular: false,
        lastStreamUrl: null,
        lastCheckedTimestamp: Date.now() - 60 * 1000,
        reportedAt: freshIso,
      },
    };
  });

  const scanner = createAutoScanner({
    stateStore: store,
    androidClient: createAndroidClient(),
    enabled: false,
    staggerMs: 0,
    androidBusyTtlMs: 20 * 60 * 1000,
    liveCheckBatchFn: async (targets) =>
      targets.map((tgt) => ({
        target: tgt.target,
        ruleId: tgt.ruleId,
        result: {
          status: 'NOT_LIVE',
          platform: 'TIKTOK',
          username: tgt.target.replace(/^@/, ''),
          sourceUrl: 'https://www.tiktok.com',
          checkedAt: new Date().toISOString(),
        },
      })),
  });

  await scanner.runOnce();
  const after = await store.readAndroidState();
  assert.equal(after.reportedUsers['TIKTOK::stale_not_live'].status, 'IDLE');
  assert.equal(after.reportedUsers['TIKTOK::fresh_uploading_nl'].status, 'UPLOADING');
});

test('Iter2: autoScanner honors legacy env cookie aliases TIKTOK_SESSION_ID, INSTAGRAM_SESSION_ID, and TWITTER_COOKIE', async (t) => {
  const dir = makeTempDir(t, 'iter2_autoscanner_legacy_env');
  const store = createStateStore(dir);

  const envKeys = [
    'TIKTOK_COOKIE',
    'TIKTOK_SESSION_ID',
    'INSTAGRAM_COOKIE',
    'INSTAGRAM_SESSION_ID',
    'X_COOKIE',
    'TWITTER_COOKIE',
  ] as const;
  const savedEnv: Record<string, string | undefined> = {};
  for (const k of envKeys) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  t.after(() => {
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  process.env.TIKTOK_SESSION_ID = 'legacy_tt_sid';
  process.env.INSTAGRAM_SESSION_ID = 'legacy_ig_sid';
  process.env.TWITTER_COOKIE = 'legacy_tw_cookie';

  await store.writeWorkspaceState({
    rules: [
      {
        id: 'r_tt_alias',
        ownerId: 'demo',
        keyword: '@tt_alias_u',
        excludedKeywords: 'tiktok.com |',
        matchType: 'contains',
        platforms: 'reddit',
        webhookServerId: 'srv_1',
        enabled: true,
        matchCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
  });

  let seenCookies: Record<string, string | undefined> = {};
  const scanner = createAutoScanner({
    stateStore: store,
    androidClient: createAndroidClient(),
    enabled: false,
    staggerMs: 0,
    liveCheckBatchFn: async (targets, cookies) => {
      seenCookies = { ...cookies };
      return targets.map((tgt) => ({
        target: tgt.target,
        ruleId: tgt.ruleId,
        result: {
          status: 'NOT_LIVE',
          platform: 'TIKTOK',
          username: tgt.target.replace(/^@/, ''),
          sourceUrl: 'https://www.tiktok.com',
          checkedAt: new Date().toISOString(),
        },
      }));
    },
  });

  await scanner.runOnce();
  assert.equal(seenCookies.tiktok, 'legacy_tt_sid');
  assert.equal(seenCookies.instagram, 'legacy_ig_sid');
  assert.equal(seenCookies.x, 'legacy_tw_cookie');
});
