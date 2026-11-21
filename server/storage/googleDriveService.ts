import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  GoogleDriveConfig,
  GoogleServiceAccount,
  StorageUploadParams,
  UploadProviderResult,
} from './types';

export class GoogleDriveService {
  private config: GoogleDriveConfig;
  private cachedToken: { token: string; expiresAtMs: number } | null = null;
  private folderCache: Map<string, string> = new Map();
  private lastError: string | null = null;

  constructor(config?: Partial<GoogleDriveConfig>) {
    this.config = {
      enabled: config?.enabled ?? true,
      folderId: config?.folderId ?? process.env.GDRIVE_FOLDER_ID?.trim(),
      serviceAccount: config?.serviceAccount ?? this.resolveServiceAccount(),
    };
  }

  /**
   * Resolves Google Service Account from env vars or credentials file
   */
  private resolveServiceAccount(): GoogleServiceAccount | undefined {
    const rawKey =
      process.env.GDRIVE_SERVICE_ACCOUNT_KEY ||
      process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

    if (rawKey && rawKey.trim()) {
      try {
        let jsonStr = rawKey.trim();
        // Check if base64 encoded
        if (!jsonStr.startsWith('{') && jsonStr.length > 50) {
          try {
            jsonStr = Buffer.from(jsonStr, 'base64').toString('utf-8');
          } catch {
            // keep raw
          }
        }
        const parsed = JSON.parse(jsonStr) as GoogleServiceAccount;
        if (parsed.client_email && parsed.private_key) {
          return parsed;
        }
      } catch (err) {
        this.lastError = `Failed to parse Service Account JSON: ${err instanceof Error ? err.message : String(err)}`;
        return undefined;
      }
    }

    const filePath =
      process.env.GDRIVE_SERVICE_ACCOUNT_PATH ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS;

    if (filePath && filePath.trim()) {
      try {
        const resolved = path.resolve(filePath.trim());
        if (fs.existsSync(resolved)) {
          const content = fs.readFileSync(resolved, 'utf-8');
          const parsed = JSON.parse(content) as GoogleServiceAccount;
          if (parsed.client_email && parsed.private_key) {
            return parsed;
          }
        }
      } catch (err) {
        this.lastError = `Failed to read Service Account file: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    return undefined;
  }

  isConfigured(): boolean {
    return Boolean(
      this.config.serviceAccount?.client_email &&
      this.config.serviceAccount?.private_key
    );
  }

  getStatus() {
    return {
      enabled: this.config.enabled && this.isConfigured(),
      configured: this.isConfigured(),
      clientEmail: this.config.serviceAccount?.client_email,
      folderId: this.config.folderId,
      lastError: this.lastError,
    };
  }

  /**
   * Generates a signed OAuth2 JWT for Google Drive API
   */
  private createSignedJwt(): string {
    const sa = this.config.serviceAccount;
    if (!sa || !sa.client_email || !sa.private_key) {
      throw new Error('Google Service Account credentials missing');
    }

    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const claim = {
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/drive',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    };

    const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
    const encodedClaim = Buffer.from(JSON.stringify(claim)).toString('base64url');
    const signatureInput = `${encodedHeader}.${encodedClaim}`;

    const signer = crypto.createSign('RSA-SHA256');
    signer.update(signatureInput);
    const signature = signer.sign(sa.private_key, 'base64url');

    return `${signatureInput}.${signature}`;
  }

  /**
   * Exchanges JWT for Google OAuth2 Access Token (cached for 55 mins)
   */
  async getAccessToken(): Promise<string> {
    const nowMs = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAtMs > nowMs + 300_000) {
      return this.cachedToken.token;
    }

    const jwt = this.createSignedJwt();
    const tokenUrl = this.config.serviceAccount?.token_uri || 'https://oauth2.googleapis.com/token';

    const resp = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
    });

    const data = await resp.json() as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!resp.ok || !data.access_token) {
      const msg = data.error_description || data.error || resp.statusText;
      this.lastError = `OAuth Token exchange failed: ${msg}`;
      throw new Error(this.lastError);
    }

    const expiresInSec = typeof data.expires_in === 'number' ? data.expires_in : 3600;
    this.cachedToken = {
      token: data.access_token,
      expiresAtMs: nowMs + expiresInSec * 1000,
    };
    this.lastError = null;
    return this.cachedToken.token;
  }

  /**
   * Finds or creates a subfolder in Google Drive under parentFolderId
   */
  async ensureFolder(folderName: string, parentFolderId?: string): Promise<string> {
    const cacheKey = `${parentFolderId || 'root'}::${folderName}`;
    if (this.folderCache.has(cacheKey)) {
      return this.folderCache.get(cacheKey)!;
    }

    const token = await this.getAccessToken();

    // Query existing folder
    let q = `name = '${folderName.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    if (parentFolderId) {
      q += ` and '${parentFolderId}' in parents`;
    }

    const searchUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=files(id,name)`;
    const searchResp = await fetch(searchUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (searchResp.ok) {
      const searchData = await searchResp.json() as { files?: Array<{ id: string; name: string }> };
      if (Array.isArray(searchData.files) && searchData.files.length > 0) {
        const foundId = searchData.files[0].id;
        this.folderCache.set(cacheKey, foundId);
        return foundId;
      }
    }

    // Create new folder
    const createBody: { name: string; mimeType: string; parents?: string[] } = {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
    };
    if (parentFolderId) {
      createBody.parents = [parentFolderId];
    }

    const createResp = await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id,name', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(createBody),
    });

    if (!createResp.ok) {
      const errText = await createResp.text();
      throw new Error(`Failed to create Google Drive folder '${folderName}': ${errText}`);
    }

    const createData = await createResp.json() as { id: string };
    this.folderCache.set(cacheKey, createData.id);
    return createData.id;
  }

  /**
   * Resolves the target folder hierarchy: <Root_Folder>/<username>/<posts|stories>/
   */
  async resolveTargetFolderId(username: string, eventType: 'post' | 'story' | 'live'): Promise<string | undefined> {
    let currentParent = this.config.folderId;
    if (!currentParent) {
      // Use or create a default root folder "PulseRadar_Downloaded_Media"
      currentParent = await this.ensureFolder('PulseRadar_Downloaded_Media');
    }

    const cleanUsername = username.replace(/[^a-zA-Z0-9_.-]/g, '_').toLowerCase();
    const userFolderId = await this.ensureFolder(cleanUsername, currentParent);

    const subFolderName = eventType === 'story' ? 'stories' : eventType === 'live' ? 'recordings' : 'posts';
    return await this.ensureFolder(subFolderName, userFolderId);
  }

  /**
   * Uploads file to Google Drive using multipart upload
   */
  async uploadFile(params: StorageUploadParams): Promise<UploadProviderResult> {
    if (!this.isConfigured()) {
      return {
        provider: 'google_drive',
        success: false,
        error: 'Google Drive Service Account not configured',
      };
    }

    try {
      if (!fs.existsSync(params.localFilePath)) {
        return {
          provider: 'google_drive',
          success: false,
          error: `Local file not found: ${params.localFilePath}`,
        };
      }

      const fileBuffer = fs.readFileSync(params.localFilePath);
      const targetFolderId = await this.resolveTargetFolderId(params.username, params.eventType);
      const token = await this.getAccessToken();

      const metadata: { name: string; parents?: string[]; description?: string } = {
        name: params.fileName,
        description: `${params.title || params.fileName} | @${params.username} | Source: ${params.sourceUrl || 'PulseRadar'}`,
      };
      if (targetFolderId) {
        metadata.parents = [targetFolderId];
      }

      const boundary = `-------PulseRadarGdriveBoundary${Date.now()}`;
      const delimiter = `\r\n--${boundary}\r\n`;
      const closeDelimiter = `\r\n--${boundary}--`;

      const metadataPayload =
        delimiter +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        JSON.stringify(metadata) +
        delimiter +
        `Content-Type: ${params.mimeType || 'application/octet-stream'}\r\n\r\n`;

      const multipartBody = Buffer.concat([
        Buffer.from(metadataPayload, 'utf-8'),
        fileBuffer,
        Buffer.from(closeDelimiter, 'utf-8'),
      ]);

      const uploadUrl =
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,mimeType,webViewLink,webContentLink,size';

      const uploadResp = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
          'Content-Length': String(multipartBody.length),
        },
        body: multipartBody,
      });

      if (!uploadResp.ok) {
        const errText = await uploadResp.text();
        this.lastError = `Google Drive upload failed (${uploadResp.status}): ${errText}`;
        return {
          provider: 'google_drive',
          success: false,
          error: this.lastError,
        };
      }

      const data = await uploadResp.json() as {
        id: string;
        name: string;
        webViewLink?: string;
        webContentLink?: string;
      };

      const webViewLink = data.webViewLink || `https://drive.google.com/file/d/${data.id}/view`;

      return {
        provider: 'google_drive',
        success: true,
        fileId: data.id,
        webViewLink,
        webContentLink: data.webContentLink,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.lastError = errorMsg;
      return {
        provider: 'google_drive',
        success: false,
        error: errorMsg,
      };
    }
  }
}

export function createGoogleDriveService(config?: Partial<GoogleDriveConfig>): GoogleDriveService {
  return new GoogleDriveService(config);
}
