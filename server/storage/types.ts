export interface GoogleServiceAccount {
  type?: string;
  project_id?: string;
  private_key_id?: string;
  private_key: string;
  client_email: string;
  client_id?: string;
  auth_uri?: string;
  token_uri?: string;
}

export interface GoogleDriveConfig {
  serviceAccount?: GoogleServiceAccount;
  folderId?: string;
  enabled: boolean;
}

export interface TelegramConfig {
  botToken?: string;
  chatId?: string;
  enabled: boolean;
}

export interface StorageUploadParams {
  localFilePath: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  username: string;
  eventType: 'post' | 'story' | 'live';
  title?: string;
  sourceUrl?: string;
}

export interface UploadProviderResult {
  provider: 'google_drive' | 'telegram' | 'local';
  success: boolean;
  fileId?: string;
  webViewLink?: string;
  webContentLink?: string;
  telegramMessageId?: number;
  telegramLink?: string;
  error?: string;
}

export interface UnifiedUploadResult {
  fileName: string;
  localPath: string;
  results: UploadProviderResult[];
  driveLink?: string;
  telegramLink?: string;
}

export interface StorageStatus {
  googleDrive: {
    enabled: boolean;
    configured: boolean;
    clientEmail?: string;
    folderId?: string;
    lastError?: string | null;
  };
  telegram: {
    enabled: boolean;
    configured: boolean;
    chatId?: string;
    lastError?: string | null;
  };
  localStorageRoot: string;
}
