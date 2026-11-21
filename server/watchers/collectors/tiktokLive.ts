import { checkTikTokLive } from '../../liveCheckers/tiktokChecker';
import type { LiveCheckResult, LivePlatform } from '../../liveCheckers/types';
import type {
  CollectorFetchResult,
  TikTokEvent,
  WatcherEvent,
  WatcherEventType,
} from '../types';
import {
  type BaseCollector,
  classifyHttpDiagnostic,
  normalizeCookieValue,
  normalizeUsername,
} from './base';

export type TikTokLiveCheckerFn = (username: string, cookie?: string) => Promise<LiveCheckResult>;

export interface TikTokLiveCollectorOptions {
  cookie?: string;
  checker?: TikTokLiveCheckerFn;
}

export function extractRoomIdFromStream(streamUrl?: string | null, fallbackKey?: string): string {
  if (!streamUrl) {
    return fallbackKey ? `live_session_${fallbackKey}` : `live_session_${Date.now()}`;
  }
  const streamMatch = streamUrl.match(/stream-(\d+)/i);
  if (streamMatch?.[1]) {
    return streamMatch[1];
  }
  const queryRoomMatch = streamUrl.match(/[?&]room_id=(\d+)/i);
  if (queryRoomMatch?.[1]) {
    return queryRoomMatch[1];
  }
  const longNumMatch = streamUrl.match(/(\d{16,21})/);
  if (longNumMatch?.[1]) {
    return longNumMatch[1];
  }
  let hash = 0;
  for (let i = 0; i < streamUrl.length; i++) {
    hash = (hash << 5) - hash + streamUrl.charCodeAt(i);
    hash |= 0;
  }
  return `room_${Math.abs(hash)}`;
}

export class TikTokLiveCollector implements BaseCollector {
  readonly name = 'tiktok_live';
  readonly platform: LivePlatform = 'TIKTOK';
  readonly eventType: WatcherEventType = 'live';
  readonly supported = true;

  private cookie: string;
  private checker: TikTokLiveCheckerFn;

  constructor(options?: TikTokLiveCollectorOptions) {
    this.cookie = normalizeCookieValue(options?.cookie);
    this.checker = options?.checker || checkTikTokLive;
  }

  setCookie(cookie: string): void {
    this.cookie = normalizeCookieValue(cookie);
  }

  async fetchWithDiagnostics(rawUsername: string): Promise<CollectorFetchResult<WatcherEvent>> {
    const usedCookie = Boolean(this.cookie);
    const username = normalizeUsername(rawUsername, 'TIKTOK');
    if (!username) {
      return {
        status: 'ERROR',
        events: [],
        reason: 'Invalid TIKTOK username',
        usedCookie,
      };
    }

    try {
      const result = await this.checker(username, this.cookie);

      if (result.status === 'ERROR') {
        const msg = result.message || 'Check failed';
        const httpMatch = msg.match(/\bHTTP\s+(\d{3})\b/i);
        if (httpMatch?.[1]) {
          const httpStatus = Number(httpMatch[1]);
          const classified = classifyHttpDiagnostic(httpStatus, msg, usedCookie, 'TikTok');
          return {
            status: classified.status,
            events: [],
            reason: `[tiktok_live] Check failed for @${username}: ${msg}`,
            httpStatus,
            usedCookie,
          };
        }
        return {
          status: 'ERROR',
          events: [],
          reason: `[tiktok_live] Check failed for @${username}: ${msg}`,
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

      const roomId = extractRoomIdFromStream(result.streamUrl, username);
      const event: TikTokEvent = {
        platform: 'TIKTOK',
        username,
        eventType: 'live',
        itemId: roomId,
        url: `https://www.tiktok.com/@${username}/live`,
        title: result.title || `TikTok Live (@${username})`,
        thumbnailUrl: null,
        streamUrl: result.streamUrl,
        detectedAt: result.checkedAt || new Date().toISOString(),
        metadata: {
          method: result.method,
          qualityInfo: result.qualityInfo,
        },
      };

      return {
        status: 'OK',
        events: [event],
        usedCookie,
      };
    } catch (err) {
      return {
        status: 'ERROR',
        events: [],
        reason: err instanceof Error ? err.message : String(err),
        usedCookie,
      };
    }
  }

  async fetch(rawUsername: string): Promise<TikTokEvent[]> {
    const username = normalizeUsername(rawUsername, 'TIKTOK');
    if (!username) {
      return [];
    }

    const result = await this.checker(username, this.cookie);

    if (result.status === 'ERROR') {
      throw new Error(`[tiktok_live] Check failed for @${username}: ${result.message}`);
    }

    if (result.status === 'NOT_LIVE') {
      return [];
    }

    const roomId = extractRoomIdFromStream(result.streamUrl, username);
    const event: TikTokEvent = {
      platform: 'TIKTOK',
      username,
      eventType: 'live',
      itemId: roomId,
      url: `https://www.tiktok.com/@${username}/live`,
      title: result.title || `TikTok Live (@${username})`,
      thumbnailUrl: null,
      streamUrl: result.streamUrl,
      detectedAt: result.checkedAt || new Date().toISOString(),
      metadata: {
        method: result.method,
        qualityInfo: result.qualityInfo,
      },
    };

    return [event];
  }
}
