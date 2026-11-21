import { fetchWithTimeout, safeJsonParse } from '../../liveCheckers/httpClient';
import type { LivePlatform } from '../../liveCheckers/types';
import type {
  CollectorFetchResult,
  CollectorStatus,
  WatcherEvent,
  WatcherEventType,
} from '../types';
import {
  classifyHttpDiagnostic,
  normalizeCookieValue,
  normalizeUsername,
  type PlatformCollector,
} from './base';
import {
  attachXAuthHeaders,
  getOrRefreshXGuestToken,
  X_BEARER_TOKEN,
  X_USER_AGENT,
  X_USER_BY_SCREEN_NAME_FEATURES,
  X_USER_BY_SCREEN_NAME_QUERY_ID,
  X_USER_TWEETS_FEATURES,
  X_USER_TWEETS_QUERY_ID,
} from './xShared';

export interface RawXTweet {
  id: string;
  text: string;
  createdAt?: string;
  createTime?: number;
  isPinned?: boolean;
  videoUrl?: string;
  streamUrl?: string | null;
  photoUrls?: string[];
  thumbnailUrl?: string | null;
}

export interface XPostFetchOutput {
  status: CollectorStatus;
  tweets: RawXTweet[];
  reason?: string;
  httpStatus?: number;
  usedCookie?: boolean;
}

export type XPostFetcherFn = (
  username: string,
  topN: number,
  cookie: string
) => Promise<XPostFetchOutput | RawXTweet[]>;

export interface XPostCollectorOptions {
  topN?: number;
  skipPinned?: boolean;
  cookie?: string;
  fetcher?: XPostFetcherFn;
}

function unwrapTweetResult(rawResult: unknown): Record<string, unknown> | null {
  if (!rawResult || typeof rawResult !== 'object') return null;
  const obj = rawResult as Record<string, unknown>;
  if (obj.__typename === 'TweetTombstone') return null;
  if (obj.__typename === 'TweetWithVisibilityResults' && obj.tweet && typeof obj.tweet === 'object') {
    return obj.tweet as Record<string, unknown>;
  }
  if (obj.tweet && typeof obj.tweet === 'object' && !obj.rest_id) {
    return obj.tweet as Record<string, unknown>;
  }
  return obj;
}

function extractTweetMedia(legacy: Record<string, unknown>): {
  videoUrl?: string;
  streamUrl?: string | null;
  photoUrls: string[];
  thumbnailUrl: string | null;
} {
  const extMedia = (legacy.extended_entities as { media?: Array<Record<string, unknown>> } | undefined)
    ?.media;
  const entMedia = (legacy.entities as { media?: Array<Record<string, unknown>> } | undefined)?.media;
  const mediaList = Array.isArray(extMedia) && extMedia.length > 0 ? extMedia : entMedia || [];

  let videoUrl: string | undefined;
  let streamUrl: string | null = null;
  const photoUrls: string[] = [];
  let thumbnailUrl: string | null = null;

  for (const m of mediaList) {
    if (!m || typeof m !== 'object') continue;
    const type = String(m.type || '').toLowerCase();
    const mediaThumb =
      typeof m.media_url_https === 'string' && m.media_url_https.trim()
        ? m.media_url_https.trim()
        : typeof m.media_url === 'string' && m.media_url.trim()
        ? m.media_url.trim()
        : '';

    if (type === 'video' || type === 'animated_gif') {
      const videoInfo = m.video_info as
        | { variants?: Array<{ content_type?: string; bitrate?: number; url?: string }> }
        | undefined;
      const variants = Array.isArray(videoInfo?.variants) ? videoInfo.variants : [];
      const mp4Variants = variants
        .filter((v) => v?.content_type === 'video/mp4' && typeof v.url === 'string' && v.url.trim())
        .sort((a, b) => Number(b.bitrate ?? 0) - Number(a.bitrate ?? 0));

      if (mp4Variants[0]?.url && !videoUrl) {
        videoUrl = mp4Variants[0].url.trim();
      } else if (!videoUrl && !streamUrl) {
        const hlsVariant = variants.find(
          (v) => v?.content_type === 'application/x-mpegURL' && typeof v.url === 'string' && v.url.trim()
        );
        if (hlsVariant?.url) {
          streamUrl = hlsVariant.url.trim();
        }
      }
      if (!thumbnailUrl && mediaThumb) {
        thumbnailUrl = mediaThumb;
      }
    } else if (mediaThumb) {
      photoUrls.push(mediaThumb);
      if (!thumbnailUrl) thumbnailUrl = mediaThumb;
    }
  }

  return { videoUrl, streamUrl, photoUrls, thumbnailUrl };
}

export function parseTweetObject(
  rawTweetObj: unknown,
  pinnedIds: Set<string>,
  forcePinned = false
): RawXTweet | null {
  const tweet = unwrapTweetResult(rawTweetObj);
  if (!tweet) return null;

  const legacy = (tweet.legacy as Record<string, unknown> | undefined) || tweet;
  const id = String(tweet.rest_id || legacy.id_str || tweet.id_str || '').trim();
  if (!id) return null;

  const noteText = (
    (tweet.note_tweet as { note_tweet_results?: { result?: { text?: string } } } | undefined)
      ?.note_tweet_results?.result?.text || ''
  ).trim();
  const fullText = String(legacy.full_text || legacy.text || '').trim();
  const text = noteText || fullText;

  const createdAtRaw = typeof legacy.created_at === 'string' ? legacy.created_at : undefined;
  let createTime: number | undefined;
  let createdAtIso: string | undefined;
  if (createdAtRaw) {
    const ms = Date.parse(createdAtRaw);
    if (Number.isFinite(ms)) {
      createTime = Math.floor(ms / 1000);
      createdAtIso = new Date(ms).toISOString();
    }
  }

  const media = extractTweetMedia(legacy);
  const isPinned = forcePinned || pinnedIds.has(id);

  return {
    id,
    text,
    createdAt: createdAtIso,
    createTime,
    isPinned,
    videoUrl: media.videoUrl,
    streamUrl: media.streamUrl,
    photoUrls: media.photoUrls.length > 0 ? media.photoUrls : undefined,
    thumbnailUrl: media.thumbnailUrl,
  };
}

export function parseXGraphqlTimeline(
  json: Record<string, unknown>,
  pinnedIds: Set<string>
): RawXTweet[] {
  const tweets: RawXTweet[] = [];
  const seen = new Set<string>();

  const userResult = (
    (json.data as Record<string, unknown> | undefined)?.user as Record<string, unknown> | undefined
  )?.result as Record<string, unknown> | undefined;

  const timelineV2 = userResult?.timeline_v2 as Record<string, unknown> | undefined;
  const timelineV1 = userResult?.timeline as Record<string, unknown> | undefined;
  const timelineObj = (timelineV2?.timeline || timelineV1?.timeline) as
    | Record<string, unknown>
    | undefined;
  const instructions = (timelineObj?.instructions as Array<Record<string, unknown>> | undefined) || [];

  for (const inst of instructions) {
    if (!inst || typeof inst !== 'object') continue;
    if (inst.type === 'TimelinePinEntry' && inst.entry && typeof inst.entry === 'object') {
      const entry = inst.entry as Record<string, unknown>;
      const tweetResult = (
        (entry.content as Record<string, unknown> | undefined)?.itemContent as
          | Record<string, unknown>
          | undefined
      )?.tweet_results as { result?: unknown } | undefined;
      const parsed = parseTweetObject(tweetResult?.result, pinnedIds, true);
      if (parsed) {
        pinnedIds.add(parsed.id);
        if (!seen.has(parsed.id)) {
          seen.add(parsed.id);
          tweets.push(parsed);
        }
      }
      continue;
    }

    if (inst.type === 'TimelineAddEntries' && Array.isArray(inst.entries)) {
      for (const entry of inst.entries as Array<Record<string, unknown>>) {
        const entryId = String(entry?.entryId || '');
        if (
          entryId.startsWith('cursor-') ||
          entryId.startsWith('who-to-follow') ||
          entryId.startsWith('promoted-tweet')
        ) {
          continue;
        }
        const content = entry?.content as Record<string, unknown> | undefined;
        const itemContent = content?.itemContent as Record<string, unknown> | undefined;
        const socialContext = itemContent?.socialContext as { contextType?: string } | undefined;
        const isSocialPin = socialContext?.contextType === 'Pin';
        const tweetResult = itemContent?.tweet_results as { result?: unknown } | undefined;

        const parsed = parseTweetObject(tweetResult?.result, pinnedIds, isSocialPin);
        if (parsed && !seen.has(parsed.id)) {
          seen.add(parsed.id);
          tweets.push(parsed);
        }
      }
    }
  }

  return tweets;
}

export function parseXSyndicationResponse(
  rawText: string,
  pinnedIds: Set<string>
): RawXTweet[] {
  const tweets: RawXTweet[] = [];
  const seen = new Set<string>();

  let data: Record<string, unknown> | null = null;
  const nextDataMatch = rawText.match(
    /<script[^>]*id="__NEXT_DATA__"[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/i
  );
  if (nextDataMatch?.[1]) {
    data = safeJsonParse<Record<string, unknown>>(nextDataMatch[1]);
  } else if (rawText.trim().startsWith('{')) {
    data = safeJsonParse<Record<string, unknown>>(rawText);
  }

  if (!data) return tweets;

  const entries = (
    (
      (data.props as Record<string, unknown> | undefined)?.pageProps as
        | Record<string, unknown>
        | undefined
    )?.timeline as { entries?: Array<Record<string, unknown>> } | undefined
  )?.entries;

  if (!Array.isArray(entries)) return tweets;

  for (const entry of entries) {
    const content = entry?.content as Record<string, unknown> | undefined;
    const tweetObj = content?.tweet as Record<string, unknown> | undefined;
    if (!tweetObj) continue;
    const isPinned =
      entry.type === 'pin' || Boolean(content?.isPinned) || Boolean(tweetObj.isPinned);
    const parsed = parseTweetObject(tweetObj, pinnedIds, isPinned);
    if (parsed && !seen.has(parsed.id)) {
      seen.add(parsed.id);
      tweets.push(parsed);
    }
  }

  return tweets;
}

function classifyXGraphqlErrors(
  errors: Array<{ code?: number; message?: string }> | undefined,
  usedCookie: boolean
): XPostFetchOutput | null {
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const first = errors[0];
  const code = first?.code;
  const msg = first?.message || 'X GraphQL error';

  if (code === 88 || /rate limit/i.test(msg)) {
    return { status: 'RATE_LIMITED', tweets: [], reason: msg, httpStatus: 429, usedCookie };
  }
  if (code === 32 || code === 239 || /could not authenticate|authenticate/i.test(msg)) {
    return { status: 'AUTH_REQUIRED', tweets: [], reason: msg, httpStatus: 401, usedCookie };
  }
  if (code === 37 || code === 179 || /not authorized|protected/i.test(msg)) {
    return { status: 'PRIVATE', tweets: [], reason: msg, httpStatus: 403, usedCookie };
  }
  if (code === 50 || code === 63 || /not found|suspended/i.test(msg)) {
    return {
      status: /suspended/i.test(msg) ? 'BLOCKED' : 'NOT_FOUND',
      tweets: [],
      reason: msg,
      usedCookie,
    };
  }
  return { status: 'ERROR', tweets: [], reason: msg, usedCookie };
}

async function defaultFetchXPosts(
  username: string,
  topN: number,
  cookie: string
): Promise<XPostFetchOutput> {
  const usedCookie = Boolean(cookie);
  let guestToken = usedCookie ? '' : await getOrRefreshXGuestToken();

  const makeHeaders = (gToken: string): Record<string, string> => {
    const h: Record<string, string> = {
      Authorization: X_BEARER_TOKEN,
      'User-Agent': X_USER_AGENT,
      Referer: `https://x.com/${encodeURIComponent(username)}`,
      Accept: '*/*',
    };
    attachXAuthHeaders(h, cookie, gToken);
    return h;
  };

  // Step 1: UserByScreenName
  const userUrl = `https://api.x.com/graphql/${X_USER_BY_SCREEN_NAME_QUERY_ID}/UserByScreenName?variables=${encodeURIComponent(
    JSON.stringify({ screen_name: username, withSafetyModeUserFields: true })
  )}&features=${encodeURIComponent(JSON.stringify(X_USER_BY_SCREEN_NAME_FEATURES))}`;

  let userResp = await fetchWithTimeout(userUrl, {
    headers: makeHeaders(guestToken),
    timeoutMs: 10000,
  });

  if (!usedCookie && (userResp.status === 401 || userResp.status === 403)) {
    guestToken = await getOrRefreshXGuestToken(true);
    userResp = await fetchWithTimeout(userUrl, {
      headers: makeHeaders(guestToken),
      timeoutMs: 10000,
    });
  }

  let definitiveVerdict: XPostFetchOutput | null = null;
  let userId = '';
  const pinnedIds = new Set<string>();
  let isProtectedUser = false;

  if (userResp.ok && userResp.text) {
    const userJson = safeJsonParse<Record<string, unknown>>(userResp.text);
    const gqlErr = classifyXGraphqlErrors(
      userJson?.errors as Array<{ code?: number; message?: string }> | undefined,
      usedCookie
    );
    const result = (
      (userJson?.data as Record<string, unknown> | undefined)?.user as
        | Record<string, unknown>
        | undefined
    )?.result as Record<string, unknown> | undefined;

    if (!result || Object.keys(result).length === 0) {
      if (gqlErr) {
        definitiveVerdict = gqlErr;
      } else {
        return {
          status: 'NOT_FOUND',
          tweets: [],
          reason: `Không tìm thấy tài khoản X @${username}`,
          httpStatus: 404,
          usedCookie,
        };
      }
    } else if (result.__typename === 'UserUnavailable') {
      const reasonText = String(result.reason || result.message || 'User unavailable');
      if (/suspended/i.test(reasonText)) {
        return {
          status: 'BLOCKED',
          tweets: [],
          reason: `Tài khoản X @${username} đã bị đình chỉ (${reasonText})`,
          httpStatus: userResp.status,
          usedCookie,
        };
      }
      if (/age-restricted|log in|nsfw/i.test(reasonText)) {
        return {
          status: 'AUTH_REQUIRED',
          tweets: [],
          reason: `Tài khoản X @${username} yêu cầu đăng nhập (${reasonText})`,
          httpStatus: userResp.status,
          usedCookie,
        };
      }
      if (/protected/i.test(reasonText)) {
        return {
          status: 'PRIVATE',
          tweets: [],
          reason: `Tài khoản X @${username} ở chế độ riêng tư (Protected)`,
          httpStatus: userResp.status,
          usedCookie,
        };
      }
      return {
        status: 'BLOCKED',
        tweets: [],
        reason: `Tài khoản X @${username} không khả dụng: ${reasonText}`,
        httpStatus: userResp.status,
        usedCookie,
      };
    } else {
      userId = String(result.rest_id || '').trim();
      const legacy = result.legacy as Record<string, unknown> | undefined;
      isProtectedUser = Boolean(legacy?.protected);
      const rawPinned = legacy?.pinned_tweet_ids_str;
      if (Array.isArray(rawPinned)) {
        for (const pid of rawPinned) {
          if (typeof pid === 'string' && pid.trim()) pinnedIds.add(pid.trim());
        }
      }
    }
  } else {
    const diag = classifyHttpDiagnostic(userResp.status, userResp.text, usedCookie, 'X');
    definitiveVerdict = {
      status: diag.status,
      tweets: [],
      reason: diag.reason,
      httpStatus: userResp.status,
      usedCookie,
    };
  }

  // Step 2: GraphQL UserTweets
  let graphqlFailedAuthOrBlock: XPostFetchOutput | null = definitiveVerdict;
  if (userId) {
    const tweetsUrl = `https://api.x.com/graphql/${X_USER_TWEETS_QUERY_ID}/UserTweets?variables=${encodeURIComponent(
      JSON.stringify({
        userId,
        count: Math.max(topN * 2, 20),
        includePromotedContent: false,
        withQuickPromoteEligibilityTweetFields: false,
        withVoice: true,
        withV2Timeline: true,
      })
    )}&features=${encodeURIComponent(JSON.stringify(X_USER_TWEETS_FEATURES))}`;

    let tweetsResp = await fetchWithTimeout(tweetsUrl, {
      headers: makeHeaders(guestToken),
      timeoutMs: 10000,
    });

    if (!usedCookie && (tweetsResp.status === 401 || tweetsResp.status === 403)) {
      guestToken = await getOrRefreshXGuestToken(true);
      tweetsResp = await fetchWithTimeout(tweetsUrl, {
        headers: makeHeaders(guestToken),
        timeoutMs: 10000,
      });
    }

    if (tweetsResp.ok && tweetsResp.text) {
      const tweetsJson = safeJsonParse<Record<string, unknown>>(tweetsResp.text);
      const gqlErr = classifyXGraphqlErrors(
        tweetsJson?.errors as Array<{ code?: number; message?: string }> | undefined,
        usedCookie
      );
      if (tweetsJson) {
        const parsedTweets = parseXGraphqlTimeline(tweetsJson, pinnedIds);
        if (parsedTweets.length > 0) {
          return {
            status: 'OK',
            tweets: parsedTweets,
            httpStatus: tweetsResp.status,
            usedCookie,
          };
        }
        if (isProtectedUser) {
          return {
            status: 'PRIVATE',
            tweets: [],
            reason: `Tài khoản X @${username} đang bật chế độ bảo vệ (Protected)`,
            httpStatus: tweetsResp.status,
            usedCookie,
          };
        }
        if (gqlErr) {
          graphqlFailedAuthOrBlock = gqlErr;
        } else if (usedCookie) {
          return {
            status: 'OK',
            tweets: [],
            httpStatus: tweetsResp.status,
            usedCookie,
          };
        }
      }
    } else {
      const diag = classifyHttpDiagnostic(tweetsResp.status, tweetsResp.text, usedCookie, 'X');
      graphqlFailedAuthOrBlock = {
        status: diag.status,
        tweets: [],
        reason: diag.reason,
        httpStatus: tweetsResp.status,
        usedCookie,
      };
    }
  }

  // Step 3: Syndication fallback (anonymous/guest only when GraphQL didn't give a definitive NOT_FOUND/BLOCKED/PRIVATE)
  if (!usedCookie) {
    const syndicationUrls = [
      `https://cdn.syndication.twimg.com/timeline-profile/screen-name/${encodeURIComponent(username)}`,
      `https://syndication.twitter.com/srv/timeline-profile/screen-name/${encodeURIComponent(username)}`,
    ];

    for (const synUrl of syndicationUrls) {
      try {
        const synResp = await fetchWithTimeout(synUrl, {
          headers: {
            'User-Agent': X_USER_AGENT,
            Accept: 'text/html,application/json,*/*',
          },
          timeoutMs: 10000,
        });

        if (synResp.ok && synResp.text) {
          const synTweets = parseXSyndicationResponse(synResp.text, pinnedIds);
          if (synTweets.length > 0) {
            return {
              status: 'OK',
              tweets: synTweets,
              httpStatus: synResp.status,
              usedCookie,
            };
          }
        } else if (synResp.status === 429 && graphqlFailedAuthOrBlock?.status === 'AUTH_REQUIRED') {
          return {
            status: 'AUTH_REQUIRED',
            tweets: [],
            reason: `${graphqlFailedAuthOrBlock.reason}; Syndication fallback rate-limited (HTTP 429)`,
            httpStatus: 429,
            usedCookie,
          };
        } else if (synResp.status === 429) {
          return {
            status: 'RATE_LIMITED',
            tweets: [],
            reason: 'X Syndication API bị giới hạn tốc độ (HTTP 429)',
            httpStatus: 429,
            usedCookie,
          };
        }
      } catch {
        // try next syndication endpoint
      }
    }
  }

  return (
    graphqlFailedAuthOrBlock || {
      status: 'OK',
      tweets: [],
      usedCookie,
    }
  );
}

export class XPostCollector implements PlatformCollector<WatcherEvent> {
  readonly name = 'x_post';
  readonly platform: LivePlatform = 'X';
  readonly eventType: WatcherEventType = 'post';
  readonly supported = true;

  private topN: number;
  private skipPinned: boolean;
  private cookie: string;
  private customFetcher?: XPostFetcherFn;

  constructor(options?: XPostCollectorOptions) {
    this.topN = options?.topN ?? 10;
    this.skipPinned = options?.skipPinned ?? true;
    this.cookie = normalizeCookieValue(options?.cookie);
    this.customFetcher = options?.fetcher;
  }

  setCookie(cookie: string): void {
    this.cookie = normalizeCookieValue(cookie);
  }

  private mapTweetsToEvents(username: string, rawTweets: RawXTweet[]): WatcherEvent[] {
    const events: WatcherEvent[] = [];

    for (const tweet of rawTweets) {
      const itemId = String(tweet.id || '').trim();
      if (!itemId) continue;

      if (this.skipPinned && tweet.isPinned) {
        continue;
      }

      const photoUrls = Array.isArray(tweet.photoUrls) ? tweet.photoUrls.filter(Boolean) : [];
      const videoUrl = tweet.videoUrl?.trim() || undefined;

      events.push({
        platform: 'X',
        username,
        eventType: 'post',
        itemId,
        url: `https://x.com/${encodeURIComponent(username)}/status/${encodeURIComponent(itemId)}`,
        title: tweet.text || `X Post from @${username}`,
        thumbnailUrl: tweet.thumbnailUrl || photoUrls[0] || null,
        streamUrl: tweet.streamUrl || null,
        detectedAt: tweet.createdAt || new Date().toISOString(),
        isPinned: Boolean(tweet.isPinned),
        metadata: {
          createTime: tweet.createTime,
          videoUrl,
          photoUrls: photoUrls.length > 0 ? photoUrls : undefined,
          downloadHeaders: {
            Referer: 'https://x.com/',
            'User-Agent': X_USER_AGENT,
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
    const username = normalizeUsername(rawUsername, 'X');
    if (!username || username.startsWith('broadcast_')) {
      return {
        status: 'NOT_FOUND',
        events: [],
        reason: 'Username X không hợp lệ',
        usedCookie,
      };
    }

    try {
      if (this.customFetcher) {
        const fetched = await this.customFetcher(username, this.topN, this.cookie);
        if (Array.isArray(fetched)) {
          return {
            status: 'OK',
            events: this.mapTweetsToEvents(username, fetched),
            usedCookie,
          };
        }
        return {
          status: fetched.status,
          events: this.mapTweetsToEvents(username, fetched.tweets),
          reason: fetched.reason,
          httpStatus: fetched.httpStatus,
          usedCookie: fetched.usedCookie ?? usedCookie,
        };
      }

      const res = await defaultFetchXPosts(username, this.topN, this.cookie);
      return {
        status: res.status,
        events: this.mapTweetsToEvents(username, res.tweets),
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
      throw new Error(result.reason || 'X post fetch failed');
    }
    return result.events;
  }
}
