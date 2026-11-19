import { fetchWithTimeout, safeJsonParse } from '../../liveCheckers/httpClient';
import type { TikTokEvent, WatcherEventType } from '../types';
import { type BaseCollector, normalizeUsername } from './base';

export interface RawTikTokStory {
  id: string;
  title?: string;
  coverUrl?: string | null;
  createTime?: number;
  expireTime?: number;
}

export type TikTokStoryFetcherFn = (username: string) => Promise<RawTikTokStory[]>;

export interface TikTokStoryCollectorOptions {
  cookie?: string;
  fetcher?: TikTokStoryFetcherFn;
}

const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

async function defaultFetchTikTokStories(
  username: string,
  cookie?: string
): Promise<RawTikTokStory[]> {
  const url = `https://www.tiktok.com/@${encodeURIComponent(username)}`;
  const headers: Record<string, string> = {
    'User-Agent': DESKTOP_USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
  };
  if (cookie) {
    headers.Cookie = cookie.includes('=') ? cookie : `sessionid=${cookie}`;
  }

  const resp = await fetchWithTimeout(url, { headers, timeoutMs: 10000 });
  if (!resp.ok) {
    if (resp.status === 404) {
      return [];
    }
    throw new Error(`Failed to fetch TikTok stories for @${username} (HTTP ${resp.status})`);
  }

  const html = resp.text || '';
  const stories: RawTikTokStory[] = [];

  // Strategy: Check __UNIVERSAL_DATA_FOR_REHYDRATION__ for story items
  const universalMatch = html.match(
    /<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/
  );
  if (universalMatch?.[1]) {
    const data = safeJsonParse<Record<string, unknown>>(universalMatch[1]);
    const defaultScope = data?.__DEFAULT_SCOPE__ as Record<string, unknown> | undefined;
    const userDetail = defaultScope?.['webapp.user-detail'] as Record<string, unknown> | undefined;
    const storyInfo = userDetail?.storyInfo as Record<string, unknown> | undefined;
    const storyList = (storyInfo?.storyList || storyInfo?.itemList) as
      | Array<Record<string, unknown>>
      | undefined;

    if (Array.isArray(storyList)) {
      for (const item of storyList) {
        const id = String(item.id || item.storyId || item.itemId || '').trim();
        if (!id) continue;
        const videoObj = item.video as Record<string, unknown> | undefined;
        const coverUrl =
          (typeof videoObj?.cover === 'string' && videoObj.cover) ||
          (typeof videoObj?.originCover === 'string' && videoObj.originCover) ||
          null;
        const title = (typeof item.desc === 'string' && item.desc) || 'TikTok Story';
        const createTime = typeof item.createTime === 'number' ? item.createTime : undefined;
        const expireTime = typeof item.expireTime === 'number' ? item.expireTime : undefined;

        stories.push({ id, title, coverUrl, createTime, expireTime });
      }
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
    this.cookie = options?.cookie;
    this.fetcher =
      options?.fetcher || ((username) => defaultFetchTikTokStories(username, this.cookie));
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
        },
      };

      events.push(event);
    }

    return events;
  }
}
