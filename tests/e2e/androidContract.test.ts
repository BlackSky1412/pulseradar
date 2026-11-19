import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createMockAndroidReceiver } from './harness.ts';
import type {
  AndroidHealthResponse,
  ErrorResponse,
  MockAndroidReceiver,
  RecordResponse,
} from './types.ts';

const liveUrl = process.env.E2E_ANDROID_URL?.trim().replace(/\/+$/, '') || '';
const allowLiveRecord = process.env.E2E_ANDROID_ALLOW_LIVE_RECORD === '1';
const testStreamUrl =
  process.env.E2E_ANDROID_TEST_STREAM_URL?.trim() || 'https://cdn.example/e2e-test-origin.flv';

let mockReceiver: MockAndroidReceiver | null = null;
let targetBaseUrl = liveUrl;

before(async () => {
  if (!liveUrl) {
    mockReceiver = await createMockAndroidReceiver({ ip: '127.0.0.1' });
    targetBaseUrl = mockReceiver.url;
  }
});

after(async () => {
  if (mockReceiver) {
    await mockReceiver.close();
  }
});

test('AC-01: GET /health returns Contract 4 schema with pollingDisabled: true', async () => {
  const resp = await fetch(`${targetBaseUrl}/health`);
  assert.equal(resp.status, 200);
  const contentType = resp.headers.get('content-type') || '';
  assert.match(contentType, /application\/json/i);

  const body = (await resp.json()) as AndroidHealthResponse;
  assert.equal(body.ok, true);
  assert.equal(body.pollingDisabled, true);
  assert.ok(
    Number.isInteger(body.listeningPort) && body.listeningPort > 0 && body.listeningPort <= 65535
  );
  assert.ok(typeof body.ip === 'string' && body.ip.length > 0);
  assert.ok(Number.isInteger(body.activeRecordings) && body.activeRecordings >= 0);
  assert.ok(Number.isInteger(body.userCount) && body.userCount >= 0);
  assert.ok(body.lastSyncAt === null || typeof body.lastSyncAt === 'string');
});

test('AC-02: POST /record returns 400 on malformed JSON', async () => {
  const resp = await fetch(`${targetBaseUrl}/record`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not-valid-json',
  });
  assert.equal(resp.status, 400);
  const body = (await resp.json()) as ErrorResponse;
  assert.equal(body.ok, false);
});

test('AC-03: POST /record returns 400 on invalid platform', async () => {
  const resp = await fetch(`${targetBaseUrl}/record`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      platform: 'TWITCH',
      username: 'streamer1',
      streamUrl: 'https://cdn.example/s.flv',
    }),
  });
  assert.equal(resp.status, 400);
  const body = (await resp.json()) as ErrorResponse;
  assert.equal(body.ok, false);
});

test('AC-04: POST /record returns 400 on missing username and usernameOrUrl', async () => {
  for (const payload of [
    { platform: 'TIKTOK', streamUrl: 'https://cdn.example/s.flv' },
    { platform: 'TIKTOK', username: '   ', usernameOrUrl: '', streamUrl: 'https://cdn.example/s.flv' },
  ]) {
    const resp = await fetch(`${targetBaseUrl}/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(resp.status, 400);
    const body = (await resp.json()) as ErrorResponse;
    assert.equal(body.ok, false);
  }
});

test('AC-05: POST /record returns 400 on blank or omitted streamUrl', async () => {
  for (const payload of [
    { platform: 'TIKTOK', username: 'mixigaming', streamUrl: '   ' },
    { platform: 'TIKTOK', username: 'mixigaming' },
  ]) {
    const resp = await fetch(`${targetBaseUrl}/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(resp.status, 400);
    const body = (await resp.json()) as ErrorResponse;
    assert.equal(body.ok, false);
  }
});

test('AC-06: POST /record returns 202 RECORDING_STARTED on valid live payload', async (t) => {
  if (liveUrl && !allowLiveRecord) {
    t.skip('Live device mutating POST /record requires E2E_ANDROID_ALLOW_LIVE_RECORD=1');
    return;
  }

  const resp = await fetch(`${targetBaseUrl}/record`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      eventId: `evt_${Date.now()}_mixigaming`,
      platform: 'TIKTOK',
      username: 'mixigaming',
      usernameOrUrl: '@mixigaming',
      streamUrl: testStreamUrl,
      title: 'E2E Contract Live Stream',
      sourceUrl: 'https://www.tiktok.com/@mixigaming/live',
      qualityInfo: 'FLV [origin]',
      detectedAt: new Date().toISOString(),
    }),
  });
  assert.equal(resp.status, 202);
  const body = (await resp.json()) as RecordResponse;
  assert.equal(body.ok, true);
  assert.equal(body.status, 'RECORDING_STARTED');
  assert.equal(body.platform, 'TIKTOK');
  assert.equal(body.username, 'mixigaming');
});

test('AC-07: POST /record returns 200 ALREADY_RECORDING when user is active and normalizes TWITTER -> X', async (t) => {
  if (liveUrl && !allowLiveRecord) {
    t.skip('Live device mutating POST /record requires E2E_ANDROID_ALLOW_LIVE_RECORD=1');
    return;
  }

  const dupResp = await fetch(`${targetBaseUrl}/record`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      platform: 'TIKTOK',
      username: 'mixigaming',
      usernameOrUrl: '@mixigaming',
      streamUrl: testStreamUrl,
    }),
  });
  assert.equal(dupResp.status, 200);
  const dupBody = (await dupResp.json()) as RecordResponse;
  assert.equal(dupBody.ok, true);
  assert.equal(dupBody.status, 'ALREADY_RECORDING');

  if (mockReceiver) {
    const twResp = await fetch(`${targetBaseUrl}/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: 'TWITTER',
        username: 'Minalatuinehehe',
        streamUrl: testStreamUrl,
      }),
    });
    assert.equal(twResp.status, 202);
    const twBody = (await twResp.json()) as RecordResponse;
    assert.equal(twBody.platform, 'X');
    assert.equal(twBody.username, 'minalatuinehehe');

    const xDupResp = await fetch(`${targetBaseUrl}/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: 'X',
        username: '@minalatuinehehe',
        streamUrl: testStreamUrl,
      }),
    });
    assert.equal(xDupResp.status, 200);
    assert.equal(((await xDupResp.json()) as RecordResponse).status, 'ALREADY_RECORDING');
  }
});

test('AC-08: POST /record enforces cellular policy (200 SKIPPED_CELLULAR_POLICY vs 202 when allowCellular=true)', async (t) => {
  if (liveUrl || !mockReceiver) {
    t.skip('Mock-only cellular policy toggle when E2E_ANDROID_URL is set');
    return;
  }

  mockReceiver.seedUser({
    platform: 'INSTAGRAM',
    username: 'cellular_blocked',
    allowCellular: false,
    status: 'IDLE',
  });
  mockReceiver.seedUser({
    platform: 'INSTAGRAM',
    username: 'cellular_allowed',
    allowCellular: true,
    status: 'IDLE',
  });
  mockReceiver.setFaultConfig({ networkOnline: true, isWifi: false });

  const blockedResp = await fetch(`${targetBaseUrl}/record`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      platform: 'INSTAGRAM',
      username: 'cellular_blocked',
      streamUrl: testStreamUrl,
    }),
  });
  assert.equal(blockedResp.status, 200);
  const blockedBody = (await blockedResp.json()) as RecordResponse;
  assert.equal(blockedBody.ok, true);
  assert.equal(blockedBody.status, 'SKIPPED_CELLULAR_POLICY');

  const allowedResp = await fetch(`${targetBaseUrl}/record`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      platform: 'INSTAGRAM',
      username: 'cellular_allowed',
      streamUrl: testStreamUrl,
    }),
  });
  assert.equal(allowedResp.status, 202);
  const allowedBody = (await allowedResp.json()) as RecordResponse;
  assert.equal(allowedBody.ok, true);
  assert.equal(allowedBody.status, 'RECORDING_STARTED');
});
