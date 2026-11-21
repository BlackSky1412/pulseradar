import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { Notifier } from './notifier';
import type { PendingDeviceNotification, WatcherEvent } from './types';

test('Notifier: uses event.platform across formatPayload, PendingDeviceNotification, and dispatchToAndroid', async () => {
  const webhookBodies: Array<Record<string, unknown>> = [];
  const androidCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const pendingNotifs: PendingDeviceNotification[] = [];

  const notifier = new Notifier({
    webhookUrl: 'https://example.com/hook',
    androidCallbackUrl: 'http://192.168.1.50:8765/record',
    fetchFn: async (url, opts) => {
      const parsed = JSON.parse(opts?.body || '{}') as Record<string, unknown>;
      if (url.includes('192.168.1.50')) {
        androidCalls.push({ url, body: parsed });
      } else {
        webhookBodies.push(parsed);
      }
      return { status: 200, ok: true };
    },
    onPendingNotification: async (notif) => {
      pendingNotifs.push(notif);
    },
  });

  // 1. Live event on INSTAGRAM
  await notifier.notify({
    platform: 'INSTAGRAM',
    username: 'ig_live_user',
    eventType: 'live',
    itemId: 'live_1',
    url: 'https://www.instagram.com/ig_live_user/live/',
    title: 'IG Live!',
    streamUrl: 'https://cdn.ig.com/live.mpd',
    detectedAt: '2026-11-21T09:00:00.000Z',
  });
  assert.equal(webhookBodies[0].platform, 'INSTAGRAM');
  assert.equal(androidCalls[0].body.platform, 'INSTAGRAM');
  assert.equal(androidCalls[0].body.canonicalKey, 'INSTAGRAM::ig_live_user');

  // 2. Post event on X
  await notifier.notify({
    platform: 'X',
    username: 'x_poster',
    eventType: 'post',
    itemId: 'tw_1',
    url: 'https://x.com/x_poster/status/tw_1',
    title: 'Tweet!',
    detectedAt: '2026-11-21T09:05:00.000Z',
  });
  assert.equal(webhookBodies[1].platform, 'X');
  assert.equal(pendingNotifs[0].platform, 'X');
  assert.equal(pendingNotifs[0].type, 'POST_DOWNLOADED');
  assert.equal(androidCalls[1].url, 'http://192.168.1.50:8765/notify');
  assert.equal(androidCalls[1].body.platform, 'X');

  // 3. Legacy event without platform defaults to TIKTOK
  const legacyPayload = notifier.formatPayload({
    username: 'tt_user',
    eventType: 'story',
    itemId: 's_1',
    url: 'https://tiktok.com/@tt_user/story/s_1',
    title: 'TT Story',
    detectedAt: '2026-11-21T09:10:00.000Z',
  });
  assert.equal(legacyPayload.platform, 'TIKTOK');
});

test('Notifier: executes onPendingNotification even when webhookUrl and androidCallbackUrl are unset', async () => {
  const queued: PendingDeviceNotification[] = [];
  const notifier = new Notifier({
    onPendingNotification: async (notif) => {
      queued.push(notif);
    },
  });

  const postEvent: WatcherEvent = {
    platform: 'INSTAGRAM',
    username: 'ig_creator',
    eventType: 'post',
    itemId: 'p_100',
    url: 'https://www.instagram.com/p/C100/',
    title: 'New IG Post',
    detectedAt: '2026-11-21T09:15:00.000Z',
  };

  const res1 = await notifier.notify(postEvent);
  assert.equal(res1.status, 'delivered');
  assert.equal(res1.attempts, 1);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].platform, 'INSTAGRAM');
  assert.equal(queued[0].type, 'POST_DOWNLOADED');

  const storyRes = await notifier.notify({
    platform: 'FACEBOOK',
    username: 'fb_creator',
    eventType: 'story',
    itemId: 'st_200',
    url: 'https://www.facebook.com/stories/fb_creator/st_200/',
    title: 'New FB Story',
    detectedAt: '2026-11-21T09:20:00.000Z',
  });
  assert.equal(storyRes.status, 'delivered');
  assert.equal(queued.length, 2);
  assert.equal(queued[1].platform, 'FACEBOOK');
  assert.equal(queued[1].type, 'STORY_DOWNLOADED');
});

test('Notifier: webhookFormat uses buildWebhookPayload, signs HMAC-SHA256, resolves localBaseUrl, and routes by platform', async () => {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];

  const notifier = new Notifier({
    webhookUrl: '/api/webhook-sandbox',
    webhookFormat: 'discord',
    secretHeader: 'super_secret_123',
    localBaseUrl: 'http://127.0.0.1:4567',
    webhookTargetsByPlatform: {
      X: {
        url: 'https://hooks.slack.com/services/T000/B000/XXX',
        format: 'slack',
        secretHeader: 'slack_sec',
      },
    },
    fetchFn: async (url, opts) => {
      calls.push({
        url,
        headers: opts?.headers || {},
        body: opts?.body || '',
      });
      return { status: 200, ok: true };
    },
  });

  // 1. Default webhook with relative /api/webhook-sandbox & discord format
  const res1 = await notifier.notify({
    platform: 'INSTAGRAM',
    username: 'ig_artist',
    eventType: 'post',
    itemId: 'p_1',
    url: 'https://www.instagram.com/p/ABC/',
    title: 'Artwork',
    detectedAt: '2026-11-21T09:30:00.000Z',
  });
  assert.equal(res1.status, 'delivered');
  assert.equal(calls[0].url, 'http://127.0.0.1:4567/api/webhook-sandbox');
  assert.equal(calls[0].headers['X-PulseBot-Format'], 'discord');
  const expectedSig1 = `sha256=${crypto
    .createHmac('sha256', 'super_secret_123')
    .update(calls[0].body)
    .digest('hex')}`;
  assert.equal(calls[0].headers['X-PulseBot-Signature'], expectedSig1);
  const discordBody = JSON.parse(calls[0].body) as { embeds?: unknown[] };
  assert.ok(Array.isArray(discordBody.embeds));

  // 2. Platform-routed X -> Slack format
  await notifier.notify({
    platform: 'X',
    username: 'x_news',
    eventType: 'post',
    itemId: 'tw_9',
    url: 'https://x.com/x_news/status/tw_9',
    title: 'Breaking update',
    detectedAt: '2026-11-21T09:31:00.000Z',
  });
  assert.equal(calls[1].url, 'https://hooks.slack.com/services/T000/B000/XXX');
  assert.equal(calls[1].headers['X-PulseBot-Format'], 'slack');
  const slackBody = JSON.parse(calls[1].body) as { blocks?: unknown[] };
  assert.ok(Array.isArray(slackBody.blocks));

  // 3. System alert uses discord format when configured, and updateConfig switches to json
  await notifier.sendSystemAlert('instagram_post', 'HTTP 429', 5);
  assert.equal(calls[2].url, 'http://127.0.0.1:4567/api/webhook-sandbox');
  const alertDiscord = JSON.parse(calls[2].body) as { content?: string; embeds?: unknown[] };
  assert.ok(alertDiscord.content?.includes('COLLECTOR_FAILURE_THRESHOLD'));

  notifier.updateConfig({ webhookFormat: undefined, secretHeader: undefined });
  await notifier.notify({
    platform: 'FACEBOOK',
    username: 'fb_page',
    eventType: 'post',
    itemId: 'fb_1',
    url: 'https://www.facebook.com/fb_page/posts/fb_1',
    title: 'FB Legacy Shape',
    detectedAt: '2026-11-21T09:32:00.000Z',
  });
  const legacyBody = JSON.parse(calls[3].body) as Record<string, unknown>;
  assert.equal(legacyBody.platform, 'FACEBOOK');
  assert.equal(legacyBody.id, 'fb_1');
  assert.equal(calls[3].headers['X-PulseBot-Signature'], undefined);
});
