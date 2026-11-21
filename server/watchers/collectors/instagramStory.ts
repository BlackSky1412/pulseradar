import { fetchWithTimeout, safeJsonParse } from '../../liveCheckers/httpClient';
import type { LivePlatform } from '../../liveCheckers/types';
import type {
  CollectorFetchResult,
  CollectorStatus,
  WatcherEvent,
  WatcherEventType,
} from '../types';
import {
  normalizeCookieValue,
  normalizeUsername,
  type PlatformCollector,
} from './base';
import {
  buildInstagramMobileApiHeaders,
  buildInstagramWebApiHeaders,
  classifyInstagramFailure,
  formatInstagramCookie,
  IG_MOBILE_USER_AGENT,
  IG_WEB_USER_AGENT,
  resolveInstagramUserId,
  unescapeInstagramUrl,
} from './instagramShared';

export interface RawInstagramStory {
  id: string;
  takenAt?: number;
  expiringAt?: number;
  videoUrl?: string;
  photoUrls?: string[];
  thumbnailUrl?: string | null;
}

export interface InstagramStoryFetchOutput {
  status: CollectorStatus;
  stories: RawInstagramStory[];
  reason?: string;
  httpStatus?: number;
  usedCookie?: boolean;
}

export type InstagramStoryFetcherFn = (
  username: string,
  cookie: string
) => Promise<InstagramStoryFetchOutput | RawInstagramStory[]>;

export interface InstagramStoryCollectorOptions {
  cookie?: string;
  fetcher?: InstagramStoryFetcherFn;
}

function pickBestCandidate(
  candidates: Array<{ url?: string; width?: number; height?: number }> | undefined
): string {
  if (!Array.isArray(candidates) || candidates.length === 0) return '';
  let bestUrl = '';
  let bestScore = -1;
  for (const c of candidates) {
    if (typeof c?.url !== 'string' || !c.url.trim()) continue;
    const score = Number(c.width || 0) * Number(c.height || 0);
    if (!bestUrl || score > bestScore) {
      bestScore = score;
      bestUrl = unescapeInstagramUrl(c.url);
    }
  }
  return bestUrl;
}

export function parseInstagramStoryItem(item: Record<string, unknown>): RawInstagramStory | null {
  const rawId = String(item.pk || item.id || '').trim();
  const id = rawId.replace(/^(\d+)_\d+$/, '$1');
  if (!id) return null;

  const videoUrl = pickBestCandidate(
    item.video_versions as Array<{ url?: string; width?: number; height?: number }> | undefined
  );
  const imgCandidates = (
    item.image_versions2 as
      | { candidates?: Array<{ url?: string; width?: number; height?: number }> }
      | undefined
  )?.candidates;
  const bestPhoto = pickBestCandidate(imgCandidates);
  const firstThumb =
    (typeof imgCandidates?.[0]?.url === 'string' && unescapeInstagramUrl(imgCandidates[0].url)) ||
    bestPhoto;

  const isVideo = item.media_type === 2 || Boolean(videoUrl);

  return {
    id,
    takenAt: typeof item.taken_at === 'number' ? item.taken_at : undefined,
    expiringAt: typeof item.expiring_at === 'number' ? item.expiring_at : undefined,
    videoUrl: isVideo && videoUrl ? videoUrl : undefined,
    photoUrls: !isVideo && bestPhoto ? [bestPhoto] : undefined,
    thumbnailUrl: firstThumb || null,
  };
}

function parseStoryItemsArray(items: unknown): RawInstagramStory[] {
  if (!Array.isArray(items)) return [];
  const stories: RawInstagramStory[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const parsed = parseInstagramStoryItem(raw as Record<string, unknown>);
    if (parsed) stories.push(parsed);
  }
  return stories;
}

export function extractInstagramStoriesFromWebHtml(html: string): RawInstagramStory[] {
  const marker = '"xdt_api__v1__feed__reels_media":';
  const idx = html.indexOf(marker);
  if (idx === -1) return [];

  const start = idx + marker.length;
  let depth = 0;
  let end = start;
  for (let i = start; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end <= start) return [];

  try {
    const jsonStr = html.slice(start, end);
    const data = JSON.parse(jsonStr);
    const reels = data?.reels_media || [];
    const stories: RawInstagramStory[] = [];
    for (const reel of reels) {
      for (const item of reel?.items || []) {
        const parsed = parseInstagramStoryItem(item);
        if (parsed) stories.push(parsed);
      }
    }
    return stories;
  } catch {
    return [];
  }
}

async function defaultFetchInstagramStories(
  username: string,
  rawCookie: string
): Promise<InstagramStoryFetchOutput> {
  const formattedCookie = formatInstagramCookie(rawCookie);
  const usedCookie = Boolean(formattedCookie);

  // Tier 1 (Primary for Web Sessions): Direct Web Stories SSR Page
  if (usedCookie) {
    const webStoriesUrl = `https://www.instagram.com/stories/${encodeURIComponent(username)}/`;
    const webResp = await fetchWithTimeout(webStoriesUrl, {
      headers: {
        'User-Agent': IG_WEB_USER_AGENT,
        Cookie: formattedCookie,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        Referer: `https://www.instagram.com/${encodeURIComponent(username)}/`,
      },
      timeoutMs: 12000,
    });

    const webHtml = webResp.text || '';
    if (webResp.status === 200 && webHtml) {
      const parsedStories = extractInstagramStoriesFromWebHtml(webHtml);
      if (parsedStories.length > 0) {
        return {
          status: 'OK',
          stories: parsedStories,
          httpStatus: 200,
          usedCookie: true,
        };
      }
      if (
        webHtml.includes('"xdt_api__v1__feed__reels_media"') ||
        webHtml.includes('StoriesPage_') ||
        /"reels_media":\s*\[\]/.test(webHtml)
      ) {
        return {
          status: 'OK',
          stories: [],
          httpStatus: 200,
          usedCookie: true,
        };
      }
    }

    const webFail = classifyInstagramFailure(webResp.status, webResp.url, webHtml, true);
    if (webFail?.status === 'AUTH_REQUIRED' || webFail?.status === 'PRIVATE') {
      return {
        status: webFail.status,
        stories: [],
        reason: webFail.reason,
        httpStatus: webFail.httpStatus,
        usedCookie: true,
      };
    }
  }

  // Tier 2: Mobile / Private API fallback
  const userRes = await resolveInstagramUserId(username, formattedCookie);
  if (userRes.failureResult) {
    return {
      status: userRes.failureResult.status,
      stories: [],
      reason: userRes.failureResult.reason,
      httpStatus: userRes.failureResult.httpStatus,
      usedCookie,
    };
  }
  if (!userRes.userId) {
    return {
      status: usedCookie ? 'BLOCKED' : 'AUTH_REQUIRED',
      stories: [],
      reason: usedCookie
        ? `Không thể phân giải userId Instagram cho @${username}`
        : 'Instagram Stories yêu cầu cookie sessionid để truy cập',
      usedCookie,
    };
  }

  const userId = userRes.userId;
  let lastFailure: InstagramStoryFetchOutput | null = null;

  // Endpoint 1: i.instagram.com/api/v1/feed/user/{userId}/story/
  const ep1Url = `https://i.instagram.com/api/v1/feed/user/${encodeURIComponent(
    userId
  )}/story/`;
  const resp1 = await fetchWithTimeout(ep1Url, {
    headers: buildInstagramMobileApiHeaders(username, formattedCookie),
    timeoutMs: 10000,
  });

  const fail1 = classifyInstagramFailure(resp1.status, resp1.url, resp1.text, usedCookie);
  if (fail1) {
    lastFailure = {
      status: fail1.status,
      stories: [],
      reason:
        fail1.status === 'AUTH_REQUIRED' && !usedCookie
          ? 'Instagram Stories yêu cầu cookie sessionid để xem'
          : fail1.reason,
      httpStatus: fail1.httpStatus,
      usedCookie,
    };
  } else if (resp1.ok && resp1.text) {
    const json = safeJsonParse<{
      status?: string;
      message?: string;
      reel?: {
        items?: unknown[];
        user?: { is_private?: boolean };
      } | null;
    }>(resp1.text);

    if (json?.reel === null && json?.status === 'ok') {
      return { status: 'OK', stories: [], httpStatus: resp1.status, usedCookie };
    }
    if (json?.reel?.user?.is_private && (!json.reel.items || json.reel.items.length === 0)) {
      if (json.message && /not authorized/i.test(json.message)) {
        return {
          status: 'PRIVATE',
          stories: [],
          reason: 'Tài khoản Instagram ở chế độ riêng tư',
          httpStatus: resp1.status,
          usedCookie,
        };
      }
    }
    if (json?.reel && Array.isArray(json.reel.items)) {
      return {
        status: 'OK',
        stories: parseStoryItemsArray(json.reel.items),
        httpStatus: resp1.status,
        usedCookie,
      };
    }
  }

  // Endpoint 2: i.instagram.com/api/v1/feed/reels_media/?reel_ids={userId}
  const ep2Url = `https://i.instagram.com/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(
    userId
  )}`;
  const resp2 = await fetchWithTimeout(ep2Url, {
    headers: buildInstagramMobileApiHeaders(username, formattedCookie),
    timeoutMs: 10000,
  });

  const fail2 = classifyInstagramFailure(resp2.status, resp2.url, resp2.text, usedCookie);
  if (fail2) {
    lastFailure = {
      status: fail2.status,
      stories: [],
      reason:
        fail2.status === 'AUTH_REQUIRED' && !usedCookie
          ? 'Instagram Stories yêu cầu cookie sessionid để xem'
          : fail2.reason,
      httpStatus: fail2.httpStatus,
      usedCookie,
    };
  } else if (resp2.ok && resp2.text) {
    const json = safeJsonParse<{
      status?: string;
      reels?: Record<string, { items?: unknown[] }>;
      reels_media?: Array<{ items?: unknown[] }>;
    }>(resp2.text);

    const items =
      json?.reels?.[userId]?.items ??
      (Array.isArray(json?.reels_media) ? json.reels_media[0]?.items : undefined);

    if (Array.isArray(items)) {
      return {
        status: 'OK',
        stories: parseStoryItemsArray(items),
        httpStatus: resp2.status,
        usedCookie,
      };
    }
    if (json?.status === 'ok') {
      return { status: 'OK', stories: [], httpStatus: resp2.status, usedCookie };
    }
  }

  // Endpoint 3: Web fallback if cookie is set and mobile returned 400/403
  if (usedCookie) {
    const ep3Url = `https://www.instagram.com/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(
      userId
    )}`;
    const resp3 = await fetchWithTimeout(ep3Url, {
      headers: buildInstagramWebApiHeaders(username, formattedCookie),
      timeoutMs: 10000,
    });
    const fail3 = classifyInstagramFailure(resp3.status, resp3.url, resp3.text, usedCookie);
    if (fail3) {
      lastFailure = {
        status: fail3.status,
        stories: [],
        reason: fail3.reason,
        httpStatus: fail3.httpStatus,
        usedCookie,
      };
    } else if (resp3.ok && resp3.text) {
      const json = safeJsonParse<{
        status?: string;
        reels?: Record<string, { items?: unknown[] }>;
        reels_media?: Array<{ items?: unknown[] }>;
      }>(resp3.text);

      const items =
        json?.reels?.[userId]?.items ??
        (Array.isArray(json?.reels_media) ? json.reels_media[0]?.items : undefined);

      if (Array.isArray(items)) {
        return {
          status: 'OK',
          stories: parseStoryItemsArray(items),
          httpStatus: resp3.status,
          usedCookie,
        };
      }
      if (json?.status === 'ok') {
        return { status: 'OK', stories: [], httpStatus: resp3.status, usedCookie };
      }
    }
  }

  return (
    lastFailure || {
      status: usedCookie ? 'BLOCKED' : 'AUTH_REQUIRED',
      stories: [],
      reason: usedCookie
        ? 'Không thể lấy Story Instagram (có thể bị chặn hoặc cookie hết hạn)'
        : 'Instagram Stories yêu cầu cookie sessionid để xem',
      usedCookie,
    }
  );
}

export class InstagramStoryCollector implements PlatformCollector<WatcherEvent> {
  readonly name = 'instagram_story';
  readonly platform: LivePlatform = 'INSTAGRAM';
  readonly eventType: WatcherEventType = 'story';
  readonly supported = true;

  private cookie: string;
  private customFetcher?: InstagramStoryFetcherFn;

  constructor(options?: InstagramStoryCollectorOptions) {
    this.cookie = normalizeCookieValue(options?.cookie);
    this.customFetcher = options?.fetcher;
  }

  setCookie(cookie: string): void {
    this.cookie = normalizeCookieValue(cookie);
  }

  private mapStoriesToEvents(username: string, rawStories: RawInstagramStory[]): WatcherEvent[] {
    const events: WatcherEvent[] = [];

    for (const story of rawStories) {
      const itemId = String(story.id || '').trim();
      if (!itemId) continue;

      const photoUrls = Array.isArray(story.photoUrls) ? story.photoUrls.filter(Boolean) : [];
      const videoUrl = story.videoUrl?.trim() || undefined;

      events.push({
        platform: 'INSTAGRAM',
        username,
        eventType: 'story',
        itemId,
        url: `https://www.instagram.com/stories/${encodeURIComponent(username)}/${encodeURIComponent(
          itemId
        )}/`,
        title: `Instagram Story from @${username}`,
        thumbnailUrl: story.thumbnailUrl || photoUrls[0] || null,
        detectedAt: story.takenAt
          ? new Date(story.takenAt * 1000).toISOString()
          : new Date().toISOString(),
        metadata: {
          createTime: story.takenAt,
          expireTime: story.expiringAt,
          videoUrl,
          photoUrls: photoUrls.length > 0 ? photoUrls : undefined,
          downloadHeaders: {
            Referer: 'https://www.instagram.com/',
            'User-Agent': IG_MOBILE_USER_AGENT,
          },
        },
      });
    }

    return events;
  }

  async fetchWithDiagnostics(rawUsername: string): Promise<CollectorFetchResult<WatcherEvent>> {
    const formattedCookie = formatInstagramCookie(this.cookie);
    const usedCookie = Boolean(formattedCookie);
    const username = normalizeUsername(rawUsername, 'INSTAGRAM');
    if (!username) {
      return {
        status: 'NOT_FOUND',
        events: [],
        reason: 'Username Instagram không hợp lệ',
        usedCookie,
      };
    }

    try {
      if (this.customFetcher) {
        const fetched = await this.customFetcher(username, formattedCookie);
        if (Array.isArray(fetched)) {
          return {
            status: 'OK',
            events: this.mapStoriesToEvents(username, fetched),
            usedCookie,
          };
        }
        return {
          status: fetched.status,
          events: this.mapStoriesToEvents(username, fetched.stories),
          reason: fetched.reason,
          httpStatus: fetched.httpStatus,
          usedCookie: fetched.usedCookie ?? usedCookie,
        };
      }

      const res = await defaultFetchInstagramStories(username, this.cookie);
      return {
        status: res.status,
        events: this.mapStoriesToEvents(username, res.stories),
        reason: res.reason,
        httpStatus: res.httpStatus,
        usedCookie: res.usedCookie ?? usedCookie,
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

  async fetch(rawUsername: string): Promise<WatcherEvent[]> {
    const result = await this.fetchWithDiagnostics(rawUsername);
    if (result.status === 'ERROR') {
      throw new Error(result.reason || 'Instagram story fetch failed');
    }
    return result.events;
  }
}
