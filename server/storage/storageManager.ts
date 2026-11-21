import fs from 'node:fs';
import { GoogleDriveService } from './googleDriveService';
import { TelegramService } from './telegramService';
import type {
  StorageStatus,
  StorageUploadParams,
  UnifiedUploadResult,
  UploadProviderResult,
} from './types';

export interface StorageManagerOptions {
  googleDriveService?: GoogleDriveService;
  telegramService?: TelegramService;
  localStorageRoot?: string;
  cleanupLocalAfterCloudUpload?: boolean;
}

export class StorageManager {
  private gdriveService: GoogleDriveService;
  private telegramService: TelegramService;
  private localStorageRoot: string;
  private cleanupLocalAfterCloudUpload: boolean;

  constructor(options?: StorageManagerOptions) {
    this.gdriveService = options?.googleDriveService || new GoogleDriveService();
    this.telegramService = options?.telegramService || new TelegramService();
    this.localStorageRoot = options?.localStorageRoot || process.cwd();
    this.cleanupLocalAfterCloudUpload =
      options?.cleanupLocalAfterCloudUpload ??
      process.env.STORAGE_CLEANUP_LOCAL === 'true';
  }

  getGoogleDriveService(): GoogleDriveService {
    return this.gdriveService;
  }

  getTelegramService(): TelegramService {
    return this.telegramService;
  }

  getStatus(): StorageStatus {
    return {
      googleDrive: this.gdriveService.getStatus(),
      telegram: this.telegramService.getStatus(),
      localStorageRoot: this.localStorageRoot,
    };
  }

  /**
   * Dispatches the local media file to all enabled cloud storage providers.
   * If both Google Drive and Telegram are active, uploads to both.
   */
  async uploadMedia(params: StorageUploadParams): Promise<UnifiedUploadResult> {
    const results: UploadProviderResult[] = [];
    let driveLink: string | undefined;
    let telegramLink: string | undefined;

    // 1. Google Drive Cloud Provider
    if (this.gdriveService.isConfigured()) {
      try {
        const driveResult = await this.gdriveService.uploadFile(params);
        results.push(driveResult);
        if (driveResult.success) {
          driveLink = driveResult.webViewLink;
        }
      } catch (err) {
        results.push({
          provider: 'google_drive',
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 2. Telegram Cloud Provider
    if (this.telegramService.isConfigured()) {
      try {
        const teleResult = await this.telegramService.uploadFile(params);
        results.push(teleResult);
        if (teleResult.success) {
          telegramLink = teleResult.telegramLink;
        }
      } catch (err) {
        results.push({
          provider: 'telegram',
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 3. Fallback / Local Provider record
    if (results.length === 0) {
      results.push({
        provider: 'local',
        success: true,
        fileId: params.fileName,
      });
    }

    // 4. Optional cleanup of local temporary file if requested and cloud upload succeeded
    const anyCloudSuccess = results.some(
      r => (r.provider === 'google_drive' || r.provider === 'telegram') && r.success
    );

    if (this.cleanupLocalAfterCloudUpload && anyCloudSuccess) {
      try {
        if (fs.existsSync(params.localFilePath)) {
          fs.unlinkSync(params.localFilePath);
        }
      } catch {
        // Ignore unlink error
      }
    }

    return {
      fileName: params.fileName,
      localPath: params.localFilePath,
      results,
      driveLink,
      telegramLink,
    };
  }
}

export function createStorageManager(options?: StorageManagerOptions): StorageManager {
  return new StorageManager(options);
}
