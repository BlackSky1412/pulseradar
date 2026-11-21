import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  startServer,
  type CreatedApp,
  type StartedServer,
  type StartServerOptions,
} from '../../server';
import type { LiveCheckResult, PlatformCookies } from '../../server/liveCheckers/index';
import type { LivePlatform, MultiPlatformSettings, KeywordRuleItem, WebhookServerItem } from '../../src/utils/scannerEngine';
import type { TikTokEvent, WatcherEventType, WatcherState } from '../../server/watchers/types';

export type ContractValidationStatus =
  | 'VALID'
  | 'INVALID_FORMAT'
  | 'NOT_FOUND'
  | 'AUTH_REQUIRED'
  | 'BLOCKED'
  | 'ERROR';

export interface ContractUserValidationResult {
  valid: boolean;
  status?: ContractValidationStatus;
  authMode?: 'anonymous' | 'cookie';
  httpStatus?: number;
  username: string;
  platform: string;
  error?: string;
  id?: string;
  nickname?: string;
  avatarUrl?: string;
  profileUrl: string;
}

export interface ContractTargetProfileMeta {
  id?: string;
  nickname?: string;
  avatarUrl?: string;
  profileUrl: string;
  status?: string;
  authMode?: 'anonymous' | 'cookie';
  updatedAt: string;
}

export interface ContractWorkspaceState {
  rules: KeywordRuleItem[];
  servers: WebhookServerItem[];
  alerts: unknown[];
  scannerSettings: {
    cookies: Required<PlatformCookies>;
    pollIntervalSeconds: number;
    deduplicateLive: boolean;
    platforms?: MultiPlatformSettings;
  };
  targetProfiles?: Record<string, ContractTargetProfileMeta>;
  updatedAt: string;
}

export type ContractCollectorStatus =
  | 'OK'
  | 'UNSUPPORTED'
  | 'AUTH_REQUIRED'
  | 'BLOCKED'
  | 'NOT_FOUND'
  | 'PRIVATE'
  | 'RATE_LIMITED'
  | 'ERROR';

export interface ContractWatcherEvent {
  platform?: LivePlatform;
  username: string;
  eventType: WatcherEventType;
  itemId: string;
  url: string;
  title: string;
  thumbnailUrl?: string | null;
  streamUrl?: string | null;
  detectedAt: string;
  isPinned?: boolean;
  metadata?: Record<string, unknown> & {
    videoUrl?: string;
    playAddr?: string;
    photoUrls?: string[];
    downloadHeaders?: Record<string, string>;
    downloadedMedia?: unknown;
  };
}

export interface ContractCollectorFetchResult<TEvent = ContractWatcherEvent> {
  status: ContractCollectorStatus;
  events: TEvent[];
  reason?: string;
  httpStatus?: number;
  usedCookie?: boolean;
}

export interface ContractPlatformCollector<TEvent = ContractWatcherEvent> {
  readonly name: string;
  readonly platform?: LivePlatform;
  readonly eventType: WatcherEventType;
  readonly supported?: boolean;
  fetch(username: string): Promise<TEvent[]>;
  fetchWithDiagnostics?(username: string): Promise<ContractCollectorFetchResult<TEvent>>;
  setCookie?(cookie: string): void;
}

export interface ContractTargetCollectorDiagnostic {
  platform: LivePlatform;
  username: string;
  eventType: WatcherEventType;
  status: ContractCollectorStatus;
  reason?: string;
  httpStatus?: number;
  usedCookie?: boolean;
  checkedAt?: string;
}

export interface ContractWatcherStatusResponse {
  success: boolean;
  running: boolean;
  health: Record<string, {
    collectorName: string;
    consecutiveErrors: number;
    lastErrorMessage: string | null;
    lastAlertSentAt: string | null;
    lastSuccessAt: string | null;
    updatedAt: string;
  }>;
  metrics: {
    seenEventsCount: number;
    trackedUsersCount: number;
  };
  diagnostics?: ContractTargetCollectorDiagnostic[];
  platforms?: Record<string, unknown>;
}

export interface ContractStorageUploadParams {
  localFilePath: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  username: string;
  eventType: WatcherEventType;
  title?: string;
  sourceUrl?: string;
  platform?: LivePlatform;
}

export interface RecordedExternalRequest {
  url: string;
  hostname: string;
  pathname: string;
  method: string;
  headers: Record<string, string>;
  bodyText?: string;
  formFields?: Record<string, string>;
  formFiles?: Array<{ field: string; name: string; size: number; type: string }>;
}

export interface MockProfileSpec {
  id: string;
  nickname: string;
  avatarUrl: string;
  storyStatus?: number;
  posts?: Array<{
    id: string;
    title: string;
    coverUrl?: string;
    videoUrl?: string;
    photoUrls?: string[];
    isPinned?: boolean;
    createTime?: number;
  }>;
  stories?: Array<{
    id: string;
    title?: string;
    coverUrl?: string;
    videoUrl?: string;
    photoUrls?: string[];
    createTime?: number;
    expireTime?: number;
  }>;
  live?: {
    roomId?: string;
    broadcastId?: string;
    mediaKey?: string;
    title: string;
    streamUrl: string;
  } | null;
  requireCookie?: boolean;
  httpStatus?: number;
  blockMode?: '401' | '403' | '429' | 'login_wall' | 'challenge' | '404' | 'unavailable';
}

export interface MockUpstreamConfig {
  tiktok: Map<string, MockProfileSpec>;
  instagram: Map<string, MockProfileSpec>;
  facebook: Map<string, MockProfileSpec>;
  x: Map<string, MockProfileSpec>;
  tikwmOverrides: Map<string, { code: number; hdplay?: string; play?: string; images?: string[] }>;
  cdnAssets: Map<string, { status: number; contentType: string; body: Buffer | string }>;
  telegramStatus: number;
  telegramFailAfter?: number;
  customHandler?: (req: RecordedExternalRequest) => Response | Promise<Response> | undefined;
}

export interface R1R2TestEnv {
  tempDir: string;
  mediaDir: string;
  server: StartedServer;
  mocks: MockUpstreamConfig;
  recordedRequests: RecordedExternalRequest[];
  clearRecordedRequests: () => void;
  apiJson: <T = Record<string, unknown>>(
    method: string,
    routePath: string,
    body?: unknown
  ) => Promise<{ status: number; ok: boolean; data: T }>;
  triggerWatcherCycle: (eventType: WatcherEventType) => Promise<unknown>;
  cleanup: () => Promise<void>;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function saveEnvVars(keys: string[]): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of keys) {
    saved[key] = process.env[key];
  }
  return saved;
}

function applyEnvOverrides(overrides: Record<string, string | undefined>): Record<string, string | undefined> {
  const saved = saveEnvVars(Object.keys(overrides));
  for (const [key, val] of Object.entries(overrides)) {
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }
  return saved;
}

function restoreEnvVars(saved: Record<string, string | undefined>): void {
  for (const [key, val] of Object.entries(saved)) {
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }
}

function normalizeHeaders(
  inputHeaders?: HeadersInit,
  requestHeaders?: Headers
): Record<string, string> {
  const out: Record<string, string> = {};
  if (requestHeaders) {
    requestHeaders.forEach((v, k) => {
      out[k.toLowerCase()] = v;
    });
  }
  if (!inputHeaders) return out;
  if (inputHeaders instanceof Headers) {
    inputHeaders.forEach((v, k) => {
      out[k.toLowerCase()] = v;
    });
  } else if (Array.isArray(inputHeaders)) {
    for (const [k, v] of inputHeaders) {
      out[k.toLowerCase()] = v;
    }
  } else {
    for (const [k, v] of Object.entries(inputHeaders)) {
      if (typeof v === 'string') {
        out[k.toLowerCase()] = v;
      }
    }
  }
  return out;
}

function escapeHtmlAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function buildTikTokProfileHtml(username: string, spec: MockProfileSpec): string {
  if (spec.blockMode === 'challenge') {
    return '<html><head><title>TikTok - Verify</title></head><body><div id="captcha_container">Verify to continue</div></body></html>';
  }
  if (spec.blockMode === 'unavailable' || spec.blockMode === '404') {
    const payload = {
      __DEFAULT_SCOPE__: {
        'webapp.user-detail': {
          statusCode: 10202,
          userInfo: {},
        },
      },
    };
    return `<html><body>Couldn't find this account<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(payload)}</script></body></html>`;
  }

  const itemList = (spec.posts || []).map((p) => ({
    id: p.id,
    desc: p.title,
    createTime: p.createTime ?? Math.floor(Date.now() / 1000),
    isPinned: Boolean(p.isPinned),
    video: {
      cover: p.coverUrl || `https://cdn.example.test/tt_${p.id}_cover.jpg`,
      originCover: p.coverUrl || `https://cdn.example.test/tt_${p.id}_cover.jpg`,
      playAddr: p.videoUrl || `https://cdn.example.test/tt_${p.id}.mp4`,
    },
  }));

  const storyList = (spec.stories || []).map((s) => ({
    id: s.id,
    desc: s.title || `Story ${s.id}`,
    createTime: s.createTime ?? Math.floor(Date.now() / 1000),
    expireTime: s.expireTime ?? Math.floor(Date.now() / 1000) + 86400,
    video: s.videoUrl
      ? {
          cover: s.coverUrl || `https://cdn.example.test/tt_story_${s.id}.jpg`,
          playAddr: s.videoUrl,
        }
      : undefined,
    imagePost:
      s.photoUrls && s.photoUrls.length > 0
        ? { images: s.photoUrls.map((u) => ({ imageURL: { urlList: [u] } })) }
        : undefined,
  }));

  const payload = {
    __DEFAULT_SCOPE__: {
      'webapp.user-detail': {
        statusCode: 0,
        userInfo: {
          user: {
            id: spec.id,
            uniqueId: username,
            nickname: spec.nickname,
            avatarThumb: spec.avatarUrl,
            avatarMedium: spec.avatarUrl,
            UserStoryStatus: spec.storyStatus ?? (storyList.length > 0 ? 1 : 0),
            roomId: spec.live?.roomId || '',
          },
        },
        itemInfo: {
          itemList,
        },
        storyInfo: {
          storyList,
        },
      },
      'webapp.live-detail': spec.live
        ? {
            liveInfo: {
              roomId: spec.live.roomId || '790000111222',
              title: spec.live.title,
              streamUrl: spec.live.streamUrl,
            },
          }
        : undefined,
    },
  };

  return `<!doctype html><html><head><title>${escapeHtmlAttr(spec.nickname)} (@${escapeHtmlAttr(username)}) | TikTok</title></head><body><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(payload)}</script></body></html>`;
}

export function buildInstagramWebProfileJson(username: string, spec: MockProfileSpec): Record<string, unknown> {
  const edges = (spec.posts || []).map((p) => ({
    node: {
      id: p.id,
      shortcode: `IG_${p.id}`,
      is_video: Boolean(p.videoUrl),
      video_url: p.videoUrl,
      display_url: p.coverUrl || (p.photoUrls && p.photoUrls[0]) || `https://cdn.example.test/ig_${p.id}.jpg`,
      thumbnail_src: p.coverUrl || `https://cdn.example.test/ig_${p.id}.jpg`,
      taken_at_timestamp: p.createTime ?? Math.floor(Date.now() / 1000),
      edge_media_to_caption: {
        edges: [{ node: { text: p.title } }],
      },
      edge_sidecar_to_children:
        p.photoUrls && p.photoUrls.length > 1
          ? {
              edges: p.photoUrls.map((u) => ({
                node: { display_url: u, is_video: false },
              })),
            }
          : undefined,
    },
  }));

  return {
    data: {
      user: {
        id: spec.id,
        pk: spec.id,
        username,
        full_name: spec.nickname,
        profile_pic_url: spec.avatarUrl,
        profile_pic_url_hd: spec.avatarUrl,
        is_private: false,
        live_broadcast_id: spec.live?.broadcastId || null,
        broadcast: spec.live
          ? {
              id: spec.live.broadcastId || '18000000000000001',
              dash_abr_playback_url: spec.live.streamUrl,
              broadcast_status: 'active',
              broadcast_message: spec.live.title,
            }
          : null,
        edge_owner_to_timeline_media: {
          count: edges.length,
          edges,
        },
      },
    },
    status: 'ok',
  };
}

export function buildInstagramHtml(username: string, spec: MockProfileSpec): string {
  if (spec.blockMode === 'login_wall') {
    return '<html><head><title>Login • Instagram</title></head><body><form id="loginForm"><input name="username"/></form>{"require_login":true}</body></html>';
  }
  const livePart = spec.live
    ? `"broadcast_id":"${spec.live.broadcastId || '18000000000000001'}","dash_abr_playback_url":"${spec.live.streamUrl}"`
    : '';
  return `<!doctype html><html><head><title>${escapeHtmlAttr(spec.nickname)} (@${escapeHtmlAttr(username)}) • Instagram photos and videos</title><meta property="og:title" content="${escapeHtmlAttr(spec.nickname)} (@${escapeHtmlAttr(username)})" /><meta property="og:image" content="${escapeHtmlAttr(spec.avatarUrl)}" /></head><body><script>window.__data={"profile_id":"${escapeHtmlAttr(spec.id)}","username":"${escapeHtmlAttr(username)}"${livePart ? ',' + livePart : ''}};</script></body></html>`;
}

export function buildInstagramStoryJson(spec: MockProfileSpec): Record<string, unknown> {
  const items = (spec.stories || []).map((s) => ({
    id: s.id,
    pk: s.id,
    taken_at: s.createTime ?? Math.floor(Date.now() / 1000),
    expiring_at: s.expireTime ?? Math.floor(Date.now() / 1000) + 86400,
    media_type: s.videoUrl ? 2 : 1,
    caption: { text: s.title || `IG Story ${s.id}` },
    video_versions: s.videoUrl ? [{ url: s.videoUrl, width: 1080, height: 1920 }] : undefined,
    image_versions2: {
      candidates: [
        {
          url: s.coverUrl || (s.photoUrls && s.photoUrls[0]) || `https://cdn.example.test/ig_story_${s.id}.jpg`,
          width: 1080,
          height: 1920,
        },
      ],
    },
  }));

  return {
    reel: {
      id: spec.id,
      items,
      user: { pk: spec.id, full_name: spec.nickname, profile_pic_url: spec.avatarUrl },
    },
    reels: {
      [spec.id]: {
        id: spec.id,
        items,
      },
    },
    broadcast: spec.live
      ? {
          id: spec.live.broadcastId || '18000000000000001',
          dash_abr_playback_url: spec.live.streamUrl,
          broadcast_status: 'active',
          broadcast_message: spec.live.title,
        }
      : undefined,
    status: 'ok',
  };
}

export function buildFacebookHtml(username: string, spec: MockProfileSpec): string {
  if (spec.blockMode === 'login_wall') {
    return '<!doctype html><html><head><title>Log in to Facebook</title></head><body><form id="login_form" action="/login/">You must log in to continue.</form></body></html>';
  }
  if (spec.blockMode === 'unavailable' || spec.blockMode === '404') {
    return '<!doctype html><html><head><title>Page Not Found</title></head><body>This page isn\'t available</body></html>';
  }

  const postsPayload =
    (spec.posts || []).length > 0
      ? `<script type="application/json" data-sjs>${JSON.stringify({
          timeline_list_feed_units: {
            edges: (spec.posts || []).map((p) => {
              const media: Record<string, unknown> = {};
              if (p.videoUrl) {
                media.playable_url_quality_hd = p.videoUrl;
                media.preferred_thumbnail = {
                  image: { uri: p.coverUrl || `https://cdn.example.test/fb_${p.id}.jpg` },
                };
              } else if (p.photoUrls && p.photoUrls.length > 0) {
                media.photo_image = { uri: p.photoUrls[0] };
                media.preferred_thumbnail = {
                  image: { uri: p.coverUrl || p.photoUrls[0] },
                };
                if (p.photoUrls.length > 1) {
                  media.all_subattachments = {
                    nodes: p.photoUrls.map((u) => ({ media: { photo_image: { uri: u } } })),
                  };
                }
              } else {
                media.playable_url_quality_hd = `https://cdn.example.test/fb_${p.id}.mp4`;
                media.preferred_thumbnail = {
                  image: { uri: p.coverUrl || `https://cdn.example.test/fb_${p.id}.jpg` },
                };
              }
              return {
                node: {
                  post_id: p.id,
                  wwwURL: `https://www.facebook.com/${username}/posts/${p.id}`,
                  message: { text: p.title },
                  creation_time: p.createTime ?? Math.floor(Date.now() / 1000),
                  is_pinned: Boolean(p.isPinned),
                  attachments: [{ media }],
                },
              };
            }),
          },
        })}</script>`
      : '';

  const postsHtml =
    (spec.posts || [])
      .map(
        (p) =>
          `<article data-post-id="${escapeHtmlAttr(p.id)}"><a href="https://www.facebook.com/${escapeHtmlAttr(username)}/posts/${escapeHtmlAttr(p.id)}">${escapeHtmlAttr(p.title)}</a></article>`
      )
      .join('\n') + postsPayload;

  const storiesPayload =
    (spec.stories || []).length > 0
      ? `<script type="application/json" data-sjs>${JSON.stringify({
          unified_stories_buckets: {
            edges: [
              {
                node: {
                  id: spec.id,
                  unified_stories: {
                    edges: (spec.stories || []).map((s) => ({
                      node: {
                        id: s.id,
                        story_card_id: s.id,
                        creation_time: s.createTime ?? Math.floor(Date.now() / 1000),
                        attachments: [
                          {
                            media: {
                              playable_url_quality_hd: s.videoUrl || `https://cdn.example.test/fb_story_${s.id}.mp4`,
                              preferred_thumbnail: {
                                image: { uri: s.coverUrl || `https://cdn.example.test/fb_story_${s.id}.jpg` },
                              },
                            },
                          },
                        ],
                      },
                    })),
                  },
                },
              },
            ],
          },
        })}</script>`
      : '';

  const storiesHtml = (spec.stories || [])
    .map(
      (s) =>
        `<div data-story-id="${escapeHtmlAttr(s.id)}"><a href="https://www.facebook.com/stories/${escapeHtmlAttr(spec.id)}/${escapeHtmlAttr(s.id)}/">${escapeHtmlAttr(s.title || `FB Story ${s.id}`)}</a></div>`
    )
    .join('\n') + storiesPayload;

  const liveScript = spec.live
    ? `<script>{"is_live_streaming":true,"broadcast_status":"LIVE","dash_abr_playback_url":"${escapeHtmlAttr(spec.live.streamUrl)}","title":"${escapeHtmlAttr(spec.live.title)}"}</script>`
    : '';

  return `<!doctype html><html><head><title>${escapeHtmlAttr(spec.nickname)} | Facebook</title><meta property="og:title" content="${escapeHtmlAttr(spec.nickname)}" /><meta property="og:image" content="${escapeHtmlAttr(spec.avatarUrl)}" /></head><body><script>{"userID":"${escapeHtmlAttr(spec.id)}","entity_id":"${escapeHtmlAttr(spec.id)}","profile_owner":{"id":"${escapeHtmlAttr(spec.id)}","name":"${escapeHtmlAttr(spec.nickname)}"}}</script>${liveScript}${postsHtml}${storiesHtml}</body></html>`;
}

export function buildXGraphqlUserJson(username: string, spec: MockProfileSpec): Record<string, unknown> {
  if (spec.blockMode === '404' || spec.blockMode === 'unavailable') {
    return {
      data: {
        user: {
          result: {
            __typename: 'UserUnavailable',
            reason: 'NotFound',
          },
        },
      },
    };
  }
  const pinnedIds = (spec.posts || []).filter((p) => p.isPinned).map((p) => p.id);
  return {
    data: {
      user: {
        result: {
          __typename: 'User',
          rest_id: spec.id,
          id: spec.id,
          legacy: {
            name: spec.nickname,
            screen_name: username,
            profile_image_url_https: spec.avatarUrl,
            pinned_tweet_ids_str: pinnedIds,
          },
        },
      },
    },
  };
}

export function buildXGraphqlTweetsJson(username: string, spec: MockProfileSpec): Record<string, unknown> {
  const pinnedIds = new Set((spec.posts || []).filter((p) => p.isPinned).map((p) => p.id));
  const entries = (spec.posts || []).map((p, idx) => ({
    entryId: `tweet-${p.id}`,
    sortIndex: String(1000 - idx),
    content: {
      entryType: 'TimelineTimelineItem',
      itemContent: {
        tweet_results: {
          result: {
            __typename: 'Tweet',
            rest_id: p.id,
            core: {
              user_results: {
                result: {
                  rest_id: spec.id,
                  legacy: {
                    screen_name: username,
                    name: spec.nickname,
                    pinned_tweet_ids_str: Array.from(pinnedIds),
                  },
                },
              },
            },
            legacy: {
              id_str: p.id,
              full_text: p.title,
              created_at: new Date((p.createTime ?? Math.floor(Date.now() / 1000)) * 1000).toUTCString(),
              extended_entities: {
                media: [
                  p.videoUrl
                    ? {
                        type: 'video',
                        media_url_https: p.coverUrl || `https://cdn.example.test/x_${p.id}.jpg`,
                        video_info: {
                          variants: [
                            { bitrate: 320000, content_type: 'video/mp4', url: `https://cdn.example.test/x_${p.id}_low.mp4` },
                            { bitrate: 2176000, content_type: 'video/mp4', url: p.videoUrl },
                          ],
                        },
                      }
                    : {
                        type: 'photo',
                        media_url_https: (p.photoUrls && p.photoUrls[0]) || p.coverUrl || `https://cdn.example.test/x_${p.id}.jpg`,
                      },
                ],
              },
            },
          },
        },
      },
    },
  }));

  return {
    data: {
      user: {
        result: {
          timeline_v2: {
            timeline: {
              instructions: [
                ...(pinnedIds.size > 0
                  ? [
                      {
                        type: 'TimelinePinEntry',
                        entry: entries.find((e) => pinnedIds.has(e.entryId.replace('tweet-', ''))),
                      },
                    ]
                  : []),
                {
                  type: 'TimelineAddEntries',
                  entries,
                },
              ],
            },
          },
        },
      },
    },
  };
}

export function buildXSyndicationHtml(username: string, spec: MockProfileSpec): string {
  const pinnedIds = (spec.posts || []).filter((p) => p.isPinned).map((p) => p.id);
  const nextData = {
    props: {
      pageProps: {
        user: {
          id_str: spec.id,
          name: spec.nickname,
          screen_name: username,
          profile_image_url_https: spec.avatarUrl,
          pinned_tweet_ids_str: pinnedIds,
        },
        timeline: {
          entries: (spec.posts || []).map((p) => ({
            type: 'tweet',
            entry_id: `tweet-${p.id}`,
            content: {
              tweet: {
                id_str: p.id,
                full_text: p.title,
                user: {
                  id_str: spec.id,
                  name: spec.nickname,
                  screen_name: username,
                  profile_image_url_https: spec.avatarUrl,
                  pinned_tweet_ids_str: pinnedIds,
                },
                extended_entities: {
                  media: [
                    p.videoUrl
                      ? {
                          type: 'video',
                          media_url_https: p.coverUrl || `https://cdn.example.test/x_${p.id}.jpg`,
                          video_info: {
                            variants: [
                              { bitrate: 320000, content_type: 'video/mp4', url: `https://cdn.example.test/x_${p.id}_low.mp4` },
                              { bitrate: 2176000, content_type: 'video/mp4', url: p.videoUrl },
                            ],
                          },
                        }
                      : {
                          type: 'photo',
                          media_url_https: (p.photoUrls && p.photoUrls[0]) || p.coverUrl || `https://cdn.example.test/x_${p.id}.jpg`,
                        },
                  ],
                },
              },
            },
          })),
        },
      },
    },
  };
  return `<!doctype html><html><head><title>${escapeHtmlAttr(spec.nickname)} (@${escapeHtmlAttr(username)}) / X</title></head><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script></body></html>`;
}

export function buildXProfileHtml(username: string, spec: MockProfileSpec): string {
  const broadcastSnippet = spec.live?.broadcastId
    ? `<a href="https://x.com/i/broadcasts/${escapeHtmlAttr(spec.live.broadcastId)}">LIVE</a>"broadcast_id":"${escapeHtmlAttr(spec.live.broadcastId)}"`
    : '';
  return `<!doctype html><html><head><title>${escapeHtmlAttr(spec.nickname)} (@${escapeHtmlAttr(username)}) / X</title><meta property="og:title" content="${escapeHtmlAttr(spec.nickname)} (@${escapeHtmlAttr(username)})" /><meta property="og:image" content="${escapeHtmlAttr(spec.avatarUrl)}" /></head><body><script>{"rest_id":"${escapeHtmlAttr(spec.id)}","screen_name":"${escapeHtmlAttr(username)}","name":"${escapeHtmlAttr(spec.nickname)}","profile_image_url_https":"${escapeHtmlAttr(spec.avatarUrl)}"}</script>${broadcastSnippet}</body></html>`;
}

function findProfileSpec(
  map: Map<string, MockProfileSpec>,
  rawKey: string
): [string, MockProfileSpec] | undefined {
  const lower = rawKey.toLowerCase();
  for (const [k, v] of map.entries()) {
    if (k.toLowerCase() === lower || v.id === rawKey) {
      return [k, v];
    }
  }
  return undefined;
}

function makeBlockResponse(spec: MockProfileSpec, platformLabel: string): Response | null {
  if (spec.httpStatus === 404 || spec.blockMode === '404') {
    return new Response(`${platformLabel} Not Found`, { status: 404, headers: { 'content-type': 'text/html' } });
  }
  if (spec.httpStatus === 401 || spec.blockMode === '401') {
    return new Response(
      JSON.stringify({ message: 'login_required', require_login: true, status: 'fail' }),
      { status: 401, headers: { 'content-type': 'application/json' } }
    );
  }
  if (spec.httpStatus === 403 || spec.blockMode === '403') {
    return new Response(
      JSON.stringify({ message: 'challenge_required', error: 'Forbidden', status: 'fail' }),
      { status: 403, headers: { 'content-type': 'application/json' } }
    );
  }
  if (spec.httpStatus === 429 || spec.blockMode === '429') {
    return new Response(
      JSON.stringify({ message: 'rate_limit_exceeded', status: 'fail' }),
      { status: 429, headers: { 'content-type': 'application/json' } }
    );
  }
  return null;
}

const KNOWN_MOCKED_DOMAINS = [
  'tiktok.com',
  'instagram.com',
  'facebook.com',
  'x.com',
  'twitter.com',
  'twimg.com',
  'fb.com',
  'fb.watch',
  'instagr.am',
  'cdn.example.test',
  'scontent.example.test',
  'api.telegram.org',
  'tikwm.com',
] as const;

function matchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function isKnownMockedHost(host: string): boolean {
  return KNOWN_MOCKED_DOMAINS.some((domain) => matchesDomain(host, domain));
}

function createMockExternalRouter(mocks: MockUpstreamConfig): (req: RecordedExternalRequest) => Promise<Response> {
  let telegramCount = 0;

  return async (req: RecordedExternalRequest): Promise<Response> => {
    if (mocks.customHandler) {
      const override = await mocks.customHandler(req);
      if (override) return override;
    }

    const parsed = new URL(req.url);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname;
    const hasCookie = Boolean(req.headers.cookie && req.headers.cookie.trim().length > 0);

    // 1. Media CDN
    if (
      matchesDomain(host, 'cdn.example.test') ||
      matchesDomain(host, 'scontent.example.test') ||
      host === 'pbs.twimg.com' ||
      host === 'video.twimg.com'
    ) {
      const exact = mocks.cdnAssets.get(req.url) || mocks.cdnAssets.get(pathname);
      if (exact) {
        const body: BodyInit = typeof exact.body === 'string' ? exact.body : new Uint8Array(exact.body);
        return new Response(body, {
          status: exact.status,
          headers: { 'content-type': exact.contentType },
        });
      }
      if (pathname.endsWith('.jpg') || pathname.endsWith('.png') || pathname.endsWith('.webp')) {
        return new Response(new Uint8Array(Buffer.from(`JPEG_BINARY_${pathname}`)), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        });
      }
      return new Response(new Uint8Array(Buffer.from(`MP4_BINARY_${pathname}`)), {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      });
    }

    // 2. Telegram Bot API
    if (matchesDomain(host, 'api.telegram.org')) {
      telegramCount += 1;
      if (mocks.telegramFailAfter && telegramCount > mocks.telegramFailAfter) {
        return new Response(JSON.stringify({ ok: false, description: 'Simulated Telegram failure' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (mocks.telegramStatus !== 200) {
        return new Response(JSON.stringify({ ok: false, description: `Telegram HTTP ${mocks.telegramStatus}` }), {
          status: mocks.telegramStatus,
          headers: { 'content-type': 'application/json' },
        });
      }
      const chatId = req.formFields?.chat_id || '-1004484723209';
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            message_id: 900 + telegramCount,
            chat: { id: Number(chatId) || chatId },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    // 3. TikWM API
    if (matchesDomain(host, 'tikwm.com')) {
      const targetPostUrl = parsed.searchParams.get('url') || '';
      const override = mocks.tikwmOverrides.get(targetPostUrl);
      if (override) {
        return new Response(
          JSON.stringify({
            code: override.code,
            data: { hdplay: override.hdplay, play: override.play, images: override.images },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            hdplay: 'https://cdn.example.test/tikwm_hd.mp4',
            play: 'https://cdn.example.test/tikwm_sd.mp4',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    // 4. TikTok
    if (matchesDomain(host, 'tiktok.com')) {
      if (pathname.includes('/api/story/item_list')) {
        const authorId = parsed.searchParams.get('authorId') || '';
        for (const [, spec] of mocks.tiktok.entries()) {
          if (spec.id === authorId) {
            const itemList = (spec.stories || []).map((s) => ({
              id: s.id,
              desc: s.title || `TT Story ${s.id}`,
              createTime: s.createTime ?? Math.floor(Date.now() / 1000),
              expireTime: s.expireTime ?? Math.floor(Date.now() / 1000) + 86400,
              video: s.videoUrl
                ? { cover: s.coverUrl || `https://cdn.example.test/tt_story_${s.id}.jpg`, playAddr: s.videoUrl }
                : undefined,
              imagePost:
                s.photoUrls && s.photoUrls.length > 0
                  ? { images: s.photoUrls.map((u) => ({ imageURL: { urlList: [u] } })) }
                  : undefined,
            }));
            return new Response(JSON.stringify({ itemList }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
        }
        return new Response(JSON.stringify({ itemList: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      const match = pathname.match(/^\/@([^/]+)/);
      const username = match?.[1] ? decodeURIComponent(match[1]) : '';
      const found = findProfileSpec(mocks.tiktok, username);
      if (!found) {
        return new Response('TikTok user not found', { status: 404, headers: { 'content-type': 'text/html' } });
      }
      const [canonName, spec] = found;
      if (spec.requireCookie && !hasCookie) {
        return new Response('<html><body>Captcha Challenge</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      const blocked = makeBlockResponse(spec, 'TikTok');
      if (blocked) return blocked;
      return new Response(buildTikTokProfileHtml(canonName, spec), {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }

    // 5. Instagram
    if (matchesDomain(host, 'instagram.com') || matchesDomain(host, 'instagr.am')) {
      if (pathname.includes('/api/v1/users/web_profile_info')) {
        const uname = parsed.searchParams.get('username') || '';
        const found = findProfileSpec(mocks.instagram, uname);
        if (!found) {
          return new Response(JSON.stringify({ data: { user: null }, status: 'ok' }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        }
        const [canonName, spec] = found;
        if (spec.requireCookie && !hasCookie) {
          return new Response(JSON.stringify({ message: 'Please wait a few minutes', require_login: true, status: 'fail' }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          });
        }
        const blocked = makeBlockResponse(spec, 'Instagram');
        if (blocked) return blocked;
        return new Response(JSON.stringify(buildInstagramWebProfileJson(canonName, spec)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      const usernameInfoMatch = pathname.match(/\/api\/v1\/users\/([^/]+)\/usernameinfo/);
      if (usernameInfoMatch?.[1]) {
        const found = findProfileSpec(mocks.instagram, decodeURIComponent(usernameInfoMatch[1]));
        if (!found) {
          return new Response(JSON.stringify({ message: 'User not found', status: 'fail' }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        }
        const [canonName, spec] = found;
        if (spec.requireCookie && !hasCookie) {
          return new Response(JSON.stringify({ message: 'login_required', status: 'fail' }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          });
        }
        const blocked = makeBlockResponse(spec, 'Instagram');
        if (blocked) return blocked;
        return new Response(
          JSON.stringify({
            user: {
              pk: spec.id,
              id: spec.id,
              username: canonName,
              full_name: spec.nickname,
              profile_pic_url: spec.avatarUrl,
            },
            status: 'ok',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (pathname.includes('/api/v1/feed/user/') && pathname.includes('/story')) {
        const idMatch = pathname.match(/\/feed\/user\/([^/]+)\/story/);
        const found = idMatch?.[1] ? findProfileSpec(mocks.instagram, idMatch[1]) : undefined;
        if (!found) {
          return new Response(JSON.stringify({ reel: null, status: 'ok' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        const [, spec] = found;
        if (spec.requireCookie && !hasCookie) {
          return new Response(JSON.stringify({ message: 'login_required', status: 'fail' }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          });
        }
        const blocked = makeBlockResponse(spec, 'Instagram');
        if (blocked) return blocked;
        return new Response(JSON.stringify(buildInstagramStoryJson(spec)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (pathname.includes('/api/v1/feed/reels_media')) {
        const reelId = parsed.searchParams.get('reel_ids') || '';
        const found = findProfileSpec(mocks.instagram, reelId);
        if (!found) {
          return new Response(JSON.stringify({ reels: {}, status: 'ok' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        const [, spec] = found;
        if (spec.requireCookie && !hasCookie) {
          return new Response(JSON.stringify({ message: 'login_required', status: 'fail' }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          });
        }
        const blocked = makeBlockResponse(spec, 'Instagram');
        if (blocked) return blocked;
        return new Response(JSON.stringify(buildInstagramStoryJson(spec)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (pathname.includes('/api/v1/live/web_info')) {
        const targetId = parsed.searchParams.get('target_user_id') || '';
        const found = findProfileSpec(mocks.instagram, targetId);
        if (!found || !found[1].live) {
          return new Response(JSON.stringify({ message: 'user is not live', status: 'fail' }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        }
        const [, spec] = found;
        return new Response(
          JSON.stringify({
            broadcast: {
              id: spec.live!.broadcastId || '18000000000000001',
              dash_abr_playback_url: spec.live!.streamUrl,
              broadcast_status: 'active',
              broadcast_message: spec.live!.title,
            },
            status: 'ok',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      const igProfileMatch = pathname.match(/^\/([^/]+)/);
      const uname = igProfileMatch?.[1] || '';
      const found = findProfileSpec(mocks.instagram, uname);
      if (!found) {
        return new Response('Instagram user not found', { status: 404, headers: { 'content-type': 'text/html' } });
      }
      const [canonName, spec] = found;
      if (spec.requireCookie && !hasCookie) {
        return new Response(
          '<html><head><title>Login • Instagram</title></head><body>{"require_login":true}</body></html>',
          { status: 401, headers: { 'content-type': 'text/html' } }
        );
      }
      const blocked = makeBlockResponse(spec, 'Instagram');
      if (blocked) return blocked;
      return new Response(buildInstagramHtml(canonName, spec), {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }

    // 6. Facebook
    if (matchesDomain(host, 'facebook.com') || matchesDomain(host, 'fb.com') || matchesDomain(host, 'fb.watch')) {
      let targetKey = '';
      if (pathname.includes('profile.php')) {
        targetKey = parsed.searchParams.get('id') || '';
      } else if (pathname.startsWith('/stories/')) {
        const parts = pathname.split('/').filter(Boolean);
        targetKey = parts[1] || '';
      } else {
        const parts = pathname.split('/').filter(Boolean);
        targetKey = parts[0] || '';
      }

      const found = findProfileSpec(mocks.facebook, decodeURIComponent(targetKey));
      if (!found) {
        return new Response('<html><body>This page isn\'t available</body></html>', {
          status: 404,
          headers: { 'content-type': 'text/html' },
        });
      }
      const [canonName, spec] = found;
      if (spec.requireCookie && !hasCookie) {
        return new Response(
          '<!doctype html><html><head><title>Log in to Facebook</title></head><body><form id="login_form" action="/login/">You must log in to continue.</form></body></html>',
          { status: 200, headers: { 'content-type': 'text/html' } }
        );
      }
      const blocked = makeBlockResponse(spec, 'Facebook');
      if (blocked) return blocked;
      return new Response(buildFacebookHtml(canonName, spec), {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }

    // 7. X / Twitter
    if (matchesDomain(host, 'twitter.com') || matchesDomain(host, 'x.com') || matchesDomain(host, 'twimg.com')) {
      if (pathname.includes('/1.1/guest/activate.json')) {
        return new Response(JSON.stringify({ guest_token: 'gt_mock_12345' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (pathname.includes('/1.1/broadcasts/show.json')) {
        const ids = (parsed.searchParams.get('ids') || '').split(',').filter(Boolean);
        const broadcasts: Record<string, unknown> = {};
        for (const [uname, spec] of mocks.x.entries()) {
          if (spec.live?.broadcastId && ids.includes(spec.live.broadcastId)) {
            broadcasts[spec.live.broadcastId] = {
              id: spec.live.broadcastId,
              state: 'RUNNING',
              media_key: spec.live.mediaKey || `mk_${spec.live.broadcastId}`,
              status: spec.live.title,
              username: uname,
            };
          }
        }
        return new Response(JSON.stringify({ broadcasts }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (pathname.includes('/1.1/live_video_stream/status/')) {
        const mediaKey = pathname.split('/').pop() || '';
        for (const [, spec] of mocks.x.entries()) {
          if (spec.live && (spec.live.mediaKey === mediaKey || `mk_${spec.live.broadcastId}` === mediaKey)) {
            return new Response(
              JSON.stringify({
                source: {
                  location: spec.live.streamUrl,
                  noRedirectPlaybackUrl: spec.live.streamUrl,
                },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            );
          }
        }
        return new Response(JSON.stringify({}), { status: 404, headers: { 'content-type': 'application/json' } });
      }

      if (pathname.includes('/graphql/') && pathname.includes('UserByScreenName')) {
        const varsRaw = parsed.searchParams.get('variables') || '{}';
        let screenName = '';
        try {
          screenName = String((JSON.parse(varsRaw) as { screen_name?: string }).screen_name || '');
        } catch {
          screenName = '';
        }
        const found = findProfileSpec(mocks.x, screenName);
        if (!found) {
          return new Response(
            JSON.stringify({ data: { user: { result: { __typename: 'UserUnavailable', reason: 'NotFound' } } } }),
            { status: 404, headers: { 'content-type': 'application/json' } }
          );
        }
        const [canonName, spec] = found;
        if (spec.requireCookie && !hasCookie) {
          return new Response(JSON.stringify({ errors: [{ code: 32, message: 'Could not authenticate you' }] }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          });
        }
        const blocked = makeBlockResponse(spec, 'X');
        if (blocked) return blocked;
        return new Response(JSON.stringify(buildXGraphqlUserJson(canonName, spec)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (pathname.includes('/graphql/') && pathname.includes('UserTweets')) {
        const varsRaw = parsed.searchParams.get('variables') || '{}';
        let userId = '';
        try {
          userId = String((JSON.parse(varsRaw) as { userId?: string }).userId || '');
        } catch {
          userId = '';
        }
        const found = findProfileSpec(mocks.x, userId);
        if (!found) {
          return new Response(JSON.stringify({ data: {} }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        }
        const [canonName, spec] = found;
        if (spec.requireCookie && !hasCookie) {
          return new Response(JSON.stringify({ errors: [{ code: 32, message: 'Could not authenticate you' }] }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          });
        }
        const blocked = makeBlockResponse(spec, 'X');
        if (blocked) return blocked;
        return new Response(JSON.stringify(buildXGraphqlTweetsJson(canonName, spec)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (pathname.includes('/srv/timeline-profile/screen-name/')) {
        const uname = decodeURIComponent(pathname.split('/').pop() || '');
        const found = findProfileSpec(mocks.x, uname);
        if (!found) {
          return new Response('Not found', { status: 404, headers: { 'content-type': 'text/html' } });
        }
        const [canonName, spec] = found;
        if (spec.requireCookie && !hasCookie) {
          return new Response('Unauthorized', { status: 401, headers: { 'content-type': 'text/plain' } });
        }
        const blocked = makeBlockResponse(spec, 'X');
        if (blocked) return blocked;
        return new Response(buildXSyndicationHtml(canonName, spec), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }

      const profileParts = pathname.split('/').filter(Boolean);
      const uname = profileParts[0] || '';
      const found = findProfileSpec(mocks.x, decodeURIComponent(uname));
      if (!found) {
        return new Response('X profile not found', { status: 404, headers: { 'content-type': 'text/html' } });
      }
      const [canonName, spec] = found;
      if (spec.requireCookie && !hasCookie) {
        return new Response(JSON.stringify({ errors: [{ message: 'Authentication required' }] }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
      const blocked = makeBlockResponse(spec, 'X');
      if (blocked) return blocked;
      return new Response(buildXProfileHtml(canonName, spec), {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }

    if (isKnownMockedHost(host)) {
      return new Response(`Mock upstream 404 for ${req.url}`, { status: 404 });
    }
    throw new Error(`Unmocked external fetch blocked: ${req.url}`);
  };
}

export async function createR1R2TestEnv(options?: {
  envCookies?: PlatformCookies;
  telegram?: { botToken?: string; chatId?: string; enabled?: boolean };
  liveCheckBatchFn?: StartServerOptions['liveCheckBatchFn'];
  customHandler?: MockUpstreamConfig['customHandler'];
}): Promise<R1R2TestEnv> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulseradar-e2e-r1r2r3-'));
  const mediaDir = path.join(tempDir, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });

  const savedEnv = applyEnvOverrides({
    DRIVE_MEDIA_DIR: mediaDir,
    GOOGLE_DRIVE_PATH: undefined,
    TIKTOK_COOKIE: undefined,
    INSTAGRAM_COOKIE: undefined,
    FACEBOOK_COOKIE: undefined,
    X_COOKIE: undefined,
    TELEGRAM_BOT_TOKEN: options?.telegram?.botToken,
    TELEGRAM_CHAT_ID: options?.telegram?.chatId,
    TELEGRAM_STORAGE_ENABLED: options?.telegram?.enabled ? 'true' : 'false',
    GDRIVE_SERVICE_ACCOUNT_KEY: undefined,
    GOOGLE_SERVICE_ACCOUNT_KEY: undefined,
    GDRIVE_SERVICE_ACCOUNT_PATH: undefined,
    GOOGLE_APPLICATION_CREDENTIALS: undefined,
    STORAGE_CLEANUP_LOCAL: 'false',
    WATCHER_ENABLED: 'false',
    AUTO_SCAN_ENABLED: 'false',
  });

  const mocks: MockUpstreamConfig = {
    tiktok: new Map(),
    instagram: new Map(),
    facebook: new Map(),
    x: new Map(),
    tikwmOverrides: new Map(),
    cdnAssets: new Map(),
    telegramStatus: 200,
    customHandler: options?.customHandler,
  };

  const recordedRequests: RecordedExternalRequest[] = [];
  const router = createMockExternalRouter(mocks);
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const urlStr =
      typeof input === 'string'
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;

    const parsed = new URL(urlStr);
    if (LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
      return originalFetch(input, init);
    }

    const reqObj = input instanceof Request ? input : undefined;
    const method = (init?.method || reqObj?.method || 'GET').toUpperCase();
    const headers = normalizeHeaders(init?.headers, reqObj?.headers);

    let bodyText: string | undefined;
    let formFields: Record<string, string> | undefined;
    let formFiles: Array<{ field: string; name: string; size: number; type: string }> | undefined;

    if (init?.body instanceof FormData) {
      formFields = {};
      formFiles = [];
      for (const [key, val] of init.body.entries()) {
        if (typeof val === 'string') {
          formFields[key] = val;
        } else {
          formFiles.push({
            field: key,
            name: val.name || 'blob',
            size: val.size,
            type: val.type || '',
          });
        }
      }
    } else if (typeof init?.body === 'string') {
      bodyText = init.body;
    } else if (reqObj && !reqObj.bodyUsed && method !== 'GET' && method !== 'HEAD') {
      try {
        bodyText = await reqObj.clone().text();
      } catch {
        // ignore body read error
      }
    }

    const recorded: RecordedExternalRequest = {
      url: urlStr,
      hostname: parsed.hostname.toLowerCase(),
      pathname: parsed.pathname,
      method,
      headers,
      bodyText,
      formFields,
      formFiles,
    };
    recordedRequests.push(recorded);

    return router(recorded);
  }) as typeof fetch;

  let server: StartedServer;
  try {
    server = await startServer({
      port: 0,
      host: '127.0.0.1',
      dataDir: tempDir,
      mountFrontend: false,
      autoScanEnabled: false,
      startAutoScanner: false,
      startWatcher: false,
      autoScanStaggerMs: 0,
      envCookies: options?.envCookies,
      liveCheckBatchFn: options?.liveCheckBatchFn,
      androidClientOptions: {
        timeoutMs: 1500,
        retryDelayMs: 25,
        maxRetries: 1,
      },
    });
  } catch (err) {
    globalThis.fetch = originalFetch;
    restoreEnvVars(savedEnv);
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw err;
  }

  const apiJson = async <T = Record<string, unknown>>(
    method: string,
    routePath: string,
    body?: unknown
  ): Promise<{ status: number; ok: boolean; data: T }> => {
    const resp = await originalFetch(`${server.url}${routePath}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await resp.text();
    let data = {} as T;
    try {
      data = JSON.parse(text) as T;
    } catch {
      data = { rawText: text } as unknown as T;
    }
    return { status: resp.status, ok: resp.ok, data };
  };

  const triggerWatcherCycle = async (eventType: WatcherEventType): Promise<unknown> => {
    const w = (server as unknown as CreatedApp).watcher as unknown as {
      updateConfig?: (partial: Record<string, unknown>) => void;
      runCycle?: (eventType: WatcherEventType) => Promise<unknown>;
      getWatchers?: () => Iterable<{ updateConfig?: (p: Record<string, unknown>) => void }>;
      watchers?: Map<string, { updateConfig?: (p: Record<string, unknown>) => void }> | Record<string, { updateConfig?: (p: Record<string, unknown>) => void }>;
    };

    w.updateConfig?.({ staggerRangeMs: [0, 0] });
    if (typeof w.getWatchers === 'function') {
      for (const child of w.getWatchers()) {
        child.updateConfig?.({ staggerRangeMs: [0, 0] });
      }
    } else if (w.watchers instanceof Map) {
      for (const child of w.watchers.values()) {
        child.updateConfig?.({ staggerRangeMs: [0, 0] });
      }
    } else if (w.watchers && typeof w.watchers === 'object') {
      for (const child of Object.values(w.watchers)) {
        child.updateConfig?.({ staggerRangeMs: [0, 0] });
      }
    }

    assert.equal(
      typeof w.runCycle,
      'function',
      'server.watcher must expose runCycle(eventType) for deterministic E2E watcher execution'
    );
    return w.runCycle!(eventType);
  };

  let cleaned = false;

  return {
    tempDir,
    mediaDir,
    server,
    mocks,
    recordedRequests,
    clearRecordedRequests: () => {
      recordedRequests.length = 0;
    },
    apiJson,
    triggerWatcherCycle,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      globalThis.fetch = originalFetch;
      restoreEnvVars(savedEnv);
      await server.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

export async function loadContractModule<T = Record<string, unknown>>(relativeFromRepoRoot: string): Promise<T> {
  const fullPath = path.resolve(process.cwd(), relativeFromRepoRoot);
  if (!fs.existsSync(fullPath)) {
    assert.fail(`Expected contract module ${relativeFromRepoRoot} to exist (${fullPath})`);
  }
  const mod = await import(`file://${fullPath.replace(/\\/g, '/')}`);
  return mod as T;
}

export function asTikTokEvent(evt: ContractWatcherEvent): TikTokEvent {
  return evt as unknown as TikTokEvent;
}

export function makeRule(params: {
  id: string;
  keyword: string;
  platform: 'reddit' | 'hackernews' | 'github' | 'bluesky';
  sourceDomain?: string;
  webhookServerId?: string;
  enabled?: boolean;
}): KeywordRuleItem {
  return {
    id: params.id,
    ownerId: 'e2e_owner',
    keyword: params.keyword,
    excludedKeywords: params.sourceDomain ? `source:${params.sourceDomain}` : '',
    matchType: 'regex',
    platforms: params.platform,
    webhookServerId: params.webhookServerId || 'srv_sandbox',
    enabled: params.enabled ?? true,
    matchCount: 0,
    createdAt: '2026-11-21T00:00:00.000Z',
    updatedAt: '2026-11-21T00:00:00.000Z',
  };
}

export function makeSandboxServer(id = 'srv_sandbox', format: 'json' | 'discord' | 'slack' | 'telegram' = 'json'): WebhookServerItem {
  return {
    id,
    ownerId: 'e2e_owner',
    name: `Sandbox (${format})`,
    url: `/api/webhook-sandbox?channel=${format}`,
    format,
    secretHeader: 'whsec_test_secret',
    enabled: true,
    createdAt: '2026-11-21T00:00:00.000Z',
    updatedAt: '2026-11-21T00:00:00.000Z',
  };
}

export async function startLocalHttpServer(
  handler: (req: http.IncomingMessage, bodyText: string, res: http.ServerResponse) => void
): Promise<{ url: string; close: () => Promise<void> }> {
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      handler(req, Buffer.concat(chunks).toString('utf-8'), res);
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
  const port = (srv.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
  };
}

export type { LiveCheckResult, WatcherState };
