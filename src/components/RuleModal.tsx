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
  ExternalLink,
  Loader2,
} from 'lucide-react';
import {
  type KeywordRuleItem,
  type MatchType,
  type PlatformCookies,
  type SocialPlatform,
  type TargetProfileMeta,
  type UserValidationResult,
  type WebhookServerItem,
  PLATFORM_LABELS,
  PLATFORM_TO_SOCIAL_KEY,
  SOURCE_DEFAULT_DOMAINS,
  extractTargetUsername,
  getTargetProfileKey,
  isLiveUserTarget,
  validateKeywordRuleInput,
  parseTrackedTargets,
  parseSourceMeta,
  resolvePlatformProfileUrl,
} from '../utils/scannerEngine';
import { UserAvatar } from './UserAvatar';

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
  cookies?: Partial<PlatformCookies>;
  targetProfiles?: Record<string, TargetProfileMeta>;
  onProfileValidated?: (updates: Record<string, TargetProfileMeta>) => void;
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

interface BlockedCandidate {
  raw: string;
  canonical: string;
  profileKey: string;
  meta: TargetProfileMeta;
  reason: string;
}

export function RuleModal({
  isOpen,
  onClose,
  onSave,
  editingRule,
  servers,
  defaultPlatform,
  cookies,
  targetProfiles,
  onProfileValidated,
}: RuleModalProps) {
  const initialPlatform: SocialPlatform = editingRule
    ? ((editingRule.platforms.split(',')[0]?.trim() as SocialPlatform) || 'reddit')
    : defaultPlatform || 'reddit';
  const initialMeta = editingRule
    ? parseSourceMeta(editingRule.excludedKeywords, initialPlatform)
    : null;

  const [selectedPlatform, setSelectedPlatform] = useState<SocialPlatform>(() => initialPlatform);
  const [sourceDomain, setSourceDomain] = useState(
    () => initialMeta?.sourceDomain || SOURCE_DEFAULT_DOMAINS[initialPlatform]
  );
  const [targets, setTargets] = useState<string[]>(() =>
    editingRule ? parseTrackedTargets(editingRule.keyword) : []
  );
  const [newTargetInput, setNewTargetInput] = useState('');
  const [excludedTermsInput, setExcludedTermsInput] = useState(
    () => initialMeta?.excludedTerms.join(', ') || ''
  );
  const [webhookServerId, setWebhookServerId] = useState(
    () => editingRule?.webhookServerId || servers[0]?.id || 'srv_sandbox_local'
  );
  const [enabled, setEnabled] = useState(() => (editingRule ? editingRule.enabled : true));

  // Stream subscriptions
  const [trackLive, setTrackLive] = useState(() =>
    editingRule ? editingRule.matchType !== 'exact' : true
  );
  const [trackPost, setTrackPost] = useState(() =>
    editingRule ? editingRule.matchType !== 'regex' : true
  );
  const [trackStory, setTrackStory] = useState(() =>
    editingRule ? editingRule.matchType !== 'regex' && editingRule.matchType !== 'exact' : true
  );

  // First-run warmup toggle
  const [firstRunWarmup, setFirstRunWarmup] = useState(true);

  // Stream intervals
  const [liveInterval, setLiveInterval] = useState(60);
  const [postInterval, setPostInterval] = useState(240);
  const [storyInterval, setStoryInterval] = useState(360);

  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [modalProfiles, setModalProfiles] = useState<Record<string, TargetProfileMeta>>({});
  const [blockedCandidates, setBlockedCandidates] = useState<BlockedCandidate[]>([]);

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
    setBlockedCandidates([]);
    setModalProfiles({});
  }, [editingRule, isOpen, servers, defaultPlatform]);

  if (!isOpen) return null;

  const handleAddTarget = async () => {
    const trimmed = newTargetInput.trim();
    if (!trimmed || isValidating) return;
    setErrorMsg(null);
    setBlockedCandidates([]);

    const parts = trimmed
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    setIsValidating(true);
    const validToAdd: string[] = [];
    const validatedUpdates: Record<string, TargetProfileMeta> = {};
    const blockedToConfirm: BlockedCandidate[] = [];
    const invalidErrors: string[] = [];
    const platformKey = PLATFORM_TO_SOCIAL_KEY[selectedPlatform];
    const platformCookie = cookies?.[platformKey]?.trim();

    for (const part of parts) {
      try {
        const resp = await fetch('/api/user/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            target: part,
            platform: selectedPlatform,
            ...(platformCookie ? { cookie: platformCookie } : {}),
          }),
        });
        const data = (await resp.json()) as { ok?: boolean; result?: UserValidationResult };
        const result = data?.result;
        const canonicalTarget = part.startsWith('http')
          ? part
          : part.startsWith('@')
          ? part
          : `@${result?.username || part}`;
        const profileKey = getTargetProfileKey(selectedPlatform, result?.username || part);

        if (data?.ok && result?.valid) {
          validToAdd.push(canonicalTarget);
          if (profileKey) {
            validatedUpdates[profileKey] = {
              ...(result.id ? { id: result.id } : {}),
              ...(result.nickname ? { nickname: result.nickname } : {}),
              ...(result.avatarUrl ? { avatarUrl: result.avatarUrl } : {}),
              profileUrl:
                result.profileUrl || resolvePlatformProfileUrl(canonicalTarget, selectedPlatform),
              status: result.status || 'VALID',
              ...(result.authMode ? { authMode: result.authMode } : {}),
              updatedAt: new Date().toISOString(),
            };
          }
        } else if (
          result &&
          (result.status === 'AUTH_REQUIRED' ||
            result.status === 'BLOCKED' ||
            result.status === 'ERROR') &&
          isLiveUserTarget(part) &&
          extractTargetUsername(part, selectedPlatform)
        ) {
          const reason =
            result.error ||
            `Nền tảng ${PLATFORM_LABELS[selectedPlatform]} chặn truy cập ẩn danh hoặc yêu cầu Cookie.`;
          blockedToConfirm.push({
            raw: part,
            canonical: canonicalTarget,
            profileKey,
            meta: {
              profileUrl:
                result.profileUrl || resolvePlatformProfileUrl(canonicalTarget, selectedPlatform),
              status: result.status,
              ...(result.authMode ? { authMode: result.authMode } : {}),
              updatedAt: new Date().toISOString(),
            },
            reason,
          });
        } else {
          invalidErrors.push(
            result?.error ||
              `Tài khoản "${part}" không tồn tại hoặc không hợp lệ trên ${PLATFORM_LABELS[selectedPlatform]}.`
          );
        }
      } catch {
        const extracted = extractTargetUsername(part, selectedPlatform);
        if (isLiveUserTarget(part) && extracted) {
          const canonicalTarget =
            part.startsWith('http') || part.startsWith('@') ? part : `@${extracted}`;
          const profileKey = getTargetProfileKey(selectedPlatform, extracted);
          blockedToConfirm.push({
            raw: part,
            canonical: canonicalTarget,
            profileKey,
            meta: {
              profileUrl: resolvePlatformProfileUrl(canonicalTarget, selectedPlatform),
              status: 'ERROR',
              updatedAt: new Date().toISOString(),
            },
            reason: `Không thể kết nối máy chủ để xác thực "${part}".`,
          });
        } else {
          invalidErrors.push(`Tên tài khoản "${part}" không đúng định dạng.`);
        }
      }
    }

    setIsValidating(false);

    if (validToAdd.length > 0) {
      setTargets(prev => Array.from(new Set([...prev, ...validToAdd])));
      if (Object.keys(validatedUpdates).length > 0) {
        setModalProfiles(prev => ({ ...prev, ...validatedUpdates }));
        onProfileValidated?.(validatedUpdates);
      }
    }

    if (blockedToConfirm.length > 0) {
      setBlockedCandidates(blockedToConfirm);
    }

    if (invalidErrors.length === 0 && blockedToConfirm.length === 0) {
      setNewTargetInput('');
    }

    if (invalidErrors.length > 0) {
      setErrorMsg(`❌ Không thể thêm: ${invalidErrors.join(' | ')}`);
    }
  };

  const handleConfirmBlockedCandidates = () => {
    if (blockedCandidates.length === 0) return;
    const toAdd = blockedCandidates.map(c => c.canonical);
    const updates: Record<string, TargetProfileMeta> = {};
    for (const candidate of blockedCandidates) {
      if (candidate.profileKey) {
        updates[candidate.profileKey] = candidate.meta;
      }
    }
    setTargets(prev => Array.from(new Set([...prev, ...toAdd])));
    if (Object.keys(updates).length > 0) {
      setModalProfiles(prev => ({ ...prev, ...updates }));
      onProfileValidated?.(updates);
    }
    setBlockedCandidates([]);
    setNewTargetInput('');
  };

  const handleRemoveTarget = (targetToRemove: string) => {
    setTargets(prev => prev.filter(t => t !== targetToRemove));
  };

  const handlePlatformSelect = (p: SocialPlatform) => {
    setSelectedPlatform(p);
    setSourceDomain(SOURCE_DEFAULT_DOMAINS[p]);
    setBlockedCandidates([]);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    if (newTargetInput.trim()) {
      setErrorMsg('Bạn còn tên user chưa bấm "Thêm vào nguồn". Vui lòng bấm Thêm vào nguồn để kiểm tra hợp lệ trước khi lưu!');
      return;
    }

    const finalTargets = [...targets];

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
      <div className="bg-[#0D121F] border-t sm:border border-slate-800 rounded-t-2xl sm:rounded-2xl max-w-2xl w-full p-5 sm:p-6 space-y-5 max-h-[92vh] overflow-y-auto overflow-x-hidden text-slate-100 shadow-2xl">
        {/* Modal Header */}
        <div className="flex items-center justify-between gap-3 border-b border-slate-800/80 pb-4">
          <div className="flex items-start gap-2.5 min-w-0">
            <div className="p-2 rounded-lg bg-indigo-500/15 border border-indigo-500/30 text-indigo-300 mt-0.5 shrink-0">
              <Layers className="w-5 h-5" />
            </div>
            <div className="min-w-0">
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
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center text-slate-400 hover:text-slate-100 rounded-lg hover:bg-slate-800 transition-colors shrink-0"
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
            <div className="flex flex-wrap items-center justify-between gap-1.5">
              <label htmlFor="rule-keyword-input" className="text-xs font-semibold text-slate-300">
                2. Danh sách @Username hoặc URL kênh ({targets.length} mục tiêu)
              </label>
              <span className="text-[11px] font-mono text-slate-400">
                Tên miền: {sourceDomain}
              </span>
            </div>

            <div className="flex flex-col sm:flex-row gap-2">
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
                className="min-w-0 flex-1 min-h-[44px] px-3.5 py-2 text-xs sm:text-sm bg-slate-950 border border-slate-700 rounded-xl text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-indigo-400"
              />
              <button
                type="button"
                onClick={handleAddTarget}
                disabled={isValidating}
                className="min-h-[44px] inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-indigo-600 border border-indigo-500 rounded-xl hover:bg-indigo-500 transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
              >
                {isValidating ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Đang xác thực...
                  </>
                ) : (
                  <>
                    <Plus className="w-3.5 h-3.5" />
                    Thêm vào nguồn
                  </>
                )}
              </button>
            </div>

            {blockedCandidates.length > 0 && (
              <div className="p-3 bg-amber-950/50 border border-amber-700/70 rounded-xl space-y-2 text-xs text-amber-200">
                <div className="flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
                  <div className="space-y-1 min-w-0">
                    <p className="font-semibold text-amber-100">
                      Không thể xác thực tự động ({blockedCandidates.map(c => c.canonical).join(', ')})
                    </p>
                    <p className="text-[11px] text-amber-200/90 leading-relaxed">
                      {blockedCandidates.map(c => c.reason).join(' | ')}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={handleConfirmBlockedCandidates}
                    className="min-h-[44px] inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-amber-950 bg-amber-400 hover:bg-amber-300 rounded-lg transition-colors"
                  >
                    Thêm dù chưa xác thực (chỉ lưu cú pháp)
                  </button>
                </div>
              </div>
            )}

            {targets.length === 0 ? (
              <div className="p-4 text-center border border-dashed border-slate-800 rounded-xl bg-slate-950/40 text-xs text-slate-500">
                Chưa có mục tiêu nào. Hãy nhập @username hoặc URL kênh ở ô trên rồi nhấn Thêm.
              </div>
            ) : (
              <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl divide-y divide-slate-800/80 max-h-48 overflow-y-auto">
                {targets.map(t => {
                  const isUser = t.startsWith('@');
                  const profileKey = getTargetProfileKey(selectedPlatform, t);
                  const profile = profileKey
                    ? modalProfiles[profileKey] ?? targetProfiles?.[profileKey]
                    : undefined;
                  const extractedName = extractTargetUsername(t, selectedPlatform);
                  const profileHref = resolvePlatformProfileUrl(t, selectedPlatform);
                  const showNickname =
                    profile?.nickname &&
                    profile.nickname.trim() &&
                    profile.nickname.trim() !== extractedName;
                  const isUnverified =
                    profile?.status === 'AUTH_REQUIRED' ||
                    profile?.status === 'BLOCKED' ||
                    profile?.status === 'ERROR';

                  return (
                    <div
                      key={t}
                      className="py-1.5 first:pt-0 last:pb-0 flex items-center justify-between gap-2 text-xs"
                    >
                      <div className="flex items-center flex-wrap gap-2 font-mono min-w-0 flex-1">
                        <UserAvatar
                          target={t}
                          platform={PLATFORM_TO_SOCIAL_KEY[selectedPlatform]}
                          avatarUrl={profile?.avatarUrl}
                          nickname={profile?.nickname}
                          size="xs"
                          showPlatformBadge={false}
                        />
                        {showNickname && (
                          <span className="text-slate-300 font-sans text-[11px] font-semibold truncate max-w-[140px]">
                            {profile!.nickname}
                          </span>
                        )}
                        <span
                          className={`break-all ${
                            isUser ? 'text-indigo-300 font-semibold' : 'text-slate-200 font-medium'
                          }`}
                        >
                          {t}
                        </span>
                        {profileHref && (
                          <a
                            href={profileHref}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-lg text-slate-400 hover:text-cyan-300 hover:bg-slate-800 transition-colors shrink-0"
                            title={`Mở trang ${PLATFORM_LABELS[selectedPlatform]} của ${t}`}
                            aria-label={`Mở trang ${PLATFORM_LABELS[selectedPlatform]} của ${t}`}
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                          </a>
                        )}
                        <span className="text-slate-500 font-sans text-[11px]">
                          · {isUser ? 'Tài khoản User' : 'URL / Từ khóa'}
                        </span>
                        {isUnverified && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-sans bg-amber-950/60 border border-amber-700/60 text-amber-300">
                            Chưa xác thực
                          </span>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => handleRemoveTarget(t)}
                        aria-label={`Xóa ${t}`}
                        className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-lg text-slate-500 hover:text-rose-400 hover:bg-slate-800/80 transition-colors shrink-0"
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
                className={`min-h-[44px] p-3 rounded-xl border cursor-pointer transition-all flex flex-col justify-between space-y-2 ${
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
                    className="w-5 h-5 shrink-0 rounded border-slate-700 bg-slate-900 text-rose-500 focus:ring-rose-500"
                  />
                </div>
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  Bắt phòng phát trực tiếp, trích xuất FLV/HLS Origin Stream URL và dedup bằng <code className="font-mono text-slate-300">room_id</code>.
                </p>
              </label>

              {/* Post Tracking */}
              <label
                className={`min-h-[44px] p-3 rounded-xl border cursor-pointer transition-all flex flex-col justify-between space-y-2 ${
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
                    className="w-5 h-5 shrink-0 rounded border-slate-700 bg-slate-900 text-blue-500 focus:ring-blue-500"
                  />
                </div>
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  Theo dõi video hoặc bài viết mới xuất bản, bỏ qua bài ghim cũ và dedup bằng <code className="font-mono text-slate-300">video_id</code>.
                </p>
              </label>

              {/* Story Tracking */}
              <label
                className={`min-h-[44px] p-3 rounded-xl border cursor-pointer transition-all flex flex-col justify-between space-y-2 ${
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
                    className="w-5 h-5 shrink-0 rounded border-slate-700 bg-slate-900 text-amber-500 focus:ring-amber-500"
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
            <label className="min-h-[44px] flex items-start gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={firstRunWarmup}
                onChange={e => setFirstRunWarmup(e.target.checked)}
                className="mt-0.5 w-5 h-5 shrink-0 rounded border-slate-700 bg-slate-900 text-emerald-500 focus:ring-emerald-500"
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
                className="w-full min-h-[44px] px-3 py-2 text-xs bg-slate-950 border border-slate-700 rounded-xl text-slate-100 focus:outline-none focus:border-indigo-400"
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
                className="w-full min-h-[44px] px-3 py-2 text-xs bg-slate-950 border border-slate-700 rounded-xl text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-indigo-400"
              />
            </div>
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
              disabled={submitting}
              className="min-h-[44px] px-5 py-2 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-500 disabled:opacity-50 transition-colors whitespace-nowrap"
            >
              {submitting ? 'Đang lưu...' : editingRule ? 'Lưu cấu hình nguồn' : 'Tạo mục tiêu theo dõi'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
