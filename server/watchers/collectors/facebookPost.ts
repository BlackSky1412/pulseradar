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
  extractJsonScriptBlocks,
  FB_DESKTOP_USER_AGENT,
  isNumericFacebookId,
  unescapeFacebookJson,
  unescapeFacebookUrl,
} from './facebookShared';

export interface RawFacebookPost {
  id: string;
  url?: string;
  title?: string;
  thumbnailUrl?: string | null;
  createTime?: number;
  isPinned?: boolean;
  videoUrl?: string;
  photoUrls?: string[];
}

export interface FacebookPostFetchOutput {
  status: CollectorStatus;
  posts: RawFacebookPost[];
  reason?: string;
  httpStatus?: number;
  usedCookie?: boolean;
}

export type FacebookPostFetcherFn = (
  target: string,
  topN: number,
  cookie: string
) => Promise<FacebookPostFetchOutput | RawFacebookPost[]>;

export interface FacebookPostCollectorOptions {
  topN?: number;
  skipPinned?: boolean;
  cookie?: string;
  fetcher?: FacebookPostFetcherFn;
}

function extractIdFromPermalink(permalink: string): string {
  if (!permalink) return '';
  const storyFbid = permalink.match(/[?&]story_fbid=(pfbid[a-zA-Z0-9]+|\d+)/i);
  if (storyFbid?.[1]) return storyFbid[1];
  const pathId = permalink.match(/\/(?:posts|videos|reel)\/(pfbid[a-zA-Z0-9]+|\d+)/i);
  if (pathId?.[1]) return pathId[1];
  return '';
}

function buildDefaultPermalink(target: string, itemId: string): string {
  if (isNumericFacebookId(target)) {
    return `https://www.facebook.com/permalink.php?story_fbid=${encodeURIComponent(
      itemId
    )}&id=${encodeURIComponent(target)}`;
  }
  return `https://www.facebook.com/${encodeURIComponent(target)}/posts/${encodeURIComponent(
    itemId
  )}`;
}

function collectMediaFromAttachment(
  att: Record<string, unknown>,
  videoUrls: string[],
  photoUrls: string[],
  thumbs: string[]
): void {
  const media = (att.media as Record<string, unknown> | undefined) || att;

  const videoCandidate =
    (typeof media.playable_url_quality_hd === 'string' && media.playable_url_quality_hd) ||
    (typeof media.playable_url === 'string' && media.playable_url) ||
    (typeof media.browser_native_hd_url === 'string' && media.browser_native_hd_url) ||
    (typeof media.browser_native_sd_url === 'string' && media.browser_native_sd_url) ||
    '';
  if (videoCandidate) {
    videoUrls.push(unescapeFacebookUrl(videoCandidate));
  }

  const photoObj =
    (media.photo_image as { uri?: string } | undefined) ||
    (media.viewer_image as { uri?: string } | undefined) ||
    (media.image as { uri?: string } | undefined);
  if (typeof photoObj?.uri === 'string' && photoObj.uri.trim() && !videoCandidate) {
    photoUrls.push(unescapeFacebookUrl(photoObj.uri));
  }

  const prefThumb = media.preferred_thumbnail as { image?: { uri?: string } } | undefined;
  if (typeof prefThumb?.image?.uri === 'string' && prefThumb.image.uri.trim()) {
    thumbs.push(unescapeFacebookUrl(prefThumb.image.uri));
  }

  // Handle subattachments (multi-photo albums)
  const styles = att.styles as Record<string, unknown> | undefined;
  const attachment = (styles?.attachment as Record<string, unknown> | undefined) || att;
  const sub = attachment.all_subattachments as
    | { nodes?: Array<Record<string, unknown>> }
    | undefined;
  if (Array.isArray(sub?.nodes)) {
    for (const subNode of sub.nodes) {
      collectMediaFromAttachment(subNode, videoUrls, photoUrls, thumbs);
    }
  }
}

function walkFacebookPostNodes(
  node: unknown,
  target: string,
  posts: RawFacebookPost[],
  seenIds: Set<string>
): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) {
      walkFacebookPostNodes(item, target, posts, seenIds);
    }
    return;
  }

  const obj = node as Record<string, unknown>;
  const cometSections = obj.comet_sections as Record<string, unknown> | undefined;
  const contentStory = (
    (cometSections?.content as Record<string, unknown> | undefined)?.story as
      | Record<string, unknown>
      | undefined
  );

  const rawPermalink =
    (typeof obj.wwwURL === 'string' && obj.wwwURL) ||
    (typeof obj.url === 'string' && obj.url) ||
    (typeof contentStory?.wwwURL === 'string' && contentStory.wwwURL) ||
    '';
  const permalink = rawPermalink ? unescapeFacebookUrl(rawPermalink) : '';

  const rawPostId =
    (obj.post_id ? String(obj.post_id) : '') ||
    (obj.legacy_fbid ? String(obj.legacy_fbid) : '') ||
    (contentStory?.post_id ? String(contentStory.post_id) : '') ||
    extractIdFromPermalink(permalink);

  const hasPostMarker = Boolean(
    obj.post_id || obj.story_fbid || contentStory?.post_id || cometSections?.content
  );

  if (hasPostMarker && rawPostId) {
    if (!seenIds.has(rawPostId)) {
      seenIds.add(rawPostId);

      const headerContext = obj.header_context || cometSections?.context_layout;
      const isPinned = Boolean(
        obj.is_pinned ||
          (headerContext && /pinned post|bài viết đã ghim/i.test(JSON.stringify(headerContext)))
      );

      const messageObj =
        (contentStory?.message as { text?: string } | undefined) ||
        (obj.message as { text?: string } | undefined);
      const title = typeof messageObj?.text === 'string' ? messageObj.text.trim() : '';

      const createTime =
        typeof obj.creation_time === 'number'
          ? obj.creation_time
          : typeof obj.publish_time === 'number'
          ? obj.publish_time
          : undefined;

      const videoUrls: string[] = [];
      const photoUrls: string[] = [];
      const thumbs: string[] = [];

      const attachments =
        (contentStory?.attachments as Array<Record<string, unknown>> | undefined) ||
        (obj.attachments as Array<Record<string, unknown>> | undefined) ||
        [];
      for (const att of attachments) {
        if (att && typeof att === 'object') {
          collectMediaFromAttachment(att, videoUrls, photoUrls, thumbs);
        }
      }

      const uniquePhotos = Array.from(new Set(photoUrls));
      posts.push({
        id: rawPostId,
        url: permalink || buildDefaultPermalink(target, rawPostId),
        title,
        thumbnailUrl: thumbs[0] || uniquePhotos[0] || null,
        createTime,
        isPinned,
        videoUrl: videoUrls[0] || undefined,
        photoUrls: uniquePhotos.length > 0 ? uniquePhotos : undefined,
      });
    }
  }

  for (const val of Object.values(obj)) {
    if (val && typeof val === 'object') {
      walkFacebookPostNodes(val, target, posts, seenIds);
    }
  }
}

export function parseFacebookPostsFromHtml(
  html: string,
  target: string,
  _topN: number = 10
): RawFacebookPost[] {
  const posts: RawFacebookPost[] = [];
  const seenIds = new Set<string>();

  // Layer 1: JSON script traversal
  const jsonBlocks = extractJsonScriptBlocks(html);
  for (const block of jsonBlocks) {
    walkFacebookPostNodes(block, target, posts, seenIds);
  }

  if (posts.length > 0) {
    return posts;
  }

  // Layer 2: HTML regex fallback (never use profile og:image!)
  const idPatterns = [
    /"post_id"\s*:\s*"(\d{8,22})"/g,
    /"story_fbid"\s*:\s*"?(pfbid[a-zA-Z0-9]+|\d{8,22})"?/g,
    /facebook\.com\/(?:[^/"\\]+\/posts\/|permalink\.php\?story_fbid=|[^/"\\]+\/videos\/|reel\/)(pfbid[a-zA-Z0-9]+|\d{8,22})/g,
  ];

  for (const pattern of idPatterns) {
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(html)) !== null) {
      const id = m[1]?.trim();
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);

      const startIdx = Math.max(0, m.index - 500);
      const endIdx = Math.min(html.length, m.index + 2500);
      const win = html.slice(startIdx, endIdx);

      const hdMatch = win.match(/"playable_url_quality_hd"\s*:\s*"([^"]+)"/);
      const sdMatch = win.match(/"playable_url"\s*:\s*"([^"]+)"/);
      const photoMatch = win.match(/"photo_image"\s*:\s*\{\s*"uri"\s*:\s*"([^"]+)"/);
      const msgMatch = win.match(/"message"\s*:\s*\{\s*"text"\s*:\s*"([^"]*)"/);
      const timeMatch = win.match(/"creation_time"\s*:\s*(\d+)/);
      const urlMatch = win.match(/"(?:wwwURL|url)"\s*:\s*"(https?:\\?\/\\?\/[^"]*facebook\.com[^"]*)"/);

      const videoUrl = hdMatch?.[1]
        ? unescapeFacebookUrl(hdMatch[1])
        : sdMatch?.[1]
        ? unescapeFacebookUrl(sdMatch[1])
        : undefined;
      const photoUrl = !videoUrl && photoMatch?.[1] ? unescapeFacebookUrl(photoMatch[1]) : undefined;
      const permalink = urlMatch?.[1]
        ? unescapeFacebookUrl(urlMatch[1])
        : buildDefaultPermalink(target, id);

      posts.push({
        id,
        url: permalink,
        title: msgMatch?.[1] ? unescapeFacebookJson(msgMatch[1]) : '',
        thumbnailUrl: photoUrl || null,
        createTime: timeMatch?.[1] ? Number(timeMatch[1]) : undefined,
        isPinned: /pinned post|bài viết đã ghim|"is_pinned"\s*:\s*true/i.test(win),
        videoUrl,
        photoUrls: photoUrl ? [photoUrl] : undefined,
      });
    }
  }

  return posts;
}

async function defaultFetchFacebookPosts(
  target: string,
  topN: number,
  cookie: string
): Promise<FacebookPostFetchOutput> {
  const usedCookie = Boolean(cookie);
  const desktopUrl = isNumericFacebookId(target)
    ? `https://www.facebook.com/profile.php?id=${encodeURIComponent(target)}`
    : `https://www.facebook.com/${encodeURIComponent(target)}`;

  const desktopResp = await fetchWithTimeout(desktopUrl, {
    headers: buildFacebookNavHeaders(cookie, false),
    timeoutMs: 12000,
  });

  const desktopPosts =
    desktopResp.ok && desktopResp.text
      ? parseFacebookPostsFromHtml(desktopResp.text, target, topN)
      : [];

  if (desktopPosts.length > 0) {
    return {
      status: 'OK',
      posts: desktopPosts,
      httpStatus: desktopResp.status,
      usedCookie,
    };
  }

  const desktopFailure = classifyFacebookHtml(
    desktopResp.status,
    desktopResp.url,
    desktopResp.text || '',
    usedCookie
  );

  // If definitive NOT_FOUND on desktop, return immediately
  if (desktopFailure?.status === 'NOT_FOUND') {
    return {
      status: 'NOT_FOUND',
      posts: [],
      reason: desktopFailure.reason,
      httpStatus: desktopFailure.httpStatus,
      usedCookie,
    };
  }

  // Mobile fallback ONLY when desktop yielded 0 posts and was blocked/redirected/non-ok
  const shouldTryMobile =
    !desktopResp.ok ||
    desktopFailure?.status === 'BLOCKED' ||
    desktopFailure?.status === 'AUTH_REQUIRED';

  if (shouldTryMobile) {
    const mobileUrl = isNumericFacebookId(target)
      ? `https://m.facebook.com/profile.php?id=${encodeURIComponent(target)}`
      : `https://m.facebook.com/${encodeURIComponent(target)}`;

    const mobileResp = await fetchWithTimeout(mobileUrl, {
      headers: buildFacebookNavHeaders(cookie, true),
      timeoutMs: 12000,
    });

    const mobilePosts =
      mobileResp.ok && mobileResp.text
        ? parseFacebookPostsFromHtml(mobileResp.text, target, topN)
        : [];

    if (mobilePosts.length > 0) {
      return {
        status: 'OK',
        posts: mobilePosts,
        httpStatus: mobileResp.status,
        usedCookie,
      };
    }

    const mobileFailure = classifyFacebookHtml(
      mobileResp.status,
      mobileResp.url,
      mobileResp.text || '',
      usedCookie
    );
    if (mobileFailure) {
      return {
        status: mobileFailure.status,
        posts: [],
        reason: mobileFailure.reason,
        httpStatus: mobileFailure.httpStatus,
        usedCookie,
      };
    }
  }

  if (desktopFailure) {
    return {
      status: desktopFailure.status,
      posts: [],
      reason: desktopFailure.reason,
      httpStatus: desktopFailure.httpStatus,
      usedCookie,
    };
  }

  return {
    status: 'OK',
    posts: [],
    httpStatus: desktopResp.status,
    usedCookie,
  };
}

export class FacebookPostCollector implements PlatformCollector<WatcherEvent> {
  readonly name = 'facebook_post';
  readonly platform: LivePlatform = 'FACEBOOK';
  readonly eventType: WatcherEventType = 'post';
  readonly supported = true;

  private topN: number;
  private skipPinned: boolean;
  private cookie: string;
  private customFetcher?: FacebookPostFetcherFn;

  constructor(options?: FacebookPostCollectorOptions) {
    this.topN = options?.topN ?? 10;
    this.skipPinned = options?.skipPinned ?? true;
    this.cookie = normalizeCookieValue(options?.cookie);
    this.customFetcher = options?.fetcher;
  }

  setCookie(cookie: string): void {
    this.cookie = normalizeCookieValue(cookie);
  }

  private mapPostsToEvents(target: string, rawPosts: RawFacebookPost[]): WatcherEvent[] {
    const events: WatcherEvent[] = [];

    for (const post of rawPosts) {
      const itemId = String(post.id || '').trim();
      if (!itemId) continue;

      if (this.skipPinned && post.isPinned) {
        continue;
      }

      const photoUrls = Array.isArray(post.photoUrls) ? post.photoUrls.filter(Boolean) : [];
      const videoUrl = post.videoUrl?.trim() || undefined;

      events.push({
        platform: 'FACEBOOK',
        username: target,
        eventType: 'post',
        itemId,
        url: post.url || buildDefaultPermalink(target, itemId),
        title: post.title || `Facebook Post from @${target}`,
        thumbnailUrl: post.thumbnailUrl || photoUrls[0] || null,
        detectedAt: post.createTime
          ? new Date(post.createTime * 1000).toISOString()
          : new Date().toISOString(),
        isPinned: Boolean(post.isPinned),
        metadata: {
          createTime: post.createTime,
          videoUrl,
          photoUrls: photoUrls.length > 0 ? photoUrls : undefined,
          downloadHeaders: {
            Referer: 'https://www.facebook.com/',
            'User-Agent': FB_DESKTOP_USER_AGENT,
          },
        },
      });

      if (events.length >= this.topN) {
        break;
      }
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
        const fetched = await this.customFetcher(target, this.topN, this.cookie);
        if (Array.isArray(fetched)) {
          return {
            status: 'OK',
            events: this.mapPostsToEvents(target, fetched),
            usedCookie,
          };
        }
        return {
          status: fetched.status,
          events: this.mapPostsToEvents(target, fetched.posts),
          reason: fetched.reason,
          httpStatus: fetched.httpStatus,
          usedCookie: fetched.usedCookie ?? usedCookie,
        };
      }

      const res = await defaultFetchFacebookPosts(target, this.topN, this.cookie);
      return {
        status: res.status,
        events: this.mapPostsToEvents(target, res.posts),
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
      throw new Error(result.reason || 'Facebook post fetch failed');
    }
    return result.events;
  }
}
