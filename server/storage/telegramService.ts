import fs from 'node:fs';
import type { LivePlatform } from '../liveCheckers/types';
import type {
  StorageUploadParams,
  TelegramConfig,
  UploadProviderResult,
} from './types';

const TELEGRAM_API_BASE = (
  process.env.TELEGRAM_API_BASE || 'https://telegram-bot-api-z088.onrender.com'
).replace(/\/+$/, '');

export function escapeTelegramHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escapeTelegramAttr(input: string): string {
  return escapeTelegramHtml(input).replace(/"/g, '&quot;');
}

function getPlatformMeta(platform?: LivePlatform): { badge: string; hashtag: string } {
  switch (platform) {
    case 'INSTAGRAM':
      return { badge: 'Instagram', hashtag: '#Instagram' };
    case 'FACEBOOK':
      return { badge: 'Facebook', hashtag: '#Facebook' };
    case 'X':
      return { badge: 'X', hashtag: '#X' };
    case 'TIKTOK':
    default:
      return { badge: 'TikTok', hashtag: '#TikTok' };
  }
}

export class TelegramService {
  private config: TelegramConfig;
  private lastError: string | null = null;

  constructor(config?: Partial<TelegramConfig>) {
    const envToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
    const envChatId = process.env.TELEGRAM_CHAT_ID?.trim();
    const envEnabled = process.env.TELEGRAM_STORAGE_ENABLED !== 'false';

    const hasTokenProp = Boolean(
      config && Object.prototype.hasOwnProperty.call(config, 'botToken')
    );
    const hasChatIdProp = Boolean(
      config && Object.prototype.hasOwnProperty.call(config, 'chatId')
    );

    const botToken = hasTokenProp ? config?.botToken?.trim() || undefined : envToken;
    const chatId = hasChatIdProp ? config?.chatId?.trim() || undefined : envChatId;

    this.config = {
      botToken,
      chatId,
      enabled: config?.enabled ?? (envEnabled && Boolean(botToken && chatId)),
      timeoutMs:
        typeof config?.timeoutMs === 'number' && Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
          ? config.timeoutMs
          : 60_000,
    };
  }

  isConfigured(): boolean {
    return Boolean(this.config.enabled && this.config.botToken && this.config.chatId);
  }

  updateConfig(partial: Partial<TelegramConfig>): void {
    const envToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
    const envChatId = process.env.TELEGRAM_CHAT_ID?.trim();
    const envEnabled = process.env.TELEGRAM_STORAGE_ENABLED !== 'false';

    if (Object.prototype.hasOwnProperty.call(partial, 'botToken')) {
      const nextToken = typeof partial.botToken === 'string' ? partial.botToken.trim() : '';
      this.config.botToken = nextToken || envToken || undefined;
    }
    if (Object.prototype.hasOwnProperty.call(partial, 'chatId')) {
      const nextChatId = typeof partial.chatId === 'string' ? partial.chatId.trim() : '';
      this.config.chatId = nextChatId || envChatId || undefined;
    }
    if (typeof partial.enabled === 'boolean') {
      this.config.enabled = partial.enabled && Boolean(this.config.botToken && this.config.chatId);
    } else {
      this.config.enabled = envEnabled && Boolean(this.config.botToken && this.config.chatId);
    }
    if (typeof partial.timeoutMs === 'number' && Number.isFinite(partial.timeoutMs) && partial.timeoutMs > 0) {
      this.config.timeoutMs = partial.timeoutMs;
    }
  }

  async testConnection(override?: { botToken?: string; chatId?: string }): Promise<{
    ok: boolean;
    botUsername?: string;
    chatTitle?: string;
    messageId?: number;
    error?: string;
  }> {
    const token = (override?.botToken !== undefined ? override.botToken : this.config.botToken)?.trim();
    const chatId = (override?.chatId !== undefined ? override.chatId : this.config.chatId)?.trim();
    if (!token || !chatId) {
      return {
        ok: false,
        error: 'Thiếu Telegram Bot Token hoặc Chat ID.',
      };
    }

    try {
      const timeoutMs = this.config.timeoutMs ?? 60_000;
      const getMeResp = await fetch(`${TELEGRAM_API_BASE}/bot${token}/getMe`, {
        method: 'GET',
        signal: AbortSignal.timeout(Math.min(15_000, timeoutMs)),
      });
      const getMeJson = (await getMeResp.json().catch(() => null)) as {
        ok?: boolean;
        description?: string;
        result?: { username?: string; first_name?: string };
      } | null;
      if (!getMeResp.ok || !getMeJson?.ok) {
        const err = getMeJson?.description || `Bot Token không hợp lệ (HTTP ${getMeResp.status})`;
        this.lastError = err;
        return { ok: false, error: err };
      }

      const botUsername = getMeJson.result?.username || getMeJson.result?.first_name;
      const sendResp = await fetch(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: `✅ <b>PulseRadar Telegram Storage</b> đã kết nối thành công!\n🤖 Bot: @${escapeTelegramHtml(botUsername || 'bot')}\n🕒 Thời gian: ${new Date().toISOString()}`,
          parse_mode: 'HTML',
        }),
        signal: AbortSignal.timeout(Math.min(15_000, timeoutMs)),
      });
      const sendJson = (await sendResp.json().catch(() => null)) as {
        ok?: boolean;
        description?: string;
        result?: { message_id?: number; chat?: { title?: string; username?: string } };
      } | null;

      if (!sendResp.ok || !sendJson?.ok) {
        const err =
          sendJson?.description ||
          `Không thể gửi tin nhắn tới Chat ID ${chatId} (HTTP ${sendResp.status}). Hãy kiểm tra Bot đã được thêm vào kênh/nhóm với quyền Admin chưa.`;
        this.lastError = err;
        return { ok: false, botUsername, error: err };
      }

      this.lastError = null;
      return {
        ok: true,
        botUsername,
        chatTitle: sendJson.result?.chat?.title || sendJson.result?.chat?.username || chatId,
        messageId: sendJson.result?.message_id,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.lastError = errorMsg;
      return { ok: false, error: errorMsg };
    }
  }

  getStatus() {
    const configured = Boolean(this.config.botToken && this.config.chatId);
    return {
      enabled: this.isConfigured(),
      configured,
      chatId: this.config.chatId,
      lastError: this.lastError,
    };
  }

  formatCaption(params: StorageUploadParams): string {
    const typeLabel = params.eventType.toUpperCase();
    const rawTitle = (params.title || params.fileName || '').trim();
    const cleanUsernameTag = params.username.replace(/[^a-zA-Z0-9_]/g, '') || 'user';
    const safeUsername = escapeTelegramHtml(params.username);
    const { badge, hashtag } = getPlatformMeta(params.platform);

    const safeUrl =
      params.sourceUrl && /^https?:\/\//i.test(params.sourceUrl.trim())
        ? escapeTelegramAttr(params.sourceUrl.trim())
        : '';

    const buildCaption = (titleMaxLen: number): string => {
      const slicedRaw =
        rawTitle.length > titleMaxLen
          ? `${rawTitle.slice(0, Math.max(0, titleMaxLen - 1))}…`
          : rawTitle;
      const safeTitle = escapeTelegramHtml(slicedRaw);

      let caption = `⚡ <b>PulseRadar Media Lưu Trữ</b>\n`;
      caption += `🌐 <b>Nền tảng:</b> ${badge}\n`;
      caption += `👤 <b>Tài khoản:</b> @${safeUsername}\n`;
      caption += `📌 <b>Loại sự kiện:</b> ${typeLabel}\n`;
      caption += `📝 <b>Nội dung:</b> ${safeTitle}\n`;
      if (safeUrl) {
        caption += `🔗 <b>Liên kết gốc:</b> <a href="${safeUrl}">Xem tại đây</a>\n`;
      }
      caption += `\n#PulseRadar ${hashtag} #${params.eventType} #${cleanUsernameTag}`;
      return caption;
    };

    let titleLimit = 300;
    let caption = buildCaption(titleLimit);
    while (caption.length > 1024 && titleLimit > 20) {
      titleLimit = Math.max(20, titleLimit - Math.ceil((caption.length - 1000) / 2));
      caption = buildCaption(titleLimit);
    }
    if (caption.length > 1024) {
      caption = buildCaption(0);
    }

    return caption;
  }

  async uploadFile(params: StorageUploadParams): Promise<UploadProviderResult> {
    if (!this.isConfigured()) {
      return {
        provider: 'telegram',
        success: false,
        error: 'Telegram Bot Token hoặc Chat ID chưa được cấu hình hoặc đã tắt',
      };
    }

    try {
      if (!fs.existsSync(params.localFilePath)) {
        return {
          provider: 'telegram',
          success: false,
          error: `Local file not found: ${params.localFilePath}`,
        };
      }

      const fileStats = fs.statSync(params.localFilePath);
      const maxSizeBytes = 50 * 1024 * 1024;
      if (fileStats.size > maxSizeBytes) {
        this.lastError = `File size (${(fileStats.size / 1024 / 1024).toFixed(1)}MB) exceeds Telegram Bot 50MB limit`;
        return {
          provider: 'telegram',
          success: false,
          error: this.lastError,
        };
      }

      const fileBuffer = fs.readFileSync(params.localFilePath);
      const isVideo =
        params.mimeType.startsWith('video/') ||
        params.fileName.endsWith('.mp4') ||
        params.fileName.endsWith('.mov') ||
        params.fileName.endsWith('.flv');

      const isImage =
        params.mimeType.startsWith('image/') ||
        params.fileName.endsWith('.jpg') ||
        params.fileName.endsWith('.jpeg') ||
        params.fileName.endsWith('.png') ||
        params.fileName.endsWith('.webp');

      const endpoint = isVideo ? 'sendVideo' : isImage ? 'sendPhoto' : 'sendDocument';
      const fileField = isVideo ? 'video' : isImage ? 'photo' : 'document';

      const formData = new FormData();
      formData.append('chat_id', this.config.chatId!);
      formData.append('caption', this.formatCaption(params));
      formData.append('parse_mode', 'HTML');

      const blob = new Blob([fileBuffer], {
        type: params.mimeType || 'application/octet-stream',
      });
      formData.append(fileField, blob, params.fileName);

      const apiUrl = `${TELEGRAM_API_BASE}/bot${this.config.botToken}/${endpoint}`;
      const timeoutMs = this.config.timeoutMs ?? 60_000;
      const resp = await fetch(apiUrl, {
        method: 'POST',
        body: formData,
        signal: AbortSignal.timeout(timeoutMs),
      });

      const rawBody = await resp.text().catch(() => '');
      let resData: {
        ok?: boolean;
        description?: string;
        result?: {
          message_id: number;
          chat?: { id: number | string; username?: string };
        };
      } | null = null;
      if (rawBody) {
        try {
          resData = JSON.parse(rawBody);
        } catch {
          resData = null;
        }
      }

      if (!resp.ok || !resData?.ok) {
        const errorMsg =
          resData?.description ||
          (rawBody
            ? `Telegram API responded with HTTP ${resp.status}: ${rawBody.slice(0, 200)}`
            : `Telegram API responded with HTTP ${resp.status}`);
        this.lastError = errorMsg;
        return {
          provider: 'telegram',
          success: false,
          error: errorMsg,
        };
      }

      const messageId = resData.result?.message_id;
      let telegramLink: string | undefined;

      const chatUsername = resData.result?.chat?.username;
      const rawChatId = String(resData.result?.chat?.id || this.config.chatId);

      if (chatUsername) {
        telegramLink = `https://t.me/${chatUsername}/${messageId}`;
      } else if (rawChatId.startsWith('-100')) {
        const cleanChannelId = rawChatId.replace(/^-100/, '');
        telegramLink = `https://t.me/c/${cleanChannelId}/${messageId}`;
      }

      this.lastError = null;
      return {
        provider: 'telegram',
        success: true,
        telegramMessageId: messageId,
        telegramLink,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.lastError = errorMsg;
      return {
        provider: 'telegram',
        success: false,
        error: errorMsg,
      };
    }
  }
}

export function createTelegramService(config?: Partial<TelegramConfig>): TelegramService {
  return new TelegramService(config);
}
