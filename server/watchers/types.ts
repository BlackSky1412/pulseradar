export type WatcherEventType = 'live' | 'post' | 'story';

export interface TikTokEvent {
  username: string;
  eventType: WatcherEventType;
  itemId: string; // room_id for live, video_id for post, story_id for story
  url: string;
  title: string;
  thumbnailUrl?: string | null;
  streamUrl?: string | null;
  detectedAt: string;
  isPinned?: boolean;
  metadata?: Record<string, unknown>;
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

