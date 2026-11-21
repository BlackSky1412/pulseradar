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
  normalizeCookieValue,
  normalizeUsername,
  unwrapDiagnosticResult,
} from './base';
import { isTikTokChallengeShell } from './tiktokPost';

export interface RawTikTokStory {
  id: string;
  title?: string;
  coverUrl?: string | null;
  createTime?: number;
  expireTime?: number;
  playAddr?: string | null;
  photoUrls?: string[];
}

export type TikTokStoryFetcherFn = (username: string) => Promise<RawTikTokStory[]>;

export interface TikTokStoryCollectorOptions {
  cookie?: string;
  fetcher?: TikTokStoryFetcherFn;
}

const MOBILE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1';

export function parseStoryItem(item: Record<string, unknown>): RawTikTokStory | null {
  const id = String(item.id || item.storyId || item.itemId || '').trim();
  if (!id) return null;

  const videoObj = item.video as Record<string, unknown> | undefined;
  const coverUrl =
    (typeof videoObj?.cover === 'string' && videoObj.cover) ||
    (typeof videoObj?.originCover === 'string' && videoObj.originCover) ||
    null;

  const playAddr =
    (typeof videoObj?.playAddr === 'string' && videoObj.playAddr) ||
    (typeof videoObj?.downloadAddr === 'string' && videoObj.downloadAddr) ||
    null;

  const photoUrls: string[] = [];
  const imagePost = item.imagePost as Record<string, unknown> | undefined;
  if (Array.isArray(imagePost?.images)) {
    for (const img of imagePost.images as Array<Record<string, unknown>>) {
      const imgUrlObj = img.imageURL as Record<string, unknown> | undefined;
      const urlList = imgUrlObj?.urlList as string[] | undefined;
      const firstUrl = Array.isArray(urlList) && urlList[0];
      if (typeof firstUrl === 'string' && firstUrl.trim()) {
        photoUrls.push(firstUrl.trim());
      }
    }
  }

  const title = (typeof item.desc === 'string' && item.desc.trim()) || 'TikTok Story';
  const createTime = typeof item.createTime === 'number' ? item.createTime : undefined;
  const expireTime = typeof item.expireTime === 'number' ? item.expireTime : undefined;

  return { id, title, coverUrl, createTime, expireTime, playAddr, photoUrls };
}

interface InternalTikTokStoriesDiagnostic {
  status: CollectorStatus;
  stories: RawTikTokStory[];
  reason?: string;
  httpStatus?: number;
  usedCookie: boolean;
}

async function defaultFetchTikTokStoriesWithDiagnostics(
  username: string,
  cookie?: string
): Promise<InternalTikTokStoriesDiagnostic> {
  const url = `https://www.tiktok.com/@${encodeURIComponent(username)}`;
  const headers: Record<string, string> = {
    'User-Agent': MOBILE_USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
  };
  const trimmedCookie = normalizeCookieValue(cookie);
  const usedCookie = Boolean(trimmedCookie);
  if (trimmedCookie) {
    headers.Cookie = trimmedCookie.includes('=') ? trimmedCookie : `sessionid=${trimmedCookie}`;
  }

  const resp = await fetchWithTimeout(url, { headers, timeoutMs: 12000 });
  if (!resp.ok) {
    if (resp.status === 404) {
      return {
        status: 'NOT_FOUND',
        stories: [],
        reason: `TikTok account @${username} not found (HTTP 404)`,
        httpStatus: 404,
        usedCookie,
      };
    }
    const classified = classifyHttpDiagnostic(resp.status, resp.text || '', usedCookie, 'TikTok');
    return {
      status: classified.status,
      stories: [],
      reason: `Failed to fetch TikTok stories for @${username} (HTTP ${resp.status})`,
      httpStatus: resp.status,
      usedCookie,
    };
  }

  const html = resp.text || '';
  const stories: RawTikTokStory[] = [];

  let authorId: string | undefined;
  let userStoryStatus: number | undefined;
  let parsedProfile = false;

  // Strategy 1: Check __UNIVERSAL_DATA_FOR_REHYDRATION__ for user info & preloaded story items
  const universalMatch = html.match(
    /<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/
  );
  if (universalMatch?.[1]) {
    parsedProfile = true;
    const data = safeJsonParse<Record<string, unknown>>(universalMatch[1]);
    const defaultScope = data?.__DEFAULT_SCOPE__ as Record<string, unknown> | undefined;
    const userDetail = defaultScope?.['webapp.user-detail'] as Record<string, unknown> | undefined;
    const userInfo = userDetail?.userInfo as Record<string, unknown> | undefined;
    const user = userInfo?.user as Record<string, unknown> | undefined;

    if (user?.id) {
      authorId = String(user.id);
    }
    if (typeof user?.UserStoryStatus === 'number') {
      userStoryStatus = user.UserStoryStatus;
    }

    // Direct story list in userDetail if populated
    const storyInfo = userDetail?.storyInfo as Record<string, unknown> | undefined;
    const storyList = (storyInfo?.storyList || storyInfo?.itemList) as
      | Array<Record<string, unknown>>
      | undefined;

    if (Array.isArray(storyList) && storyList.length > 0) {
      for (const item of storyList) {
        const parsed = parseStoryItem(item);
        if (parsed) stories.push(parsed);
      }
      return { status: 'OK', stories, httpStatus: resp.status, usedCookie };
    }
  }

  // Strategy 2: Fallback extraction of authorId from HTML regex
  if (!authorId) {
    const idMatch = html.match(/"id":"(\d{15,22})"/);
    if (idMatch?.[1]) {
      authorId = idMatch[1];
      parsedProfile = true;
    }
  }

  // Strategy 3: Query TikTok story API endpoint with authorId
  if (authorId) {
    if (userStoryStatus === 0) {
      return { status: 'OK', stories: [], httpStatus: resp.status, usedCookie };
    }

    const apiHeaders: Record<string, string> = {
      'User-Agent': MOBILE_USER_AGENT,
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://www.tiktok.com/',
    };
    if (headers.Cookie) {
      apiHeaders.Cookie = headers.Cookie;
    }

    const storyApiUrl = `https://www.tiktok.com/api/story/item_list/?aid=1988&app_language=vi-VN&browser_language=vi-VN&authorId=${encodeURIComponent(
      authorId
    )}&count=20&cursor=0`;

    try {
      const apiResp = await fetchWithTimeout(storyApiUrl, {
        headers: apiHeaders,
        timeoutMs: 10000,
      });

      if (apiResp.ok && apiResp.text) {
        const apiData = safeJsonParse<{
          itemList?: Array<Record<string, unknown>>;
        }>(apiResp.text);

        if (Array.isArray(apiData?.itemList)) {
          for (const item of apiData.itemList) {
            const parsed = parseStoryItem(item);
            if (parsed) stories.push(parsed);
          }
        }
      }
    } catch {
      // Non-fatal, return whatever stories were collected
    }
    return { status: 'OK', stories, httpStatus: resp.status, usedCookie };
  }

  if (!parsedProfile && isTikTokChallengeShell(html)) {
    return {
      status: 'BLOCKED',
      stories: [],
      reason: 'TikTok returned JS challenge / empty shell without profile data',
      httpStatus: resp.status,
      usedCookie,
    };
  }

  return { status: 'OK', stories, httpStatus: resp.status, usedCookie };
}

export class TikTokStoryCollector implements BaseCollector {
  readonly name = 'tiktok_story';
  readonly platform: LivePlatform = 'TIKTOK';
  readonly eventType: WatcherEventType = 'story';
  readonly supported = true;

  private cookie: string;
  private customFetcher?: TikTokStoryFetcherFn;

  constructor(options?: TikTokStoryCollectorOptions) {
    this.cookie = normalizeCookieValue(options?.cookie);
    this.customFetcher = options?.fetcher;
  }

  setCookie(cookie: string): void {
    this.cookie = normalizeCookieValue(cookie);
  }

  private mapStoriesToEvents(username: string, rawStories: RawTikTokStory[]): TikTokEvent[] {
    const events: TikTokEvent[] = [];

    for (const story of rawStories) {
      if (!story.id) continue;

      const event: TikTokEvent = {
        platform: 'TIKTOK',
        username,
        eventType: 'story',
        itemId: story.id,
        url: `https://www.tiktok.com/@${username}/story/${story.id}`,
        title: story.title || `TikTok Story from @${username}`,
        thumbnailUrl: story.coverUrl || null,
        detectedAt: new Date().toISOString(),
        metadata: {
          createTime: story.createTime,
          expireTime: story.expireTime,
          playAddr: story.playAddr || undefined,
          photoUrls: story.photoUrls,
        },
      };

      events.push(event);
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
        const rawStories = await this.customFetcher(username);
        return {
          status: 'OK',
          events: this.mapStoriesToEvents(username, rawStories),
          usedCookie,
        };
      }

      const diag = await defaultFetchTikTokStoriesWithDiagnostics(username, this.cookie);
      return {
        status: diag.status,
        events: this.mapStoriesToEvents(username, diag.stories),
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
      const rawStories = await this.customFetcher(username);
      return this.mapStoriesToEvents(username, rawStories);
    }

    const diag = await defaultFetchTikTokStoriesWithDiagnostics(username, this.cookie);
    if (diag.status === 'BLOCKED' && diag.httpStatus === 200) {
      return [];
    }
    return unwrapDiagnosticResult({
      status: diag.status,
      events: this.mapStoriesToEvents(username, diag.stories),
      reason: diag.reason,
      httpStatus: diag.httpStatus,
      usedCookie: diag.usedCookie,
    });
  }
}
