import { fetchWithTimeout, safeJsonParse } from './httpClient';
import type { LiveCheckResult } from './types';

const WEB_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MOBILE_USER_AGENT =
  'Instagram 312.0.0.34.111 Android (34/14; 480dpi; 1080x2400; samsung; SM-S918B; dm3q; qcom; en_US; 559996041)';
const IG_APP_ID = '936619743392459';

// In-memory cache mapping Instagram username -> numeric user_id to reduce HTTP 429
const userIdCache = new Map<string, string>();

function unescapeJsonUrl(raw: string): string {
  return raw
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003d/gi, '=')
    .replace(/&amp;/g, '&')
    .trim();
}

export function formatInstagramCookie(rawCookie: string = ''): string {
  const trimmed = typeof rawCookie === 'string' ? rawCookie.trim() : '';
  if (!trimmed) return '';
  if (!trimmed.includes('=')) {
    // User pasted bare Instagram sessionid (e.g. 50160641448%3Axxxx...)
    if (!trimmed.toLowerCase().includes('%3a') && !trimmed.includes(':')) {
      return '';
    }
    const userIdPart = trimmed.split(/%3A|%3a|:/)[0] || '';
    if (userIdPart && /^\d+$/.test(userIdPart)) {
      return `sessionid=${trimmed}; ds_user_id=${userIdPart}`;
    }
    return `sessionid=${trimmed}`;
  }
  return trimmed;
}

export function extractInstagramUsername(input: string): string {
  let trimmed = input.trim();
  if (trimmed.includes('instagram.com') || trimmed.includes('instagr.am')) {
    trimmed = trimmed.split(/[?#]/)[0] || trimmed;
    const match = trimmed.match(/(?:instagram\.com|instagr\.am)\/([a-zA-Z0-9_.]+)/);
    if (match?.[1]) {
      const candidate = match[1];
      if (!['live', 'stories', 'reels', 'p', 'tv', 'explore'].includes(candidate.toLowerCase())) {
        return candidate;
      }
    }
  }
  return trimmed.replace(/^@/, '').split(/[/?#]/)[0]?.trim() || '';
}

async function fetchBroadcastInfoById(
  broadcastId: string,
  username: string,
  cookie: string,
  sourceUrl: string
): Promise<LiveCheckResult | null> {
  const url = `https://i.instagram.com/api/v1/live/${encodeURIComponent(broadcastId)}/info/`;
  const headers: Record<string, string> = {
    'User-Agent': MOBILE_USER_AGENT,
    'X-IG-App-ID': IG_APP_ID,
    Referer: `https://www.instagram.com/${username}/live/`,
    Accept: '*/*',
  };
  const safeCookie = typeof cookie === 'string' ? cookie.trim() : '';
  if (safeCookie) headers.Cookie = safeCookie;

  const resp = await fetchWithTimeout(url, { headers, timeoutMs: 8000 });
  if (!resp.ok || !resp.text) return null;
  const json = safeJsonParse<Record<string, unknown>>(resp.text);
  if (!json) return null;
  return parseBroadcastObject(json, username, cookie, sourceUrl, 'instagram:live/info');
}

async function parseBroadcastObject(
  broadcastObj: Record<string, unknown>,
  username: string,
  cookie: string,
  sourceUrl: string,
  method: string
): Promise<LiveCheckResult | null> {
  const status = String(broadcastObj.broadcast_status || '').toLowerCase();
  if (status === 'stopped' || status === 'hard_stop') {
    return {
      status: 'NOT_LIVE',
      platform: 'INSTAGRAM',
      username,
      sourceUrl,
      checkedAt: new Date().toISOString(),
    };
  }

  const rawTitle = String(broadcastObj.broadcast_message || '').trim();
  const title = rawTitle && rawTitle !== 'null' ? rawTitle : `Instagram Live (@${username})`;

  const pickUrl = (key: string): string | null => {
    const val = typeof broadcastObj[key] === 'string' ? broadcastObj[key].trim() : '';
    return val && val !== 'null' ? val : null;
  };

  const dashAbr = pickUrl('dash_abr_playback_url');
  const dashPred = pickUrl('dash_live_predictive_playback_url');
  const dash = pickUrl('dash_playback_url');
  const hls = pickUrl('hls_playback_url');

  // Priority: DASH ABR -> DASH Predictive -> DASH -> HLS
  const chosenUrl = dashAbr || dashPred || dash || hls;
  const qualityInfo = dashAbr
    ? 'DASH-ABR'
    : dashPred
    ? 'DASH-Predictive'
    : dash
    ? 'DASH'
    : hls
    ? 'HLS'
    : undefined;

  if (chosenUrl) {
    return {
      status: 'LIVE',
      platform: 'INSTAGRAM',
      username,
      title,
      streamUrl: unescapeJsonUrl(chosenUrl),
      sourceUrl,
      qualityInfo,
      method,
      checkedAt: new Date().toISOString(),
    };
  }

  const broadcastId =
    String(broadcastObj.id || '').trim() || String(broadcastObj.broadcast_id || '').trim();
  if (broadcastId && broadcastId !== 'null' && status === 'active') {
    return fetchBroadcastInfoById(broadcastId, username, cookie, sourceUrl);
  }

  return null;
}

async function resolveUserIdFromWebPage(
  username: string,
  cookie: string,
  sourceUrl: string
): Promise<{ userId: string | null; result: LiveCheckResult | null }> {
  const url = `https://www.instagram.com/${encodeURIComponent(username)}/`;
  const headers: Record<string, string> = {
    'User-Agent': WEB_USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
  };
  const safeCookie = typeof cookie === 'string' ? cookie.trim() : '';
  if (safeCookie) headers.Cookie = safeCookie;

  let html: string | null = null;
  try {
    const resp = await fetchWithTimeout(url, { headers, timeoutMs: 8000 });
    if (resp.ok) html = resp.text;
  } catch {
    if (safeCookie) {
      return resolveUserIdFromWebPage(username, '', sourceUrl);
    }
    return { userId: null, result: null };
  }

  if (!html) return { userId: null, result: null };

  const idMatch =
    html.match(/"(?:profile_id|target_user_id)"\s*:\s*"(\d+)"/) ||
    html.match(/"user_id"\s*:\s*"(\d+)"/) ||
    html.match(/profilePage_(\d+)/);
  const foundUserId = idMatch?.[1] && idMatch[1] !== '0' ? idMatch[1] : null;

  const dashAbrMatch = html.match(/"dash_abr_playback_url"\s*:\s*"([^"]+)"/);
  const dashPredMatch = html.match(/"dash_live_predictive_playback_url"\s*:\s*"([^"]+)"/);
  const highQualityRawUrl = dashAbrMatch?.[1] || dashPredMatch?.[1];

  if (highQualityRawUrl && highQualityRawUrl !== 'null') {
    return {
      userId: foundUserId,
      result: {
        status: 'LIVE',
        platform: 'INSTAGRAM',
        username,
        title: `Instagram Live (@${username})`,
        streamUrl: unescapeJsonUrl(highQualityRawUrl),
        sourceUrl,
        qualityInfo: dashAbrMatch?.[1] ? 'DASH-ABR' : 'DASH-Predictive',
        method: 'instagram:profile-html',
        checkedAt: new Date().toISOString(),
      },
    };
  }

  return { userId: foundUserId, result: null };
}

async function checkViaWebProfileInfo(
  username: string,
  cookie: string,
  sourceUrl: string
): Promise<{ userId: string | null; result: LiveCheckResult | null }> {
  const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(
    username
  )}&_=${Date.now()}`;
  const headers: Record<string, string> = {
    'User-Agent': WEB_USER_AGENT,
    'X-IG-App-ID': IG_APP_ID,
    'X-ASBD-ID': '129477',
    'X-IG-WWW-Claim': '0',
    'X-Requested-With': 'XMLHttpRequest',
    Referer: `https://www.instagram.com/${username}/`,
    Accept: '*/*',
  };
  const safeCookie = typeof cookie === 'string' ? cookie.trim() : '';
  if (safeCookie) headers.Cookie = safeCookie;

  const resp = await fetchWithTimeout(url, { headers, timeoutMs: 8000 });
  if (!resp.ok || !resp.text) return { userId: null, result: null };

  const json = safeJsonParse<Record<string, unknown>>(resp.text);
  const userObj = (json?.data as Record<string, unknown> | undefined)?.user as
    | Record<string, unknown>
    | undefined;
  if (!userObj) return { userId: null, result: null };

  const userId = typeof userObj.id === 'string' && userObj.id.trim() ? userObj.id.trim() : null;

  const broadcastObj = userObj.broadcast as Record<string, unknown> | undefined;
  if (broadcastObj && typeof broadcastObj === 'object') {
    const liveRes = await parseBroadcastObject(
      broadcastObj,
      username,
      cookie,
      sourceUrl,
      'instagram:web_profile_info'
    );
    if (liveRes) return { userId, result: liveRes };
  }

  const broadcastId =
    typeof userObj.live_broadcast_id === 'string' &&
    userObj.live_broadcast_id.trim() &&
    userObj.live_broadcast_id !== 'null'
      ? userObj.live_broadcast_id.trim()
      : null;

  if (broadcastId) {
    const infoRes = await fetchBroadcastInfoById(broadcastId, username, cookie, sourceUrl);
    if (infoRes) return { userId, result: infoRes };
  }

  return { userId, result: null };
}

async function checkViaMobileUsernameInfo(
  username: string,
  cookie: string
): Promise<string | null> {
  const url = `https://i.instagram.com/api/v1/users/${encodeURIComponent(username)}/usernameinfo/`;
  const headers: Record<string, string> = {
    'User-Agent': MOBILE_USER_AGENT,
    'X-IG-App-ID': IG_APP_ID,
    Accept: '*/*',
  };
  const safeCookie = typeof cookie === 'string' ? cookie.trim() : '';
  if (safeCookie) headers.Cookie = safeCookie;

  const resp = await fetchWithTimeout(url, { headers, timeoutMs: 8000 });
  if (!resp.ok || !resp.text) return null;

  const json = safeJsonParse<Record<string, unknown>>(resp.text);
  const userObj = json?.user as Record<string, unknown> | undefined;
  if (!userObj) return null;

  const pk = String(userObj.pk || userObj.id || '').trim();
  return pk || null;
}

async function checkViaLiveWebInfo(
  userId: string,
  username: string,
  cookie: string,
  sourceUrl: string
): Promise<LiveCheckResult | null> {
  const url = `https://www.instagram.com/api/v1/live/web_info/?target_user_id=${encodeURIComponent(
    userId
  )}&_=${Date.now()}`;
  const headers: Record<string, string> = {
    'User-Agent': WEB_USER_AGENT,
    'X-IG-App-ID': IG_APP_ID,
    'X-ASBD-ID': '129477',
    'X-Requested-With': 'XMLHttpRequest',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    Referer: `https://www.instagram.com/${username}/live/`,
    Accept: '*/*',
  };
  const safeCookie = typeof cookie === 'string' ? cookie.trim() : '';
  if (safeCookie) headers.Cookie = safeCookie;

  const resp = await fetchWithTimeout(url, { headers, timeoutMs: 8000 });
  if (resp.status === 404 && resp.text.toLowerCase().includes('user is not live')) {
    return {
      status: 'NOT_LIVE',
      platform: 'INSTAGRAM',
      username,
      sourceUrl,
      checkedAt: new Date().toISOString(),
    };
  }
  if (!resp.ok || !resp.text) return null;

  const json = safeJsonParse<Record<string, unknown>>(resp.text);
  if (!json) return null;

  const broadcastObj =
    (json.broadcast as Record<string, unknown> | undefined) ||
    ((json.data as Record<string, unknown> | undefined)?.broadcast as
      | Record<string, unknown>
      | undefined) ||
    json;

  return parseBroadcastObject(broadcastObj, username, cookie, sourceUrl, 'instagram:live/web_info');
}

async function checkViaUserStoryFeed(
  userId: string,
  username: string,
  cookie: string,
  sourceUrl: string
): Promise<LiveCheckResult | null> {
  const url = `https://i.instagram.com/api/v1/feed/user/${encodeURIComponent(
    userId
  )}/story/?_=${Date.now()}`;
  const headers: Record<string, string> = {
    'User-Agent': MOBILE_USER_AGENT,
    'X-IG-App-ID': IG_APP_ID,
    Referer: `https://www.instagram.com/${username}/`,
    Accept: '*/*',
  };
  const safeCookie = typeof cookie === 'string' ? cookie.trim() : '';
  if (safeCookie) headers.Cookie = safeCookie;

  const resp = await fetchWithTimeout(url, { headers, timeoutMs: 8000 });
  if (!resp.ok || !resp.text) return null;

  const json = safeJsonParse<Record<string, unknown>>(resp.text);
  const broadcastObj = json?.broadcast as Record<string, unknown> | undefined;
  if (!broadcastObj) return null;

  return parseBroadcastObject(broadcastObj, username, cookie, sourceUrl, 'instagram:feed/story');
}

async function checkViaReelsMedia(
  userId: string,
  username: string,
  cookie: string,
  sourceUrl: string
): Promise<LiveCheckResult | null> {
  const url = `https://i.instagram.com/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(
    userId
  )}`;
  const headers: Record<string, string> = {
    'User-Agent': MOBILE_USER_AGENT,
    'X-IG-App-ID': IG_APP_ID,
    Accept: '*/*',
  };
  const safeCookie = typeof cookie === 'string' ? cookie.trim() : '';
  if (safeCookie) headers.Cookie = safeCookie;

  const resp = await fetchWithTimeout(url, { headers, timeoutMs: 8000 });
  if (!resp.ok || !resp.text) return null;

  const json = safeJsonParse<Record<string, unknown>>(resp.text);
  const reels = json?.reels as Record<string, unknown> | undefined;
  const userReel = reels?.[userId] as Record<string, unknown> | undefined;
  const broadcastObj =
    (userReel?.broadcast as Record<string, unknown> | undefined) ||
    (json?.broadcast as Record<string, unknown> | undefined);
  if (!broadcastObj) return null;

  return parseBroadcastObject(broadcastObj, username, cookie, sourceUrl, 'instagram:reels_media');
}

async function checkViaLiveWebPage(
  username: string,
  cookie: string,
  sourceUrl: string
): Promise<LiveCheckResult | null> {
  const url = `https://www.instagram.com/${encodeURIComponent(username)}/live/`;
  const headers: Record<string, string> = {
    'User-Agent': WEB_USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
  };
  const safeCookie = typeof cookie === 'string' ? cookie.trim() : '';
  if (safeCookie) headers.Cookie = safeCookie;

  const resp = await fetchWithTimeout(url, { headers, timeoutMs: 8000 });
  if (!resp.ok || !resp.text) return null;
  const html = resp.text;

  let foundId: string | null = null;
  const idMatch =
    html.match(/"(?:profile_id|target_user_id)"\s*:\s*"(\d+)"/) ||
    html.match(/"user_id"\s*:\s*"(\d+)"/);
  if (idMatch?.[1] && idMatch[1] !== '0') {
    foundId = idMatch[1];
    userIdCache.set(username, foundId);
  }

  const statusMatch = html.match(/"broadcast_status"\s*:\s*"([^"]+)"/);
  if (statusMatch?.[1]) {
    const st = statusMatch[1].toLowerCase();
    if (st === 'stopped' || st === 'hard_stop') {
      return {
        status: 'NOT_LIVE',
        platform: 'INSTAGRAM',
        username,
        sourceUrl,
        checkedAt: new Date().toISOString(),
      };
    }
  }

  const dashAbrMatch = html.match(/"dash_abr_playback_url"\s*:\s*"([^"]+)"/);
  const dashPredMatch = html.match(/"dash_live_predictive_playback_url"\s*:\s*"([^"]+)"/);
  const dashMatch = html.match(/"dash_playback_url"\s*:\s*"([^"]+)"/);
  const hlsMatch = html.match(/"hls_playback_url"\s*:\s*"([^"]+)"/);

  const highQualityUrl = dashAbrMatch?.[1] || dashPredMatch?.[1];
  if (highQualityUrl && highQualityUrl !== 'null') {
    return {
      status: 'LIVE',
      platform: 'INSTAGRAM',
      username,
      title: `Instagram Live - @${username}`,
      streamUrl: unescapeJsonUrl(highQualityUrl),
      sourceUrl,
      qualityInfo: dashAbrMatch?.[1] ? 'DASH-ABR' : 'DASH-Predictive',
      method: 'instagram:live-html',
      checkedAt: new Date().toISOString(),
    };
  }

  if (foundId) {
    const infoRes = await checkViaLiveWebInfo(foundId, username, cookie, sourceUrl);
    if (infoRes) return infoRes;
  }

  const fallbackRawUrl = dashMatch?.[1] || hlsMatch?.[1];
  if (fallbackRawUrl && fallbackRawUrl !== 'null') {
    return {
      status: 'LIVE',
      platform: 'INSTAGRAM',
      username,
      title: `Instagram Live - @${username}`,
      streamUrl: unescapeJsonUrl(fallbackRawUrl),
      sourceUrl,
      qualityInfo: dashMatch?.[1] ? 'DASH' : 'HLS',
      method: 'instagram:live-html-fallback',
      checkedAt: new Date().toISOString(),
    };
  }

  const bcastMatch = html.match(/"broadcast_id"\s*:\s*"?(\d+)"?/);
  if (bcastMatch?.[1]) {
    return fetchBroadcastInfoById(bcastMatch[1], username, cookie, sourceUrl);
  }

  return null;
}

export async function checkInstagramLive(
  usernameOrUrl: string,
  instagramCookie = ''
): Promise<LiveCheckResult> {
  const username = extractInstagramUsername(usernameOrUrl);
  if (!username) {
    return {
      status: 'ERROR',
      platform: 'INSTAGRAM',
      username: usernameOrUrl,
      sourceUrl: 'https://www.instagram.com',
      message: `Tên người dùng Instagram không hợp lệ: ${usernameOrUrl}`,
      checkedAt: new Date().toISOString(),
    };
  }

  const sourceUrl = `https://www.instagram.com/${username}/live/`;
  const formattedCookie = formatInstagramCookie(instagramCookie);
  let userId = userIdCache.get(username) || null;

  // 1. Resolve userId from Profile HTML (avoids HTTP 429 on web_profile_info)
  if (!userId) {
    try {
      const htmlProfile = await resolveUserIdFromWebPage(username, formattedCookie, sourceUrl);
      if (htmlProfile.userId) {
        userId = htmlProfile.userId;
        userIdCache.set(username, userId);
      }
      if (htmlProfile.result) return htmlProfile.result;
    } catch {
      // continue to fallbacks
    }
  }

  // 2. Web Profile Info API
  if (!userId) {
    try {
      const profileRes = await checkViaWebProfileInfo(username, formattedCookie, sourceUrl);
      if (profileRes.userId) {
        userId = profileRes.userId;
        userIdCache.set(username, userId);
      }
      if (profileRes.result) return profileRes.result;
    } catch {
      // continue
    }
  }

  // 3. Mobile usernameinfo API
  if (!userId) {
    try {
      const mobileUserId = await checkViaMobileUsernameInfo(username, formattedCookie);
      if (mobileUserId) {
        userId = mobileUserId;
        userIdCache.set(username, userId);
      }
    } catch {
      // continue
    }
  }

  // 4. Direct live status endpoints using userId
  if (userId) {
    try {
      const webLiveInfo = await checkViaLiveWebInfo(userId, username, formattedCookie, sourceUrl);
      if (webLiveInfo) return webLiveInfo;
    } catch {
      // continue
    }

    try {
      const storyRes = await checkViaUserStoryFeed(userId, username, formattedCookie, sourceUrl);
      if (storyRes) return storyRes;
    } catch {
      // continue
    }

    try {
      const reelsRes = await checkViaReelsMedia(userId, username, formattedCookie, sourceUrl);
      if (reelsRes) return reelsRes;
    } catch {
      // continue
    }
  }

  // 5. Final fallback: https://www.instagram.com/{username}/live/
  try {
    const webPageRes = await checkViaLiveWebPage(username, formattedCookie, sourceUrl);
    if (webPageRes) return webPageRes;
  } catch {
    // ignore
  }

  return {
    status: 'NOT_LIVE',
    platform: 'INSTAGRAM',
    username,
    sourceUrl,
    checkedAt: new Date().toISOString(),
  };
}
