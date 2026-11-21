import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createMediaDownloader,
  downloadFileAtomic,
  getDefaultRefererForPlatform,
  resolveHighQualityMedia,
} from './mediaDownloader';
import type { StorageManager } from './storage/index';
import type { StorageUploadParams } from './storage/types';
import type { WatcherEvent } from './watchers/types';

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pulseradar_m2_media_${prefix}_`));
}

test('MediaDownloader: TikWM API is strictly gated to TIKTOK platform', async () => {
  const origFetch = globalThis.fetch;
  const calledUrls: string[] = [];

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calledUrls.push(url);
    return new Response(
      JSON.stringify({
        code: 0,
        data: { hdplay: 'https://cdn.tikwm.com/hd.mp4' },
      }),
      { status: 200 }
    );
  }) as typeof fetch;

  try {
    for (const platform of ['INSTAGRAM', 'FACEBOOK', 'X'] as const) {
      calledUrls.length = 0;
      const event: WatcherEvent = {
        platform,
        username: 'creator',
        eventType: 'post',
        itemId: 'item_1',
        url: 'https://example.com/p/1',
        title: 'Post',
        detectedAt: new Date().toISOString(),
      };
      const candidates = await resolveHighQualityMedia(event, 1000);
      assert.equal(candidates.length, 0);
      assert.equal(
        calledUrls.some((u) => u.includes('tikwm.com')),
        false,
        `TikWM must NOT be called for ${platform}`
      );
    }

    // TIKTOK event without metadata DOES call TikWM
    calledUrls.length = 0;
    const ttEvent: WatcherEvent = {
      platform: 'TIKTOK',
      username: 'creator',
      eventType: 'post',
      itemId: 'item_tt',
      url: 'https://www.tiktok.com/@creator/video/item_tt',
      title: 'TT Post',
      detectedAt: new Date().toISOString(),
    };
    const ttCandidates = await resolveHighQualityMedia(ttEvent, 1000);
    assert.equal(ttCandidates.length, 1);
    assert.equal(ttCandidates[0].url, 'https://cdn.tikwm.com/hd.mp4');
    assert.ok(calledUrls.some((u) => u.includes('tikwm.com')));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('MediaDownloader: resolveHighQualityMedia handles videoUrls array and photo extensions', async () => {
  const event: WatcherEvent = {
    platform: 'INSTAGRAM',
    username: 'carousel_user',
    eventType: 'post',
    itemId: 'c1',
    url: 'https://www.instagram.com/p/C1/',
    title: 'Carousel',
    detectedAt: new Date().toISOString(),
    metadata: {
      videoUrls: ['https://cdn.ig.com/v1.mp4', 'https://cdn.ig.com/v2.mp4'],
      photoUrls: ['https://cdn.ig.com/p1.webp?stp=1', 'https://cdn.ig.com/p2.png'],
    },
  };

  const candidates = await resolveHighQualityMedia(event);
  assert.equal(candidates.length, 4);
  assert.equal(candidates[0].ext, 'mp4');
  assert.equal(candidates[1].ext, 'mp4');
  assert.equal(candidates[2].ext, 'webp');
  assert.equal(candidates[3].ext, 'png');
});

test('MediaDownloader: downloadFileAtomic merges headers case-insensitively and omits blank Cookie', async () => {
  const tempDir = createTempDir('headers');
  const observedHeaders: Array<Record<string, string | string[] | undefined>> = [];

  const server = http.createServer((req, res) => {
    observedHeaders.push(req.headers);
    res.writeHead(200, { 'Content-Type': 'video/mp4' });
    res.end('VIDEO_BYTES');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const mediaUrl = `http://127.0.0.1:${port}/test.mp4`;

  try {
    // 1. Legacy number overload
    await downloadFileAtomic(mediaUrl, path.join(tempDir, 'legacy.mp4'), 5000);
    assert.equal(observedHeaders[0].referer, 'https://www.tiktok.com/');
    assert.equal(observedHeaders[0].cookie, undefined);

    // 2. Object options with lowercase referer override and whitespace cookie
    await downloadFileAtomic(mediaUrl, path.join(tempDir, 'custom.mp4'), {
      timeoutMs: 5000,
      referer: 'https://www.instagram.com/',
      headers: { referer: 'https://instagram.com/custom', Cookie: '   ' },
      cookie: '   ',
    });
    assert.equal(observedHeaders[1].referer, 'https://instagram.com/custom');
    assert.equal(observedHeaders[1].cookie, undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('MediaDownloader: collision-safe naming, platform Referer, and storageManager platform forwarding', async () => {
  const tempDir = createTempDir('collision');
  const receivedReferers: string[] = [];
  const receivedCustomHeaders: Array<string | undefined> = [];

  const server = http.createServer((req, res) => {
    receivedReferers.push(String(req.headers.referer || ''));
    receivedCustomHeaders.push(req.headers['x-custom-dl'] ? String(req.headers['x-custom-dl']) : undefined);
    res.writeHead(200, { 'Content-Type': 'video/mp4' });
    res.end('MEDIA_DATA_BYTES');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;

  const uploadedParams: StorageUploadParams[] = [];
  const fakeStorageManager = {
    uploadMedia: async (params: StorageUploadParams) => {
      uploadedParams.push(params);
      return {
        fileName: params.fileName,
        localPath: params.localFilePath,
        results: [{ provider: 'local' as const, success: true, fileId: params.fileName }],
      };
    },
  } as unknown as StorageManager;

  try {
    const downloader = createMediaDownloader({
      storageRoot: tempDir,
      timeoutMs: 5000,
      storageManager: fakeStorageManager,
    });

    const platforms = ['TIKTOK', 'INSTAGRAM', 'FACEBOOK', 'X'] as const;
    const savedPaths: string[] = [];

    for (const platform of platforms) {
      const res = await downloader.downloadEventMedia({
        platform,
        username: 'creator',
        eventType: 'post',
        itemId: '999',
        url: `https://example.com/${platform}/999`,
        title: `${platform} Post`,
        detectedAt: new Date().toISOString(),
        metadata: {
          videoUrl: `http://127.0.0.1:${port}/${platform}.mp4`,
          downloadHeaders: { 'X-Custom-Dl': `dl-${platform}` },
        },
      });

      assert.equal(res.success, true);
      assert.equal(res.platform, platform);
      assert.equal(res.files.length, 1);
      savedPaths.push(res.files[0].path);
    }

    // All 4 paths must be unique and inside <root>/creator/posts/
    assert.equal(new Set(savedPaths).size, 4);
    assert.ok(path.basename(savedPaths[0]).match(/^\d{8}_999\.mp4$/));
    assert.ok(path.basename(savedPaths[1]).startsWith('instagram_'));
    assert.ok(path.basename(savedPaths[2]).startsWith('facebook_'));
    assert.ok(path.basename(savedPaths[3]).startsWith('x_'));

    assert.deepEqual(
      receivedReferers,
      platforms.map((p) => getDefaultRefererForPlatform(p))
    );
    assert.deepEqual(
      receivedCustomHeaders,
      platforms.map((p) => `dl-${p}`)
    );
    assert.deepEqual(
      uploadedParams.map((u) => u.platform),
      ['TIKTOK', 'INSTAGRAM', 'FACEBOOK', 'X']
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
