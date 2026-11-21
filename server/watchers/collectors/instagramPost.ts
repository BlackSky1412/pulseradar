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
  extractInstagramUserIdFromHtml,
  formatInstagramCookie,
  IG_CRAWLER_USER_AGENTS,
  IG_WEB_USER_AGENT,
  instagramUserIdCache,
  unescapeInstagramUrl,
} from './instagramShared';

export interface RawInstagramPost {
  id: string;
  shortcode?: string;
  url?: string;
  caption?: string;
  thumbnailUrl?: string | null;
  takenAt?: number;
  isPinned?: boolean;
  isReel?: boolean;
  videoUrls: string[];
  photoUrls: string[];
}

export interface InstagramPostFetchOutput {
  status: CollectorStatus;
  posts: RawInstagramPost[];
  reason?: string;
  httpStatus?: number;
  usedCookie?: boolean;
}

export type InstagramPostFetcherFn = (
  username: string,
  topN: number,
  cookie: string
) => Promise<InstagramPostFetchOutput | RawInstagramPost[]>;

export interface InstagramPostCollectorOptions {
  topN?: number;
  skipPinned?: boolean;
  cookie?: string;
  fetcher?: InstagramPostFetcherFn;
}

function pickBestCandidateUrl(
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

export function parseInstagramGraphqlNode(
  node: Record<string, unknown>,
  username: string
): RawInstagramPost | null {
  const shortcode = String(node.shortcode || node.code || '').trim();
  const rawId = String(node.id || node.pk || shortcode || '').trim();
  const id = rawId.replace(/^(\d+)_\d+$/, '$1');
  if (!id && !shortcode) return null;

  const isPinned = Boolean(
    (Array.isArray(node.pinned_for_users) && node.pinned_for_users.length > 0) ||
      (Array.isArray(node.timeline_pinned_user_ids) &&
        node.timeline_pinned_user_ids.length > 0) ||
      node.is_pinned
  );

  const isReel =
    node.product_type === 'clips' ||
    (node.__typename === 'GraphVideo' && node.product_type === 'clips');

  const url = shortcode
    ? `https://www.instagram.com/${isReel ? 'reel' : 'p'}/${shortcode}/`
    : `https://www.instagram.com/${encodeURIComponent(username)}/`;

  const captionEdges = (
    node.edge_media_to_caption as { edges?: Array<{ node?: { text?: string } }> } | undefined
  )?.edges;
  const caption =
    captionEdges?.[0]?.node?.text?.trim() ||
    (typeof node.caption === 'object' && node.caption
      ? String((node.caption as { text?: string }).text || '').trim()
      : '') ||
    (typeof node.accessibility_caption === 'string' ? node.accessibility_caption.trim() : '');

  const videoUrls: string[] = [];
  const photoUrls: string[] = [];

  const sidecarEdges = (
    node.edge_sidecar_to_children as { edges?: Array<{ node?: Record<string, unknown> }> } | undefined
  )?.edges;

  if (Array.isArray(sidecarEdges) && sidecarEdges.length > 0) {
    for (const edge of sidecarEdges) {
      const child = edge?.node;
      if (!child) continue;
      if (child.is_video && typeof child.video_url === 'string' && child.video_url.trim()) {
        videoUrls.push(unescapeInstagramUrl(child.video_url));
      } else if (typeof child.display_url === 'string' && child.display_url.trim()) {
        photoUrls.push(unescapeInstagramUrl(child.display_url));
      }
    }
  } else if (node.is_video && typeof node.video_url === 'string' && node.video_url.trim()) {
    videoUrls.push(unescapeInstagramUrl(node.video_url));
  } else if (typeof node.display_url === 'string' && node.display_url.trim() && !node.is_video) {
    photoUrls.push(unescapeInstagramUrl(node.display_url));
  }

  const rawThumb =
    (typeof node.display_url === 'string' && node.display_url) ||
    (typeof node.thumbnail_src === 'string' && node.thumbnail_src) ||
    photoUrls[0] ||
    '';
  const thumbnailUrl = rawThumb ? unescapeInstagramUrl(rawThumb) : null;

  const takenAt =
    typeof node.taken_at_timestamp === 'number'
      ? node.taken_at_timestamp
      : typeof node.taken_at === 'number'
      ? node.taken_at
      : undefined;

  return {
    id: id || shortcode,
    shortcode: shortcode || undefined,
    url,
    caption,
    thumbnailUrl,
    takenAt,
    isPinned,
    isReel,
    videoUrls,
    photoUrls,
  };
}

export function parseInstagramMobileItem(
  item: Record<string, unknown>,
  username: string
): RawInstagramPost | null {
  const shortcode = String(item.code || '').trim();
  const rawId = String(item.pk || item.id || shortcode || '').trim();
  const id = rawId.replace(/^(\d+)_\d+$/, '$1');
  if (!id && !shortcode) return null;

  const isPinned =
    Array.isArray(item.timeline_pinned_user_ids) && item.timeline_pinned_user_ids.length > 0;
  const isReel = item.product_type === 'clips' || item.media_type === 2;
  const url = shortcode
    ? `https://www.instagram.com/${item.product_type === 'clips' ? 'reel' : 'p'}/${shortcode}/`
    : `https://www.instagram.com/${encodeURIComponent(username)}/`;

  const captionObj = item.caption as { text?: string } | undefined;
  const caption =
    (typeof captionObj?.text === 'string' && captionObj.text.trim()) ||
    (typeof item.accessibility_caption === 'string' && item.accessibility_caption.trim()) ||
    '';

  const videoUrls: string[] = [];
  const photoUrls: string[] = [];

  const carousel = item.carousel_media as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(carousel) && carousel.length > 0) {
    for (const c of carousel) {
      const vUrl = pickBestCandidateUrl(
        c.video_versions as Array<{ url?: string; width?: number; height?: number }> | undefined
      );
      if (vUrl) {
        videoUrls.push(vUrl);
      } else {
        const imgObj = c.image_versions2 as
          | { candidates?: Array<{ url?: string; width?: number; height?: number }> }
          | undefined;
        const pUrl = pickBestCandidateUrl(imgObj?.candidates);
        if (pUrl) photoUrls.push(pUrl);
      }
    }
  } else {
    const vUrl = pickBestCandidateUrl(
      item.video_versions as Array<{ url?: string; width?: number; height?: number }> | undefined
    );
    if (vUrl) {
      videoUrls.push(vUrl);
    } else {
      const imgObj = item.image_versions2 as
        | { candidates?: Array<{ url?: string; width?: number; height?: number }> }
        | undefined;
      const pUrl = pickBestCandidateUrl(imgObj?.candidates);
      if (pUrl) photoUrls.push(pUrl);
    }
  }

  const thumbObj = item.image_versions2 as
    | { candidates?: Array<{ url?: string; width?: number; height?: number }> }
    | undefined;
  const thumbUrl = pickBestCandidateUrl(thumbObj?.candidates) || photoUrls[0] || '';

  return {
    id: id || shortcode,
    shortcode: shortcode || undefined,
    url,
    caption,
    thumbnailUrl: thumbUrl || null,
    takenAt: typeof item.taken_at === 'number' ? item.taken_at : undefined,
    isPinned,
    isReel,
    videoUrls,
    photoUrls,
  };
}

function findRelayTimelineEdges(root: unknown): Array<{ node?: Record<string, unknown> }> | null {
  if (!root || typeof root !== 'object') return null;
  if (Array.isArray(root)) {
    for (const el of root) {
      const found = findRelayTimelineEdges(el);
      if (found) return found;
    }
    return null;
  }
  const obj = root as Record<string, unknown>;
  const timeline = obj.xdt_api__v1__feed__user_timeline_graphql_connection as
    | { edges?: Array<{ node?: Record<string, unknown> }> }
    | undefined;
  if (Array.isArray(timeline?.edges)) {
    return timeline.edges;
  }
  const ownerMedia = obj.edge_owner_to_timeline_media as
    | { edges?: Array<{ node?: Record<string, unknown> }> }
    | undefined;
  if (Array.isArray(ownerMedia?.edges)) {
    return ownerMedia.edges;
  }
  for (const val of Object.values(obj)) {
    if (val && typeof val === 'object') {
      const found = findRelayTimelineEdges(val);
      if (found) return found;
    }
  }
  return null;
}

export function parseInstagramPostsFromHtml(
  html: string,
  username: string,
  _topN: number = 10
): { posts: RawInstagramPost[]; isPrivate?: boolean; userId?: string } {
  const userId = extractInstagramUserIdFromHtml(html) || undefined;
  if (userId) {
    instagramUserIdCache.set(username.toLowerCase(), userId);
  }

  const isPrivate =
    /"is_private"\s*:\s*true/i.test(html) ||
    /this account is private/i.test(html);

  const posts: RawInstagramPost[] = [];
  const seenIds = new Set<string>();

  // Strategy 1: Relay <script type="application/json"> blocks
  const scriptRegex = /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRegex.exec(html)) !== null) {
    const rawJson = match[1]?.trim();
    if (
      !rawJson ||
      (!rawJson.includes('xdt_api__v1__feed__user_timeline_graphql_connection') &&
        !rawJson.includes('edge_owner_to_timeline_media'))
    ) {
      continue;
    }
    const parsed = safeJsonParse<unknown>(rawJson);
    if (!parsed) continue;
    const edges = findRelayTimelineEdges(parsed);
    if (edges) {
      for (const edge of edges) {
        const node = edge?.node;
        if (!node) continue;
        const post =
          'video_versions' in node || 'image_versions2' in node || 'carousel_media' in node
            ? parseInstagramMobileItem(node, username)
            : parseInstagramGraphqlNode(node, username);
        if (post && !seenIds.has(post.id)) {
          seenIds.add(post.id);
          posts.push(post);
        }
      }
    }
  }

  if (posts.length > 0) {
    return { posts, isPrivate, userId };
  }

  // Strategy 2: Inline JSON edge_owner_to_timeline_media or shortcode blocks (never og:image)
  const shortcodeMatches = html.matchAll(/"shortcode"\s*:\s*"([A-Za-z0-9_-]{5,32})"/g);
  for (const scMatch of shortcodeMatches) {
    const shortcode = scMatch[1];
    if (!shortcode || seenIds.has(shortcode)) continue;
    seenIds.add(shortcode);

    const startIdx = Math.max(0, (scMatch.index ?? 0) - 300);
    const endIdx = Math.min(html.length, (scMatch.index ?? 0) + 1800);
    const windowStr = html.slice(startIdx, endIdx);

    const idMatch = windowStr.match(/"id"\s*:\s*"(\d+)(?:_\d+)?"/);
    const id = idMatch?.[1] || shortcode;
    if (seenIds.has(id) && id !== shortcode) continue;
    seenIds.add(id);

    const isVideo = /"is_video"\s*:\s*true/.test(windowStr);
    const videoMatch = windowStr.match(/"video_url"\s*:\s*"([^"]+)"/);
    const displayMatch = windowStr.match(/"display_url"\s*:\s*"([^"]+)"/);
    const captionMatch = windowStr.match(
      /"edge_media_to_caption"\s*:\s*\{\s*"edges"\s*:\s*\[\s*\{\s*"node"\s*:\s*\{\s*"text"\s*:\s*"([^"]*)"/
    );
    const takenAtMatch = windowStr.match(/"taken_at_timestamp"\s*:\s*(\d+)/);

    const videoUrl = videoMatch?.[1] ? unescapeInstagramUrl(videoMatch[1]) : '';
    const displayUrl = displayMatch?.[1] ? unescapeInstagramUrl(displayMatch[1]) : '';

    const videoUrls = videoUrl ? [videoUrl] : [];
    const photoUrls = !isVideo && displayUrl ? [displayUrl] : [];
    const isPinned = /"pinned_for_users"\s*:\s*\[\s*\{/.test(windowStr);

    posts.push({
      id,
      shortcode,
      url: `https://www.instagram.com/${isVideo ? 'reel' : 'p'}/${shortcode}/`,
      caption: captionMatch?.[1] || '',
      thumbnailUrl: displayUrl || null,
      takenAt: takenAtMatch?.[1] ? Number(takenAtMatch[1]) : undefined,
      isPinned,
      isReel: isVideo,
      videoUrls,
      photoUrls,
    });
  }

  return { posts, isPrivate, userId };
}

async function enrichShortcodeMedia(
  post: RawInstagramPost,
  cookie: string
): Promise<void> {
  if (!post.shortcode) return;
  if (post.videoUrls.length > 0 || post.photoUrls.length > 0) return;

  try {
    const embedUrl = `https://www.instagram.com/p/${encodeURIComponent(
      post.shortcode
    )}/embed/captioned/`;
    const headers: Record<string, string> = {
      'User-Agent': IG_WEB_USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    };
    if (cookie) headers.Cookie = cookie;
    const resp = await fetchWithTimeout(embedUrl, { headers, timeoutMs: 8000 });
    if (!resp.ok || !resp.text) return;

    const videoMatch = resp.text.match(/"video_url"\s*:\s*"([^"]+)"/);
    if (videoMatch?.[1]) {
      post.videoUrls.push(unescapeInstagramUrl(videoMatch[1]));
    }
    const imgMatch = resp.text.match(/class="EmbeddedMediaImage"[^>]*src="([^"]+)"/i);
    if (imgMatch?.[1] && post.videoUrls.length === 0) {
      const photo = unescapeInstagramUrl(imgMatch[1]);
      post.photoUrls.push(photo);
      if (!post.thumbnailUrl) post.thumbnailUrl = photo;
    }
  } catch {
    // non-fatal enrichment failure
  }
}

async function defaultFetchInstagramPosts(
  username: string,
  topN: number,
  rawCookie: string,
  skipPinned = true
): Promise<InstagramPostFetchOutput> {
  const formattedCookie = formatInstagramCookie(rawCookie);
  const usedCookie = Boolean(formattedCookie);
  let lastFailure: InstagramPostFetchOutput | null = null;
  let resolvedUserId: string | undefined = instagramUserIdCache.get(username.toLowerCase());

  const fetchViaWebProfileInfo = async (
    cookieStr: string
  ): Promise<InstagramPostFetchOutput | null> => {
    const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(
      username
    )}&_=${Date.now()}`;
    const resp = await fetchWithTimeout(url, {
      headers: buildInstagramWebApiHeaders(username, cookieStr),
      timeoutMs: 10000,
    });
    const failure = classifyInstagramFailure(
      resp.status,
      resp.url,
      resp.text,
      Boolean(cookieStr)
    );
    if (failure) {
      lastFailure = {
        status: failure.status,
        posts: [],
        reason: failure.reason,
        httpStatus: failure.httpStatus,
        usedCookie,
      };
      return failure.status === 'NOT_FOUND' ? lastFailure : null;
    }

    if (resp.ok && resp.text) {
      const json = safeJsonParse<{
        data?: {
          user?: {
            id?: string;
            pk?: string;
            is_private?: boolean;
            edge_owner_to_timeline_media?: {
              edges?: Array<{ node?: Record<string, unknown> }>;
            };
          };
        };
      }>(resp.text);
      const user = json?.data?.user;
      if (user) {
        const id = String(user.id || user.pk || '').trim();
        if (id && /^\d+$/.test(id)) {
          resolvedUserId = id;
          instagramUserIdCache.set(username.toLowerCase(), id);
        }
        const edges = user.edge_owner_to_timeline_media?.edges || [];
        if (user.is_private === true && edges.length === 0) {
          return {
            status: 'PRIVATE',
            posts: [],
            reason: 'Tài khoản Instagram ở chế độ riêng tư',
            httpStatus: resp.status,
            usedCookie,
          };
        }
        const posts: RawInstagramPost[] = [];
        for (const edge of edges) {
          if (!edge?.node) continue;
          const post = parseInstagramGraphqlNode(edge.node, username);
          if (post) posts.push(post);
        }
        if (posts.length > 0 || !user.is_private) {
          return {
            status: 'OK',
            posts,
            httpStatus: resp.status,
            usedCookie,
          };
        }
      }
    }
    return null;
  };

  const fetchViaMobileFeed = async (
    userId: string,
    cookieStr: string
  ): Promise<InstagramPostFetchOutput | null> => {
    const url = `https://i.instagram.com/api/v1/feed/user/${encodeURIComponent(
      userId
    )}/?count=${Math.max(topN * 2, topN + 6, 12)}`;
    const resp = await fetchWithTimeout(url, {
      headers: buildInstagramMobileApiHeaders(username, cookieStr),
      timeoutMs: 10000,
    });
    const failure = classifyInstagramFailure(
      resp.status,
      resp.url,
      resp.text,
      Boolean(cookieStr)
    );
    if (failure) {
      lastFailure = {
        status: failure.status,
        posts: [],
        reason: failure.reason,
        httpStatus: failure.httpStatus,
        usedCookie,
      };
      return null;
    }
    if (resp.ok && resp.text) {
      const json = safeJsonParse<{ items?: Array<Record<string, unknown>> }>(resp.text);
      if (Array.isArray(json?.items)) {
        const posts: RawInstagramPost[] = [];
        for (const item of json.items) {
          const post = parseInstagramMobileItem(item, username);
          if (post) posts.push(post);
        }
        return { status: 'OK', posts, httpStatus: resp.status, usedCookie };
      }
    }
    return null;
  };

  const fetchViaHtml = async (
    userAgent: string,
    cookieStr: string,
    includeSecFetch: boolean
  ): Promise<InstagramPostFetchOutput | null> => {
    const url = `https://www.instagram.com/${encodeURIComponent(username)}/`;
    const headers: Record<string, string> = {
      'User-Agent': userAgent,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    };
    if (includeSecFetch) {
      headers['Sec-Fetch-Dest'] = 'document';
      headers['Sec-Fetch-Mode'] = 'navigate';
      headers['Sec-Fetch-Site'] = 'none';
      headers['Sec-Fetch-User'] = '?1';
    }
    if (cookieStr) {
      headers.Cookie = cookieStr;
    }

    const resp = await fetchWithTimeout(url, { headers, timeoutMs: 12000 });
    const failure = classifyInstagramFailure(
      resp.status,
      resp.url,
      resp.text,
      Boolean(cookieStr)
    );
    if (failure) {
      lastFailure = {
        status: failure.status,
        posts: [],
        reason: failure.reason,
        httpStatus: failure.httpStatus,
        usedCookie,
      };
      return failure.status === 'NOT_FOUND' ? lastFailure : null;
    }

    if (resp.ok && resp.text) {
      const parsed = parseInstagramPostsFromHtml(resp.text, username, topN);
      if (parsed.userId) resolvedUserId = parsed.userId;

      if (parsed.isPrivate && parsed.posts.length === 0) {
        return {
          status: 'PRIVATE',
          posts: [],
          reason: 'Tài khoản Instagram ở chế độ riêng tư',
          httpStatus: resp.status,
          usedCookie,
        };
      }
      if (parsed.posts.length > 0) {
        return {
          status: 'OK',
          posts: parsed.posts,
          httpStatus: resp.status,
          usedCookie,
        };
      }
      if (parsed.userId) {
        return {
          status: 'OK',
          posts: [],
          httpStatus: resp.status,
          usedCookie,
        };
      }
    }
    return null;
  };

  if (usedCookie) {
    const r1 = await fetchViaWebProfileInfo(formattedCookie);
    if (r1 && (r1.status !== 'OK' || r1.posts.length > 0)) {
      return r1;
    }

    if (resolvedUserId) {
      const r2 = await fetchViaMobileFeed(resolvedUserId, formattedCookie);
      if (r2 && (r2.status !== 'OK' || r2.posts.length > 0)) {
        return r2;
      }
    }

    const r3 = await fetchViaHtml(IG_WEB_USER_AGENT, formattedCookie, true);
    if (r3 && (r3.status !== 'OK' || r3.posts.length > 0)) {
      return r3;
    }

    const r4 = await fetchViaHtml(IG_CRAWLER_USER_AGENTS[0], '', false);
    if (r4 && (r4.status !== 'OK' || r4.posts.length > 0)) {
      return r4;
    }
    if (r1?.status === 'OK') return r1;
  } else {
    // Anonymous mode: Crawler HTML primary -> web_profile_info fallback -> Twitterbot HTML fallback
    const r1 = await fetchViaHtml(IG_CRAWLER_USER_AGENTS[0], '', false);
    if (r1 && (r1.status !== 'OK' || r1.posts.length > 0)) {
      const toEnrich = r1.posts.filter((p) => !skipPinned || !p.isPinned).slice(0, topN);
      for (const p of toEnrich) {
        await enrichShortcodeMedia(p, '');
      }
      return r1;
    }

    const r2 = await fetchViaWebProfileInfo('');
    if (r2 && (r2.status !== 'OK' || r2.posts.length > 0)) {
      return r2;
    }

    const r3 = await fetchViaHtml(IG_CRAWLER_USER_AGENTS[1], '', false);
    if (r3 && (r3.status !== 'OK' || r3.posts.length > 0)) {
      const toEnrich = r3.posts.filter((p) => !skipPinned || !p.isPinned).slice(0, topN);
      for (const p of toEnrich) {
        await enrichShortcodeMedia(p, '');
      }
      return r3;
    }

    if (r1?.status === 'OK') return r1;
    if (r2?.status === 'OK') return r2;
    if (r3?.status === 'OK') return r3;
  }

  return (
    lastFailure || {
      status: usedCookie ? 'BLOCKED' : 'AUTH_REQUIRED',
      posts: [],
      reason: usedCookie
        ? 'Không thể trích xuất bài viết Instagram (trang trả về SPA shell rỗng hoặc bị chặn)'
        : 'Instagram chặn truy cập ẩn danh hoặc yêu cầu đăng nhập để xem bài viết',
      usedCookie,
    }
  );
}

export class InstagramPostCollector implements PlatformCollector<WatcherEvent> {
  readonly name = 'instagram_post';
  readonly platform: LivePlatform = 'INSTAGRAM';
  readonly eventType: WatcherEventType = 'post';
  readonly supported = true;

  private topN: number;
  private skipPinned: boolean;
  private cookie: string;
  private customFetcher?: InstagramPostFetcherFn;

  constructor(options?: InstagramPostCollectorOptions) {
    this.topN = options?.topN ?? 10;
    this.skipPinned = options?.skipPinned ?? true;
    this.cookie = normalizeCookieValue(options?.cookie);
    this.customFetcher = options?.fetcher;
  }

  setCookie(cookie: string): void {
    this.cookie = normalizeCookieValue(cookie);
  }

  private mapPostsToEvents(username: string, rawPosts: RawInstagramPost[]): WatcherEvent[] {
    const events: WatcherEvent[] = [];

    for (const post of rawPosts) {
      const itemId = (post.id || post.shortcode || '').trim();
      if (!itemId) continue;

      if (this.skipPinned && post.isPinned) {
        continue;
      }

      const videoUrls = Array.isArray(post.videoUrls) ? post.videoUrls.filter(Boolean) : [];
      const photoUrls = Array.isArray(post.photoUrls) ? post.photoUrls.filter(Boolean) : [];

      const event: WatcherEvent = {
        platform: 'INSTAGRAM',
        username,
        eventType: 'post',
        itemId,
        url:
          post.url ||
          (post.shortcode
            ? `https://www.instagram.com/${post.isReel ? 'reel' : 'p'}/${post.shortcode}/`
            : `https://www.instagram.com/${encodeURIComponent(username)}/`),
        title: post.caption || `Instagram Post from @${username}`,
        thumbnailUrl: post.thumbnailUrl || photoUrls[0] || null,
        detectedAt: post.takenAt
          ? new Date(post.takenAt * 1000).toISOString()
          : new Date().toISOString(),
        isPinned: Boolean(post.isPinned),
        metadata: {
          shortcode: post.shortcode,
          createTime: post.takenAt,
          videoUrl: videoUrls[0],
          videoUrls: videoUrls.length > 0 ? videoUrls : undefined,
          photoUrls: photoUrls.length > 0 ? photoUrls : undefined,
          downloadHeaders: {
            Referer: 'https://www.instagram.com/',
            'User-Agent': IG_WEB_USER_AGENT,
          },
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
        const fetched = await this.customFetcher(username, this.topN, formattedCookie);
        if (Array.isArray(fetched)) {
          return {
            status: 'OK',
            events: this.mapPostsToEvents(username, fetched),
            usedCookie,
          };
        }
        return {
          status: fetched.status,
          events: this.mapPostsToEvents(username, fetched.posts),
          reason: fetched.reason,
          httpStatus: fetched.httpStatus,
          usedCookie: fetched.usedCookie ?? usedCookie,
        };
      }

      const res = await defaultFetchInstagramPosts(username, this.topN, this.cookie, this.skipPinned);
      return {
        status: res.status,
        events: this.mapPostsToEvents(username, res.posts),
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
      throw new Error(result.reason || 'Instagram post fetch failed');
    }
    return result.events;
  }
}
