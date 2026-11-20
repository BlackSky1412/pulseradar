import { fetchWithTimeout } from './httpClient';
import type { LiveCheckResult } from './types';

const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MOBILE_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

function unescapeUrl(url: string): string {
  return url
    .replace(/\\u0025/gi, '%')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u002F/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .trim();
}

function unescapeJsonString(str: string): string {
  return str
    .replace(/\\u003C/gi, '<')
    .replace(/\\u003E/gi, '>')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u002F/gi, '/')
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\\//g, '/');
}

export function extractFacebookUsername(input: string): string {
  let trimmed = input.trim();
  if (trimmed.startsWith('@')) trimmed = trimmed.slice(1);

  if (
    trimmed.includes('facebook.com') ||
    trimmed.includes('fb.com') ||
    trimmed.includes('fb.watch')
  ) {
    // Case 1: profile.php?id=100064789123456
    const idMatch = trimmed.match(/profile\.php\?id=([0-9]+)/);
    if (idMatch?.[1]) return idMatch[1];

    // Case 2: watch/live/?v=123456 or /videos/123456
    const videoMatch = trimmed.match(/[?&]v=([0-9]+)/);
    if (videoMatch?.[1]) return `video_${videoMatch[1]}`;

    const videosPathMatch = trimmed.match(/\/videos\/([0-9]+)/);
    if (videosPathMatch?.[1]) return `video_${videosPathMatch[1]}`;

    // Case 3: /username/live/ or /username/live_videos/
    const livePathMatch = trimmed.match(/facebook\.com\/([^/?#]+)\/(?:live|live_videos)/);
    if (livePathMatch?.[1]) {
      const candidate = livePathMatch[1];
      if (!['watch', 'share', 'profile.php', 'story.php'].includes(candidate)) {
        return candidate;
      }
    }

    // Case 4: /username
    const standardMatch = trimmed.match(/(?:facebook\.com|fb\.com)\/([^/?#]+)/);
    if (standardMatch?.[1]) {
      const candidate = standardMatch[1];
      if (!['watch', 'share', 'profile.php', 'story.php', 'live'].includes(candidate)) {
        return candidate;
      }
    }
  }

  const cleanCandidate = trimmed.split(/[/?#]/)[0]?.trim() || '';
  return cleanCandidate || trimmed;
}

export function extractFacebookStreamFromHtml(
  html: string
): { streamUrl: string; qualityInfo: string } | null {
  const hasLiveSignal =
    html.includes('"is_live_streaming":true') ||
    html.includes('"broadcast_status":"LIVE"') ||
    html.includes('"stream_status":"LIVE"') ||
    html.includes('"is_live":true') ||
    html.includes('live_broadcast_id') ||
    html.includes('dash_playback_url') ||
    html.includes('dash_abr_playback_url') ||
    html.includes('hls_playback_url');

  if (!hasLiveSignal) return null;

  const patterns: Array<{ regex: RegExp; quality: string }> = [
    { regex: /"dash_abr_playback_url"\s*:\s*"([^"]+)"/, quality: 'DASH-ABR (.mpd)' },
    { regex: /"dash_playback_url"\s*:\s*"([^"]+)"/, quality: 'DASH (.mpd)' },
    { regex: /"hls_playback_url"\s*:\s*"([^"]+)"/, quality: 'HLS (.m3u8)' },
    { regex: /"playable_url_quality_hd"\s*:\s*"([^"]+)"/, quality: 'Progressive HD' },
    { regex: /"playable_url"\s*:\s*"([^"]+)"/, quality: 'Progressive SD' },
  ];

  for (const { regex, quality } of patterns) {
    const match = html.match(regex);
    if (match?.[1]) {
      const clean = unescapeUrl(match[1]);
      if (clean && clean.startsWith('http')) {
        return { streamUrl: clean, qualityInfo: quality };
      }
    }
  }

  // Priority 6: Embedded DASH manifest XML
  const dashManifestMatch = html.match(/"dash_manifest"\s*:\s*"([^"]+)"/);
  if (dashManifestMatch?.[1]) {
    const unescapedXml = unescapeJsonString(dashManifestMatch[1]);
    if (unescapedXml.includes('<MPD') && unescapedXml.includes('</MPD>')) {
      const baseUrlMatch = unescapedXml.match(/<BaseURL>([^<]+)<\/BaseURL>/);
      const streamUrl = baseUrlMatch?.[1]
        ? unescapeUrl(baseUrlMatch[1])
        : `data:application/dash+xml;charset=utf-8,${encodeURIComponent(unescapedXml.slice(0, 1200))}`;
      return { streamUrl, qualityInfo: 'Embedded DASH MPD' };
    }
  }

  return null;
}

function extractTitleFromHtml(html: string): string | null {
  const ogMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
  if (ogMatch?.[1]) {
    const raw = ogMatch[1]
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .trim();
    if (raw && raw.toLowerCase() !== 'facebook') return raw;
  }

  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  if (titleMatch?.[1]) {
    const raw = titleMatch[1]
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .trim();
    if (raw && raw.toLowerCase() !== 'facebook') {
      return raw.replace(/\s*\|\s*Facebook$/i, '').trim();
    }
  }

  return null;
}

async function queryFacebookPage(
  url: string,
  cookie: string,
  isMobile: boolean,
  username: string,
  method: string
): Promise<LiveCheckResult> {
  const headers: Record<string, string> = {
    'User-Agent': isMobile ? MOBILE_USER_AGENT : DESKTOP_USER_AGENT,
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

  const resp = await fetchWithTimeout(url, { headers, timeoutMs: 10000 });
  if (!resp.text) {
    return {
      status: 'NOT_LIVE',
      platform: 'FACEBOOK',
      username,
      sourceUrl: url,
      checkedAt: new Date().toISOString(),
    };
  }

  const extracted = extractFacebookStreamFromHtml(resp.text);
  if (extracted) {
    const title = extractTitleFromHtml(resp.text) || `Facebook Live (@${username})`;
    return {
      status: 'LIVE',
      platform: 'FACEBOOK',
      username,
      title,
      streamUrl: extracted.streamUrl,
      sourceUrl: resp.url || url,
      qualityInfo: extracted.qualityInfo,
      method,
      checkedAt: new Date().toISOString(),
    };
  }

  return {
    status: 'NOT_LIVE',
    platform: 'FACEBOOK',
    username,
    sourceUrl: url,
    checkedAt: new Date().toISOString(),
  };
}

async function checkDirectUrl(
  rawUrl: string,
  cookie: string,
  username: string
): Promise<LiveCheckResult | null> {
  try {
    let resolvedUrl = rawUrl;
    const headers: Record<string, string> = { 'User-Agent': DESKTOP_USER_AGENT };
    const safeCookie = typeof cookie === 'string' ? cookie.trim() : '';
    if (safeCookie) headers.Cookie = safeCookie;

    const headResp = await fetchWithTimeout(rawUrl, {
      method: 'HEAD',
      headers,
      timeoutMs: 10000,
    });
    if (headResp.url && headResp.url !== rawUrl) {
      resolvedUrl = headResp.url;
    }

    const res = await queryFacebookPage(resolvedUrl, cookie, false, username, 'facebook:direct-url');
    if (res.status === 'LIVE') return res;
  } catch {
    // ignore and fallback
  }
  return null;
}

export async function checkFacebookLive(
  usernameOrUrl: string,
  facebookCookie = ''
): Promise<LiveCheckResult> {
  const trimmedInput = usernameOrUrl.trim();
  const username = extractFacebookUsername(trimmedInput);
  if (!username) {
    return {
      status: 'ERROR',
      platform: 'FACEBOOK',
      username: usernameOrUrl,
      sourceUrl: 'https://www.facebook.com',
      message: `Tên người dùng hoặc liên kết Facebook không hợp lệ: ${usernameOrUrl}`,
      checkedAt: new Date().toISOString(),
    };
  }

  const formattedCookie = typeof facebookCookie === 'string' ? facebookCookie.trim() : '';
  const isNumericId = /^\d+$/.test(username);
  const defaultSourceUrl = trimmedInput.startsWith('http')
    ? trimmedInput
    : isNumericId
    ? `https://www.facebook.com/profile.php?id=${username}&sk=live_videos`
    : `https://www.facebook.com/${username}/live/`;

  // 0. video_ prefix
  if (trimmedInput.startsWith('video_')) {
    const videoId = trimmedInput.slice('video_'.length);
    const directRes = await checkDirectUrl(
      `https://www.facebook.com/watch/?v=${encodeURIComponent(videoId)}`,
      formattedCookie,
      username
    );
    if (directRes) return directRes;
  }

  // 1. Direct video URL / fb.watch
  if (
    trimmedInput.includes('watch') ||
    trimmedInput.includes('/videos/') ||
    trimmedInput.includes('fb.watch')
  ) {
    const directRes = await checkDirectUrl(trimmedInput, formattedCookie, username);
    if (directRes) return directRes;
  }

  // 2. Desktop live endpoint
  const desktopLiveUrl = isNumericId
    ? `https://www.facebook.com/profile.php?id=${username}&sk=live_videos`
    : `https://www.facebook.com/${encodeURIComponent(username)}/live/`;

  try {
    const desktopRes = await queryFacebookPage(
      desktopLiveUrl,
      formattedCookie,
      false,
      username,
      'facebook:desktop-live'
    );
    if (desktopRes.status === 'LIVE') return desktopRes;
  } catch {
    // fallback
  }

  // 3. Mobile live endpoint
  const mobileLiveUrl = isNumericId
    ? `https://m.facebook.com/profile.php?id=${username}`
    : `https://m.facebook.com/${encodeURIComponent(username)}/live/`;

  try {
    const mobileRes = await queryFacebookPage(
      mobileLiveUrl,
      formattedCookie,
      true,
      username,
      'facebook:mobile-live'
    );
    if (mobileRes.status === 'LIVE') return mobileRes;
  } catch {
    // fallback
  }

  // 4. Main profile page
  const mainProfileUrl = isNumericId
    ? `https://www.facebook.com/profile.php?id=${username}`
    : `https://www.facebook.com/${encodeURIComponent(username)}`;

  try {
    const profileRes = await queryFacebookPage(
      mainProfileUrl,
      formattedCookie,
      false,
      username,
      'facebook:profile-page'
    );
    if (profileRes.status === 'LIVE') return profileRes;
  } catch {
    // fallback
  }

  return {
    status: 'NOT_LIVE',
    platform: 'FACEBOOK',
    username,
    sourceUrl: defaultSourceUrl,
    checkedAt: new Date().toISOString(),
  };
}
