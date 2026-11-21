import { detectLivePlatform, extractLiveUsername } from '../../liveCheckers/index';
import type {
  CollectorFetchResult,
  CollectorStatus,
  LivePlatform,
  PlatformCollector,
  TikTokEvent,
  WatcherEvent,
  WatcherEventType,
} from '../types';

export type {
  CollectorFetchResult,
  CollectorStatus,
  LivePlatform,
  PlatformCollector,
  TikTokEvent,
  WatcherEvent,
  WatcherEventType,
};

export interface BaseCollector<TEvent = WatcherEvent> extends PlatformCollector<TEvent> {}

export function normalizeCookieValue(cookie?: string): string {
  return typeof cookie === 'string' ? cookie.trim() : '';
}

const TIKTOK_RESERVED_ROUTES = new Set([
  'explore',
  'following',
  'foryou',
  'live',
  'upload',
  'login',
  'signup',
  'search',
  'discover',
  'messages',
  'tag',
  'music',
  'business',
  'about',
  'friends',
]);

const IG_RESERVED_ROUTES = new Set([
  'p',
  'reel',
  'reels',
  'tv',
  'explore',
  'stories',
  'accounts',
  'about',
  'legal',
  'developer',
  'directory',
  'direct',
  'api',
  'static',
  'live',
]);

const FB_RESERVED_ROUTES = new Set([
  'watch',
  'share',
  'profile.php',
  'story.php',
  'live',
  'groups',
  'events',
  'marketplace',
  'gaming',
  'pages',
  'login',
  'help',
  'policies',
  'settings',
  'ads',
  'reel',
  'reels',
  'videos',
  'photo.php',
  'permalink.php',
  'recover',
  'privacy',
  'stories',
  'people',
]);

const X_RESERVED_ROUTES = new Set([
  'i',
  'explore',
  'home',
  'search',
  'settings',
  'notifications',
  'messages',
  'bookmarks',
  'compose',
  'login',
  'signup',
  'tos',
  'privacy',
  'intent',
]);

export function normalizeUsername(
  input: string,
  platform?: LivePlatform,
  options?: { allowVideoId?: boolean }
): string {
  const trimmed = typeof input === 'string' ? input.trim() : '';
  if (!trimmed) return '';

  const resolvedPlatform = platform ?? detectLivePlatform(trimmed, 'TIKTOK');

  // Handle facebook.com/people/<Name>/<numericId> and /stories/<id>/... before generic extraction
  if (resolvedPlatform === 'FACEBOOK' && /facebook\.com/i.test(trimmed)) {
    const peopleId = trimmed.match(/facebook\.com\/people\/[^/]+\/(\d+)/i);
    if (peopleId?.[1]) return peopleId[1];
    const storiesId = trimmed.match(/facebook\.com\/stories\/([^/?#]+)/i);
    if (storiesId?.[1]) {
      const candidate = storiesId[1].replace(/^@+/, '').trim();
      return candidate && !FB_RESERVED_ROUTES.has(candidate.toLowerCase()) ? candidate : '';
    }
  }

  // Handle instagram.com/stories/<username>/... and instagram.com/@<username>/... before generic extraction
  if (
    resolvedPlatform === 'INSTAGRAM' &&
    (/(?:instagram\.com|instagr\.am)/i.test(trimmed))
  ) {
    const storyUser = trimmed.match(/(?:instagram\.com|instagr\.am)\/stories\/@?([a-zA-Z0-9_.]+)/i);
    if (storyUser?.[1]) {
      const candidate = storyUser[1];
      if (candidate.toLowerCase() === 'highlights' || IG_RESERVED_ROUTES.has(candidate.toLowerCase())) {
        return '';
      }
      return candidate;
    }
    const atUser = trimmed.match(/(?:instagram\.com|instagr\.am)\/@([a-zA-Z0-9_.]+)/i);
    if (atUser?.[1]) {
      return IG_RESERVED_ROUTES.has(atUser[1].toLowerCase()) ? '' : atUser[1];
    }
  }

  const rawExtracted = extractLiveUsername(trimmed, resolvedPlatform).trim();
  const extracted = rawExtracted.replace(/^@+/, '').trim();

  // Guard against reserved URL paths (e.g. instagram.com/p/xyz or x.com/i/flow/login)
  // falling back to 'http:' / 'https:' or hostname in legacy extractors
  if (!extracted || /^https?:?$/i.test(extracted)) {
    return '';
  }

  if (
    /^(?:www\.|m\.)?(?:tiktok\.com|instagram\.com|instagr\.am|facebook\.com|fb\.com|fb\.watch|x\.com|twitter\.com)$/i.test(
      extracted
    )
  ) {
    return '';
  }

  if (
    resolvedPlatform === 'FACEBOOK' &&
    !options?.allowVideoId &&
    /^video_\d+$/i.test(extracted)
  ) {
    return '';
  }

  const lower = extracted.toLowerCase();
  if (
    (resolvedPlatform === 'INSTAGRAM' && IG_RESERVED_ROUTES.has(lower)) ||
    (resolvedPlatform === 'FACEBOOK' && FB_RESERVED_ROUTES.has(lower)) ||
    (resolvedPlatform === 'X' && X_RESERVED_ROUTES.has(lower)) ||
    (resolvedPlatform === 'TIKTOK' && TIKTOK_RESERVED_ROUTES.has(lower))
  ) {
    return '';
  }

  return extracted;
}

export class CollectorDiagnosticError extends Error {
  readonly status: CollectorStatus;
  readonly httpStatus?: number;
  readonly usedCookie: boolean;

  constructor(
    message: string,
    status: CollectorStatus = 'ERROR',
    options?: { httpStatus?: number; usedCookie?: boolean }
  ) {
    super(message);
    this.name = 'CollectorDiagnosticError';
    this.status = status;
    this.httpStatus = options?.httpStatus;
    this.usedCookie = Boolean(options?.usedCookie);
  }
}

export function classifyHttpDiagnostic(
  httpStatus: number,
  body: string = '',
  usedCookie = false,
  platformLabel = 'Platform'
): { status: CollectorStatus; reason: string } {
  const lower = body.toLowerCase();
  if (httpStatus === 404) {
    return { status: 'NOT_FOUND', reason: `${platformLabel} account not found (HTTP 404)` };
  }
  if (httpStatus === 401) {
    return {
      status: 'AUTH_REQUIRED',
      reason: `${platformLabel} requires login/cookie (HTTP 401)${usedCookie ? ' — configured cookie may be expired' : ''}`,
    };
  }
  if (httpStatus === 429) {
    return { status: 'RATE_LIMITED', reason: `${platformLabel} rate-limited requests (HTTP 429)` };
  }
  if (httpStatus === 403) {
    if (
      lower.includes('require_login') ||
      lower.includes('login') ||
      lower.includes('checkpoint')
    ) {
      return {
        status: 'AUTH_REQUIRED',
        reason: `${platformLabel} login/checkpoint required (HTTP 403)`,
      };
    }
    return { status: 'BLOCKED', reason: `${platformLabel} blocked request (HTTP 403)` };
  }
  return { status: 'ERROR', reason: `${platformLabel} HTTP ${httpStatus}` };
}

export function unwrapDiagnosticResult<TEvent = WatcherEvent>(
  result: CollectorFetchResult<TEvent>
): TEvent[] {
  if (
    result.status === 'OK' ||
    result.status === 'NOT_FOUND' ||
    result.status === 'UNSUPPORTED'
  ) {
    return result.events;
  }
  throw new CollectorDiagnosticError(
    result.reason || `Collector failed with status ${result.status}`,
    result.status,
    { httpStatus: result.httpStatus, usedCookie: result.usedCookie }
  );
}
