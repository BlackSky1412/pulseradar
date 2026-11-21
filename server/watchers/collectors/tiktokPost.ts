import { fetchWithTimeout, safeJsonParse } from '../../liveCheckers/httpClient';
import type { LivePlatform } from '../../liveCheckers/types';
import type {
  CollectorFetchResult,
  CollectorStatus,
  TikTokEvent,
  WatcherEvent,
  WatcherEventType,
} from '../types';
import {
  type BaseCollector,
  classifyHttpDiagnostic,
  CollectorDiagnosticError,
  normalizeCookieValue,
  normalizeUsername,
} from './base';

export interface RawTikTokPost {
  id: string;
  desc?: string;
  title?: string;
  coverUrl?: string | null;
  createTime?: number;
  isPinned?: boolean;
}

export type TikTokPostFetcherFn = (
  username: string,
  topN: number
) => Promise<RawTikTokPost[]>;

export interface TikTokPostCollectorOptions {
  topN?: number;
  skipPinned?: boolean;
  cookie?: string;
  fetcher?: TikTokPostFetcherFn;
}

const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const MOBILE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1';

export function isTikTokChallengeShell(html: string): boolean {
  if (!html) return true;
  if (
    html.includes('__UNIVERSAL_DATA_FOR_REHYDRATION__') ||
    html.includes('SIGI_STATE')
  ) {
    return false;
  }
  return (
    html.length < 15000 ||
    /captcha|challenge|verify|secsdk|_waf|__cf_chl|tiktok-captcha/i.test(html)
  );
}

interface ParsedTikTokPostsResult {
  found: boolean;
  notFound?: boolean;
  privateAccount?: boolean;
  posts: RawTikTokPost[];
}

export function parseTikTokPostsFromHtml(
  html: string,
  _topN: number = 10
): ParsedTikTokPostsResult {
  const posts: RawTikTokPost[] = [];

  // Strategy 1: Check __UNIVERSAL_DATA_FOR_REHYDRATION__
  const universalMatch = html.match(
    /<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/
  );
  if (universalMatch?.[1]) {
    const data = safeJsonParse<Record<string, unknown>>(universalMatch[1]);
    const defaultScope = data?.__DEFAULT_SCOPE__ as Record<string, unknown> | undefined;
    const userDetail = defaultScope?.['webapp.user-detail'] as Record<string, unknown> | undefined;

    if (userDetail) {
      const statusCode = userDetail.statusCode;
      const userInfo = userDetail.userInfo as Record<string, unknown> | undefined;
      const user = userInfo?.user as Record<string, unknown> | undefined;
      const itemInfo = userDetail.itemInfo as Record<string, unknown> | undefined;
      const itemList = itemInfo?.itemList as Array<Record<string, unknown>> | undefined;

      if (typeof statusCode === 'number' && statusCode !== 0 && !user && !Array.isArray(itemList)) {
        return { found: true, notFound: true, posts: [] };
      }

      if (user?.privateAccount === true && (!Array.isArray(itemList) || itemList.length === 0)) {
        return { found: true, privateAccount: true, posts: [] };
      }

      if (Array.isArray(itemList)) {
        for (const item of itemList) {
          const id = String(item.id || item.itemId || '').trim();
          if (!id) continue;
          const isPinned = Boolean(
            item.isPinned ||
            item.isTop ||
            (item.tag as Record<string, unknown> | undefined)?.isTop
          );
          const videoObj = item.video as Record<string, unknown> | undefined;
          const coverUrl =
            (typeof videoObj?.cover === 'string' && videoObj.cover) ||
            (typeof videoObj?.originCover === 'string' && videoObj.originCover) ||
            null;
          const desc = (typeof item.desc === 'string' && item.desc) || '';
          const createTime = typeof item.createTime === 'number' ? item.createTime : undefined;

          posts.push({ id, desc, coverUrl, createTime, isPinned });
        }
        return { found: true, posts };
      }

      if (user) {
        return { found: true, posts: [] };
      }
    }
  }

  // Strategy 2: Check SIGI_STATE
  const sigiMatch = html.match(/<script[^>]*id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/);
  if (sigiMatch?.[1]) {
    const data = safeJsonParse<Record<string, unknown>>(sigiMatch[1]);
    const itemModule = data?.ItemModule as Record<string, Record<string, unknown>> | undefined;
    if (itemModule && typeof itemModule === 'object') {
      for (const item of Object.values(itemModule)) {
        const id = String(item.id || '').trim();
        if (!id) continue;
        const isPinned = Boolean(
          item.isPinned ||
          item.isTop ||
          (item.tag as Record<string, unknown> | undefined)?.isTop
        );
        const desc = (typeof item.desc === 'string' && item.desc) || '';
        const videoObj = item.video as Record<string, unknown> | undefined;
        const coverUrl =
          (typeof videoObj?.cover === 'string' && videoObj.cover) ||
          (typeof videoObj?.originCover === 'string' && videoObj.originCover) ||
          null;

        posts.push({ id, desc, coverUrl, isPinned });
      }
      return { found: true, posts };
    }
  }

  return { found: false, posts: [] };
}

interface InternalTikTokPostsDiagnostic {
  status: CollectorStatus;
  posts: RawTikTokPost[];
  reason?: string;
  httpStatus?: number;
  usedCookie: boolean;
}

function buildTikTokHeaders(userAgent: string, cookie?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': userAgent,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
  };
  const trimmedCookie = normalizeCookieValue(cookie);
  if (trimmedCookie) {
    headers.Cookie = trimmedCookie.includes('=') ? trimmedCookie : `sessionid=${trimmedCookie}`;
  }
  return headers;
}

function parsedResultToDiagnostic(
  parsed: ParsedTikTokPostsResult,
  httpStatus: number,
  usedCookie: boolean
): InternalTikTokPostsDiagnostic {
  if (parsed.notFound) {
    return {
      status: 'NOT_FOUND',
      posts: [],
      reason: 'TikTok account not found',
      httpStatus,
      usedCookie,
    };
  }
  if (parsed.privateAccount) {
    return {
      status: 'PRIVATE',
      posts: [],
      reason: 'TikTok account is private',
      httpStatus,
      usedCookie,
    };
  }
  return {
    status: 'OK',
    posts: parsed.posts,
    httpStatus,
    usedCookie,
  };
}

async function defaultFetchTikTokPostsWithDiagnostics(
  username: string,
  topN: number,
  cookie?: string
): Promise<InternalTikTokPostsDiagnostic> {
  const url = `https://www.tiktok.com/@${encodeURIComponent(username)}`;
  const trimmedCookie = normalizeCookieValue(cookie);
  const usedCookie = Boolean(trimmedCookie);

  const desktopResp = await fetchWithTimeout(url, {
    headers: buildTikTokHeaders(DESKTOP_USER_AGENT, trimmedCookie),
    timeoutMs: 10000,
  });

  if (desktopResp.status === 404) {
    return {
      status: 'NOT_FOUND',
      posts: [],
      reason: `TikTok account @${username} not found (HTTP 404)`,
      httpStatus: 404,
      usedCookie,
    };
  }

  if (desktopResp.ok) {
    const parsed = parseTikTokPostsFromHtml(desktopResp.text || '', topN);
    if (parsed.found) {
      return parsedResultToDiagnostic(parsed, desktopResp.status, usedCookie);
    }
  }

  // Fallback to MOBILE_USER_AGENT when Desktop hit non-404 HTTP error or JS challenge shell
  const mobileResp = await fetchWithTimeout(url, {
    headers: buildTikTokHeaders(MOBILE_USER_AGENT, trimmedCookie),
    timeoutMs: 10000,
  });

  if (mobileResp.status === 404) {
    return {
      status: 'NOT_FOUND',
      posts: [],
      reason: `TikTok account @${username} not found (HTTP 404)`,
      httpStatus: 404,
      usedCookie,
    };
  }

  if (!mobileResp.ok) {
    const classified = classifyHttpDiagnostic(
      mobileResp.status,
      mobileResp.text || '',
      usedCookie,
      'TikTok'
    );
    return {
      status: classified.status,
      posts: [],
      reason: `Failed to fetch TikTok profile for @${username} (HTTP ${mobileResp.status}): ${classified.reason}`,
      httpStatus: mobileResp.status,
      usedCookie,
    };
  }

  const mobileHtml = mobileResp.text || '';
  const mobileParsed = parseTikTokPostsFromHtml(mobileHtml, topN);
  if (mobileParsed.found) {
    return parsedResultToDiagnostic(mobileParsed, mobileResp.status, usedCookie);
  }

  if (isTikTokChallengeShell(mobileHtml)) {
    return {
      status: 'BLOCKED',
      posts: [],
      reason: 'TikTok returned JS challenge / empty shell without profile data',
      httpStatus: mobileResp.status,
      usedCookie,
    };
  }

  return {
    status: 'OK',
    posts: [],
    httpStatus: mobileResp.status,
    usedCookie,
  };
}

export class TikTokPostCollector implements BaseCollector {
  readonly name = 'tiktok_post';
  readonly platform: LivePlatform = 'TIKTOK';
  readonly eventType: WatcherEventType = 'post';
  readonly supported = true;

  private topN: number;
  private skipPinned: boolean;
  private cookie: string;
  private customFetcher?: TikTokPostFetcherFn;

  constructor(options?: TikTokPostCollectorOptions) {
    this.topN = options?.topN ?? 10;
    this.skipPinned = options?.skipPinned ?? true;
    this.cookie = normalizeCookieValue(options?.cookie);
    this.customFetcher = options?.fetcher;
  }

  setCookie(cookie: string): void {
    this.cookie = normalizeCookieValue(cookie);
  }

  private mapPostsToEvents(username: string, rawPosts: RawTikTokPost[]): TikTokEvent[] {
    const events: TikTokEvent[] = [];

    for (const post of rawPosts) {
      if (!post.id) continue;

      if (this.skipPinned && post.isPinned) {
        continue;
      }

      const event: TikTokEvent = {
        platform: 'TIKTOK',
        username,
        eventType: 'post',
        itemId: post.id,
        url: `https://www.tiktok.com/@${username}/video/${post.id}`,
        title: post.desc || post.title || `TikTok Video from @${username}`,
        thumbnailUrl: post.coverUrl || null,
        detectedAt: new Date().toISOString(),
        isPinned: Boolean(post.isPinned),
        metadata: {
          createTime: post.createTime,
        },
      };

      events.push(event);

      if (events.length >= this.topN) {
        break;
      }
    }

    return events;
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
      if (this.customFetcher) {
        const rawPosts = await this.customFetcher(username, this.topN);
        return {
          status: 'OK',
          events: this.mapPostsToEvents(username, rawPosts),
          usedCookie,
        };
      }

      const diag = await defaultFetchTikTokPostsWithDiagnostics(username, this.topN, this.cookie);
      return {
        status: diag.status,
        events: this.mapPostsToEvents(username, diag.posts),
        reason: diag.reason,
        httpStatus: diag.httpStatus,
        usedCookie: diag.usedCookie,
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

    if (this.customFetcher) {
      const rawPosts = await this.customFetcher(username, this.topN);
      return this.mapPostsToEvents(username, rawPosts);
    }

    const diag = await defaultFetchTikTokPostsWithDiagnostics(username, this.topN, this.cookie);
    if (diag.status === 'OK' || diag.status === 'NOT_FOUND' || diag.status === 'PRIVATE') {
      return this.mapPostsToEvents(username, diag.posts);
    }

    // Backward compat with watcher.test.ts: HTTP 200 empty shells return [] without throwing in fetch()
    if (diag.status === 'BLOCKED' && diag.httpStatus === 200) {
      return [];
    }

    throw new CollectorDiagnosticError(
      diag.reason || `Failed to fetch TikTok profile for @${username}`,
      diag.status,
      { httpStatus: diag.httpStatus, usedCookie: diag.usedCookie }
    );
  }
}
