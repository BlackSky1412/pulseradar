import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  matchKeywordRule,
  buildWebhookPayload,
  validateKeywordRuleInput,
  validateWebhookServerInput,
  parseTrackedTargets,
  parseSourceMeta,
  createDefaultPlatformTrackingConfig,
  createDefaultMultiPlatformSettings,
  normalizePlatformTrackingConfig,
  normalizeMultiPlatformSettings,
  DEFAULT_MULTI_PLATFORM_SETTINGS,
  type ActivityEventType,
  type SocialPlatformKey,
  SOCIAL_KEY_TO_PLATFORM,
  PLATFORM_TO_SOCIAL_KEY,
  PLATFORM_BRAND_NAMES,
} from './scannerEngine';
import { startServer } from '../../server';

test('matchKeywordRule matches substring or multi-target @username list and respects excludedKeywords', () => {
  const rule = {
    keyword: '@mixigaming, AI agent, @vtv24',
    excludedKeywords: 'tiktok.com | spam,hiring',
    matchType: 'contains' as const,
    platforms: 'hackernews,reddit',
    enabled: true,
  };

  const matchingPost = {
    title: 'Building a reliable AI Agent with webhook triggers',
    contentSnippet: 'Real-time monitoring for social streams.',
    platform: 'hackernews' as const,
  };
  assert.equal(matchKeywordRule(matchingPost, rule).matched, true);

  const matchingUserLive = {
    title: 'ĐANG LIVE: Giao lưu trực tiếp cuối tuần',
    contentSnippet: 'Kênh @mixigaming vừa bắt đầu phát trực tiếp.',
    author: 'mixigaming',
    platform: 'reddit' as const,
  };
  const userMatch = matchKeywordRule(matchingUserLive, rule);
  assert.equal(userMatch.matched, true);
  assert.equal(userMatch.matchedTerm, '@mixigaming');

  const excludedPost = {
    title: 'We are hiring an AI Agent engineer',
    contentSnippet: 'Apply today.',
    platform: 'hackernews' as const,
  };
  assert.equal(matchKeywordRule(excludedPost, rule).matched, false);

  const wrongPlatformPost = {
    title: 'Building a reliable AI Agent',
    contentSnippet: 'Great tool.',
    platform: 'bluesky' as const,
  };
  assert.equal(matchKeywordRule(wrongPlatformPost, rule).matched, false);
});

test('parseTrackedTargets and parseSourceMeta extract source domain and targets cleanly', () => {
  const targets = parseTrackedTargets('@mixigaming, @fireship_dev, Next.js');
  assert.deepEqual(targets, ['@mixigaming', '@fireship_dev', 'Next.js']);

  const meta = parseSourceMeta('tiktok.com | reup, spam', 'reddit');
  assert.equal(meta.sourceDomain, 'tiktok.com');
  assert.deepEqual(meta.excludedTerms, ['reup', 'spam']);
});

test('matchKeywordRule enforces word boundaries in exact mode and regex in regex mode', () => {
  const exactRule = {
    keyword: 'react',
    excludedKeywords: '',
    matchType: 'exact' as const,
    platforms: 'reddit',
    enabled: true,
  };

  assert.equal(
    matchKeywordRule(
      { title: 'Why reactive programming is hard', contentSnippet: 'No match', platform: 'reddit' },
      exactRule
    ).matched,
    false
  );

  assert.equal(
    matchKeywordRule(
      { title: 'Migrating to React 19 in production', contentSnippet: 'Fast hydration', platform: 'reddit' },
      exactRule
    ).matched,
    true
  );

  const regexRule = {
    keyword: '(postgres|supabase)\\s+\\d+',
    excludedKeywords: '',
    matchType: 'regex' as const,
    platforms: 'github',
    enabled: true,
  };

  assert.equal(
    matchKeywordRule(
      { title: 'Upgrading to Postgres 17 cluster', contentSnippet: 'Zero downtime', platform: 'github' },
      regexRule
    ).matched,
    true
  );
});

test('buildWebhookPayload formats payloads for json, discord, slack, and telegram with post/live activityType', () => {
  const sample = {
    ruleId: 'rule_1',
    keyword: '@mixigaming',
    matchType: 'contains' as const,
    platform: 'reddit' as const,
    sourceDomain: 'tiktok.com',
    activityType: 'live' as const,
    author: 'mixigaming',
    title: 'ĐANG LIVE: Giao lưu cùng anh em',
    contentSnippet: 'Livestream trực tiếp trên TikTok.',
    sourceUrl: 'https://tiktok.com/@mixigaming/live',
    detectedAt: '2026-11-17T01:00:00.000Z',
  };

  const jsonPayload = buildWebhookPayload('json', sample);
  assert.equal(jsonPayload.event, 'social.keyword.detected');
  assert.equal(jsonPayload.action, 'user.started_live');

  const discordPayload = buildWebhookPayload('discord', sample);
  assert.ok(Array.isArray(discordPayload.embeds));

  const slackPayload = buildWebhookPayload('slack', sample);
  assert.ok(Array.isArray(slackPayload.blocks));

  const telegramPayload = buildWebhookPayload('telegram', sample);
  assert.equal(telegramPayload.parse_mode, 'HTML');
});

test('validateKeywordRuleInput and validateWebhookServerInput reject invalid inputs', () => {
  assert.equal(
    validateKeywordRuleInput({
      keyword: '',
      excludedKeywords: '',
      matchType: 'contains',
      platforms: ['reddit'],
      webhookServerId: 'srv_1',
    }).valid,
    false
  );

  assert.equal(
    validateKeywordRuleInput({
      keyword: '[unclosed regex',
      excludedKeywords: '',
      matchType: 'regex',
      platforms: ['reddit'],
      webhookServerId: 'srv_1',
    }).valid,
    false
  );

  assert.equal(
    validateWebhookServerInput({
      name: 'My Server',
      url: 'ftp://invalid-url',
      format: 'json',
      secretHeader: '',
    }).valid,
    false
  );

  assert.equal(
    validateWebhookServerInput({
      name: 'Local Sandbox',
      url: '/api/webhook-sandbox',
      format: 'json',
      secretHeader: 'sec_123',
    }).valid,
    true
  );
});

test('buildWebhookPayload formats story activityType correctly across json, discord, slack, and telegram', () => {
  const storySample = {
    ruleId: 'rule_story_1',
    keyword: '@mixigaming',
    matchType: 'regex' as const,
    platform: 'reddit' as const,
    sourceDomain: 'tiktok.com',
    activityType: 'story' as const,
    author: 'mixigaming',
    title: 'Khoảnh khắc hậu trường mới nhất',
    contentSnippet: 'TikTok Story biến mất sau 24h.',
    sourceUrl: 'https://www.tiktok.com/@mixigaming/story/123456789',
    detectedAt: '2026-11-19T08:00:00.000Z',
  };

  // 1. JSON format
  const jsonPayload = buildWebhookPayload('json', storySample);
  assert.equal(jsonPayload.event, 'social.keyword.detected');
  assert.equal(jsonPayload.action, 'user.published_story');
  assert.equal(jsonPayload.activityType, 'story');
  assert.equal((jsonPayload.activity as Record<string, unknown>).type, 'story');
  assert.equal((jsonPayload.activity as Record<string, unknown>).statusLabel, 'TIN MỚI (STORY)');

  // 2. Discord format
  const discordPayload = buildWebhookPayload('discord', storySample);
  assert.ok(Array.isArray(discordPayload.embeds));
  assert.ok(String(discordPayload.content).includes('TIN MỚI (STORY)'));
  assert.ok(String(discordPayload.content).includes('vừa đăng Story trên'));
  const firstEmbed = (discordPayload.embeds as Array<Record<string, unknown>>)[0];
  assert.equal(firstEmbed.color, 16744272);

  // 3. Slack format
  const slackPayload = buildWebhookPayload('slack', storySample);
  assert.ok(Array.isArray(slackPayload.blocks));
  assert.ok(String(slackPayload.text).includes('TIN MỚI (STORY)'));

  // 4. Telegram format
  const telegramPayload = buildWebhookPayload('telegram', storySample);
  assert.equal(telegramPayload.parse_mode, 'HTML');
  assert.ok(String(telegramPayload.text).includes('<b>[TIN MỚI (STORY)]</b>'));
  assert.ok(String(telegramPayload.text).includes('Mở Story / Liên kết gốc'));

  // 5. Automatic title-based story detection when activityType is omitted
  const autoStoryPayload = buildWebhookPayload('json', {
    ...storySample,
    activityType: undefined,
    title: 'Daily story update from creator',
  });
  assert.equal(autoStoryPayload.action, 'user.published_story');
  assert.equal(autoStoryPayload.activityType, 'story');
});

test('createDefaultMultiPlatformSettings and normalizeMultiPlatformSettings handle defaults and partial configurations', () => {
  const defaults = createDefaultMultiPlatformSettings();
  const platforms: Array<'tiktok' | 'instagram' | 'facebook' | 'x'> = ['tiktok', 'instagram', 'facebook', 'x'];

  for (const p of platforms) {
    const config = defaults[p];
    assert.equal(config.liveEnabled, true);
    assert.equal(config.postEnabled, true);
    assert.equal(config.storyEnabled, true);
    assert.equal(config.liveIntervalSeconds, 60);
    assert.equal(config.postIntervalSeconds, 240);
    assert.equal(config.storyIntervalSeconds, 360);
  }

  assert.deepEqual(DEFAULT_MULTI_PLATFORM_SETTINGS, defaults);

  // Normalization with undefined falls back to full defaults
  const normalizedEmpty = normalizeMultiPlatformSettings(undefined);
  assert.deepEqual(normalizedEmpty, defaults);

  // Normalization with partial platform override
  const partial = normalizeMultiPlatformSettings({
    tiktok: {
      liveEnabled: false,
      postEnabled: true,
      storyEnabled: true,
      liveIntervalSeconds: 30,
      postIntervalSeconds: 240,
      storyIntervalSeconds: 360,
    },
  });
  assert.equal(partial.tiktok.liveEnabled, false);
  assert.equal(partial.tiktok.liveIntervalSeconds, 30);
  assert.equal(partial.tiktok.postIntervalSeconds, 240);
  assert.equal(partial.instagram.liveEnabled, true);
  assert.equal(partial.instagram.liveIntervalSeconds, 60);

  // Normalization rejects invalid sub-5s interval and falls back to default
  const configWithInvalid = normalizePlatformTrackingConfig({
    liveIntervalSeconds: 2,
    postIntervalSeconds: NaN,
  });
  assert.equal(configWithInvalid.liveIntervalSeconds, 60);
  assert.equal(configWithInvalid.postIntervalSeconds, 240);
});

test('server integration: GET /api/watcher/status and PUT /api/workspace-state with multi-platform settings', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulseradar-m2-'));
  const server = await startServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: tempDir,
    mountFrontend: false,
    autoScanEnabled: false,
    startAutoScanner: false,
  });

  try {
    // 1. GET /api/watcher/status returns expected contract structure
    const statusRes = await fetch(`${server.url}/api/watcher/status`);
    assert.equal(statusRes.status, 200);
    const statusBody = (await statusRes.json()) as {
      success: boolean;
      running: boolean;
      health: Record<string, unknown>;
      metrics: { seenEventsCount: number; trackedUsersCount: number };
    };

    assert.equal(statusBody.success, true);
    assert.equal(typeof statusBody.running, 'boolean');
    assert.equal(typeof statusBody.health, 'object');
    assert.equal(typeof statusBody.metrics.seenEventsCount, 'number');
    assert.equal(typeof statusBody.metrics.trackedUsersCount, 'number');
    assert.ok(statusBody.metrics.seenEventsCount >= 0);
    assert.ok(statusBody.metrics.trackedUsersCount >= 0);

    // 2. PUT /api/workspace-state persists multi-platform tracking configuration
    const customPlatforms = {
      tiktok: {
        liveEnabled: true,
        postEnabled: false,
        storyEnabled: true,
        liveIntervalSeconds: 45,
        postIntervalSeconds: 180,
        storyIntervalSeconds: 300,
      },
      instagram: {
        liveEnabled: true,
        postEnabled: true,
        storyEnabled: false,
        liveIntervalSeconds: 90,
        postIntervalSeconds: 300,
        storyIntervalSeconds: 600,
      },
      facebook: {
        liveEnabled: true,
        postEnabled: true,
        storyEnabled: true,
        liveIntervalSeconds: 60,
        postIntervalSeconds: 240,
        storyIntervalSeconds: 360,
      },
      x: {
        liveEnabled: false,
        postEnabled: true,
        storyEnabled: false,
        liveIntervalSeconds: 120,
        postIntervalSeconds: 400,
        storyIntervalSeconds: 500,
      },
    };

    const putRes = await fetch(`${server.url}/api/workspace-state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rules: [],
        servers: [],
        alerts: [],
        scannerSettings: {
          cookies: { tiktok: 'custom_tiktok_cookie', instagram: '', facebook: '', x: '' },
          pollIntervalSeconds: 30,
          deduplicateLive: true,
          platforms: customPlatforms,
        },
      }),
    });
    assert.equal(putRes.status, 200);
    const putBody = (await putRes.json()) as { ok: boolean; state: any };
    assert.equal(putBody.ok, true);
    assert.equal(putBody.state.scannerSettings.platforms.tiktok.postEnabled, false);
    assert.equal(putBody.state.scannerSettings.platforms.tiktok.liveIntervalSeconds, 45);
    assert.equal(putBody.state.scannerSettings.platforms.instagram.storyEnabled, false);

    // 3. GET /api/workspace-state reflects persisted platform configuration
    const getRes = await fetch(`${server.url}/api/workspace-state`);
    assert.equal(getRes.status, 200);
    const getBody = (await getRes.json()) as { ok: boolean; state: any };
    assert.equal(getBody.ok, true);
    assert.equal(getBody.state.scannerSettings.platforms.tiktok.postEnabled, false);
    assert.equal(getBody.state.scannerSettings.platforms.tiktok.liveIntervalSeconds, 45);
    assert.equal(getBody.state.scannerSettings.platforms.x.liveEnabled, false);
    assert.equal(getBody.state.scannerSettings.cookies.tiktok, 'custom_tiktok_cookie');
  } finally {
    await server.close();
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('multi-platform mappings and brand names are bidirectionally consistent for all 4 platforms', () => {
  const platforms: SocialPlatformKey[] = ['tiktok', 'instagram', 'facebook', 'x'];

  for (const p of platforms) {
    const legacy = SOCIAL_KEY_TO_PLATFORM[p];
    assert.ok(legacy, `Legacy platform must exist for ${p}`);
    const mappedBack = PLATFORM_TO_SOCIAL_KEY[legacy];
    assert.equal(mappedBack, p, `Bidirectional mapping must match for ${p}`);
    assert.ok(PLATFORM_BRAND_NAMES[p], `Brand name must exist for ${p}`);
  }

  assert.equal(PLATFORM_BRAND_NAMES.tiktok, 'TikTok');
  assert.equal(PLATFORM_BRAND_NAMES.instagram, 'Instagram');
  assert.equal(PLATFORM_BRAND_NAMES.facebook, 'Facebook');
  assert.equal(PLATFORM_BRAND_NAMES.x, 'X (Twitter)');
});
