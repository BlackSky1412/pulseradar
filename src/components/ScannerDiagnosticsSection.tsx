import React, { useState, useMemo } from 'react';
import { Terminal, Search, CheckCircle2, AlertCircle, Clock, ShieldCheck, Radio, Film, FileText } from 'lucide-react';

export interface WatcherDiagnosticItem {
  platform: string;
  username: string;
  eventType: string;
  status: string;
  usedCookie?: boolean;
  itemCount?: number;
  newItemCount?: number;
  reason?: string;
  checkedAt?: string;
}

export interface ScannerDiagnosticsSectionProps {
  diagnostics?: WatcherDiagnosticItem[];
  lastScanAt?: string | null;
}

const PLATFORM_COLORS: Record<string, string> = {
  TIKTOK: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  INSTAGRAM: 'bg-purple-500/15 text-purple-300 border-purple-500/30',
  FACEBOOK: 'bg-blue-500/15 text-blue-300 border-blue-500/30',
  X: 'bg-slate-700/30 text-slate-300 border-slate-600/40',
};

export function ScannerDiagnosticsSection({ diagnostics = [], lastScanAt }: ScannerDiagnosticsSectionProps) {
  const [platformFilter, setPlatformFilter] = useState<string>('all');
  const [eventFilter, setEventFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Sort descending by checkedAt
  const sorted = useMemo(() => {
    return [...diagnostics].sort((a, b) => {
      const ta = a.checkedAt ? new Date(a.checkedAt).getTime() : 0;
      const tb = b.checkedAt ? new Date(b.checkedAt).getTime() : 0;
      return tb - ta;
    });
  }, [diagnostics]);

  const filtered = useMemo(() => {
    return sorted.filter(d => {
      if (platformFilter !== 'all' && d.platform.toUpperCase() !== platformFilter.toUpperCase()) return false;
      if (eventFilter !== 'all' && d.eventType.toLowerCase() !== eventFilter.toLowerCase()) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return d.username.toLowerCase().includes(q) || (d.reason || '').toLowerCase().includes(q);
      }
      return true;
    });
  }, [sorted, platformFilter, eventFilter, searchQuery]);

  return (
    <section className="bg-[#0C111D] border border-slate-800/90 rounded-2xl overflow-hidden space-y-4 p-4 sm:p-6">
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-100 flex items-center gap-2">
            <Terminal className="w-5 h-5 text-emerald-400" />
            Nhật Ký Quét Kênh Thời Gian Thực ({diagnostics.length} lượt kiểm tra gần nhất)
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Ghi nhận mọi lần kiểm tra của bộ quét Live, Story 24h và Post đối với từng tài khoản, trạng thái cookie và kết quả.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Platform Filters */}
          <div className="inline-flex items-center gap-1 p-1 bg-slate-950 border border-slate-800 rounded-xl">
            {['all', 'TIKTOK', 'INSTAGRAM', 'FACEBOOK', 'X'].map(p => (
              <button
                key={p}
                type="button"
                onClick={() => setPlatformFilter(p)}
                className={`px-2.5 py-1 text-xs font-medium rounded-lg transition-colors ${
                  platformFilter === p
                    ? 'bg-emerald-600 text-white font-semibold'
                    : 'text-slate-400 hover:text-slate-100'
                }`}
              >
                {p === 'all' ? 'Tất cả' : p}
              </button>
            ))}
          </div>

          {/* Event Filters */}
          <div className="inline-flex items-center gap-1 p-1 bg-slate-950 border border-slate-800 rounded-xl">
            {['all', 'story', 'live', 'post'].map(e => (
              <button
                key={e}
                type="button"
                onClick={() => setEventFilter(e)}
                className={`px-2.5 py-1 text-xs font-medium rounded-lg transition-colors uppercase ${
                  eventFilter === e
                    ? 'bg-slate-700 text-white font-semibold'
                    : 'text-slate-400 hover:text-slate-100'
                }`}
              >
                {e === 'all' ? 'Tất cả' : e}
              </button>
            ))}
          </div>

          <div className="relative w-full sm:w-48">
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Tìm @user..."
              className="w-full pl-8 pr-3 py-1 text-xs bg-slate-950 border border-slate-700 rounded-xl text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-emerald-400"
            />
          </div>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="py-12 text-center text-slate-500 text-xs bg-slate-950/50 rounded-xl border border-slate-800/60">
          Chưa có nhật ký quét nào khớp với bộ lọc. Hệ thống quét định kỳ theo chu kỳ và sẽ cập nhật kết quả tại đây.
        </div>
      ) : (
        <div className="overflow-x-auto max-h-[380px] rounded-xl border border-slate-800/80 bg-slate-950/60 divide-y divide-slate-800/60 font-mono">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-900/80 text-slate-400 uppercase text-[10px] sticky top-0 z-10 backdrop-blur-md font-sans">
              <tr>
                <th className="py-2.5 px-4">Thời Gian</th>
                <th className="py-2.5 px-4">Nền Tảng</th>
                <th className="py-2.5 px-4">Kênh Mục Tiêu</th>
                <th className="py-2.5 px-4">Luồng Quét</th>
                <th className="py-2.5 px-4">Cookie</th>
                <th className="py-2.5 px-4">Kết Quả Kiểm Tra</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50 text-slate-200 text-[11px]">
              {filtered.slice(0, 100).map((d, idx) => {
                const isOk = d.status === 'OK' || d.status === 'WARMED_UP';
                const newCount = typeof d.newItemCount === 'number' ? d.newItemCount : (d.status === 'WARMED_UP' ? 0 : (d.itemCount ?? 0));
                const totalCount = d.itemCount ?? 0;
                const hasNewItem = newCount > 0;
                return (
                  <tr key={`${d.platform}_${d.username}_${d.eventType}_${idx}`} className="hover:bg-slate-900/50 transition-colors">
                    <td className="py-2 px-4 text-slate-400 whitespace-nowrap">
                      {d.checkedAt ? new Date(d.checkedAt).toLocaleTimeString() : 'N/A'}
                    </td>
                    <td className="py-2 px-4 font-sans">
                      <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold border ${PLATFORM_COLORS[d.platform] || 'text-slate-300'}`}>
                        {d.platform}
                      </span>
                    </td>
                    <td className="py-2 px-4 font-bold text-slate-100 font-sans">
                      @{d.username}
                    </td>
                    <td className="py-2 px-4 font-sans">
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-300 uppercase">
                        {d.eventType === 'story' && <Film className="w-3 h-3 text-amber-400" />}
                        {d.eventType === 'live' && <Radio className="w-3 h-3 text-rose-400 animate-pulse" />}
                        {d.eventType === 'post' && <FileText className="w-3 h-3 text-indigo-400" />}
                        {d.eventType}
                      </span>
                    </td>
                    <td className="py-2 px-4">
                      {d.usedCookie ? (
                        <span className="text-emerald-400 font-semibold inline-flex items-center gap-1 text-[10px]">
                          <ShieldCheck className="w-3 h-3" /> Có Cookie
                        </span>
                      ) : (
                        <span className="text-slate-500 text-[10px]">Ẩn danh</span>
                      )}
                    </td>
                    <td className="py-2 px-4 font-sans">
                      {hasNewItem ? (
                        <span className="text-emerald-400 font-bold flex items-center gap-1.5">
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                          Phát hiện {newCount} mục mới (Đã tải)
                        </span>
                      ) : isOk ? (
                        <span className="text-slate-300 flex items-center gap-1.5">
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400/80" />
                          {d.status === 'WARMED_UP'
                            ? `Mốc ban đầu (0 mới${totalCount > 0 ? ` · ${totalCount} đã lưu` : ''})`
                            : totalCount > 0
                            ? `Đã quét (0 mục mới · ${totalCount} đã tải trước đó)`
                            : 'Đã quét (0 mục mới)'}
                        </span>
                      ) : (
                        <span className="text-amber-400 flex items-center gap-1.5" title={d.reason || d.status}>
                          <AlertCircle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                          <span className="truncate max-w-[280px]">{d.reason || d.status}</span>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
