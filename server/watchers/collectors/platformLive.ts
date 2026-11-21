import { checkFacebookLive } from '../../liveCheckers/facebookChecker';
import { checkInstagramLive } from '../../liveCheckers/instagramChecker';
import { checkTikTokLive } from '../../liveCheckers/tiktokChecker';
import { checkXLive } from '../../liveCheckers/xChecker';
import type { LiveCheckResult, LiveCheckSuccess, LivePlatform } from '../../liveCheckers/types';
import {
  classifyHttpDiagnostic,
  normalizeCookieValue,
  normalizeUsername,
  unwrapDiagnosticResult,
  type CollectorFetchResult,
  type PlatformCollector,
  type WatcherEvent,
  type WatcherEventType,
} from './base';
import { extractRoomIdFromStream } from './tiktokLive';

export type LiveCheckerFn = (username: string, cookie?: string) => Promise<LiveCheckResult>;

export interface PlatformLiveCollectorOptions {
  platform: LivePlatform;
  cookie?: string;
  checker?: LiveCheckerFn;
}

function defaultCheckerForPlatform(platform: LivePlatform): LiveCheckerFn {
  switch (platform) {
    case 'INSTAGRAM':
      return checkInstagramLive;
    case 'FACEBOOK':
      return checkFacebookLive;
    case 'X':
      return checkXLive;
    case 'TIKTOK':
    default:
      return checkTikTokLive;
  }
}

function defaultLiveUrl(platform: LivePlatform, username: string): string {
  switch (platform) {
    case 'INSTAGRAM':
      return `https://www.instagram.com/${encodeURIComponent(username)}/live/`;
    case 'FACEBOOK':
      return /^\d+$/.test(username)
        ? `https://www.facebook.com/profile.php?id=${encodeURIComponent(username)}`
        : `https://www.facebook.com/${encodeURIComponent(username)}/live`;
    case 'X':
      return username.startsWith('broadcast_')
        ? `https://x.com/i/broadcasts/${encodeURIComponent(username.replace(/^broadcast_/, ''))}`
        : `https://x.com/${encodeURIComponent(username)}`;
    case 'TIKTOK':
    default:
      return `https://www.tiktok.com/@${encodeURIComponent(username)}/live`;
  }
}

function fnv1aHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function extractStableLiveSessionId(
  platform: LivePlatform,
  result: Pick<LiveCheckSuccess, 'streamUrl' | 'sourceUrl'>,
  username: string
): string {
  if (platform === 'TIKTOK') {
    return extractRoomIdFromStream(result.streamUrl, username);
  }

  const sourceUrl = result.sourceUrl || '';
  const streamUrl = result.streamUrl || '';

  if (platform === 'X') {
    const srcBroadcast = sourceUrl.match(/\/i\/broadcasts\/([a-zA-Z0-9_-]+)/i);
    if (srcBroadcast?.[1]) return srcBroadcast[1];

    const streamBroadcast = streamUrl.match(/\/i\/broadcasts\/([a-zA-Z0-9_-]+)/i);
    if (streamBroadcast?.[1]) return streamBroadcast[1];

    if (streamUrl) {
      try {
        const parsed = new URL(streamUrl);
        const hlsMatch = parsed.pathname.match(/\/([a-zA-Z0-9_-]{10,36})\.m3u8$/i);
        if (hlsMatch?.[1]) return hlsMatch[1];
        return `x_${fnv1aHash(`${parsed.origin}${parsed.pathname}`)}`;
      } catch {
        return `x_${fnv1aHash(streamUrl.split('?')[0])}`;
      }
    }
    return `x_live_${username}`;
  }

  // INSTAGRAM or FACEBOOK
  const srcVideoQuery = sourceUrl.match(/[?&]v=(\d+)/i);
  if (srcVideoQuery?.[1]) return srcVideoQuery[1];

  const srcVideoPath = sourceUrl.match(/\/(?:videos|live)\/(\d+)/i);
  if (srcVideoPath?.[1]) return srcVideoPath[1];

  if (streamUrl) {
    if (streamUrl.startsWith('data:')) {
      const dashIdMatch = streamUrl.match(/stream-(\d+)|live_id=(\d+)|broadcast_id=(\d+)/i);
      const id = dashIdMatch?.[1] || dashIdMatch?.[2] || dashIdMatch?.[3];
      if (id) return id;
      return `${platform.toLowerCase()}_dash_${fnv1aHash(streamUrl.slice(0, 256))}`;
    }

    const queryIdMatch = streamUrl.match(/[?&](?:room_id|broadcast_id|live_id)=(\d+)/i);
    if (queryIdMatch?.[1]) return queryIdMatch[1];

    try {
      const parsed = new URL(streamUrl);
      const cleanPath = parsed.pathname;
      const streamNum = cleanPath.match(/stream-(\d+)/i);
      if (streamNum?.[1]) return streamNum[1];

      const longId = cleanPath.match(/\/(\d{13,22})(?:[/_.]|$)/);
      if (longId?.[1]) return longId[1];

      return `${platform.toLowerCase()}_${fnv1aHash(`${parsed.origin}${cleanPath}`)}`;
    } catch {
      const cleanNoQuery = streamUrl.split('?')[0];
      const streamNum = cleanNoQuery.match(/stream-(\d+)/i);
      if (streamNum?.[1]) return streamNum[1];
      return `${platform.toLowerCase()}_${fnv1aHash(cleanNoQuery)}`;
    }
  }

  return `${platform.toLowerCase()}_live_${username}`;
}

export class PlatformLiveCollector implements PlatformCollector<WatcherEvent> {
  readonly name: string;
  readonly platform: LivePlatform;
  readonly eventType: WatcherEventType = 'live';
  readonly supported = true;

  private cookie: string;
  private checker: LiveCheckerFn;

  constructor(options: PlatformLiveCollectorOptions) {
    this.platform = options.platform;
    this.name = `${options.platform.toLowerCase()}_live`;
    this.cookie = normalizeCookieValue(options.cookie);
    this.checker = options.checker || defaultCheckerForPlatform(options.platform);
  }

  setCookie(cookie: string): void {
    this.cookie = normalizeCookieValue(cookie);
  }

  async fetchWithDiagnostics(rawUsername: string): Promise<CollectorFetchResult<WatcherEvent>> {
    const usedCookie = Boolean(this.cookie);
    const username = normalizeUsername(
      rawUsername,
      this.platform,
      this.platform === 'FACEBOOK' ? { allowVideoId: true } : undefined
    );
    if (!username) {
      return {
        status: 'ERROR',
        events: [],
        reason: `Invalid ${this.platform} username`,
        usedCookie,
      };
    }

    try {
      const result = await this.checker(username, this.cookie);

      if (result.status === 'ERROR') {
        const msg = result.message || 'Live check failed';
        const httpMatch = msg.match(/\bHTTP\s+(\d{3})\b/i);
        if (httpMatch?.[1]) {
          const httpStatus = Number(httpMatch[1]);
          const classified = classifyHttpDiagnostic(httpStatus, msg, usedCookie, this.platform);
          return {
            status: classified.status,
            events: [],
            reason: `[${this.name}] ${msg}`,
            httpStatus,
            usedCookie,
          };
        }

        const lower = msg.toLowerCase();
        if (lower.includes('429') || lower.includes('rate limit')) {
          return {
            status: 'RATE_LIMITED',
            events: [],
            reason: `[${this.name}] ${msg}`,
            httpStatus: 429,
            usedCookie,
          };
        }
        if (lower.includes('401') || lower.includes('login') || lower.includes('cookie')) {
          return {
            status: 'AUTH_REQUIRED',
            events: [],
            reason: `[${this.name}] ${msg}`,
            usedCookie,
          };
        }
        if (lower.includes('403') || lower.includes('blocked') || lower.includes('checkpoint')) {
          return {
            status: 'BLOCKED',
            events: [],
            reason: `[${this.name}] ${msg}`,
            usedCookie,
          };
        }

        return {
          status: 'ERROR',
          events: [],
          reason: `[${this.name}] ${msg}`,
          usedCookie,
        };
      }

      if (result.status === 'NOT_LIVE') {
        return {
          status: 'OK',
          events: [],
          usedCookie,
        };
      }

      const itemId = extractStableLiveSessionId(this.platform, result, username);
      const event: WatcherEvent = {
        platform: this.platform,
        username,
        eventType: 'live',
        itemId,
        url: result.sourceUrl || defaultLiveUrl(this.platform, username),
        title: result.title || `${this.platform} Live (@${username})`,
        thumbnailUrl: null,
        streamUrl: result.streamUrl,
        detectedAt: result.checkedAt || new Date().toISOString(),
        metadata: {
          method: result.method,
          qualityInfo: result.qualityInfo,
          sourceUrl: result.sourceUrl,
        },
      };

      return {
        status: 'OK',
        events: [event],
        usedCookie,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: 'ERROR',
        events: [],
        reason: `[${this.name}] ${msg}`,
        usedCookie,
      };
    }
  }

  async fetch(rawUsername: string): Promise<WatcherEvent[]> {
    const username = normalizeUsername(
      rawUsername,
      this.platform,
      this.platform === 'FACEBOOK' ? { allowVideoId: true } : undefined
    );
    if (!username) {
      return [];
    }
    const result = await this.fetchWithDiagnostics(username);
    return unwrapDiagnosticResult(result);
  }
}

export class InstagramLiveCollector extends PlatformLiveCollector {
  constructor(options?: Omit<PlatformLiveCollectorOptions, 'platform'>) {
    super({ ...options, platform: 'INSTAGRAM' });
  }
}

export class FacebookLiveCollector extends PlatformLiveCollector {
  constructor(options?: Omit<PlatformLiveCollectorOptions, 'platform'>) {
    super({ ...options, platform: 'FACEBOOK' });
  }
}

export class XLiveCollector extends PlatformLiveCollector {
  constructor(options?: Omit<PlatformLiveCollectorOptions, 'platform'>) {
    super({ ...options, platform: 'X' });
  }
}

export function createPlatformLiveCollector(
  platform: LivePlatform,
  options?: Omit<PlatformLiveCollectorOptions, 'platform'>
): PlatformLiveCollector {
  return new PlatformLiveCollector({ ...options, platform });
}
