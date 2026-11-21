import { extractFacebookUsername } from '../../liveCheckers/facebookChecker';
import { safeJsonParse } from '../../liveCheckers/httpClient';
import type { CollectorFetchResult, WatcherEvent } from '../types';

export { extractFacebookUsername };

export const FB_DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
export const FB_MOBILE_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

export function buildFacebookNavHeaders(
  cookie: string,
  isMobile = false
): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': isMobile ? FB_MOBILE_USER_AGENT : FB_DESKTOP_USER_AGENT,
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
  };
  const trimmed = typeof cookie === 'string' ? cookie.trim() : '';
  if (trimmed) {
    headers.Cookie = trimmed;
  }
  return headers;
}

export function unescapeFacebookUrl(url: string): string {
  return url
    .replace(/\\u0025/gi, '%')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u002F/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .trim();
}

export function unescapeFacebookJson(str: string): string {
  return str
    .replace(/\\u003C/gi, '<')
    .replace(/\\u003E/gi, '>')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u002F/gi, '/')
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\\//g, '/');
}

export function isNumericFacebookId(id: string): boolean {
  return /^\d+$/.test(id.trim());
}

export function hasFacebookAuthCookie(cookie: string): boolean {
  const trimmed = typeof cookie === 'string' ? cookie.trim() : '';
  return /c_user=\d+/.test(trimmed) && /xs=[^;\s]+/.test(trimmed);
}

export function classifyFacebookHtml(
  status: number,
  finalUrl: string,
  html: string,
  usedCookie: boolean
): CollectorFetchResult<WatcherEvent> | null {
  const lowerUrl = (finalUrl || '').toLowerCase();
  const lowerHtml = (html || '').toLowerCase();

  if (status === 429 || /temporarily blocked/i.test(html)) {
    return {
      status: 'RATE_LIMITED',
      events: [],
      reason: 'Facebook tạm thời giới hạn tốc độ truy cập (HTTP 429)',
      httpStatus: status || 429,
      usedCookie,
    };
  }

  if (
    lowerUrl.includes('/checkpoint/') ||
    lowerUrl.includes('/recover/') ||
    status === 403 ||
    status === 400 ||
    /confirm your identity|account has been locked/i.test(html)
  ) {
    return {
      status: 'BLOCKED',
      events: [],
      reason: `Facebook chặn truy cập hoặc yêu cầu xác minh checkpoint (HTTP ${status})`,
      httpStatus: status || 403,
      usedCookie,
    };
  }

  if (
    status === 404 ||
    /this content isn['’]t available|this page isn['’]t available|nội dung này hiện không khả dụng/i.test(
      html
    )
  ) {
    return {
      status: 'NOT_FOUND',
      events: [],
      reason: 'Trang hoặc tài khoản Facebook không tồn tại hoặc không khả dụng',
      httpStatus: status || 404,
      usedCookie,
    };
  }

  if (
    lowerUrl.includes('/login') ||
    lowerUrl.includes('login.php') ||
    lowerUrl.includes('/?hr=1') ||
    lowerHtml.includes('id="login_form"') ||
    /you must log in to continue|log in or sign up to view|đăng nhập facebook/i.test(html)
  ) {
    return {
      status: 'AUTH_REQUIRED',
      events: [],
      reason: usedCookie
        ? 'Cookie Facebook (c_user/xs) đã hết hạn hoặc bị chuyển hướng về trang đăng nhập'
        : 'Facebook yêu cầu đăng nhập (cookie c_user + xs) để xem nội dung này',
      httpStatus: status || 401,
      usedCookie,
    };
  }

  if (status >= 500) {
    return {
      status: 'ERROR',
      events: [],
      reason: `Facebook gặp lỗi máy chủ (HTTP ${status})`,
      httpStatus: status,
      usedCookie,
    };
  }

  return null;
}

const RELEVANT_FB_JSON_KEYS = [
  'post_id',
  'story_fbid',
  'comet_sections',
  'unified_stories_buckets',
  'unified_stories',
  'story_card_id',
  'story_bucket_owner',
  'playable_url',
  'photo_image',
];

export function extractJsonScriptBlocks(html: string): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  const regex = /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    if (!RELEVANT_FB_JSON_KEYS.some((k) => raw.includes(k))) {
      continue;
    }
    const parsed = safeJsonParse<Record<string, unknown>>(raw);
    if (parsed && typeof parsed === 'object') {
      blocks.push(parsed);
    }
  }
  return blocks;
}

export function extractFacebookNumericIdFromHtml(html: string): string | null {
  const match = html.match(/"(?:userID|pageID|entity_id)"\s*:\s*"(\d{5,22})"/);
  return match?.[1] || null;
}
