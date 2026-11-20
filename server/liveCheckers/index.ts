import { delay } from './httpClient';
import { checkTikTokLive, extractTikTokUsername } from './tiktokChecker';
import { checkInstagramLive, extractInstagramUsername } from './instagramChecker';
import { checkFacebookLive, extractFacebookUsername } from './facebookChecker';
import { checkXLive, extractXUsername } from './xChecker';
import type { LiveCheckResult, LivePlatform, PlatformCookies } from './types';

export * from './types';
export { extractTikTokUsername, extractUrlFromStreamDataJson } from './tiktokChecker';
export { extractInstagramUsername, formatInstagramCookie } from './instagramChecker';
export { extractFacebookUsername, extractFacebookStreamFromHtml } from './facebookChecker';
export { extractXUsername, extractXBroadcastIdsFromHtml } from './xChecker';

/**
 * Detects the real live streaming platform from a target URL/username, source domain, or fallback hint.
 */
export function detectLivePlatform(
  input: string,
  defaultPlatform: string = 'TIKTOK',
  sourceDomain = ''
): LivePlatform {
  const combined = `${input.trim().toLowerCase()} ${sourceDomain.trim().toLowerCase()}`;
  const normalizedDefault = defaultPlatform.trim().toUpperCase();

  if (combined.includes('instagram.com') || combined.includes('instagr.am')) return 'INSTAGRAM';
  if (
    combined.includes('facebook.com') ||
    combined.includes('fb.com') ||
    combined.includes('fb.watch')
  ) {
    return 'FACEBOOK';
  }
  if (
    combined.includes('twitter.com') ||
    combined.includes('x.com') ||
    combined.includes('t.co') ||
    input.trim().startsWith('broadcast_')
  ) {
    return 'X';
  }
  if (combined.includes('tiktok.com')) return 'TIKTOK';

  // Map PulseRadar internal platform keys if passed directly
  if (normalizedDefault === 'INSTAGRAM' || normalizedDefault === 'HACKERNEWS') return 'INSTAGRAM';
  if (normalizedDefault === 'FACEBOOK' || normalizedDefault === 'GITHUB') return 'FACEBOOK';
  if (normalizedDefault === 'X' || normalizedDefault === 'TWITTER' || normalizedDefault === 'BLUESKY') {
    return 'X';
  }
  return 'TIKTOK';
}

export function extractLiveUsername(
  input: string,
  platform: LivePlatform = 'TIKTOK'
): string {
  const resolved = detectLivePlatform(input, platform);
  switch (resolved) {
    case 'INSTAGRAM':
      return extractInstagramUsername(input);
    case 'FACEBOOK':
      return extractFacebookUsername(input);
    case 'X':
      return extractXUsername(input);
    case 'TIKTOK':
    default:
      return extractTikTokUsername(input);
  }
}

function normalizeCookie(val: unknown): string {
  return typeof val === 'string' ? val.trim() : '';
}

export async function checkUserLive(
  usernameOrUrl: string,
  options: {
    platform?: string;
    sourceDomain?: string;
    cookies?: PlatformCookies;
  } = {}
): Promise<LiveCheckResult> {
  const resolvedPlatform = detectLivePlatform(
    usernameOrUrl,
    options.platform || 'TIKTOK',
    options.sourceDomain || ''
  );
  const cookies = (
    options?.cookies && typeof options.cookies === 'object' ? options.cookies : {}
  ) as PlatformCookies;

  switch (resolvedPlatform) {
    case 'INSTAGRAM':
      return checkInstagramLive(
        usernameOrUrl,
        normalizeCookie(cookies.instagram) || normalizeCookie(process.env.INSTAGRAM_COOKIE)
      );
    case 'FACEBOOK':
      return checkFacebookLive(
        usernameOrUrl,
        normalizeCookie(cookies.facebook) || normalizeCookie(process.env.FACEBOOK_COOKIE)
      );
    case 'X':
      return checkXLive(
        usernameOrUrl,
        normalizeCookie(cookies.x) || normalizeCookie(process.env.X_COOKIE)
      );
    case 'TIKTOK':
    default:
      return checkTikTokLive(
        usernameOrUrl,
        normalizeCookie(cookies.tiktok) || normalizeCookie(process.env.TIKTOK_COOKIE)
      );
  }
}

export interface BatchLiveTarget {
  target: string;
  platform?: string;
  sourceDomain?: string;
  ruleId?: string;
}

export interface BatchLiveCheckItem {
  target: string;
  ruleId?: string;
  result: LiveCheckResult;
}

/**
 * Checks multiple users concurrently with a 250ms stagger (ported from StreamMonitorService.kt)
 * to avoid TikTok / Instagram WAF HTTP 429 throttling.
 */
export async function checkBatchLive(
  targets: BatchLiveTarget[],
  cookies: PlatformCookies = {},
  staggerMs = 250
): Promise<BatchLiveCheckItem[]> {
  return Promise.all(
    targets.map(async (item, index) => {
      if (index > 0 && staggerMs > 0) {
        await delay(index * staggerMs);
      }
      const result = await checkUserLive(item.target, {
        platform: item.platform,
        sourceDomain: item.sourceDomain,
        cookies,
      });
      return {
        target: item.target,
        ruleId: item.ruleId,
        result,
      };
    })
  );
}
