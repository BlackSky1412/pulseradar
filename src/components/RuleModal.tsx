import React, { useState, useEffect } from 'react';
import {
  X,
  Plus,
  Trash2,
  AlertCircle,
  Radio,
  FileText,
  Sparkles,
  Flame,
  Clock,
  Server,
  Layers,
} from 'lucide-react';
import {
  type KeywordRuleItem,
  type MatchType,
  type SocialPlatform,
  type WebhookServerItem,
  PLATFORM_LABELS,
  SOURCE_DEFAULT_DOMAINS,
  MATCH_TYPE_LABELS,
  validateKeywordRuleInput,
  parseTrackedTargets,
  parseSourceMeta,
} from '../utils/scannerEngine';

interface RuleModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (data: {
    id?: string;
    keyword: string;
    excludedKeywords: string;
    matchType: MatchType;
    platforms: SocialPlatform[];
    webhookServerId: string;
    enabled: boolean;
    streamSubscriptions?: {
      live: boolean;
      post: boolean;
      story: boolean;
    };
    warmup?: boolean;
    intervals?: {
      live?: number;
      post?: number;
      story?: number;
    };
  }) => Promise<void>;
  editingRule: KeywordRuleItem | null;
  servers: WebhookServerItem[];
  defaultPlatform?: SocialPlatform;
}

const ALL_PLATFORMS: SocialPlatform[] = ['reddit', 'hackernews', 'github', 'bluesky'];

const PLATFORM_COLORS: Record<SocialPlatform, { border: string; bg: string; text: string; badge: string }> = {
  reddit: {
    border: 'border-cyan-500',
    bg: 'bg-cyan-500/10',
    text: 'text-cyan-300',
    badge: 'bg-cyan-950 text-cyan-300 border-cyan-800',
  },
  hackernews: {
    border: 'border-fuchsia-500',
    bg: 'bg-fuchsia-500/10',
    text: 'text-fuchsia-300',
    badge: 'bg-fuchsia-950 text-fuchsia-300 border-fuchsia-800',
  },
  github: {
    border: 'border-blue-500',
    bg: 'bg-blue-500/10',
    text: 'text-blue-300',
    badge: 'bg-blue-950 text-blue-300 border-blue-800',
  },
  bluesky: {
    border: 'border-slate-400',
    bg: 'bg-slate-400/10',
    text: 'text-slate-200',
    badge: 'bg-slate-900 text-slate-200 border-slate-700',
  },
};

export function RuleModal({
  isOpen,
  onClose,
  onSave,
  editingRule,
  servers,
  defaultPlatform,
}: RuleModalProps) {
  const [selectedPlatform, setSelectedPlatform] = useState<SocialPlatform>(
    defaultPlatform || 'reddit'
  );
  const [sourceDomain, setSourceDomain] = useState('tiktok.com');
  const [targets, setTargets] = useState<string[]>([]);
  const [newTargetInput, setNewTargetInput] = useState('');
  const [excludedTermsInput, setExcludedTermsInput] = useState('');
  const [webhookServerId, setWebhookServerId] = useState('');
  const [enabled, setEnabled] = useState(true);

  // Stream subscriptions
  const [trackLive, setTrackLive] = useState(true);
  const [trackPost, setTrackPost] = useState(true);
  const [trackStory, setTrackStory] = useState(true);

  // First-run warmup toggle
  const [firstRunWarmup, setFirstRunWarmup] = useState(true);

  // Stream intervals
  const [liveInterval, setLiveInterval] = useState(60);
  const [postInterval, setPostInterval] = useState(240);
  const [storyInterval, setStoryInterval] = useState(360);

  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (editingRule) {
      const p = (editingRule.platforms.split(',')[0]?.trim() as SocialPlatform) || 'reddit';
      setSelectedPlatform(p);
      const parsedTargets = parseTrackedTargets(editingRule.keyword);
      setTargets(parsedTargets);
      const meta = parseSourceMeta(editingRule.excludedKeywords, p);
      setSourceDomain(meta.sourceDomain);
      setExcludedTermsInput(meta.excludedTerms.join(', '));
      setWebhookServerId(editingRule.webhookServerId || servers[0]?.id || 'srv_sandbox_local');
      setEnabled(editingRule.enabled);

      // Infer stream subscriptions from matchType
      if (editingRule.matchType === 'regex') {
        setTrackLive(true);
        setTrackPost(false);
        setTrackStory(false);
      } else if (editingRule.matchType === 'exact') {
        setTrackLive(false);
        setTrackPost(true);
        setTrackStory(false);
      } else {
        setTrackLive(true);
        setTrackPost(true);
        setTrackStory(true);
      }
    } else {
      const p = defaultPlatform || 'reddit';
      setSelectedPlatform(p);
      setSourceDomain(SOURCE_DEFAULT_DOMAINS[p]);
      setTargets([]);
      setNewTargetInput('');
      setExcludedTermsInput('');
      setWebhookServerId(servers[0]?.id || 'srv_sandbox_local');
      setEnabled(true);
      setTrackLive(true);
      setTrackPost(true);
      setTrackStory(true);
      setFirstRunWarmup(true);
    }
    setErrorMsg(null);
  }, [editingRule, isOpen, servers, defaultPlatform]);

  if (!isOpen) return null;

  const handleAddTarget = () => {
    const trimmed = newTargetInput.trim();
    if (!trimmed) return;
    const parts = trimmed
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    setTargets(prev => Array.from(new Set([...prev, ...parts])));
    setNewTargetInput('');
  };

  const handleRemoveTarget = (targetToRemove: string) => {
    setTargets(prev => prev.filter(t => t !== targetToRemove));
  };

  const handlePlatformSelect = (p: SocialPlatform) => {
    setSelectedPlatform(p);
    setSourceDomain(SOURCE_DEFAULT_DOMAINS[p]);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    const finalTargets = [...targets];
    if (newTargetInput.trim()) {
      newTargetInput
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .forEach(item => {
          if (!finalTargets.includes(item)) finalTargets.push(item);
        });
    }

    if (!trackLive && !trackPost && !trackStory) {
      setErrorMsg('Vui lòng chọn ít nhất 1 luồng theo dõi (Live, Post, hoặc Story).');
      return;
    }

    const joinedKeyword = finalTargets.join(', ');
    const cleanDomain = sourceDomain.trim() || SOURCE_DEFAULT_DOMAINS[selectedPlatform];
    const cleanExcluded = excludedTermsInput.trim();
    const combinedExcludedField = cleanExcluded
      ? `${cleanDomain} | ${cleanExcluded}`
      : `${cleanDomain} |`;

    // Map stream subscriptions to canonical MatchType for backward compatibility
    let calculatedMatchType: MatchType = 'contains';
    if (trackLive && !trackPost && !trackStory) {
      calculatedMatchType = 'regex';
    } else if (!trackLive && trackPost && !trackStory) {
      calculatedMatchType = 'exact';
    } else {
      calculatedMatchType = 'contains';
    }

    const validation = validateKeywordRuleInput({
      keyword: joinedKeyword,
      excludedKeywords: combinedExcludedField,
      matchType: calculatedMatchType,
      platforms: [selectedPlatform],
      webhookServerId,
    });

    if (!validation.valid) {
      setErrorMsg(validation.error || 'Dữ liệu không hợp lệ.');
      return;
    }

    setSubmitting(true);
    try {
      await onSave({
        id: editingRule?.id,
        keyword: joinedKeyword.slice(0, 4000),
        excludedKeywords: combinedExcludedField.slice(0, 250),
        matchType: calculatedMatchType,
        platforms: [selectedPlatform],
        webhookServerId,
        enabled,
        streamSubscriptions: {
          live: trackLive,
          post: trackPost,
          story: trackStory,
        },
        warmup: firstRunWarmup,
        intervals: {
          live: liveInterval,
          post: postInterval,
          story: storyInterval,
        },
      });
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Không thể lưu cấu hình trang web nguồn.');
    } finally {
      setSubmitting(false);
    }
  };

  const platformStyle = PLATFORM_COLORS[selectedPlatform];

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rule-modal-title"
    >
      <div className="bg-[#0D121F] border-t sm:border border-slate-800 rounded-t-2xl sm:rounded-2xl max-w-2xl w-full p-5 sm:p-6 space-y-5 max-h-[92vh] overflow-y-auto text-slate-100 shadow-2xl">
        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-slate-800/80 pb-4">
          <div className="flex items-start gap-2.5">
            <div className="p-2 rounded-lg bg-indigo-500/15 border border-indigo-500/30 text-indigo-300 mt-0.5">
              <Layers className="w-5 h-5" />
            </div>
            <div>
              <h2 id="rule-modal-title" className="text-base font-semibold text-slate-100">
                {editingRule ? 'Cấu hình Kênh & Luồng Theo Dõi Nền Tảng' : 'Thêm Mục Tiêu & Cấu Hình Luồng Quét Mới'}
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Thiết lập nền tảng, danh sách @username / URL và cấu hình đa luồng (Live, Post, Story) kèm chế độ Khởi tạo êm.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng hộp thoại cấu hình"
            className="min-h-[40px] min-w-[40px] inline-flex items-center justify-center text-slate-400 hover:text-slate-100 rounded-lg hover:bg-slate-800 transition-colors shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {errorMsg && (
            <div className="p-3 bg-rose-950/60 border border-rose-800/80 rounded-lg flex items-center gap-2 text-xs text-rose-300">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* Step 1: Platform Selection */}
          <div className="space-y-2">
            <label className="block text-xs font-semibold text-slate-300">
              1. Chọn nền tảng mạng xã hội
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {ALL_PLATFORMS.map(p => {
                const active = selectedPlatform === p;
                const style = PLATFORM_COLORS[p];
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => handlePlatformSelect(p)}
                    className={`min-h-[46px] px-3 py-2 rounded-xl border text-center transition-all ${
                      active
                        ? `${style.border} ${style.bg} ${style.text} font-bold shadow-xs ring-1 ring-inset ring-indigo-500/40`
                        : 'border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                    }`}
                  >
                    <div className="text-xs font-semibold">{PLATFORM_LABELS[p]}</div>
                    <div className="text-[10px] font-mono text-slate-400 mt-0.5">
                      {SOURCE_DEFAULT_DOMAINS[p]}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Step 2: Target Handle / URL Input */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label htmlFor="rule-keyword-input" className="text-xs font-semibold text-slate-300">
                2. Danh sách @Username hoặc URL kênh ({targets.length} mục tiêu)
              </label>
              <span className="text-[11px] font-mono text-slate-400">
                Tên miền: {sourceDomain}
              </span>
            </div>

            <div className="flex gap-2">
              <input
                id="rule-keyword-input"
                type="text"
                value={newTargetInput}
                onChange={e => setNewTargetInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddTarget();
                  }
                }}
                placeholder={`Nhập @username hoặc URL (VD: @mixigaming, https://${sourceDomain}/@...) rồi nhấn Thêm...`}
                className="flex-1 min-h-[42px] px-3.5 py-2 text-xs sm:text-sm bg-slate-950 border border-slate-700 rounded-xl text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-indigo-400"
              />
              <button
                type="button"
                onClick={handleAddTarget}
                className="min-h-[42px] inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-indigo-600 border border-indigo-500 rounded-xl hover:bg-indigo-500 transition-colors whitespace-nowrap shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
                Thêm vào nguồn
              </button>
            </div>

            {targets.length === 0 ? (
              <div className="p-4 text-center border border-dashed border-slate-800 rounded-xl bg-slate-950/40 text-xs text-slate-500">
                Chưa có mục tiêu nào. Hãy nhập @username hoặc URL kênh ở ô trên rồi nhấn Thêm.
              </div>
            ) : (
              <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl divide-y divide-slate-800/80 max-h-40 overflow-y-auto">
                {targets.map(t => {
                  const isUser = t.startsWith('@');
                  return (
                    <div
                      key={t}
                      className="py-1.5 first:pt-0 last:pb-0 flex items-center justify-between gap-2 text-xs"
                    >
                      <div className="flex items-center gap-2 font-mono">
                        <span
                          className={
                            isUser ? 'text-indigo-300 font-semibold' : 'text-slate-200 font-medium'
                          }
                        >
                          {t}
                        </span>
                        <span className="text-slate-500 font-sans text-[11px]">
                          · {isUser ? 'Tài khoản User' : 'URL / Từ khóa'}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleRemoveTarget(t)}
                        aria-label={`Xóa ${t}`}
                        className="p-1 text-slate-500 hover:text-rose-400 transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Step 3: Stream Subscription Checkboxes (Live, Post, Story) */}
          <div className="space-y-2.5">
            <span className="block text-xs font-semibold text-slate-300">
              3. Chọn các luồng sự kiện theo dõi (Multi-Stream Tracking)
            </span>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              {/* Live Tracking */}
              <label
                className={`p-3 rounded-xl border cursor-pointer transition-all flex flex-col justify-between space-y-2 ${
                  trackLive
                    ? 'border-rose-500/80 bg-rose-950/20 text-rose-200'
                    : 'border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 font-bold text-xs text-rose-300">
                    <Radio className="w-3.5 h-3.5" />
                    Live Tracking
                  </div>
                  <input
                    type="checkbox"
                    checked={trackLive}
                    onChange={e => setTrackLive(e.target.checked)}
                    className="rounded border-slate-700 bg-slate-900 text-rose-500 focus:ring-rose-500"
                  />
                </div>
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  Bắt phòng phát trực tiếp, trích xuất FLV/HLS Origin Stream URL và dedup bằng <code className="font-mono text-slate-300">room_id</code>.
                </p>
              </label>

              {/* Post Tracking */}
              <label
                className={`p-3 rounded-xl border cursor-pointer transition-all flex flex-col justify-between space-y-2 ${
                  trackPost
                    ? 'border-blue-500/80 bg-blue-950/20 text-blue-200'
                    : 'border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 font-bold text-xs text-blue-300">
                    <FileText className="w-3.5 h-3.5" />
                    Post Tracking
                  </div>
                  <input
                    type="checkbox"
                    checked={trackPost}
                    onChange={e => setTrackPost(e.target.checked)}
                    className="rounded border-slate-700 bg-slate-900 text-blue-500 focus:ring-blue-500"
                  />
                </div>
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  Theo dõi video hoặc bài viết mới xuất bản, bỏ qua bài ghim cũ và dedup bằng <code className="font-mono text-slate-300">video_id</code>.
                </p>
              </label>

              {/* Story Tracking */}
              <label
                className={`p-3 rounded-xl border cursor-pointer transition-all flex flex-col justify-between space-y-2 ${
                  trackStory
                    ? 'border-amber-500/80 bg-amber-950/20 text-amber-200'
                    : 'border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 font-bold text-xs text-amber-300">
                    <Sparkles className="w-3.5 h-3.5" />
                    Story Tracking
                  </div>
                  <input
                    type="checkbox"
                    checked={trackStory}
                    onChange={e => setTrackStory(e.target.checked)}
                    className="rounded border-slate-700 bg-slate-900 text-amber-500 focus:ring-amber-500"
                  />
                </div>
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  Theo dõi Story 24h tạm thời, tự động lưu lịch sử chống trùng 48h (cần Cookie phiên đăng nhập).
                </p>
              </label>
            </div>
          </div>

          {/* Step 4: First-Run Warmup Toggle */}
          <div className="p-3.5 rounded-xl bg-slate-950/90 border border-slate-800/90 space-y-2">
            <label className="flex items-start gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={firstRunWarmup}
                onChange={e => setFirstRunWarmup(e.target.checked)}
                className="mt-0.5 rounded border-slate-700 bg-slate-900 text-emerald-500 focus:ring-emerald-500"
              />
              <div className="space-y-0.5">
                <span className="text-xs font-semibold text-emerald-300 inline-flex items-center gap-1.5">
                  <Flame className="w-3.5 h-3.5 text-emerald-400" />
                  Khởi tạo êm (First-run Warmup)
                </span>
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  Khi bật, lần đầu tiên thêm các @username này, hệ thống sẽ đồng bộ và lưu baseline toàn bộ ID bài viết / story hiện có vào bộ nhớ đệm mà <strong>không bắn thông báo ồ ạt</strong> cho các nội dung cũ. Chỉ bắn thông báo khi có nội dung mới xuất bản sau thời điểm này.
                </p>
              </div>
            </label>
          </div>

          {/* Step 5: Destination Server & Stream Intervals */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            <div>
              <label
                htmlFor="rule-webhook-server"
                className="block text-xs font-semibold text-slate-300 mb-1.5"
              >
                4. Máy chủ nhận Alert Request
              </label>
              <select
                id="rule-webhook-server"
                value={webhookServerId}
                onChange={e => setWebhookServerId(e.target.value)}
                className="w-full min-h-[42px] px-3 py-2 text-xs bg-slate-950 border border-slate-700 rounded-xl text-slate-100 focus:outline-none focus:border-indigo-400"
              >
                {servers.map(srv => (
                  <option key={srv.id} value={srv.id}>
                    {srv.name} ({srv.format.toUpperCase()})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="rule-excluded-input"
                className="block text-xs font-semibold text-slate-300 mb-1.5"
              >
                Từ khóa loại trừ (Bỏ qua bài đăng/live chứa từ này)
              </label>
              <input
                id="rule-excluded-input"
                type="text"
                value={excludedTermsInput}
                onChange={e => setExcludedTermsInput(e.target.value)}
                placeholder="Ví dụ: reup, tuyển dụng, quảng cáo"
                maxLength={150}
                className="w-full min-h-[42px] px-3 py-2 text-xs bg-slate-950 border border-slate-700 rounded-xl text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-indigo-400"
              />
            </div>
          </div>

          {/* Modal Actions */}
          <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-800">
            <button
              type="button"
              onClick={onClose}
              className="min-h-[40px] px-4 py-2 text-xs font-medium text-slate-300 bg-slate-800 rounded-lg hover:bg-slate-700 transition-colors whitespace-nowrap"
            >
              Hủy
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="min-h-[40px] px-5 py-2 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-500 disabled:opacity-50 transition-colors whitespace-nowrap"
            >
              {submitting ? 'Đang lưu...' : editingRule ? 'Lưu cấu hình nguồn' : 'Tạo mục tiêu theo dõi'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
