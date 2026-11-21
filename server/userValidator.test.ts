import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  validateTargetUser,
  resolvePlatformProfileUrl,
  extractTargetUsername,
  resetUserValidatorCachesForTest,
} from './userValidator';
import {
  extractTargetUsername as extractFrontendUsername,
  resolvePlatformProfileUrl as resolveFrontendProfileUrl,
  getTargetProfileKey,
} from '../src/utils/scannerEngine';
import { createStateStore, normalizeTargetProfiles } from './stateStore';
import { startServer } from '../server';

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

type MockFetchHandler = (
  req: RecordedRequest,
  origFetch: typeof globalThis.fetch
) => Response | Promise<Response>;

function headersToRecord(initHeaders?: HeadersInit): Record<string, string> {
  const out: Record<string, string> = {};
  if (!initHeaders) return out;
  if (initHeaders instanceof Headers) {
    initHeaders.forEach((v, k) => {
      out[k.toLowerCase()] = v;
    });
    return out;
  }
  if (Array.isArray(initHeaders)) {
    for (const [k, v] of initHeaders) {
      out[k.toLowerCase()] = v;
    }
    return out;
  }
  for (const [k, v] of Object.entries(initHeaders)) {
    if (typeof v === 'string') {
      out[k.toLowerCase()] = v;
    }
  }
  return out;
}

async function withMockFetch<T>(
  handler: MockFetchHandler,
  fn: (requests: RecordedRequest[], origFetch: typeof globalThis.fetch) => Promise<T>
): Promise<T> {
  resetUserValidatorCachesForTest();
  const origFetch = globalThis.fetch;
  const requests: RecordedRequest[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method || 'GET').toUpperCase();
    const headers = headersToRecord(init?.headers);
    const body = typeof init?.body === 'string' ? init.body : null;
    const rec: RecordedRequest = { url, method, headers, body };
    requests.push(rec);
    return handler(rec, origFetch);
  }) as typeof globalThis.fetch;

  try {
    return await fn(requests, origFetch);
  } finally {
    globalThis.fetch = origFetch;
    resetUserValidatorCachesForTest();
  }
}

function makeResponse(
  status: number,
  body: string,
  options: { url?: string; contentType?: string } = {}
): Response {
  const resp = new Response(body, {
    status,
    headers: { 'content-type': options.contentType || 'text/html; charset=utf-8' },
  });
  if (options.url) {
    Object.defineProperty(resp, 'url', { value: options.url, configurable: true });
  }
  return resp;
}

function createTempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulseradar-r1-test-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('F-R1-01: extractTargetUsername, resolvePlatformProfileUrl, and getTargetProfileKey across all platforms', () => {
  for (const extract of [extractTargetUsername, extractFrontendUsername]) {
    assert.equal(extract('@baotran162008'), 'baotran162008');
    assert.equal(extract('https://www.tiktok.com/@baotran162008?is_from_webapp=1'), 'baotran162008');
    assert.equal(extract('https://www.tiktok.com/explore'), '');

    assert.equal(extract('https://instagram.com/baotran16tui/'), 'baotran16tui');
    assert.equal(extract('https://instagr.am/user.one?igsh=abc'), 'user.one');
    assert.equal(extract('https://www.instagram.com/@panbaozhen16/'), 'panbaozhen16');
    assert.equal(extract('https://www.instagram.com/p/C12345/'), '');
    assert.equal(extract('https://www.instagram.com/reels/abc/'), '');
    assert.equal(extract('https://www.instagram.com/explore/'), '');

    assert.equal(extract('https://facebook.com/luvtint'), 'luvtint');
    assert.equal(extract('https://fb.com/@my.page/videos/123'), 'my.page');
    assert.equal(extract('https://www.facebook.com/profile.php?id=100064789123456'), '100064789123456');
    assert.equal(extract('https://fb.watch/xyz123/'), '');
    assert.equal(extract('https://www.facebook.com/groups/123456'), '');

    assert.equal(extract('https://x.com/Elinaaa2511'), 'Elinaaa2511');
    assert.equal(extract('https://twitter.com/@jack/status/999999'), 'jack');
    assert.equal(extract('https://x.com/explore'), '');
    assert.equal(extract('https://x.com/i/flow/login'), '');
    assert.equal(extract('https://example.com/random'), '');
  }

  for (const resolveUrl of [resolvePlatformProfileUrl, resolveFrontendProfileUrl]) {
    assert.equal(resolveUrl('@baotran162008', 'TIKTOK'), 'https://www.tiktok.com/@baotran162008');
    assert.equal(resolveUrl('baotran16tui', 'INSTAGRAM'), 'https://www.instagram.com/baotran16tui/');
    assert.equal(resolveUrl('luvtint', 'FACEBOOK'), 'https://www.facebook.com/luvtint');
    assert.equal(
      resolveUrl('100064789123456', 'FACEBOOK'),
      'https://www.facebook.com/profile.php?id=100064789123456'
    );
    assert.equal(resolveUrl('Elinaaa2511', 'X'), 'https://x.com/Elinaaa2511');
  }

  assert.equal(
    getTargetProfileKey('hackernews', 'https://www.instagram.com/@PanBaoZhen16/'),
    'INSTAGRAM::panbaozhen16'
  );
  assert.equal(
    getTargetProfileKey('facebook', 'https://www.facebook.com/profile.php?id=100064789123456'),
    'FACEBOOK::100064789123456'
  );
  assert.equal(getTargetProfileKey('bluesky', '@Elinaaa2511'), 'X::elinaaa2511');
  assert.equal(getTargetProfileKey('reddit', '@baotran162008'), 'TIKTOK::baotran162008');
  assert.equal(getTargetProfileKey('instagram', 'https://instagram.com/p/abc'), '');
});

test('F-R1-02: rejects malformed handles and reserved routes with INVALID_FORMAT without network calls', async () => {
  await withMockFetch(
    async () => {
      throw new Error('Should not make network calls on INVALID_FORMAT');
    },
    async requests => {
      const r1 = await validateTargetUser('a', 'TIKTOK');
      assert.equal(r1.valid, false);
      assert.equal(r1.status, 'INVALID_FORMAT');
      assert.match(r1.error || '', /không đúng định dạng/);

      const r2 = await validateTargetUser('invalid user with spaces', 'TIKTOK');
      assert.equal(r2.valid, false);
      assert.equal(r2.status, 'INVALID_FORMAT');

      const r3 = await validateTargetUser('this_handle_is_way_too_long_for_x_twitter', 'X');
      assert.equal(r3.valid, false);
      assert.equal(r3.status, 'INVALID_FORMAT');
      assert.match(r3.error || '', /tối đa 15 ký tự/);

      const r4 = await validateTargetUser('https://www.instagram.com/p/C12345/', 'INSTAGRAM');
      assert.equal(r4.valid, false);
      assert.equal(r4.status, 'INVALID_FORMAT');

      const r5 = await validateTargetUser('https://fb.watch/abc123/', 'FACEBOOK');
      assert.equal(r5.valid, false);
      assert.equal(r5.status, 'INVALID_FORMAT');

      assert.equal(requests.length, 0);
    }
  );
});

test('F-R1-02: TikTok validation (valid rehydration, cookie mode, 404, challenge BLOCKED, login AUTH_REQUIRED, network ERROR)', async () => {
  // 1. Valid with __UNIVERSAL_DATA_FOR_REHYDRATION__ + cookie mode
  await withMockFetch(
    async req => {
      assert.equal(req.headers.cookie, 'sessionid=tt_sess_123');
      const payload = {
        __DEFAULT_SCOPE__: {
          'webapp.user-detail': {
            statusCode: 0,
            userInfo: {
              user: {
                id: '7123456789012345678',
                nickname: 'Baotran16tui',
                avatarThumb: 'https://p16-sign-sg.tiktokcdn.com/avatar.jpeg',
              },
            },
          },
        },
      };
      return makeResponse(
        200,
        `<html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify(payload)}</script></html>`
      );
    },
    async () => {
      const res = await validateTargetUser('@baotran162008', 'TIKTOK', 'tt_sess_123');
      assert.equal(res.valid, true);
      assert.equal(res.status, 'VALID');
      assert.equal(res.authMode, 'cookie');
      assert.equal(res.id, '7123456789012345678');
      assert.equal(res.nickname, 'Baotran16tui');
      assert.equal(res.avatarUrl, 'https://p16-sign-sg.tiktokcdn.com/avatar.jpeg');
    }
  );

  // 2. 404 NOT_FOUND & statusCode 10202 NOT_FOUND
  await withMockFetch(
    async () => makeResponse(404, 'Not Found'),
    async () => {
      const res = await validateTargetUser('@fake_user_99881', 'TIKTOK');
      assert.equal(res.valid, false);
      assert.equal(res.status, 'NOT_FOUND');
      assert.equal(res.authMode, 'anonymous');
      assert.equal(res.httpStatus, 404);
      assert.match(res.error || '', /không tồn tại/);
    }
  );

  // 3. HTTP 200 challenge/captcha shell MUST return BLOCKED (never optimistic valid: true)
  await withMockFetch(
    async () => makeResponse(200, '<html><title>Verify</title><script>captcha()</script></html>'),
    async () => {
      const res = await validateTargetUser('@baotran162008', 'TIKTOK');
      assert.equal(res.valid, false);
      assert.equal(res.status, 'BLOCKED');
      assert.equal(res.httpStatus, 200);
    }
  );

  // 4. HTTP 200 login shell -> AUTH_REQUIRED
  await withMockFetch(
    async () =>
      makeResponse(200, '<html><title>Log in to TikTok</title></html>', {
        url: 'https://www.tiktok.com/login',
      }),
    async () => {
      const res = await validateTargetUser('@baotran162008', 'TIKTOK');
      assert.equal(res.valid, false);
      assert.equal(res.status, 'AUTH_REQUIRED');
    }
  );

  // 5. Network failure -> ERROR
  await withMockFetch(
    async () => {
      throw new Error('ECONNRESET');
    },
    async () => {
      const res = await validateTargetUser('@baotran162008', 'TIKTOK');
      assert.equal(res.valid, false);
      assert.equal(res.status, 'ERROR');
      assert.match(res.error || '', /ECONNRESET/);
    }
  );
});

test('F-R1-02: Instagram validation (cookie web_profile_info, anonymous crawler fallback, NOT_FOUND, AUTH_REQUIRED, BLOCKED)', async () => {
  // 1. Cookie mode (bare sessionid normalized via formatInstagramCookie)
  await withMockFetch(
    async req => {
      assert.ok(req.url.includes('web_profile_info/?username=panbaozhen16'));
      assert.equal(req.headers.cookie, 'sessionid=50160641448%3Axyz; ds_user_id=50160641448');
      return makeResponse(
        200,
        JSON.stringify({
          data: {
            user: {
              id: '46182957549',
              full_name: 'Pan Bao Zhen',
              profile_pic_url_hd: 'https://scontent.cdninstagram.com/hd.jpg?a=1\\u0026b=2',
            },
          },
        }),
        { contentType: 'application/json' }
      );
    },
    async () => {
      const res = await validateTargetUser('@panbaozhen16', 'INSTAGRAM', '50160641448%3Axyz');
      assert.equal(res.valid, true);
      assert.equal(res.status, 'VALID');
      assert.equal(res.authMode, 'cookie');
      assert.equal(res.id, '46182957549');
      assert.equal(res.nickname, 'Pan Bao Zhen');
      assert.equal(res.avatarUrl, 'https://scontent.cdninstagram.com/hd.jpg?a=1&b=2');
    }
  );

  // 2. Anonymous fallback: web_profile_info 429 -> usernameinfo 403 -> facebookexternalhit HTML
  await withMockFetch(
    async req => {
      if (req.url.includes('web_profile_info')) {
        return makeResponse(429, '{}');
      }
      if (req.url.includes('usernameinfo')) {
        return makeResponse(403, '{}');
      }
      assert.ok(req.headers['user-agent']?.includes('facebookexternalhit'));
      assert.equal(req.headers.cookie, undefined);
      return makeResponse(
        200,
        `<html>
          <meta property="og:title" content="Bao Tran (@baotran16tui) • Instagram photos and videos" />
          <meta property="og:image" content="https://scontent.cdninstagram.com/og.jpg?oe=1&amp;oh=2" />
          <meta property="al:ios:url" content="instagram://user?username=baotran16tui" />
          <script>{"profilePage_46182957549":{}}</script>
        </html>`
      );
    },
    async () => {
      const res = await validateTargetUser('https://www.instagram.com/baotran16tui/', 'INSTAGRAM');
      assert.equal(res.valid, true);
      assert.equal(res.status, 'VALID');
      assert.equal(res.authMode, 'anonymous');
      assert.equal(res.id, '46182957549');
      assert.equal(res.nickname, 'Bao Tran');
      assert.equal(res.avatarUrl, 'https://scontent.cdninstagram.com/og.jpg?oe=1&oh=2');
    }
  );

  // 3. NOT_FOUND
  await withMockFetch(
    async () => makeResponse(404, '{"message":"User not found"}'),
    async () => {
      const res = await validateTargetUser('missing_ig_user', 'INSTAGRAM');
      assert.equal(res.valid, false);
      assert.equal(res.status, 'NOT_FOUND');
    }
  );

  // 4. AUTH_REQUIRED
  await withMockFetch(
    async req => {
      if (req.url.includes('web_profile_info')) {
        return makeResponse(401, '{"require_login":true}');
      }
      if (req.url.includes('usernameinfo')) {
        return makeResponse(401, '{"message":"login_required"}');
      }
      return makeResponse(200, '<title>Login • Instagram</title>', {
        url: 'https://www.instagram.com/accounts/login/',
      });
    },
    async () => {
      const res = await validateTargetUser('private_or_walled', 'INSTAGRAM');
      assert.equal(res.valid, false);
      assert.equal(res.status, 'AUTH_REQUIRED');
    }
  );

  // 5. BLOCKED across all tiers
  await withMockFetch(
    async () => makeResponse(429, 'Rate limited'),
    async () => {
      const res = await validateTargetUser('blocked_ig', 'INSTAGRAM');
      assert.equal(res.valid, false);
      assert.equal(res.status, 'BLOCKED');
    }
  );
});

test('F-R1-02: Facebook validation (Desktop Sec-Fetch, numeric Twitterbot fallback, cookie mode, AUTH_REQUIRED, BLOCKED, NOT_FOUND)', async () => {
  // 1. Desktop HTML with Sec-Fetch-Dest: document
  await withMockFetch(
    async req => {
      assert.equal(req.headers['sec-fetch-dest'], 'document');
      assert.equal(req.headers.cookie, 'c_user=100; xs=secret');
      return makeResponse(
        200,
        `<html>
          <meta property="og:title" content="Luv Tint | Facebook" />
          <meta property="og:image" content="https://scontent.xx.fbcdn.net/avatar.jpg" />
          <script>{"userID":"100064789123456"}</script>
        </html>`
      );
    },
    async () => {
      const res = await validateTargetUser('luvtint', 'FACEBOOK', 'c_user=100; xs=secret');
      assert.equal(res.valid, true);
      assert.equal(res.status, 'VALID');
      assert.equal(res.authMode, 'cookie');
      assert.equal(res.id, '100064789123456');
      assert.equal(res.nickname, 'Luv Tint');
      assert.equal(res.avatarUrl, 'https://scontent.xx.fbcdn.net/avatar.jpg');
    }
  );

  // 2. Numeric profile.php?id=... desktop 400 -> Twitterbot fallback
  await withMockFetch(
    async req => {
      if (req.headers['user-agent']?.includes('Twitterbot')) {
        return makeResponse(
          200,
          `<html>
            <meta property="og:title" content="Nguyen Van A" />
            <meta property="og:image" content="https://scontent.xx.fbcdn.net/num.jpg" />
          </html>`
        );
      }
      return makeResponse(400, '<title>Error</title>');
    },
    async () => {
      const res = await validateTargetUser(
        'https://www.facebook.com/profile.php?id=100002950203435',
        'FACEBOOK'
      );
      assert.equal(res.valid, true);
      assert.equal(res.status, 'VALID');
      assert.equal(res.authMode, 'anonymous');
      assert.equal(res.id, '100002950203435');
      assert.equal(res.nickname, 'Nguyen Van A');
      assert.equal(res.profileUrl, 'https://www.facebook.com/profile.php?id=100002950203435');
    }
  );

  // 3. Login wall -> AUTH_REQUIRED
  await withMockFetch(
    async () =>
      makeResponse(200, '<html><form id="login_form"></form></html>', {
        url: 'https://www.facebook.com/login/?next=...',
      }),
    async () => {
      const res = await validateTargetUser('walled_fb_page', 'FACEBOOK');
      assert.equal(res.valid, false);
      assert.equal(res.status, 'AUTH_REQUIRED');
    }
  );

  // 4. Blocked across all tiers
  await withMockFetch(
    async () => makeResponse(403, 'Blocked'),
    async () => {
      const res = await validateTargetUser('blocked_fb', 'FACEBOOK');
      assert.equal(res.valid, false);
      assert.equal(res.status, 'BLOCKED');
    }
  );

  // 5. Missing phrase -> NOT_FOUND
  await withMockFetch(
    async () => makeResponse(200, "<html>This content isn't available right now</html>"),
    async () => {
      const res = await validateTargetUser('missing_fb', 'FACEBOOK');
      assert.equal(res.valid, false);
      assert.equal(res.status, 'NOT_FOUND');
    }
  );
});

test('F-R1-02: X validation (anonymous guest+GraphQL, cookie x-csrf-token, UserUnavailable precedence, syndication fallback, BLOCKED)', async () => {
  // 1. Anonymous guest/activate + GraphQL UserByScreenName
  await withMockFetch(
    async req => {
      if (req.url.includes('guest/activate.json')) {
        assert.equal(req.method, 'POST');
        return makeResponse(200, JSON.stringify({ guest_token: 'gt_12345' }), {
          contentType: 'application/json',
        });
      }
      assert.equal(req.headers['x-guest-token'], 'gt_12345');
      return makeResponse(
        200,
        JSON.stringify({
          data: {
            user: {
              result: {
                __typename: 'User',
                rest_id: '1555123456',
                legacy: {
                  name: 'Elinaaa',
                  profile_image_url_https: 'https://pbs.twimg.com/profile_images/1/abc_normal.jpg',
                },
              },
            },
          },
        }),
        { contentType: 'application/json' }
      );
    },
    async () => {
      const res = await validateTargetUser('@Elinaaa2511', 'X');
      assert.equal(res.valid, true);
      assert.equal(res.status, 'VALID');
      assert.equal(res.authMode, 'anonymous');
      assert.equal(res.id, '1555123456');
      assert.equal(res.nickname, 'Elinaaa');
      assert.equal(res.avatarUrl, 'https://pbs.twimg.com/profile_images/1/abc_400x400.jpg');
    }
  );

  // 2. Cookie mode sends Cookie + x-csrf-token (ct0) without guest token
  await withMockFetch(
    async req => {
      assert.equal(req.headers.cookie, 'auth_token=tok_a; ct0=csrf_123');
      assert.equal(req.headers['x-csrf-token'], 'csrf_123');
      assert.equal(req.headers['x-guest-token'], undefined);
      return makeResponse(
        200,
        JSON.stringify({
          data: {
            user: {
              result: {
                __typename: 'User',
                rest_id: '999',
                legacy: { name: 'CookieUser', profile_image_url_https: '' },
              },
            },
          },
        })
      );
    },
    async () => {
      const res = await validateTargetUser('CookieUser', 'X', 'auth_token=tok_a; ct0=csrf_123');
      assert.equal(res.valid, true);
      assert.equal(res.authMode, 'cookie');
    }
  );

  // 3. UserUnavailable: age-restricted BEFORE Suspended -> AUTH_REQUIRED
  await withMockFetch(
    async req => {
      if (req.url.includes('guest/activate.json')) {
        return makeResponse(200, JSON.stringify({ guest_token: 'gt_age' }));
      }
      return makeResponse(
        200,
        JSON.stringify({
          data: {
            user: {
              result: {
                __typename: 'UserUnavailable',
                reason: 'Suspended',
                message: 'User is age-restricted. You must be logged in to view this profile.',
              },
            },
          },
        })
      );
    },
    async () => {
      const res = await validateTargetUser('age_user', 'X');
      assert.equal(res.valid, false);
      assert.equal(res.status, 'AUTH_REQUIRED');
    }
  );

  // 4. UserUnavailable: Suspended alone -> BLOCKED; NotFound -> NOT_FOUND
  await withMockFetch(
    async req => {
      if (req.url.includes('guest/activate.json')) {
        return makeResponse(200, JSON.stringify({ guest_token: 'gt_susp' }));
      }
      return makeResponse(
        200,
        JSON.stringify({
          data: {
            user: {
              result: {
                __typename: 'UserUnavailable',
                reason: 'Suspended',
                message: 'Account suspended',
              },
            },
          },
        })
      );
    },
    async () => {
      const res = await validateTargetUser('susp_user', 'X');
      assert.equal(res.valid, false);
      assert.equal(res.status, 'BLOCKED');
    }
  );

  await withMockFetch(
    async req => {
      if (req.url.includes('guest/activate.json')) {
        return makeResponse(200, JSON.stringify({ guest_token: 'gt_404' }));
      }
      return makeResponse(
        200,
        JSON.stringify({
          data: {
            user: {
              result: {
                __typename: 'UserUnavailable',
                reason: 'NotFound',
              },
            },
          },
        })
      );
    },
    async () => {
      const res = await validateTargetUser('no_such_x', 'X');
      assert.equal(res.valid, false);
      assert.equal(res.status, 'NOT_FOUND');
    }
  );

  // 5. GraphQL 403 -> syndication fallback VALID
  await withMockFetch(
    async req => {
      if (req.url.includes('guest/activate.json')) {
        return makeResponse(200, JSON.stringify({ guest_token: 'gt_syn' }));
      }
      if (req.url.includes('graphql')) {
        return makeResponse(403, '{}');
      }
      if (req.url.includes('syndication.twimg.com')) {
        return makeResponse(200, JSON.stringify([{ id: '777', name: 'Synd User' }]));
      }
      return makeResponse(403, '');
    },
    async () => {
      const res = await validateTargetUser('synd_user', 'X');
      assert.equal(res.valid, true);
      assert.equal(res.status, 'VALID');
      assert.equal(res.id, '777');
      assert.equal(res.nickname, 'Synd User');
    }
  );

  // 6. GraphQL 403 + empty syndication + HTML 403 -> BLOCKED
  await withMockFetch(
    async req => {
      if (req.url.includes('guest/activate.json')) {
        return makeResponse(200, JSON.stringify({ guest_token: 'gt_blk' }));
      }
      if (req.url.includes('syndication.twimg.com')) {
        return makeResponse(200, '[]');
      }
      return makeResponse(403, '');
    },
    async () => {
      const res = await validateTargetUser('blk_user', 'X');
      assert.equal(res.valid, false);
      assert.equal(res.status, 'BLOCKED');
    }
  );
});

test('F-R1-04: normalizeTargetProfiles and createStateStore persistence & partial-write preservation', async t => {
  const dir = createTempDir(t);
  const store = createStateStore(dir);

  // Legacy workspace file without targetProfiles
  await fs.promises.writeFile(
    store.workspaceFile,
    JSON.stringify({ rules: [], servers: [], alerts: [] }),
    'utf-8'
  );
  const legacy = await store.readWorkspaceState();
  assert.deepEqual(legacy.targetProfiles, {});

  // Normalization: canonicalizes keys, keeps newer timestamp on collision, strips unsafe avatarUrl
  const normalized = normalizeTargetProfiles({
    'instagram::@PanBaoZhen16': {
      nickname: 'Old',
      avatarUrl: 'javascript:alert(1)',
      profileUrl: 'https://www.instagram.com/panbaozhen16/',
      updatedAt: '2026-11-20T00:00:00.000Z',
    },
    'INSTAGRAM::panbaozhen16': {
      id: '46182957549',
      nickname: 'Pan Bao Zhen',
      avatarUrl: 'https://cdn.example.com/avatar.jpg',
      profileUrl: 'https://www.instagram.com/panbaozhen16/',
      status: 'VALID',
      authMode: 'cookie',
      updatedAt: '2026-11-21T00:00:00.000Z',
    },
  });
  assert.deepEqual(Object.keys(normalized), ['INSTAGRAM::panbaozhen16']);
  assert.equal(normalized['INSTAGRAM::panbaozhen16']?.nickname, 'Pan Bao Zhen');
  assert.equal(normalized['INSTAGRAM::panbaozhen16']?.avatarUrl, 'https://cdn.example.com/avatar.jpg');

  // Unsafe avatarUrl stripped
  const stripped = normalizeTargetProfiles({
    'TIKTOK::@demo': {
      avatarUrl: 'data:text/html,xss',
      profileUrl: 'bad-url',
      updatedAt: 'not-a-date',
    },
  });
  assert.equal(stripped['TIKTOK::demo']?.avatarUrl, undefined);
  assert.equal(stripped['TIKTOK::demo']?.profileUrl, 'https://www.tiktok.com/@demo');

  // Write and partial-write preservation
  await store.writeWorkspaceState({ targetProfiles: normalized });
  const afterPartial = await store.writeWorkspaceState({ rules: [] });
  assert.equal(afterPartial.targetProfiles?.['INSTAGRAM::panbaozhen16']?.id, '46182957549');
});

test('F-R1-03 & F-R1-04 integration: POST /api/user/validate cookie precedence, anonymous override, and GET/PUT /api/workspace-state', async t => {
  const dir = createTempDir(t);
  const envKeys = ['TIKTOK_COOKIE', 'INSTAGRAM_COOKIE', 'FACEBOOK_COOKIE', 'X_COOKIE'] as const;
  const savedEnv: Partial<Record<(typeof envKeys)[number], string>> = {};
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
    envCookies: {
      tiktok: '',
      instagram: 'sessionid=env_opt_ig_cookie',
      facebook: '',
      x: '',
    },
  });
  t.after(() => server.close());

  await withMockFetch(
    async (req, origFetch) => {
      if (req.url.startsWith(server.url)) {
        return origFetch(req.url, {
          method: req.method,
          headers: req.headers,
          body: req.body ?? undefined,
        });
      }
      if (req.url.includes('web_profile_info')) {
        return makeResponse(
          200,
          JSON.stringify({
            data: {
              user: {
                id: '12345',
                full_name: `CookieEcho:${req.headers.cookie || 'NONE'}`,
                profile_pic_url_hd: 'https://cdn.example.com/ig.jpg',
              },
            },
          }),
          { contentType: 'application/json' }
        );
      }
      if (req.url.includes('usernameinfo')) {
        return makeResponse(403, '{}');
      }
      if (req.url.includes('instagram.com')) {
        return makeResponse(200, '<title>Login • Instagram</title>', {
          url: 'https://www.instagram.com/accounts/login/',
        });
      }
      return makeResponse(404, '');
    },
    async (requests, origFetch) => {
      // 1. Missing target -> 400
      const badResp = await origFetch(`${server.url}/api/user/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: '   ', platform: 'INSTAGRAM' }),
      });
      assert.equal(badResp.status, 400);

      // 2. PUT invalid targetProfiles -> 400
      for (const invalidVal of [[], 'bad', 123, null]) {
        const invalidPut = await origFetch(`${server.url}/api/workspace-state`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetProfiles: invalidVal }),
        });
        assert.equal(invalidPut.status, 400);
      }

      // 3. options.envCookies used when ws & body cookies empty (and whitespace body.cookie does not shadow!)
      // Also test URL with omitted platform -> auto-detected as INSTAGRAM
      const envOptResp = await origFetch(`${server.url}/api/user/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: 'https://www.instagram.com/panbaozhen16',
          cookie: '   ',
        }),
      });
      assert.equal(envOptResp.status, 200);
      const envOptJson = (await envOptResp.json()) as { ok: boolean; result: any };
      assert.equal(envOptJson.result.valid, true);
      assert.equal(envOptJson.result.authMode, 'cookie');
      assert.equal(envOptJson.result.nickname, 'CookieEcho:sessionid=env_opt_ig_cookie');

      // 4. PUT workspace-state with cookie & targetProfiles -> workspace cookie overrides envCookies
      const putResp = await origFetch(`${server.url}/api/workspace-state`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scannerSettings: {
            cookies: { tiktok: '', instagram: 'sessionid=ws_ig_cookie', facebook: '', x: '' },
            pollIntervalSeconds: 30,
            deduplicateLive: true,
          },
          targetProfiles: {
            'instagram::@PanBaoZhen16': {
              id: '46182957549',
              nickname: 'Pan Bao Zhen',
              avatarUrl: 'https://cdn.example.com/saved.jpg',
              profileUrl: 'https://www.instagram.com/panbaozhen16/',
              status: 'VALID',
              authMode: 'cookie',
              updatedAt: '2026-11-21T01:00:00.000Z',
            },
          },
        }),
      });
      assert.equal(putResp.status, 200);
      const putJson = (await putResp.json()) as { ok: boolean; state: any };
      assert.ok(putJson.state.targetProfiles['INSTAGRAM::panbaozhen16']);

      // Legacy platform token 'hackernews' resolves instagram cookie slot
      const wsResp = await origFetch(`${server.url}/api/user/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'another_user', platform: 'hackernews' }),
      });
      const wsJson = (await wsResp.json()) as { result: any };
      assert.equal(wsJson.result.nickname, 'CookieEcho:sessionid=ws_ig_cookie');
      assert.equal(wsJson.result.authMode, 'cookie');

      // 5. Explicit body.cookie overrides workspace cookie
      const bodyResp = await origFetch(`${server.url}/api/user/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: 'another_user',
          platform: 'INSTAGRAM',
          cookie: 'sessionid=body_ig_cookie',
        }),
      });
      const bodyJson = (await bodyResp.json()) as { result: any };
      assert.equal(bodyJson.result.nickname, 'CookieEcho:sessionid=body_ig_cookie');
      assert.equal(bodyJson.result.authMode, 'cookie');

      // 6. anonymous: true overrides ALL cookies (body, ws, envCookies, process.env)
      process.env.INSTAGRAM_COOKIE = 'sessionid=proc_env_ig_cookie';
      const beforeCount = requests.length;
      const anonResp = await origFetch(`${server.url}/api/user/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: 'another_user',
          platform: 'INSTAGRAM',
          cookie: 'sessionid=body_ig_cookie',
          anonymous: true,
        }),
      });
      const anonJson = (await anonResp.json()) as { result: any };
      assert.equal(anonJson.result.authMode, 'anonymous');
      assert.equal(anonJson.result.nickname, 'CookieEcho:NONE');
      const externalReqs = requests.slice(beforeCount).filter(r => !r.url.startsWith(server.url));
      assert.ok(externalReqs.length >= 1);
      for (const ext of externalReqs) {
        assert.equal(ext.headers.cookie, undefined);
      }

      // 7. Partial PUT omitting targetProfiles preserves existing targetProfiles, and POST /api/user/validate did NOT mutate it
      const partialPut = await origFetch(`${server.url}/api/workspace-state`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules: [] }),
      });
      assert.equal(partialPut.status, 200);

      const getResp = await origFetch(`${server.url}/api/workspace-state`);
      assert.equal(getResp.status, 200);
      const getJson = (await getResp.json()) as { state: any };
      assert.deepEqual(Object.keys(getJson.state.targetProfiles), ['INSTAGRAM::panbaozhen16']);
      assert.equal(getJson.state.targetProfiles['INSTAGRAM::panbaozhen16'].id, '46182957549');
    }
  );
});

test('R1-R2 regressions: facebook.com/people parsing & resolvePlatformProfileUrl schemeless reserved routes', () => {
  for (const extract of [extractTargetUsername, extractFrontendUsername]) {
    assert.equal(
      extract('https://www.facebook.com/people/Some-Name/100064789123456'),
      '100064789123456'
    );
    assert.equal(extract('facebook.com/people/Some-Name/100064789123456/'), '100064789123456');
    assert.equal(extract('https://www.facebook.com/people/Some-Name'), '');
    assert.equal(extract('facebook.com/people/Some-Name'), '');
  }

  for (const resolveUrl of [resolvePlatformProfileUrl, resolveFrontendProfileUrl]) {
    assert.notEqual(resolveUrl('fb.watch/xyz', 'FACEBOOK'), 'https://www.facebook.com/fb.watch');
    assert.equal(resolveUrl('fb.watch/xyz', 'FACEBOOK'), '');
    assert.equal(resolveUrl('instagram.com/reels/abc', 'INSTAGRAM'), '');
    assert.equal(resolveUrl('facebook.com/people/Some-Name', 'FACEBOOK'), '');
    assert.equal(
      resolveUrl('facebook.com/people/Some-Name/100064789123456', 'FACEBOOK'),
      'https://www.facebook.com/profile.php?id=100064789123456'
    );
  }
});

test('R1-R2 regressions: FB login wall with JSON name/userID=0, IG user_id=0, TikTok zero-id, escaped JSON quotes, and X guest token eviction + Tier 3 login redirect', async () => {
  // 1a. Facebook login wall with English (US) name and userID: "0" -> AUTH_REQUIRED
  await withMockFetch(
    async () =>
      makeResponse(
        200,
        `<html>
          <head><title>Log in to Facebook</title></head>
          <body>
            <form id="login_form" action="/login/"></form>
            <script>{"name":"English (US)","userID":"0"}</script>
          </body>
        </html>`,
        { url: 'https://m.facebook.com/login.php?next=https%3A%2F%2Fm.facebook.com%2Fluvmylife' }
      ),
    async () => {
      const res = await validateTargetUser('luvmylife', 'FACEBOOK');
      assert.equal(res.valid, false);
      assert.equal(res.status, 'AUTH_REQUIRED');
    }
  );

  // 1b. Facebook Vietnamese login wall with LoginController JSON name -> AUTH_REQUIRED
  await withMockFetch(
    async () =>
      makeResponse(
        200,
        `<html>
          <head><title>Đăng nhập Facebook | Facebook</title></head>
          <body>
            <form action="/login/"></form>
            <script>{"name":"LoginController","userID":"0"}</script>
          </body>
        </html>`,
        { url: 'https://m.facebook.com/login/?next=...' }
      ),
    async () => {
      const res = await validateTargetUser('vi_walled_page', 'FACEBOOK');
      assert.equal(res.valid, false);
      assert.equal(res.status, 'AUTH_REQUIRED');
    }
  );

  // 1c. Facebook generic shell with unrelated JSON "name" and "userID":"0" -> BLOCKED (never VALID)
  await withMockFetch(
    async () =>
      makeResponse(
        200,
        `<html><head><title>Error</title></head><script>{"name":"fb_dtsg","userID":"0"}</script></html>`
      ),
    async () => {
      const res = await validateTargetUser('generic_shell_fb', 'FACEBOOK');
      assert.equal(res.valid, false);
      assert.equal(res.status, 'BLOCKED');
    }
  );

  // 2a. Instagram HTML fallback: 429 + 403 + crawler 200 <title>Instagram</title> with {"viewer":{"user_id":"0"}} -> BLOCKED
  await withMockFetch(
    async req => {
      if (req.url.includes('web_profile_info')) return makeResponse(429, '{}');
      if (req.url.includes('usernameinfo')) return makeResponse(403, '{}');
      return makeResponse(
        200,
        `<html><head><title>Instagram</title></head><body><script>{"viewer":{"user_id":"0"}}</script></body></html>`
      );
    },
    async () => {
      const res = await validateTargetUser('ig_zero_id_user', 'INSTAGRAM');
      assert.equal(res.valid, false);
      assert.equal(res.status, 'BLOCKED');
    }
  );

  // 2b. TikTok zero-id challenge shell -> BLOCKED
  await withMockFetch(
    async () =>
      makeResponse(200, '<html><title>Verify</title><script>{"id":"0000000000000000"}</script></html>'),
    async () => {
      const res = await validateTargetUser('@tt_zero_id', 'TIKTOK');
      assert.equal(res.valid, false);
      assert.equal(res.status, 'BLOCKED');
    }
  );

  // 3. Escaped quotes & HTML entities in IG HTML JSON full_name
  await withMockFetch(
    async req => {
      if (req.url.includes('web_profile_info')) return makeResponse(429, '{}');
      if (req.url.includes('usernameinfo')) return makeResponse(403, '{}');
      return makeResponse(
        200,
        `<html>
          <script>{"profilePage_46182957549":{},"full_name":"Taylor \\"Swift\\" &amp; Co \\u0026 Sons"}</script>
        </html>`
      );
    },
    async () => {
      const res = await validateTargetUser('taylorswift', 'INSTAGRAM');
      assert.equal(res.valid, true);
      assert.equal(res.status, 'VALID');
      assert.equal(res.id, '46182957549');
      assert.equal(res.nickname, 'Taylor "Swift" & Co & Sons');
    }
  );

  // 3b. Escaped quotes & HTML entities in FB JSON name paired with non-zero userID (skipping preceding userID:"0")
  await withMockFetch(
    async () =>
      makeResponse(
        200,
        `<html><head><title>Facebook</title></head><script>{"userID":"0","page":{"userID":"100064789123456","name":"Rock \\"Live\\" &amp; Roll"}}</script></html>`
      ),
    async () => {
      const res = await validateTargetUser('rocklive', 'FACEBOOK');
      assert.equal(res.valid, true);
      assert.equal(res.status, 'VALID');
      assert.equal(res.id, '100064789123456');
      assert.equal(res.nickname, 'Rock "Live" & Roll');
    }
  );

  // 4a. X stale guest token cleared on 401/403 when guest/activate.json fails (next call doesn't resend stale_tok)
  let activateCalls = 0;
  await withMockFetch(
    async req => {
      if (req.url.includes('guest/activate.json')) {
        activateCalls += 1;
        if (activateCalls === 1) {
          return makeResponse(200, JSON.stringify({ guest_token: 'stale_tok' }));
        }
        return makeResponse(429, '{}');
      }
      if (req.url.includes('graphql')) {
        return makeResponse(401, '{}');
      }
      if (req.url.includes('syndication.twimg.com')) {
        return makeResponse(200, '[]');
      }
      return makeResponse(403, '');
    },
    async requests => {
      await validateTargetUser('jack', 'X');
      const countBeforeSecond = requests.length;
      await validateTargetUser('jack', 'X');
      const secondCallGql = requests
        .slice(countBeforeSecond)
        .filter(r => r.url.includes('graphql'));
      assert.ok(secondCallGql.length >= 1);
      for (const req of secondCallGql) {
        assert.notEqual(req.headers['x-guest-token'], 'stale_tok');
      }
    }
  );

  // 4b. X Tier 3 HTML fallback /i/flow/login redirect -> AUTH_REQUIRED
  await withMockFetch(
    async req => {
      if (req.url.includes('guest/activate.json')) {
        return makeResponse(200, JSON.stringify({ guest_token: 'gt_login' }));
      }
      if (req.url.includes('graphql')) {
        return makeResponse(403, '{}');
      }
      if (req.url.includes('syndication.twimg.com')) {
        return makeResponse(200, '[]');
      }
      return makeResponse(200, '<html><title>Sign in to X</title></html>', {
        url: 'https://x.com/i/flow/login?redirect_after_login=%2Fjack',
      });
    },
    async () => {
      const res = await validateTargetUser('jack', 'X');
      assert.equal(res.valid, false);
      assert.equal(res.status, 'AUTH_REQUIRED');
    }
  );
});
