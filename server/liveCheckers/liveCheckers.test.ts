import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectLivePlatform,
  extractLiveUsername,
  extractTikTokUsername,
  extractInstagramUsername,
  extractFacebookUsername,
  extractXUsername,
  extractUrlFromStreamDataJson,
  formatInstagramCookie,
  extractFacebookStreamFromHtml,
  extractXBroadcastIdsFromHtml,
} from './index';
import {
  buildWebhookPayload,
  isLiveUserTarget,
  resolveLivePlatformForTarget,
} from '../../src/utils/scannerEngine';

test('detectLivePlatform accurately resolves TikTok, Instagram, Facebook, and X from URLs, domains, and fallback keys', () => {
  assert.equal(detectLivePlatform('https://www.tiktok.com/@mixigaming/live'), 'TIKTOK');
  assert.equal(detectLivePlatform('https://www.instagram.com/tiennugovap/live/'), 'INSTAGRAM');
  assert.equal(detectLivePlatform('https://fb.watch/abc123/'), 'FACEBOOK');
  assert.equal(detectLivePlatform('https://www.facebook.com/vtv24/live/'), 'FACEBOOK');
  assert.equal(detectLivePlatform('https://x.com/i/broadcasts/1kvJpmapzboxE'), 'X');
  assert.equal(detectLivePlatform('broadcast_1kvJpmapzboxE'), 'X');

  // Domain hints
  assert.equal(detectLivePlatform('@vtv24', 'TIKTOK', 'facebook.com'), 'FACEBOOK');
  assert.equal(detectLivePlatform('@cristiano', 'TIKTOK', 'instagram.com'), 'INSTAGRAM');
  assert.equal(detectLivePlatform('@elonmusk', 'TIKTOK', 'x.com'), 'X');

  // PulseRadar internal platform keys
  assert.equal(detectLivePlatform('@user1', 'reddit'), 'TIKTOK');
  assert.equal(detectLivePlatform('@user1', 'hackernews'), 'INSTAGRAM');
  assert.equal(detectLivePlatform('@user1', 'bluesky'), 'X');
  assert.equal(detectLivePlatform('@user1', 'github'), 'FACEBOOK');
});

test('username extractors handle profiles, live URLs, broadcast IDs, and video IDs', () => {
  assert.equal(extractTikTokUsername('https://www.tiktok.com/@mixigaming/live?enter_from=1'), 'mixigaming');
  assert.equal(extractTikTokUsername('@vtv24'), 'vtv24');

  assert.equal(extractInstagramUsername('https://www.instagram.com/cristiano/live/?hl=vi'), 'cristiano');
  assert.equal(extractInstagramUsername('@tiennugovap'), 'tiennugovap');

  assert.equal(extractFacebookUsername('https://www.facebook.com/profile.php?id=100064789123456'), '100064789123456');
  assert.equal(extractFacebookUsername('https://www.facebook.com/watch/?v=987654321'), 'video_987654321');
  assert.equal(extractFacebookUsername('https://www.facebook.com/vtv24/live/'), 'vtv24');

  assert.equal(extractXUsername('https://x.com/i/broadcasts/1kvJpmapzboxE'), 'broadcast_1kvJpmapzboxE');
  assert.equal(extractXUsername('https://x.com/elonmusk/status/1234567890'), 'elonmusk');
  assert.equal(extractXUsername('https://x.com/openai'), 'openai');

  assert.equal(extractLiveUsername('https://www.instagram.com/nasa/', 'TIKTOK'), 'nasa');
});

test('extractUrlFromStreamDataJson skips audio-only and picks origin highest quality stream', () => {
  const sampleStreamData = JSON.stringify({
    data: {
      ao: {
        main: { flv: 'https://cdn.example/audio_only.flv', hls: '' },
      },
      hd: {
        main: {
          flv: 'https://cdn.example/hd.flv',
          hls: 'https://cdn.example/hd.m3u8',
          sdk_params: JSON.stringify({ vbitrate: 2000000, fps: 30, resolution: '720x1280', VCodec: 'h264' }),
        },
      },
      origin: {
        main: {
          flv: 'https://cdn.example/origin.flv',
          hls: 'https://cdn.example/origin.m3u8',
          sdk_params: JSON.stringify({ vbitrate: 6000000, fps: 60, resolution: '1080x1920', VCodec: 'h264' }),
        },
      },
    },
  });

  const result = extractUrlFromStreamDataJson(sampleStreamData);
  assert.ok(result);
  assert.equal(result.url, 'https://cdn.example/origin.flv');
  assert.ok(result.qualityInfo?.includes('[origin]'));
  assert.ok(result.qualityInfo?.includes('1080x1920'));
});

test('formatInstagramCookie expands bare sessionid with ds_user_id', () => {
  assert.equal(
    formatInstagramCookie('50160641448%3Aabcdef123456'),
    'sessionid=50160641448%3Aabcdef123456; ds_user_id=50160641448'
  );
  assert.equal(formatInstagramCookie('sessionid=abc; csrftoken=xyz'), 'sessionid=abc; csrftoken=xyz');
  assert.equal(formatInstagramCookie('invalid_without_colon'), '');
});

test('extractFacebookStreamFromHtml prioritizes DASH-ABR and ignores non-live HTML', () => {
  assert.equal(extractFacebookStreamFromHtml('<html><body>Normal profile</body></html>'), null);

  const liveHtml = `
    <script>
      {"is_live_streaming":true,"hls_playback_url":"https:\\/\\/video.fbcdn.net\\/live.m3u8?a=1\\u0026b=2","dash_abr_playback_url":"https:\\/\\/video.fbcdn.net\\/live.mpd?a=1\\u0026b=2"}
    </script>
  `;
  const extracted = extractFacebookStreamFromHtml(liveHtml);
  assert.ok(extracted);
  assert.equal(extracted.streamUrl, 'https://video.fbcdn.net/live.mpd?a=1&b=2');
  assert.equal(extracted.qualityInfo, 'DASH-ABR (.mpd)');
});

test('extractXBroadcastIdsFromHtml extracts unique broadcast IDs', () => {
  const html = `
    <a href="/i/broadcasts/1kvJpmapzboxE">Live 1</a>
    {"broadcast_id":"2BlLMqBpBoLkPo"}
    <a href="/i/broadcasts/1kvJpmapzboxE">Duplicate</a>
  `;
  assert.deepEqual(extractXBroadcastIdsFromHtml(html), ['1kvJpmapzboxE', '2BlLMqBpBoLkPo']);
});

test('scannerEngine helpers identify live user targets and attach streamUrl to webhook payload', () => {
  assert.equal(isLiveUserTarget('@mixigaming'), true);
  assert.equal(isLiveUserTarget('https://www.tiktok.com/@vtv24/live'), true);
  assert.equal(isLiveUserTarget('cristiano'), true);
  assert.equal(isLiveUserTarget('livestream flashsale'), false);
  assert.equal(isLiveUserTarget('(postgres|supabase)'), false);

  assert.equal(resolveLivePlatformForTarget('@user', 'hackernews', 'instagram.com'), 'INSTAGRAM');

  const payload = buildWebhookPayload('json', {
    ruleId: 'rule_1',
    keyword: '@mixigaming',
    matchType: 'regex',
    platform: 'reddit',
    livePlatform: 'TIKTOK',
    sourceDomain: 'tiktok.com',
    activityType: 'live',
    author: 'mixigaming',
    title: 'Đang Live',
    contentSnippet: 'Live trên TikTok',
    sourceUrl: 'https://www.tiktok.com/@mixigaming/live',
    streamUrl: 'https://cdn.example/origin.flv',
    qualityInfo: 'FLV [origin]',
    detectionMethod: 'tiktok:api-live(desktop)',
    detectedAt: '2026-11-18T15:00:00.000Z',
  }) as { activity: Record<string, unknown>; sourceWebsite: Record<string, unknown> };

  assert.equal(payload.sourceWebsite.livePlatform, 'TIKTOK');
  assert.equal(payload.activity.streamUrl, 'https://cdn.example/origin.flv');
  assert.equal(payload.activity.qualityInfo, 'FLV [origin]');
  assert.equal(payload.activity.detectionMethod, 'tiktok:api-live(desktop)');
});
