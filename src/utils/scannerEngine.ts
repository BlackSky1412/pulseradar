export type SocialPlatform = 'reddit' | 'hackernews' | 'bluesky' | 'github';
export type LivePlatform = 'TIKTOK' | 'INSTAGRAM' | 'FACEBOOK' | 'X';
export type MatchType = 'contains' | 'exact' | 'regex';
export type WebhookFormat = 'json' | 'discord' | 'slack' | 'telegram';
export type WebhookDeliveryStatus = 'delivered' | 'failed' | 'pending';
export type ActivityEventType = 'live' | 'post' | 'story';

export interface PlatformTrackingConfig {
  liveEnabled: boolean;
  postEnabled: boolean;
  storyEnabled: boolean;
  liveIntervalSeconds: number;
  postIntervalSeconds: number;
  storyIntervalSeconds: number;
}

export interface MultiPlatformSettings {
  tiktok: PlatformTrackingConfig;
  instagram: PlatformTrackingConfig;
  facebook: PlatformTrackingConfig;
  x: PlatformTrackingConfig;
}

export function createDefaultPlatformTrackingConfig(): PlatformTrackingConfig {
  return {
    liveEnabled: true,
    postEnabled: true,
    storyEnabled: true,
    liveIntervalSeconds: 60,
    postIntervalSeconds: 240,
    storyIntervalSeconds: 360,
  };
}

export function createDefaultMultiPlatformSettings(): MultiPlatformSettings {
  return {
    tiktok: createDefaultPlatformTrackingConfig(),
    instagram: createDefaultPlatformTrackingConfig(),
    facebook: createDefaultPlatformTrackingConfig(),
    x: createDefaultPlatformTrackingConfig(),
  };
}

export const DEFAULT_MULTI_PLATFORM_SETTINGS: MultiPlatformSettings = createDefaultMultiPlatformSettings();

export function normalizePlatformTrackingConfig(
  incoming?: Partial<PlatformTrackingConfig> | null,
  fallback?: PlatformTrackingConfig
): PlatformTrackingConfig {
  const base = fallback ?? createDefaultPlatformTrackingConfig();
  const liveSec = incoming?.liveIntervalSeconds;
  const postSec = incoming?.postIntervalSeconds;
  const storySec = incoming?.storyIntervalSeconds;
  return {
    liveEnabled: typeof incoming?.liveEnabled === 'boolean' ? incoming.liveEnabled : base.liveEnabled,
    postEnabled: typeof incoming?.postEnabled === 'boolean' ? incoming.postEnabled : base.postEnabled,
    storyEnabled: typeof incoming?.storyEnabled === 'boolean' ? incoming.storyEnabled : base.storyEnabled,
    liveIntervalSeconds:
      typeof liveSec === 'number' && Number.isFinite(liveSec) && liveSec >= 5
        ? liveSec
        : base.liveIntervalSeconds,
    postIntervalSeconds:
      typeof postSec === 'number' && Number.isFinite(postSec) && postSec >= 5
        ? postSec
        : base.postIntervalSeconds,
    storyIntervalSeconds:
      typeof storySec === 'number' && Number.isFinite(storySec) && storySec >= 5
        ? storySec
        : base.storyIntervalSeconds,
  };
}

export function normalizeMultiPlatformSettings(
  incoming?: Partial<MultiPlatformSettings> | null,
  fallback?: MultiPlatformSettings
): MultiPlatformSettings {
  const base = fallback ?? createDefaultMultiPlatformSettings();
  return {
    tiktok: normalizePlatformTrackingConfig(incoming?.tiktok, base.tiktok),
    instagram: normalizePlatformTrackingConfig(incoming?.instagram, base.instagram),
    facebook: normalizePlatformTrackingConfig(incoming?.facebook, base.facebook),
    x: normalizePlatformTrackingConfig(incoming?.x, base.x),
  };
}

export interface PlatformCookies {
  tiktok: string;
  instagram: string;
  facebook: string;
  x: string;
}

export interface ScannerSettingsState {
  cookies: Required<PlatformCookies>;
  pollIntervalSeconds: number;
  deduplicateLive: boolean;
  platforms?: MultiPlatformSettings;
}

export interface LiveScannerSettings {
  cookies: PlatformCookies;
  pollIntervalSeconds: number;
  deduplicateLive: boolean;
  platforms?: MultiPlatformSettings;
}

export interface LiveTargetScanStatus {
  ruleId: string;
  target: string;
  username: string;
  platform: LivePlatform;
  status: 'LIVE' | 'NOT_LIVE' | 'ERROR';
  title?: string;
  streamUrl?: string;
  sourceUrl: string;
  qualityInfo?: string;
  method?: string;
  error?: string;
  checkedAt: string;
  webhookDispatched?: boolean;
  deduplicated?: boolean;
}

export interface KeywordRuleItem {
  id: string;
  ownerId: string;
  /**
   * Comma-separated list of tracked @usernames, profile URLs, broadcast IDs, or keywords
   * e.g. "@mixigaming, https://www.tiktok.com/@vtv24, @fpt_official"
   */
  keyword: string;
  /**
   * Stores optional custom source domain/name + excluded terms e.g. "tiktok.com | quảng cáo,spam"
   * or plain comma-separated excluded keywords for backward compatibility.
   */
  excludedKeywords: string;
  /**
   * 'contains' = Theo dõi cả Phát Live thật & Đăng bài
   * 'exact'    = Chỉ khi Đăng bài mới (Post Event / Exact Match)
   * 'regex'    = Chỉ khi Bắt đầu Phát Live (Live Stream Event)
   */
  matchType: MatchType;
  platforms: string; // Firestore-compatible source identifier: 'reddit' | 'hackernews' | 'bluesky' | 'github'
  webhookServerId: string;
  enabled: boolean;
  matchCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookServerItem {
  id: string;
  ownerId: string;
  name: string;
  url: string;
  format: WebhookFormat;
  secretHeader: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AlertDetectionItem {
  id: string;
  ownerId: string;
  ruleId: string;
  keyword: string; // e.g. "[PHÁT LIVE] @mixigaming" or "[ĐĂNG BÀI] AI agent"
  platform: SocialPlatform;
  author: string;
  title: string;
  contentSnippet: string;
  sourceUrl: string;
  webhookServerName: string;
  webhookStatus: WebhookDeliveryStatus;
  httpStatusCode: number;
  latencyMs: number;
  payloadJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface SocialPostCandidate {
  externalId: string;
  platform: SocialPlatform;
  author: string;
  title: string;
  contentSnippet: string;
  sourceUrl: string;
  publishedAt: string;
  activityType?: ActivityEventType;
  streamUrl?: string;
  livePlatform?: LivePlatform;
  qualityInfo?: string;
  detectionMethod?: string;
}

export const PLATFORM_LABELS: Record<SocialPlatform, string> = {
  reddit: 'TikTok Live',
  hackernews: 'Instagram Live',
  bluesky: 'X (Twitter) Live',
  github: 'Facebook Live',
};

export type SocialPlatformKey = 'tiktok' | 'instagram' | 'facebook' | 'x';

export const SOCIAL_KEY_TO_PLATFORM: Record<SocialPlatformKey, SocialPlatform> = {
  tiktok: 'reddit',
  instagram: 'hackernews',
  facebook: 'github',
  x: 'bluesky',
};

export const PLATFORM_TO_SOCIAL_KEY: Record<SocialPlatform, SocialPlatformKey> = {
  reddit: 'tiktok',
  hackernews: 'instagram',
  github: 'facebook',
  bluesky: 'x',
};

export const PLATFORM_BRAND_NAMES: Record<SocialPlatformKey, string> = {
  tiktok: 'TikTok',
  instagram: 'Instagram',
  facebook: 'Facebook',
  x: 'X (Twitter)',
};

export interface StreamSubscription {
  live: boolean;
  post: boolean;
  story: boolean;
}

export interface TargetStreamStatus {
  live?: {
    status: 'LIVE' | 'NOT_LIVE' | 'ERROR';
    roomId?: string;
    streamUrl?: string;
    qualityInfo?: string;
    checkedAt: string;
  };
  post?: {
    status: 'WARMED_UP' | 'NEW_POST' | 'IDLE' | 'ERROR';
    latestVideoId?: string;
    videoCount?: number;
    checkedAt: string;
  };
  story?: {
    status: 'ACTIVE' | 'NONE' | 'COOKIE_REQUIRED' | 'ERROR';
    latestStoryId?: string;
    activeCount?: number;
    checkedAt: string;
  };
}

export const SOURCE_DEFAULT_DOMAINS: Record<SocialPlatform, string> = {
  reddit: 'tiktok.com',
  hackernews: 'instagram.com',
  bluesky: 'x.com',
  github: 'facebook.com',
};

export const SOCIAL_TO_LIVE_PLATFORM: Record<SocialPlatform, LivePlatform> = {
  reddit: 'TIKTOK',
  hackernews: 'INSTAGRAM',
  bluesky: 'X',
  github: 'FACEBOOK',
};

export const LIVE_PLATFORM_LABELS: Record<LivePlatform, string> = {
  TIKTOK: 'TikTok Live',
  INSTAGRAM: 'Instagram Live',
  X: 'X (Twitter) Live',
  FACEBOOK: 'Facebook Live',
};

export const MATCH_TYPE_LABELS: Record<MatchType, string> = {
  regex: 'Chỉ khi Bắt đầu Phát Live (Quét Live Thật)',
  contains: 'Phát Live Thật & Giả lập / Bài đăng',
  exact: 'Chỉ khi Đăng bài / Khớp từ khóa chính xác',
};

export const WEBHOOK_FORMAT_LABELS: Record<WebhookFormat, string> = {
  json: 'Standard JSON Request (Server API)',
  discord: 'Discord Webhook Embed',
  slack: 'Slack Block Kit',
  telegram: 'Telegram Bot Payload',
};

/**
 * Parses a source rule's `keyword` string into individual tracked targets (@usernames, URLs, and keywords).
 */
export function parseTrackedTargets(keywordField: string): string[] {
  return keywordField
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);
}

/**
 * Determines whether a target string represents a live user handle/URL/broadcast ID
 * (as opposed to a multi-word keyword or regex expression).
 */
export function isLiveUserTarget(target: string): boolean {
  const trimmed = target.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('@')) return true;
  if (/^https?:\/\//i.test(trimmed)) return true;
  if (/(tiktok\.com|instagram\.com|instagr\.am|facebook\.com|fb\.com|fb\.watch|x\.com|twitter\.com)/i.test(trimmed)) {
    return true;
  }
  if (trimmed.startsWith('broadcast_') || trimmed.startsWith('video_')) return true;
  // Single handle without spaces or regex metacharacters
  if (/^[a-zA-Z0-9_.-]{2,64}$/.test(trimmed)) return true;
  return false;
}

/**
 * Resolves the LivePlatform from target URL, source domain, or PulseRadar platform key.
 */
export function resolveLivePlatformForTarget(
  target: string,
  platform: SocialPlatform,
  sourceDomain = ''
): LivePlatform {
  const combined = `${target.toLowerCase()} ${sourceDomain.toLowerCase()}`;
  if (combined.includes('instagram.com') || combined.includes('instagr.am')) return 'INSTAGRAM';
  if (combined.includes('facebook.com') || combined.includes('fb.com') || combined.includes('fb.watch')) {
    return 'FACEBOOK';
  }
  if (
    combined.includes('x.com') ||
    combined.includes('twitter.com') ||
    combined.includes('t.co') ||
    target.trim().startsWith('broadcast_')
  ) {
    return 'X';
  }
  if (combined.includes('tiktok.com')) return 'TIKTOK';
  return SOCIAL_TO_LIVE_PLATFORM[platform] || 'TIKTOK';
}

/**
 * Parses `excludedKeywords` which may optionally include a custom source domain prefix `domain.com | neg1,neg2`
 */
export function parseSourceMeta(
  excludedKeywordsField: string,
  platform: SocialPlatform
): { sourceDomain: string; excludedTerms: string[] } {
  const raw = excludedKeywordsField || '';
  if (raw.includes('|')) {
    const [domainPart, negPart] = raw.split('|');
    const excludedTerms = (negPart || '')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);
    return {
      sourceDomain: domainPart.trim() || SOURCE_DEFAULT_DOMAINS[platform],
      excludedTerms,
    };
  }
  return {
    sourceDomain: SOURCE_DEFAULT_DOMAINS[platform] || 'tiktok.com',
    excludedTerms: raw
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean),
  };
}

/**
 * Validates KeywordRule input strictly against firebase-blueprint.json boundaries.
 */
export function validateKeywordRuleInput(input: {
  keyword: string;
  excludedKeywords: string;
  matchType: MatchType;
  platforms: SocialPlatform[];
  webhookServerId: string;
}): { valid: boolean; error?: string } {
  const kw = input.keyword.trim();
  if (kw.length < 1) {
    return { valid: false, error: 'Vui lòng nhập ít nhất 1 @username, URL kênh hoặc từ khóa cần theo dõi.' };
  }
  if (kw.length > 4000) {
    return { valid: false, error: 'Danh sách @username / từ khóa không được vượt quá 4000 ký tự.' };
  }
  if (input.excludedKeywords.length > 250) {
    return { valid: false, error: 'Thông tin tên miền nguồn / từ khóa loại trừ tối đa 250 ký tự.' };
  }
  if (!['contains', 'exact', 'regex'].includes(input.matchType)) {
    return { valid: false, error: 'Loại sự kiện theo dõi không hợp lệ.' };
  }
  if (input.matchType === 'regex' && !kw.includes(',') && !isLiveUserTarget(kw)) {
    try {
      new RegExp(kw, 'i');
    } catch {
      return { valid: false, error: 'Biểu thức Regex không hợp lệ. Vui lòng kiểm tra cú pháp.' };
    }
  }
  if (!input.platforms || input.platforms.length === 0) {
    return { valid: false, error: 'Vui lòng chọn nền tảng / trang web nguồn cần quét.' };
  }
  if (!input.webhookServerId || input.webhookServerId.trim().length === 0) {
    return { valid: false, error: 'Vui lòng chọn máy chủ nhận request xử lý.' };
  }
  return { valid: true };
}

/**
 * Validates WebhookServer input strictly against firebase-blueprint.json boundaries.
 */
export function validateWebhookServerInput(input: {
  name: string;
  url: string;
  format: WebhookFormat;
  secretHeader: string;
}): { valid: boolean; error?: string } {
  const name = input.name.trim();
  const url = input.url.trim();
  if (name.length < 1 || name.length > 80) {
    return { valid: false, error: 'Tên máy chủ phải từ 1 đến 80 ký tự.' };
  }
  if (url.length < 1 || url.length > 500) {
    return { valid: false, error: 'URL máy chủ phải từ 1 đến 500 ký tự.' };
  }
  const isLocalSandbox = url.startsWith('/api/webhook-sandbox');
  const isHttpUrl = /^https?:\/\/.+/i.test(url);
  if (!isLocalSandbox && !isHttpUrl) {
    return {
      valid: false,
      error: 'URL phải bắt đầu bằng https://, http:// hoặc dùng /api/webhook-sandbox.',
    };
  }
  if (!['json', 'discord', 'slack', 'telegram'].includes(input.format)) {
    return { valid: false, error: 'Định dạng request không hợp lệ.' };
  }
  if (input.secretHeader.length > 128) {
    return { valid: false, error: 'Secret Header không được vượt quá 128 ký tự.' };
  }
  return { valid: true };
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Evaluates whether a social post or live stream matches a source website's watchlist of @usernames / keywords.
 */
export function matchKeywordRule(
  post: { title: string; contentSnippet: string; platform: SocialPlatform; author?: string },
  rule: Pick<KeywordRuleItem, 'keyword' | 'excludedKeywords' | 'matchType' | 'platforms' | 'enabled'>
): { matched: boolean; matchedTerm?: string } {
  if (!rule.enabled) {
    return { matched: false };
  }

  const allowedPlatforms = rule.platforms
    .split(',')
    .map(p => p.trim().toLowerCase())
    .filter(Boolean);

  if (!allowedPlatforms.includes(post.platform)) {
    return { matched: false };
  }

  const authorText = post.author ? `@${post.author.replace(/^@/, '')} ${post.author}` : '';
  const fullText = `${post.title} ${post.contentSnippet} ${authorText}`;
  const lowerFullText = fullText.toLowerCase();

  // Check excluded keywords first
  const { excludedTerms } = parseSourceMeta(rule.excludedKeywords, post.platform);
  for (const neg of excludedTerms) {
    if (neg && lowerFullText.includes(neg)) {
      return { matched: false };
    }
  }

  const rawKw = rule.keyword.trim();
  if (!rawKw) return { matched: false };

  const targets =
    rule.matchType === 'regex' && !rawKw.includes(',')
      ? [rawKw]
      : parseTrackedTargets(rawKw);

  for (const target of targets) {
    const cleanTarget = target.replace(/^@/, '').trim();
    if (!cleanTarget) continue;

    if (rule.matchType === 'contains') {
      if (lowerFullText.includes(target.toLowerCase()) || lowerFullText.includes(cleanTarget.toLowerCase())) {
        return { matched: true, matchedTerm: target };
      }
    } else if (rule.matchType === 'exact') {
      const regex = new RegExp(`(^|[^a-zA-Z0-9_À-ỹ])(${escapeRegExp(cleanTarget)})($|[^a-zA-Z0-9_À-ỹ])`, 'i');
      const match = fullText.match(regex);
      if (match) {
        return { matched: true, matchedTerm: target };
      }
    } else if (rule.matchType === 'regex') {
      try {
        const regex = new RegExp(target, 'i');
        const match = fullText.match(regex);
        if (match) {
          return { matched: true, matchedTerm: match[0] || target };
        }
      } catch {
        if (lowerFullText.includes(cleanTarget.toLowerCase())) {
          return { matched: true, matchedTerm: target };
        }
      }
    }
  }

  return { matched: false };
}

/**
 * Builds the webhook JSON request body sent to the user's processing server when a LIVE or POST event is detected.
 */
export function buildWebhookPayload(
  format: WebhookFormat,
  data: {
    ruleId: string;
    keyword: string;
    matchType: MatchType;
    platform: SocialPlatform;
    sourceDomain?: string;
    activityType?: ActivityEventType;
    author: string;
    title: string;
    contentSnippet: string;
    sourceUrl: string;
    detectedAt: string;
    streamUrl?: string;
    livePlatform?: LivePlatform;
    qualityInfo?: string;
    detectionMethod?: string;
  }
): Record<string, unknown> {
  const sourceLabel = data.sourceDomain || SOURCE_DEFAULT_DOMAINS[data.platform] || PLATFORM_LABELS[data.platform];
  const activityType: ActivityEventType =
    data.activityType ||
    (data.title.toLowerCase().includes('live')
      ? 'live'
      : data.title.toLowerCase().includes('story')
      ? 'story'
      : 'post');
  const activityLabel =
    activityType === 'live'
      ? 'PHÁT TRỰC TIẾP (LIVE)'
      : activityType === 'story'
      ? 'TIN MỚI (STORY)'
      : 'ĐĂNG BÀI MỚI (POST)';
  const livePlatformLabel = data.livePlatform ? LIVE_PLATFORM_LABELS[data.livePlatform] : sourceLabel;

  if (format === 'discord') {
    const fields: Array<{ name: string; value: string; inline?: boolean }> = [
      { name: 'Mục tiêu khớp', value: `\`${data.keyword}\``, inline: true },
      { name: 'Sự kiện', value: activityLabel, inline: true },
      { name: 'Nền tảng', value: livePlatformLabel, inline: true },
    ];
    if (data.qualityInfo) {
      fields.push({ name: 'Chất lượng luồng', value: `\`${data.qualityInfo}\``, inline: true });
    }
    if (data.streamUrl) {
      fields.push({ name: 'Stream URL', value: data.streamUrl.slice(0, 900), inline: false });
    }
    const actionVerb =
      activityType === 'live'
        ? 'đang Live trên'
        : activityType === 'story'
        ? 'vừa đăng Story trên'
        : 'vừa đăng bài trên';
    return {
      username: 'PulseRadar Live Scanner',
      content: `🔴 **[${activityLabel}]** Phát hiện **${data.keyword}** ${actionVerb} **${livePlatformLabel}**`,
      embeds: [
        {
          title: data.title.slice(0, 250),
          description: data.contentSnippet.slice(0, 800),
          url: data.sourceUrl,
          color: activityType === 'live' ? 15548997 : activityType === 'story' ? 16744272 : 5793266,
          author: {
            name: `@${data.author.replace(/^@/, '')} · ${sourceLabel}`,
          },
          fields,
          timestamp: data.detectedAt,
        },
      ],
    };
  }

  if (format === 'slack') {
    const streamLine = data.streamUrl ? `\n• *Stream URL:* \`${data.streamUrl.slice(0, 400)}\`` : '';
    return {
      text: `[PulseRadar] ${activityLabel} từ "${data.keyword}" trên ${livePlatformLabel}: ${data.title}`,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: `[${activityLabel}] ${data.keyword} · ${livePlatformLabel}`,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*<${data.sourceUrl}|${data.title}>*\n${data.contentSnippet.slice(0, 500)}${streamLine}\n_User: @${data.author.replace(/^@/, '')} · Lúc: ${data.detectedAt}_`,
          },
        },
      ],
    };
  }

  if (format === 'telegram') {
    const streamHtml = data.streamUrl
      ? `\n<b>Stream URL (${data.qualityInfo || 'Live'}):</b> <code>${data.streamUrl.slice(0, 300)}</code>`
      : '';
    const openLinkText =
      activityType === 'live'
        ? 'Mở phòng Live / Liên kết gốc'
        : activityType === 'story'
        ? 'Mở Story / Liên kết gốc'
        : 'Mở bài đăng / Liên kết gốc';
    return {
      parse_mode: 'HTML',
      disable_web_page_preview: false,
      text:
        `<b>[${activityLabel}]</b> Mục tiêu: <code>${data.keyword}</code>\n` +
        `<b>Nền tảng:</b> ${livePlatformLabel} (@${data.author.replace(/^@/, '')})\n` +
        `<b>Tiêu đề:</b> ${data.title}${streamHtml}\n\n` +
        `${data.contentSnippet.slice(0, 400)}\n\n` +
        `<a href="${data.sourceUrl}">${openLinkText}</a>`,
    };
  }

  // Standard JSON Request for User Backend Server Processing
  return {
    event: 'social.keyword.detected',
    action:
      activityType === 'live'
        ? 'user.started_live'
        : activityType === 'story'
        ? 'user.published_story'
        : 'user.published_post',
    activityType,
    bot: 'PulseRadar/2026.2-LiveScanner',
    detectedAt: data.detectedAt,
    sourceWebsite: {
      id: data.ruleId,
      platform: data.platform,
      livePlatform: data.livePlatform || SOCIAL_TO_LIVE_PLATFORM[data.platform] || 'TIKTOK',
      domain: sourceLabel,
    },
    matchedTarget: {
      query: data.keyword,
      isUsername: data.keyword.startsWith('@') || isLiveUserTarget(data.keyword),
      triggerMode: data.matchType,
    },
    activity: {
      type: activityType,
      statusLabel: activityLabel,
      author: data.author,
      title: data.title,
      contentSnippet: data.contentSnippet,
      url: data.sourceUrl,
      ...(data.streamUrl ? { streamUrl: data.streamUrl } : {}),
      ...(data.qualityInfo ? { qualityInfo: data.qualityInfo } : {}),
      ...(data.detectionMethod ? { detectionMethod: data.detectionMethod } : {}),
    },
  };
}

export const INITIAL_WEBHOOK_SERVERS: WebhookServerItem[] = [
  {
    id: 'srv_sandbox_local',
    ownerId: 'demo_user',
    name: 'Máy chủ Sandbox cục bộ (/api/webhook-sandbox)',
    url: '/api/webhook-sandbox',
    format: 'json',
    secretHeader: '',
    enabled: true,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  },
];

export const INITIAL_KEYWORD_RULES: KeywordRuleItem[] = [
  {
    id: 'rule_tiktok_source',
    ownerId: 'demo_user',
    keyword: '',
    excludedKeywords: 'tiktok.com |',
    matchType: 'regex',
    platforms: 'reddit',
    webhookServerId: 'srv_sandbox_local',
    enabled: true,
    matchCount: 0,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  },
  {
    id: 'rule_instagram_source',
    ownerId: 'demo_user',
    keyword: '',
    excludedKeywords: 'instagram.com |',
    matchType: 'regex',
    platforms: 'hackernews',
    webhookServerId: 'srv_sandbox_local',
    enabled: true,
    matchCount: 0,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  },
  {
    id: 'rule_x_source',
    ownerId: 'demo_user',
    keyword: '',
    excludedKeywords: 'x.com |',
    matchType: 'regex',
    platforms: 'bluesky',
    webhookServerId: 'srv_sandbox_local',
    enabled: true,
    matchCount: 0,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  },
  {
    id: 'rule_facebook_source',
    ownerId: 'demo_user',
    keyword: '',
    excludedKeywords: 'facebook.com |',
    matchType: 'regex',
    platforms: 'github',
    webhookServerId: 'srv_sandbox_local',
    enabled: true,
    matchCount: 0,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  },
];

export const INITIAL_ALERT_DETECTIONS: AlertDetectionItem[] = [];
