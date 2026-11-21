import React, { useState, useMemo } from 'react';
import { Film, Image as ImageIcon, Search, Download, ExternalLink, RefreshCw, FolderDown } from 'lucide-react';

export interface DownloadedMediaItem {
  username: string;
  eventType: string;
  fileName: string;
  size: number;
  mtime: string;
  localPath: string;
  downloadUrl: string;
}

export interface DownloadedMediaSectionProps {
  media: DownloadedMediaItem[];
  isLoading: boolean;
  onRefresh: () => void;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function DownloadedMediaSection({ media, isLoading, onRefresh }: DownloadedMediaSectionProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'stories' | 'posts'>('all');

  const filteredMedia = useMemo(() => {
    return media.filter(item => {
      if (typeFilter !== 'all' && item.eventType !== typeFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return item.username.toLowerCase().includes(q) || item.fileName.toLowerCase().includes(q);
      }
      return true;
    });
  }, [media, typeFilter, searchQuery]);

  const storiesCount = useMemo(() => media.filter(m => m.eventType === 'stories').length, [media]);
  const postsCount = useMemo(() => media.filter(m => m.eventType === 'posts').length, [media]);

  return (
    <section className="bg-[#0C111D] border border-slate-800/90 rounded-2xl overflow-hidden space-y-4 p-4 sm:p-6">
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-100 flex items-center gap-2">
            <FolderDown className="w-5 h-5 text-indigo-400" />
            Kho Media Story & Bài Post Đã Tải Về ({media.length} files)
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Tự động tải về ổ đĩa máy chủ không trùng lặp và lưu trữ vĩnh viễn. Bấm để xem hoặc tải trực tiếp về thiết bị.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Filter Pills */}
          <div className="inline-flex items-center gap-1 p-1 bg-slate-950 border border-slate-800 rounded-xl">
            <button
              type="button"
              onClick={() => setTypeFilter('all')}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                typeFilter === 'all'
                  ? 'bg-indigo-600 text-white font-semibold'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              Tất cả ({media.length})
            </button>
            <button
              type="button"
              onClick={() => setTypeFilter('stories')}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                typeFilter === 'stories'
                  ? 'bg-indigo-600 text-white font-semibold'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              Story ({storiesCount})
            </button>
            <button
              type="button"
              onClick={() => setTypeFilter('posts')}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                typeFilter === 'posts'
                  ? 'bg-indigo-600 text-white font-semibold'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              Post ({postsCount})
            </button>
          </div>

          <div className="relative w-full sm:w-56">
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Tìm theo @username..."
              className="w-full pl-8 pr-3 py-1.5 text-xs bg-slate-950 border border-slate-700 rounded-xl text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-indigo-400"
            />
          </div>

          <button
            type="button"
            onClick={onRefresh}
            disabled={isLoading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-200 bg-slate-800 rounded-xl hover:bg-slate-700 transition-colors shrink-0 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            Làm mới
          </button>
        </div>
      </div>

      {filteredMedia.length === 0 ? (
        <div className="py-12 text-center text-slate-500 text-xs bg-slate-950/50 rounded-xl border border-slate-800/60">
          Chưa có file media nào được tải về khớp với bộ lọc. Khi hệ thống phát hiện Story hoặc Post mới, file sẽ xuất hiện tại đây.
        </div>
      ) : (
        <div className="overflow-x-auto max-h-[420px] rounded-xl border border-slate-800/80 bg-slate-950/60 divide-y divide-slate-800/60">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-900/80 text-slate-400 uppercase font-mono text-[10px] sticky top-0 z-10 backdrop-blur-md">
              <tr>
                <th className="py-2.5 px-4">Tài Khoản</th>
                <th className="py-2.5 px-4">Loại Media</th>
                <th className="py-2.5 px-4">Tên Tệp</th>
                <th className="py-2.5 px-4">Dung Lượng</th>
                <th className="py-2.5 px-4">Thời Gian Tải</th>
                <th className="py-2.5 px-4 text-right">Thao Tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50 text-slate-200 font-mono">
              {filteredMedia.map((item, idx) => {
                const isVideo = item.fileName.endsWith('.mp4');
                return (
                  <tr key={`${item.username}_${item.fileName}_${idx}`} className="hover:bg-slate-900/50 transition-colors">
                    <td className="py-2.5 px-4 font-bold text-slate-100 font-sans">
                      @{item.username}
                    </td>
                    <td className="py-2.5 px-4">
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold uppercase ${
                          item.eventType === 'stories'
                            ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                            : 'bg-indigo-500/15 text-indigo-300 border border-indigo-500/30'
                        }`}
                      >
                        {isVideo ? <Film className="w-3 h-3" /> : <ImageIcon className="w-3 h-3" />}
                        {item.eventType === 'stories' ? 'Story 24h' : 'Post'}
                      </span>
                    </td>
                    <td className="py-2.5 px-4 text-slate-300 truncate max-w-[220px]" title={item.fileName}>
                      {item.fileName}
                    </td>
                    <td className="py-2.5 px-4 text-slate-400 tabular-nums">
                      {formatBytes(item.size)}
                    </td>
                    <td className="py-2.5 px-4 text-slate-400 text-[11px] tabular-nums font-sans">
                      {new Date(item.mtime).toLocaleString()}
                    </td>
                    <td className="py-2.5 px-4 text-right font-sans">
                      <a
                        href={item.downloadUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-indigo-300 hover:text-indigo-200 bg-indigo-950/60 hover:bg-indigo-900/80 border border-indigo-700/50 rounded-lg transition-colors"
                      >
                        <ExternalLink className="w-3 h-3" />
                        Xem / Tải
                      </a>
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
