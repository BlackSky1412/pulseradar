import {
  isLiveUserTarget,
  parseSourceMeta,
  parseTrackedTargets,
  type KeywordRuleItem,
  type LivePlatform,
  type SocialPlatform,
} from '../src/utils/scannerEngine';
import { detectLivePlatform, extractLiveUsername } from './liveCheckers/index';

export type ServerUserStatus = 'IDLE' | 'LIVE' | 'ERROR';
export type AndroidUserStatus = 'IDLE' | 'LIVE' | 'RECORDING' | 'UPLOADING' | 'ERROR';

export interface ServerLiveStatusEntry {
  canonicalKey?: string;
  ruleId?: string;
  target?: string;
  platform: LivePlatform;
  username: string;
  status: 'LIVE' | 'NOT_LIVE' | 'ERROR';
  title?: string;
  streamUrl?: string;
  sourceUrl?: string;
  qualityInfo?: string;
  method?: string;
  checkedAt?: string;
  error?: string;
}

export interface AuthoritativeUser {
  username: string;
  usernameOrUrl: string;
  platform: LivePlatform;
  nickname: string;
  isEnabled: boolean;
  serverStatus: ServerUserStatus;
  effectiveStatus: AndroidUserStatus;
  streamUrl: string | null;
  streamTitle: string | null;
  sourceUrl: string | null;
  qualityInfo: string | null;
}

export interface AndroidSyncUserInput {
  username?: string;
  usernameOrUrl?: string;
  platform: string;
  nickname?: string;
  status?: string;
  isEnabled?: boolean;
  allowCellular?: boolean;
  lastStreamUrl?: string | null;
  lastCheckedTimestamp?: number | null;
}

export interface NormalizedAndroidSyncUser {
  canonicalKey: string;
  username: string;
  usernameOrUrl: string;
  platform: LivePlatform;
  status: AndroidUserStatus;
  isEnabled: boolean;
  allowCellular: boolean;
  lastStreamUrl: string | null;
  lastCheckedTimestamp: number | null;
}

export interface RecordTriggerItem {
  eventId: string;
  platform: LivePlatform;
  username: string;
  usernameOrUrl: string;
  streamUrl: string;
  title: string;
  sourceUrl: string;
  qualityInfo?: string;
  detectedAt: string;
}

export interface ReconcileToRemoveItem {
  username: string;
  usernameOrUrl: string;
  platform: LivePlatform;
}

export interface ReconcileResult {
  authoritativeUsers: AuthoritativeUser[];
  toAdd: AuthoritativeUser[];
  toUpdate: AuthoritativeUser[];
  toRemove: ReconcileToRemoveItem[];
  recordTriggers: RecordTriggerItem[];
}

const VALID_ANDROID_STATUSES = new Set<AndroidUserStatus>([
  'IDLE',
  'LIVE',
  'RECORDING',
  'UPLOADING',
  'ERROR',
]);

export const STATUS_PRIORITY: Record<AndroidUserStatus, number> = {
  RECORDING: 5,
  UPLOADING: 4,
  LIVE: 3,
  ERROR: 2,
  IDLE: 1,
};

export function parseStrictPlatform(raw: unknown): LivePlatform | null {
  if (typeof raw !== 'string') return null;
  const upper = raw.trim().toUpperCase();
  if (!upper) return null;
  if (upper === 'TIKTOK' || upper === 'REDDIT') return 'TIKTOK';
  if (upper === 'INSTAGRAM' || upper === 'HACKERNEWS') return 'INSTAGRAM';
  if (upper === 'FACEBOOK' || upper === 'GITHUB') return 'FACEBOOK';
  if (upper === 'X' || upper === 'TWITTER' || upper === 'BLUESKY') return 'X';
  return null;
}

export function normalizePlatformForRuleTarget(
  target: string,
  rulePlatforms: string,
  sourceDomain = ''
): LivePlatform {
  const tokens = String(rulePlatforms || '')
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);

  let mappedRulePlatform: LivePlatform = 'TIKTOK';
  for (const token of tokens) {
    const parsed = parseStrictPlatform(token);
    if (parsed) {
      mappedRulePlatform = parsed;
      break;
    }
  }

  return detectLivePlatform(target, mappedRulePlatform, sourceDomain);
}

export function canonicalizeUsername(input: string, platform: LivePlatform): string {
  if (typeof input !== 'string') return '';
  const trimmed = input.trim();
  if (!trimmed) return '';

  // Pre-sanitize domain.com/@handle URLs for IG/FB/X so underlying extractors don't return "https:" or "@handle"
  const sanitized = trimmed.replace(
    /((?:instagram\.com|instagr\.am|facebook\.com|fb\.com|x\.com|twitter\.com)\/)@+/i,
    '$1'
  );

  const extracted = extractLiveUsername(sanitized, platform);
  const cleaned = String(extracted || '')
    .trim()
    .replace(/^@+/, '')
    .trim()
    .toLowerCase();

  if (
    !cleaned ||
    cleaned === 'http:' ||
    cleaned === 'https:' ||
    cleaned.includes('://') ||
    cleaned.includes('/') ||
    cleaned.includes('?') ||
    cleaned.includes('#') ||
    /^[a-z][a-z0-9+.-]*:$/.test(cleaned)
  ) {
    return '';
  }

  return cleaned;
}

export function makeCanonicalKey(platform: LivePlatform, canonicalUsername: string): string {
  return `${platform}::${canonicalUsername}`;
}

export function buildDefaultSourceUrl(platform: LivePlatform, username: string): string {
  switch (platform) {
    case 'INSTAGRAM':
      return `https://www.instagram.com/${username}/live/`;
    case 'FACEBOOK':
      return /^\d+$/.test(username)
        ? `https://www.facebook.com/profile.php?id=${username}&sk=live_videos`
        : `https://www.facebook.com/${username}/live/`;
    case 'X':
      return username.startsWith('broadcast_')
        ? `https://x.com/i/broadcasts/${username.slice('broadcast_'.length)}`
        : `https://x.com/${username}`;
    case 'TIKTOK':
    default:
      return `https://www.tiktok.com/@${username}/live`;
  }
}

export function normalizeAndroidStatus(raw: unknown): AndroidUserStatus | null {
  if (raw === undefined || raw === null || raw === '') return 'IDLE';
  if (typeof raw !== 'string') return null;
  const upper = raw.trim().toUpperCase();
  if (upper === 'NOT_LIVE') return 'IDLE';
  if (VALID_ANDROID_STATUSES.has(upper as AndroidUserStatus)) {
    return upper as AndroidUserStatus;
  }
  return null;
}

function isPreferredTargetFormat(candidate: string, current: string): boolean {
  const c = candidate.trim();
  const cur = current.trim();
  const cScore = c.startsWith('@') || /^https?:\/\//i.test(c) ? 1 : 0;
  const curScore = cur.startsWith('@') || /^https?:\/\//i.test(cur) ? 1 : 0;
  return cScore > curScore;
}

export function extractAuthoritativeUsers(
  rules: KeywordRuleItem[],
  liveStatusMap: Record<string, ServerLiveStatusEntry> = {}
): AuthoritativeUser[] {
  const merged = new Map<
    string,
    {
      username: string;
      usernameOrUrl: string;
      platform: LivePlatform;
      isEnabled: boolean;
    }
  >();

  for (const rule of Array.isArray(rules) ? rules : []) {
    if (!rule) continue;
    const platformsList = String(rule.platforms || 'reddit')
      .split(',')
      .map(p => p.trim().toLowerCase())
      .filter(Boolean);
    const primarySocial = (platformsList[0] || 'reddit') as SocialPlatform;
    const { sourceDomain } = parseSourceMeta(String(rule.excludedKeywords || ''), primarySocial);
    const targets = parseTrackedTargets(String(rule.keyword || ''));
    const ruleEnabled = Boolean(rule.enabled);

    for (const rawTarget of targets) {
      if (!isLiveUserTarget(rawTarget)) continue;
      const platform = normalizePlatformForRuleTarget(rawTarget, String(rule.platforms || 'reddit'), sourceDomain);
      const canonicalUsername = canonicalizeUsername(rawTarget, platform);
      if (!canonicalUsername) continue;

      const key = makeCanonicalKey(platform, canonicalUsername);
      const trimmedTarget = rawTarget.trim();
      const existing = merged.get(key);

      if (!existing) {
        merged.set(key, {
          username: canonicalUsername,
          usernameOrUrl: trimmedTarget,
          platform,
          isEnabled: ruleEnabled,
        });
      } else {
        const wasDisabled = !existing.isEnabled;
        existing.isEnabled = existing.isEnabled || ruleEnabled;
        if (wasDisabled && ruleEnabled) {
          existing.usernameOrUrl = trimmedTarget;
        } else if (wasDisabled === !ruleEnabled && isPreferredTargetFormat(trimmedTarget, existing.usernameOrUrl)) {
          existing.usernameOrUrl = trimmedTarget;
        }
      }
    }
  }

  const authoritativeUsers: AuthoritativeUser[] = [];

  for (const [key, entry] of merged.entries()) {
    const liveEntry = liveStatusMap[key];
    const defaultSourceUrl = buildDefaultSourceUrl(entry.platform, entry.username);

    let serverStatus: ServerUserStatus = 'IDLE';
    let streamUrl: string | null = null;
    let streamTitle: string | null = null;
    let sourceUrl: string | null = liveEntry?.sourceUrl || defaultSourceUrl;
    let qualityInfo: string | null = null;

    if (liveEntry?.status === 'LIVE' && typeof liveEntry.streamUrl === 'string' && liveEntry.streamUrl.trim()) {
      serverStatus = 'LIVE';
      streamUrl = liveEntry.streamUrl.trim();
      streamTitle = liveEntry.title?.trim() || `${entry.platform} Live (@${entry.username})`;
      sourceUrl = liveEntry.sourceUrl?.trim() || defaultSourceUrl;
      qualityInfo = liveEntry.qualityInfo?.trim() || null;
    } else if (liveEntry?.status === 'ERROR') {
      serverStatus = 'ERROR';
      sourceUrl = liveEntry.sourceUrl?.trim() || defaultSourceUrl;
    }

    authoritativeUsers.push({
      username: entry.username,
      usernameOrUrl: entry.usernameOrUrl,
      platform: entry.platform,
      nickname: entry.username,
      isEnabled: entry.isEnabled,
      serverStatus,
      effectiveStatus: serverStatus,
      streamUrl,
      streamTitle,
      sourceUrl,
      qualityInfo,
    });
  }

  return authoritativeUsers;
}

export function normalizeAndroidSyncUsers(rawUsers: AndroidSyncUserInput[]): NormalizedAndroidSyncUser[] {
  const result: NormalizedAndroidSyncUser[] = [];
  for (const u of Array.isArray(rawUsers) ? rawUsers : []) {
    if (!u || typeof u !== 'object') continue;
    const platform = parseStrictPlatform(u.platform);
    if (!platform) continue;
    if (
      u.username !== undefined &&
      u.username !== null &&
      typeof u.username !== 'string'
    ) {
      continue;
    }
    if (
      u.usernameOrUrl !== undefined &&
      u.usernameOrUrl !== null &&
      typeof u.usernameOrUrl !== 'string'
    ) {
      continue;
    }
    const rawUsernameOrUrl = typeof u.usernameOrUrl === 'string' ? u.usernameOrUrl.trim() : '';
    const rawUsername = typeof u.username === 'string' ? u.username.trim() : '';
    const rawTarget = rawUsernameOrUrl || rawUsername;
    const canonicalUsername =
      canonicalizeUsername(rawTarget, platform) ||
      (rawUsername ? canonicalizeUsername(rawUsername, platform) : '');
    if (!canonicalUsername) continue;

    const status = normalizeAndroidStatus(u.status) ?? 'IDLE';
    result.push({
      canonicalKey: makeCanonicalKey(platform, canonicalUsername),
      username: canonicalUsername,
      usernameOrUrl: rawTarget || canonicalUsername,
      platform,
      status,
      isEnabled: u.isEnabled === undefined ? true : Boolean(u.isEnabled),
      allowCellular: Boolean(u.allowCellular),
      lastStreamUrl: typeof u.lastStreamUrl === 'string' ? u.lastStreamUrl : null,
      lastCheckedTimestamp:
        typeof u.lastCheckedTimestamp === 'number' && Number.isFinite(u.lastCheckedTimestamp)
          ? u.lastCheckedTimestamp
          : null,
    });
  }
  return result;
}

export function mergeAndroidSyncUsers(
  normalizedInputs: NormalizedAndroidSyncUser[]
): Map<string, NormalizedAndroidSyncUser> {
  const androidMap = new Map<string, NormalizedAndroidSyncUser>();
  for (const u of normalizedInputs) {
    const existing = androidMap.get(u.canonicalKey);
    if (!existing) {
      androidMap.set(u.canonicalKey, { ...u });
    } else {
      const existingPriority = STATUS_PRIORITY[existing.status];
      const nextPriority = STATUS_PRIORITY[u.status];
      if (nextPriority > existingPriority) {
        androidMap.set(u.canonicalKey, { ...u });
      } else if (nextPriority === existingPriority) {
        existing.isEnabled = existing.isEnabled && u.isEnabled;
      }
    }
  }
  return androidMap;
}

export function reconcileAndroidSync(
  authoritativeUsers: AuthoritativeUser[],
  androidUsers: Array<AndroidSyncUserInput | NormalizedAndroidSyncUser>,
  options: { syncedAt?: string; nowMs?: number } = {}
): ReconcileResult {
  const nowMs = options.nowMs ?? Date.now();
  const syncedAtIso = options.syncedAt ?? new Date(nowMs).toISOString();

  const normalizedInputs: NormalizedAndroidSyncUser[] = androidUsers.every(
    u => 'canonicalKey' in u && typeof u.canonicalKey === 'string'
  )
    ? (androidUsers as NormalizedAndroidSyncUser[])
    : normalizeAndroidSyncUsers(androidUsers as AndroidSyncUserInput[]);

  const androidMap = mergeAndroidSyncUsers(normalizedInputs);

  const authMap = new Map<string, AuthoritativeUser>();
  const resolvedAuthUsers: AuthoritativeUser[] = [];
  const toAdd: AuthoritativeUser[] = [];
  const toUpdate: AuthoritativeUser[] = [];
  const recordTriggers: RecordTriggerItem[] = [];

  for (const authUser of authoritativeUsers) {
    const key = makeCanonicalKey(authUser.platform, authUser.username);
    const androidEntry = androidMap.get(key);

    const effectiveStatus: AndroidUserStatus =
      androidEntry && (androidEntry.status === 'RECORDING' || androidEntry.status === 'UPLOADING')
        ? androidEntry.status
        : authUser.serverStatus;

    const resolvedUser: AuthoritativeUser = {
      ...authUser,
      effectiveStatus,
    };

    authMap.set(key, resolvedUser);
    resolvedAuthUsers.push(resolvedUser);

    if (!androidEntry) {
      toAdd.push(resolvedUser);
    } else if (
      androidEntry.isEnabled !== resolvedUser.isEnabled ||
      androidEntry.status !== resolvedUser.effectiveStatus
    ) {
      toUpdate.push(resolvedUser);
    }

    const isAndroidBusy =
      androidEntry !== undefined &&
      (androidEntry.status === 'RECORDING' || androidEntry.status === 'UPLOADING');

    if (
      resolvedUser.isEnabled &&
      resolvedUser.serverStatus === 'LIVE' &&
      typeof resolvedUser.streamUrl === 'string' &&
      resolvedUser.streamUrl.trim().length > 0 &&
      !isAndroidBusy
    ) {
      recordTriggers.push({
        eventId: `sync_${Math.floor(nowMs / 1000)}_${resolvedUser.username}`,
        platform: resolvedUser.platform,
        username: resolvedUser.username,
        usernameOrUrl: resolvedUser.usernameOrUrl,
        streamUrl: resolvedUser.streamUrl,
        title: resolvedUser.streamTitle || `${resolvedUser.platform} Live (@${resolvedUser.username})`,
        sourceUrl: resolvedUser.sourceUrl || buildDefaultSourceUrl(resolvedUser.platform, resolvedUser.username),
        ...(resolvedUser.qualityInfo ? { qualityInfo: resolvedUser.qualityInfo } : {}),
        detectedAt: syncedAtIso,
      });
    }
  }

  const toRemove: ReconcileToRemoveItem[] = [];
  for (const [key, androidEntry] of androidMap.entries()) {
    if (!authMap.has(key)) {
      toRemove.push({
        username: androidEntry.username,
        usernameOrUrl: androidEntry.usernameOrUrl,
        platform: androidEntry.platform,
      });
    }
  }

  return {
    authoritativeUsers: resolvedAuthUsers,
    toAdd,
    toUpdate,
    toRemove,
    recordTriggers,
  };
}
