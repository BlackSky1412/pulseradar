import fs from 'node:fs';
import path from 'node:path';
import { fetchWithTimeout, safeJsonParse } from './liveCheckers/httpClient';
import type { TikTokEvent, WatcherEventType } from './watchers/types';

export interface DownloadedFileItem {
  path: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  sourceUrl: string;
}

export interface DownloadedMediaResult {
  success: boolean;
  itemId: string;
  username: string;
  eventType: WatcherEventType;
  title: string;
  storageDir: string;
  files: DownloadedFileItem[];
  error?: string;
  downloadedAt: string;
}

export interface MediaDownloaderOptions {
  storageRoot?: string;
  timeoutMs?: number;
}

/**
 * Resolves the Google Drive storage directory according to user specification:
 * 1. process.env.DRIVE_MEDIA_DIR or GOOGLE_DRIVE_PATH
 * 2. Local Google Drive Desktop path if present on Windows: G:\My Drive\PulseRadar_StreamRecorder_Package\Downloaded_Media
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

  const defaultDrivePath = 'G:\\My Drive\\PulseRadar_StreamRecorder_Package\\Downloaded_Media';
  try {
    const driveBase = 'G:\\My Drive\\PulseRadar_StreamRecorder_Package';
    if (fs.existsSync(driveBase)) {
      if (!fs.existsSync(defaultDrivePath)) {
        fs.mkdirSync(defaultDrivePath, { recursive: true });
      }
      return defaultDrivePath;
    }
  } catch {
    // Ignore error if G: drive is not mounted (e.g. on Linux/Render)
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

/**
 * Downloads a single media stream into the destination path atomically.
 */
export async function downloadFileAtomic(
  mediaUrl: string,
  destPath: string,
  timeoutMs = 30000
): Promise<{ fileSize: number; mimeType: string }> {
  const tempPath = `${destPath}.tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    const resp = await fetch(mediaUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Referer: 'https://www.tiktok.com/',
      },
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
 * Extracts candidate high quality media URLs from event metadata or TikWM public resolver.
 */
export async function resolveHighQualityMedia(
  event: TikTokEvent,
  timeoutMs = 10000
): Promise<ResolvedCandidate[]> {
  const candidates: ResolvedCandidate[] = [];

  // Check metadata for direct playAddr or videoUrl
  const meta = event.metadata || {};
  if (typeof meta.videoUrl === 'string' && meta.videoUrl.trim()) {
    candidates.push({
      url: meta.videoUrl.trim(),
      ext: 'mp4',
      mimeType: 'video/mp4',
      isHighQuality: true,
    });
  } else if (typeof meta.playAddr === 'string' && meta.playAddr.trim()) {
    candidates.push({
      url: meta.playAddr.trim(),
      ext: 'mp4',
      mimeType: 'video/mp4',
      isHighQuality: true,
    });
  }

  // Check metadata for photo array
  if (Array.isArray(meta.photoUrls) && meta.photoUrls.length > 0) {
    for (const pUrl of meta.photoUrls) {
      if (typeof pUrl === 'string' && pUrl.trim()) {
        candidates.push({
          url: pUrl.trim(),
          ext: 'jpg',
          mimeType: 'image/jpeg',
          isHighQuality: true,
        });
      }
    }
  }

  // If already resolved from metadata, return candidates
  if (candidates.length > 0) {
    return candidates;
  }

  // Fallback to TikWM high quality watermark-free API resolver for post/story URLs
  const postUrl = event.url || `https://www.tiktok.com/@${event.username}/video/${event.itemId}`;
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
        // High-definition watermark-free video
        const bestPlay = parsed.data.hdplay || parsed.data.play || parsed.data.wmplay;
        if (bestPlay) {
          candidates.push({
            url: bestPlay.startsWith('http') ? bestPlay : `https://www.tikwm.com${bestPlay}`,
            ext: 'mp4',
            mimeType: 'video/mp4',
            isHighQuality: true,
          });
        }

        // Multi-image post
        if (Array.isArray(parsed.data.images) && parsed.data.images.length > 0) {
          for (const imgUrl of parsed.data.images) {
            candidates.push({
              url: imgUrl.startsWith('http') ? imgUrl : `https://www.tikwm.com${imgUrl}`,
              ext: 'jpg',
              mimeType: 'image/jpeg',
              isHighQuality: true,
            });
          }
        }
      }
    }
  } catch (err) {
    // Non-fatal, fallback to streamUrl or coverUrl
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
      candidates.push({
        url: event.thumbnailUrl.trim(),
        ext: 'jpg',
        mimeType: 'image/jpeg',
        isHighQuality: false,
      });
    }
  }

  return candidates;
}

export class MediaDownloader {
  private storageRoot: string;
  private timeoutMs: number;

  constructor(options?: MediaDownloaderOptions) {
    this.storageRoot = resolveDriveStorageRoot(options?.storageRoot);
    this.timeoutMs = options?.timeoutMs ?? 30000;
  }

  getStorageRoot(): string {
    return this.storageRoot;
  }

  /**
   * Automatically downloads all media associated with a post or story event
   * into <Drive_Folder>/<username>/<posts|stories>/<timestamp>_<id>.<ext>
   */
  async downloadEventMedia(event: TikTokEvent): Promise<DownloadedMediaResult> {
    const downloadedAt = new Date().toISOString();
    const datePrefix = downloadedAt.slice(0, 10).replace(/-/g, '');
    const cleanId = sanitizeFileName(event.itemId || 'unknown');
    const targetDir = resolveTargetDir(this.storageRoot, event.username, event.eventType);

    const result: DownloadedMediaResult = {
      success: false,
      itemId: event.itemId,
      username: event.username,
      eventType: event.eventType,
      title: event.title || `${event.eventType} by @${event.username}`,
      storageDir: targetDir,
      files: [],
      downloadedAt,
    };

    try {
      const candidates = await resolveHighQualityMedia(event, 10000);
      if (candidates.length === 0) {
        result.error = 'No valid media stream or image URL could be resolved';
        return result;
      }

      for (let idx = 0; idx < candidates.length; idx++) {
        const candidate = candidates[idx];
        const suffix = candidates.length > 1 ? `_${idx + 1}` : '';
        const fileName = `${datePrefix}_${cleanId}${suffix}.${candidate.ext}`;
        const destPath = path.join(targetDir, fileName);

        // If file already exists and is non-empty, avoid redundant download
        if (fs.existsSync(destPath)) {
          const stats = fs.statSync(destPath);
          if (stats.size > 0) {
            result.files.push({
              path: destPath,
              fileName,
              fileSize: stats.size,
              mimeType: candidate.mimeType,
              sourceUrl: candidate.url,
            });
            continue;
          }
        }

        const downloaded = await downloadFileAtomic(candidate.url, destPath, this.timeoutMs);
        result.files.push({
          path: destPath,
          fileName,
          fileSize: downloaded.fileSize,
          mimeType: downloaded.mimeType,
          sourceUrl: candidate.url,
        });
      }

      result.success = result.files.length > 0;
      return result;
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      result.success = result.files.length > 0; // partial success if some files downloaded
      return result;
    }
  }
}

export function createMediaDownloader(options?: MediaDownloaderOptions): MediaDownloader {
  return new MediaDownloader(options);
}

