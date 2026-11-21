import fs from 'node:fs';
import path from 'node:path';
import { fetchWithTimeout, safeJsonParse } from './liveCheckers/httpClient';
import type { LivePlatform } from './liveCheckers/types';
import type { WatcherEvent, WatcherEventType } from './watchers/types';
import { createStorageManager, StorageManager, type UnifiedUploadResult } from './storage/index';

export interface DownloadedFileItem {
  path: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  sourceUrl: string;
  driveLink?: string;
  telegramLink?: string;
}

export interface DownloadedMediaResult {
  success: boolean;
  platform?: LivePlatform;
  itemId: string;
  username: string;
  eventType: WatcherEventType;
  title: string;
  storageDir: string;
  files: DownloadedFileItem[];
  error?: string;
  downloadedAt: string;
  cloudUploads?: UnifiedUploadResult[];
}

export interface MediaDownloaderOptions {
  storageRoot?: string;
  timeoutMs?: number;
  storageManager?: StorageManager;
}

export interface DownloadFileOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  referer?: string;
  cookie?: string;
}

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export function getDefaultRefererForPlatform(platform?: LivePlatform | string): string {
  switch (String(platform || 'TIKTOK').toUpperCase()) {
    case 'INSTAGRAM':
      return 'https://www.instagram.com/';
    case 'FACEBOOK':
      return 'https://www.facebook.com/';
    case 'X':
      return 'https://x.com/';
    case 'TIKTOK':
    default:
      return 'https://www.tiktok.com/';
  }
}

export function mergeDownloadHeaders(opts?: DownloadFileOptions): Record<string, string> {
  const map = new Map<string, { key: string; value: string }>();

  const setHeader = (key: string, value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    map.set(key.toLowerCase(), { key, value: trimmed });
  };

  setHeader('User-Agent', DEFAULT_USER_AGENT);
  const referer = opts?.referer !== undefined ? opts.referer : 'https://www.tiktok.com/';
  if (referer.trim()) {
    setHeader('Referer', referer);
  }

  if (opts?.headers && typeof opts.headers === 'object') {
    for (const [k, v] of Object.entries(opts.headers)) {
      if (typeof v === 'string' && v.trim()) {
        setHeader(k, v);
      }
    }
  }

  if (typeof opts?.cookie === 'string' && opts.cookie.trim()) {
    setHeader('Cookie', opts.cookie);
  }

  const out: Record<string, string> = {};
  for (const { key, value } of map.values()) {
    out[key] = value;
  }
  return out;
}

/**
 * Resolves the Google Drive storage directory according to user specification:
 * 1. process.env.DRIVE_MEDIA_DIR or GOOGLE_DRIVE_PATH
 * 2. Local Google Drive Desktop path if present on Windows
 * 3. Fallback: <workspace>/data/downloaded_media
 */
export function resolveDriveStorageRoot(customRoot?: string): string {
  if (customRoot && customRoot.trim()) {
    return path.resolve(customRoot.trim());
  }

  const envPath = process.env.DRIVE_MEDIA_DIR || process.env.GOOGLE_DRIVE_PATH;
  if (envPath && envPath.trim()) {
    return path.resolve(envPath.trim());
  }

  try {
    for (const letter of ['H', 'G', 'I', 'F', 'D']) {
      const driveBase = `${letter}:\\My Drive`;
      if (fs.existsSync(driveBase)) {
        const driveMedia = path.join(driveBase, 'PulseRadar_Media');
        if (!fs.existsSync(driveMedia)) {
          fs.mkdirSync(driveMedia, { recursive: true });
        }
        return driveMedia;
      }
    }
  } catch {
    // Ignore error if drive is not mounted (e.g. on Linux/Render)
  }

  const fallbackPath = path.resolve(process.cwd(), 'data', 'downloaded_media');
  if (!fs.existsSync(fallbackPath)) {
    fs.mkdirSync(fallbackPath, { recursive: true });
  }
  return fallbackPath;
}

/**
 * Generates hierarchical target directory for user and event type:
 * <Drive_Folder>/<username>/<posts|stories>/
 */
export function resolveTargetDir(
  storageRoot: string,
  username: string,
  eventType: WatcherEventType
): string {
  const cleanUsername = username.replace(/[^a-zA-Z0-9_.-]/g, '_').toLowerCase();
  const subFolder = eventType === 'story' ? 'stories' : 'posts';
  const targetDir = path.join(storageRoot, cleanUsername, subFolder);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  return targetDir;
}

function sanitizeFileName(input: string): string {
  return input.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function inferImageExtension(mediaUrl: string): 'jpg' | 'png' | 'webp' {
  try {
    const pathname = new URL(mediaUrl).pathname.toLowerCase();
    if (pathname.endsWith('.png')) return 'png';
    if (pathname.endsWith('.webp')) return 'webp';
  } catch {
    // ignore malformed URL
  }
  return 'jpg';
}

function mimeForImageExt(ext: 'jpg' | 'png' | 'webp'): string {
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  return 'image/jpeg';
}

/**
 * Downloads a single media stream into the destination path atomically.
 */
export async function downloadFileAtomic(
  mediaUrl: string,
  destPath: string,
  options?: number | DownloadFileOptions
): Promise<{ fileSize: number; mimeType: string }> {
  const opts: DownloadFileOptions =
    typeof options === 'number' ? { timeoutMs: options } : options || {};
  const timeoutMs =
    typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs)
      ? opts.timeoutMs
      : 30000;

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tempPath = `${destPath}.tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    const headers = mergeDownloadHeaders(opts);
    const resp = await fetch(mediaUrl, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!resp.ok) {
      throw new Error(`Media download failed with HTTP ${resp.status}: ${resp.statusText}`);
    }

    const contentType = resp.headers.get('content-type') || 'application/octet-stream';
    const buffer = Buffer.from(await resp.arrayBuffer());

    if (buffer.length === 0) {
      throw new Error('Downloaded file is empty (0 bytes)');
    }

    fs.writeFileSync(tempPath, buffer);
    fs.renameSync(tempPath, destPath);

    return {
      fileSize: buffer.length,
      mimeType: contentType,
    };
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {
      // Ignore cleanup error
    }
    throw err;
  }
}

interface ResolvedCandidate {
  url: string;
  ext: 'mp4' | 'jpg' | 'png' | 'webp';
  mimeType: string;
  isHighQuality: boolean;
}

/**
 * Extracts candidate high quality media URLs from event metadata or TikWM public resolver (TikTok only).
 */
export async function resolveHighQualityMedia(
  event: WatcherEvent,
  timeoutMs = 10000
): Promise<ResolvedCandidate[]> {
  const candidates: ResolvedCandidate[] = [];
  const seenUrls = new Set<string>();
  const platform = (event.platform || 'TIKTOK').toUpperCase();

  const pushVideo = (url: string) => {
    const trimmed = url.trim();
    if (!trimmed || seenUrls.has(trimmed)) return;
    seenUrls.add(trimmed);
    candidates.push({
      url: trimmed,
      ext: 'mp4',
      mimeType: 'video/mp4',
      isHighQuality: true,
    });
  };

  const pushPhoto = (url: string) => {
    const trimmed = url.trim();
    if (!trimmed || seenUrls.has(trimmed)) return;
    seenUrls.add(trimmed);
    const ext = inferImageExtension(trimmed);
    candidates.push({
      url: trimmed,
      ext,
      mimeType: mimeForImageExt(ext),
      isHighQuality: true,
    });
  };

  const meta = event.metadata || {};

  if (Array.isArray(meta.videoUrls) && meta.videoUrls.length > 0) {
    for (const vUrl of meta.videoUrls) {
      if (typeof vUrl === 'string' && vUrl.trim()) {
        pushVideo(vUrl);
      }
    }
  } else if (typeof meta.videoUrl === 'string' && meta.videoUrl.trim()) {
    pushVideo(meta.videoUrl);
  } else if (typeof meta.playAddr === 'string' && meta.playAddr.trim()) {
    pushVideo(meta.playAddr);
  }

  if (Array.isArray(meta.photoUrls) && meta.photoUrls.length > 0) {
    for (const pUrl of meta.photoUrls) {
      if (typeof pUrl === 'string' && pUrl.trim()) {
        pushPhoto(pUrl);
      }
    }
  }

  if (candidates.length > 0) {
    return candidates;
  }

  // Fallback to TikWM high quality watermark-free API resolver ONLY for TikTok
  if (platform === 'TIKTOK') {
    const postUrl =
      event.url || `https://www.tiktok.com/@${event.username}/video/${event.itemId}`;
    try {
      const resolverUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(postUrl)}`;
      const resp = await fetchWithTimeout(resolverUrl, {
        timeoutMs,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          Accept: 'application/json',
        },
      });

      if (resp.ok && resp.text) {
        const parsed = safeJsonParse<{
          code?: number;
          data?: {
            play?: string;
            hdplay?: string;
            wmplay?: string;
            images?: string[];
          };
        }>(resp.text);

        if (parsed?.code === 0 && parsed.data) {
          const bestPlay = parsed.data.hdplay || parsed.data.play || parsed.data.wmplay;
          if (bestPlay) {
            pushVideo(bestPlay.startsWith('http') ? bestPlay : `https://www.tikwm.com${bestPlay}`);
          }

          if (Array.isArray(parsed.data.images) && parsed.data.images.length > 0) {
            for (const imgUrl of parsed.data.images) {
              pushPhoto(
                imgUrl.startsWith('http') ? imgUrl : `https://www.tikwm.com${imgUrl}`
              );
            }
          }
        }
      }
    } catch {
      // Non-fatal, fallback to streamUrl or thumbnailUrl
    }
  }

  // Final fallback: streamUrl or thumbnailUrl
  if (candidates.length === 0) {
    if (event.streamUrl && event.streamUrl.trim()) {
      candidates.push({
        url: event.streamUrl.trim(),
        ext: 'mp4',
        mimeType: 'video/mp4',
        isHighQuality: false,
      });
    } else if (event.thumbnailUrl && event.thumbnailUrl.trim()) {
      const thumbUrl = event.thumbnailUrl.trim();
      const ext = inferImageExtension(thumbUrl);
      candidates.push({
        url: thumbUrl,
        ext,
        mimeType: mimeForImageExt(ext),
        isHighQuality: false,
      });
    }
  }

  return candidates;
}

export class MediaDownloader {
  private storageRoot: string;
  private timeoutMs: number;
  private storageManager: StorageManager;

  constructor(options?: MediaDownloaderOptions) {
    this.storageRoot = resolveDriveStorageRoot(options?.storageRoot);
    this.timeoutMs = options?.timeoutMs ?? 30000;
    this.storageManager =
      options?.storageManager ||
      createStorageManager({ localStorageRoot: this.storageRoot });
  }

  getStorageRoot(): string {
    return this.storageRoot;
  }

  getStorageManager(): StorageManager {
    return this.storageManager;
  }

  /**
   * Automatically downloads all media associated with a post or story event
   * into <Drive_Folder>/<username>/<posts|stories>/<[platform_]timestamp_id>.<ext>
   * and dispatches to configured cloud storage providers (Google Drive API / Telegram).
   */
  async downloadEventMedia(event: WatcherEvent): Promise<DownloadedMediaResult> {
    const platform = ((event.platform || 'TIKTOK').toUpperCase() as LivePlatform);
    const downloadedAt = new Date().toISOString();
    const datePrefix = downloadedAt.slice(0, 10).replace(/-/g, '');
    const cleanId = sanitizeFileName(event.itemId || 'unknown');
    const targetDir = resolveTargetDir(this.storageRoot, event.username, event.eventType);

    const result: DownloadedMediaResult = {
      success: false,
      platform,
      itemId: event.itemId,
      username: event.username,
      eventType: event.eventType,
      title: event.title || `${event.eventType} by @${event.username}`,
      storageDir: targetDir,
      files: [],
      cloudUploads: [],
      downloadedAt,
    };

    try {
      const candidates = await resolveHighQualityMedia(event, 10000);
      if (candidates.length === 0) {
        result.error = 'No valid media stream or image URL could be resolved';
        return result;
      }

      const rawDlHeaders = event.metadata?.downloadHeaders;
      const downloadHeaders: Record<string, string> = {};
      if (rawDlHeaders && typeof rawDlHeaders === 'object' && !Array.isArray(rawDlHeaders)) {
        for (const [k, v] of Object.entries(rawDlHeaders)) {
          if (typeof v === 'string' && v.trim()) {
            downloadHeaders[k] = v.trim();
          }
        }
      }

      const platformPrefix = platform !== 'TIKTOK' ? `${platform.toLowerCase()}_` : '';

      for (let idx = 0; idx < candidates.length; idx++) {
        const candidate = candidates[idx];
        const suffix = candidates.length > 1 ? `_${idx + 1}` : '';
        const fileName = `${platformPrefix}${datePrefix}_${cleanId}${suffix}.${candidate.ext}`;
        const destPath = path.join(targetDir, fileName);
        let fileSize = 0;

        if (fs.existsSync(destPath)) {
          const stats = fs.statSync(destPath);
          if (stats.size > 0) {
            fileSize = stats.size;
          }
        }

        if (fileSize === 0) {
          const downloaded = await downloadFileAtomic(candidate.url, destPath, {
            timeoutMs: this.timeoutMs,
            referer: getDefaultRefererForPlatform(platform),
            headers: downloadHeaders,
          });
          fileSize = downloaded.fileSize;
        }

        let driveLink: string | undefined;
        let telegramLink: string | undefined;

        try {
          const cloudResult = await this.storageManager.uploadMedia({
            platform,
            localFilePath: destPath,
            fileName,
            fileSize,
            mimeType: candidate.mimeType,
            username: event.username,
            eventType: event.eventType,
            title: event.title,
            sourceUrl: candidate.url,
          });

          driveLink = cloudResult.driveLink;
          telegramLink = cloudResult.telegramLink;
          if (Array.isArray(result.cloudUploads)) {
            result.cloudUploads.push(cloudResult);
          }
        } catch (uploadErr) {
          console.warn(
            `[MediaDownloader] Cloud upload warning for ${fileName}:`,
            uploadErr instanceof Error ? uploadErr.message : String(uploadErr)
          );
        }

        result.files.push({
          path: destPath,
          fileName,
          fileSize,
          mimeType: candidate.mimeType,
          sourceUrl: candidate.url,
          driveLink,
          telegramLink,
        });
      }

      result.success = result.files.length > 0;
      return result;
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      result.success = result.files.length > 0;
      return result;
    }
  }
}

export function createMediaDownloader(options?: MediaDownloaderOptions): MediaDownloader {
  return new MediaDownloader(options);
}
