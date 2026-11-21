import type { LivePlatform } from '../../liveCheckers/types';
import type {
  CollectorFetchResult,
  WatcherEvent,
  WatcherEventType,
} from '../types';
import { normalizeCookieValue, type PlatformCollector } from './base';

export interface XStoryCollectorOptions {
  cookie?: string;
}

export class XStoryCollector implements PlatformCollector<WatcherEvent> {
  readonly name = 'x_story';
  readonly platform: LivePlatform = 'X';
  readonly eventType: WatcherEventType = 'story';
  readonly supported = false;

  private cookie: string;

  constructor(options?: XStoryCollectorOptions) {
    this.cookie = normalizeCookieValue(options?.cookie);
  }

  setCookie(cookie: string): void {
    this.cookie = normalizeCookieValue(cookie);
  }

  async fetch(_rawUsername: string): Promise<WatcherEvent[]> {
    return [];
  }

  async fetchWithDiagnostics(_rawUsername: string): Promise<CollectorFetchResult<WatcherEvent>> {
    return {
      status: 'UNSUPPORTED',
      events: [],
      reason: 'X (Twitter) không hỗ trợ Story',
      usedCookie: Boolean(this.cookie),
    };
  }
}
