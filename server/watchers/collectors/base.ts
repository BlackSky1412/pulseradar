import type { TikTokEvent, WatcherEventType } from '../types';

export interface BaseCollector<TEvent = TikTokEvent> {
  readonly name: string;
  readonly eventType: WatcherEventType;
  fetch(username: string): Promise<TEvent[]>;
}

export function normalizeUsername(input: string): string {
  const trimmed = input.trim();
  if (trimmed.includes('tiktok.com')) {
    const atMatch = trimmed.match(/tiktok\.com\/@([a-zA-Z0-9_.]+)/);
    if (atMatch?.[1]) {
      return atMatch[1];
    }
    const match = trimmed.match(/tiktok\.com\/([a-zA-Z0-9_.]+)/);
    return match?.[1] || trimmed.replace(/^@/, '');
  }
  return trimmed.replace(/^@/, '').split(/[/?#]/)[0]?.trim() || '';
}
