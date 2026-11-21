import { fetchWithTimeout, safeJsonParse } from '../../liveCheckers/httpClient';
import type { TikTokEvent, WatcherEventType } from '../types';
import { type BaseCollector, normalizeUsername } from './base';

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

async function defaultFetchTikTokStories(
  username: string,
  cookie?: string
): Promise<RawTikTokStory[]> {
  const url = `https://www.tiktok.com/@${encodeURIComponent(username)}`;
  const headers: Record<string, string> = {
    'User-Agent': MOBILE_USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
  };
  const trimmedCookie = typeof cookie === 'string' ? cookie.trim() : '';
  if (trimmedCookie) {
    headers.Cookie = trimmedCookie.includes('=') ? trimmedCookie : `sessionid=${trimmedCookie}`;
  }

  const resp = await fetchWithTimeout(url, { headers, timeoutMs: 12000 });
  if (!resp.ok) {
    if (resp.status === 404) {
      return [];
    }
    throw new Error(`Failed to fetch TikTok stories for @${username} (HTTP ${resp.status})`);
  }

  const html = resp.text || '';
  const stories: RawTikTokStory[] = [];

  let authorId: string | undefined;
  let userStoryStatus: number | undefined;

  // Strategy 1: Check __UNIVERSAL_DATA_FOR_REHYDRATION__ for user info & preloaded story items
  const universalMatch = html.match(
    /<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/
  );
  if (universalMatch?.[1]) {
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
      return stories;
    }
  }

  // Strategy 2: Fallback extraction of authorId from HTML regex
  if (!authorId) {
    const idMatch = html.match(/"id":"(\d{15,22})"/);
    if (idMatch?.[1]) {
      authorId = idMatch[1];
    }
  }

  // Strategy 3: Query TikTok story API endpoint with authorId
  if (authorId) {
    if (userStoryStatus === 0) {
      // UserStoryStatus = 0 means user has no active stories
      return [];
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
  }

  return stories;
}

export class TikTokStoryCollector implements BaseCollector {
  readonly name = 'tiktok_story';
  readonly eventType: WatcherEventType = 'story';

  private cookie?: string;
  private fetcher: TikTokStoryFetcherFn;

  constructor(options?: TikTokStoryCollectorOptions) {
    this.cookie = typeof options?.cookie === 'string' ? options.cookie.trim() : '';
    this.fetcher =
      options?.fetcher || ((username) => defaultFetchTikTokStories(username, this.cookie));
  }

  setCookie(cookie: string): void {
    this.cookie = typeof cookie === 'string' ? cookie.trim() : '';
  }

  async fetch(rawUsername: string): Promise<TikTokEvent[]> {
    const username = normalizeUsername(rawUsername);
    if (!username) {
      return [];
    }

    const rawStories = await this.fetcher(username);
    const events: TikTokEvent[] = [];

    for (const story of rawStories) {
      if (!story.id) continue;

      const event: TikTokEvent = {
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
          playAddr: story.playAddr,
          photoUrls: story.photoUrls,
        },
      };

      events.push(event);
    }

    return events;
  }
}
