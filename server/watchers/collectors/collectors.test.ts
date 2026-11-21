import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CollectorDiagnosticError,
  normalizeUsername,
} from './base';
import {
  createPlatformLiveCollector,
  FacebookLiveCollector,
  InstagramLiveCollector,
  XLiveCollector,
} from './platformLive';
import { TikTokPostCollector } from './tiktokPost';
import { TikTokStoryCollector } from './tiktokStory';
import { clearInstagramUserIdCache } from './instagramShared';
import { InstagramPostCollector } from './instagramPost';
import { InstagramStoryCollector } from './instagramStory';
import { FacebookPostCollector } from './facebookPost';
import { FacebookStoryCollector } from './facebookStory';
import { clearXGuestTokenCache } from './xShared';
import { XPostCollector } from './xPost';
import { XStoryCollector } from './xStory';

function headerValue(init: RequestInit | undefined, key: string): string | undefined {
  if (!init?.headers || typeof init.headers !== 'object' || Array.isArray(init.headers)) {
    return undefined;
  }
  const target = key.toLowerCase();
  for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
    if (k.toLowerCase() === target) return String(v);
  }
  return undefined;
}

test('normalizeUsername: handles all 4 platforms and rejects reserved/scheme fallbacks', () => {
  assert.equal(normalizeUsername('@user_1', 'TIKTOK'), 'user_1');
  assert.equal(normalizeUsername('https://www.tiktok.com/@user_1/live?x=1', 'TIKTOK'), 'user_1');
  assert.equal(normalizeUsername('https://www.tiktok.com/user_1', 'TIKTOK'), 'user_1');

  assert.equal(normalizeUsername('https://instagr.am/panbaozhen16/', 'INSTAGRAM'), 'panbaozhen16');
  assert.equal(
    normalizeUsername('https://www.instagram.com/stories/panbaozhen16/123456/', 'INSTAGRAM'),
    'panbaozhen16'
  );
  assert.equal(normalizeUsername('https://www.instagram.com/p/C123/', 'INSTAGRAM'), '');
  assert.equal(normalizeUsername('https://www.instagram.com/explore/', 'INSTAGRAM'), '');

  assert.equal(
    normalizeUsername('https://www.facebook.com/profile.php?id=100002950203435', 'FACEBOOK'),
    '100002950203435'
  );
  assert.equal(
    normalizeUsername('https://www.facebook.com/people/John-Doe/100064789/', 'FACEBOOK'),
    '100064789'
  );
  assert.equal(normalizeUsername('@luvtint', 'FACEBOOK'), 'luvtint');

  assert.equal(
    normalizeUsername('https://x.com/i/broadcasts/1kvJpmapzboxE', 'X'),
    'broadcast_1kvJpmapzboxE'
  );
  assert.equal(
    normalizeUsername('https://x.com/Elinaaa2511/status/123456789', 'X'),
    'Elinaaa2511'
  );
  assert.equal(normalizeUsername('https://x.com/i/flow/login', 'X'), '');
});

test('PlatformLiveCollector: LIVE stability, NOT_LIVE, HTTP error diagnostics, and cookie isolation', async () => {
  // Stable session ID across rotating CDN query strings
  const ig1 = new InstagramLiveCollector({
    checker: async (username) => ({
      status: 'LIVE',
      platform: 'INSTAGRAM',
      username,
      title: 'IG Live Session',
      streamUrl: 'https://scontent.cdninstagram.com/v/t50/stream-9876543210987654.mpd?oe=111&oh=aaa',
      sourceUrl: `https://www.instagram.com/${username}/live/`,
      checkedAt: '2026-11-21T09:00:00.000Z',
    }),
  });
  const ig2 = new InstagramLiveCollector({
    checker: async (username) => ({
      status: 'LIVE',
      platform: 'INSTAGRAM',
      username,
      title: 'IG Live Session',
      streamUrl: 'https://scontent.cdninstagram.com/v/t50/stream-9876543210987654.mpd?oe=222&oh=bbb',
      sourceUrl: `https://www.instagram.com/${username}/live/`,
      checkedAt: '2026-11-21T09:01:00.000Z',
    }),
  });

  const events1 = await ig1.fetch('ig_creator');
  const events2 = await ig2.fetch('ig_creator');
  assert.equal(events1.length, 1);
  assert.equal(events1[0].platform, 'INSTAGRAM');
  assert.equal(events1[0].itemId, '9876543210987654');
  assert.equal(events1[0].itemId, events2[0].itemId);

  // NOT_LIVE -> OK with []
  const fbNotLive = new FacebookLiveCollector({
    checker: async (username) => ({
      status: 'NOT_LIVE',
      platform: 'FACEBOOK',
      username,
      sourceUrl: `https://www.facebook.com/${username}/live`,
      checkedAt: '2026-11-21T09:00:00.000Z',
    }),
  });
  const notLiveDiag = await fbNotLive.fetchWithDiagnostics('fb_user');
  assert.equal(notLiveDiag.status, 'OK');
  assert.equal(notLiveDiag.events.length, 0);
  assert.deepEqual(await fbNotLive.fetch('fb_user'), []);

  // HTTP 401/429 mapping + fetch() throws CollectorDiagnosticError
  const xErr = new XLiveCollector({
    checker: async (username) => ({
      status: 'ERROR',
      platform: 'X',
      username,
      sourceUrl: `https://x.com/${username}`,
      message: 'X returned HTTP 429 rate limited',
      checkedAt: '2026-11-21T09:00:00.000Z',
    }),
  });
  const errDiag = await xErr.fetchWithDiagnostics('x_user');
  assert.equal(errDiag.status, 'RATE_LIMITED');
  assert.equal(errDiag.httpStatus, 429);
  await assert.rejects(() => xErr.fetch('x_user'), (err: unknown) => {
    return err instanceof CollectorDiagnosticError && err.status === 'RATE_LIMITED';
  });

  // Cookie isolation: setCookie('') passes '' even when env var is populated
  const prevIgEnv = process.env.INSTAGRAM_COOKIE;
  process.env.INSTAGRAM_COOKIE = 'sessionid=env_should_not_leak';
  try {
    let seenCookie: string | undefined = 'unset';
    const isolated = createPlatformLiveCollector('INSTAGRAM', {
      cookie: 'sessionid=init',
      checker: async (_username, cookie) => {
        seenCookie = cookie;
        return {
          status: 'NOT_LIVE',
          platform: 'INSTAGRAM',
          username: 'u',
          sourceUrl: 'https://www.instagram.com/u/live/',
          checkedAt: new Date().toISOString(),
        };
      },
    });
    isolated.setCookie('');
    await isolated.fetch('u');
    assert.equal(seenCookie, '');
  } finally {
    if (prevIgEnv === undefined) delete process.env.INSTAGRAM_COOKIE;
    else process.env.INSTAGRAM_COOKIE = prevIgEnv;
  }
});

test('TikTokPostCollector: mobile UA fallback on JS challenge shell & HTTP 403', async () => {
  const origFetch = globalThis.fetch;
  try {
    // 1. Desktop returns 1.4KB challenge shell, Mobile returns __UNIVERSAL_DATA_FOR_REHYDRATION__
    const seenUAs: string[] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const ua = headerValue(init, 'user-agent') || '';
      seenUAs.push(ua);
      if (ua.includes('Chrome/122')) {
        return new Response('<html><script>/* challenge */</script></html>', { status: 200 });
      }
      const payload = {
        __DEFAULT_SCOPE__: {
          'webapp.user-detail': {
            statusCode: 0,
            userInfo: { user: { id: '12345', privateAccount: false } },
            itemInfo: {
              itemList: [
                {
                  id: '777001',
                  desc: 'Mobile fallback post',
                  createTime: 1700000000,
                  video: { cover: 'https://cdn.tiktok.com/cover1.jpg' },
                },
              ],
            },
          },
        },
      };
      return new Response(
        `<html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify(payload)}</script></html>`,
        { status: 200 }
      );
    }) as typeof fetch;

    const collector = new TikTokPostCollector();
    const diag = await collector.fetchWithDiagnostics('niegym22tq');
    assert.equal(seenUAs.length, 2);
    assert.ok(seenUAs[0].includes('Chrome/122'));
    assert.ok(seenUAs[1].includes('iPhone'));
    assert.equal(diag.status, 'OK');
    assert.equal(diag.events.length, 1);
    assert.equal(diag.events[0].platform, 'TIKTOK');
    assert.equal(diag.events[0].itemId, '777001');

    // 2. Both Desktop and Mobile return empty challenge shell -> fetch() returns [], fetchWithDiagnostics() returns BLOCKED
    globalThis.fetch = (async () =>
      new Response('<html><body>Please verify captcha</body></html>', { status: 200 })) as typeof fetch;
    const blockedDiag = await collector.fetchWithDiagnostics('blocked_user');
    assert.equal(blockedDiag.status, 'BLOCKED');
    assert.equal(blockedDiag.httpStatus, 200);
    assert.deepEqual(await collector.fetch('blocked_user'), []);

    // 3. Both return HTTP 429 -> RATE_LIMITED + throws CollectorDiagnosticError
    globalThis.fetch = (async () => new Response('Rate limited', { status: 429 })) as typeof fetch;
    const rlDiag = await collector.fetchWithDiagnostics('rl_user');
    assert.equal(rlDiag.status, 'RATE_LIMITED');
    assert.equal(rlDiag.httpStatus, 429);
    await assert.rejects(() => collector.fetch('rl_user'), (err: unknown) => {
      return err instanceof CollectorDiagnosticError && err.status === 'RATE_LIMITED';
    });
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('TikTokStoryCollector: fetchWithDiagnostics reports OK and BLOCKED challenge shell', async () => {
  const origFetch = globalThis.fetch;
  try {
    const collector = new TikTokStoryCollector();
    globalThis.fetch = (async () =>
      new Response('<html><body>captcha verify</body></html>', { status: 200 })) as typeof fetch;
    const blocked = await collector.fetchWithDiagnostics('story_blocked');
    assert.equal(blocked.status, 'BLOCKED');
    assert.deepEqual(await collector.fetch('story_blocked'), []);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('InstagramPostCollector: cookie mode, anonymous crawler fallback, pinned skip, and diagnostics', async () => {
  clearInstagramUserIdCache();
  const origFetch = globalThis.fetch;
  try {
    // 1. Cookie mode with bare sessionid -> expands ds_user_id and parses carousel + reel
    let capturedCookie = '';
    let capturedAppId = '';
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      capturedCookie = headerValue(init, 'cookie') || '';
      capturedAppId = headerValue(init, 'x-ig-app-id') || '';
      return new Response(
        JSON.stringify({
          data: {
            user: {
              id: '50160641448',
              is_private: false,
              edge_owner_to_timeline_media: {
                edges: [
                  {
                    node: {
                      id: 'pin_1',
                      shortcode: 'PIN1',
                      pinned_for_users: [{ id: '50160641448' }],
                      is_video: false,
                      display_url: 'https://cdn.ig.com/pin.jpg',
                    },
                  },
                  {
                    node: {
                      id: 'carousel_2',
                      shortcode: 'CAR2',
                      taken_at_timestamp: 1700000100,
                      edge_media_to_caption: { edges: [{ node: { text: 'Carousel caption' } }] },
                      edge_sidecar_to_children: {
                        edges: [
                          { node: { is_video: true, video_url: 'https://cdn.ig.com/v1.mp4', display_url: 'https://cdn.ig.com/t1.jpg' } },
                          { node: { is_video: false, display_url: 'https://cdn.ig.com/p2.jpg' } },
                        ],
                      },
                    },
                  },
                ],
              },
            },
          },
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    const cookieCollector = new InstagramPostCollector({ cookie: '50160641448%3Aabcxyz' });
    const res1 = await cookieCollector.fetchWithDiagnostics('ig_star');
    assert.equal(capturedCookie, 'sessionid=50160641448%3Aabcxyz; ds_user_id=50160641448');
    assert.equal(capturedAppId, '936619743392459');
    assert.equal(res1.status, 'OK');
    assert.equal(res1.events.length, 1);
    assert.equal(res1.events[0].platform, 'INSTAGRAM');
    assert.equal(res1.events[0].itemId, 'carousel_2');
    assert.equal(res1.events[0].metadata?.videoUrl, 'https://cdn.ig.com/v1.mp4');
    assert.deepEqual(res1.events[0].metadata?.photoUrls, ['https://cdn.ig.com/p2.jpg']);
    assert.equal(res1.events[0].metadata?.downloadHeaders?.Referer, 'https://www.instagram.com/');

    // 2. Anonymous mode: facebookexternalhit/1.1 HTML with Relay JSON; og:image never emitted
    const uas: string[] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const ua = headerValue(init, 'user-agent') || '';
      uas.push(ua);
      const relayJson = {
        xdt_api__v1__feed__user_timeline_graphql_connection: {
          edges: [
            {
              node: {
                pk: '991122',
                code: 'ANON1',
                product_type: 'clips',
                video_versions: [{ url: 'https://cdn.ig.com/reel.mp4', width: 1080, height: 1920 }],
                image_versions2: { candidates: [{ url: 'https://cdn.ig.com/reel_thumb.jpg', width: 1080, height: 1920 }] },
                caption: { text: 'Anon reel' },
              },
            },
          ],
        },
      };
      return new Response(
        `<html><head><meta property="og:image" content="https://cdn.ig.com/avatar_only.jpg"/></head><body><script type="application/json">${JSON.stringify(relayJson)}</script></body></html>`,
        { status: 200 }
      );
    }) as typeof fetch;

    const anonCollector = new InstagramPostCollector();
    const res2 = await anonCollector.fetchWithDiagnostics('anon_ig');
    assert.ok(uas[0].includes('facebookexternalhit/1.1'));
    assert.equal(res2.status, 'OK');
    assert.equal(res2.events.length, 1);
    assert.equal(res2.events[0].url, 'https://www.instagram.com/reel/ANON1/');
    assert.equal(res2.events[0].metadata?.videoUrl, 'https://cdn.ig.com/reel.mp4');

    // 3. Diagnostics: 401 -> AUTH_REQUIRED, 404 -> NOT_FOUND, is_private -> PRIVATE
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: 'login_required', require_login: true }), {
        status: 401,
      })) as typeof fetch;
    const authRes = await anonCollector.fetchWithDiagnostics('need_login');
    assert.equal(authRes.status, 'AUTH_REQUIRED');
    assert.deepEqual(await anonCollector.fetch('need_login'), []);

    globalThis.fetch = (async () => new Response('Not Found', { status: 404 })) as typeof fetch;
    assert.equal((await anonCollector.fetchWithDiagnostics('missing_ig')).status, 'NOT_FOUND');

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ data: { user: { id: '55', is_private: true, edge_owner_to_timeline_media: { edges: [] } } } }),
        { status: 200 }
      )) as typeof fetch;
    assert.equal((await cookieCollector.fetchWithDiagnostics('priv_ig')).status, 'PRIVATE');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('InstagramStoryCollector: userId cache, feed fallback, video/photo extraction & AUTH_REQUIRED', async () => {
  clearInstagramUserIdCache();
  const origFetch = globalThis.fetch;
  try {
    let profileLookups = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('web_profile_info')) {
        profileLookups++;
        return new Response(JSON.stringify({ data: { user: { id: '888111' } } }), { status: 200 });
      }
      if (url.includes('/feed/user/888111/story/')) {
        return new Response(
          JSON.stringify({
            status: 'ok',
            reel: {
              items: [
                {
                  pk: '333444_888111',
                  media_type: 2,
                  taken_at: 1700001000,
                  video_versions: [
                    { url: 'https://cdn.ig.com/low.mp4', width: 480, height: 854 },
                    { url: 'https://cdn.ig.com/hd.mp4', width: 1080, height: 1920 },
                  ],
                  image_versions2: {
                    candidates: [{ url: 'https://cdn.ig.com/story_cover.jpg', width: 1080, height: 1920 }],
                  },
                },
              ],
            },
          }),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    const storyCollector = new InstagramStoryCollector({ cookie: '888111%3Atoken' });
    const s1 = await storyCollector.fetchWithDiagnostics('story_star');
    const s2 = await storyCollector.fetchWithDiagnostics('story_star');
    assert.equal(profileLookups, 1, 'userId should be cached across calls');
    assert.equal(s1.status, 'OK');
    assert.equal(s1.events.length, 1);
    assert.equal(s1.events[0].platform, 'INSTAGRAM');
    assert.equal(s1.events[0].itemId, '333444');
    assert.equal(s1.events[0].metadata?.videoUrl, 'https://cdn.ig.com/hd.mp4');
    assert.equal(s2.events.length, 1);

    // Fallback to reels_media + empty items OK
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/feed/user/888111/story/')) {
        return new Response('Forbidden', { status: 403 });
      }
      if (url.includes('/feed/reels_media/')) {
        return new Response(
          JSON.stringify({
            status: 'ok',
            reels_media: [
              {
                items: [
                  {
                    pk: '555666',
                    media_type: 1,
                    image_versions2: {
                      candidates: [{ url: 'https://cdn.ig.com/story_photo.jpg', width: 1080, height: 1920 }],
                    },
                  },
                ],
              },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const s3 = await storyCollector.fetchWithDiagnostics('story_star');
    assert.equal(s3.status, 'OK');
    assert.deepEqual(s3.events[0].metadata?.photoUrls, ['https://cdn.ig.com/story_photo.jpg']);

    // Anonymous 401 -> AUTH_REQUIRED
    const anonStory = new InstagramStoryCollector();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ require_login: true }), { status: 401 })) as typeof fetch;
    const authFail = await anonStory.fetchWithDiagnostics('story_star');
    assert.equal(authFail.status, 'AUTH_REQUIRED');
    assert.equal(authFail.usedCookie, false);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('FacebookPostCollector & FacebookStoryCollector: Sec-Fetch headers, parsing, and diagnostics', async () => {
  const origFetch = globalThis.fetch;
  try {
    let capturedHeaders: Record<string, string> = {};
    let requestedUrl = '';

    const relayData = {
      node: {
        post_id: '777888999000',
        creation_time: 1700002000,
        comet_sections: {
          content: {
            story: {
              message: { text: 'Hello from Facebook' },
              attachments: [
                {
                  media: {
                    playable_url_quality_hd: 'https:\\/\\/video.fbcdn.net\\/hd.mp4?a=1\\u0026b=2',
                    playable_url: 'https://video.fbcdn.net/sd.mp4',
                    preferred_thumbnail: { image: { uri: 'https://scontent.fbcdn.net/thumb.jpg' } },
                  },
                },
              ],
            },
          },
        },
      },
    };

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(input);
      capturedHeaders = (init?.headers as Record<string, string>) || {};
      return new Response(
        `<html><head><meta property="og:image" content="https://fb.com/avatar.jpg"/></head><body><script type="application/json">${JSON.stringify(relayData)}</script></body></html>`,
        { status: 200 }
      );
    }) as typeof fetch;

    const fbPost = new FacebookPostCollector();
    const postRes = await fbPost.fetchWithDiagnostics('https://www.facebook.com/profile.php?id=100002950203435');
    assert.equal(requestedUrl, 'https://www.facebook.com/profile.php?id=100002950203435');
    assert.equal(capturedHeaders['Sec-Fetch-Dest'], 'document');
    assert.equal(capturedHeaders['Sec-Fetch-Mode'], 'navigate');
    assert.equal(capturedHeaders['Sec-Fetch-Site'], 'none');
    assert.equal(capturedHeaders['Sec-Fetch-User'], '?1');
    assert.equal(postRes.status, 'OK');
    assert.equal(postRes.events.length, 1);
    assert.equal(postRes.events[0].platform, 'FACEBOOK');
    assert.equal(
      postRes.events[0].url,
      'https://www.facebook.com/permalink.php?story_fbid=777888999000&id=100002950203435'
    );
    assert.equal(postRes.events[0].metadata?.videoUrl, 'https://video.fbcdn.net/hd.mp4?a=1&b=2');

    // Login wall -> AUTH_REQUIRED
    globalThis.fetch = (async () =>
      new Response('<html><form id="login_form">You must log in to continue</form></html>', {
        status: 200,
      })) as typeof fetch;
    const loginRes = await fbPost.fetchWithDiagnostics('private_fb');
    assert.equal(loginRes.status, 'AUTH_REQUIRED');

    // FacebookStoryCollector: unified_stories_buckets + checkpoint BLOCKED
    const storyData = {
      unified_stories_buckets: {
        edges: [
          {
            node: {
              id: 'bucket_123',
              unified_stories: {
                edges: [
                  {
                    node: {
                      id: 'card_456',
                      creation_time: 1700003000,
                      attachments: [
                        {
                          media: {
                            image: { uri: 'https://scontent.fbcdn.net/story1.jpg' },
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        ],
      },
    };
    globalThis.fetch = (async () =>
      new Response(
        `<html><script type="application/json">${JSON.stringify(storyData)}</script></html>`,
        { status: 200 }
      )) as typeof fetch;

    const fbStory = new FacebookStoryCollector({ cookie: 'c_user=10001; xs=secret' });
    const storyRes = await fbStory.fetchWithDiagnostics('100002950203435');
    assert.equal(storyRes.status, 'OK');
    assert.equal(storyRes.usedCookie, true);
    assert.equal(storyRes.events.length, 1);
    assert.equal(storyRes.events[0].platform, 'FACEBOOK');
    assert.equal(storyRes.events[0].url, 'https://www.facebook.com/stories/bucket_123/card_456/');
    assert.deepEqual(storyRes.events[0].metadata?.photoUrls, ['https://scontent.fbcdn.net/story1.jpg']);

    globalThis.fetch = (async () =>
      new Response('<html>Confirm your identity</html>', { status: 403 })) as typeof fetch;
    assert.equal((await fbStory.fetchWithDiagnostics('100002950203435')).status, 'BLOCKED');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('XPostCollector & XStoryCollector: cookie/guest auth, syndication fallback, pinned skip, UNSUPPORTED story', async () => {
  clearXGuestTokenCache();
  const origFetch = globalThis.fetch;
  try {
    // 1. Cookie mode verifies x-csrf-token & OAuth2Session, no x-guest-token, skips pinned, picks highest bitrate mp4
    const seenHeaders: Array<Record<string, string>> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seenHeaders.push((init?.headers as Record<string, string>) || {});
      if (url.includes('UserByScreenName')) {
        return new Response(
          JSON.stringify({
            data: {
              user: {
                result: {
                  rest_id: '44196397',
                  legacy: { pinned_tweet_ids_str: ['111'] },
                },
              },
            },
          }),
          { status: 200 }
        );
      }
      if (url.includes('UserTweets')) {
        return new Response(
          JSON.stringify({
            data: {
              user: {
                result: {
                  timeline_v2: {
                    timeline: {
                      instructions: [
                        {
                          type: 'TimelineAddEntries',
                          entries: [
                            {
                              entryId: 'tweet-111',
                              content: {
                                itemContent: {
                                  tweet_results: {
                                    result: {
                                      rest_id: '111',
                                      legacy: { full_text: 'Pinned tweet' },
                                    },
                                  },
                                },
                              },
                            },
                            {
                              entryId: 'tweet-222',
                              content: {
                                itemContent: {
                                  tweet_results: {
                                    result: {
                                      rest_id: '222',
                                      legacy: {
                                        full_text: 'Fresh video tweet',
                                        created_at: 'Tue Nov 21 09:00:00 +0000 2026',
                                        extended_entities: {
                                          media: [
                                            {
                                              type: 'video',
                                              media_url_https: 'https://pbs.twimg.com/thumb.jpg',
                                              video_info: {
                                                variants: [
                                                  { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/stream.m3u8' },
                                                  { content_type: 'video/mp4', bitrate: 832000, url: 'https://video.twimg.com/mid.mp4' },
                                                  { content_type: 'video/mp4', bitrate: 2176000, url: 'https://video.twimg.com/hd.mp4' },
                                                ],
                                              },
                                            },
                                          ],
                                        },
                                      },
                                    },
                                  },
                                },
                              },
                            },
                          ],
                        },
                      ],
                    },
                  },
                },
              },
            },
          }),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    const xCookieCollector = new XPostCollector({ cookie: 'auth_token=tok123; ct0=csrf456' });
    const xRes1 = await xCookieCollector.fetchWithDiagnostics('@elonmusk');
    assert.equal(seenHeaders[0]['x-csrf-token'], 'csrf456');
    assert.equal(seenHeaders[0]['x-twitter-auth-type'], 'OAuth2Session');
    assert.equal(seenHeaders[0]['x-guest-token'], undefined);
    assert.equal(xRes1.status, 'OK');
    assert.equal(xRes1.events.length, 1);
    assert.equal(xRes1.events[0].platform, 'X');
    assert.equal(xRes1.events[0].itemId, '222');
    assert.equal(xRes1.events[0].metadata?.videoUrl, 'https://video.twimg.com/hd.mp4');

    // 2. Guest mode: 401/403 retry refreshes guest token & falls back to syndication
    clearXGuestTokenCache();
    let guestActivations = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('guest/activate.json')) {
        guestActivations++;
        return new Response(JSON.stringify({ guest_token: `gt_${guestActivations}` }), { status: 200 });
      }
      if (url.includes('UserByScreenName')) {
        return new Response(
          JSON.stringify({ data: { user: { result: { rest_id: '999', legacy: {} } } } }),
          { status: 200 }
        );
      }
      if (url.includes('UserTweets')) {
        return new Response('Unauthorized', { status: 401 });
      }
      if (url.includes('cdn.syndication.twimg.com')) {
        const nextData = {
          props: {
            pageProps: {
              timeline: {
                entries: [
                  {
                    type: 'tweet',
                    content: {
                      tweet: {
                        id_str: '333',
                        full_text: 'Syndication tweet',
                        entities: { media: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/p.jpg' }] },
                      },
                    },
                  },
                ],
              },
            },
          },
        };
        return new Response(
          `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script></html>`,
          { status: 200 }
        );
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    const xAnonCollector = new XPostCollector();
    const xRes2 = await xAnonCollector.fetchWithDiagnostics('x_star');
    assert.equal(guestActivations, 2, 'Should activate once and refresh once on 401');
    assert.equal(xRes2.status, 'OK');
    assert.equal(xRes2.events[0].itemId, '333');
    assert.deepEqual(xRes2.events[0].metadata?.photoUrls, ['https://pbs.twimg.com/p.jpg']);

    // 3. Suspended / Protected / Age-restricted diagnostics
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('guest/activate.json')) {
        return new Response(JSON.stringify({ guest_token: 'gt_ok' }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          data: {
            user: {
              result: {
                __typename: 'UserUnavailable',
                reason: 'Suspended',
              },
            },
          },
        }),
        { status: 200 }
      );
    }) as typeof fetch;
    assert.equal((await xAnonCollector.fetchWithDiagnostics('suspended_user')).status, 'BLOCKED');

    // 4. XStoryCollector: UNSUPPORTED with zero network calls
    let networkCalled = false;
    globalThis.fetch = (async () => {
      networkCalled = true;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const xStory = new XStoryCollector({ cookie: 'auth_token=a; ct0=b' });
    assert.equal(xStory.supported, false);
    assert.deepEqual(await xStory.fetch('elonmusk'), []);
    const xStoryDiag = await xStory.fetchWithDiagnostics('elonmusk');
    assert.equal(xStoryDiag.status, 'UNSUPPORTED');
    assert.equal(xStoryDiag.events.length, 0);
    assert.equal(xStoryDiag.usedCookie, true);
    assert.ok(xStoryDiag.reason?.includes('không hỗ trợ Story'));
    assert.equal(networkCalled, false);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Regression: normalizeUsername reserved routes, @ URLs, and Facebook allowVideoId', () => {
  assert.equal(normalizeUsername('https://www.instagram.com/reel/C123/', 'INSTAGRAM'), '');
  assert.equal(normalizeUsername('https://www.instagram.com/accounts/login/', 'INSTAGRAM'), '');
  assert.equal(normalizeUsername('https://www.instagram.com/@some_user/', 'INSTAGRAM'), 'some_user');
  assert.equal(normalizeUsername('https://www.instagram.com/stories/highlights/1800123/', 'INSTAGRAM'), '');
  assert.equal(normalizeUsername('https://x.com/settings/account', 'X'), '');
  assert.equal(normalizeUsername('https://www.facebook.com/watch/?v=123', 'FACEBOOK'), '');
  assert.equal(normalizeUsername('https://www.facebook.com/groups/12345/', 'FACEBOOK'), '');
  assert.equal(normalizeUsername('https://www.tiktok.com/explore', 'TIKTOK'), '');
  assert.equal(
    normalizeUsername('https://www.facebook.com/watch/?v=123', 'FACEBOOK', { allowVideoId: true }),
    'video_123'
  );
});

test('Regression: FacebookPostCollector & FacebookStoryCollector make 0 HTTP calls for /watch/?v=123 while FacebookLiveCollector retains support', async () => {
  const origFetch = globalThis.fetch;
  try {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      return new Response('Should not be called', { status: 200 });
    }) as typeof fetch;

    const fbPost = new FacebookPostCollector();
    const fbStory = new FacebookStoryCollector();

    const postWatch = await fbPost.fetchWithDiagnostics('https://www.facebook.com/watch/?v=123');
    assert.equal(postWatch.status, 'NOT_FOUND');
    assert.deepEqual(postWatch.events, []);
    assert.deepEqual(await fbPost.fetch('video_123'), []);

    const storyWatch = await fbStory.fetchWithDiagnostics('https://www.facebook.com/watch/?v=123');
    assert.equal(storyWatch.status, 'NOT_FOUND');
    assert.deepEqual(storyWatch.events, []);
    assert.deepEqual(await fbStory.fetch('video_123'), []);

    assert.equal(fetchCount, 0);

    let liveSeenTarget = '';
    const fbLive = new FacebookLiveCollector({
      checker: async (username) => {
        liveSeenTarget = username;
        return {
          status: 'LIVE',
          platform: 'FACEBOOK',
          username,
          title: 'FB Live Video',
          streamUrl: 'https://video.fbcdn.net/live.m3u8',
          sourceUrl: 'https://www.facebook.com/watch/?v=123',
          checkedAt: '2026-11-21T09:00:00.000Z',
        };
      },
    });
    const liveRes = await fbLive.fetchWithDiagnostics('https://www.facebook.com/watch/?v=123');
    assert.equal(liveSeenTarget, 'video_123');
    assert.equal(liveRes.status, 'OK');
    assert.equal(liveRes.events.length, 1);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Regression: 3 pinned + 2 normal posts with topN=2 returns both normal posts across TikTok, Instagram, and Facebook', async () => {
  const origFetch = globalThis.fetch;
  try {
    // 1. TikTokPostCollector (topN: 2, [p1, p2, p3, n1, n2])
    globalThis.fetch = (async () => {
      const payload = {
        __DEFAULT_SCOPE__: {
          'webapp.user-detail': {
            statusCode: 0,
            userInfo: { user: { id: '12345', privateAccount: false } },
            itemInfo: {
              itemList: [
                { id: 'p1', isPinned: true, desc: 'Pin 1' },
                { id: 'p2', isPinned: true, desc: 'Pin 2' },
                { id: 'p3', isPinned: true, desc: 'Pin 3' },
                { id: 'n1', isPinned: false, desc: 'Normal 1' },
                { id: 'n2', isPinned: false, desc: 'Normal 2' },
              ],
            },
          },
        },
      };
      return new Response(
        `<html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify(payload)}</script></html>`,
        { status: 200 }
      );
    }) as typeof fetch;

    const tt = new TikTokPostCollector({ topN: 2 });
    const ttRes = await tt.fetchWithDiagnostics('tt_pinned_user');
    assert.equal(ttRes.status, 'OK');
    assert.deepEqual(
      ttRes.events.map((e) => e.itemId),
      ['n1', 'n2']
    );

    // 2. InstagramPostCollector (cookie web_profile_info, topN: 2, [p1, p2, p3, n1, n2])
    clearInstagramUserIdCache();
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: {
            user: {
              id: '777',
              is_private: false,
              edge_owner_to_timeline_media: {
                edges: [
                  { node: { id: 'p1', shortcode: 'P1', pinned_for_users: [{ id: '777' }], display_url: 'https://cdn.ig/p1.jpg' } },
                  { node: { id: 'p2', shortcode: 'P2', pinned_for_users: [{ id: '777' }], display_url: 'https://cdn.ig/p2.jpg' } },
                  { node: { id: 'p3', shortcode: 'P3', pinned_for_users: [{ id: '777' }], display_url: 'https://cdn.ig/p3.jpg' } },
                  { node: { id: 'n1', shortcode: 'N1', display_url: 'https://cdn.ig/n1.jpg' } },
                  { node: { id: 'n2', shortcode: 'N2', display_url: 'https://cdn.ig/n2.jpg' } },
                ],
              },
            },
          },
        }),
        { status: 200 }
      )) as typeof fetch;

    const ig = new InstagramPostCollector({ topN: 2, cookie: '777%3Atoken' });
    const igRes = await ig.fetchWithDiagnostics('ig_pinned_user');
    assert.equal(igRes.status, 'OK');
    assert.deepEqual(
      igRes.events.map((e) => e.itemId),
      ['n1', 'n2']
    );

    // 3. FacebookPostCollector (topN: 2, [p1, p2, p3, n1, n2])
    globalThis.fetch = (async () => {
      const relay = {
        items: [
          { node: { post_id: 'p1', is_pinned: true, comet_sections: { content: { story: { message: { text: 'Pin 1' } } } } } },
          { node: { post_id: 'p2', is_pinned: true, comet_sections: { content: { story: { message: { text: 'Pin 2' } } } } } },
          { node: { post_id: 'p3', is_pinned: true, comet_sections: { content: { story: { message: { text: 'Pin 3' } } } } } },
          { node: { post_id: 'n1', comet_sections: { content: { story: { message: { text: 'Norm 1' } } } } } },
          { node: { post_id: 'n2', comet_sections: { content: { story: { message: { text: 'Norm 2' } } } } } },
        ],
      };
      return new Response(
        `<html><script type="application/json">${JSON.stringify(relay)}</script></html>`,
        { status: 200 }
      );
    }) as typeof fetch;

    const fb = new FacebookPostCollector({ topN: 2 });
    const fbRes = await fb.fetchWithDiagnostics('fb_pinned_user');
    assert.equal(fbRes.status, 'OK');
    assert.deepEqual(
      fbRes.events.map((e) => e.itemId),
      ['n1', 'n2']
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Regression: InstagramPostCollector anonymous HTML enrichment skips pinned posts before topN slice', async () => {
  clearInstagramUserIdCache();
  const origFetch = globalThis.fetch;
  try {
    const enrichedShortcodes: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/embed/captioned/')) {
        const match = url.match(/\/p\/([^/]+)\/embed/);
        const sc = match?.[1] || '';
        enrichedShortcodes.push(sc);
        return new Response(
          `<html><img class="EmbeddedMediaImage" src="https://cdn.ig/${sc}.jpg" /></html>`,
          { status: 200 }
        );
      }

      const relayJson = {
        xdt_api__v1__feed__user_timeline_graphql_connection: {
          edges: [
            { node: { id: 'p1', shortcode: 'SC_P1', pinned_for_users: [{ id: '1' }] } },
            { node: { id: 'p2', shortcode: 'SC_P2', pinned_for_users: [{ id: '1' }] } },
            { node: { id: 'p3', shortcode: 'SC_P3', pinned_for_users: [{ id: '1' }] } },
            { node: { id: 'n1', shortcode: 'SC_N1' } },
            { node: { id: 'n2', shortcode: 'SC_N2' } },
          ],
        },
      };
      return new Response(
        `<html><script type="application/json">${JSON.stringify(relayJson)}</script></html>`,
        { status: 200 }
      );
    }) as typeof fetch;

    const ig = new InstagramPostCollector({ topN: 2, skipPinned: true });
    const res = await ig.fetchWithDiagnostics('ig_enrich_test');
    assert.equal(res.status, 'OK');
    assert.deepEqual(enrichedShortcodes, ['SC_N1', 'SC_N2']);
    assert.deepEqual(
      res.events.map((e) => e.itemId),
      ['n1', 'n2']
    );
    assert.deepEqual(res.events[0].metadata?.photoUrls, ['https://cdn.ig/SC_N1.jpg']);
    assert.deepEqual(res.events[1].metadata?.photoUrls, ['https://cdn.ig/SC_N2.jpg']);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Regression: FacebookStoryCollector returns OK (0 stories) when vanity /stories/<handle> 404s and numeric /stories/<id> returns 200 empty', async () => {
  const origFetch = globalThis.fetch;
  try {
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url === 'https://www.facebook.com/stories/fb_vanity') {
        return new Response('Not Found', { status: 404 });
      }
      if (url === 'https://www.facebook.com/fb_vanity') {
        return new Response('<html><script>{"userID":"100011223344"}</script></html>', {
          status: 200,
        });
      }
      if (url === 'https://www.facebook.com/stories/100011223344') {
        return new Response('<html><body>No active stories</body></html>', { status: 200 });
      }
      return new Response('Unexpected URL', { status: 500 });
    }) as typeof fetch;

    const fbStory = new FacebookStoryCollector({ cookie: 'c_user=1; xs=tok' });
    const res = await fbStory.fetchWithDiagnostics('fb_vanity');
    assert.equal(res.status, 'OK');
    assert.deepEqual(res.events, []);
    assert.equal(res.httpStatus, 200);
    assert.deepEqual(requestedUrls, [
      'https://www.facebook.com/stories/fb_vanity',
      'https://www.facebook.com/fb_vanity',
      'https://www.facebook.com/stories/100011223344',
    ]);
  } finally {
    globalThis.fetch = origFetch;
  }
});
