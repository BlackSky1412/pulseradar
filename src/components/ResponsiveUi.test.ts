import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { WatchlistSection } from './WatchlistSection';
import { ActivityLogSection } from './ActivityLogSection';
import { InfoPopover } from './InfoPopover';
import { UserAvatar } from './UserAvatar';
import { CookieSettingsModal } from './CookieSettingsModal';
import { RuleModal } from './RuleModal';
import { WebhookModal } from './WebhookModal';
import { PayloadInspectorModal } from './PayloadInspectorModal';
import {
  createDefaultMultiPlatformSettings,
  type AlertDetectionItem,
  type KeywordRuleItem,
  type LiveTargetScanStatus,
  type TargetStreamMeta,
  type WebhookServerItem,
} from '../utils/scannerEngine';

function getTagMatches(
  html: string,
  tagName: 'button' | 'a' | 'input' | 'select' | 'label'
): string[] {
  return html.match(new RegExp(`<${tagName}\\b[^>]*>`, 'g')) ?? [];
}

function getElementBlocksWithLabels(
  html: string,
  tagName: 'label'
): Array<{ openTag: string; innerHtml: string }> {
  const blocks: Array<{ openTag: string; innerHtml: string }> = [];
  const regex = new RegExp(`<${tagName}\\b([^>]*)>([\\s\\S]*?)</${tagName}>`, 'g');
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    blocks.push({ openTag: `<${tagName}${match[1]}>`, innerHtml: match[2] });
  }
  return blocks;
}

function hasMinTouchHeight(tagHtml: string, minPx = 44): boolean {
  const match = tagHtml.match(/\bmin-h-\[(\d+)px\]/);
  if (match && Number(match[1]) >= minPx) return true;
  const hMatch = tagHtml.match(/\bh-(\d+)\b/);
  return Boolean(hMatch && Number(hMatch[1]) * 4 >= minPx);
}

function hasMinTouchWidth(tagHtml: string, minPx = 44): boolean {
  const match = tagHtml.match(/\bmin-w-\[(\d+)px\]/);
  if (match && Number(match[1]) >= minPx) return true;
  const wMatch = tagHtml.match(/\bw-(\d+)\b/);
  return Boolean(wMatch && Number(wMatch[1]) * 4 >= minPx);
}

function extractBetweenMarkers(html: string, startMarker: string, endMarker?: string): string {
  const startIdx = html.indexOf(startMarker);
  assert.ok(startIdx >= 0, `Expected marker "${startMarker}" to exist in HTML`);
  if (!endMarker) return html.slice(startIdx);
  const endIdx = html.indexOf(endMarker, startIdx);
  assert.ok(endIdx > startIdx, `Expected marker "${endMarker}" after "${startMarker}"`);
  return html.slice(startIdx, endIdx);
}

const SAMPLE_RULE: KeywordRuleItem = {
  id: 'rule_tiktok_source',
  ownerId: 'demo_user',
  keyword: '@mixigaming, https://www.tiktok.com/@vtv24_official_very_long_channel_handle',
  excludedKeywords: 'tiktok.com |',
  matchType: 'contains',
  platforms: 'reddit',
  webhookServerId: 'srv_sandbox_local',
  enabled: true,
  matchCount: 2,
  createdAt: '2026-11-20T10:00:00.000Z',
  updatedAt: '2026-11-20T10:00:00.000Z',
};

const SAMPLE_SERVER: WebhookServerItem = {
  id: 'srv_sandbox_local',
  ownerId: 'demo_user',
  name: 'Máy chủ Sandbox cục bộ',
  url: '/api/webhook-sandbox',
  format: 'json',
  secretHeader: 'whsec_test_123456',
  enabled: true,
  createdAt: '2026-11-20T10:00:00.000Z',
  updatedAt: '2026-11-20T10:00:00.000Z',
};

const SAMPLE_ALERT_DELIVERED: AlertDetectionItem = {
  id: 'alert_1',
  ownerId: 'demo_user',
  ruleId: 'rule_tiktok_source',
  keyword: '[PHÁT LIVE] @mixigaming',
  platform: 'reddit',
  author: 'mixigaming',
  title: 'Đang phát trực tiếp buổi tối cùng anh em trên TikTok Live',
  contentSnippet: 'Stream chất lượng gốc FLV/HLS đã được phát hiện và chuyển tiếp sang Android.',
  sourceUrl: 'https://www.tiktok.com/@mixigaming/live',
  webhookServerName: 'Máy chủ Sandbox cục bộ',
  webhookStatus: 'delivered',
  httpStatusCode: 200,
  latencyMs: 42,
  payloadJson: JSON.stringify({ event: 'social.keyword.detected', activityType: 'live' }, null, 2),
  createdAt: '2026-11-20T12:00:00.000Z',
  updatedAt: '2026-11-20T12:00:00.000Z',
};

const SAMPLE_ALERT_FAILED: AlertDetectionItem = {
  id: 'alert_2',
  ownerId: 'demo_user',
  ruleId: 'rule_tiktok_source',
  keyword: '[STORY] @vtv24',
  platform: 'reddit',
  author: 'vtv24',
  title: 'Tin nhanh 24h vừa đăng tải',
  contentSnippet: 'Nội dung story tạm thời được phát hiện.',
  sourceUrl: 'https://www.tiktok.com/@vtv24',
  webhookServerName: 'Backup Server',
  webhookStatus: 'failed',
  httpStatusCode: 502,
  latencyMs: 310,
  payloadJson: JSON.stringify({ event: 'social.keyword.detected', activityType: 'story' }, null, 2),
  createdAt: '2026-11-20T12:05:00.000Z',
  updatedAt: '2026-11-20T12:05:00.000Z',
};

test('WatchlistSection renders empty state without table when targets is empty', () => {
  const html = renderToStaticMarkup(
    React.createElement(WatchlistSection, {
      selectedPlatform: 'tiktok',
      targets: [],
      liveStatusMap: {},
      targetStreamMetaMap: {},
      hasPlatformCookie: false,
      isScanning: false,
      scanningTargetKey: null,
      copiedStreamKey: null,
      onToggleStream: () => {},
      onScanTarget: () => {},
      onCopyStreamUrl: () => {},
      onEditRule: () => {},
      onRemoveTarget: () => {},
    })
  );

  assert.equal(html.includes('<table'), false);
  assert.ok(html.includes('Chưa có kênh nào trong tab TikTok'));
});

test('WatchlistSection renders mobile cards without table and preserves 6-col desktop table', () => {
  const longStreamTitle =
    'Buổi livestream đặc biệt kéo dài cả buổi tối với tiêu đề rất dài không được cắt xén trên thiết bị di động';
  const liveStatusMap: Record<string, LiveTargetScanStatus> = {
    [`${SAMPLE_RULE.id}::@mixigaming`]: {
      ruleId: SAMPLE_RULE.id,
      target: '@mixigaming',
      username: 'mixigaming',
      platform: 'TIKTOK',
      status: 'LIVE',
      title: longStreamTitle,
      streamUrl: 'https://pull-flv.tiktokcdn.com/stream/123.flv',
      sourceUrl: 'https://www.tiktok.com/@mixigaming/live',
      qualityInfo: '1080p60 · FLV',
      checkedAt: '2026-11-20T12:00:00.000Z',
    },
    [`${SAMPLE_RULE.id}::https://www.tiktok.com/@vtv24_official_very_long_channel_handle`]: {
      ruleId: SAMPLE_RULE.id,
      target: 'https://www.tiktok.com/@vtv24_official_very_long_channel_handle',
      username: 'vtv24_official_very_long_channel_handle',
      platform: 'TIKTOK',
      status: 'ERROR',
      sourceUrl: 'https://www.tiktok.com/@vtv24_official_very_long_channel_handle',
      error: 'Network timeout while checking channel',
      checkedAt: '2026-11-20T12:01:00.000Z',
    },
  };
  const targetStreamMetaMap: Record<string, TargetStreamMeta> = {
    [`${SAMPLE_RULE.id}::@mixigaming`]: {
      live: true,
      post: true,
      story: false,
      warmup: true,
    },
  };

  const html = renderToStaticMarkup(
    React.createElement(WatchlistSection, {
      selectedPlatform: 'tiktok',
      targets: [
        { rule: SAMPLE_RULE, target: '@mixigaming' },
        {
          rule: SAMPLE_RULE,
          target: 'https://www.tiktok.com/@vtv24_official_very_long_channel_handle',
        },
      ],
      liveStatusMap,
      targetStreamMetaMap,
      hasPlatformCookie: false,
      isScanning: false,
      scanningTargetKey: null,
      copiedStreamKey: `${SAMPLE_RULE.id}::@mixigaming`,
      onToggleStream: () => {},
      onScanTarget: () => {},
      onCopyStreamUrl: () => {},
      onEditRule: () => {},
      onRemoveTarget: () => {},
    })
  );

  const mobileHtml = extractBetweenMarkers(
    html,
    'data-testid="watchlist-mobile-cards"',
    'data-testid="watchlist-desktop-table"'
  );
  const desktopHtml = extractBetweenMarkers(html, 'data-testid="watchlist-desktop-table"');

  // Mobile cards must not contain any <table>
  assert.equal(mobileHtml.includes('<table'), false);
  assert.ok(mobileHtml.includes('@mixigaming'));
  assert.ok(mobileHtml.includes('break-all'));
  assert.ok(mobileHtml.includes(longStreamTitle));
  assert.equal(mobileHtml.includes('max-w-[180px] truncate'), false);

  // Explicit visible stream toggle labels + aria-pressed
  assert.ok(mobileHtml.includes('Live: Bật'));
  assert.ok(mobileHtml.includes('Post: Bật'));
  assert.ok(mobileHtml.includes('Story: Tắt'));
  assert.ok(mobileHtml.includes('aria-pressed="true"'));
  assert.ok(mobileHtml.includes('aria-pressed="false"'));

  // Touch-accessible Warmup InfoPopover + Post/Story status summaries + Action labels
  assert.ok(mobileHtml.includes('Warmup'));
  assert.ok(mobileHtml.includes('aria-expanded="false"'));
  assert.ok(mobileHtml.includes('Post: Khởi tạo êm (Đang theo dõi)'));
  assert.ok(mobileHtml.includes('Story: Tắt'));
  assert.ok(mobileHtml.includes('Quét Live'));
  assert.ok(mobileHtml.includes('Đã chép'));

  // Every <button> and <a> in mobile cards must have >= 44px touch height
  const mobileButtons = getTagMatches(mobileHtml, 'button');
  const mobileLinks = getTagMatches(mobileHtml, 'a');
  assert.ok(mobileButtons.length >= 10);
  assert.ok(mobileLinks.length >= 1);
  for (const btn of mobileButtons) {
    assert.ok(hasMinTouchHeight(btn, 44), `Watchlist mobile button missing >=44px height: ${btn}`);
    if (
      btn.includes('aria-label="Sửa cấu hình nguồn') ||
      btn.includes('aria-label="Xóa ')
    ) {
      assert.ok(hasMinTouchWidth(btn, 44), `Watchlist icon button missing >=44px width: ${btn}`);
    }
  }
  for (const link of mobileLinks) {
    assert.ok(hasMinTouchHeight(link, 44), `Watchlist mobile link missing >=44px height: ${link}`);
    assert.ok(hasMinTouchWidth(link, 44), `Watchlist mobile link missing >=44px width: ${link}`);
  }

  // Desktop block retains the 6-column table
  assert.ok(desktopHtml.includes('<table'));
  for (const col of [
    'Kênh &amp; Avatar',
    'Luồng kích hoạt',
    'Trạng thái Live',
    'Trạng thái Post',
    'Trạng thái Story',
    'Hành động',
  ]) {
    assert.ok(desktopHtml.includes(col), `Desktop Watchlist table missing column "${col}"`);
  }
});

test('ActivityLogSection renders mobile cards without table and preserves 6-col desktop table', () => {
  const html = renderToStaticMarkup(
    React.createElement(ActivityLogSection, {
      selectedPlatform: 'tiktok',
      logScope: 'platform',
      onChangeLogScope: () => {},
      searchQuery: '',
      onChangeSearchQuery: () => {},
      totalAlertsCount: 2,
      filteredAlerts: [SAMPLE_ALERT_DELIVERED, SAMPLE_ALERT_FAILED],
      onInspectAlert: () => {},
    })
  );

  // Header controls must be >= 44px on mobile
  const headerHtml = extractBetweenMarkers(html, '<section', 'data-testid="activity-log-mobile-cards"');
  for (const btn of getTagMatches(headerHtml, 'button')) {
    assert.ok(hasMinTouchHeight(btn, 44), `ActivityLog header button < 44px: ${btn}`);
  }
  for (const input of getTagMatches(headerHtml, 'input')) {
    assert.ok(hasMinTouchHeight(input, 44), `ActivityLog search input < 44px: ${input}`);
  }

  const mobileHtml = extractBetweenMarkers(
    html,
    'data-testid="activity-log-mobile-cards"',
    'data-testid="activity-log-desktop-table"'
  );
  const desktopHtml = extractBetweenMarkers(html, 'data-testid="activity-log-desktop-table"');

  assert.equal(mobileHtml.includes('<table'), false);
  assert.ok(mobileHtml.includes('[PHÁT LIVE] @mixigaming'));
  assert.ok(mobileHtml.includes('@mixigaming'));
  assert.ok(mobileHtml.includes(SAMPLE_ALERT_DELIVERED.title));
  assert.ok(mobileHtml.includes('HTTP 200'));
  assert.ok(mobileHtml.includes('HTTP 502'));
  assert.ok(mobileHtml.includes('Xem Request'));

  const mobileButtons = getTagMatches(mobileHtml, 'button');
  const mobileLinks = getTagMatches(mobileHtml, 'a');
  assert.equal(mobileButtons.length, 2);
  assert.equal(mobileLinks.length, 2);
  for (const btn of mobileButtons) {
    assert.ok(hasMinTouchHeight(btn, 44), `ActivityLog mobile button < 44px: ${btn}`);
  }
  for (const link of mobileLinks) {
    assert.ok(hasMinTouchHeight(link, 44), `ActivityLog mobile link < 44px height: ${link}`);
    assert.ok(hasMinTouchWidth(link, 44), `ActivityLog mobile link < 44px width: ${link}`);
  }

  assert.ok(desktopHtml.includes('<table'));
  for (const col of [
    'Thời gian',
    'Loại sự kiện &amp; Mục tiêu',
    'Nền tảng &amp; Creator',
    'Tiêu đề / Nội dung',
    'Máy chủ xử lý &amp; Phản hồi',
    'Chi tiết Request',
  ]) {
    assert.ok(desktopHtml.includes(col), `Desktop ActivityLog table missing column "${col}"`);
  }
});

test('InfoPopover renders touch-accessible closed and expanded states without title-only hiding', () => {
  const closedHtml = renderToStaticMarkup(
    React.createElement(InfoPopover, {
      ariaLabel: 'Xem chi tiết Server Auto-Scan',
      title: 'Server Auto-Scan',
      iconOnly: true,
      defaultOpen: false,
      children: 'Nội dung giải thích chi tiết',
    })
  );

  const closedButtons = getTagMatches(closedHtml, 'button');
  assert.equal(closedButtons.length, 1);
  assert.ok(hasMinTouchHeight(closedButtons[0], 44));
  assert.ok(hasMinTouchWidth(closedButtons[0], 44));
  assert.ok(closedButtons[0].includes('aria-expanded="false"'));
  assert.ok(closedButtons[0].includes('aria-controls="'));
  assert.equal(closedButtons[0].includes('title="'), false);
  assert.equal(closedHtml.includes('Nội dung giải thích chi tiết'), false);

  const openHtml = renderToStaticMarkup(
    React.createElement(InfoPopover, {
      ariaLabel: 'Xem chi tiết Server Auto-Scan',
      title: 'Server Auto-Scan',
      defaultOpen: true,
      children: 'Nội dung giải thích chi tiết',
    })
  );

  const openButtons = getTagMatches(openHtml, 'button');
  assert.equal(openButtons.length, 2); // trigger + close X
  assert.ok(openButtons[0].includes('aria-expanded="true"'));
  const controlsMatch = openButtons[0].match(/aria-controls="([^"]+)"/);
  assert.ok(controlsMatch && controlsMatch[1]);
  assert.ok(openHtml.includes(`id="${controlsMatch[1]}"`));
  assert.ok(openHtml.includes('role="region"'));
  assert.ok(openHtml.includes('max-w-[calc(100vw-2rem)]'));
  assert.ok(openHtml.includes('Nội dung giải thích chi tiết'));
  assert.ok(hasMinTouchHeight(openButtons[1], 44));
  assert.ok(hasMinTouchWidth(openButtons[1], 44));
});

test('UserAvatar sets aria-label and marks decorative badges aria-hidden', () => {
  const html = renderToStaticMarkup(
    React.createElement(UserAvatar, {
      target: '@mixigaming',
      platform: 'tiktok',
      isLive: true,
    })
  );
  assert.ok(html.includes('aria-label="mixigaming (TIKTOK)"'));
  assert.ok(html.includes('aria-hidden="true"'));
});

test('All 4 Modals enforce >= 44px touch targets and RuleModal initializes targets lazily for SSR', () => {
  const cookieHtml = renderToStaticMarkup(
    React.createElement(CookieSettingsModal, {
      isOpen: true,
      onClose: () => {},
      settings: {
        cookies: { tiktok: '', instagram: '', facebook: '', x: '' },
        pollIntervalSeconds: 60,
        deduplicateLive: true,
        platforms: createDefaultMultiPlatformSettings(),
      },
      onSave: () => {},
    })
  );

  const ruleHtml = renderToStaticMarkup(
    React.createElement(RuleModal, {
      isOpen: true,
      onClose: () => {},
      onSave: async () => {},
      editingRule: SAMPLE_RULE,
      servers: [SAMPLE_SERVER],
      defaultPlatform: 'reddit',
    })
  );

  const webhookHtml = renderToStaticMarkup(
    React.createElement(WebhookModal, {
      isOpen: true,
      onClose: () => {},
      onSave: async () => {},
      editingServer: SAMPLE_SERVER,
    })
  );

  const inspectorHtml = renderToStaticMarkup(
    React.createElement(PayloadInspectorModal, {
      alertItem: SAMPLE_ALERT_DELIVERED,
      onClose: () => {},
      onRetryWebhook: async () => {},
    })
  );

  // Verify RuleModal lazily initialized targets & Trash2 buttons in SSR
  assert.ok(ruleHtml.includes('@mixigaming'));
  assert.ok(ruleHtml.includes('https://www.tiktok.com/@vtv24_official_very_long_channel_handle'));
  assert.ok(ruleHtml.includes('aria-label="Xóa @mixigaming"'));
  assert.equal(ruleHtml.includes('Chưa có mục tiêu nào.'), false);

  for (const [name, modalHtml] of [
    ['CookieSettingsModal', cookieHtml],
    ['RuleModal', ruleHtml],
    ['WebhookModal', webhookHtml],
    ['PayloadInspectorModal', inspectorHtml],
  ] as const) {
    assert.ok(modalHtml.includes('role="dialog"'), `${name} missing role="dialog"`);

    for (const btn of getTagMatches(modalHtml, 'button')) {
      assert.ok(hasMinTouchHeight(btn, 44), `${name} button < 44px height: ${btn}`);
      if (btn.includes('aria-label="Đóng') || btn.includes('aria-label="Xóa')) {
        assert.ok(hasMinTouchWidth(btn, 44), `${name} icon button < 44px width: ${btn}`);
      }
    }

    for (const input of getTagMatches(modalHtml, 'input')) {
      if (input.includes('type="text"') || input.includes('type="password"')) {
        assert.ok(hasMinTouchHeight(input, 44), `${name} text/password input < 44px: ${input}`);
      }
    }

    for (const select of getTagMatches(modalHtml, 'select')) {
      assert.ok(hasMinTouchHeight(select, 44), `${name} select < 44px: ${select}`);
    }

    for (const link of getTagMatches(modalHtml, 'a')) {
      assert.ok(hasMinTouchHeight(link, 44), `${name} link < 44px: ${link}`);
    }

    for (const labelBlock of getElementBlocksWithLabels(modalHtml, 'label')) {
      if (labelBlock.innerHtml.includes('type="checkbox"')) {
        assert.ok(
          hasMinTouchHeight(labelBlock.openTag, 44),
          `${name} checkbox <label> wrapper < 44px: ${labelBlock.openTag}`
        );
      }
    }
  }
});
