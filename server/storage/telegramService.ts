import fs from 'node:fs';
import type {
  StorageUploadParams,
  TelegramConfig,
  UploadProviderResult,
} from './types';

export class TelegramService {
  private config: TelegramConfig;
  private lastError: string | null = null;

  constructor(config?: Partial<TelegramConfig>) {
    const envToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
    const envChatId = process.env.TELEGRAM_CHAT_ID?.trim();
    const envEnabled = process.env.TELEGRAM_STORAGE_ENABLED !== 'false';

    this.config = {
      botToken: config?.botToken ?? envToken,
      chatId: config?.chatId ?? envChatId,
      enabled: config?.enabled ?? (envEnabled && Boolean(envToken && envChatId)),
    };
  }

  isConfigured(): boolean {
    return Boolean(this.config.botToken && this.config.chatId);
  }

  getStatus() {
    return {
      enabled: this.config.enabled && this.isConfigured(),
      configured: this.isConfigured(),
      chatId: this.config.chatId,
      lastError: this.lastError,
    };
  }

  private formatCaption(params: StorageUploadParams): string {
    const typeLabel = params.eventType.toUpperCase();
    const title = params.title || params.fileName;
    const cleanUsername = params.username.replace(/[^a-zA-Z0-9_]/g, '');

    let caption = `⚡ <b>PulseRadar Media Lưu Trữ</b>\n`;
    caption += `👤 <b>Tài khoản:</b> @${params.username}\n`;
    caption += `📌 <b>Loại sự kiện:</b> ${typeLabel}\n`;
    caption += `📝 <b>Nội dung:</b> ${title.slice(0, 300)}\n`;
    if (params.sourceUrl) {
      caption += `🔗 <b>Liên kết gốc:</b> <a href="${params.sourceUrl}">Xem tại đây</a>\n`;
    }
    caption += `\n#PulseRadar #${params.eventType} #${cleanUsername}`;

    // Telegram caption maximum length is 1024 characters
    return caption.slice(0, 1020);
  }

  async uploadFile(params: StorageUploadParams): Promise<UploadProviderResult> {
    if (!this.isConfigured()) {
      return {
        provider: 'telegram',
        success: false,
        error: 'Telegram Bot Token hoặc Chat ID chưa được cấu hình',
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
      // Telegram Bot API standard file upload limit is 50MB
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

      const blob = new Blob([fileBuffer], { type: params.mimeType || 'application/octet-stream' });
      formData.append(fileField, blob, params.fileName);

      const apiUrl = `https://api.telegram.org/bot${this.config.botToken}/${endpoint}`;
      const resp = await fetch(apiUrl, {
        method: 'POST',
        body: formData,
      });

      const resData = (await resp.json()) as {
        ok: boolean;
        description?: string;
        result?: {
          message_id: number;
          chat?: { id: number | string; username?: string };
        };
      };

      if (!resp.ok || !resData.ok) {
        const errorMsg = resData.description || `Telegram API responded with HTTP ${resp.status}`;
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
