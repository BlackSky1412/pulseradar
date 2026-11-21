import fs from 'node:fs';
import path from 'node:path';
import { validateTargetUser } from '../server/userValidator';
import { TikTokStoryCollector } from '../server/watchers/collectors/tiktokStory';
import { TikTokPostCollector } from '../server/watchers/collectors/tiktokPost';
import { InstagramStoryCollector } from '../server/watchers/collectors/instagramStory';
import { InstagramPostCollector } from '../server/watchers/collectors/instagramPost';
import { FacebookStoryCollector } from '../server/watchers/collectors/facebookStory';
import { FacebookPostCollector } from '../server/watchers/collectors/facebookPost';
import { XStoryCollector } from '../server/watchers/collectors/xStory';
import { XPostCollector } from '../server/watchers/collectors/xPost';
import type { LivePlatform } from '../server/liveCheckers/types';

interface AuditTarget {
  platform: LivePlatform;
  rawTarget: string;
  username: string;
}

interface TargetAuditResult {
  platform: LivePlatform;
  username: string;
  rawTarget: string;
  validation: {
    valid: boolean;
    status: string;
    authMode: string;
    avatarUrl?: string | null;
    nickname?: string | null;
    id?: string | null;
    reason?: string;
  };
  storyCheck: {
    supported: boolean;
    status: string;
    itemCount: number;
    reason?: string;
  };
  postCheck: {
    supported: boolean;
    status: string;
    itemCount: number;
    reason?: string;
  };
  scanCapability: {
    canScanAnonymous: boolean;
    canScanStory: boolean;
    canScanPost: boolean;
    cookieRequired: boolean;
    issues: string[];
  };
}

async function runAudit() {
  console.log('Fetching live workspace state from Render...');
  let prodState: any;
  try {
    const r = await fetch('https://pulseradar-server.onrender.com/api/workspace-state');
    const d = await r.json();
    prodState = d.state;
  } catch (err) {
    console.warn('Could not fetch from Render, fallback to local data/workspace-state.json', err);
    prodState = JSON.parse(fs.readFileSync('data/workspace-state.json', 'utf8'));
  }

  const targets: AuditTarget[] = [];
  for (const rule of (prodState?.rules || [])) {
    let platform: LivePlatform = 'TIKTOK';
    const kw = rule.keyword || '';
    if (rule.id.includes('tiktok') || rule.platforms === 'reddit') platform = 'TIKTOK';
    else if (rule.id.includes('instagram') || rule.platforms === 'hackernews') platform = 'INSTAGRAM';
    else if (rule.id.includes('facebook') || rule.platforms === 'github') platform = 'FACEBOOK';
    else if (rule.id.includes('x') || rule.platforms === 'bluesky') platform = 'X';

    const items = kw.split(',').map((s: string) => s.trim()).filter(Boolean);
    for (const raw of items) {
      const u = raw.replace(/^@+/, '').trim();
      if (u) {
        targets.push({ platform, rawTarget: raw, username: u });
      }
    }
  }

  console.log(`Total targets to audit: ${targets.length}`);

  const ttStoryCol = new TikTokStoryCollector({ cookie: '' });
  const ttPostCol = new TikTokPostCollector({ cookie: '' });
  const igStoryCol = new InstagramStoryCollector({ cookie: '' });
  const igPostCol = new InstagramPostCollector({ cookie: '' });
  const fbStoryCol = new FacebookStoryCollector({ cookie: '' });
  const fbPostCol = new FacebookPostCollector({ cookie: '' });
  const xStoryCol = new XStoryCollector({ cookie: '' });
  const xPostCol = new XPostCollector({ cookie: '' });

  const results: TargetAuditResult[] = [];

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    console.log(`[${i + 1}/${targets.length}] Auditing ${t.platform} @${t.username}...`);

    // 1. Validation (Profile / Avatar)
    let valResult: any;
    try {
      valResult = await validateTargetUser(t.rawTarget, t.platform, {
        anonymous: true,
        cookie: '',
      });
    } catch (err: any) {
      valResult = {
        valid: false,
        status: 'ERROR',
        authMode: 'anonymous',
        reason: err.message,
      };
    }

    // 2. Story Check
    let storyCheck = { supported: true, status: 'UNKNOWN', itemCount: 0, reason: '' };
    try {
      if (t.platform === 'TIKTOK') {
        const res = await ttStoryCol.fetchWithDiagnostics(t.username);
        storyCheck = { supported: true, status: res.status, itemCount: res.events?.length || 0, reason: res.reason || '' };
      } else if (t.platform === 'INSTAGRAM') {
        const res = await igStoryCol.fetchWithDiagnostics(t.username);
        storyCheck = { supported: true, status: res.status, itemCount: res.events?.length || 0, reason: res.reason || '' };
      } else if (t.platform === 'FACEBOOK') {
        const res = await fbStoryCol.fetchWithDiagnostics(t.username);
        storyCheck = { supported: true, status: res.status, itemCount: res.events?.length || 0, reason: res.reason || '' };
      } else if (t.platform === 'X') {
        storyCheck = { supported: false, status: 'UNSUPPORTED', itemCount: 0, reason: 'X (Twitter) không hỗ trợ tính năng Story' };
      }
    } catch (err: any) {
      storyCheck = { supported: true, status: 'ERROR', itemCount: 0, reason: err.message };
    }

    // 3. Post Check
    let postCheck = { supported: true, status: 'UNKNOWN', itemCount: 0, reason: '' };
    try {
      if (t.platform === 'TIKTOK') {
        const res = await ttPostCol.fetchWithDiagnostics(t.username);
        postCheck = { supported: true, status: res.status, itemCount: res.events?.length || 0, reason: res.reason || '' };
      } else if (t.platform === 'INSTAGRAM') {
        const res = await igPostCol.fetchWithDiagnostics(t.username);
        postCheck = { supported: true, status: res.status, itemCount: res.events?.length || 0, reason: res.reason || '' };
      } else if (t.platform === 'FACEBOOK') {
        const res = await fbPostCol.fetchWithDiagnostics(t.username);
        postCheck = { supported: true, status: res.status, itemCount: res.events?.length || 0, reason: res.reason || '' };
      } else if (t.platform === 'X') {
        const res = await xPostCol.fetchWithDiagnostics(t.username);
        postCheck = { supported: true, status: res.status, itemCount: res.events?.length || 0, reason: res.reason || '' };
      }
    } catch (err: any) {
      postCheck = { supported: true, status: 'ERROR', itemCount: 0, reason: err.message };
    }

    // 4. Summarize capability
    const issues: string[] = [];
    let cookieRequired = false;

    if (!valResult.valid) {
      if (valResult.status === 'AUTH_REQUIRED' || valResult.status === 'BLOCKED') {
        issues.push(`Profile chặn truy cập ẩn danh (${valResult.status}): Cần đăng nhập/cookie`);
        cookieRequired = true;
      } else if (valResult.status === 'NOT_FOUND') {
        issues.push(`Tài khoản không tồn tại hoặc đã đổi tên (404 NOT_FOUND)`);
      } else {
        issues.push(`Lỗi xác thực: ${valResult.reason || valResult.status}`);
      }
    }

    if (storyCheck.supported) {
      if (storyCheck.status === 'AUTH_REQUIRED' || storyCheck.status === 'BLOCKED') {
        issues.push(`Story bị khóa ẩn danh (${storyCheck.status}): Cần cookie để xem story`);
        cookieRequired = true;
      }
    } else {
      issues.push(`Nền tảng không hỗ trợ Story`);
    }

    if (postCheck.status === 'AUTH_REQUIRED' || postCheck.status === 'BLOCKED') {
      issues.push(`Post bị chặn ẩn danh (${postCheck.status}): Cần cookie`);
      cookieRequired = true;
    }

    const canScanAnonymous = valResult.valid && (postCheck.status === 'OK' || postCheck.status === 'PRIVATE');
    const canScanStory = storyCheck.supported && storyCheck.status === 'OK';
    const canScanPost = postCheck.status === 'OK';

    results.push({
      platform: t.platform,
      username: t.username,
      rawTarget: t.rawTarget,
      validation: {
        valid: valResult.valid,
        status: valResult.status,
        authMode: valResult.authMode,
        avatarUrl: valResult.avatarUrl,
        nickname: valResult.nickname,
        id: valResult.id,
        reason: valResult.reason,
      },
      storyCheck,
      postCheck,
      scanCapability: {
        canScanAnonymous,
        canScanStory,
        canScanPost,
        cookieRequired,
        issues,
      },
    });

    // Small delay to be polite with rate limits
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/live_audit_results.json', JSON.stringify(results, null, 2), 'utf8');
  console.log('\nAudit complete! Saved to data/live_audit_results.json');
}

runAudit().catch(console.error);
