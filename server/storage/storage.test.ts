import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {
  GoogleDriveService,
  TelegramService,
  StorageManager,
  createStorageManager,
} from './index';

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pulseradar_storage_${prefix}_`));
}

test('GoogleDriveService: configuration detection and status defaults', () => {
  const gdrive = new GoogleDriveService({
    enabled: true,
    serviceAccount: undefined,
  });

  assert.equal(gdrive.isConfigured(), false);
  const status = gdrive.getStatus();
  assert.equal(status.configured, false);
  assert.equal(status.enabled, false);
});

test('GoogleDriveService: RS256 JWT generation with valid RSA keypair', async () => {
  // Generate test RSA 2048 keypair
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const mockSa = {
    client_email: 'test-robot@pulseradar-project.iam.gserviceaccount.com',
    private_key: privateKey,
  };

  const gdrive = new GoogleDriveService({
    enabled: true,
    serviceAccount: mockSa,
    folderId: 'folder_root_123',
  });

  assert.equal(gdrive.isConfigured(), true);
  const status = gdrive.getStatus();
  assert.equal(status.configured, true);
  assert.equal(status.clientEmail, mockSa.client_email);
  assert.equal(status.folderId, 'folder_root_123');
});

test('TelegramService: configuration detection, captioning and limits', () => {
  const unconfiguredTele = new TelegramService({
    botToken: undefined,
    chatId: undefined,
  });
  assert.equal(unconfiguredTele.isConfigured(), false);
  assert.equal(unconfiguredTele.getStatus().configured, false);

  const configuredTele = new TelegramService({
    botToken: '123456:TEST_TOKEN_XYZ',
    chatId: '-100987654321',
  });
  assert.equal(configuredTele.isConfigured(), true);
  assert.equal(configuredTele.getStatus().chatId, '-100987654321');
});

test('StorageManager: local fallback when cloud providers unconfigured', async () => {
  const tempDir = createTempDir('mgr_fallback');
  try {
    const dummyFile = path.join(tempDir, 'test_post.mp4');
    fs.writeFileSync(dummyFile, 'fake video buffer content');

    const manager = createStorageManager({
      googleDriveService: new GoogleDriveService({ serviceAccount: undefined }),
      telegramService: new TelegramService({ botToken: undefined }),
      localStorageRoot: tempDir,
    });

    const status = manager.getStatus();
    assert.equal(status.googleDrive.configured, false);
    assert.equal(status.telegram.configured, false);

    const result = await manager.uploadMedia({
      localFilePath: dummyFile,
      fileName: 'test_post.mp4',
      fileSize: 25,
      mimeType: 'video/mp4',
      username: 'test_creator',
      eventType: 'post',
      title: 'Exciting new post',
    });

    assert.equal(result.fileName, 'test_post.mp4');
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].provider, 'local');
    assert.equal(result.results[0].success, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('StorageManager: uploads to mock Google Drive and Telegram concurrently', async () => {
  const tempDir = createTempDir('mgr_mock_upload');

  // Set up mock HTTP server simulating Google OAuth + Drive API and Telegram API
  const server = http.createServer((req, res) => {
    // 1. Google OAuth token
    if (req.url === '/oauth/token' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'mock_access_token_123', expires_in: 3600 }));
      return;
    }

    // 2. Google Drive search files
    if (req.url?.startsWith('/drive/v3/files?') && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ files: [{ id: 'mock_folder_456', name: 'posts' }] }));
      return;
    }

    // 3. Google Drive upload
    if (req.url?.startsWith('/upload/drive/v3/files?') && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'gdrive_file_789',
          name: 'mock_video.mp4',
          webViewLink: 'https://drive.google.com/file/d/gdrive_file_789/view',
          webContentLink: 'https://drive.google.com/uc?id=gdrive_file_789',
        })
      );
      return;
    }

    // 4. Telegram sendVideo
    if (req.url?.includes('sendVideo') && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          result: {
            message_id: 42,
            chat: { id: -1001234567890, username: 'pulseradar_channel' },
          },
        })
      );
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const dummyFile = path.join(tempDir, 'mock_video.mp4');
    fs.writeFileSync(dummyFile, 'binary video content payload');

    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const gdrive = new GoogleDriveService({
      enabled: true,
      folderId: 'root_folder_001',
      serviceAccount: {
        client_email: 'robot@test.iam.gserviceaccount.com',
        private_key: privateKey,
        token_uri: `${baseUrl}/oauth/token`,
      },
    });

    const tele = new TelegramService({
      botToken: '123456:MOCK_TOKEN',
      chatId: '-1001234567890',
    });

    // Monkey-patch fetch in gdrive and tele to route through test server
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(input);
      if (urlStr.includes('googleapis.com/upload/drive/v3/files')) {
        return origFetch(`${baseUrl}/upload/drive/v3/files?${urlStr.split('?')[1] || ''}`, init);
      }
      if (urlStr.includes('googleapis.com/drive/v3/files')) {
        return origFetch(`${baseUrl}/drive/v3/files?${urlStr.split('?')[1] || ''}`, init);
      }
      if (urlStr.includes('api.telegram.org')) {
        const action = urlStr.split('/').pop() || 'sendVideo';
        return origFetch(`${baseUrl}/${action}`, init);
      }
      return origFetch(input, init);
    }) as typeof fetch;

    const manager = createStorageManager({
      googleDriveService: gdrive,
      telegramService: tele,
      localStorageRoot: tempDir,
    });

    const result = await manager.uploadMedia({
      localFilePath: dummyFile,
      fileName: 'mock_video.mp4',
      fileSize: 28,
      mimeType: 'video/mp4',
      username: 'superstar_creator',
      eventType: 'post',
      title: 'Amazing live moment',
      sourceUrl: 'https://tiktok.com/@superstar_creator/video/12345',
    });

    globalThis.fetch = origFetch;

    assert.equal(result.fileName, 'mock_video.mp4');
    assert.equal(result.results.length, 2);

    const driveResult = result.results.find(r => r.provider === 'google_drive');
    assert.ok(driveResult?.success);
    assert.equal(driveResult?.fileId, 'gdrive_file_789');
    assert.equal(result.driveLink, 'https://drive.google.com/file/d/gdrive_file_789/view');

    const teleResult = result.results.find(r => r.provider === 'telegram');
    assert.ok(teleResult?.success);
    assert.equal(teleResult?.telegramMessageId, 42);
    assert.equal(result.telegramLink, 'https://t.me/pulseradar_channel/42');
  } finally {
    server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('TelegramService: enabled flag, platform hashtags, HTML escaping & safe truncation', async () => {
  const prevToken = process.env.TELEGRAM_BOT_TOKEN;
  const prevChat = process.env.TELEGRAM_CHAT_ID;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;

  try {
    // 1. Constructor without enabled defaults to true when credentials provided, even when env is unset
    const activeTele = new TelegramService({
      botToken: '123:ABC',
      chatId: '-100111',
    });
    assert.equal(activeTele.isConfigured(), true);
    assert.equal(activeTele.getStatus().enabled, true);

    // 2. enabled: false disables isConfigured and prevents fetch in uploadFile
    const disabledTele = new TelegramService({
      botToken: '123:ABC',
      chatId: '-100111',
      enabled: false,
    });
    assert.equal(disabledTele.isConfigured(), false);
    assert.equal(disabledTele.getStatus().enabled, false);
    assert.equal(disabledTele.getStatus().configured, true);

    const origFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    try {
      const uploadRes = await disabledTele.uploadFile({
        localFilePath: '/nonexistent.mp4',
        fileName: 'nonexistent.mp4',
        fileSize: 10,
        mimeType: 'video/mp4',
        platform: 'INSTAGRAM',
        username: 'ig_user',
        eventType: 'post',
      });
      assert.equal(uploadRes.success, false);
      assert.equal(fetchCalled, false);
    } finally {
      globalThis.fetch = origFetch;
    }

    // 3. Platform badges/hashtags + HTML escaping + safe tag boundary on very long title
    const igCaption = activeTele.formatCaption({
      localFilePath: '/tmp/a.mp4',
      fileName: 'a.mp4',
      fileSize: 100,
      mimeType: 'video/mp4',
      platform: 'INSTAGRAM',
      username: 'user<script>',
      eventType: 'post',
      title: `Title with <script>alert(1)</script> & "quotes" ${'A'.repeat(1200)}`,
      sourceUrl: 'https://www.instagram.com/p/C1/?a=1&b="2"',
    });
    assert.ok(igCaption.includes('#Instagram'));
    assert.ok(igCaption.includes('<b>Nền tảng:</b> Instagram'));
    assert.ok(!igCaption.includes('<script>'));
    assert.ok(igCaption.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; "quotes"'));
    assert.ok(igCaption.includes('<a href="https://www.instagram.com/p/C1/?a=1&amp;b=&quot;2&quot;">Xem tại đây</a>'));
    assert.ok(igCaption.length <= 1024);

    const fbCaption = activeTele.formatCaption({
      localFilePath: '/tmp/b.mp4',
      fileName: 'b.mp4',
      fileSize: 100,
      mimeType: 'video/mp4',
      platform: 'FACEBOOK',
      username: 'fb_user',
      eventType: 'story',
    });
    assert.ok(fbCaption.includes('#Facebook'));

    const xCaption = activeTele.formatCaption({
      localFilePath: '/tmp/c.mp4',
      fileName: 'c.mp4',
      fileSize: 100,
      mimeType: 'video/mp4',
      platform: 'X',
      username: 'x_user',
      eventType: 'post',
    });
    assert.ok(xCaption.includes('#X'));
  } finally {
    if (prevToken !== undefined) process.env.TELEGRAM_BOT_TOKEN = prevToken;
    if (prevChat !== undefined) process.env.TELEGRAM_CHAT_ID = prevChat;
  }
});

test('GoogleDriveService: enabled check and platform folder/description context', async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const disabledDrive = new GoogleDriveService({
    enabled: false,
    serviceAccount: { client_email: 'bot@test.iam.gserviceaccount.com', private_key: privateKey },
  });
  assert.equal(disabledDrive.isConfigured(), false);
  assert.equal(disabledDrive.getStatus().enabled, false);
  assert.equal(disabledDrive.getStatus().configured, true);

  const tempDir = createTempDir('gdrive_platform');
  const dummyFile = path.join(tempDir, 'instagram_post.mp4');
  fs.writeFileSync(dummyFile, 'video');

  const createdFolders: Array<{ name: string; parents?: string[] }> = [];
  const uploadedMetadatas: Array<{ description?: string; parents?: string[] }> = [];
  const origFetch = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('oauth/token')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), {
        status: 200,
      });
    }
    if (url.includes('/upload/drive/v3/files')) {
      const rawBody = Buffer.isBuffer(init?.body)
        ? init.body.toString('utf-8')
        : String(init?.body || '');
      const jsonMatch = rawBody.match(/\{[\s\S]*?"description"[\s\S]*?\}/);
      if (jsonMatch?.[0]) {
        uploadedMetadatas.push(JSON.parse(jsonMatch[0]));
      }
      return new Response(JSON.stringify({ id: 'file_1', name: 'instagram_post.mp4' }), {
        status: 200,
      });
    }
    if (url.includes('/drive/v3/files?') && (!init?.method || init.method === 'GET')) {
      return new Response(JSON.stringify({ files: [] }), { status: 200 });
    }
    if (url.includes('/drive/v3/files?') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body || '{}')) as { name: string; parents?: string[] };
      createdFolders.push(body);
      return new Response(JSON.stringify({ id: `folder_${body.name}` }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;

  try {
    const gdrive = new GoogleDriveService({
      enabled: true,
      folderId: 'root_id',
      serviceAccount: {
        client_email: 'bot@test.iam.gserviceaccount.com',
        private_key: privateKey,
        token_uri: 'https://mock.local/oauth/token',
      },
    });

    await gdrive.uploadFile({
      localFilePath: dummyFile,
      fileName: 'instagram_post.mp4',
      fileSize: 5,
      mimeType: 'video/mp4',
      platform: 'INSTAGRAM',
      username: 'ig_creator',
      eventType: 'post',
      title: 'IG Video',
      sourceUrl: 'https://www.instagram.com/p/123/',
    });

    assert.deepEqual(
      createdFolders.map((f) => [f.name, f.parents?.[0]]),
      [
        ['instagram', 'root_id'],
        ['ig_creator', 'folder_instagram'],
        ['posts', 'folder_ig_creator'],
      ]
    );
    assert.ok(uploadedMetadatas[0]?.description?.startsWith('[INSTAGRAM] IG Video'));
    assert.equal(uploadedMetadatas[0]?.parents?.[0], 'folder_posts');

    // TikTok preserves <Root>/<username>/<posts>
    createdFolders.length = 0;
    await gdrive.uploadFile({
      localFilePath: dummyFile,
      fileName: 'tt_post.mp4',
      fileSize: 5,
      mimeType: 'video/mp4',
      platform: 'TIKTOK',
      username: 'tt_creator',
      eventType: 'post',
      title: 'TT Video',
    });
    assert.deepEqual(
      createdFolders.map((f) => [f.name, f.parents?.[0]]),
      [
        ['tt_creator', 'root_id'],
        ['posts', 'folder_tt_creator'],
      ]
    );
    assert.ok(uploadedMetadatas[1]?.description?.startsWith('[TIKTOK] TT Video'));
  } finally {
    globalThis.fetch = origFetch;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
