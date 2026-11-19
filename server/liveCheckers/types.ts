export type LivePlatform = 'TIKTOK' | 'INSTAGRAM' | 'FACEBOOK' | 'X';

export interface PlatformCookies {
  tiktok?: string;
  instagram?: string;
  facebook?: string;
  x?: string;
}

export interface LiveCheckSuccess {
  status: 'LIVE';
  platform: LivePlatform;
  username: string;
  title: string;
  streamUrl: string;
  sourceUrl: string;
  qualityInfo?: string;
  method?: string;
  checkedAt: string;
}

export interface LiveCheckNotLive {
  status: 'NOT_LIVE';
  platform: LivePlatform;
  username: string;
  sourceUrl: string;
  checkedAt: string;
}

export interface LiveCheckError {
  status: 'ERROR';
  platform: LivePlatform;
  username: string;
  sourceUrl: string;
  message: string;
  checkedAt: string;
}

export type LiveCheckResult = LiveCheckSuccess | LiveCheckNotLive | LiveCheckError;
