import { fetchWithTimeout, safeJsonParse } from './liveCheckers/httpClient';

export interface UserValidationResult {
  valid: boolean;
  username: string;
  platform: string;
  error?: string;
  id?: string;
  nickname?: string;
  avatarUrl?: string;
  profileUrl: string;
}

const MOBILE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1';

export function resolvePlatformProfileUrl(rawTarget: string, platform = 'TIKTOK'): string {
  const clean = rawTarget.trim();
  if (clean.startsWith('http://') || clean.startsWith('https://')) {
    return clean;
  }
  const cleanUsername = clean.replace(/^@+/, '').split(/[/?#]/)[0].trim();
  const p = platform.toUpperCase();

  if (p === 'REDDIT' || p === 'TIKTOK') {
    return `https://www.tiktok.com/@${cleanUsername}`;
  }
  if (p === 'HACKERNEWS' || p === 'INSTAGRAM') {
    return `https://www.instagram.com/${cleanUsername}/`;
  }
  if (p === 'GITHUB' || p === 'FACEBOOK') {
    return `https://www.facebook.com/${cleanUsername}`;
  }
  if (p === 'BLUESKY' || p === 'X' || p === 'TWITTER') {
    return `https://x.com/${cleanUsername}`;
  }
  return `https://www.tiktok.com/@${cleanUsername}`;
}

export function extractTargetUsername(input: string): string {
  const trimmed = input.trim();
  if (trimmed.includes('tiktok.com')) {
    const atMatch = trimmed.match(/tiktok\.com\/@([a-zA-Z0-9_.]+)/);
    if (atMatch?.[1]) return atMatch[1];
    const plainMatch = trimmed.match(/tiktok\.com\/([a-zA-Z0-9_.]+)/);
    return plainMatch?.[1] || trimmed.replace(/^@/, '');
  }
  if (trimmed.includes('instagram.com')) {
    const match = trimmed.match(/instagram\.com\/([a-zA-Z0-9_.]+)/);
    if (match?.[1]) return match[1];
  }
  if (trimmed.includes('facebook.com')) {
    const match = trimmed.match(/facebook\.com\/([a-zA-Z0-9_.]+)/);
    if (match?.[1]) return match[1];
  }
  if (trimmed.includes('x.com') || trimmed.includes('twitter.com')) {
    const match = trimmed.match(/(?:x|twitter)\.com\/([a-zA-Z0-9_.]+)/);
    if (match?.[1]) return match[1];
  }
  return trimmed.replace(/^@+/, '').split(/[/?#]/)[0].trim();
}

/**
 * Validates whether a target username exists and is valid on the target platform.
 */
export async function validateTargetUser(
  target: string,
  platform = 'TIKTOK',
  cookie = ''
): Promise<UserValidationResult> {
  const username = extractTargetUsername(target);
  const p = platform.toUpperCase();
  const profileUrl = resolvePlatformProfileUrl(username, p);

  if (!username) {
    return {
      valid: false,
      username: target,
      platform: p,
      profileUrl,
      error: 'Tên người dùng không được để trống',
    };
  }

  // 1. TikTok Validation
  if (p === 'TIKTOK' || p === 'REDDIT') {
    if (!/^[a-zA-Z0-9_.]+$/.test(username) || username.length < 2 || username.length > 24) {
      return {
        valid: false,
        username,
        platform: p,
        profileUrl,
        error: `Tên người dùng TikTok "@${username}" không đúng định dạng (chỉ gồm chữ cái, số, dấu gạch dưới, dấu chấm và từ 2-24 ký tự).`,
      };
    }

    try {
      const url = `https://www.tiktok.com/@${encodeURIComponent(username)}`;
      const headers: Record<string, string> = {
        'User-Agent': MOBILE_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
      };
      if (cookie?.trim()) {
        headers.Cookie = cookie.includes('=') ? cookie.trim() : `sessionid=${cookie.trim()}`;
      }

      const resp = await fetchWithTimeout(url, { headers, timeoutMs: 9000 });
      if (resp.status === 404) {
        return {
          valid: false,
          username,
          platform: p,
          profileUrl,
          error: `Tài khoản TikTok "@${username}" không tồn tại (Lỗi 404 Not Found). Vui lòng kiểm tra lại chính tả!`,
        };
      }

      const html = resp.text || '';
      const match = html.match(
        /<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/
      );

      if (match?.[1]) {
        const data = safeJsonParse<Record<string, unknown>>(match[1]);
        const defaultScope = data?.__DEFAULT_SCOPE__ as Record<string, unknown> | undefined;
        const userDetail = defaultScope?.['webapp.user-detail'] as Record<string, unknown> | undefined;
        const statusCode = userDetail?.statusCode;
        const userInfo = userDetail?.userInfo as Record<string, unknown> | undefined;
        const user = userInfo?.user as Record<string, unknown> | undefined;

        if (typeof statusCode === 'number' && statusCode !== 0) {
          return {
            valid: false,
            username,
            platform: p,
            profileUrl,
            error: `Tài khoản TikTok "@${username}" không tồn tại hoặc đã bị khóa (Mã lỗi ${statusCode}).`,
          };
        }

        if (user?.id) {
          return {
            valid: true,
            username,
            platform: p,
            profileUrl,
            id: String(user.id),
            nickname: typeof user.nickname === 'string' ? user.nickname : username,
            avatarUrl:
              typeof user.avatarThumb === 'string'
                ? user.avatarThumb
                : typeof user.avatarMedium === 'string'
                ? user.avatarMedium
                : undefined,
          };
        }
      }

      // If page returned 200 and has id digits or user profile
      const idMatch = html.match(/"id":"(\d{15,22})"/);
      if (idMatch?.[1]) {
        return {
          valid: true,
          username,
          platform: p,
          profileUrl,
          id: idMatch[1],
        };
      }

      // If universal data or id match failed and page seems blocked or missing
      if (html.includes('Couldn\'t find this account') || html.includes('Không thể tìm thấy tài khoản này')) {
        return {
          valid: false,
          username,
          platform: p,
          profileUrl,
          error: `Tài khoản TikTok "@${username}" không tồn tại. Vui lòng kiểm tra lại chính tả!`,
        };
      }

      return {
        valid: true,
        username,
        platform: p,
        profileUrl,
      };
    } catch (err) {
      return {
        valid: false,
        username,
        platform: p,
        profileUrl,
        error: `Không thể kết nối xác thực tài khoản @${username} với TikTok: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // 2. Instagram Validation
  if (p === 'INSTAGRAM' || p === 'HACKERNEWS') {
    if (!/^[a-zA-Z0-9_.]+$/.test(username) || username.length < 1 || username.length > 30) {
      return {
        valid: false,
        username,
        platform: p,
        profileUrl,
        error: `Tên người dùng Instagram "@${username}" không đúng định dạng (chỉ gồm chữ cái, số, dấu gạch dưới, dấu chấm và tối đa 30 ký tự).`,
      };
    }
    return {
      valid: true,
      username,
      platform: p,
      profileUrl,
    };
  }

  // 3. Facebook Validation
  if (p === 'FACEBOOK' || p === 'GITHUB') {
    if (!/^[a-zA-Z0-9_.-]+$/.test(username) || username.length < 3 || username.length > 50) {
      return {
        valid: false,
        username,
        platform: p,
        profileUrl,
        error: `Tên người dùng hoặc URL Facebook "${target}" không hợp lệ.`,
      };
    }
    return {
      valid: true,
      username,
      platform: p,
      profileUrl,
    };
  }

  // 4. X (Twitter) Validation
  if (p === 'X' || p === 'BLUESKY' || p === 'TWITTER') {
    if (!/^[a-zA-Z0-9_]{1,15}$/.test(username)) {
      return {
        valid: false,
        username,
        platform: p,
        profileUrl,
        error: `Username X (Twitter) "@${username}" không hợp lệ (tối đa 15 ký tự chữ cái, số hoặc dấu gạch dưới).`,
      };
    }
    return {
      valid: true,
      username,
      platform: p,
      profileUrl,
    };
  }

  return {
    valid: true,
    username,
    platform: p,
    profileUrl,
  };
}
