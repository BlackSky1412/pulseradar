import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {
  resolveDriveStorageRoot,
  resolveTargetDir,
  downloadFileAtomic,
  createMediaDownloader,
  resolveHighQualityMedia,
} from '../../server/mediaDownloader';
import type { TikTokEvent } from '../../server/watchers/types';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pulseradar-media-test-'));
}

test('MediaDownloader: resolveDriveStorageRoot and resolveTargetDir hierarchy', () => {
  const customRoot = createTempDir();
  try {
    const root = resolveDriveStorageRoot(customRoot);
    assert.equal(root, path.resolve(customRoot));

    const postDir = resolveTargetDir(root, 'TestUser.123', 'post');
    assert.ok(postDir.endsWith(path.join('testuser.123', 'posts')));
    assert.ok(fs.existsSync(postDir));

    const storyDir = resolveTargetDir(root, 'TestUser.123', 'story');
    assert.ok(storyDir.endsWith(path.join('testuser.123', 'stories')));
    assert.ok(fs.existsSync(storyDir));
  } finally {
    fs.rmSync(customRoot, { recursive: true, force: true });
  }
});

test('MediaDownloader: downloadFileAtomic downloads and atomically renames', async () => {
  const tempDir = createTempDir();
  const samplePayload = 'MP4_SAMPLE_VIDEO_CONTENT_BYTES_1234567890';

  const mockServer = http.createServer((_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': Buffer.byteLength(samplePayload).toString(),
    });
    res.end(samplePayload);
  });

  await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', () => resolve()));
  const port = (mockServer.address() as { port: number }).port;
  const mockUrl = `http://127.0.0.1:${port}/video.mp4`;

  try {
    const destPath = path.join(tempDir, 'sample_20261120_123.mp4');
    const result = await downloadFileAtomic(mockUrl, destPath, 5000);

    assert.equal(result.fileSize, Buffer.byteLength(samplePayload));
    assert.equal(result.mimeType, 'video/mp4');
    assert.ok(fs.existsSync(destPath));
    assert.equal(fs.readFileSync(destPath, 'utf-8'), samplePayload);

    // Verify no stray .tmp files exist
    const files = fs.readdirSync(tempDir);
    assert.equal(files.length, 1);
    assert.equal(files[0], 'sample_20261120_123.mp4');
  } finally {
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('MediaDownloader: resolveHighQualityMedia prioritizes metadata video and photos', async () => {
  const postEvent: TikTokEvent = {
    username: 'creator1',
    eventType: 'post',
    itemId: 'post_99991',
    url: 'https://tiktok.com/@creator1/video/post_99991',
    title: 'High Res Video',
    detectedAt: new Date().toISOString(),
    metadata: {
      videoUrl: 'https://cdn.example.com/high_origin.mp4',
    },
  };

  const candidates = await resolveHighQualityMedia(postEvent);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].url, 'https://cdn.example.com/high_origin.mp4');
  assert.equal(candidates[0].ext, 'mp4');
  assert.equal(candidates[0].isHighQuality, true);
});

test('MediaDownloader: downloadEventMedia writes structured hierarchical files', async () => {
  const tempDir = createTempDir();
  const sampleData = 'STORY_IMAGE_HIGH_QUALITY_DATA';

  const mockServer = http.createServer((_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': Buffer.byteLength(sampleData).toString(),
    });
    res.end(sampleData);
  });

  await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', () => resolve()));
  const port = (mockServer.address() as { port: number }).port;

  try {
    const downloader = createMediaDownloader({ storageRoot: tempDir, timeoutMs: 5000 });
    const storyEvent: TikTokEvent = {
      username: 'daily_vlog',
      eventType: 'story',
      itemId: 'story_8888',
      url: 'https://tiktok.com/@daily_vlog',
      title: 'Morning Coffee',
      thumbnailUrl: `http://127.0.0.1:${port}/story_cover.jpg`,
      detectedAt: '2026-11-20T08:00:00.000Z',
    };

    const res = await downloader.downloadEventMedia(storyEvent);
    assert.equal(res.success, true);
    assert.equal(res.username, 'daily_vlog');
    assert.equal(res.eventType, 'story');
    assert.equal(res.files.length, 1);
    assert.ok(res.files[0].fileName.includes('story_8888.jpg'));
    assert.ok(fs.existsSync(res.files[0].path));
    assert.equal(fs.readFileSync(res.files[0].path, 'utf-8'), sampleData);
  } finally {
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
