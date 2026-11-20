import React, { useState, useEffect } from 'react';
import {
  X,
  KeyRound,
  ShieldCheck,
  Clock,
  Eye,
  EyeOff,
  Radio,
  FileText,
  Sparkles,
  Info,
} from 'lucide-react';
import {
  type PlatformCookies,
  type LiveScannerSettings,
  type MultiPlatformSettings,
  normalizeMultiPlatformSettings,
} from '../utils/scannerEngine';

export type { LiveScannerSettings };

interface CookieSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: LiveScannerSettings;
  onSave: (next: LiveScannerSettings) => void;
}

const LIVE_INTERVAL_OPTIONS = [15, 30, 45, 60, 90, 120];
const POST_INTERVAL_OPTIONS = [120, 180, 240, 300, 360];
const STORY_INTERVAL_OPTIONS = [180, 300, 360, 480, 600];

export function CookieSettingsModal({
  isOpen,
  onClose,
  settings,
  onSave,
}: CookieSettingsModalProps) {
  const [tiktok, setTiktok] = useState(settings.cookies.tiktok);
  const [instagram, setInstagram] = useState(settings.cookies.instagram);
  const [facebook, setFacebook] = useState(settings.cookies.facebook);
  const [xCookie, setXCookie] = useState(settings.cookies.x);
  const [liveIntervalSeconds, setLiveIntervalSeconds] = useState(
    settings.pollIntervalSeconds || 60
  );

  const initialPlatforms = normalizeMultiPlatformSettings(settings.platforms);
  const [postIntervalSeconds, setPostIntervalSeconds] = useState(
    initialPlatforms.tiktok.postIntervalSeconds || 240
  );
  const [storyIntervalSeconds, setStoryIntervalSeconds] = useState(
    initialPlatforms.tiktok.storyIntervalSeconds || 360
  );

  const [deduplicateLive, setDeduplicateLive] = useState(settings.deduplicateLive ?? true);
  const [showSecrets, setShowSecrets] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setTiktok(settings.cookies.tiktok || '');
      setInstagram(settings.cookies.instagram || '');
      setFacebook(settings.cookies.facebook || '');
      setXCookie(settings.cookies.x || '');
      setLiveIntervalSeconds(settings.pollIntervalSeconds || 60);

      const norm = normalizeMultiPlatformSettings(settings.platforms);
      setPostIntervalSeconds(norm.tiktok.postIntervalSeconds || 240);
      setStoryIntervalSeconds(norm.tiktok.storyIntervalSeconds || 360);
      setDeduplicateLive(settings.deduplicateLive ?? true);
    }
  }, [isOpen, settings]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const currentNorm = normalizeMultiPlatformSettings(settings.platforms);
    const updatedPlatforms: MultiPlatformSettings = {
      tiktok: {
        ...currentNorm.tiktok,
        liveIntervalSeconds,
        postIntervalSeconds,
        storyIntervalSeconds,
      },
      instagram: {
        ...currentNorm.instagram,
        liveIntervalSeconds,
        postIntervalSeconds,
        storyIntervalSeconds,
      },
      facebook: {
        ...currentNorm.facebook,
        liveIntervalSeconds,
        postIntervalSeconds,
        storyIntervalSeconds,
      },
      x: {
        ...currentNorm.x,
        liveIntervalSeconds,
        postIntervalSeconds,
        storyIntervalSeconds,
      },
    };

    onSave({
      cookies: {
        tiktok: tiktok.trim(),
        instagram: instagram.trim(),
        facebook: facebook.trim(),
        x: xCookie.trim(),
      },
      pollIntervalSeconds: liveIntervalSeconds,
      deduplicateLive,
      platforms: updatedPlatforms,
    });
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cookie-settings-title"
    >
      <div className="bg-[#0D121F] border-t sm:border border-slate-800 rounded-t-2xl sm:rounded-2xl max-w-2xl w-full p-5 sm:p-6 space-y-5 max-h-[92vh] overflow-y-auto overflow-x-hidden text-slate-100 shadow-2xl">
        {/* Modal Header */}
        <div className="flex items-center justify-between gap-3 border-b border-slate-800/80 pb-4">
          <div className="flex items-start gap-2.5 min-w-0">
            <div className="p-2 rounded-lg bg-indigo-500/15 border border-indigo-500/30 text-indigo-300 mt-0.5 shrink-0">
              <KeyRound className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h2 id="cookie-settings-title" className="text-base font-semibold text-slate-100">
                Cài đặt Cookie Nền Tảng & Chu Kỳ Quét Độc Lập
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Cấu hình Cookie xác thực cho 4 nền tảng (TikTok, Instagram, Facebook, X) và thiết lập chu kỳ quét độc lập cho Live, Post, Story.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng cài đặt bộ quét"
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center text-slate-400 hover:text-slate-100 rounded-lg hover:bg-slate-800 transition-colors shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Section 1: Configurable Stream Intervals for Live, Post, and Story */}
          <div className="p-4 rounded-xl bg-slate-950/90 border border-slate-800/90 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold text-slate-200 inline-flex items-center gap-1.5">
                <Clock className="w-4 h-4 text-indigo-400" />
                Chu kỳ quét độc lập theo 3 luồng (Stream Intervals)
              </span>
              <span className="text-[11px] font-mono text-slate-400">
                Multi-Loop Scheduler (10-20% Jitter)
              </span>
            </div>

            {/* Live Stream Interval */}
            <div className="space-y-1.5 pt-1">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="text-slate-300 font-medium inline-flex items-center gap-1.5">
                  <Radio className="w-3.5 h-3.5 text-rose-400" />
                  Chu kỳ Live Tracking (Khuyến nghị 45s - 60s):
                </span>
                <span className="font-mono text-rose-400 font-bold">{liveIntervalSeconds}s</span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {LIVE_INTERVAL_OPTIONS.map(sec => (
                  <button
                    key={sec}
                    type="button"
                    onClick={() => setLiveIntervalSeconds(sec)}
                    className={`min-h-[44px] min-w-[44px] inline-flex items-center justify-center px-3 py-2 text-xs font-mono rounded-lg border transition-colors ${
                      liveIntervalSeconds === sec
                        ? 'bg-rose-600/30 border-rose-500 text-rose-200 font-semibold shadow-xs'
                        : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700'
                    }`}
                  >
                    {sec}s
                  </button>
                ))}
              </div>
            </div>

            {/* Post Stream Interval */}
            <div className="space-y-1.5 pt-2 border-t border-slate-800/70">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="text-slate-300 font-medium inline-flex items-center gap-1.5">
                  <FileText className="w-3.5 h-3.5 text-blue-400" />
                  Chu kỳ Post Tracking (Khuyến nghị 3 - 5 phút):
                </span>
                <span className="font-mono text-blue-400 font-bold">
                  {postIntervalSeconds}s ({Math.round(postIntervalSeconds / 60)} phút)
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {POST_INTERVAL_OPTIONS.map(sec => (
                  <button
                    key={sec}
                    type="button"
                    onClick={() => setPostIntervalSeconds(sec)}
                    className={`min-h-[44px] min-w-[44px] inline-flex items-center justify-center px-3 py-2 text-xs font-mono rounded-lg border transition-colors ${
                      postIntervalSeconds === sec
                        ? 'bg-blue-600/30 border-blue-500 text-blue-200 font-semibold shadow-xs'
                        : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700'
                    }`}
                  >
                    {sec}s ({Math.round(sec / 60)}m)
                  </button>
                ))}
              </div>
            </div>

            {/* Story Stream Interval */}
            <div className="space-y-1.5 pt-2 border-t border-slate-800/70">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="text-slate-300 font-medium inline-flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                  Chu kỳ Story Tracking (Khuyến nghị 5 - 10 phút):
                </span>
                <span className="font-mono text-amber-400 font-bold">
                  {storyIntervalSeconds}s ({Math.round(storyIntervalSeconds / 60)} phút)
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {STORY_INTERVAL_OPTIONS.map(sec => (
                  <button
                    key={sec}
                    type="button"
                    onClick={() => setStoryIntervalSeconds(sec)}
                    className={`min-h-[44px] min-w-[44px] inline-flex items-center justify-center px-3 py-2 text-xs font-mono rounded-lg border transition-colors ${
                      storyIntervalSeconds === sec
                        ? 'bg-amber-600/30 border-amber-500 text-amber-200 font-semibold shadow-xs'
                        : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700'
                    }`}
                  >
                    {sec}s ({Math.round(sec / 60)}m)
                  </button>
                ))}
              </div>
            </div>

            {/* Deduplication Live Toggle */}
            <label className="min-h-[44px] flex items-start gap-2.5 cursor-pointer pt-3 border-t border-slate-800/80">
              <input
                type="checkbox"
                checked={deduplicateLive}
                onChange={e => setDeduplicateLive(e.target.checked)}
                className="mt-0.5 w-5 h-5 shrink-0 rounded border-slate-700 bg-slate-900 text-indigo-500 focus:ring-indigo-500"
              />
              <span className="text-xs text-slate-300 leading-relaxed">
                <strong className="text-slate-100">Chống gửi trùng Webhook (Deduplication):</strong>{' '}
                Chỉ bắn Alert Webhook 1 lần duy nhất cho mỗi phiên Live / bài đăng mới; tự động reset khi phiên Live kết thúc hoặc sau 48h đối với Story.
              </span>
            </label>
          </div>

          {/* Section 2: Platform Credentials with Guidance for all 4 Platforms */}
          <div className="space-y-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold text-slate-200 inline-flex items-center gap-1.5">
                <KeyRound className="w-3.5 h-3.5 text-indigo-400" />
                Cookie xác thực 4 nền tảng mạng xã hội
              </span>
              <button
                type="button"
                onClick={() => setShowSecrets(prev => !prev)}
                className="min-h-[44px] min-w-[44px] px-2.5 py-2 rounded-lg hover:bg-slate-800/60 inline-flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
              >
                {showSecrets ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                {showSecrets ? 'Ẩn giá trị' : 'Hiện giá trị'}
              </button>
            </div>

            {/* TikTok Credential */}
            <div className="p-3.5 rounded-xl bg-slate-950/80 border border-slate-800/80 space-y-2">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
                <label
                  htmlFor="cookie-tiktok"
                  className="text-xs font-bold text-slate-200 inline-flex items-center gap-1.5"
                >
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-cyan-950 text-cyan-300 border border-cyan-800">
                    TikTok
                  </span>
                  TikTok Cookie / Session ID
                </label>
                <span className="text-[11px] text-cyan-400/90 font-medium">
                  Khóa chính: <code className="font-mono bg-slate-900 px-1 rounded">sessionid</code>
                </span>
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed flex items-start gap-1.5">
                <Info className="w-3.5 h-3.5 text-cyan-400 shrink-0 mt-0.5" />
                <span>
                  <strong>Cần thiết cho Story collector & phòng Live 18+:</strong> Vượt kiểm duyệt WAF (mã lỗi 4003110) và hỗ trợ quét các story tạm thời chưa hết hạn.
                </span>
              </p>
              <input
                id="cookie-tiktok"
                type={showSecrets ? 'text' : 'password'}
                value={tiktok}
                onChange={e => setTiktok(e.target.value)}
                placeholder="Dán giá trị sessionid (VD: 8a1b2c3d...) hoặc chuỗi Cookie TikTok..."
                className="w-full min-h-[44px] px-3 py-2 text-xs font-mono bg-slate-900 border border-slate-700 rounded-lg text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-cyan-400"
              />
            </div>

            {/* Instagram Credential */}
            <div className="p-3.5 rounded-xl bg-slate-950/80 border border-slate-800/80 space-y-2">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
                <label
                  htmlFor="cookie-instagram"
                  className="text-xs font-bold text-slate-200 inline-flex items-center gap-1.5"
                >
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-fuchsia-950 text-fuchsia-300 border border-fuchsia-800">
                    Instagram
                  </span>
                  Instagram Cookie (sessionid + ds_user_id)
                </label>
                <span className="text-[11px] text-fuchsia-400/90 font-medium">
                  Khóa chính: <code className="font-mono bg-slate-900 px-1 rounded">sessionid + ds_user_id</code>
                </span>
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed flex items-start gap-1.5">
                <Info className="w-3.5 h-3.5 text-fuchsia-400 shrink-0 mt-0.5" />
                <span>
                  <strong>Cần thiết cho Story collector & tránh HTTP 429:</strong> Gọi endpoint nội bộ <code className="font-mono">live/web_info</code> và trích xuất danh sách Story cá nhân 24h.
                </span>
              </p>
              <input
                id="cookie-instagram"
                type={showSecrets ? 'text' : 'password'}
                value={instagram}
                onChange={e => setInstagram(e.target.value)}
                placeholder="Dán sessionid (VD: 50160641448%3A...) hoặc đầy đủ chuỗi cookie Instagram..."
                className="w-full min-h-[44px] px-3 py-2 text-xs font-mono bg-slate-900 border border-slate-700 rounded-lg text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-fuchsia-400"
              />
            </div>

            {/* Facebook Credential */}
            <div className="p-3.5 rounded-xl bg-slate-950/80 border border-slate-800/80 space-y-2">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
                <label
                  htmlFor="cookie-facebook"
                  className="text-xs font-bold text-slate-200 inline-flex items-center gap-1.5"
                >
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-blue-950 text-blue-300 border border-blue-800">
                    Facebook
                  </span>
                  Facebook Cookie (c_user + xs)
                </label>
                <span className="text-[11px] text-blue-400/90 font-medium">
                  Khóa chính: <code className="font-mono bg-slate-900 px-1 rounded">c_user + xs</code>
                </span>
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed flex items-start gap-1.5">
                <Info className="w-3.5 h-3.5 text-blue-400 shrink-0 mt-0.5" />
                <span>
                  <strong>Hỗ trợ trích xuất luồng DASH-ABR & bài đăng:</strong> Cho phép bot đọc dữ liệu các trang Fanpage hoặc Group có bảo vệ quyền riêng tư yêu cầu đăng nhập.
                </span>
              </p>
              <input
                id="cookie-facebook"
                type={showSecrets ? 'text' : 'password'}
                value={facebook}
                onChange={e => setFacebook(e.target.value)}
                placeholder="c_user=...; xs=...; (hỗ trợ đọc trang Live yêu cầu đăng nhập)"
                className="w-full min-h-[44px] px-3 py-2 text-xs font-mono bg-slate-900 border border-slate-700 rounded-lg text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-blue-400"
              />
            </div>

            {/* X (Twitter) Credential */}
            <div className="p-3.5 rounded-xl bg-slate-950/80 border border-slate-800/80 space-y-2">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
                <label
                  htmlFor="cookie-x"
                  className="text-xs font-bold text-slate-200 inline-flex items-center gap-1.5"
                >
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-slate-900 text-slate-200 border border-slate-700">
                    X / Twitter
                  </span>
                  X (Twitter) Cookie (auth_token + ct0)
                </label>
                <span className="text-[11px] text-slate-400 font-medium">
                  Khóa chính: <code className="font-mono bg-slate-900 px-1 rounded">auth_token + ct0</code>
                </span>
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed flex items-start gap-1.5">
                <Info className="w-3.5 h-3.5 text-indigo-400 shrink-0 mt-0.5" />
                <span>
                  <strong>Tự động trích xuất CSRF Token:</strong> Hệ thống tự trích xuất <code className="font-mono">x-csrf-token</code> từ giá trị <code className="font-mono">ct0</code> để gọi API Live Broadcast và bắt bài tweet mới.
                </span>
              </p>
              <input
                id="cookie-x"
                type={showSecrets ? 'text' : 'password'}
                value={xCookie}
                onChange={e => setXCookie(e.target.value)}
                placeholder="auth_token=...; ct0=...; (tự động gắn x-csrf-token từ ct0)"
                className="w-full min-h-[44px] px-3 py-2 text-xs font-mono bg-slate-900 border border-slate-700 rounded-lg text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-indigo-400"
              />
            </div>
          </div>

          {/* Privacy & Security Note */}
          <div className="p-3.5 rounded-xl bg-emerald-950/30 border border-emerald-800/50 flex items-start gap-2.5 text-xs text-emerald-300/90 leading-relaxed">
            <ShieldCheck className="w-4 h-4 shrink-0 mt-0.5 text-emerald-400" />
            <span>
              <strong>Bảo mật thông tin:</strong> Cookie chỉ được lưu cục bộ trên trình duyệt (localStorage) và gửi trực tiếp tới máy chủ Express của PulseRadar để gọi API nền tảng. Cookie <strong>tuyệt đối không</strong> bị rò rỉ trong Webhook payload hoặc chia sẻ ra bên ngoài.
            </span>
          </div>

          {/* Modal Actions */}
          <div className="flex flex-wrap items-center justify-end gap-3 pt-4 border-t border-slate-800">
            <button
              type="button"
              onClick={onClose}
              className="min-h-[44px] px-4 py-2 text-xs font-medium text-slate-300 bg-slate-800 rounded-lg hover:bg-slate-700 transition-colors whitespace-nowrap"
            >
              Hủy
            </button>
            <button
              type="submit"
              className="min-h-[44px] px-5 py-2 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-500 shadow-sm transition-colors whitespace-nowrap"
            >
              Lưu cài đặt Cookie & Chu kỳ
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
