import { fetchWithTimeout } from '../../liveCheckers/httpClient';
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
  buildFacebookNavHeaders,
  classifyFacebookHtml,
  extractFacebookNumericIdFromHtml,
  extractJsonScriptBlocks,
  FB_DESKTOP_USER_AGENT,
  isNumericFacebookId,
  unescapeFacebookUrl,
} from './facebookShared';

export interface RawFacebookStory {
  id: string;
  bucketId?: string;
  createTime?: number;
  videoUrl?: string;
  photoUrls?: string[];
  thumbnailUrl?: string | null;
}

export interface FacebookStoryFetchOutput {
  status: CollectorStatus;
  stories: RawFacebookStory[];
  reason?: string;
  httpStatus?: number;
  usedCookie?: boolean;
}

export type FacebookStoryFetcherFn = (
  target: string,
  cookie: string
) => Promise<FacebookStoryFetchOutput | RawFacebookStory[]>;

export interface FacebookStoryCollectorOptions {
  cookie?: string;
  fetcher?: FacebookStoryFetcherFn;
}

function parseStoryCard(
  card: Record<string, unknown>,
  bucketId: string
): RawFacebookStory | null {
  const id = String(card.id || card.story_card_id || '').trim();
  if (!id) return null;

  let videoUrl: string | undefined;
  const photoUrls: string[] = [];
  let thumbnailUrl: string | null = null;

  const attachments = (card.attachments as Array<Record<string, unknown>> | undefined) || [];
  for (const att of attachments) {
    const media = (att?.media as Record<string, unknown> | undefined) || att;
    if (!media) continue;

    const vCandidate =
      (typeof media.playable_url_quality_hd === 'string' && media.playable_url_quality_hd) ||
      (typeof media.playable_url === 'string' && media.playable_url) ||
      (typeof media.browser_native_hd_url === 'string' && media.browser_native_hd_url) ||
      (typeof media.browser_native_sd_url === 'string' && media.browser_native_sd_url) ||
      '';
    if (vCandidate && !videoUrl) {
      videoUrl = unescapeFacebookUrl(vCandidate);
    }

    const prefThumb = media.preferred_thumbnail as { image?: { uri?: string } } | undefined;
    const thumbImg = media.thumbnailImage as { uri?: string } | undefined;
    if (typeof prefThumb?.image?.uri === 'string') {
      thumbnailUrl = unescapeFacebookUrl(prefThumb.image.uri);
    } else if (typeof thumbImg?.uri === 'string') {
      thumbnailUrl = unescapeFacebookUrl(thumbImg.uri);
    }

    const imgUri =
      (media.image as { uri?: string } | undefined)?.uri ||
      (media.photo_image as { uri?: string } | undefined)?.uri ||
      '';
    if (imgUri && !videoUrl) {
      const cleanImg = unescapeFacebookUrl(imgUri);
      photoUrls.push(cleanImg);
      if (!thumbnailUrl) thumbnailUrl = cleanImg;
    }
  }

  return {
    id,
    bucketId,
    createTime: typeof card.creation_time === 'number' ? card.creation_time : undefined,
    videoUrl,
    photoUrls: photoUrls.length > 0 ? photoUrls : undefined,
    thumbnailUrl,
  };
}

function walkFacebookStoryNodes(
  node: unknown,
  fallbackBucketId: string,
  stories: RawFacebookStory[],
  seenIds: Set<string>
): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) {
      walkFacebookStoryNodes(item, fallbackBucketId, stories, seenIds);
    }
    return;
  }

  const obj = node as Record<string, unknown>;

  const buckets = obj.unified_stories_buckets as
    | { edges?: Array<{ node?: Record<string, unknown> }>; nodes?: Array<Record<string, unknown>> }
    | undefined;
  const bucketList = buckets?.edges?.map((e) => e?.node).filter(Boolean) || buckets?.nodes;

  if (Array.isArray(bucketList)) {
    for (const bucket of bucketList) {
      if (!bucket) continue;
      const bucketId = String(bucket.id || fallbackBucketId);
      const unifiedStories = bucket.unified_stories as
        | { edges?: Array<{ node?: Record<string, unknown> }>; nodes?: Array<Record<string, unknown>> }
        | undefined;
      const cards =
        unifiedStories?.edges?.map((e) => e?.node).filter(Boolean) ||
        unifiedStories?.nodes ||
        (bucket.nodes as Array<Record<string, unknown>> | undefined);

      if (Array.isArray(cards)) {
        for (const card of cards) {
          if (!card) continue;
          const parsed = parseStoryCard(card, bucketId);
          if (parsed && !seenIds.has(parsed.id)) {
            seenIds.add(parsed.id);
            stories.push(parsed);
          }
        }
      }
    }
  }

  const unifiedStoriesDirect = obj.unified_stories as
    | { edges?: Array<{ node?: Record<string, unknown> }>; nodes?: Array<Record<string, unknown>> }
    | undefined;
  if (unifiedStoriesDirect) {
    const bucketId = String(obj.id || fallbackBucketId);
    const cards =
      unifiedStoriesDirect.edges?.map((e) => e?.node).filter(Boolean) ||
      unifiedStoriesDirect.nodes;
    if (Array.isArray(cards)) {
      for (const card of cards) {
        if (!card) continue;
        const parsed = parseStoryCard(card, bucketId);
        if (parsed && !seenIds.has(parsed.id)) {
          seenIds.add(parsed.id);
          stories.push(parsed);
        }
      }
    }
  }

  for (const val of Object.values(obj)) {
    if (val && typeof val === 'object') {
      walkFacebookStoryNodes(val, fallbackBucketId, stories, seenIds);
    }
  }
}

export function parseFacebookStoriesFromHtml(
  html: string,
  target: string
): RawFacebookStory[] {
  const stories: RawFacebookStory[] = [];
  const seenIds = new Set<string>();

  const jsonBlocks = extractJsonScriptBlocks(html);
  for (const block of jsonBlocks) {
    walkFacebookStoryNodes(block, target, stories, seenIds);
  }

  if (stories.length > 0) {
    return stories;
  }

  // Regex fallback for story_card_id
  const cardMatches = html.matchAll(/"story_card_id"\s*:\s*"?(\d{6,24})"?/g);
  for (const m of cardMatches) {
    const id = m[1];
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);

    const startIdx = Math.max(0, (m.index ?? 0) - 400);
    const endIdx = Math.min(html.length, (m.index ?? 0) + 2000);
    const win = html.slice(startIdx, endIdx);

    const hdMatch = win.match(/"playable_url_quality_hd"\s*:\s*"([^"]+)"/);
    const sdMatch = win.match(/"playable_url"\s*:\s*"([^"]+)"/);
    const imgMatch = win.match(/"(?:photo_image|image)"\s*:\s*\{\s*"uri"\s*:\s*"([^"]+)"/);

    const videoUrl = hdMatch?.[1]
      ? unescapeFacebookUrl(hdMatch[1])
      : sdMatch?.[1]
      ? unescapeFacebookUrl(sdMatch[1])
      : undefined;
    const photoUrl = !videoUrl && imgMatch?.[1] ? unescapeFacebookUrl(imgMatch[1]) : undefined;

    stories.push({
      id,
      bucketId: target,
      videoUrl,
      photoUrls: photoUrl ? [photoUrl] : undefined,
      thumbnailUrl: photoUrl || null,
    });
  }

  return stories;
}

async function defaultFetchFacebookStories(
  target: string,
  cookie: string
): Promise<FacebookStoryFetchOutput> {
  const usedCookie = Boolean(cookie);
  const storyUrl = `https://www.facebook.com/stories/${encodeURIComponent(target)}`;

  const resp1 = await fetchWithTimeout(storyUrl, {
    headers: buildFacebookNavHeaders(cookie, false),
    timeoutMs: 12000,
  });

  if (resp1.ok && resp1.text) {
    const stories1 = parseFacebookStoriesFromHtml(resp1.text, target);
    if (stories1.length > 0) {
      return {
        status: 'OK',
        stories: stories1,
        httpStatus: resp1.status,
        usedCookie,
      };
    }
  }

  const fail1 = classifyFacebookHtml(
    resp1.status,
    resp1.url,
    resp1.text || '',
    usedCookie
  );

  // If non-numeric handle and stories page redirected or yielded no bucket, check profile for numeric ID or embedded story buckets
  let resolvedId: string | null = isNumericFacebookId(target) ? target : null;
  if (!resolvedId) {
    const profileUrl = `https://www.facebook.com/${encodeURIComponent(target)}`;
    const profileResp = await fetchWithTimeout(profileUrl, {
      headers: buildFacebookNavHeaders(cookie, false),
      timeoutMs: 12000,
    });
    if (profileResp.ok && profileResp.text) {
      const embeddedStories = parseFacebookStoriesFromHtml(profileResp.text, target);
      if (embeddedStories.length > 0) {
        return {
          status: 'OK',
          stories: embeddedStories,
          httpStatus: profileResp.status,
          usedCookie,
        };
      }
      resolvedId = extractFacebookNumericIdFromHtml(profileResp.text);
    } else {
      const profileFail = classifyFacebookHtml(
        profileResp.status,
        profileResp.url,
        profileResp.text || '',
        usedCookie
      );
      if (profileFail?.status === 'NOT_FOUND') {
        return {
          status: 'NOT_FOUND',
          stories: [],
          reason: profileFail.reason,
          httpStatus: profileFail.httpStatus,
          usedCookie,
        };
      }
    }

    if (resolvedId) {
      const numericStoryUrl = `https://www.facebook.com/stories/${encodeURIComponent(resolvedId)}`;
      const respNumeric = await fetchWithTimeout(numericStoryUrl, {
        headers: buildFacebookNavHeaders(cookie, false),
        timeoutMs: 12000,
      });
      if (respNumeric.ok && respNumeric.text) {
        const storiesNum = parseFacebookStoriesFromHtml(respNumeric.text, resolvedId);
        if (storiesNum.length > 0) {
          return {
            status: 'OK',
            stories: storiesNum,
            httpStatus: respNumeric.status,
            usedCookie,
          };
        }
      }
      const failNum = classifyFacebookHtml(
        respNumeric.status,
        respNumeric.url,
        respNumeric.text || '',
        usedCookie
      );
      if (failNum) {
        return {
          status: failNum.status,
          stories: [],
          reason: failNum.reason,
          httpStatus: failNum.httpStatus,
          usedCookie,
        };
      }
      if (respNumeric.ok) {
        return {
          status: 'OK',
          stories: [],
          httpStatus: respNumeric.status,
          usedCookie,
        };
      }
    }
  }

  // Mobile fallback
  if (fail1?.status === 'BLOCKED' || fail1?.status === 'AUTH_REQUIRED' || !resp1.ok) {
    const idOrTarget = resolvedId || target;
    const mobileStoryUrl = `https://m.facebook.com/stories/${encodeURIComponent(idOrTarget)}`;
    const mobileResp = await fetchWithTimeout(mobileStoryUrl, {
      headers: buildFacebookNavHeaders(cookie, true),
      timeoutMs: 12000,
    });
    if (mobileResp.ok && mobileResp.text) {
      const mobileStories = parseFacebookStoriesFromHtml(mobileResp.text, idOrTarget);
      if (mobileStories.length > 0) {
        return {
          status: 'OK',
          stories: mobileStories,
          httpStatus: mobileResp.status,
          usedCookie,
        };
      }
    }
    const mobileFail = classifyFacebookHtml(
      mobileResp.status,
      mobileResp.url,
      mobileResp.text || '',
      usedCookie
    );
    if (mobileFail) {
      return {
        status: mobileFail.status,
        stories: [],
        reason: mobileFail.reason,
        httpStatus: mobileFail.httpStatus,
        usedCookie,
      };
    }
  }

  if (fail1) {
    return {
      status: fail1.status,
      stories: [],
      reason: fail1.reason,
      httpStatus: fail1.httpStatus,
      usedCookie,
    };
  }

  return {
    status: 'OK',
    stories: [],
    httpStatus: resp1.status,
    usedCookie,
  };
}

export class FacebookStoryCollector implements PlatformCollector<WatcherEvent> {
  readonly name = 'facebook_story';
  readonly platform: LivePlatform = 'FACEBOOK';
  readonly eventType: WatcherEventType = 'story';
  readonly supported = true;

  private cookie: string;
  private customFetcher?: FacebookStoryFetcherFn;

  constructor(options?: FacebookStoryCollectorOptions) {
    this.cookie = normalizeCookieValue(options?.cookie);
    this.customFetcher = options?.fetcher;
  }

  setCookie(cookie: string): void {
    this.cookie = normalizeCookieValue(cookie);
  }

  private mapStoriesToEvents(target: string, rawStories: RawFacebookStory[]): WatcherEvent[] {
    const events: WatcherEvent[] = [];

    for (const story of rawStories) {
      const itemId = String(story.id || '').trim();
      if (!itemId) continue;

      const bucketId = story.bucketId || target;
      const photoUrls = Array.isArray(story.photoUrls) ? story.photoUrls.filter(Boolean) : [];
      const videoUrl = story.videoUrl?.trim() || undefined;

      events.push({
        platform: 'FACEBOOK',
        username: target,
        eventType: 'story',
        itemId,
        url: `https://www.facebook.com/stories/${encodeURIComponent(bucketId)}/${encodeURIComponent(
          itemId
        )}/`,
        title: `Facebook Story from @${target}`,
        thumbnailUrl: story.thumbnailUrl || photoUrls[0] || null,
        detectedAt: story.createTime
          ? new Date(story.createTime * 1000).toISOString()
          : new Date().toISOString(),
        metadata: {
          createTime: story.createTime,
          videoUrl,
          photoUrls: photoUrls.length > 0 ? photoUrls : undefined,
          downloadHeaders: {
            Referer: 'https://www.facebook.com/',
            'User-Agent': FB_DESKTOP_USER_AGENT,
          },
        },
      });
    }

    return events;
  }

  async fetchWithDiagnostics(rawUsername: string): Promise<CollectorFetchResult<WatcherEvent>> {
    const usedCookie = Boolean(this.cookie);
    const target = normalizeUsername(rawUsername, 'FACEBOOK');
    if (!target || target.startsWith('video_')) {
      return {
        status: 'NOT_FOUND',
        events: [],
        reason: 'Username hoặc ID Facebook không hợp lệ',
        usedCookie,
      };
    }

    try {
      if (this.customFetcher) {
        const fetched = await this.customFetcher(target, this.cookie);
        if (Array.isArray(fetched)) {
          return {
            status: 'OK',
            events: this.mapStoriesToEvents(target, fetched),
            usedCookie,
          };
        }
        return {
          status: fetched.status,
          events: this.mapStoriesToEvents(target, fetched.stories),
          reason: fetched.reason,
          httpStatus: fetched.httpStatus,
          usedCookie: fetched.usedCookie ?? usedCookie,
        };
      }

      const res = await defaultFetchFacebookStories(target, this.cookie);
      return {
        status: res.status,
        events: this.mapStoriesToEvents(target, res.stories),
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
      throw new Error(result.reason || 'Facebook story fetch failed');
    }
    return result.events;
  }
}
