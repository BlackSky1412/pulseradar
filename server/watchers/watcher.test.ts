import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { BaseCollector } from './collectors/base';
import { extractRoomIdFromStream, TikTokLiveCollector } from './collectors/tiktokLive';
import { RawTikTokPost, TikTokPostCollector } from './collectors/tiktokPost';
import { RawTikTokStory, TikTokStoryCollector } from './collectors/tiktokStory';
import { Notifier } from './notifier';
import {
  buildSeenEventKey,
  buildTrackedUserKey,
  createWatcherStateStore,
} from './stateStore';
import { TikTokWatcher } from './tiktokWatcher';
import type { TikTokEvent } from './types';

const TEST_DIR = path.resolve('data', 'test-watcher');

async function cleanTestDir(): Promise<void> {
  try {
    await fs.promises.rm(TEST_DIR, { recursive: true, force: true });
  } catch {}
}

test.before(async () => {
  await cleanTestDir();
  await fs.promises.mkdir(TEST_DIR, { recursive: true });
});

test.after(async () => {
  await cleanTestDir();
});

// ==========================================
// 1. State Store Tests
// ==========================================
test('WatcherStateStore: warmupUser, deduplication, and persistence', async (t) => {
  const testFile = path.join(TEST_DIR, 'state-test-1.json');
  const store = createWatcherStateStore(testFile);

  await t.test('initial state returns uninitialized', async () => {
    const isInit = await store.isInitialized('TIKTOK', 'testuser', 'live');
    assert.equal(isInit, false);
  });

  await t.test('warmupUser records baseline items without alerting and marks user initialized', async () => {
    await store.warmupUser('TIKTOK', 'testuser', 'post', [
      { itemId: 'post_101', title: 'Video 101' },
      { itemId: 'post_102', title: 'Video 102' },
    ]);

    const isInit = await store.isInitialized('TIKTOK', 'testuser', 'post');
    assert.equal(isInit, true);

    // Items recorded during warmup must be marked as seen
    const isNew101 = await store.isNewAndMark('TIKTOK', 'testuser', 'post', 'post_101');
    assert.equal(isNew101, false, 'post_101 was warmed up, so isNewAndMark should return false');

    const isNew102 = await store.isNewAndMark('TIKTOK', 'testuser', 'post', 'post_102');
    assert.equal(isNew102, false, 'post_102 was warmed up, so isNewAndMark should return false');

    // Truly new item returns true
    const isNew103 = await store.isNewAndMark('TIKTOK', 'testuser', 'post', 'post_103');
    assert.equal(isNew103, true, 'post_103 is new, so isNewAndMark should return true');

    // Duplicate check on 103 returns false
    const isNew103Again = await store.isNewAndMark('TIKTOK', 'testuser', 'post', 'post_103');
    assert.equal(isNew103Again, false, 'post_103 was already marked, should return false');
  });

  await t.test('state persists across store reload', async () => {
    await store.flush();
    const reloadedStore = createWatcherStateStore(testFile);

    const isInit = await reloadedStore.isInitialized('TIKTOK', 'testuser', 'post');
    assert.equal(isInit, true);

    const isNew103 = await reloadedStore.isNewAndMark('TIKTOK', 'testuser', 'post', 'post_103');
    assert.equal(isNew103, false, 'Persisted post_103 must still be seen after reload');
  });
});

test('WatcherStateStore: collector health error counting, threshold alerts & cooldown', async (t) => {
  const testFile = path.join(TEST_DIR, 'state-health-test.json');
  const store = createWatcherStateStore(testFile);

  await t.test('increments errors and triggers alert at threshold', async () => {
    const threshold = 3;
    const cooldownMs = 1000;

    const res1 = await store.recordFailure('tiktok_post', 'Err 1', threshold, cooldownMs);
    assert.equal(res1.consecutiveErrors, 1);
    assert.equal(res1.triggerAlert, false);

    const res2 = await store.recordFailure('tiktok_post', 'Err 2', threshold, cooldownMs);
    assert.equal(res2.consecutiveErrors, 2);
    assert.equal(res2.triggerAlert, false);

    // 3rd failure reaches threshold -> alert triggered!
    const res3 = await store.recordFailure('tiktok_post', 'Err 3', threshold, cooldownMs);
    assert.equal(res3.consecutiveErrors, 3);
    assert.equal(res3.triggerAlert, true);

    // 4th failure right away is suppressed by cooldown
    const res4 = await store.recordFailure('tiktok_post', 'Err 4', threshold, cooldownMs);
    assert.equal(res4.consecutiveErrors, 4);
    assert.equal(res4.triggerAlert, false, 'Alert should be throttled by cooldown');

    // Record success resets errors to 0
    await store.recordSuccess('tiktok_post');
    const health = await store.getHealthStatus();
    assert.equal(health.tiktok_post.consecutiveErrors, 0);
    assert.ok(health.tiktok_post.lastSuccessAt);
  });
});

test('WatcherStateStore: pruneExpiredStories cleans up only stories older than 48h', async () => {
  const testFile = path.join(TEST_DIR, 'state-prune-test.json');
  const store = createWatcherStateStore(testFile);

  const state = await store.getState();
  const now = Date.now();
  const oldTime = new Date(now - 50 * 3600 * 1000).toISOString(); // 50 hours old
  const recentTime = new Date(now - 10 * 3600 * 1000).toISOString(); // 10 hours old

  // Add an old story
  const oldKey = buildSeenEventKey('TIKTOK', 'creator1', 'story', 'story_old_1');
  state.seenEvents[oldKey] = {
    platform: 'TIKTOK',
    username: 'creator1',
    eventType: 'story',
    itemId: 'story_old_1',
    createdAt: oldTime,
  };

  // Add a recent story
  const recentKey = buildSeenEventKey('TIKTOK', 'creator1', 'story', 'story_new_1');
  state.seenEvents[recentKey] = {
    platform: 'TIKTOK',
    username: 'creator1',
    eventType: 'story',
    itemId: 'story_new_1',
    createdAt: recentTime,
  };

  // Add an old post (should NOT be pruned by pruneExpiredStories)
  const oldPostKey = buildSeenEventKey('TIKTOK', 'creator1', 'post', 'post_old_1');
  state.seenEvents[oldPostKey] = {
    platform: 'TIKTOK',
    username: 'creator1',
    eventType: 'post',
    itemId: 'post_old_1',
    createdAt: oldTime,
  };

  await fs.promises.writeFile(testFile, JSON.stringify(state), 'utf-8');

  // Prune with 48h window
  const pruned = await store.pruneExpiredStories(48);
  assert.equal(pruned, 1, 'Exactly 1 story should have been pruned');

  const afterState = await store.getState();
  assert.equal(Boolean(afterState.seenEvents[oldKey]), false, 'Old story should be deleted');
  assert.equal(Boolean(afterState.seenEvents[recentKey]), true, 'Recent story should be retained');
  assert.equal(Boolean(afterState.seenEvents[oldPostKey]), true, 'Old post must be retained');
});

// ==========================================
// 2. Collectors Tests
// ==========================================
test('TikTokLiveCollector: detects live state and extracts room_id', async () => {
  const mockChecker = async (username: string) => {
    return {
      status: 'LIVE' as const,
      platform: 'TIKTOK' as const,
      username,
      title: 'Gaming Stream',
      streamUrl: 'https://pull-flv.tiktokcdn.com/stage/stream-742918237192.flv',
      sourceUrl: `https://www.tiktok.com/@${username}/live`,
      checkedAt: new Date().toISOString(),
    };
  };

  const collector = new TikTokLiveCollector({ checker: mockChecker });
  const events = await collector.fetch('@gamer123');

  assert.equal(events.length, 1);
  assert.equal(events[0].username, 'gamer123');
  assert.equal(events[0].eventType, 'live');
  assert.equal(events[0].itemId, '742918237192');
  assert.equal(events[0].title, 'Gaming Stream');
  assert.ok(events[0].streamUrl?.includes('flv'));
});

test('TikTokLiveCollector: handles NOT_LIVE correctly', async () => {
  const mockChecker = async (username: string) => ({
    status: 'NOT_LIVE' as const,
    platform: 'TIKTOK' as const,
    username,
    sourceUrl: `https://www.tiktok.com/@${username}/live`,
    checkedAt: new Date().toISOString(),
  });

  const collector = new TikTokLiveCollector({ checker: mockChecker });
  const events = await collector.fetch('offline_user');
  assert.equal(events.length, 0);
});

test('TikTokPostCollector: inspects top N posts and skips pinned videos', async () => {
  const mockPosts: RawTikTokPost[] = [
    { id: 'pinned_post_1', desc: 'Old Pinned Video 2023', isPinned: true },
    { id: 'pinned_post_2', desc: 'Second Pinned Video', isPinned: true },
    { id: 'fresh_post_1', desc: 'New Video Today!', isPinned: false },
    { id: 'fresh_post_2', desc: 'Yesterday Video', isPinned: false },
  ];

  const collector = new TikTokPostCollector({
    topN: 5,
    skipPinned: true,
    fetcher: async () => mockPosts,
  });

  const events = await collector.fetch('creator_xyz');

  assert.equal(events.length, 2, 'Pinned videos must be skipped, leaving 2 fresh posts');
  assert.equal(events[0].itemId, 'fresh_post_1');
  assert.equal(events[0].title, 'New Video Today!');
  assert.equal(events[1].itemId, 'fresh_post_2');
});

test('TikTokStoryCollector: extracts active stories', async () => {
  const mockStories: RawTikTokStory[] = [
    { id: 'story_999', title: 'Day in Life', coverUrl: 'https://thumb.jpg' },
  ];

  const collector = new TikTokStoryCollector({
    fetcher: async () => mockStories,
  });

  const events = await collector.fetch('@story_teller');

  assert.equal(events.length, 1);
  assert.equal(events[0].username, 'story_teller');
  assert.equal(events[0].eventType, 'story');
  assert.equal(events[0].itemId, 'story_999');
  assert.equal(events[0].url, 'https://www.tiktok.com/@story_teller/story/story_999');
});

// ==========================================
// 3. Notifier Tests
// ==========================================
test('Notifier: exponential backoff retries on 5xx and immediate halt on 4xx', async (t) => {
  await t.test('retries on 500 error up to 3 times with backoff', async () => {
    let callCount = 0;
    const notifier = new Notifier({
      webhookUrl: 'https://example.com/webhook',
      timeoutMs: 1000,
      retryDelaysMs: [10, 20, 40], // Fast delays for test
      fetchFn: async () => {
        callCount++;
        if (callCount < 3) {
          return { status: 503, ok: false, text: 'Service Unavailable' };
        }
        return { status: 200, ok: true, text: 'OK' };
      },
    });

    const event: TikTokEvent = {
      username: 'sample_user',
      eventType: 'live',
      itemId: 'room_111',
      url: 'https://tiktok.com/@sample_user/live',
      title: 'Live now',
      detectedAt: new Date().toISOString(),
    };

    const res = await notifier.notify(event);
    assert.equal(res.status, 'delivered');
    assert.equal(callCount, 3, 'Should have made 1 initial call + 2 retries before succeeding');
  });

  await t.test('halts immediately on 400 client error without retry', async () => {
    let callCount = 0;
    const notifier = new Notifier({
      webhookUrl: 'https://example.com/webhook',
      timeoutMs: 1000,
      retryDelaysMs: [10, 20, 40],
      fetchFn: async () => {
        callCount++;
        return { status: 400, ok: false, text: 'Bad Request' };
      },
    });

    const event: TikTokEvent = {
      username: 'sample_user',
      eventType: 'post',
      itemId: 'post_222',
      url: 'https://tiktok.com/@sample_user/video/post_222',
      title: 'Video',
      detectedAt: new Date().toISOString(),
    };

    const res = await notifier.notify(event);
    assert.equal(res.status, 'failed');
    assert.equal(callCount, 1, 'Should NOT retry on 4xx');
    assert.ok(res.error?.includes('HTTP 400'));
  });

  await t.test('formats payload matching specification §5', async () => {
    let capturedPayload: unknown = null;
    const notifier = new Notifier({
      webhookUrl: 'https://example.com/webhook',
      fetchFn: async (url, opts) => {
        capturedPayload = JSON.parse(opts?.body || '{}');
        return { status: 200, ok: true };
      },
    });

    const now = new Date().toISOString();
    const event: TikTokEvent = {
      username: 'example_user',
      eventType: 'live',
      itemId: '742819203948123',
      url: 'https://www.tiktok.com/@example_user/live',
      title: 'Đang phát trực tiếp',
      thumbnailUrl: null,
      detectedAt: now,
    };

    await notifier.notify(event);
    const p = capturedPayload as Record<string, unknown>;
    assert.equal(p.username, 'example_user');
    assert.equal(p.type, 'live');
    assert.equal(p.id, '742819203948123');
    assert.equal(p.url, 'https://www.tiktok.com/@example_user/live');
    assert.equal(p.title, 'Đang phát trực tiếp');
    assert.equal(p.thumbnail_url, null);
    assert.equal(p.detected_at, now);
  });
});

// ==========================================
// 4. TikTok Watcher Integration Tests
// ==========================================
test('TikTokWatcher: first-run warmup suppresses alerts, subsequent cycles notify new items only', async () => {
  const testFile = path.join(TEST_DIR, 'watcher-warmup-test.json');
  const store = createWatcherStateStore(testFile);

  const notificationsDispatched: TikTokEvent[] = [];
  const mockNotifier = new Notifier({
    webhookUrl: 'https://example.com/webhook',
    fetchFn: async (url, opts) => {
      return { status: 200, ok: true };
    },
  });
  // Intercept format/notify
  mockNotifier.notify = async (event) => {
    notificationsDispatched.push(event);
    return { status: 'delivered', attempts: 1 };
  };

  // Initial items present on target
  let currentPosts: RawTikTokPost[] = [
    { id: 'v_existing_1', desc: 'Old video 1', isPinned: false },
    { id: 'v_existing_2', desc: 'Old video 2', isPinned: false },
  ];

  const postCollector = new TikTokPostCollector({
    topN: 10,
    skipPinned: true,
    fetcher: async () => currentPosts,
  });

  const watcher = new TikTokWatcher({
    config: {
      targetUsers: ['cool_creator'],
      enableWarmup: true,
      staggerRangeMs: [0, 0],
    },
    stateStore: store,
    notifier: mockNotifier,
    postCollector,
  });

  // Cycle 1: First-run warmup!
  const report1 = await watcher.runCycle('post');
  assert.equal(report1.warmedUpTargets, 1, 'Target should have been warmed up');
  assert.equal(report1.newEventsFound, 0, 'Zero new events found during warmup');
  assert.equal(report1.notificationsDispatched, 0, 'Zero notifications sent during warmup');
  assert.equal(notificationsDispatched.length, 0, 'No alerts should have fired for existing posts');

  // Cycle 2: Same posts queried again -> zero new events, zero alerts
  const report2 = await watcher.runCycle('post');
  assert.equal(report2.newEventsFound, 0, 'Same items must be deduplicated');
  assert.equal(report2.notificationsDispatched, 0);
  assert.equal(notificationsDispatched.length, 0);

  // Cycle 3: Creator publishes a brand new post!
  currentPosts = [
    { id: 'v_fresh_brand_new_1', desc: 'Brand new video just uploaded!', isPinned: false },
    ...currentPosts,
  ];

  const report3 = await watcher.runCycle('post');
  assert.equal(report3.newEventsFound, 1, 'New post should be detected');
  assert.equal(report3.notificationsDispatched, 1, 'Alert must be dispatched for new post');
  assert.equal(notificationsDispatched.length, 1);
  assert.equal(notificationsDispatched[0].itemId, 'v_fresh_brand_new_1');

  // Cycle 4: Same items again -> deduplication ensures no duplicate alert!
  const report4 = await watcher.runCycle('post');
  assert.equal(report4.newEventsFound, 0);
  assert.equal(notificationsDispatched.length, 1, 'Total notifications remains 1');
});

test('TikTokWatcher: fault isolation between collectors', async () => {
  const testFile = path.join(TEST_DIR, 'watcher-fault-isolation.json');
  const store = createWatcherStateStore(testFile);

  // Live collector works fine
  const liveCollector: BaseCollector = {
    name: 'tiktok_live',
    eventType: 'live',
    fetch: async (username) => [
      {
        username,
        eventType: 'live',
        itemId: 'room_live_1',
        url: `https://www.tiktok.com/@${username}/live`,
        title: 'Active Live',
        detectedAt: new Date().toISOString(),
      },
    ],
  };

  // Story collector throws 429 WAF error
  const storyCollector: BaseCollector = {
    name: 'tiktok_story',
    eventType: 'story',
    fetch: async () => {
      throw new Error('TikTok WAF 429 Too Many Requests');
    },
  };

  const watcher = new TikTokWatcher({
    config: {
      targetUsers: ['user_isolated'],
      enableWarmup: false, // directly test event loop
      alertErrorThreshold: 2,
      alertCooldownSeconds: 3600,
      staggerRangeMs: [0, 0],
    },
    stateStore: store,
    liveCollector,
    storyCollector,
  });

  // Run story cycle -> should fail safely without throwing unhandled rejection
  const storyReport = await watcher.runCycle('story');
  assert.equal(storyReport.errors.length, 1);
  assert.ok(storyReport.errors[0].error.includes('429'));

  // Run live cycle -> must succeed completely independently
  const liveReport = await watcher.runCycle('live');
  assert.equal(liveReport.errors.length, 0);
  assert.equal(liveReport.newEventsFound, 1);

  // Health check verifies story collector recorded error
  const health = await store.getHealthStatus();
  assert.equal(health.tiktok_story.consecutiveErrors, 1);
  assert.equal(health.tiktok_live.consecutiveErrors, 0);
});

test('TikTokWatcher: sleepOrAbort cleans up abort listeners without memory leak or MaxListenersExceededWarning', async () => {
  const testFile = path.join(TEST_DIR, 'watcher-sleep-leak-test.json');
  const store = createWatcherStateStore(testFile);

  const watcher = new TikTokWatcher({
    config: {
      targetUsers: ['leak_tester'],
    },
    stateStore: store,
  });

  const capturedWarnings: Error[] = [];
  const warningHandler = (warning: Error) => {
    capturedWarnings.push(warning);
  };
  process.on('warning', warningHandler);

  try {
    const controller = new AbortController();
    (watcher as any).stopController = controller;

    // Execute 20 consecutive sleeps to exceed the default limit of 10 listeners
    for (let i = 0; i < 20; i++) {
      await (watcher as any).sleepOrAbort(2);
      const listenerCount = getEventListeners(controller.signal, 'abort').length;
      assert.equal(
        listenerCount,
        0,
        `Abort listener must be removed after timer completion (iteration ${i + 1})`
      );
    }

    // Verify no MaxListenersExceededWarning was triggered
    const leakWarnings = capturedWarnings.filter(
      (w) => w.name === 'MaxListenersExceededWarning' || w.message.includes('MaxListenersExceeded')
    );
    assert.equal(
      leakWarnings.length,
      0,
      `Expected 0 MaxListenersExceededWarning, but got: ${leakWarnings.map((w) => w.message).join(', ')}`
    );

    // Verify early abort resolves immediately and cleans up
    const abortController = new AbortController();
    (watcher as any).stopController = abortController;
    const startAbort = Date.now();
    const sleepPromise = (watcher as any).sleepOrAbort(5000);
    abortController.abort();
    await sleepPromise;
    const abortDuration = Date.now() - startAbort;
    assert.ok(abortDuration < 200, `Sleep should resolve promptly on abort, took ${abortDuration}ms`);

    // Verify that once aborted, subsequent sleeps resolve immediately without registering listeners
    const startSubsequent = Date.now();
    await (watcher as any).sleepOrAbort(5000);
    const subsequentDuration = Date.now() - startSubsequent;
    assert.ok(
      subsequentDuration < 100,
      `Subsequent sleep when aborted should resolve immediately, took ${subsequentDuration}ms`
    );
    assert.equal(
      getEventListeners(abortController.signal, 'abort').length,
      0,
      'No abort listener should be attached when signal is already aborted'
    );
  } finally {
    process.off('warning', warningHandler);
  }
});

test('TikTokWatcher: updateConfig({ tiktokSessionId: "" }) propagates Guest mode to live, post, and story collectors', async () => {
  const testFile = path.join(TEST_DIR, 'watcher-guest-cookie-prop.json');
  const store = createWatcherStateStore(testFile);

  const capturedHeaders: Array<{ url: string; cookie: string | undefined }> = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    let cookie: string | undefined;
    if (init?.headers && typeof init.headers === 'object' && !Array.isArray(init.headers)) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        if (k.toLowerCase() === 'cookie') {
          cookie = String(v);
        }
      }
    }
    capturedHeaders.push({ url, cookie });
    return new Response('<html></html>', { status: 200 });
  }) as typeof fetch;

  try {
    const watcher = new TikTokWatcher({
      config: {
        targetUsers: ['guest_creator'],
        enableWarmup: false,
        staggerRangeMs: [0, 0],
        tiktokSessionId: 'initial_session_123',
      },
      stateStore: store,
    });

    await watcher.runCycle('live');
    await watcher.runCycle('post');
    await watcher.runCycle('story');

    assert.ok(capturedHeaders.length >= 3);
    assert.ok(
      capturedHeaders.every(r => r.cookie === 'sessionid=initial_session_123'),
      'All collectors must send initial session cookie before clearing'
    );

    capturedHeaders.length = 0;
    watcher.updateConfig({ tiktokSessionId: '' });

    await watcher.runCycle('live');
    await watcher.runCycle('post');
    await watcher.runCycle('story');

    assert.ok(capturedHeaders.length >= 3);
    assert.ok(
      capturedHeaders.every(r => r.cookie === undefined),
      'All collectors must omit Cookie header after updateConfig({ tiktokSessionId: "" })'
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('TikTokPostCollector, TikTokStoryCollector & TikTokLiveCollector: empty/whitespace/undefined cookie safety', async () => {
  const capturedCookies: Array<string | undefined> = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    let cookie: string | undefined;
    if (init?.headers && typeof init.headers === 'object' && !Array.isArray(init.headers)) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        if (k.toLowerCase() === 'cookie') {
          cookie = String(v);
        }
      }
    }
    capturedCookies.push(cookie);
    return new Response('<html></html>', { status: 200 });
  }) as typeof fetch;

  try {
    const postCollector = new TikTokPostCollector({ cookie: '   ' });
    const storyCollector = new TikTokStoryCollector({ cookie: '   ' });
    const liveCollector = new TikTokLiveCollector({ cookie: '   ' });

    await postCollector.fetch('guest_user');
    await storyCollector.fetch('guest_user');
    await liveCollector.fetch('guest_user');

    postCollector.setCookie('');
    storyCollector.setCookie(undefined as unknown as string);
    liveCollector.setCookie('   ');

    await postCollector.fetch('guest_user');
    await storyCollector.fetch('guest_user');
    await liveCollector.fetch('guest_user');

    assert.ok(capturedCookies.length >= 6);
    assert.ok(
      capturedCookies.every(c => c === undefined),
      'Collectors must never emit Cookie headers for empty, whitespace, or undefined cookies'
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});
