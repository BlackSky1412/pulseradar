import { fetchWithTimeout, safeJsonParse } from './liveCheckers/httpClient';
import { formatInstagramCookie } from './liveCheckers/instagramChecker';

export type UserValidationStatus =
  | 'VALID'
  | 'INVALID_FORMAT'
  | 'NOT_FOUND'
  | 'AUTH_REQUIRED'
  | 'BLOCKED'
  | 'ERROR';

export interface UserValidationResult {
  valid: boolean;
  status?: UserValidationStatus;
  authMode?: 'anonymous' | 'cookie';
  httpStatus?: number;
  username: string;
  platform: string;
  error?: string;
  id?: string;
  nickname?: string;
  avatarUrl?: string;
  profileUrl: string;
}

const MOBILE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1';
const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const IG_MOBILE_USER_AGENT =
  'Instagram 312.0.0.34.111 Android (34/14; 480dpi; 1080x2400; samsung; SM-S918B; dm3q; qcom; en_US; 559996041)';
const FB_MOBILE_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
const CRAWLER_FACEBOOK_UA =
  'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
const CRAWLER_TWITTER_UA = 'Twitterbot/1.0';
const IG_APP_ID = '936619743392459';
const X_BEARER_TOKEN =
  'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

const TIKTOK_RESERVED_ROUTES = new Set([
  'explore',
  'following',
  'friends',
  'live',
  'messages',
  'upload',
  'search',
  'tag',
  'music',
  'foryou',
  'discover',
  'login',
  'signup',
]);

const IG_RESERVED_ROUTES = new Set([
  'live',
  'stories',
  'reels',
  'reel',
  'p',
  'tv',
  'explore',
  'accounts',
  'direct',
  'about',
  'legal',
  'developer',
  'directory',
]);

const FB_RESERVED_ROUTES = new Set([
  'watch',
  'share',
  'profile.php',
  'story.php',
  'photo.php',
  'permalink.php',
  'live',
  'groups',
  'events',
  'pages',
  'marketplace',
  'gaming',
  'reel',
  'reels',
  'videos',
  'login',
  'recover',
  'help',
  'settings',
  'privacy',
  'policies',
  'stories',
  'people',
]);

const X_RESERVED_ROUTES = new Set([
  'i',
  'explore',
  'home',
  'search',
  'notifications',
  'messages',
  'settings',
  'compose',
  'intent',
  'hashtag',
  'login',
  'signup',
  'tos',
  'privacy',
]);

let cachedXGuestToken: { token: string; fetchedAt: number } | null = null;
const X_GUEST_TOKEN_TTL_MS = 10 * 60 * 1000;

export function resetUserValidatorCachesForTest(): void {
  cachedXGuestToken = null;
}

export function resolvePlatformProfileUrl(rawTarget: string, platform = 'TIKTOK'): string {
  const clean = rawTarget.trim();
  if (!clean) return '';
  if (clean.startsWith('http://') || clean.startsWith('https://')) {
    return clean;
  }
  const cleanUsername = extractTargetUsername(clean);
  if (!cleanUsername) {
    return '';
  }
  const p = platform.toUpperCase();

  if (p === 'REDDIT' || p === 'TIKTOK') {
    return `https://www.tiktok.com/@${cleanUsername}`;
  }
  if (p === 'HACKERNEWS' || p === 'INSTAGRAM') {
    return `https://www.instagram.com/${cleanUsername}/`;
  }
  if (p === 'GITHUB' || p === 'FACEBOOK') {
    if (/^\d+$/.test(cleanUsername)) {
      return `https://www.facebook.com/profile.php?id=${cleanUsername}`;
    }
    return `https://www.facebook.com/${cleanUsername}`;
  }
  if (p === 'BLUESKY' || p === 'X' || p === 'TWITTER') {
    return `https://x.com/${cleanUsername}`;
  }
  return `https://www.tiktok.com/@${cleanUsername}`;
}

export function extractTargetUsername(input: string): string {
  const trimmed = typeof input === 'string' ? input.trim() : '';
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();

  if (lower.includes('tiktok.com')) {
    const atMatch = trimmed.match(/tiktok\.com\/@([a-zA-Z0-9_.]+)/i);
    if (atMatch?.[1]) return atMatch[1];
    const plainMatch = trimmed.match(/tiktok\.com\/([a-zA-Z0-9_.]+)/i);
    const candidate = plainMatch?.[1] || '';
    if (candidate && !TIKTOK_RESERVED_ROUTES.has(candidate.toLowerCase())) {
      return candidate;
    }
    return '';
  }

  if (lower.includes('instagram.com') || lower.includes('instagr.am')) {
    const noQuery = trimmed.split(/[?#]/)[0] || trimmed;
    const match = noQuery.match(/(?:instagram\.com|instagr\.am)\/@?([a-zA-Z0-9_.]+)/i);
    const candidate = match?.[1] || '';
    if (candidate && !IG_RESERVED_ROUTES.has(candidate.toLowerCase())) {
      return candidate;
    }
    return '';
  }

  if (lower.includes('facebook.com') || lower.includes('fb.com') || lower.includes('fb.watch')) {
    if (lower.includes('fb.watch')) {
      return '';
    }
    const idMatch = trimmed.match(/profile\.php\?(?:[^#]*&)?id=(\d+)/i);
    if (idMatch?.[1]) {
      return idMatch[1];
    }
    const peopleMatch = trimmed.match(/(?:facebook\.com|fb\.com)\/people\/[^/?#]+\/(\d+)/i);
    if (peopleMatch?.[1]) {
      return peopleMatch[1];
    }
    const match = trimmed.match(/(?:facebook\.com|fb\.com)\/@?([^/?#]+)/i);
    const candidate = (match?.[1] || '').replace(/^@+/, '').trim();
    if (candidate && !FB_RESERVED_ROUTES.has(candidate.toLowerCase())) {
      return candidate;
    }
    return '';
  }

  if (lower.includes('x.com') || lower.includes('twitter.com')) {
    const statusMatch = trimmed.match(/(?:x|twitter)\.com\/@?([a-zA-Z0-9_]+)\/status\//i);
    if (statusMatch?.[1] && !X_RESERVED_ROUTES.has(statusMatch[1].toLowerCase())) {
      return statusMatch[1];
    }
    const match = trimmed.match(/(?:x|twitter)\.com\/@?([a-zA-Z0-9_]+)/i);
    const candidate = match?.[1] || '';
    if (candidate && !X_RESERVED_ROUTES.has(candidate.toLowerCase())) {
      return candidate;
    }
    return '';
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return '';
  }

  return trimmed.replace(/^@+/, '').split(/[/?#]/)[0]?.trim() || '';
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&#x0*27;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .trim();
}

function unescapeJsonUrl(raw: string): string {
  return decodeHtmlEntities(
    raw
      .replace(/\\\//g, '/')
      .replace(/\\u0026/gi, '&')
      .replace(/\\u002f/gi, '/')
      .replace(/\\u003d/gi, '=')
  );
}

function decodeJsonStringLiteral(raw: string): string {
  try {
    const parsed = JSON.parse(`"${raw}"`) as string;
    return decodeHtmlEntities(parsed);
  } catch {
    const manual = raw.replace(/\\(["\\/bfnrt]|u[0-9a-fA-F]{4})/g, (_m, seq: string) => {
      if (seq === '"') return '"';
      if (seq === '\\') return '\\';
      if (seq === '/') return '/';
      if (seq === 'b') return '\b';
      if (seq === 'f') return '\f';
      if (seq === 'n') return '\n';
      if (seq === 'r') return '\r';
      if (seq === 't') return '\t';
      if (seq.startsWith('u')) return String.fromCharCode(parseInt(seq.slice(1), 16));
      return seq;
    });
    return decodeHtmlEntities(manual);
  }
}

function extractMetaTag(html: string, propertyOrName: string): string | undefined {
  const escaped = propertyOrName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern1 = new RegExp(
    `<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`,
    'i'
  );
  const m1 = html.match(pattern1);
  if (m1?.[1]) return decodeHtmlEntities(m1[1]);

  const pattern2 = new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`,
    'i'
  );
  const m2 = html.match(pattern2);
  if (m2?.[1]) return decodeHtmlEntities(m2[1]);

  return undefined;
}

function isGenericInstagramTitle(title: string): boolean {
  const t = title.trim().toLowerCase();
  return (
    !t ||
    t === 'instagram' ||
    t.startsWith('login') ||
    t.includes('create an account') ||
    t === 'page not found'
  );
}

function cleanInstagramOgTitle(rawTitle: string, username: string): string | undefined {
  const stripped = rawTitle
    .replace(/\s*\(@[^)]+\)\s*[•·].*$/i, '')
    .replace(/\s*[•·]\s*Instagram.*$/i, '')
    .trim();
  if (!stripped || isGenericInstagramTitle(stripped)) return undefined;
  if (stripped.toLowerCase() === username.toLowerCase()) return stripped;
  return stripped;
}

function isGenericInstagramAvatar(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    !lower.startsWith('http') ||
    lower.includes('rsrc.php') ||
    lower.includes('/rsrc/') ||
    lower.includes('instagram_logo')
  );
}

function isGenericFacebookTitle(title: string): boolean {
  const t = title.trim().toLowerCase();
  return (
    !t ||
    t === 'facebook' ||
    t === 'error' ||
    t.startsWith('log in') ||
    t.startsWith('log into') ||
    t.startsWith('đăng nhập') ||
    t.includes('security check')
  );
}

function cleanFacebookTitle(rawTitle: string): string | undefined {
  const stripped = decodeHtmlEntities(
    rawTitle
      .replace(/\s*\|\s*Facebook.*$/i, '')
      .replace(/\s*-\s*Facebook.*$/i, '')
      .trim()
  );
  if (!stripped || isGenericFacebookTitle(stripped)) return undefined;
  return stripped;
}

function isGenericFacebookAvatar(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    !lower.startsWith('http') ||
    lower.includes('rsrc.php') ||
    lower.includes('fb_icon')
  );
}

function attachXCookieHeaders(headers: Record<string, string>, cookie: string): void {
  if (!cookie) return;
  headers.Cookie = cookie;
  const ct0Match = cookie.match(/(?:^|;\s*)ct0=([a-zA-Z0-9_-]+)/);
  if (ct0Match?.[1]) {
    headers['x-csrf-token'] = ct0Match[1];
  }
}

async function getOrRefreshXGuestToken(forceRefresh = false): Promise<string | null> {
  if (forceRefresh) {
    cachedXGuestToken = null;
  }
  if (
    !forceRefresh &&
    cachedXGuestToken &&
    Date.now() - cachedXGuestToken.fetchedAt < X_GUEST_TOKEN_TTL_MS
  ) {
    return cachedXGuestToken.token;
  }

  try {
    const resp = await fetchWithTimeout('https://api.twitter.com/1.1/guest/activate.json', {
      method: 'POST',
      headers: {
        Authorization: X_BEARER_TOKEN,
        'User-Agent': DESKTOP_USER_AGENT,
        'Content-Type': 'application/json',
      },
      body: '',
      timeoutMs: 7000,
    });
    if (!resp.ok || !resp.text) return null;
    const json = safeJsonParse<{ guest_token?: string }>(resp.text);
    const token = typeof json?.guest_token === 'string' ? json.guest_token.trim() : '';
    if (!token) return null;
    cachedXGuestToken = { token, fetchedAt: Date.now() };
    return token;
  } catch {
    return null;
  }
}

function upgradeXAvatarUrl(rawUrl: string): string | undefined {
  const trimmed = rawUrl.trim();
  if (!trimmed || !/^https?:\/\//i.test(trimmed)) return undefined;
  return trimmed.replace(/_normal(\.[a-zA-Z0-9]+)(\?.*)?$/i, '_400x400$1$2');
}

async function validateTikTokUser(
  username: string,
  platform: string,
  profileUrl: string,
  cookie: string
): Promise<UserValidationResult> {
  const effectiveCookie = cookie.trim()
    ? cookie.includes('=')
      ? cookie.trim()
      : `sessionid=${cookie.trim()}`
    : '';
  const authMode: 'anonymous' | 'cookie' = effectiveCookie ? 'cookie' : 'anonymous';

  if (!/^[a-zA-Z0-9_.]+$/.test(username) || username.length < 2 || username.length > 24) {
    return {
      valid: false,
      status: 'INVALID_FORMAT',
      authMode,
      username,
      platform,
      profileUrl,
      error: `Tên người dùng TikTok "@${username}" không đúng định dạng (chỉ gồm chữ cái, số, dấu gạch dưới, dấu chấm và từ 2-24 ký tự).`,
    };
  }

  try {
    const url = `https://www.tiktok.com/@${encodeURIComponent(username)}`;
    const headers: Record<string, string> = {
      'User-Agent': MOBILE_USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
    };
    if (effectiveCookie) {
      headers.Cookie = effectiveCookie;
    }

    const resp = await fetchWithTimeout(url, { headers, timeoutMs: 9000 });
    if (resp.status === 404) {
      return {
        valid: false,
        status: 'NOT_FOUND',
        authMode,
        httpStatus: 404,
        username,
        platform,
        profileUrl,
        error: `Tài khoản TikTok "@${username}" không tồn tại (Lỗi 404 Not Found). Vui lòng kiểm tra lại chính tả!`,
      };
    }
    if (resp.status === 401) {
      return {
        valid: false,
        status: 'AUTH_REQUIRED',
        authMode,
        httpStatus: 401,
        username,
        platform,
        profileUrl,
        error: `TikTok yêu cầu đăng nhập để xem hồ sơ @${username} (HTTP 401). Vui lòng cấu hình TikTok Cookie trong Cài đặt Cookie.`,
      };
    }
    if (resp.status === 403 || resp.status === 429) {
      return {
        valid: false,
        status: 'BLOCKED',
        authMode,
        httpStatus: resp.status,
        username,
        platform,
        profileUrl,
        error: `TikTok đang giới hạn hoặc chặn truy cập (HTTP ${resp.status}) khi kiểm tra @${username}. Vui lòng thử lại hoặc cấu hình TikTok Cookie.`,
      };
    }

    const html = resp.text || '';
    const match = html.match(
      /<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/
    );

    if (match?.[1]) {
      const data = safeJsonParse<Record<string, unknown>>(match[1]);
      const defaultScope = data?.__DEFAULT_SCOPE__ as Record<string, unknown> | undefined;
      const userDetail = defaultScope?.['webapp.user-detail'] as Record<string, unknown> | undefined;
      const statusCode = userDetail?.statusCode;
      const userInfo = userDetail?.userInfo as Record<string, unknown> | undefined;
      const user = userInfo?.user as Record<string, unknown> | undefined;

      if (typeof statusCode === 'number' && statusCode !== 0) {
        return {
          valid: false,
          status: 'NOT_FOUND',
          authMode,
          httpStatus: resp.status,
          username,
          platform,
          profileUrl,
          error: `Tài khoản TikTok "@${username}" không tồn tại hoặc đã bị khóa (Mã lỗi ${statusCode}).`,
        };
      }

      if (user?.id) {
        return {
          valid: true,
          status: 'VALID',
          authMode,
          httpStatus: resp.status,
          username,
          platform,
          profileUrl,
          id: String(user.id),
          nickname: typeof user.nickname === 'string' && user.nickname.trim() ? user.nickname : username,
          avatarUrl:
            typeof user.avatarThumb === 'string' && user.avatarThumb
              ? user.avatarThumb
              : typeof user.avatarMedium === 'string' && user.avatarMedium
              ? user.avatarMedium
              : undefined,
        };
      }
    }

    const idMatch = html.match(/"id":"([1-9]\d{14,21})"/);
    if (idMatch?.[1]) {
      return {
        valid: true,
        status: 'VALID',
        authMode,
        httpStatus: resp.status,
        username,
        platform,
        profileUrl,
        id: idMatch[1],
      };
    }

    if (
      html.includes("Couldn't find this account") ||
      html.includes('Không thể tìm thấy tài khoản này')
    ) {
      return {
        valid: false,
        status: 'NOT_FOUND',
        authMode,
        httpStatus: resp.status,
        username,
        platform,
        profileUrl,
        error: `Tài khoản TikTok "@${username}" không tồn tại. Vui lòng kiểm tra lại chính tả!`,
      };
    }

    if (resp.url.includes('/login') || /log in to tiktok|đăng nhập vào tiktok/i.test(html)) {
      return {
        valid: false,
        status: 'AUTH_REQUIRED',
        authMode,
        httpStatus: resp.status,
        username,
        platform,
        profileUrl,
        error: `TikTok yêu cầu đăng nhập để xem hồ sơ @${username}. Vui lòng cấu hình TikTok Cookie trong Cài đặt Cookie.`,
      };
    }

    return {
      valid: false,
      status: 'BLOCKED',
      authMode,
      httpStatus: resp.status,
      username,
      platform,
      profileUrl,
      error: `TikTok trả về trang xác minh/chặn truy cập (HTTP ${resp.status}) khi kiểm tra @${username}. Vui lòng thử lại hoặc cấu hình TikTok Cookie.`,
    };
  } catch (err) {
    return {
      valid: false,
      status: 'ERROR',
      authMode,
      username,
      platform,
      profileUrl,
      error: `Không thể kết nối xác thực tài khoản @${username} với TikTok: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function validateInstagramUser(
  username: string,
  platform: string,
  profileUrl: string,
  cookie: string
): Promise<UserValidationResult> {
  const effectiveCookie = formatInstagramCookie(cookie);
  const authMode: 'anonymous' | 'cookie' = effectiveCookie ? 'cookie' : 'anonymous';

  if (!/^[a-zA-Z0-9_.]+$/.test(username) || username.length < 1 || username.length > 30) {
    return {
      valid: false,
      status: 'INVALID_FORMAT',
      authMode,
      username,
      platform,
      profileUrl,
      error: `Tên người dùng Instagram "@${username}" không đúng định dạng (chỉ gồm chữ cái, số, dấu gạch dưới, dấu chấm và tối đa 30 ký tự).`,
    };
  }

  let lastHttpStatus: number | undefined;
  let sawAuthRequired = false;
  let sawBlocked = false;
  let lastNetworkError: string | null = null;

  // Tier 1: Web Profile Info API
  try {
    const apiUrl = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
    const headers: Record<string, string> = {
      'User-Agent': DESKTOP_USER_AGENT,
      'X-IG-App-ID': IG_APP_ID,
      'X-ASBD-ID': '129477',
      'X-IG-WWW-Claim': '0',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/plain, */*',
      Referer: `https://www.instagram.com/${encodeURIComponent(username)}/`,
    };
    if (effectiveCookie) {
      headers.Cookie = effectiveCookie;
    }

    const resp = await fetchWithTimeout(apiUrl, { headers, timeoutMs: 9000 });
    lastHttpStatus = resp.status;

    if (resp.status === 404) {
      return {
        valid: false,
        status: 'NOT_FOUND',
        authMode,
        httpStatus: 404,
        username,
        platform,
        profileUrl,
        error: `Tài khoản Instagram "@${username}" không tồn tại (HTTP 404).`,
      };
    }

    const json = safeJsonParse<Record<string, unknown>>(resp.text || '');
    const dataObj = json?.data as Record<string, unknown> | undefined;
    const msg = typeof json?.message === 'string' ? json.message : '';

    if ((dataObj && dataObj.user === null) || /user not found|not found/i.test(msg)) {
      return {
        valid: false,
        status: 'NOT_FOUND',
        authMode,
        httpStatus: resp.status,
        username,
        platform,
        profileUrl,
        error: `Tài khoản Instagram "@${username}" không tồn tại.`,
      };
    }

    const user = dataObj?.user as Record<string, unknown> | undefined;
    if (resp.ok && user) {
      const id = String(user.id || user.pk || '').trim() || undefined;
      const fullName = typeof user.full_name === 'string' ? user.full_name.trim() : '';
      const rawAvatar =
        typeof user.profile_pic_url_hd === 'string' && user.profile_pic_url_hd
          ? user.profile_pic_url_hd
          : typeof user.profile_pic_url === 'string'
          ? user.profile_pic_url
          : '';
      const avatarUrl = rawAvatar ? unescapeJsonUrl(rawAvatar) : undefined;
      return {
        valid: true,
        status: 'VALID',
        authMode,
        httpStatus: resp.status,
        username,
        platform,
        profileUrl,
        id,
        nickname: fullName || username,
        avatarUrl,
      };
    }

    if (resp.status === 401 || resp.url.includes('/accounts/login') || json?.require_login === true) {
      sawAuthRequired = true;
    } else if (resp.status === 403 || resp.status === 429) {
      sawBlocked = true;
    }
  } catch (err) {
    lastNetworkError = err instanceof Error ? err.message : String(err);
  }

  // Tier 2: Mobile usernameinfo API
  try {
    const mobileApiUrl = `https://i.instagram.com/api/v1/users/${encodeURIComponent(username)}/usernameinfo/`;
    const headers: Record<string, string> = {
      'User-Agent': IG_MOBILE_USER_AGENT,
      'X-IG-App-ID': IG_APP_ID,
      Accept: 'application/json',
    };
    if (effectiveCookie) {
      headers.Cookie = effectiveCookie;
    }

    const resp = await fetchWithTimeout(mobileApiUrl, { headers, timeoutMs: 9000 });
    lastHttpStatus = resp.status;

    if (resp.status === 404) {
      return {
        valid: false,
        status: 'NOT_FOUND',
        authMode,
        httpStatus: 404,
        username,
        platform,
        profileUrl,
        error: `Tài khoản Instagram "@${username}" không tồn tại (HTTP 404).`,
      };
    }

    const json = safeJsonParse<Record<string, unknown>>(resp.text || '');
    const msg = typeof json?.message === 'string' ? json.message : '';
    if (/user not found/i.test(msg)) {
      return {
        valid: false,
        status: 'NOT_FOUND',
        authMode,
        httpStatus: resp.status,
        username,
        platform,
        profileUrl,
        error: `Tài khoản Instagram "@${username}" không tồn tại.`,
      };
    }

    const user = json?.user as Record<string, unknown> | undefined;
    if (resp.ok && user) {
      const id = String(user.pk || user.id || '').trim() || undefined;
      const fullName = typeof user.full_name === 'string' ? user.full_name.trim() : '';
      const hdInfo = user.hd_profile_pic_url_info as { url?: unknown } | undefined;
      const rawAvatar =
        typeof hdInfo?.url === 'string' && hdInfo.url
          ? hdInfo.url
          : typeof user.profile_pic_url === 'string'
          ? user.profile_pic_url
          : '';
      const avatarUrl = rawAvatar ? unescapeJsonUrl(rawAvatar) : undefined;
      return {
        valid: true,
        status: 'VALID',
        authMode,
        httpStatus: resp.status,
        username,
        platform,
        profileUrl,
        id,
        nickname: fullName || username,
        avatarUrl,
      };
    }

    if (resp.status === 401 || /login_required/i.test(msg)) {
      sawAuthRequired = true;
    } else if (resp.status === 403 || resp.status === 429) {
      sawBlocked = true;
    }
  } catch (err) {
    lastNetworkError = err instanceof Error ? err.message : String(err);
  }

  // Tier 3: Crawler UA & Authenticated Desktop HTML fallback
  const htmlAttempts: Array<{ ua: string; useCookie: boolean; secFetch?: boolean }> = [
    { ua: CRAWLER_FACEBOOK_UA, useCookie: false },
    { ua: CRAWLER_TWITTER_UA, useCookie: false },
  ];
  if (effectiveCookie) {
    htmlAttempts.push({ ua: DESKTOP_USER_AGENT, useCookie: true, secFetch: true });
  }

  const webUrl = `https://www.instagram.com/${encodeURIComponent(username)}/`;
  for (const attempt of htmlAttempts) {
    try {
      const headers: Record<string, string> = {
        'User-Agent': attempt.ua,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      };
      if (attempt.secFetch) {
        headers['Sec-Fetch-Dest'] = 'document';
        headers['Sec-Fetch-Mode'] = 'navigate';
        headers['Sec-Fetch-Site'] = 'none';
        headers['Sec-Fetch-User'] = '?1';
      }
      if (attempt.useCookie && effectiveCookie) {
        headers.Cookie = effectiveCookie;
      }

      const resp = await fetchWithTimeout(webUrl, { headers, timeoutMs: 9000 });
      lastHttpStatus = resp.status;
      const html = resp.text || '';

      if (
        resp.status === 404 ||
        /Sorry, this page isn't available|Trang này hiện không khả dụng|<title>\s*Page Not Found/i.test(html)
      ) {
        return {
          valid: false,
          status: 'NOT_FOUND',
          authMode,
          httpStatus: resp.status,
          username,
          platform,
          profileUrl,
          error: `Tài khoản Instagram "@${username}" không tồn tại hoặc đã đổi tên.`,
        };
      }

      if (
        resp.url.includes('/accounts/login') ||
        /<title>\s*Login\s*[•·-]\s*Instagram/i.test(html)
      ) {
        sawAuthRequired = true;
        continue;
      }

      if (resp.url.includes('/challenge/') || resp.status === 403 || resp.status === 429) {
        sawBlocked = true;
        continue;
      }

      const idMatch =
        html.match(/"(?:profile_id|target_user_id|user_id)"\s*:\s*"([1-9]\d{4,})"/) ||
        html.match(/profilePage_([1-9]\d{4,})/);
      const id = idMatch?.[1];

      const rawPicMatch =
        html.match(/"profile_pic_url_hd"\s*:\s*"((?:[^"\\]|\\.)+)"/) ||
        html.match(/"profile_pic_url"\s*:\s*"((?:[^"\\]|\\.)+)"/);
      const ogImage = extractMetaTag(html, 'og:image');
      const picCandidate = rawPicMatch?.[1]
        ? unescapeJsonUrl(decodeJsonStringLiteral(rawPicMatch[1]))
        : ogImage && !isGenericInstagramAvatar(ogImage)
        ? ogImage
        : undefined;
      const avatarUrl = picCandidate && !isGenericInstagramAvatar(picCandidate) ? picCandidate : undefined;

      const fullNameMatch = html.match(/"full_name"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      const decodedFullName = fullNameMatch?.[1]
        ? decodeJsonStringLiteral(fullNameMatch[1]).trim()
        : '';
      const ogTitle = extractMetaTag(html, 'og:title');
      const cleanedOgTitle = ogTitle ? cleanInstagramOgTitle(ogTitle, username) : undefined;
      const nickname = decodedFullName || cleanedOgTitle;

      if (id || nickname || avatarUrl) {
        return {
          valid: true,
          status: 'VALID',
          authMode,
          httpStatus: resp.status,
          username,
          platform,
          profileUrl,
          id,
          nickname: nickname || username,
          avatarUrl,
        };
      }

      // HTTP 200 SPA shell without profile info
      sawBlocked = true;
    } catch (err) {
      lastNetworkError = err instanceof Error ? err.message : String(err);
    }
  }

  if (sawAuthRequired) {
    return {
      valid: false,
      status: 'AUTH_REQUIRED',
      authMode,
      httpStatus: lastHttpStatus,
      username,
      platform,
      profileUrl,
      error: `Instagram yêu cầu đăng nhập để xem hồ sơ @${username}. Vui lòng cấu hình Instagram Cookie (sessionid) trong Cài đặt Cookie.`,
    };
  }

  if (sawBlocked || lastHttpStatus !== undefined) {
    return {
      valid: false,
      status: 'BLOCKED',
      authMode,
      httpStatus: lastHttpStatus,
      username,
      platform,
      profileUrl,
      error: `Instagram đang giới hạn hoặc chặn truy cập (HTTP ${lastHttpStatus ?? 429}) khi kiểm tra @${username}. Vui lòng thử lại hoặc cấu hình Instagram Cookie.`,
    };
  }

  return {
    valid: false,
    status: 'ERROR',
    authMode,
    username,
    platform,
    profileUrl,
    error: `Không thể kết nối xác thực tài khoản @${username} với Instagram: ${lastNetworkError || 'Lỗi mạng'}`,
  };
}

async function validateFacebookUser(
  username: string,
  platform: string,
  profileUrl: string,
  cookie: string
): Promise<UserValidationResult> {
  const effectiveCookie = cookie.trim();
  const authMode: 'anonymous' | 'cookie' = effectiveCookie ? 'cookie' : 'anonymous';

  if (!/^[a-zA-Z0-9_.-]+$/.test(username) || username.length < 3 || username.length > 50) {
    return {
      valid: false,
      status: 'INVALID_FORMAT',
      authMode,
      username,
      platform,
      profileUrl,
      error: `Tên người dùng hoặc URL Facebook "${username}" không hợp lệ.`,
    };
  }

  const isNumeric = /^\d+$/.test(username);
  const desktopUrl = isNumeric
    ? `https://www.facebook.com/profile.php?id=${username}`
    : `https://www.facebook.com/${encodeURIComponent(username)}`;
  const mobileUrl = isNumeric
    ? `https://m.facebook.com/profile.php?id=${username}`
    : `https://m.facebook.com/${encodeURIComponent(username)}`;
  const mbasicUrl = isNumeric
    ? `https://mbasic.facebook.com/profile.php?id=${username}`
    : `https://mbasic.facebook.com/${encodeURIComponent(username)}`;

  const attempts: Array<{ url: string; headers: Record<string, string> }> = [
    {
      url: desktopUrl,
      headers: {
        'User-Agent': DESKTOP_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
        ...(effectiveCookie ? { Cookie: effectiveCookie } : {}),
      },
    },
    {
      url: desktopUrl,
      headers: {
        'User-Agent': CRAWLER_TWITTER_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    },
    {
      url: mobileUrl,
      headers: {
        'User-Agent': FB_MOBILE_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        ...(effectiveCookie ? { Cookie: effectiveCookie } : {}),
      },
    },
  ];

  if (effectiveCookie) {
    attempts.push({
      url: mbasicUrl,
      headers: {
        'User-Agent': DESKTOP_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Cookie: effectiveCookie,
      },
    });
  }

  let lastHttpStatus: number | undefined;
  let sawAuthRequired = false;
  let sawBlocked = false;
  let lastNetworkError: string | null = null;

  for (const attempt of attempts) {
    try {
      const resp = await fetchWithTimeout(attempt.url, {
        headers: attempt.headers,
        timeoutMs: 9000,
      });
      lastHttpStatus = resp.status;
      const html = resp.text || '';

      if (resp.status === 404) {
        return {
          valid: false,
          status: 'NOT_FOUND',
          authMode,
          httpStatus: 404,
          username,
          platform,
          profileUrl,
          error: `Trang hoặc tài khoản Facebook "${username}" không tồn tại (HTTP 404).`,
        };
      }

      if (
        resp.url.includes('/checkpoint/') ||
        resp.status === 400 ||
        resp.status === 403 ||
        resp.status === 429
      ) {
        sawBlocked = true;
        continue;
      }

      const hasMissingPhrase =
        /This content isn't available right now|This page isn't available|The link you followed may be broken|Bạn hiện không xem được nội dung này|Trang này không hiển thị/i.test(
          html
        );
      if (hasMissingPhrase) {
        if (/you must log in|đăng nhập để tiếp tục/i.test(html)) {
          sawAuthRequired = true;
          continue;
        }
        return {
          valid: false,
          status: 'NOT_FOUND',
          authMode,
          httpStatus: resp.status,
          username,
          platform,
          profileUrl,
          error: `Trang hoặc tài khoản Facebook "${username}" không tồn tại hoặc đã bị gỡ.`,
        };
      }

      const isLoginWall =
        /\/login(?:\.php|\/|\?|$)/i.test(resp.url) ||
        /id=["']login_form["']|action=["']\/login\/|<title[^>]*>\s*(?:Log in to Facebook|Log into Facebook|Đăng nhập Facebook)/i.test(
          html
        );
      if (isLoginWall) {
        sawAuthRequired = true;
        continue;
      }

      const idMatch =
        html.match(/"userID"\s*:\s*"([1-9]\d{4,})"/) ||
        html.match(/"entity_id"\s*:\s*"([1-9]\d{4,})"/) ||
        html.match(/"pageID"\s*:\s*"([1-9]\d{4,})"/) ||
        html.match(/"profile_owner"\s*:\s*\{[^}]*"id"\s*:\s*"([1-9]\d{4,})"/) ||
        html.match(/fb:\/\/(?:profile|page)\/([1-9]\d{4,})/);
      const extractedId = idMatch?.[1];

      const ogImage = extractMetaTag(html, 'og:image');
      const picJsonMatch =
        html.match(/"profilePicLarge"\s*:\s*\{\s*"uri"\s*:\s*"((?:[^"\\]|\\.)+)"/) ||
        html.match(/"profile_picture"\s*:\s*\{\s*"uri"\s*:\s*"((?:[^"\\]|\\.)+)"/);
      const picCandidate =
        ogImage && !isGenericFacebookAvatar(ogImage)
          ? ogImage
          : picJsonMatch?.[1]
          ? unescapeJsonUrl(decodeJsonStringLiteral(picJsonMatch[1]))
          : undefined;
      const avatarUrl =
        picCandidate && !isGenericFacebookAvatar(picCandidate) ? picCandidate : undefined;

      const ogTitle = extractMetaTag(html, 'og:title');
      const titleTagMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const titleNickname =
        (ogTitle && cleanFacebookTitle(ogTitle)) ||
        (titleTagMatch?.[1] && cleanFacebookTitle(titleTagMatch[1])) ||
        undefined;
      const nameJsonMatch = html.match(/"name"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      const decodedJsonName = nameJsonMatch?.[1]
        ? cleanFacebookTitle(decodeJsonStringLiteral(nameJsonMatch[1]))
        : undefined;
      const jsonNickname =
        decodedJsonName && decodedJsonName.length <= 120 ? decodedJsonName : undefined;
      const nickname =
        titleNickname || (extractedId || avatarUrl ? jsonNickname : undefined);

      if (extractedId || nickname || avatarUrl) {
        return {
          valid: true,
          status: 'VALID',
          authMode,
          httpStatus: resp.status,
          username,
          platform,
          profileUrl,
          id: extractedId || (isNumeric ? username : undefined),
          nickname: nickname || username,
          avatarUrl,
        };
      }

      if (/you must log in|đăng nhập để tiếp tục/i.test(html)) {
        sawAuthRequired = true;
      } else {
        sawBlocked = true;
      }
    } catch (err) {
      lastNetworkError = err instanceof Error ? err.message : String(err);
    }
  }

  if (sawAuthRequired) {
    return {
      valid: false,
      status: 'AUTH_REQUIRED',
      authMode,
      httpStatus: lastHttpStatus,
      username,
      platform,
      profileUrl,
      error: `Facebook yêu cầu đăng nhập để xem trang "${username}". Vui lòng cấu hình Facebook Cookie (c_user, xs) trong Cài đặt Cookie.`,
    };
  }

  if (sawBlocked || lastHttpStatus !== undefined) {
    return {
      valid: false,
      status: 'BLOCKED',
      authMode,
      httpStatus: lastHttpStatus,
      username,
      platform,
      profileUrl,
      error: `Facebook đang chặn hoặc yêu cầu xác minh (HTTP ${lastHttpStatus ?? 403}) khi kiểm tra "${username}". Vui lòng thử lại hoặc cấu hình Facebook Cookie.`,
    };
  }

  return {
    valid: false,
    status: 'ERROR',
    authMode,
    username,
    platform,
    profileUrl,
    error: `Không thể kết nối xác thực tài khoản "${username}" với Facebook: ${lastNetworkError || 'Lỗi mạng'}`,
  };
}

async function validateXUser(
  username: string,
  platform: string,
  profileUrl: string,
  cookie: string
): Promise<UserValidationResult> {
  const effectiveCookie = cookie.trim();
  const authMode: 'anonymous' | 'cookie' = effectiveCookie ? 'cookie' : 'anonymous';

  if (!/^[a-zA-Z0-9_]{1,15}$/.test(username)) {
    return {
      valid: false,
      status: 'INVALID_FORMAT',
      authMode,
      username,
      platform,
      profileUrl,
      error: `Username X (Twitter) "@${username}" không hợp lệ (tối đa 15 ký tự chữ cái, số hoặc dấu gạch dưới).`,
    };
  }

  let lastHttpStatus: number | undefined;
  let sawAuthRequired = false;
  let sawBlocked = false;
  let lastNetworkError: string | null = null;

  // Tier 1: GraphQL UserByScreenName
  try {
    const variables = JSON.stringify({
      screen_name: username,
      withSafetyModeUserFields: true,
    });
    const features = JSON.stringify({
      hidden_profile_subscriptions_enabled: true,
      rweb_tipjar_consumption_enabled: true,
      responsive_web_graphql_exclude_directive_enabled: true,
      verified_phone_label_enabled: false,
      subscriptions_verification_info_is_identity_verified_enabled: true,
      subscriptions_verification_info_verified_guest_may_be_enabled: true,
      responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
      responsive_web_graphql_timeline_navigation_enabled: true,
    });
    const fieldToggles = JSON.stringify({ withAuxiliaryUserLabels: false });
    const gqlUrl =
      `https://api.x.com/graphql/qW5u-DAuXpMEG0zA1F7UGQ/UserByScreenName` +
      `?variables=${encodeURIComponent(variables)}` +
      `&features=${encodeURIComponent(features)}` +
      `&fieldToggles=${encodeURIComponent(fieldToggles)}`;

    const executeGql = async (forceRefreshGuest: boolean) => {
      const headers: Record<string, string> = {
        Authorization: X_BEARER_TOKEN,
        'User-Agent': DESKTOP_USER_AGENT,
        Accept: '*/*',
        Referer: 'https://x.com/',
      };
      if (effectiveCookie) {
        attachXCookieHeaders(headers, effectiveCookie);
      } else {
        const guestToken = await getOrRefreshXGuestToken(forceRefreshGuest);
        if (guestToken) {
          headers['x-guest-token'] = guestToken;
        }
      }
      return fetchWithTimeout(gqlUrl, { headers, timeoutMs: 9000 });
    };

    let resp = await executeGql(false);
    if (!effectiveCookie && (resp.status === 401 || resp.status === 403)) {
      cachedXGuestToken = null;
      resp = await executeGql(true);
    }
    lastHttpStatus = resp.status;

    if (resp.status === 404) {
      return {
        valid: false,
        status: 'NOT_FOUND',
        authMode,
        httpStatus: 404,
        username,
        platform,
        profileUrl,
        error: `Tài khoản X "@${username}" không tồn tại (HTTP 404).`,
      };
    }

    const json = safeJsonParse<Record<string, unknown>>(resp.text || '');
    const dataObj = json?.data as Record<string, unknown> | undefined;
    const userObj = dataObj?.user as Record<string, unknown> | undefined;
    const result = userObj?.result as Record<string, unknown> | undefined;

    if (result) {
      const typename = typeof result.__typename === 'string' ? result.__typename : '';
      const legacy = result.legacy as Record<string, unknown> | undefined;
      const core = result.core as Record<string, unknown> | undefined;

      if (typename === 'User' || (result.rest_id && legacy)) {
        const id = typeof result.rest_id === 'string' || typeof result.rest_id === 'number'
          ? String(result.rest_id)
          : undefined;
        const nickname =
          (typeof legacy?.name === 'string' && legacy.name.trim()) ||
          (typeof core?.name === 'string' && core.name.trim()) ||
          username;
        const rawAvatar =
          typeof legacy?.profile_image_url_https === 'string'
            ? legacy.profile_image_url_https
            : '';
        return {
          valid: true,
          status: 'VALID',
          authMode,
          httpStatus: resp.status,
          username,
          platform,
          profileUrl,
          id,
          nickname,
          avatarUrl: upgradeXAvatarUrl(rawAvatar),
        };
      }

      if (typename === 'UserUnavailable') {
        const reason = typeof result.reason === 'string' ? result.reason : '';
        const message = typeof result.message === 'string' ? result.message : '';
        if (/notfound/i.test(reason)) {
          return {
            valid: false,
            status: 'NOT_FOUND',
            authMode,
            httpStatus: resp.status,
            username,
            platform,
            profileUrl,
            error: `Tài khoản X "@${username}" không tồn tại (${reason}).`,
          };
        }
        // Check auth/age-restriction BEFORE Suspended because X can emit both reason="Suspended" & message="User is age-restricted"
        if (
          /age-restricted|log in|must be logged in/i.test(message) ||
          /protected|nsfw|agerestricted/i.test(reason)
        ) {
          return {
            valid: false,
            status: 'AUTH_REQUIRED',
            authMode,
            httpStatus: resp.status,
            username,
            platform,
            profileUrl,
            error: `X yêu cầu đăng nhập (${message || reason}) để xem hồ sơ @${username}. Vui lòng cấu hình X Cookie (auth_token, ct0) trong Cài đặt Cookie.`,
          };
        }
        if (/suspended/i.test(reason)) {
          return {
            valid: false,
            status: 'BLOCKED',
            authMode,
            httpStatus: resp.status,
            username,
            platform,
            profileUrl,
            error: `Tài khoản X "@${username}" đã bị tạm khóa (${reason}).`,
          };
        }
        return {
          valid: false,
          status: 'BLOCKED',
          authMode,
          httpStatus: resp.status,
          username,
          platform,
          profileUrl,
          error: `Tài khoản X "@${username}" hiện không khả dụng (${message || reason || 'UserUnavailable'}).`,
        };
      }
    }

    const errors = Array.isArray(json?.errors)
      ? (json.errors as Array<{ code?: number; message?: string }>)
      : [];

    if (resp.ok && dataObj && 'user' in dataObj && (!userObj || Object.keys(userObj).length === 0) && errors.length === 0) {
      return {
        valid: false,
        status: 'NOT_FOUND',
        authMode,
        httpStatus: resp.status,
        username,
        platform,
        profileUrl,
        error: `Tài khoản X "@${username}" không tồn tại.`,
      };
    }

    for (const errItem of errors) {
      if (errItem?.code === 50) {
        return {
          valid: false,
          status: 'NOT_FOUND',
          authMode,
          httpStatus: resp.status,
          username,
          platform,
          profileUrl,
          error: `Tài khoản X "@${username}" không tồn tại (Code 50).`,
        };
      }
      if (errItem?.code === 63) {
        return {
          valid: false,
          status: 'BLOCKED',
          authMode,
          httpStatus: resp.status,
          username,
          platform,
          profileUrl,
          error: `Tài khoản X "@${username}" đã bị tạm khóa (Code 63).`,
        };
      }
      if (errItem?.code === 32 || errItem?.code === 239 || errItem?.code === 353) {
        sawAuthRequired = true;
      }
    }

    if (resp.status === 401) {
      sawAuthRequired = true;
    } else if (resp.status === 403 || resp.status === 429) {
      sawBlocked = true;
    }
  } catch (err) {
    lastNetworkError = err instanceof Error ? err.message : String(err);
  }

  // Tier 2: Syndication followbutton info fallback
  try {
    const syndicationUrl = `https://cdn.syndication.twimg.com/widgets/followbutton/info.json?screen_names=${encodeURIComponent(username)}`;
    const resp = await fetchWithTimeout(syndicationUrl, {
      headers: {
        'User-Agent': DESKTOP_USER_AGENT,
        Accept: 'application/json',
      },
      timeoutMs: 7000,
    });
    lastHttpStatus = resp.status;
    if (resp.ok && resp.text.trim()) {
      const arr = safeJsonParse<Array<{ id?: string | number; name?: string; screen_name?: string }>>(
        resp.text
      );
      if (Array.isArray(arr) && arr[0]?.id) {
        return {
          valid: true,
          status: 'VALID',
          authMode,
          httpStatus: resp.status,
          username,
          platform,
          profileUrl,
          id: String(arr[0].id),
          nickname: typeof arr[0].name === 'string' && arr[0].name.trim() ? arr[0].name : username,
        };
      }
    } else if (resp.status === 403 || resp.status === 429) {
      sawBlocked = true;
    }
  } catch (err) {
    lastNetworkError = err instanceof Error ? err.message : String(err);
  }

  // Tier 3: X HTML fallback
  try {
    const htmlUrl = `https://x.com/${encodeURIComponent(username)}`;
    const headers: Record<string, string> = {
      'User-Agent': DESKTOP_USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    };
    if (effectiveCookie) {
      attachXCookieHeaders(headers, effectiveCookie);
    }
    const resp = await fetchWithTimeout(htmlUrl, { headers, timeoutMs: 9000 });
    lastHttpStatus = resp.status;
    const html = resp.text || '';

    if (resp.status === 404) {
      return {
        valid: false,
        status: 'NOT_FOUND',
        authMode,
        httpStatus: 404,
        username,
        platform,
        profileUrl,
        error: `Tài khoản X "@${username}" không tồn tại (HTTP 404).`,
      };
    }
    if (
      resp.status === 401 ||
      resp.url.includes('/i/flow/login') ||
      /\/login(?:\?|\/|$)/i.test(resp.url)
    ) {
      sawAuthRequired = true;
    } else if (resp.status === 403 || resp.status === 429) {
      sawBlocked = true;
    } else {
      const restIdMatch = html.match(/"rest_id"\s*:\s*"([1-9]\d{4,})"/);
      const ogTitle = extractMetaTag(html, 'og:title');
      const cleanedTitle =
        ogTitle && !/^(?:x|profile \/ x|log in to x)$/i.test(ogTitle.trim())
          ? ogTitle.replace(/\s*\(@[^)]+\)\s*\/\s*X.*$/i, '').trim()
          : undefined;
      const ogImage = extractMetaTag(html, 'og:image');
      const avatarUrl =
        ogImage && !ogImage.toLowerCase().includes('abs.twimg.com/sticky')
          ? upgradeXAvatarUrl(ogImage)
          : undefined;

      if (restIdMatch?.[1] || cleanedTitle || avatarUrl) {
        return {
          valid: true,
          status: 'VALID',
          authMode,
          httpStatus: resp.status,
          username,
          platform,
          profileUrl,
          id: restIdMatch?.[1],
          nickname: cleanedTitle || username,
          avatarUrl,
        };
      }
      sawBlocked = true;
    }
  } catch (err) {
    lastNetworkError = err instanceof Error ? err.message : String(err);
  }

  if (sawAuthRequired) {
    return {
      valid: false,
      status: 'AUTH_REQUIRED',
      authMode,
      httpStatus: lastHttpStatus,
      username,
      platform,
      profileUrl,
      error: `X yêu cầu đăng nhập để xem hồ sơ @${username}. Vui lòng cấu hình X Cookie (auth_token, ct0) trong Cài đặt Cookie.`,
    };
  }

  if (sawBlocked || lastHttpStatus !== undefined) {
    return {
      valid: false,
      status: 'BLOCKED',
      authMode,
      httpStatus: lastHttpStatus,
      username,
      platform,
      profileUrl,
      error: `X đang giới hạn hoặc chặn truy cập (HTTP ${lastHttpStatus ?? 403}) khi kiểm tra @${username}. Vui lòng thử lại hoặc cấu hình X Cookie.`,
    };
  }

  return {
    valid: false,
    status: 'ERROR',
    authMode,
    username,
    platform,
    profileUrl,
    error: `Không thể kết nối xác thực tài khoản @${username} với X: ${lastNetworkError || 'Lỗi mạng'}`,
  };
}

/**
 * Validates whether a target username exists and is valid on the target platform.
 */
export async function validateTargetUser(
  target: string,
  platform = 'TIKTOK',
  cookie = ''
): Promise<UserValidationResult> {
  const username = extractTargetUsername(target);
  const p = platform.toUpperCase();
  const rawCookie = typeof cookie === 'string' ? cookie.trim() : '';
  const authMode: 'anonymous' | 'cookie' = rawCookie ? 'cookie' : 'anonymous';
  const profileUrl = resolvePlatformProfileUrl(username, p);

  if (!username) {
    return {
      valid: false,
      status: 'INVALID_FORMAT',
      authMode,
      username: '',
      platform: p,
      profileUrl,
      error: target.trim()
        ? `Tên người dùng hoặc URL "${target}" không hợp lệ hoặc không phải trang cá nhân.`
        : 'Tên người dùng không được để trống',
    };
  }

  // 1. TikTok Validation
  if (p === 'TIKTOK' || p === 'REDDIT') {
    return validateTikTokUser(username, p, profileUrl, rawCookie);
  }

  // 2. Instagram Validation
  if (p === 'INSTAGRAM' || p === 'HACKERNEWS') {
    return validateInstagramUser(username, p, profileUrl, rawCookie);
  }

  // 3. Facebook Validation
  if (p === 'FACEBOOK' || p === 'GITHUB') {
    return validateFacebookUser(username, p, profileUrl, rawCookie);
  }

  // 4. X (Twitter) Validation
  if (p === 'X' || p === 'BLUESKY' || p === 'TWITTER') {
    return validateXUser(username, p, profileUrl, rawCookie);
  }

  return {
    valid: true,
    status: 'VALID',
    authMode,
    username,
    platform: p,
    profileUrl,
  };
}
