import { fetchWithTimeout, safeJsonParse } from './httpClient';
import type { LiveCheckResult } from './types';

const BEARER_TOKEN =
  'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const GUEST_TOKEN_LIFETIME_MS = 2 * 60 * 60 * 1000; // 2 hours

let guestTokenCache: { token: string; expiresAt: number } | null = null;

function attachCookieHeaders(headers: Record<string, string>, xCookie: string = ''): void {
  const trimmed = typeof xCookie === 'string' ? xCookie.trim() : '';
  if (!trimmed) return;
  headers.Cookie = trimmed;
  const ct0Match = trimmed.match(/ct0=([a-zA-Z0-9_-]+)/);
  if (ct0Match?.[1]) {
    headers['x-csrf-token'] = ct0Match[1];
  }
}

async function getOrRefreshGuestToken(forceRefresh = false): Promise<string> {
  const now = Date.now();
  if (!forceRefresh && guestTokenCache && now < guestTokenCache.expiresAt) {
    return guestTokenCache.token;
  }

  try {
    const resp = await fetchWithTimeout('https://api.twitter.com/1.1/guest/activate.json', {
      method: 'POST',
      headers: {
        Authorization: BEARER_TOKEN,
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
      },
      body: '',
      timeoutMs: 10000,
    });
    if (resp.ok && resp.text) {
      const json = safeJsonParse<Record<string, unknown>>(resp.text);
      const token = typeof json?.guest_token === 'string' ? json.guest_token.trim() : '';
      if (token) {
        guestTokenCache = { token, expiresAt: now + GUEST_TOKEN_LIFETIME_MS };
        return token;
      }
    }
  } catch {
    // fall through to cached value if any
  }

  return guestTokenCache?.token || '';
}

async function queryBroadcastApi(
  broadcastId: string,
  guestToken: string,
  xCookie: string
): Promise<{ status: number; body: string }> {
  const url = `https://api.twitter.com/1.1/broadcasts/show.json?include_events=true&ids=${encodeURIComponent(
    broadcastId
  )}`;
  const headers: Record<string, string> = {
    Authorization: BEARER_TOKEN,
    'User-Agent': USER_AGENT,
  };
  if (guestToken) headers['x-guest-token'] = guestToken;
  attachCookieHeaders(headers, xCookie);

  const resp = await fetchWithTimeout(url, { headers, timeoutMs: 10000 });
  return { status: resp.status, body: resp.text };
}

async function queryLiveVideoStreamUrl(
  mediaKey: string,
  guestToken: string,
  xCookie: string
): Promise<string | null> {
  try {
    const url = `https://api.twitter.com/1.1/live_video_stream/status/${encodeURIComponent(
      mediaKey
    )}`;
    const headers: Record<string, string> = {
      Authorization: BEARER_TOKEN,
      'User-Agent': USER_AGENT,
    };
    if (guestToken) headers['x-guest-token'] = guestToken;
    attachCookieHeaders(headers, xCookie);

    const resp = await fetchWithTimeout(url, { headers, timeoutMs: 10000 });
    if (!resp.ok || !resp.text) return null;

    const json = safeJsonParse<Record<string, unknown>>(resp.text);
    const source = json?.source as Record<string, unknown> | undefined;
    if (!source) return null;

    const location = typeof source.location === 'string' ? source.location.trim() : '';
    if (location) return location;

    const noRedirect =
      typeof source.noRedirectPlaybackUrl === 'string' ? source.noRedirectPlaybackUrl.trim() : '';
    if (noRedirect) return noRedirect;
  } catch {
    // ignore
  }
  return null;
}

async function resolveBroadcastIdFromTweet(tweetId: string): Promise<string | null> {
  try {
    const url = `https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(
      tweetId
    )}&token=x`;
    const resp = await fetchWithTimeout(url, {
      headers: { 'User-Agent': USER_AGENT },
      timeoutMs: 10000,
    });
    if (!resp.ok || !resp.text) return null;

    const match = resp.text.match(/(?:x\.com|twitter\.com)\/i\/broadcasts\/([a-zA-Z0-9_-]+)/);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

export function extractXBroadcastIdsFromHtml(html: string): string[] {
  const results = new Set<string>();

  for (const m of html.matchAll(/broadcasts\/([a-zA-Z0-9_-]{10,25})/g)) {
    if (m[1] && m[1].length >= 10) results.add(m[1]);
  }

  for (const m of html.matchAll(/"broadcast_id"\s*:\s*"([a-zA-Z0-9_-]+)"/g)) {
    if (m[1] && m[1].length >= 10) results.add(m[1]);
  }

  return Array.from(results);
}

export function extractXUsername(input: string): string {
  const trimmed = input.trim();

  const broadcastMatch = trimmed.match(/(?:x\.com|twitter\.com)\/i\/broadcasts\/([a-zA-Z0-9_-]+)/);
  if (broadcastMatch?.[1]) {
    return `broadcast_${broadcastMatch[1]}`;
  }

  const tweetMatch = trimmed.match(/(?:x\.com|twitter\.com)\/([a-zA-Z0-9_]+)\/status\//);
  if (tweetMatch?.[1]) {
    return tweetMatch[1];
  }

  const profileMatch = trimmed.match(/(?:x\.com|twitter\.com)\/([a-zA-Z0-9_]+)/);
  if (profileMatch?.[1]) {
    const user = profileMatch[1];
    if (!['i', 'explore', 'home', 'search'].includes(user.toLowerCase())) {
      return user;
    }
  }

  return trimmed.replace(/^@/, '').split(/[/?#]/)[0]?.trim() || '';
}

export async function checkXBroadcastById(
  broadcastId: string,
  xCookie = '',
  displayUsername?: string
): Promise<LiveCheckResult> {
  const safeCookie = typeof xCookie === 'string' ? xCookie.trim() : '';
  const sourceUrl = `https://x.com/i/broadcasts/${broadcastId}`;
  const username = displayUsername || `broadcast_${broadcastId}`;

  try {
    let guestToken = await getOrRefreshGuestToken();
    let res = await queryBroadcastApi(broadcastId, guestToken, safeCookie);

    if (res.status === 401 || res.status === 403) {
      guestTokenCache = null;
      guestToken = await getOrRefreshGuestToken(true);
      res = await queryBroadcastApi(broadcastId, guestToken, safeCookie);
    }

    if (res.status !== 200 || !res.body) {
      return {
        status: 'ERROR',
        platform: 'X',
        username,
        sourceUrl,
        message: `Lỗi X broadcast API: HTTP ${res.status}`,
        checkedAt: new Date().toISOString(),
      };
    }

    const json = safeJsonParse<Record<string, unknown>>(res.body);
    const broadcastsObj = json?.broadcasts as Record<string, unknown> | undefined;
    const broadcastObj = broadcastsObj?.[broadcastId] as Record<string, unknown> | undefined;
    if (!broadcastObj) {
      return {
        status: 'NOT_LIVE',
        platform: 'X',
        username,
        sourceUrl,
        checkedAt: new Date().toISOString(),
      };
    }

    const state = String(broadcastObj.state || '');
    const title = String(broadcastObj.status || '').trim() || 'X Live Stream';
    const mediaKey = String(broadcastObj.media_key || '').trim();
    const resolvedUser =
      displayUsername ||
      String(broadcastObj.username || broadcastObj.twitter_username || '').trim() ||
      username;

    if (state.toUpperCase() === 'RUNNING') {
      if (mediaKey) {
        const streamUrl = await queryLiveVideoStreamUrl(mediaKey, guestToken, safeCookie);
        if (streamUrl) {
          return {
            status: 'LIVE',
            platform: 'X',
            username: resolvedUser,
            title,
            streamUrl,
            sourceUrl,
            qualityInfo: 'HLS (.m3u8)',
            method: 'x:broadcast-api',
            checkedAt: new Date().toISOString(),
          };
        }
      }
      return {
        status: 'ERROR',
        platform: 'X',
        username: resolvedUser,
        sourceUrl,
        message: 'Broadcast X đang live nhưng không lấy được link stream HLS',
        checkedAt: new Date().toISOString(),
      };
    }

    return {
      status: 'NOT_LIVE',
      platform: 'X',
      username: resolvedUser,
      sourceUrl,
      checkedAt: new Date().toISOString(),
    };
  } catch (err) {
    return {
      status: 'ERROR',
      platform: 'X',
      username,
      sourceUrl,
      message: `Lỗi kiểm tra broadcast X: ${err instanceof Error ? err.message : String(err)}`,
      checkedAt: new Date().toISOString(),
    };
  }
}

async function checkXUserLive(username: string, xCookie: string): Promise<LiveCheckResult> {
  const safeCookie = typeof xCookie === 'string' ? xCookie.trim() : '';
  const profileUrl = `https://x.com/${encodeURIComponent(username)}`;
  try {
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    };
    attachCookieHeaders(headers, safeCookie);

    const resp = await fetchWithTimeout(profileUrl, { headers, timeoutMs: 10000 });
    if (!resp.ok) {
      return {
        status: 'ERROR',
        platform: 'X',
        username,
        sourceUrl: profileUrl,
        message: `HTTP ${resp.status} khi tải x.com/${username}${
          !safeCookie ? ' (Thử thêm X Cookie nếu bị giới hạn)' : ''
        }`,
        checkedAt: new Date().toISOString(),
      };
    }

    const broadcastIds = extractXBroadcastIdsFromHtml(resp.text);
    if (broadcastIds.length === 0) {
      return {
        status: 'NOT_LIVE',
        platform: 'X',
        username,
        sourceUrl: profileUrl,
        checkedAt: new Date().toISOString(),
      };
    }

    // Check up to 3 latest broadcasts
    for (const id of broadcastIds.slice(0, 3)) {
      const res = await checkXBroadcastById(id, safeCookie, username);
      if (res.status === 'LIVE') {
        return res;
      }
    }

    return {
      status: 'NOT_LIVE',
      platform: 'X',
      username,
      sourceUrl: profileUrl,
      checkedAt: new Date().toISOString(),
    };
  } catch (err) {
    return {
      status: 'ERROR',
      platform: 'X',
      username,
      sourceUrl: profileUrl,
      message: `Lỗi kết nối X: ${err instanceof Error ? err.message : String(err)}`,
      checkedAt: new Date().toISOString(),
    };
  }
}

export async function checkXLive(usernameOrUrl: string, xCookie = ''): Promise<LiveCheckResult> {
  const trimmed = usernameOrUrl.trim();
  const safeCookie = typeof xCookie === 'string' ? xCookie.trim() : '';

  // 0. broadcast_ prefix
  if (trimmed.startsWith('broadcast_')) {
    const broadcastId = trimmed.slice('broadcast_'.length).trim();
    return checkXBroadcastById(broadcastId, safeCookie);
  }

  // 1. Direct broadcast URL
  const broadcastIdMatch = trimmed.match(/(?:x\.com|twitter\.com)\/i\/broadcasts\/([a-zA-Z0-9_-]+)/);
  if (broadcastIdMatch?.[1]) {
    return checkXBroadcastById(broadcastIdMatch[1], safeCookie);
  }

  // 2. Tweet link
  const tweetMatch = trimmed.match(/(?:x\.com|twitter\.com)\/([a-zA-Z0-9_]+)\/status\/([0-9]+)/);
  if (tweetMatch?.[2]) {
    const extractedBroadcastId = await resolveBroadcastIdFromTweet(tweetMatch[2]);
    if (extractedBroadcastId) {
      return checkXBroadcastById(extractedBroadcastId, safeCookie, tweetMatch[1]);
    }
  }

  // 3. Raw Broadcast ID (12-30 chars, no @ prefix, no spaces)
  if (!trimmed.startsWith('@') && /^[a-zA-Z0-9_-]{12,30}$/.test(trimmed)) {
    const directCheck = await checkXBroadcastById(trimmed, safeCookie);
    if (directCheck.status === 'LIVE') {
      return directCheck;
    }
  }

  // 4. Profile / Username
  const username = extractXUsername(trimmed);
  if (!username) {
    return {
      status: 'ERROR',
      platform: 'X',
      username: usernameOrUrl,
      sourceUrl: 'https://x.com',
      message: `Username X không hợp lệ: ${usernameOrUrl}`,
      checkedAt: new Date().toISOString(),
    };
  }

  return checkXUserLive(username, safeCookie);
}
