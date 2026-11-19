import { fetchWithTimeout, safeJsonParse } from '../../liveCheckers/httpClient';
import type { TikTokEvent, WatcherEventType } from '../types';
import { type BaseCollector, normalizeUsername } from './base';

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

async function defaultFetchTikTokPosts(
  username: string,
  topN: number,
  cookie?: string
): Promise<RawTikTokPost[]> {
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
    throw new Error(`Failed to fetch TikTok profile for @${username} (HTTP ${resp.status})`);
  }

  const html = resp.text || '';
  const posts: RawTikTokPost[] = [];

  // Strategy 1: Check __UNIVERSAL_DATA_FOR_REHYDRATION__
  const universalMatch = html.match(
    /<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/
  );
  if (universalMatch?.[1]) {
    const data = safeJsonParse<Record<string, unknown>>(universalMatch[1]);
    const defaultScope = data?.__DEFAULT_SCOPE__ as Record<string, unknown> | undefined;
    const userDetail = defaultScope?.['webapp.user-detail'] as Record<string, unknown> | undefined;
    const itemInfo = userDetail?.itemInfo as Record<string, unknown> | undefined;
    const itemList = itemInfo?.itemList as Array<Record<string, unknown>> | undefined;

    if (Array.isArray(itemList)) {
      for (const item of itemList.slice(0, topN * 2)) {
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
      return posts;
    }
  }

  // Strategy 2: Check SIGI_STATE
  const sigiMatch = html.match(/<script[^>]*id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/);
  if (sigiMatch?.[1]) {
    const data = safeJsonParse<Record<string, unknown>>(sigiMatch[1]);
    const itemModule = data?.ItemModule as Record<string, Record<string, unknown>> | undefined;
    if (itemModule && typeof itemModule === 'object') {
      for (const item of Object.values(itemModule).slice(0, topN * 2)) {
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
      return posts;
    }
  }

  return posts;
}

export class TikTokPostCollector implements BaseCollector {
  readonly name = 'tiktok_post';
  readonly eventType: WatcherEventType = 'post';

  private topN: number;
  private skipPinned: boolean;
  private cookie?: string;
  private fetcher: TikTokPostFetcherFn;

  constructor(options?: TikTokPostCollectorOptions) {
    this.topN = options?.topN ?? 10;
    this.skipPinned = options?.skipPinned ?? true;
    this.cookie = options?.cookie;
    this.fetcher =
      options?.fetcher ||
      ((username, count) => defaultFetchTikTokPosts(username, count, this.cookie));
  }

  async fetch(rawUsername: string): Promise<TikTokEvent[]> {
    const username = normalizeUsername(rawUsername);
    if (!username) {
      return [];
    }

    const rawPosts = await this.fetcher(username, this.topN);
    const events: TikTokEvent[] = [];

    for (const post of rawPosts) {
      if (!post.id) continue;

      // Skip pinned videos if configured
      if (this.skipPinned && post.isPinned) {
        continue;
      }

      const event: TikTokEvent = {
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

      // Return up to topN unpinned posts
      if (events.length >= this.topN) {
        break;
      }
    }

    return events;
  }
}
