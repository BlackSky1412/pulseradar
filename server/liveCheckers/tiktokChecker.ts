import { fetchWithTimeout, safeJsonParse } from './httpClient';
import type { LiveCheckResult } from './types';

const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const MOBILE_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

const PRIORITY_QUALITIES = [
  'origin',
  'ORIGIN',
  'uhd_60',
  'uhd',
  'FULL_HD1',
  'FULL_HD',
  'full_hd',
  'fhd_60',
  'fhd',
  '1080p',
  'HD1',
  'HD',
  'hd_60',
  'hd',
  '720p',
  'SD1',
  'SD',
  'sd',
  'ld',
  'auto',
];

interface QualityCandidate {
  key: string;
  flvUrl: string;
  hlsUrl: string;
  bitrate: number;
  pixels: number;
  fps: number;
  resolutionText: string;
  codec: string;
  isOrigin: boolean;
  priorityIndex: number;
}

interface ExtractedStream {
  url: string;
  qualityInfo?: string;
}

function formatTikTokCookie(cookie: string = ''): string {
  const trimmed = typeof cookie === 'string' ? cookie.trim() : '';
  if (!trimmed) return '';
  return !trimmed.includes('=') ? `sessionid=${trimmed}` : trimmed;
}

export function extractTikTokUsername(input: string): string {
  const trimmed = input.trim();
  if (trimmed.includes('tiktok.com')) {
    const atMatch = trimmed.match(/tiktok\.com\/@([a-zA-Z0-9_.]+)/);
    if (atMatch?.[1]) {
      return atMatch[1];
    }
    const match = trimmed.match(/tiktok\.com\/([a-zA-Z0-9_.]+)/);
    return match?.[1] || trimmed.replace(/^@/, '');
  }
  return trimmed.replace(/^@/, '').split(/[/?#]/)[0]?.trim() || '';
}

export function extractUrlFromStreamDataJson(streamDataJsonStr: string): ExtractedStream | null {
  const root = safeJsonParse<Record<string, unknown>>(streamDataJsonStr);
  const data = root?.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== 'object') return null;

  const candidates: QualityCandidate[] = [];

  for (const [k, rawQObj] of Object.entries(data)) {
    if (k.toLowerCase() === 'ao') continue; // Skip audio-only stream
    const qObj = rawQObj as Record<string, unknown> | undefined;
    const main = qObj?.main as Record<string, unknown> | undefined;
    if (!main || typeof main !== 'object') continue;

    const flv = typeof main.flv === 'string' ? main.flv.trim() : '';
    const hls = typeof main.hls === 'string' ? main.hls.trim() : '';
    if (!flv && !hls) continue;

    let bitrate = 0;
    let pixels = 0;
    let fps = 0;
    let resolutionText = '';
    let codec = 'h264';

    const sdkParamsStr =
      (typeof main.sdk_params === 'string' && main.sdk_params.trim()) ||
      (typeof qObj?.sdk_params === 'string' && qObj.sdk_params.trim()) ||
      '';

    if (sdkParamsStr) {
      const sdkJson = safeJsonParse<Record<string, unknown>>(sdkParamsStr);
      if (sdkJson) {
        bitrate = Number(sdkJson.vbitrate || 0) || 0;
        fps = Number(sdkJson.fps || 0) || 0;
        codec = String(sdkJson.VCodec || 'h264').trim() || 'h264';
        resolutionText = String(sdkJson.resolution || '');
        if (resolutionText.toLowerCase().includes('x')) {
          const [wStr, hStr] = resolutionText.toLowerCase().split('x');
          const w = Number.parseInt((wStr || '').trim(), 10) || 0;
          const h = Number.parseInt((hStr || '').trim(), 10) || 0;
          if (w > 0 && h > 0) {
            pixels = w * h;
          }
        }
      }
    }

    const isOrigin = k.toLowerCase() === 'origin';
    const foundIdx = PRIORITY_QUALITIES.findIndex(q => q.toLowerCase() === k.toLowerCase());
    const priorityIndex = foundIdx >= 0 ? foundIdx : 999;

    candidates.push({
      key: k,
      flvUrl: flv,
      hlsUrl: hls,
      bitrate,
      pixels,
      fps,
      resolutionText,
      codec,
      isOrigin,
      priorityIndex,
    });
  }

  // Sort: origin first -> highest pixel count -> priority list -> highest bitrate -> highest fps
  candidates.sort((a, b) => {
    if (a.isOrigin !== b.isOrigin) return a.isOrigin ? -1 : 1;
    if (a.pixels !== b.pixels) return b.pixels - a.pixels;
    if (a.priorityIndex !== b.priorityIndex) return a.priorityIndex - b.priorityIndex;
    if (a.bitrate !== b.bitrate) return b.bitrate - a.bitrate;
    return b.fps - a.fps;
  });

  for (const c of candidates) {
    const infoParts = [
      `[${c.key}]`,
      c.resolutionText || 'auto',
      c.bitrate > 0 ? `${Math.round(c.bitrate / 1000)}kbps` : null,
      c.fps > 0 ? `${c.fps}fps` : null,
      c.codec,
    ].filter(Boolean);
    const qualityInfo = infoParts.join(' · ');

    if (c.flvUrl) {
      return { url: c.flvUrl, qualityInfo: `FLV ${qualityInfo}` };
    }
    if (c.hlsUrl) {
      return { url: c.hlsUrl, qualityInfo: `HLS ${qualityInfo}` };
    }
  }

  return null;
}

function extractStreamUrlFromData(data: Record<string, unknown>): ExtractedStream | null {
  const streamUrlObj = data.stream_url as Record<string, unknown> | undefined;
  if (!streamUrlObj || typeof streamUrlObj !== 'object') return null;

  // 1. Highest priority: live_core_sdk_data.pull_data.stream_data or pull_data.stream_data
  const liveCoreSdk = streamUrlObj.live_core_sdk_data as Record<string, unknown> | undefined;
  const sdkPullData =
    (liveCoreSdk?.pull_data as Record<string, unknown> | undefined) ||
    (streamUrlObj.pull_data as Record<string, unknown> | undefined);
  const streamDataStr =
    typeof sdkPullData?.stream_data === 'string' ? sdkPullData.stream_data : '';

  if (streamDataStr.trim()) {
    const extracted = extractUrlFromStreamDataJson(streamDataStr);
    if (extracted) return extracted;
  }

  // 2. Fallback: flv_pull_url
  const flvPull = streamUrlObj.flv_pull_url;
  if (flvPull && typeof flvPull === 'object') {
    const flvObj = flvPull as Record<string, unknown>;
    const preferredKeys = ['ORIGIN', 'origin', 'UH1', 'FULL_HD1', 'HD1', 'HD', 'SD1', 'SD'];
    for (const key of preferredKeys) {
      const val = typeof flvObj[key] === 'string' ? flvObj[key].trim() : '';
      if (val) return { url: val, qualityInfo: `FLV [${key}]` };
    }
    for (const [key, val] of Object.entries(flvObj)) {
      if (typeof val === 'string' && val.trim()) {
        return { url: val.trim(), qualityInfo: `FLV [${key}]` };
      }
    }
  } else if (typeof flvPull === 'string' && flvPull.trim()) {
    return { url: flvPull.trim(), qualityInfo: 'FLV' };
  }

  const rtmp = typeof streamUrlObj.rtmp_pull_url === 'string' ? streamUrlObj.rtmp_pull_url.trim() : '';
  if (rtmp) return { url: rtmp, qualityInfo: 'RTMP' };

  const hls = typeof streamUrlObj.hls_pull_url === 'string' ? streamUrlObj.hls_pull_url.trim() : '';
  if (hls) return { url: hls, qualityInfo: 'HLS' };

  return null;
}

async function checkViaWebcastInfoByUser(
  username: string,
  cookie: string,
  sourceUrl: string
): Promise<LiveCheckResult | null> {
  const url = `https://webcast.tiktok.com/webcast/room/info_by_user/?aid=1988&app_language=vi-VN&browser_language=vi-VN&unique_id=${encodeURIComponent(
    username
  )}`;
  const headers: Record<string, string> = {
    'User-Agent': DESKTOP_USER_AGENT,
    Referer: `https://www.tiktok.com/@${username}/live`,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
  };
  const cookieHeader = formatTikTokCookie(cookie);
  if (cookieHeader) headers.Cookie = cookieHeader;

  const resp = await fetchWithTimeout(url, { headers, timeoutMs: 8000 });
  if (!resp.ok || !resp.text) return null;

  const json = safeJsonParse<Record<string, unknown>>(resp.text);
  const data = json?.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== 'object') return null;

  const status = Number(data.status ?? 0);
  if (status === 2) {
    const title =
      (typeof data.title === 'string' && data.title.trim()) || `TikTok Live (@${username})`;
    const extracted = extractStreamUrlFromData(data);
    if (extracted) {
      return {
        status: 'LIVE',
        platform: 'TIKTOK',
        username,
        title,
        streamUrl: extracted.url,
        sourceUrl,
        qualityInfo: extracted.qualityInfo,
        method: 'tiktok:webcast/info_by_user',
        checkedAt: new Date().toISOString(),
      };
    }
  }

  const msg = typeof data.message === 'string' ? data.message.toLowerCase() : '';
  if (msg.includes('room has finished') || status === 4) {
    return {
      status: 'NOT_LIVE',
      platform: 'TIKTOK',
      username,
      sourceUrl,
      checkedAt: new Date().toISOString(),
    };
  }

  return null;
}

async function fetchFromWebcastRoomInfo(
  roomId: string,
  username: string,
  cookie: string,
  defaultTitle: string,
  sourceUrl: string
): Promise<LiveCheckResult | null> {
  const url = `https://webcast.tiktok.com/webcast/room/info/?aid=1988&room_id=${encodeURIComponent(
    roomId
  )}&app_language=vi-VN&browser_language=vi-VN`;
  const headers: Record<string, string> = {
    'User-Agent': DESKTOP_USER_AGENT,
    Referer: `https://www.tiktok.com/@${username}/live`,
    Accept: 'application/json, text/plain, */*',
  };
  const cookieHeader = formatTikTokCookie(cookie);
  if (cookieHeader) headers.Cookie = cookieHeader;

  const resp = await fetchWithTimeout(url, { headers, timeoutMs: 8000 });
  const json = safeJsonParse<Record<string, unknown>>(resp.text);
  if (!json) return null;

  const statusCode = Number(json.status_code ?? -1);
  if (statusCode === 4003110) {
    return {
      status: 'ERROR',
      platform: 'TIKTOK',
      username,
      sourceUrl,
      message: `Phòng Live (ID: ${roomId}) bị giới hạn (18+/WAF - mã 4003110). Vui lòng cấu hình TikTok Cookie / Session ID trong mục Cài đặt Cookie.`,
      checkedAt: new Date().toISOString(),
    };
  }

  const data = json.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== 'object') return null;

  const title =
    (typeof data.title === 'string' && data.title.trim()) || defaultTitle || 'TikTok Live Stream';
  const extracted = extractStreamUrlFromData(data);
  if (extracted) {
    return {
      status: 'LIVE',
      platform: 'TIKTOK',
      username,
      title,
      streamUrl: extracted.url,
      sourceUrl,
      qualityInfo: extracted.qualityInfo,
      method: 'tiktok:webcast/room/info',
      checkedAt: new Date().toISOString(),
    };
  }

  return null;
}

async function checkViaApiLive(
  username: string,
  cookie: string,
  sourceUrl: string,
  isMobile = false
): Promise<LiveCheckResult | null> {
  const now = Date.now();
  const url = `https://www.tiktok.com/api-live/user/room/?aid=1988&sourceType=54&uniqueId=${encodeURIComponent(
    username
  )}&_=${now}`;

  const headers: Record<string, string> = {
    'User-Agent': isMobile ? MOBILE_USER_AGENT : DESKTOP_USER_AGENT,
    Referer: `https://www.tiktok.com/@${username}/live`,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
  };
  const cookieHeader = formatTikTokCookie(cookie);
  if (cookieHeader) headers.Cookie = cookieHeader;

  const resp = await fetchWithTimeout(url, { headers, timeoutMs: 8000 });
  if (!resp.ok || !resp.text) return null;

  const json = safeJsonParse<Record<string, unknown>>(resp.text);
  const data = json?.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== 'object') return null;

  const userObj = data.user as Record<string, unknown> | undefined;
  const liveRoom = data.liveRoom as Record<string, unknown> | undefined;

  const userStatus = Number(userObj?.status ?? 0);
  const roomStatus = Number(liveRoom?.status ?? 0);

  // 2 = LIVE
  const isLive = userStatus === 2 || roomStatus === 2;
  if (!isLive) {
    return {
      status: 'NOT_LIVE',
      platform: 'TIKTOK',
      username,
      sourceUrl,
      checkedAt: new Date().toISOString(),
    };
  }

  const title =
    (typeof liveRoom?.title === 'string' && liveRoom.title.trim()) || `TikTok Live (@${username})`;

  const streamDataStr = (
    (liveRoom?.streamData as Record<string, unknown> | undefined)?.pull_data as
      | Record<string, unknown>
      | undefined
  )?.stream_data;

  if (typeof streamDataStr === 'string' && streamDataStr.trim()) {
    const extracted = extractUrlFromStreamDataJson(streamDataStr);
    if (extracted) {
      return {
        status: 'LIVE',
        platform: 'TIKTOK',
        username,
        title,
        streamUrl: extracted.url,
        sourceUrl,
        qualityInfo: extracted.qualityInfo,
        method: isMobile ? 'tiktok:api-live(mobile)' : 'tiktok:api-live(desktop)',
        checkedAt: new Date().toISOString(),
      };
    }
  }

  const hevcStr = (
    (liveRoom?.hevcStreamData as Record<string, unknown> | undefined)?.pull_data as
      | Record<string, unknown>
      | undefined
  )?.stream_data;

  if (typeof hevcStr === 'string' && hevcStr.trim()) {
    const extracted = extractUrlFromStreamDataJson(hevcStr);
    if (extracted) {
      return {
        status: 'LIVE',
        platform: 'TIKTOK',
        username,
        title,
        streamUrl: extracted.url,
        sourceUrl,
        qualityInfo: extracted.qualityInfo,
        method: isMobile ? 'tiktok:api-live-hevc(mobile)' : 'tiktok:api-live-hevc(desktop)',
        checkedAt: new Date().toISOString(),
      };
    }
  }

  const roomId =
    (typeof userObj?.roomId === 'string' && userObj.roomId.trim()) ||
    (typeof liveRoom?.streamId === 'string' && liveRoom.streamId.trim()) ||
    '';

  if (roomId) {
    const webcastResult = await fetchFromWebcastRoomInfo(roomId, username, cookie, title, sourceUrl);
    if (webcastResult) return webcastResult;
  }

  return {
    status: 'ERROR',
    platform: 'TIKTOK',
    username,
    sourceUrl,
    message: `Phát hiện @${username} đang Live nhưng chưa phân giải được stream URL (Room ID: ${roomId || 'N/A'})`,
    checkedAt: new Date().toISOString(),
  };
}

async function checkViaWebpage(
  username: string,
  cookie: string,
  sourceUrl: string
): Promise<LiveCheckResult | null> {
  const url = `https://www.tiktok.com/@${username}/live`;
  const headers: Record<string, string> = {
    'User-Agent': DESKTOP_USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
  };
  const cookieHeader = formatTikTokCookie(cookie);
  if (cookieHeader) headers.Cookie = cookieHeader;

  const resp = await fetchWithTimeout(url, { headers, timeoutMs: 8000 });
  if (!resp.ok || !resp.text) return null;

  const sigiMatch = resp.text.match(/<script[^>]*id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/);
  if (!sigiMatch?.[1]) return null;

  const json = safeJsonParse<Record<string, unknown>>(sigiMatch[1]);
  const liveRoom = json?.LiveRoom as Record<string, unknown> | undefined;
  const userInfo = liveRoom?.liveRoomUserInfo as Record<string, unknown> | undefined;
  const user = userInfo?.user as Record<string, unknown> | undefined;
  const room = userInfo?.liveRoom as Record<string, unknown> | undefined;

  const status = Number(room?.status ?? user?.status ?? 0);
  if (status !== 2) {
    return {
      status: 'NOT_LIVE',
      platform: 'TIKTOK',
      username,
      sourceUrl,
      checkedAt: new Date().toISOString(),
    };
  }

  const title =
    (typeof room?.title === 'string' && room.title.trim()) || `TikTok Live (@${username})`;

  const streamDataStr = (
    (room?.streamData as Record<string, unknown> | undefined)?.pull_data as
      | Record<string, unknown>
      | undefined
  )?.stream_data;

  if (typeof streamDataStr === 'string' && streamDataStr.trim()) {
    const extracted = extractUrlFromStreamDataJson(streamDataStr);
    if (extracted) {
      return {
        status: 'LIVE',
        platform: 'TIKTOK',
        username,
        title,
        streamUrl: extracted.url,
        sourceUrl,
        qualityInfo: extracted.qualityInfo,
        method: 'tiktok:sigi-state',
        checkedAt: new Date().toISOString(),
      };
    }
  }

  const hevcStr = (
    (room?.hevcStreamData as Record<string, unknown> | undefined)?.pull_data as
      | Record<string, unknown>
      | undefined
  )?.stream_data;

  if (typeof hevcStr === 'string' && hevcStr.trim()) {
    const extracted = extractUrlFromStreamDataJson(hevcStr);
    if (extracted) {
      return {
        status: 'LIVE',
        platform: 'TIKTOK',
        username,
        title,
        streamUrl: extracted.url,
        sourceUrl,
        qualityInfo: extracted.qualityInfo,
        method: 'tiktok:sigi-state-hevc',
        checkedAt: new Date().toISOString(),
      };
    }
  }

  const roomId = typeof user?.roomId === 'string' ? user.roomId.trim() : '';
  if (roomId) {
    const webcastResult = await fetchFromWebcastRoomInfo(roomId, username, cookie, title, sourceUrl);
    if (webcastResult) return webcastResult;
  }

  return null;
}

export async function checkTikTokLive(
  usernameOrUrl: string,
  cookie = ''
): Promise<LiveCheckResult> {
  let resolvedInput = usernameOrUrl.trim();

  // Resolve shortlinks (vt.tiktok.com / vm.tiktok.com)
  if (
    (resolvedInput.startsWith('http://') || resolvedInput.startsWith('https://')) &&
    (resolvedInput.includes('vt.tiktok.com') || resolvedInput.includes('vm.tiktok.com'))
  ) {
    try {
      const headResp = await fetchWithTimeout(resolvedInput, {
        method: 'HEAD',
        headers: { 'User-Agent': DESKTOP_USER_AGENT },
        timeoutMs: 8000,
      });
      if (headResp.url && headResp.url !== resolvedInput) {
        resolvedInput = headResp.url;
      }
    } catch {
      // ignore redirect resolution error and try extracting directly
    }
  }

  const username = extractTikTokUsername(resolvedInput);
  if (!username) {
    return {
      status: 'ERROR',
      platform: 'TIKTOK',
      username: usernameOrUrl,
      sourceUrl: 'https://www.tiktok.com',
      message: `Tên người dùng TikTok không hợp lệ: ${usernameOrUrl}`,
      checkedAt: new Date().toISOString(),
    };
  }

  const sourceUrl = `https://www.tiktok.com/@${username}/live`;
  const safeCookie = formatTikTokCookie(cookie);

  // 1. Webcast info_by_user (Unblocked on datacenter/cloud IPs, e.g. Render AWS Singapore)
  try {
    const webcastRes = await checkViaWebcastInfoByUser(username, safeCookie, sourceUrl);
    if (webcastRes) return webcastRes;
  } catch {
    // fallback
  }

  // 2. Official api-live/user/room (Desktop UA)
  try {
    const desktopRes = await checkViaApiLive(username, safeCookie, sourceUrl, false);
    if (desktopRes) return desktopRes;
  } catch {
    // fallback
  }

  // 2. Fallback 1: Mobile UA (bypass Desktop WAF)
  try {
    const mobileRes = await checkViaApiLive(username, safeCookie, sourceUrl, true);
    if (mobileRes) return mobileRes;
  } catch {
    // fallback
  }

  // 3. Fallback 2: Webpage HTML (SIGI_STATE)
  try {
    const webRes = await checkViaWebpage(username, safeCookie, sourceUrl);
    if (webRes) return webRes;
  } catch {
    // fallback
  }

  return {
    status: 'NOT_LIVE',
    platform: 'TIKTOK',
    username,
    sourceUrl,
    checkedAt: new Date().toISOString(),
  };
}
