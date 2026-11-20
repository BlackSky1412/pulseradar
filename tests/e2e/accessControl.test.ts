import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createApp } from '../../server';
import { resolveDriveStorageRoot } from '../../server/mediaDownloader';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pulseradar-access-test-'));
}

test('Access Control: Device Whitelist enforcement on register and sync', async (t) => {
  const dataDir = createTempDir();
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const { app, stateStore, close } = await createApp({ dataDir });
  t.after(async () => {
    await close();
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const baseUrl = `http://127.0.0.1:${port}`;

  // Explicitly configure device whitelist to strictly allow sm_n770f_default
  await stateStore.updateAndroidState((draft) => {
    draft.allowedDeviceIds = ['sm_n770f_default'];
  });

  // 1. Authorized device registers -> 200 OK
  const authRegResp = await fetch(`${baseUrl}/api/android/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deviceId: 'sm_n770f_default',
      ip: '192.168.1.9',
      port: 8765,
    }),
  });
  assert.equal(authRegResp.status, 200);
  const authRegJson = await authRegResp.json();
  assert.equal(authRegJson.ok, true);

  // 2. Unauthorized rogue device registers -> 403 Forbidden
  const rogueRegResp = await fetch(`${baseUrl}/api/android/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deviceId: 'rogue_hacker_phone',
      ip: '192.168.1.99',
      port: 8765,
    }),
  });
  assert.equal(rogueRegResp.status, 403);
  const rogueRegJson = await rogueRegResp.json();
  assert.equal(rogueRegJson.ok, false);
  assert.equal(rogueRegJson.error, 'Device not authorized');

  // 3. Unauthorized sync -> 403 Forbidden
  const rogueSyncResp = await fetch(`${baseUrl}/api/android/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deviceId: 'rogue_hacker_phone',
      users: [],
    }),
  });
  assert.equal(rogueSyncResp.status, 403);

  // 4. Update whitelist dynamically via /api/security/device-whitelist
  const updateWhitelistResp = await fetch(`${baseUrl}/api/security/device-whitelist`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      allowedDeviceIds: ['sm_n770f_default', 'rogue_hacker_phone'],
    }),
  });
  assert.equal(updateWhitelistResp.status, 200);

  // Now rogue_hacker_phone is authorized
  const secondSyncResp = await fetch(`${baseUrl}/api/android/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deviceId: 'rogue_hacker_phone',
      users: [],
    }),
  });
  assert.equal(secondSyncResp.status, 200);
});

test('Notification Queue: /api/android/notify queues notification delivered on /api/android/sync', async (t) => {
  const dataDir = createTempDir();
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const { app, close } = await createApp({ dataDir });
  t.after(async () => {
    await close();
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const baseUrl = `http://127.0.0.1:${port}`;

  // 1. Post notification
  const notifPayload = {
    type: 'POST_DOWNLOADED',
    eventType: 'post',
    platform: 'TIKTOK',
    username: 'mixigaming',
    title: 'New Mixi Gaming Video',
    itemId: 'video_777777',
    mediaPath: 'G:/My Drive/.../video.mp4',
    fileName: '20261120_video_777777.mp4',
    fileSize: 15420300,
  };

  const notifyResp = await fetch(`${baseUrl}/api/android/notify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(notifPayload),
  });
  assert.equal(notifyResp.status, 200);
  const notifyJson = await notifyResp.json();
  assert.equal(notifyJson.ok, true);
  assert.equal(notifyJson.notification.username, 'mixigaming');

  // 2. Perform 10-minute Android sync -> returns notifications array
  const syncResp = await fetch(`${baseUrl}/api/android/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deviceId: 'sm_n770f_default',
      users: [],
    }),
  });
  assert.equal(syncResp.status, 200);
  const syncJson = await syncResp.json();
  assert.equal(syncJson.ok, true);
  assert.ok(Array.isArray(syncJson.notifications));
  assert.equal(syncJson.notifications.length, 1);
  assert.equal(syncJson.notifications[0].username, 'mixigaming');
  assert.equal(syncJson.notifications[0].itemId, 'video_777777');

  // 3. Second sync -> queue was flushed, notifications is empty
  const secondSync = await fetch(`${baseUrl}/api/android/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deviceId: 'sm_n770f_default',
      users: [],
    }),
  });
  const secondJson = await secondSync.json();
  assert.equal(secondJson.notifications.length, 0);
});

test('Active Poll: /api/android/poll delivers pending commands and notifications immediately', async (t) => {
  const dataDir = createTempDir();
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const { app, stateStore, close } = await createApp({ dataDir });
  t.after(async () => {
    await close();
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const baseUrl = `http://127.0.0.1:${port}`;

  // 1. Initially empty
  const poll1 = await fetch(`${baseUrl}/api/android/poll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: 'sm_n770f_default' }),
  });
  assert.equal(poll1.status, 200);
  const json1 = await poll1.json();
  assert.equal(json1.ok, true);
  assert.deepEqual(json1.commands, []);
  assert.deepEqual(json1.notifications, []);

  // 2. Queue a record command and notification
  await stateStore.updateAndroidState((draft) => {
    draft.pendingRecordCommands = [
      {
        eventId: 'evt_test_123',
        canonicalKey: 'TIKTOK::baotran162008',
        platform: 'TIKTOK',
        username: 'baotran162008',
        usernameOrUrl: 'baotran162008',
        streamUrl: 'https://stream.tiktok.com/live_test.flv',
        title: 'Bao Tran Live Test',
        queuedAt: new Date().toISOString(),
      },
    ];
    draft.pendingNotifications = [
      {
        id: 'notif_1',
        type: 'MEDIA_DOWNLOADED',
        eventType: 'post',
        platform: 'TIKTOK',
        username: 'baotran162008',
        title: 'New Story',
        itemId: 'story_1',
        createdAt: new Date().toISOString(),
      },
    ];
  });

  // 3. Unauthorized poll gets 403
  await stateStore.updateAndroidState((draft) => {
    draft.allowedDeviceIds = ['sm_n770f_default'];
  });
  const unauthPoll = await fetch(`${baseUrl}/api/android/poll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: 'hacker_phone' }),
  });
  assert.equal(unauthPoll.status, 403);

  // 4. Authorized poll gets commands & notifications immediately
  const poll2 = await fetch(`${baseUrl}/api/android/poll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: 'sm_n770f_default' }),
  });
  assert.equal(poll2.status, 200);
  const json2 = await poll2.json();
  assert.equal(json2.ok, true);
  assert.equal(json2.commands.length, 1);
  assert.equal(json2.commands[0].username, 'baotran162008');
  assert.equal(json2.commands[0].streamUrl, 'https://stream.tiktok.com/live_test.flv');
  assert.equal(json2.notifications.length, 1);
  assert.equal(json2.notifications[0].itemId, 'story_1');

  // 5. Subsequent poll -> both queues drained
  const poll3 = await fetch(`${baseUrl}/api/android/poll?deviceId=sm_n770f_default`);
  assert.equal(poll3.status, 200);
  const json3 = await poll3.json();
  assert.equal(json3.commands.length, 0);
  assert.equal(json3.notifications.length, 0);

  // Active session was set
  const finalState = await stateStore.readAndroidState();
  assert.equal(finalState.activeSessions['TIKTOK::baotran162008'], 'https://stream.tiktok.com/live_test.flv');
});

test('Media API: /api/media/downloaded and /api/media/file stream downloaded files', async (t) => {
  const dataDir = createTempDir();
  const mediaDir = path.join(dataDir, 'downloaded_media');
  process.env.DRIVE_MEDIA_DIR = mediaDir;

  t.after(() => {
    delete process.env.DRIVE_MEDIA_DIR;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  // Seed sample media files
  const userPostDir = path.join(mediaDir, 'streamer_a', 'posts');
  fs.mkdirSync(userPostDir, { recursive: true });
  const sampleFilePath = path.join(userPostDir, '20261120_post123.mp4');
  fs.writeFileSync(sampleFilePath, 'DUMMY_MP4_CONTENT_12345');

  const { app, close } = await createApp({ dataDir });
  t.after(async () => {
    await close();
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const baseUrl = `http://127.0.0.1:${port}`;

  // 1. Check list
  const listResp = await fetch(`${baseUrl}/api/media/downloaded`);
  assert.equal(listResp.status, 200);
  const listJson = await listResp.json();
  assert.equal(listJson.ok, true);
  assert.equal(listJson.count, 1);
  assert.equal(listJson.media[0].username, 'streamer_a');
  assert.equal(listJson.media[0].fileName, '20261120_post123.mp4');

  // 2. Fetch media file content
  const fileResp = await fetch(`${baseUrl}/api/media/file/streamer_a/posts/20261120_post123.mp4`);
  assert.equal(fileResp.status, 200);
  const fileText = await fileResp.text();
  assert.equal(fileText, 'DUMMY_MP4_CONTENT_12345');

  // 3. Non-existent file -> 404
  const notFoundResp = await fetch(`${baseUrl}/api/media/file/streamer_a/posts/non_existent.mp4`);
  assert.equal(notFoundResp.status, 404);
});

