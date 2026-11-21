import { fetchWithTimeout, safeJsonParse } from '../../liveCheckers/httpClient';
import {
  extractInstagramUsername,
  formatInstagramCookie,
} from '../../liveCheckers/instagramChecker';
import type { CollectorFetchResult, WatcherEvent } from '../types';

export { extractInstagramUsername, formatInstagramCookie };

export const IG_APP_ID = '936619743392459';
export const IG_WEB_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
export const IG_MOBILE_USER_AGENT =
  'Instagram 312.0.0.34.111 Android (34/14; 480dpi; 1080x2400; samsung; SM-S918B; dm3q; qcom; en_US; 559996041)';
export const IG_CRAWLER_USER_AGENTS = [
  'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  'Twitterbot/1.0',
] as const;

export const instagramUserIdCache = new Map<string, string>();

export function clearInstagramUserIdCache(): void {
  instagramUserIdCache.clear();
}

export function unescapeInstagramUrl(raw: string): string {
  return raw
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003d/gi, '=')
    .replace(/&amp;/g, '&')
    .trim();
}

export function extractInstagramCsrfToken(cookie: string): string {
  const match = cookie.match(/csrftoken=([^;\s]+)/i);
  return match?.[1]?.trim() || '';
}

export function buildInstagramWebApiHeaders(
  username: string,
  formattedCookie: string
): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': IG_WEB_USER_AGENT,
    'X-IG-App-ID': IG_APP_ID,
    'X-ASBD-ID': '129477',
    'X-IG-WWW-Claim': '0',
    'X-Requested-With': 'XMLHttpRequest',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: `https://www.instagram.com/${encodeURIComponent(username)}/`,
  };
  if (formattedCookie) {
    headers.Cookie = formattedCookie;
    const csrf = extractInstagramCsrfToken(formattedCookie);
    if (csrf) {
      headers['X-CSRFToken'] = csrf;
    }
  }
  return headers;
}

export function buildInstagramMobileApiHeaders(
  username: string,
  formattedCookie: string
): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': IG_MOBILE_USER_AGENT,
    'X-IG-App-ID': IG_APP_ID,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: `https://www.instagram.com/${encodeURIComponent(username)}/`,
  };
  if (formattedCookie) {
    headers.Cookie = formattedCookie;
  }
  return headers;
}

export function classifyInstagramFailure(
  status: number,
  url: string,
  body: string,
  usedCookie: boolean
): CollectorFetchResult<WatcherEvent> | null {
  const lowerUrl = (url || '').toLowerCase();
  const lowerBody = (body || '').toLowerCase();

  if (
    status === 404 ||
    lowerBody.includes("sorry, this page isn't available") ||
    lowerBody.includes('the link you followed may be broken')
  ) {
    return {
      status: 'NOT_FOUND',
      events: [],
      reason: 'Không tìm thấy tài khoản Instagram (HTTP 404)',
      httpStatus: status || 404,
      usedCookie,
    };
  }

  if (
    status === 429 ||
    lowerBody.includes('please wait a few minutes before you try again')
  ) {
    return {
      status: 'RATE_LIMITED',
      events: [],
      reason: 'Instagram giới hạn tốc độ truy cập (HTTP 429)',
      httpStatus: status || 429,
      usedCookie,
    };
  }

  if (
    status === 401 ||
    status === 302 ||
    lowerUrl.includes('/accounts/login') ||
    lowerBody.includes('"require_login":true') ||
    lowerBody.includes('login_required') ||
    lowerBody.includes('redirect_loop') ||
    lowerBody.includes('sessionid=deleted')
  ) {
    return {
      status: 'AUTH_REQUIRED',
      events: [],
      reason: usedCookie
        ? 'Cookie Instagram đã hết hạn hoặc không hợp lệ — cần đăng nhập lại'
        : 'Instagram yêu cầu đăng nhập / cookie sessionid để xem nội dung này',
      httpStatus: status || 401,
      usedCookie,
    };
  }

  if (
    status === 403 ||
    lowerUrl.includes('/challenge/') ||
    lowerBody.includes('challenge_required') ||
    lowerBody.includes('checkpoint_required') ||
    lowerBody.includes('consent_required')
  ) {
    return {
      status: 'BLOCKED',
      events: [],
      reason: 'Instagram chặn truy cập hoặc yêu cầu xác minh challenge/checkpoint',
      httpStatus: status || 403,
      usedCookie,
    };
  }

  if (status >= 500) {
    return {
      status: 'ERROR',
      events: [],
      reason: `Instagram gặp lỗi máy chủ (HTTP ${status})`,
      httpStatus: status,
      usedCookie,
    };
  }

  return null;
}

export function extractInstagramUserIdFromHtml(html: string): string | null {
  const match = html.match(
    /(?:"(?:profile_id|target_user_id)"\s*:\s*"(\d+)"|"user_id"\s*:\s*"(\d+)"|profilePage_(\d+))/
  );
  const id = match?.[1] || match?.[2] || match?.[3] || '';
  return id && id !== '0' ? id : null;
}

export interface ResolveInstagramUserIdResult {
  userId: string | null;
  isPrivate?: boolean;
  failureResult?: CollectorFetchResult<WatcherEvent>;
}

export async function resolveInstagramUserId(
  username: string,
  formattedCookie: string
): Promise<ResolveInstagramUserIdResult> {
  const cacheKey = username.toLowerCase();
  const cached = instagramUserIdCache.get(cacheKey);
  if (cached) {
    return { userId: cached };
  }

  const usedCookie = Boolean(formattedCookie);
  let lastFailure: CollectorFetchResult<WatcherEvent> | undefined;

  const tryWebProfileInfo = async (): Promise<ResolveInstagramUserIdResult | null> => {
    const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(
      username
    )}&_=${Date.now()}`;
    const resp = await fetchWithTimeout(url, {
      headers: buildInstagramWebApiHeaders(username, formattedCookie),
      timeoutMs: 10000,
    });
    const failure = classifyInstagramFailure(resp.status, resp.url, resp.text, usedCookie);
    if (failure) {
      lastFailure = failure;
      if (failure.status === 'NOT_FOUND') return { userId: null, failureResult: failure };
      return null;
    }
    if (resp.ok && resp.text) {
      const json = safeJsonParse<{
        data?: { user?: { id?: string; pk?: string; is_private?: boolean } };
      }>(resp.text);
      const user = json?.data?.user;
      const id = String(user?.id || user?.pk || '').trim();
      if (id && /^\d+$/.test(id) && id !== '0') {
        instagramUserIdCache.set(cacheKey, id);
        return { userId: id, isPrivate: Boolean(user?.is_private) };
      }
    }
    return null;
  };

  const tryMobileUsernameInfo = async (): Promise<ResolveInstagramUserIdResult | null> => {
    const url = `https://i.instagram.com/api/v1/users/${encodeURIComponent(
      username
    )}/usernameinfo/`;
    const resp = await fetchWithTimeout(url, {
      headers: buildInstagramMobileApiHeaders(username, formattedCookie),
      timeoutMs: 10000,
    });
    const failure = classifyInstagramFailure(resp.status, resp.url, resp.text, usedCookie);
    if (failure) {
      lastFailure = failure;
      if (failure.status === 'NOT_FOUND') return { userId: null, failureResult: failure };
      return null;
    }
    if (resp.ok && resp.text) {
      const json = safeJsonParse<{
        user?: { pk?: string | number; id?: string | number; is_private?: boolean };
      }>(resp.text);
      const id = String(json?.user?.pk || json?.user?.id || '').trim();
      if (id && /^\d+$/.test(id) && id !== '0') {
        instagramUserIdCache.set(cacheKey, id);
        return { userId: id, isPrivate: Boolean(json?.user?.is_private) };
      }
    }
    return null;
  };

  const tryHtmlProfile = async (
    userAgent: string,
    includeCookie: boolean
  ): Promise<ResolveInstagramUserIdResult | null> => {
    const url = `https://www.instagram.com/${encodeURIComponent(username)}/`;
    const headers: Record<string, string> = {
      'User-Agent': userAgent,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    };
    if (includeCookie && formattedCookie) {
      headers.Cookie = formattedCookie;
    }
    const resp = await fetchWithTimeout(url, { headers, timeoutMs: 10000 });
    const failure = classifyInstagramFailure(
      resp.status,
      resp.url,
      resp.text,
      includeCookie && usedCookie
    );
    if (failure) {
      lastFailure = failure;
      if (failure.status === 'NOT_FOUND') return { userId: null, failureResult: failure };
      return null;
    }
    if (resp.ok && resp.text) {
      const id = extractInstagramUserIdFromHtml(resp.text);
      if (id) {
        instagramUserIdCache.set(cacheKey, id);
        return { userId: id };
      }
    }
    return null;
  };

  if (usedCookie) {
    const r1 = await tryWebProfileInfo();
    if (r1) return r1;
    const r2 = await tryMobileUsernameInfo();
    if (r2) return r2;
    const r3 = await tryHtmlProfile(IG_WEB_USER_AGENT, true);
    if (r3) return r3;
  } else {
    const r1 = await tryHtmlProfile(IG_CRAWLER_USER_AGENTS[0], false);
    if (r1) return r1;
    const r2 = await tryWebProfileInfo();
    if (r2) return r2;
    const r3 = await tryMobileUsernameInfo();
    if (r3) return r3;
  }

  return {
    userId: null,
    failureResult: lastFailure,
  };
}
