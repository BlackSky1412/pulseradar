import React from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  Edit3,
  ExternalLink,
  Flame,
  Radio,
  RefreshCw,
  X,
} from 'lucide-react';
import { UserAvatar } from './UserAvatar';
import { InfoPopover } from './InfoPopover';
import {
  type KeywordRuleItem,
  type LiveTargetScanStatus,
  type SocialPlatformKey,
  type TargetStreamMeta,
  PLATFORM_BRAND_NAMES,
  formatTimestamp,
  isLiveUserTarget,
  resolvePlatformProfileUrl,
} from '../utils/scannerEngine';

export interface WatchlistTargetEntry {
  rule: KeywordRuleItem;
  target: string;
}

export interface WatchlistSectionProps {
  selectedPlatform: SocialPlatformKey;
  targets: WatchlistTargetEntry[];
  liveStatusMap: Record<string, LiveTargetScanStatus>;
  targetStreamMetaMap: Record<string, TargetStreamMeta>;
  hasPlatformCookie: boolean;
  isScanning: boolean;
  scanningTargetKey: string | null;
  copiedStreamKey: string | null;
  onToggleStream: (targetKey: string, stream: 'live' | 'post' | 'story') => void;
  onScanTarget: (rule: KeywordRuleItem, target: string) => void;
  onCopyStreamUrl: (targetKey: string, streamUrl: string) => void;
  onEditRule: (rule: KeywordRuleItem) => void;
  onRemoveTarget: (rule: KeywordRuleItem, target: string) => void;
}

const DEFAULT_STREAM_META: TargetStreamMeta = {
  live: true,
  post: true,
  story: true,
  warmup: true,
};

export function WatchlistSection({
  selectedPlatform,
  targets,
  liveStatusMap,
  targetStreamMetaMap,
  hasPlatformCookie,
  isScanning,
  scanningTargetKey,
  copiedStreamKey,
  onToggleStream,
  onScanTarget,
  onCopyStreamUrl,
  onEditRule,
  onRemoveTarget,
}: WatchlistSectionProps) {
  if (targets.length === 0) {
    return (
      <div className="p-8 text-center border border-dashed border-slate-800 rounded-2xl bg-slate-950/40 space-y-2">
        <p className="text-sm font-semibold text-slate-300">
          Chưa có kênh nào trong tab {PLATFORM_BRAND_NAMES[selectedPlatform]}
        </p>
        <p className="text-xs text-slate-500 max-w-md mx-auto">
          Nhập <span className="font-mono text-slate-400">@username</span> hoặc dán URL kênh ở ô trên rồi nhấn{' '}
          <strong className="text-slate-300">Thêm kênh</strong> để bắt đầu tự động theo dõi Live, Post và Story.
        </p>
      </div>
    );
  }

  return (
    <>
      {/* Mobile Vertical Cards (< md) */}
      <div data-testid="watchlist-mobile-cards" className="md:hidden space-y-3">
        {targets.map(({ rule, target }) => {
          const targetKey = `${rule.id}::${target}`;
          const liveInfo = liveStatusMap[targetKey];
          const isLiveUser = isLiveUserTarget(target);
          const isRowScanning = scanningTargetKey === targetKey;
          const meta = targetStreamMetaMap[targetKey] || DEFAULT_STREAM_META;
          const targetKindLabel = target.startsWith('http')
            ? 'URL'
            : isLiveUser
            ? '@USER'
            : 'TỪ KHÓA';

          return (
            <article
              key={`mobile_${targetKey}`}
              className="rounded-2xl border border-slate-800/90 bg-slate-950/75 p-4 space-y-3"
            >
              {/* Header row */}
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3 min-w-0 flex-1">
                  <UserAvatar
                    target={target}
                    platform={selectedPlatform}
                    isLive={liveInfo?.status === 'LIVE'}
                    size="md"
                  />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-mono font-bold text-slate-100 text-sm break-all leading-snug">
                        {target}
                      </span>
                      <a
                        href={resolvePlatformProfileUrl(target, selectedPlatform)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center justify-center p-1 rounded-md text-slate-400 hover:text-cyan-300 hover:bg-slate-800 transition-colors"
                        title={`Mở trang ${PLATFORM_BRAND_NAMES[selectedPlatform]} của ${target}`}
                        aria-label={`Mở trang ${PLATFORM_BRAND_NAMES[selectedPlatform]} của ${target}`}
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-mono border shrink-0 ${
                          isLiveUser
                            ? 'bg-indigo-950/70 border-indigo-800/70 text-indigo-300'
                            : 'bg-slate-900 border-slate-700 text-slate-400'
                        }`}
                      >
                        {targetKindLabel}
                      </span>
                      {meta.warmup && (
                        <InfoPopover
                          placement="inline"
                          ariaLabel={`Giải thích trạng thái Warmup của ${target}`}
                          title="Khởi tạo êm (Warmup)"
                          triggerClassName="min-h-[44px] px-2.5 py-1 rounded-lg text-[11px] font-mono bg-emerald-950/70 border border-emerald-800/70 text-emerald-300 font-semibold hover:bg-emerald-900/60"
                          trigger={
                            <>
                              <Flame className="w-3 h-3 shrink-0" />
                              <span>Warmup</span>
                            </>
                          }
                        >
                          Khởi tạo êm: đã nạp baseline ID vào bộ nhớ để tránh gửi trùng bài hoặc story cũ.
                        </InfoPopover>
                      )}
                    </div>
                  </div>
                </div>

                <div className="shrink-0">
                  {liveInfo?.status === 'LIVE' ? (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-mono font-bold rounded-full bg-rose-500/20 border border-rose-500/50 text-rose-300">
                      <span className="w-1.5 h-1.5 rounded-full bg-rose-400 animate-ping" />
                      ĐANG LIVE
                    </span>
                  ) : liveInfo?.status === 'NOT_LIVE' ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-mono rounded-full bg-slate-900 border border-slate-700 text-slate-400">
                      Offline · {formatTimestamp(liveInfo.checkedAt)}
                    </span>
                  ) : liveInfo?.status === 'ERROR' ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-mono rounded-full bg-amber-950/70 border border-amber-700/60 text-amber-300">
                      <AlertTriangle className="w-3 h-3" />
                      Lỗi quét
                    </span>
                  ) : (
                    <span className="text-[11px] font-mono text-slate-500">Chưa quét</span>
                  )}
                </div>
              </div>

              {/* Stream title / quality / error (untruncated) */}
              {(liveInfo?.title || liveInfo?.qualityInfo || (liveInfo?.status === 'ERROR' && liveInfo?.error)) && (
                <div className="rounded-xl bg-slate-900/70 border border-slate-800/80 px-3 py-2 space-y-1">
                  {liveInfo.title && (
                    <p className="text-xs text-slate-200 break-words leading-relaxed">
                      {liveInfo.title}
                    </p>
                  )}
                  {liveInfo.qualityInfo && (
                    <p className="text-[11px] font-mono text-slate-400 break-words">
                      {liveInfo.qualityInfo}
                    </p>
                  )}
                  {liveInfo.status === 'ERROR' && liveInfo.error && (
                    <p className="text-[11px] font-mono text-amber-300 break-words">
                      {liveInfo.error}
                    </p>
                  )}
                </div>
              )}

              {/* Explicit Stream Toggles */}
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  aria-pressed={meta.live}
                  onClick={() => onToggleStream(targetKey, 'live')}
                  className={`min-h-[44px] w-full px-2 py-1.5 rounded-xl border text-[11px] font-mono font-bold inline-flex items-center justify-center transition-colors ${
                    meta.live
                      ? 'bg-rose-500/20 border-rose-500/50 text-rose-300'
                      : 'bg-slate-900 border-slate-800 text-slate-500'
                  }`}
                >
                  <span>Live: {meta.live ? 'Bật' : 'Tắt'}</span>
                </button>
                <button
                  type="button"
                  aria-pressed={meta.post}
                  onClick={() => onToggleStream(targetKey, 'post')}
                  className={`min-h-[44px] w-full px-2 py-1.5 rounded-xl border text-[11px] font-mono font-bold inline-flex items-center justify-center transition-colors ${
                    meta.post
                      ? 'bg-blue-500/20 border-blue-500/50 text-blue-300'
                      : 'bg-slate-900 border-slate-800 text-slate-500'
                  }`}
                >
                  <span>Post: {meta.post ? 'Bật' : 'Tắt'}</span>
                </button>
                <button
                  type="button"
                  aria-pressed={meta.story}
                  onClick={() => onToggleStream(targetKey, 'story')}
                  className={`min-h-[44px] w-full px-2 py-1.5 rounded-xl border text-[11px] font-mono font-bold inline-flex items-center justify-center transition-colors ${
                    meta.story
                      ? 'bg-amber-500/20 border-amber-500/50 text-amber-300'
                      : 'bg-slate-900 border-slate-800 text-slate-500'
                  }`}
                >
                  <span>Story: {meta.story ? 'Bật' : 'Tắt'}</span>
                </button>
              </div>

              {/* Post & Story Status Summary */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] font-mono">
                <div
                  className={`px-2.5 py-1.5 rounded-lg border ${
                    meta.post
                      ? 'bg-blue-950/40 border-blue-800/40 text-blue-300'
                      : 'bg-slate-900/60 border-slate-800 text-slate-500'
                  }`}
                >
                  Post: {meta.post ? 'Khởi tạo êm (Đang theo dõi)' : 'Tắt'}
                </div>
                <div
                  className={`px-2.5 py-1.5 rounded-lg border ${
                    !meta.story
                      ? 'bg-slate-900/60 border-slate-800 text-slate-500'
                      : hasPlatformCookie
                      ? 'bg-emerald-950/40 border-emerald-800/40 text-emerald-300'
                      : 'bg-indigo-950/40 border-indigo-800/40 text-indigo-300'
                  }`}
                >
                  Story:{' '}
                  {!meta.story
                    ? 'Tắt'
                    : `${hasPlatformCookie ? 'Sẵn sàng · Cookie' : 'Sẵn sàng · Ẩn danh'} · 48h`}
                </div>
              </div>

              {/* Action Bar */}
              <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-800/80">
                {isLiveUser && (
                  <button
                    type="button"
                    disabled={isScanning}
                    onClick={() => onScanTarget(rule, target)}
                    className="min-h-[44px] flex-1 min-w-[110px] inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-rose-200 bg-rose-950/60 border border-rose-800/60 rounded-xl hover:bg-rose-900/60 disabled:opacity-50 transition-colors"
                  >
                    {isRowScanning ? (
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Radio className="w-3.5 h-3.5" />
                    )}
                    <span>Quét Live</span>
                  </button>
                )}

                {liveInfo?.status === 'LIVE' && liveInfo.streamUrl && (
                  <button
                    type="button"
                    onClick={() => onCopyStreamUrl(targetKey, liveInfo.streamUrl!)}
                    className="min-h-[44px] inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-emerald-200 bg-emerald-950/60 border border-emerald-700/60 rounded-xl hover:bg-emerald-900/60 transition-colors"
                  >
                    {copiedStreamKey === targetKey ? (
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                    <span>{copiedStreamKey === targetKey ? 'Đã chép' : 'Copy'}</span>
                  </button>
                )}

                {liveInfo?.status === 'LIVE' && liveInfo.sourceUrl && (
                  <a
                    href={liveInfo.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Mở link phòng live của ${target}`}
                    className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center text-slate-300 hover:text-white bg-slate-800/80 rounded-xl transition-colors"
                  >
                    <ExternalLink className="w-4 h-4" />
                  </a>
                )}

                <button
                  type="button"
                  onClick={() => onEditRule(rule)}
                  aria-label={`Sửa cấu hình nguồn ${target}`}
                  className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center text-slate-300 hover:text-slate-100 bg-slate-900/80 border border-slate-800 rounded-xl hover:bg-slate-800 transition-colors"
                >
                  <Edit3 className="w-4 h-4" />
                </button>

                <button
                  type="button"
                  onClick={() => onRemoveTarget(rule, target)}
                  aria-label={`Xóa ${target}`}
                  className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center text-slate-400 hover:text-rose-400 bg-slate-900/80 border border-slate-800 rounded-xl hover:bg-slate-800 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </article>
          );
        })}
      </div>

      {/* Desktop 6-Column Table (md+) */}
      <div
        data-testid="watchlist-desktop-table"
        className="hidden md:block border border-slate-800/80 rounded-2xl bg-slate-950/60 overflow-hidden"
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-950/90 text-slate-400 font-semibold">
                <th className="py-3 px-4">Kênh & Avatar (@Username / URL)</th>
                <th className="py-3 px-3">Luồng kích hoạt</th>
                <th className="py-3 px-4">Trạng thái Live</th>
                <th className="py-3 px-3">Trạng thái Post</th>
                <th className="py-3 px-3">Trạng thái Story</th>
                <th className="py-3 px-4 text-right">Hành động</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {targets.map(({ rule, target }) => {
                const targetKey = `${rule.id}::${target}`;
                const liveInfo = liveStatusMap[targetKey];
                const isLiveUser = isLiveUserTarget(target);
                const isRowScanning = scanningTargetKey === targetKey;
                const meta = targetStreamMetaMap[targetKey] || DEFAULT_STREAM_META;

                return (
                  <tr key={targetKey} className="hover:bg-slate-900/60 transition-colors">
                    {/* 1. Target Avatar, Name & Metadata */}
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-3">
                        <UserAvatar
                          target={target}
                          platform={selectedPlatform}
                          isLive={liveInfo?.status === 'LIVE'}
                          size="md"
                        />
                        <div className="min-w-0 flex flex-col justify-center">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-mono font-bold text-slate-100 truncate max-w-[200px] text-xs">
                              {target}
                            </span>
                            <a
                              href={resolvePlatformProfileUrl(target, selectedPlatform)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center justify-center p-1 rounded-md text-slate-400 hover:text-cyan-300 hover:bg-slate-800 transition-colors"
                              title={`Mở trang ${PLATFORM_BRAND_NAMES[selectedPlatform]} của ${target}`}
                              aria-label={`Mở trang ${PLATFORM_BRAND_NAMES[selectedPlatform]} của ${target}`}
                            >
                              <ExternalLink className="w-3 h-3" />
                            </a>
                            {meta.warmup && (
                              <InfoPopover
                                placement="inline"
                                ariaLabel={`Giải thích trạng thái Warmup của ${target}`}
                                title="Khởi tạo êm (Warmup)"
                                triggerClassName="min-h-[44px] md:min-h-[24px] px-2 md:px-1.5 py-0.5 rounded text-[10px] md:text-[9px] font-mono bg-emerald-950/70 border border-emerald-800/70 text-emerald-300 font-semibold shrink-0"
                                trigger={<span>Warmup</span>}
                              >
                                Khởi tạo êm: đã nạp baseline ID vào bộ nhớ.
                              </InfoPopover>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5 mt-0.5 text-[11px] text-slate-400 font-mono truncate">
                            <span
                              className={`px-1 py-0.2 rounded text-[9px] font-mono border shrink-0 ${
                                isLiveUser
                                  ? 'bg-indigo-950/70 border-indigo-800/70 text-indigo-300'
                                  : 'bg-slate-900 border-slate-700 text-slate-400'
                              }`}
                            >
                              {target.startsWith('http')
                                ? 'URL'
                                : isLiveUser
                                ? '@USER'
                                : 'TỪ KHÓA'}
                            </span>
                            {liveInfo?.title && (
                              <span className="truncate max-w-[180px] text-slate-400" title={liveInfo.title}>
                                {liveInfo.title}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </td>

                    {/* 2. Multi-stream Toggle Badges */}
                    <td className="py-3 px-3 whitespace-nowrap">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          aria-pressed={meta.live}
                          onClick={() => onToggleStream(targetKey, 'live')}
                          title={meta.live ? 'Đang bật Live: bấm để tắt' : 'Đang tắt Live: bấm để bật'}
                          className={`min-h-[44px] md:min-h-[30px] px-2.5 py-1 rounded text-[10px] font-mono font-bold border transition-colors ${
                            meta.live
                              ? 'bg-rose-500/20 border-rose-500/50 text-rose-300'
                              : 'bg-slate-900 border-slate-800 text-slate-600 line-through'
                          }`}
                        >
                          Live
                        </button>
                        <button
                          type="button"
                          aria-pressed={meta.post}
                          onClick={() => onToggleStream(targetKey, 'post')}
                          title={meta.post ? 'Đang bật Post: bấm để tắt' : 'Đang tắt Post: bấm để bật'}
                          className={`min-h-[44px] md:min-h-[30px] px-2.5 py-1 rounded text-[10px] font-mono font-bold border transition-colors ${
                            meta.post
                              ? 'bg-blue-500/20 border-blue-500/50 text-blue-300'
                              : 'bg-slate-900 border-slate-800 text-slate-600 line-through'
                          }`}
                        >
                          Post
                        </button>
                        <button
                          type="button"
                          aria-pressed={meta.story}
                          onClick={() => onToggleStream(targetKey, 'story')}
                          title={meta.story ? 'Đang bật Story: bấm để tắt' : 'Đang tắt Story: bấm để bật'}
                          className={`min-h-[44px] md:min-h-[30px] px-2.5 py-1 rounded text-[10px] font-mono font-bold border transition-colors ${
                            meta.story
                              ? 'bg-amber-500/20 border-amber-500/50 text-amber-300'
                              : 'bg-slate-900 border-slate-800 text-slate-600 line-through'
                          }`}
                        >
                          Story
                        </button>
                      </div>
                    </td>

                    {/* 3. Real-Time Live Status */}
                    <td className="py-3 px-4">
                      {liveInfo?.status === 'LIVE' ? (
                        <div className="space-y-1">
                          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] font-mono font-bold rounded-full bg-rose-500/20 border border-rose-500/50 text-rose-300">
                            <span className="w-1.5 h-1.5 rounded-full bg-rose-400 animate-ping" />
                            ĐANG LIVE
                          </span>
                          {liveInfo.qualityInfo && (
                            <div className="text-[10px] font-mono text-slate-400 truncate max-w-[180px]">
                              {liveInfo.qualityInfo}
                            </div>
                          )}
                        </div>
                      ) : liveInfo?.status === 'NOT_LIVE' ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-mono rounded-full bg-slate-900 border border-slate-700 text-slate-400">
                          Offline · {formatTimestamp(liveInfo.checkedAt)}
                        </span>
                      ) : liveInfo?.status === 'ERROR' ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-mono rounded-full bg-amber-950/70 border border-amber-700/60 text-amber-300">
                          <AlertTriangle className="w-3 h-3" />
                          Lỗi quét
                        </span>
                      ) : (
                        <span className="text-[11px] font-mono text-slate-500">Chưa quét</span>
                      )}
                    </td>

                    {/* 4. Real-Time Post Status */}
                    <td className="py-3 px-3 whitespace-nowrap">
                      {meta.post ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-mono rounded-md bg-blue-950/40 border border-blue-800/40 text-blue-300">
                          Khởi tạo êm (Đang theo dõi)
                        </span>
                      ) : (
                        <span className="text-slate-600 font-mono">Tắt</span>
                      )}
                    </td>

                    {/* 5. Real-Time Story Status */}
                    <td className="py-3 px-3 whitespace-nowrap">
                      {!meta.story ? (
                        <span className="text-slate-600 font-mono">Tắt</span>
                      ) : (
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-mono rounded-md border ${
                            hasPlatformCookie
                              ? 'bg-emerald-950/40 border-emerald-800/40 text-emerald-300'
                              : 'bg-indigo-950/40 border-indigo-800/40 text-indigo-300'
                          }`}
                        >
                          {hasPlatformCookie ? 'Sẵn sàng · Cookie' : 'Sẵn sàng · Ẩn danh'} · 48h
                        </span>
                      )}
                    </td>

                    {/* 6. Action Buttons */}
                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      <div className="inline-flex items-center justify-end gap-1.5">
                        {isLiveUser && (
                          <button
                            type="button"
                            disabled={isScanning}
                            onClick={() => onScanTarget(rule, target)}
                            className="min-h-[44px] md:min-h-[32px] inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-rose-200 bg-rose-950/60 border border-rose-800/60 rounded-lg hover:bg-rose-900/60 disabled:opacity-50 transition-colors"
                          >
                            {isRowScanning ? (
                              <RefreshCw className="w-3 h-3 animate-spin" />
                            ) : (
                              <Radio className="w-3 h-3" />
                            )}
                            <span>Quét Live</span>
                          </button>
                        )}

                        {liveInfo?.status === 'LIVE' && liveInfo.streamUrl && (
                          <button
                            type="button"
                            onClick={() => onCopyStreamUrl(targetKey, liveInfo.streamUrl!)}
                            className="min-h-[44px] md:min-h-[32px] inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-emerald-200 bg-emerald-950/60 border border-emerald-700/60 rounded-lg hover:bg-emerald-900/60 transition-colors"
                          >
                            {copiedStreamKey === targetKey ? (
                              <Check className="w-3 h-3 text-emerald-400" />
                            ) : (
                              <Copy className="w-3 h-3" />
                            )}
                            <span>{copiedStreamKey === targetKey ? 'Đã chép' : 'Copy'}</span>
                          </button>
                        )}

                        {liveInfo?.status === 'LIVE' && liveInfo.sourceUrl && (
                          <a
                            href={liveInfo.sourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label={`Mở link phòng live của ${target}`}
                            className="min-h-[44px] min-w-[44px] md:min-h-[32px] md:min-w-[32px] inline-flex items-center justify-center text-slate-300 hover:text-white bg-slate-800/80 rounded-lg transition-colors"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                          </a>
                        )}

                        <button
                          type="button"
                          onClick={() => onEditRule(rule)}
                          aria-label={`Sửa cấu hình nguồn ${target}`}
                          className="min-h-[44px] min-w-[44px] md:min-h-[32px] md:min-w-[32px] inline-flex items-center justify-center text-slate-400 hover:text-slate-100 rounded-lg hover:bg-slate-800 transition-colors"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>

                        <button
                          type="button"
                          onClick={() => onRemoveTarget(rule, target)}
                          aria-label={`Xóa ${target}`}
                          className="min-h-[44px] min-w-[44px] md:min-h-[32px] md:min-w-[32px] inline-flex items-center justify-center text-slate-500 hover:text-rose-400 rounded-lg hover:bg-slate-800 transition-colors"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
