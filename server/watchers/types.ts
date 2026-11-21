import type { LivePlatform, PlatformCookies } from '../liveCheckers/types';
import type { MultiPlatformSettings } from '../../src/utils/scannerEngine';

export type { LivePlatform } from '../liveCheckers/types';

export type WatcherEventType = 'live' | 'post' | 'story';

export type CollectorStatus =
  | 'OK'
  | 'UNSUPPORTED'
  | 'AUTH_REQUIRED'
  | 'BLOCKED'
  | 'NOT_FOUND'
  | 'PRIVATE'
  | 'RATE_LIMITED'
  | 'ERROR';

export interface WatcherEvent {
  platform?: LivePlatform; // default 'TIKTOK' when omitted by legacy callers
  username: string;
  eventType: WatcherEventType;
  itemId: string; // room_id/broadcast_id for live, post/video/tweet id for post, story_id for story
  url: string;
  title: string;
  thumbnailUrl?: string | null;
  streamUrl?: string | null;
  detectedAt: string;
  isPinned?: boolean;
  metadata?: Record<string, unknown> & {
    videoUrl?: string;
    videoUrls?: string[];
    playAddr?: string;
    photoUrls?: string[];
    downloadHeaders?: Record<string, string>;
  };
}

export type TikTokEvent = WatcherEvent;

export interface CollectorFetchResult<TEvent = WatcherEvent> {
  status: CollectorStatus;
  events: TEvent[];
  reason?: string;
  httpStatus?: number;
  usedCookie?: boolean;
}

export interface PlatformCollector<TEvent = WatcherEvent> {
  readonly name: string;
  readonly platform?: LivePlatform;
  readonly eventType: WatcherEventType;
  readonly supported?: boolean; // false for unsupported capabilities e.g. X stories
  fetch(username: string): Promise<TEvent[]>;
  fetchWithDiagnostics?(username: string): Promise<CollectorFetchResult<TEvent>>;
  setCookie?(cookie: string): void;
}

export interface TargetCollectorDiagnostic {
  platform: LivePlatform;
  username: string;
  eventType: WatcherEventType;
  status: CollectorStatus | 'WARMED_UP';
  reason?: string;
  httpStatus?: number;
  usedCookie: boolean;
  itemCount: number;
  checkedAt: string;
}

export interface MultiPlatformWatcherConfig {
  targetsByPlatform: Partial<Record<LivePlatform, string[]>>;
  cookies?: PlatformCookies;
  platformSettings?: Partial<MultiPlatformSettings>;
  enableWarmup?: boolean;
  autoDownloadMedia?: boolean;
  driveStorageRoot?: string;
  webhookUrl?: string;
  androidCallbackUrl?: string;
  staggerRangeMs?: [number, number];
  alertErrorThreshold?: number;
  alertCooldownSeconds?: number;
}

export interface SeenEventRecord {
  platform: string;
  username: string;
  eventType: WatcherEventType;
  itemId: string;
  createdAt: string;
  title?: string;
  url?: string;
}

export interface TrackedUserRecord {
  platform: string;
  username: string;
  eventType: WatcherEventType;
  initializedAt: string;
}

export interface CollectorHealthRecord {
  collectorName: string;
  consecutiveErrors: number;
  lastErrorMessage: string | null;
  lastAlertSentAt: string | null;
  lastSuccessAt: string | null;
  updatedAt: string;
}

export interface WatcherState {
  seenEvents: Record<string, SeenEventRecord>;
  trackedUsers: Record<string, TrackedUserRecord>;
  collectorHealth: Record<string, CollectorHealthRecord>;
  updatedAt: string;
}

export interface WatcherConfig {
  targetUsers: string[];
  webhookUrl?: string;
  liveIntervalSeconds?: number;
  postIntervalSeconds?: number;
  storyIntervalSeconds?: number;
  alertErrorThreshold?: number;
  alertCooldownSeconds?: number;
  tiktokApiKey?: string;
  tiktokSessionId?: string;
  proxyUrl?: string;
  enableWarmup?: boolean;
  androidCallbackUrl?: string;
  autoDownloadMedia?: boolean;
  driveStorageRoot?: string;
  staggerRangeMs?: [number, number];
}

export interface WebhookEventPayload {
  username: string;
  type: WatcherEventType;
  id: string;
  url: string;
  title: string;
  thumbnail_url: string | null;
  stream_url?: string | null;
  platform: string;
  detected_at: string;
}

export interface SystemAlertPayload {
  alert_type: 'COLLECTOR_FAILURE_THRESHOLD';
  collector_name: string;
  consecutive_errors: number;
  error_message: string;
  triggered_at: string;
}

export interface NotificationResult {
  status: 'delivered' | 'failed' | 'skipped';
  attempts: number;
  httpStatus?: number;
  error?: string | null;
}

export interface PendingDeviceNotification {
  id: string;
  type: 'POST_DOWNLOADED' | 'STORY_DOWNLOADED' | 'RECORD_TRIGGER' | 'MEDIA_DOWNLOADED';
  eventType: WatcherEventType;
  platform: string;
  username: string;
  title: string;
  itemId: string;
  sourceUrl?: string;
  mediaPath?: string;
  fileName?: string;
  fileSize?: number;
  createdAt: string;
}
