import React from 'react';
import { AlertTriangle, CheckCircle2, Code2, ExternalLink, Search } from 'lucide-react';
import {
  type AlertDetectionItem,
  type SocialPlatformKey,
  PLATFORM_BRAND_NAMES,
  PLATFORM_LABELS,
  formatTimestamp,
} from '../utils/scannerEngine';

export interface ActivityLogSectionProps {
  selectedPlatform: SocialPlatformKey;
  logScope: 'platform' | 'all';
  onChangeLogScope: (scope: 'platform' | 'all') => void;
  searchQuery: string;
  onChangeSearchQuery: (query: string) => void;
  totalAlertsCount: number;
  filteredAlerts: AlertDetectionItem[];
  onInspectAlert: (item: AlertDetectionItem) => void;
}

export function ActivityLogSection({
  selectedPlatform,
  logScope,
  onChangeLogScope,
  searchQuery,
  onChangeSearchQuery,
  totalAlertsCount,
  filteredAlerts,
  onInspectAlert,
}: ActivityLogSectionProps) {
  return (
    <section className="bg-[#0C111D] border border-slate-800/90 rounded-2xl overflow-hidden">
      <div className="px-4 sm:px-6 py-4 border-b border-slate-800 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-slate-100">
            Nhật Ký Phát Hiện Sự Kiện (Live / Post / Story) & Request Đã Bắn Về Máy Chủ
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            {logScope === 'platform'
              ? `Đang hiển thị sự kiện thuộc nền tảng: ${PLATFORM_BRAND_NAMES[selectedPlatform]}`
              : 'Đang hiển thị toàn bộ sự kiện từ tất cả các nền tảng'}
          </p>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="grid grid-cols-2 sm:inline-flex items-center gap-1 p-1 bg-slate-950 border border-slate-800 rounded-xl w-full sm:w-auto">
            <button
              type="button"
              onClick={() => onChangeLogScope('platform')}
              className={`min-h-[44px] md:min-h-[34px] px-3 py-2 md:py-1 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                logScope === 'platform'
                  ? 'bg-indigo-600 text-white font-semibold'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              Chỉ {PLATFORM_BRAND_NAMES[selectedPlatform]}
            </button>
            <button
              type="button"
              onClick={() => onChangeLogScope('all')}
              className={`min-h-[44px] md:min-h-[34px] px-3 py-2 md:py-1 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                logScope === 'all'
                  ? 'bg-indigo-600 text-white font-semibold'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              Tất cả nguồn ({totalAlertsCount})
            </button>
          </div>

          <div className="relative w-full sm:w-56">
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => onChangeSearchQuery(e.target.value)}
              placeholder="Tìm @username, từ khóa, live..."
              aria-label="Tìm kiếm nhật ký phát hiện"
              className="w-full min-h-[44px] md:min-h-[38px] pl-8 pr-3 py-2 md:py-1.5 text-sm md:text-xs bg-slate-950 border border-slate-700 rounded-xl text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-indigo-400"
            />
          </div>
        </div>
      </div>

      {filteredAlerts.length === 0 ? (
        <div className="p-8 text-center space-y-2">
          <p className="text-sm text-slate-400">
            Chưa có sự kiện nào trong danh mục này. Hãy bấm &ldquo;Quét Live&rdquo;, &ldquo;Quét Post&rdquo; hoặc &ldquo;Quét Story&rdquo; ở trên để chạy thử nghiệm.
          </p>
        </div>
      ) : (
        <>
          {/* Mobile Vertical Cards (< md) */}
          <div data-testid="activity-log-mobile-cards" className="md:hidden divide-y divide-slate-800/90">
            {filteredAlerts.map(item => {
              const isLiveEvent =
                item.keyword.includes('LIVE') || item.title.toUpperCase().includes('LIVE');
              const isStoryEvent =
                item.keyword.includes('STORY') || item.title.toUpperCase().includes('STORY');

              return (
                <article key={`mobile_${item.id}`} className="p-4 space-y-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <span
                      className={`font-mono font-semibold text-xs break-words min-w-0 ${
                        isLiveEvent
                          ? 'text-rose-400'
                          : isStoryEvent
                          ? 'text-amber-300'
                          : 'text-blue-300'
                      }`}
                    >
                      {item.keyword}
                    </span>
                    <span className="font-mono tabular-nums text-[11px] text-slate-400 shrink-0">
                      {formatTimestamp(item.createdAt)}
                    </span>
                  </div>

                  <div className="text-xs text-slate-400 break-all">
                    <span className="font-medium text-slate-200">
                      {PLATFORM_LABELS[item.platform]}
                    </span>
                    <span aria-hidden="true"> · </span>
                    <span className="font-mono text-slate-300">
                      @{item.author.replace(/^@/, '')}
                    </span>
                  </div>

                  <div className="space-y-1">
                    <div className="font-medium text-slate-100 text-sm break-words leading-snug">
                      {item.title}
                    </div>
                    <div className="text-xs text-slate-400 break-words leading-relaxed">
                      {item.contentSnippet}
                    </div>
                  </div>

                  <div className="rounded-xl bg-slate-950/75 border border-slate-800/80 px-3 py-2 space-y-1 text-xs">
                    <div className="font-medium text-slate-200 break-words">
                      {item.webhookServerName}
                    </div>
                    <div className="font-mono tabular-nums">
                      {item.webhookStatus === 'delivered' ? (
                        <span className="inline-flex items-center gap-1 text-emerald-400">
                          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                          HTTP {item.httpStatusCode} · {item.latencyMs}ms
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-rose-400">
                          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                          HTTP {item.httpStatusCode} · {item.latencyMs}ms
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => onInspectAlert(item)}
                      className="min-h-[44px] flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-200 bg-slate-800 border border-slate-700 rounded-xl hover:bg-slate-700 transition-colors"
                    >
                      <Code2 className="w-3.5 h-3.5 shrink-0" />
                      Xem Request
                    </button>
                    <a
                      href={item.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Xem nguồn sự kiện của ${item.author}`}
                      className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-2 text-slate-300 hover:text-slate-100 bg-slate-900 border border-slate-800 rounded-xl hover:bg-slate-800 transition-colors shrink-0"
                    >
                      <ExternalLink className="w-4 h-4" />
                    </a>
                  </div>
                </article>
              );
            })}
          </div>

          {/* Desktop 6-Column Table (md+) */}
          <div data-testid="activity-log-desktop-table" className="hidden md:block overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-950/60 text-slate-400 font-semibold">
                  <th className="py-3 px-6">Thời gian</th>
                  <th className="py-3 px-4">Loại sự kiện & Mục tiêu</th>
                  <th className="py-3 px-4">Nền tảng & Creator</th>
                  <th className="py-3 px-4">Tiêu đề / Nội dung</th>
                  <th className="py-3 px-4">Máy chủ xử lý & Phản hồi</th>
                  <th className="py-3 px-6 text-right">Chi tiết Request</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {filteredAlerts.map(item => {
                  const isLiveEvent =
                    item.keyword.includes('LIVE') || item.title.toUpperCase().includes('LIVE');
                  const isStoryEvent =
                    item.keyword.includes('STORY') || item.title.toUpperCase().includes('STORY');

                  return (
                    <tr key={item.id} className="hover:bg-slate-800/35 transition-colors">
                      <td className="py-3.5 px-6 font-mono tabular-nums text-slate-400 whitespace-nowrap">
                        {formatTimestamp(item.createdAt)}
                      </td>
                      <td className="py-3.5 px-4 font-mono whitespace-nowrap">
                        <span
                          className={`font-semibold ${
                            isLiveEvent
                              ? 'text-rose-400'
                              : isStoryEvent
                              ? 'text-amber-300'
                              : 'text-blue-300'
                          }`}
                        >
                          {item.keyword}
                        </span>
                      </td>
                      <td className="py-3.5 px-4 text-slate-400 whitespace-nowrap">
                        <span className="font-medium text-slate-200">
                          {PLATFORM_LABELS[item.platform]}
                        </span>
                        <span aria-hidden="true"> · </span>
                        <span className="font-mono text-slate-300">
                          @{item.author.replace(/^@/, '')}
                        </span>
                      </td>
                      <td className="py-3.5 px-4 max-w-md">
                        <div className="font-medium text-slate-100 line-clamp-1">{item.title}</div>
                        <div className="text-[11px] text-slate-400 line-clamp-1 mt-0.5">
                          {item.contentSnippet}
                        </div>
                      </td>
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        <div className="font-medium text-slate-200">{item.webhookServerName}</div>
                        <div className="flex items-center gap-1.5 mt-0.5 font-mono tabular-nums">
                          {item.webhookStatus === 'delivered' ? (
                            <span className="inline-flex items-center gap-1 text-emerald-400">
                              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                              HTTP {item.httpStatusCode} · {item.latencyMs}ms
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-rose-400">
                              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                              HTTP {item.httpStatusCode} · {item.latencyMs}ms
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-3.5 px-6 text-right whitespace-nowrap">
                        <div className="inline-flex items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => onInspectAlert(item)}
                            className="min-h-[44px] md:min-h-[34px] inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-200 bg-slate-800 border border-slate-700 rounded-lg hover:bg-slate-700 transition-colors whitespace-nowrap shrink-0"
                          >
                            <Code2 className="w-3.5 h-3.5" />
                            Xem Request
                          </button>
                          <a
                            href={item.sourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label={`Xem nguồn sự kiện của ${item.author}`}
                            className="min-h-[44px] min-w-[44px] md:min-h-[34px] md:min-w-[34px] inline-flex items-center justify-center p-2 md:p-1.5 text-slate-400 hover:text-slate-100 rounded-lg hover:bg-slate-800 transition-colors"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                          </a>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
