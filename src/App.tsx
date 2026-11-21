import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  onAuthStateChanged,
  type User,
} from 'firebase/auth';
import {
  collection,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore';
import {
  Activity,
  Search,
  Plus,
  Play,
  RefreshCw,
  Trash2,
  Edit3,
  Send,
  CheckCircle2,
  AlertTriangle,
  ExternalLink,
  Code2,
  LogIn,
  LogOut,
  Clock,
  LayoutDashboard,
  Globe,
  Server,
  Terminal,
  Radio,
  FileText,
  X,
  ArrowRight,
  KeyRound,
  Copy,
  Check,
  Sparkles,
  Flame,
  Layers,
  ShieldCheck,
  Info,
} from 'lucide-react';
import {
  auth,
  db,
  signInWithGoogle,
  logOutUser,
  OperationType,
  handleFirestoreError,
} from './firebase';
import {
  type KeywordRuleItem,
  type WebhookServerItem,
  type AlertDetectionItem,
  type SocialPlatform,
  type MatchType,
  type WebhookFormat,
  type ActivityEventType,
  type LiveTargetScanStatus,
  type SocialPlatformKey,
  type TargetStreamMeta,
  SOCIAL_KEY_TO_PLATFORM,
  PLATFORM_TO_SOCIAL_KEY,
  PLATFORM_BRAND_NAMES,
  PLATFORM_LABELS,
  LIVE_PLATFORM_LABELS,
  SOURCE_DEFAULT_DOMAINS,
  MATCH_TYPE_LABELS,
  WEBHOOK_FORMAT_LABELS,
  INITIAL_WEBHOOK_SERVERS,
  INITIAL_KEYWORD_RULES,
  INITIAL_ALERT_DETECTIONS,
  buildWebhookPayload,
  parseTrackedTargets,
  parseSourceMeta,
  isLiveUserTarget,
  normalizeMultiPlatformSettings,
  formatTimestamp,
} from './utils/scannerEngine';
import { RuleModal } from './components/RuleModal';
import { WebhookModal } from './components/WebhookModal';
import { PayloadInspectorModal } from './components/PayloadInspectorModal';
import {
  CookieSettingsModal,
  type LiveScannerSettings,
} from './components/CookieSettingsModal';
import { UserAvatar } from './components/UserAvatar';
import { InfoPopover } from './components/InfoPopover';
import { WatchlistSection } from './components/WatchlistSection';
import { ActivityLogSection } from './components/ActivityLogSection';

export type ActiveTab =
  | 'overview'
  | 'rules'
  | 'servers'
  | 'sandbox'
  | 'activity'
  | SocialPlatformKey;

interface SandboxReceiptItem {
  id: string;
  receivedAt: string;
  channel: string;
  signatureHeader: string;
  signatureVerified: boolean;
  eventHeader: string;
  userAgent: string;
  payload: unknown;
}

interface AndroidRuntimeStatus {
  ok: boolean;
  device: {
    deviceId: string;
    ip: string;
    port: number;
    callbackUrl: string;
    appVersion?: string;
    networkType?: string;
    lastSeenAt?: string;
    lastSyncAt?: string | null;
  } | null;
  scanner: {
    enabled: boolean;
    running: boolean;
    scanning?: boolean;
    pollIntervalSeconds: number;
    lastScanAt: string | null;
    activeLiveCount: number;
    lastDispatchError: string | null;
  };
}

interface WatcherHealthItem {
  consecutiveErrors: number;
  lastError: string | null;
  lastSuccess: string | null;
}

interface WatcherStatusData {
  success: boolean;
  running: boolean;
  health: Record<string, WatcherHealthItem>;
  metrics: {
    seenEventsCount: number;
    trackedUsersCount: number;
  };
}

function toIsoString(val: unknown): string {
  if (val instanceof Timestamp) {
    return val.toDate().toISOString();
  }
  if (typeof val === 'string') {
    return val;
  }
  return new Date().toISOString();
}

export function getPlatformKeyForRule(rule: KeywordRuleItem): SocialPlatformKey {
  const p = String(rule.platforms || '').split(',')[0]?.trim().toLowerCase();
  if (p === 'reddit' || p === 'tiktok') return 'tiktok';
  if (p === 'hackernews' || p === 'instagram') return 'instagram';
  if (p === 'github' || p === 'facebook') return 'facebook';
  if (p === 'bluesky' || p === 'x' || p === 'twitter') return 'x';
  const kw = (rule.excludedKeywords || '').toLowerCase();
  if (kw.includes('tiktok')) return 'tiktok';
  if (kw.includes('instagram')) return 'instagram';
  if (kw.includes('facebook') || kw.includes('fb.')) return 'facebook';
  if (kw.includes('x.com') || kw.includes('twitter')) return 'x';
  return 'tiktok';
}

export const ALL_SOCIAL_PLATFORMS: SocialPlatformKey[] = ['tiktok', 'instagram', 'facebook', 'x'];

export function ensureAllPlatformRules(existingRules: KeywordRuleItem[]): KeywordRuleItem[] {
  const result = [...existingRules];
  for (const p of ALL_SOCIAL_PLATFORMS) {
    const hasPlatform = result.some(r => getPlatformKeyForRule(r) === p);
    if (!hasPlatform) {
      const defaultRule = INITIAL_KEYWORD_RULES.find(r => getPlatformKeyForRule(r) === p);
      if (defaultRule) {
        result.push(defaultRule);
      }
    }
  }
  return result;
}

export function parseNavigationHash(
  hash: string
): { tab: ActiveTab; platform?: SocialPlatformKey } | null {
  const clean = hash.replace(/^#/, '').toLowerCase().trim();
  if (!clean) return null;
  if (clean === 'tiktok' || clean === 'instagram' || clean === 'facebook' || clean === 'x') {
    return { tab: clean as ActiveTab, platform: clean as SocialPlatformKey };
  }
  if (
    clean === 'overview' ||
    clean === 'rules' ||
    clean === 'servers' ||
    clean === 'sandbox' ||
    clean === 'activity' ||
    clean === 'history'
  ) {
    return { tab: (clean === 'history' ? 'activity' : clean) as ActiveTab };
  }
  return null;
}

const PLATFORM_THEMES: Record<
  SocialPlatformKey,
  {
    border: string;
    bg: string;
    text: string;
    badge: string;
    accent: string;
    hoverBorder: string;
  }
> = {
  tiktok: {
    border: 'border-cyan-500',
    bg: 'bg-cyan-500/10',
    text: 'text-cyan-300',
    badge: 'bg-cyan-950 text-cyan-300 border-cyan-800',
    accent: '#00f2fe',
    hoverBorder: 'hover:border-cyan-500/70',
  },
  instagram: {
    border: 'border-fuchsia-500',
    bg: 'bg-fuchsia-500/10',
    text: 'text-fuchsia-300',
    badge: 'bg-fuchsia-950 text-fuchsia-300 border-fuchsia-800',
    accent: '#f58529',
    hoverBorder: 'hover:border-fuchsia-500/70',
  },
  facebook: {
    border: 'border-blue-500',
    bg: 'bg-blue-500/10',
    text: 'text-blue-300',
    badge: 'bg-blue-950 text-blue-300 border-blue-800',
    accent: '#1877f2',
    hoverBorder: 'hover:border-blue-500/70',
  },
  x: {
    border: 'border-slate-400',
    bg: 'bg-slate-400/10',
    text: 'text-slate-200',
    badge: 'bg-slate-900 text-slate-200 border-slate-700',
    accent: '#ffffff',
    hoverBorder: 'hover:border-slate-400/70',
  },
};

export default function App() {
  const initialNav = typeof window !== 'undefined' ? parseNavigationHash(window.location.hash) : null;
  const [activeTab, setActiveTab] = useState<ActiveTab>(initialNav?.tab || 'tiktok');
  const [selectedPlatform, setSelectedPlatform] = useState<SocialPlatformKey>(
    initialNav?.platform ||
      (initialNav?.tab && ALL_SOCIAL_PLATFORMS.includes(initialNav.tab as SocialPlatformKey)
        ? (initialNav.tab as SocialPlatformKey)
        : 'tiktok')
  );
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);

  // Core state: Source Websites (`rules`), Target Servers (`servers`), Activity Detections (`alerts`)
  const [rules, setRules] = useState<KeywordRuleItem[]>(() => {
    try {
      const raw = localStorage.getItem('pulseradar_local_rules_v2');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) return ensureAllPlatformRules(parsed);
      }
    } catch {
      // ignore
    }
    return INITIAL_KEYWORD_RULES;
  });

  const [servers, setServers] = useState<WebhookServerItem[]>(() => {
    try {
      const raw = localStorage.getItem('pulseradar_local_servers_v2');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {
      // ignore
    }
    return INITIAL_WEBHOOK_SERVERS;
  });

  const [alerts, setAlerts] = useState<AlertDetectionItem[]>(() => {
    try {
      const raw = localStorage.getItem('pulseradar_local_alerts_v2');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {
      // ignore
    }
    return INITIAL_ALERT_DETECTIONS;
  });

  const [sandboxReceipts, setSandboxReceipts] = useState<SandboxReceiptItem[]>([]);
  const [workspaceHydrated, setWorkspaceHydrated] = useState(false);
  const lastSyncedWorkspaceJsonRef = useRef<string | null>(null);
  const [androidStatus, setAndroidStatus] = useState<AndroidRuntimeStatus | null>(null);
  const [watcherStatus, setWatcherStatus] = useState<WatcherStatusData | null>(null);
  const [storageStatus, setStorageStatus] = useState<{
    googleDrive?: { enabled: boolean; configured: boolean; clientEmail?: string; folderId?: string; lastError?: string | null };
    telegram?: { enabled: boolean; configured: boolean; chatId?: string; lastError?: string | null };
    localStorageRoot?: string;
  } | null>(null);

  // Per-target stream subscription metadata (Live, Post, Story, Warmup)
  const [targetStreamMetaMap, setTargetStreamMetaMap] = useState<Record<string, TargetStreamMeta>>(() => {
    try {
      const raw = localStorage.getItem('pulseradar_target_stream_meta_v1');
      if (raw) return JSON.parse(raw);
    } catch {
      // ignore
    }
    return {};
  });

  // Inline add target state per platform
  const [inlineInputs, setInlineInputs] = useState<Record<string, string>>({});
  const [inlineTrackLive, setInlineTrackLive] = useState(true);
  const [inlineTrackPost, setInlineTrackPost] = useState(true);
  const [inlineTrackStory, setInlineTrackStory] = useState(true);
  const [inlineWarmup, setInlineWarmup] = useState(true);

  // Scanner state
  const [isScanning, setIsScanning] = useState(false);
  const [scanningTargetKey, setScanningTargetKey] = useState<string | null>(null);
  const [autoScanEnabled, setAutoScanEnabled] = useState(false);
  const [lastScanSummary, setLastScanSummary] = useState<string>(
    'Sẵn sàng quét Live, Post, Story thật · Chọn nền tảng để theo dõi tự động.'
  );
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [logScope, setLogScope] = useState<'platform' | 'all'>('platform');

  // Real-time live scan status map: key = `${ruleId}::${target}`
  const [liveStatusMap, setLiveStatusMap] = useState<Record<string, LiveTargetScanStatus>>({});
  const [copiedStreamKey, setCopiedStreamKey] = useState<string | null>(null);

  // Live Scanner Settings (Cookies & Poll Interval persisted locally)
  const [scannerSettings, setScannerSettings] = useState<LiveScannerSettings>(() => {
    try {
      const raw = localStorage.getItem('pulseradar_live_scanner_settings_v1');
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<LiveScannerSettings>;
        return {
          cookies: {
            tiktok: parsed.cookies?.tiktok || '',
            instagram: parsed.cookies?.instagram || '',
            facebook: parsed.cookies?.facebook || '',
            x: parsed.cookies?.x || '',
          },
          pollIntervalSeconds:
            typeof parsed.pollIntervalSeconds === 'number' && parsed.pollIntervalSeconds >= 10
              ? parsed.pollIntervalSeconds
              : 60,
          deduplicateLive: parsed.deduplicateLive ?? true,
          platforms: normalizeMultiPlatformSettings(parsed.platforms),
        };
      }
    } catch {
      // ignore
    }
    return {
      cookies: { tiktok: '', instagram: '', facebook: '', x: '' },
      pollIntervalSeconds: 60,
      deduplicateLive: true,
      platforms: normalizeMultiPlatformSettings(),
    };
  });

  // Modal visibility states
  const [isRuleModalOpen, setIsRuleModalOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<KeywordRuleItem | null>(null);
  const [isWebhookModalOpen, setIsWebhookModalOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<WebhookServerItem | null>(null);
  const [inspectingAlert, setInspectingAlert] = useState<AlertDetectionItem | null>(null);
  const [isCookieModalOpen, setIsCookieModalOpen] = useState(false);

  // Synchronize activeTab and selectedPlatform with URL hash and browser history (Back/Forward)
  useEffect(() => {
    const syncFromHash = () => {
      const nav = parseNavigationHash(window.location.hash);
      if (nav) {
        setActiveTab(nav.tab);
        if (nav.platform) {
          setSelectedPlatform(nav.platform);
        }
      }
    };

    window.addEventListener('hashchange', syncFromHash);
    syncFromHash();

    return () => {
      window.removeEventListener('hashchange', syncFromHash);
    };
  }, []);

  // Central tab navigation handler with URL hash synchronization
  const navigateToTab = (tab: ActiveTab, platform?: SocialPlatformKey) => {
    setActiveTab(tab);
    const p =
      platform ||
      (ALL_SOCIAL_PLATFORMS.includes(tab as SocialPlatformKey)
        ? (tab as SocialPlatformKey)
        : undefined);
    if (p) {
      setSelectedPlatform(p);
    }
    if (tab === 'activity') {
      setLogScope('all');
    }
    const targetHash = `#${tab}`;
    if (window.location.hash !== targetHash) {
      window.location.hash = targetHash;
    }
  };

  // Hydrate workspace state from local backend file
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/workspace-state');
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled || !data?.ok) return;
        const st = data.state;
        if (st && typeof st === 'object') {
          const rawRules =
            Array.isArray(st.rules) && st.rules.length > 0 ? st.rules : rules;
          const nextRules = ensureAllPlatformRules(rawRules);
          const nextServers =
            Array.isArray(st.servers) && st.servers.length > 0 ? st.servers : servers;
          const nextAlerts = Array.isArray(st.alerts) ? st.alerts : alerts;
          const nextScannerSettings: LiveScannerSettings =
            st.scannerSettings && typeof st.scannerSettings === 'object'
              ? {
                  cookies: {
                    tiktok: String(st.scannerSettings.cookies?.tiktok || ''),
                    instagram: String(st.scannerSettings.cookies?.instagram || ''),
                    facebook: String(st.scannerSettings.cookies?.facebook || ''),
                    x: String(st.scannerSettings.cookies?.x || ''),
                  },
                  pollIntervalSeconds:
                    typeof st.scannerSettings.pollIntervalSeconds === 'number' &&
                    st.scannerSettings.pollIntervalSeconds >= 10
                      ? st.scannerSettings.pollIntervalSeconds
                      : 60,
                  deduplicateLive: st.scannerSettings.deduplicateLive ?? true,
                  platforms: normalizeMultiPlatformSettings(st.scannerSettings.platforms),
                }
              : scannerSettings;

          lastSyncedWorkspaceJsonRef.current = JSON.stringify({
            rules: nextRules,
            servers: nextServers,
            alerts: nextAlerts.slice(0, 100),
            scannerSettings: nextScannerSettings,
          });

          setRules(nextRules);
          if (Array.isArray(st.servers) && st.servers.length > 0) {
            setServers(st.servers);
          }
          if (Array.isArray(st.alerts)) {
            setAlerts(st.alerts);
          }
          if (st.scannerSettings && typeof st.scannerSettings === 'object') {
            setScannerSettings(nextScannerSettings);
          }
        }
        if (!cancelled) setWorkspaceHydrated(true);
      } catch {
        // ignore transient errors
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist local state to localStorage + backend workspace-state file
  useEffect(() => {
    if (currentUser || !workspaceHydrated) return;
    try {
      localStorage.setItem('pulseradar_local_rules_v2', JSON.stringify(rules));
      localStorage.setItem('pulseradar_local_servers_v2', JSON.stringify(servers));
      localStorage.setItem('pulseradar_local_alerts_v2', JSON.stringify(alerts.slice(0, 100)));
      localStorage.setItem(
        'pulseradar_live_scanner_settings_v1',
        JSON.stringify(scannerSettings)
      );
    } catch {
      // ignore
    }

    const payloadJson = JSON.stringify({
      rules,
      servers,
      alerts: alerts.slice(0, 100),
      scannerSettings,
    });
    if (payloadJson === lastSyncedWorkspaceJsonRef.current) return;

    const timer = setTimeout(async () => {
      try {
        const res = await fetch('/api/workspace-state', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: payloadJson,
        });
        if (res.ok) {
          lastSyncedWorkspaceJsonRef.current = payloadJson;
        }
      } catch {
        // ignore network error
      }
    }, 400);

    return () => clearTimeout(timer);
  }, [rules, servers, alerts, scannerSettings, currentUser, workspaceHydrated]);

  // Firebase auth state
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, user => {
      setCurrentUser(user);
      setAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  // Firestore real-time listeners when logged in
  useEffect(() => {
    if (!currentUser) return;
    const rulesQuery = query(
      collection(db, 'keyword_rules'),
      where('ownerId', '==', currentUser.uid)
    );
    const unsubsRules = onSnapshot(
      rulesQuery,
      snapshot => {
        const items: KeywordRuleItem[] = [];
        snapshot.forEach(docSnap => {
          const d = docSnap.data();
          items.push({
            id: docSnap.id,
            ownerId: d.ownerId,
            keyword: d.keyword || '',
            excludedKeywords: d.excludedKeywords || '',
            matchType: d.matchType || 'contains',
            platforms: d.platforms || 'reddit',
            webhookServerId: d.webhookServerId || '',
            enabled: d.enabled ?? true,
            matchCount: d.matchCount || 0,
            createdAt: toIsoString(d.createdAt),
            updatedAt: toIsoString(d.updatedAt),
          });
        });
        if (items.length > 0) setRules(items);
      },
      err => handleFirestoreError(err, OperationType.LIST, 'keyword_rules')
    );

    const serversQuery = query(
      collection(db, 'webhook_servers'),
      where('ownerId', '==', currentUser.uid)
    );
    const unsubsServers = onSnapshot(
      serversQuery,
      snapshot => {
        const items: WebhookServerItem[] = [];
        snapshot.forEach(docSnap => {
          const d = docSnap.data();
          items.push({
            id: docSnap.id,
            ownerId: d.ownerId,
            name: d.name || '',
            url: d.url || '',
            format: d.format || 'json',
            secretHeader: d.secretHeader || '',
            enabled: d.enabled ?? true,
            createdAt: toIsoString(d.createdAt),
            updatedAt: toIsoString(d.updatedAt),
          });
        });
        if (items.length > 0) setServers(items);
      },
      err => handleFirestoreError(err, OperationType.LIST, 'webhook_servers')
    );

    const alertsQuery = query(
      collection(db, 'alert_detections'),
      where('ownerId', '==', currentUser.uid)
    );
    const unsubsAlerts = onSnapshot(
      alertsQuery,
      snapshot => {
        const items: AlertDetectionItem[] = [];
        snapshot.forEach(docSnap => {
          const d = docSnap.data();
          items.push({
            id: docSnap.id,
            ownerId: d.ownerId,
            ruleId: d.ruleId || '',
            keyword: d.keyword || '',
            platform: d.platform || 'reddit',
            author: d.author || '',
            title: d.title || '',
            contentSnippet: d.contentSnippet || '',
            sourceUrl: d.sourceUrl || '',
            webhookServerName: d.webhookServerName || '',
            webhookStatus: d.webhookStatus || 'delivered',
            httpStatusCode: d.httpStatusCode || 200,
            latencyMs: d.latencyMs || 0,
            payloadJson: d.payloadJson || '{}',
            createdAt: toIsoString(d.createdAt),
            updatedAt: toIsoString(d.updatedAt),
          });
        });
        items.sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
        setAlerts(items);
      },
      err => handleFirestoreError(err, OperationType.LIST, 'alert_detections')
    );

    return () => {
      unsubsRules();
      unsubsServers();
      unsubsAlerts();
    };
  }, [currentUser]);

  // Fetch sandbox receipts
  const fetchSandboxLogs = useCallback(async () => {
    try {
      const res = await fetch('/api/webhook-sandbox/logs');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.receipts)) {
          setSandboxReceipts(data.receipts);
        }
      }
    } catch {
      // ignore
    }
  }, []);

  // Fetch Android status
  const fetchAndroidStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/android/status');
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data === 'object') {
          setAndroidStatus(data as AndroidRuntimeStatus);
        }
      }
    } catch {
      // ignore
    }
  }, []);

  // Fetch Watcher Status (health, warmup states, dedup metrics)
  const fetchWatcherStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/watcher/status');
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data === 'object' && data.success) {
          setWatcherStatus(data as WatcherStatusData);
        }
      }
    } catch {
      // ignore
    }
  }, []);

  // Fetch Cloud Storage Status (Google Drive API & Telegram)
  const fetchStorageStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/storage/status');
      if (res.ok) {
        const data = await res.json();
        if (data && data.ok && data.status) {
          setStorageStatus(data.status);
        }
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchSandboxLogs();
    fetchAndroidStatus();
    fetchWatcherStatus();
    fetchStorageStatus();
    const timer = setInterval(() => {
      void fetchAndroidStatus();
      void fetchWatcherStatus();
      void fetchStorageStatus();
    }, 10000);
    return () => clearInterval(timer);
  }, [fetchSandboxLogs, fetchAndroidStatus, fetchWatcherStatus, fetchStorageStatus]);

  // Execute a real live scan or activity event
  const runSocialScan = useCallback(
    async (options?: {
      injectedText?: string;
      specificRule?: KeywordRuleItem;
      specificTargets?: string[];
      activityType?: ActivityEventType;
      isAutoScan?: boolean;
    }) => {
      if (isScanning) return;
      const targetRules = options?.specificRule
        ? [options.specificRule]
        : rules.filter(r => r.enabled);

      if (targetRules.length === 0) {
        setLastScanSummary(
          'Không có Trang Web Nguồn nào đang bật. Vui lòng bật hoặc thêm nguồn mới.'
        );
        return;
      }

      const totalLiveTargetsToCheck = options?.specificTargets?.length
        ? options.specificTargets.length
        : targetRules.reduce((sum, r) => sum + parseTrackedTargets(r.keyword).length, 0);

      if (!options?.injectedText && totalLiveTargetsToCheck === 0) {
        setLastScanSummary(
          'Chưa có kênh (@username hoặc URL) nào được thêm vào danh sách theo dõi. Hãy thêm kênh trước khi quét.'
        );
        return;
      }

      const isSingleTargetScan =
        Boolean(options?.specificRule) &&
        Array.isArray(options?.specificTargets) &&
        options.specificTargets.length === 1;
      const singleKey = isSingleTargetScan
        ? `${options!.specificRule!.id}::${options!.specificTargets![0]}`
        : null;

      setIsScanning(true);
      setScanningTargetKey(singleKey);

      const effectiveInjectedText =
        options?.injectedText !== undefined ? options.injectedText : '';

      setLastScanSummary(
        effectiveInjectedText
          ? `Đang gửi sự kiện [${(options?.activityType || 'post').toUpperCase()}] về máy chủ Webhook...`
          : singleKey
          ? `Đang quét trạng thái Live thật cho ${options!.specificTargets![0]}...`
          : `Đang quét trạng thái Live thật trên ${targetRules.length} Trang Nguồn (TikTok / Instagram / Facebook / X)...`
      );

      try {
        const res = await fetch('/api/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            rules: targetRules.map(r => ({ ...r, enabled: true })),
            servers,
            cookies: scannerSettings.cookies,
            specificTargets: options?.specificTargets,
            customSampleText: effectiveInjectedText,
            simulatedActivityType: options?.activityType,
            isAutoScan: Boolean(options?.isAutoScan),
            deduplicateLive: scannerSettings.deduplicateLive,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          throw new Error(data.error || 'Quá trình quét gặp lỗi.');
        }

        const returnedStatuses: LiveTargetScanStatus[] = Array.isArray(data.liveStatuses)
          ? data.liveStatuses
          : [];
        if (returnedStatuses.length > 0) {
          setLiveStatusMap(prev => {
            const next = { ...prev };
            for (const st of returnedStatuses) {
              next[`${st.ruleId}::${st.target}`] = st;
            }
            return next;
          });
        }

        const newDetections: AlertDetectionItem[] = (data.detections || []).map(
          (det: Record<string, unknown>, idx: number) => ({
            id: `alert_${Date.now()}_${idx}`,
            ownerId: currentUser?.uid || 'demo_user',
            ruleId: String(det.ruleId || ''),
            keyword: String(det.keyword || ''),
            platform: (det.platform as SocialPlatform) || 'reddit',
            author: String(det.author || 'creator'),
            title: String(det.title || ''),
            contentSnippet: String(det.contentSnippet || ''),
            sourceUrl: String(det.sourceUrl || ''),
            webhookServerName: String(det.webhookServerName || 'Webhook Server'),
            webhookStatus: (det.webhookStatus as 'delivered' | 'failed') || 'delivered',
            httpStatusCode: Number(det.httpStatusCode || 200),
            latencyMs: Number(det.latencyMs || 0),
            payloadJson: String(det.payloadJson || '{}'),
            createdAt: String(det.detectedAt || new Date().toISOString()),
            updatedAt: String(det.detectedAt || new Date().toISOString()),
          })
        );

        if (newDetections.length > 0) {
          setAlerts(prev => [...newDetections, ...prev].slice(0, 200));
        }

        const liveFoundCount = returnedStatuses.filter(s => s.status === 'LIVE').length;
        setLastScanSummary(
          `Quét hoàn tất: Kiểm tra ${returnedStatuses.length} kênh · ${
            liveFoundCount > 0 ? `🔥 Phát hiện ${liveFoundCount} user ĐANG LIVE` : 'Hiện không có kênh nào đang Live'
          } · ${newDetections.length} Alert Webhook đã bắn.`
        );

        void fetchSandboxLogs();
        void fetchWatcherStatus();
      } catch (err) {
        setLastScanSummary(
          `Quét thất bại: ${err instanceof Error ? err.message : 'Lỗi kết nối bộ quét'}`
        );
      } finally {
        setIsScanning(false);
        setScanningTargetKey(null);
      }
    },
    [isScanning, rules, servers, scannerSettings, currentUser, fetchSandboxLogs, fetchWatcherStatus]
  );

  // Background Auto-Scan ticker when serverAutoScanManaged is not active
  const serverAutoScanManaged = Boolean(androidStatus?.scanner?.enabled);
  useEffect(() => {
    if (!autoScanEnabled || serverAutoScanManaged) return;
    const intervalSec = Math.max(scannerSettings.pollIntervalSeconds || 60, 10);
    const timer = setInterval(() => {
      void runSocialScan({ isAutoScan: true });
    }, intervalSec * 1000);
    return () => clearInterval(timer);
  }, [
    autoScanEnabled,
    serverAutoScanManaged,
    scannerSettings.pollIntervalSeconds,
    runSocialScan,
  ]);

  // Copy Stream URL to clipboard
  const handleCopyStreamUrl = async (targetKey: string, url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedStreamKey(targetKey);
      setTimeout(() => setCopiedStreamKey(null), 2500);
    } catch {
      // fallback
    }
  };

  // Toggle stream subscription for a specific target
  const handleToggleStreamSubscription = (
    targetKey: string,
    stream: 'live' | 'post' | 'story' | 'warmup'
  ) => {
    setTargetStreamMetaMap(prev => {
      const current = prev[targetKey] || { live: true, post: true, story: true, warmup: true };
      const nextMeta = { ...current, [stream]: !current[stream] };
      const nextMap = { ...prev, [targetKey]: nextMeta };
      try {
        localStorage.setItem('pulseradar_target_stream_meta_v1', JSON.stringify(nextMap));
      } catch {
        // ignore
      }
      return nextMap;
    });
  };

  // Save or update a Keyword Rule
  const handleSaveRule = async (data: {
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
  }) => {
    const nowIso = new Date().toISOString();
    const primaryPlatform = (data.platforms[0] || 'reddit') as SocialPlatform;
    const platformKey = PLATFORM_TO_SOCIAL_KEY[primaryPlatform] || 'tiktok';

    // If intervals provided, update multi-platform settings
    if (data.intervals) {
      const norm = normalizeMultiPlatformSettings(scannerSettings.platforms);
      const updated = {
        ...norm,
        [platformKey]: {
          ...norm[platformKey],
          liveIntervalSeconds: data.intervals.live ?? norm[platformKey].liveIntervalSeconds,
          postIntervalSeconds: data.intervals.post ?? norm[platformKey].postIntervalSeconds,
          storyIntervalSeconds: data.intervals.story ?? norm[platformKey].storyIntervalSeconds,
        },
      };
      setScannerSettings(prev => ({
        ...prev,
        platforms: updated,
      }));
    }

    // Determine consistent rule ID for metadata mapping and persistence
    const effectiveRuleId = data.id || `rule_${Date.now()}`;

    // Save target stream subscriptions
    if (data.streamSubscriptions) {
      const targets = parseTrackedTargets(data.keyword);
      setTargetStreamMetaMap(prev => {
        const nextMap = { ...prev };
        for (const t of targets) {
          const key = `${effectiveRuleId}::${t}`;
          nextMap[key] = {
            live: data.streamSubscriptions!.live,
            post: data.streamSubscriptions!.post,
            story: data.streamSubscriptions!.story,
            warmup: data.warmup ?? true,
          };
        }
        try {
          localStorage.setItem('pulseradar_target_stream_meta_v1', JSON.stringify(nextMap));
        } catch {
          // ignore
        }
        return nextMap;
      });
    }

    if (currentUser) {
      const ruleId = effectiveRuleId;
      if (data.id) {
        try {
          await updateDoc(doc(db, 'keyword_rules', ruleId), {
            keyword: data.keyword.slice(0, 4000),
            excludedKeywords: data.excludedKeywords.slice(0, 250),
            matchType: data.matchType,
            platforms: data.platforms[0] || 'reddit',
            webhookServerId: data.webhookServerId,
            enabled: data.enabled,
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, `keyword_rules/${ruleId}`);
        }
      } else {
        try {
          await setDoc(doc(db, 'keyword_rules', ruleId), {
            ownerId: currentUser.uid,
            keyword: data.keyword.slice(0, 4000),
            excludedKeywords: data.excludedKeywords.slice(0, 250),
            matchType: data.matchType,
            platforms: data.platforms[0] || 'reddit',
            webhookServerId: data.webhookServerId,
            enabled: data.enabled,
            matchCount: 0,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.CREATE, `keyword_rules/${ruleId}`);
        }
      }
    } else if (data.id) {
      setRules(prev => {
        const idx = prev.findIndex(r => r.id === data.id);
        if (idx >= 0) {
          return prev.map((r, i) =>
            i === idx
              ? {
                  ...r,
                  keyword: data.keyword.slice(0, 4000),
                  excludedKeywords: data.excludedKeywords.slice(0, 250),
                  matchType: data.matchType,
                  platforms: data.platforms[0] || 'reddit',
                  webhookServerId: data.webhookServerId,
                  enabled: data.enabled,
                  updatedAt: nowIso,
                }
              : r
          );
        } else {
          const newRule: KeywordRuleItem = {
            id: data.id || effectiveRuleId,
            ownerId: 'demo_user',
            keyword: data.keyword.slice(0, 4000),
            excludedKeywords: data.excludedKeywords.slice(0, 250),
            matchType: data.matchType,
            platforms: data.platforms[0] || 'reddit',
            webhookServerId: data.webhookServerId,
            enabled: data.enabled,
            matchCount: 0,
            createdAt: nowIso,
            updatedAt: nowIso,
          };
          return [...prev, newRule];
        }
      });
    } else {
      const newRule: KeywordRuleItem = {
        id: effectiveRuleId,
        ownerId: 'demo_user',
        keyword: data.keyword.slice(0, 4000),
        excludedKeywords: data.excludedKeywords.slice(0, 250),
        matchType: data.matchType,
        platforms: data.platforms[0] || 'reddit',
        webhookServerId: data.webhookServerId,
        enabled: data.enabled,
        matchCount: 0,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      setRules(prev => [newRule, ...prev]);
    }
  };

  // Inline add a @username or URL to a platform's rule
  const handleInlineAddTarget = async (rule: KeywordRuleItem) => {
    const rawVal = (inlineInputs[rule.id] || '').trim();
    if (!rawVal) return;

    const platformKey = selectedPlatform;
    const targetPlatform = SOCIAL_KEY_TO_PLATFORM[platformKey];
    const defaultDomain = SOURCE_DEFAULT_DOMAINS[targetPlatform];

    // Check if the passed rule actually belongs to the selected platform and exists in rules
    const ruleExists = rules.some(
      r => r.id === rule.id && getPlatformKeyForRule(r) === platformKey
    );
    const targetRuleId = ruleExists
      ? rule.id
      : rule.id.startsWith(`rule_${platformKey}`)
      ? rule.id
      : `rule_${platformKey}_source`;

    const currentTargets = ruleExists ? parseTrackedTargets(rule.keyword) : [];
    const newItems = rawVal
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    const merged = Array.from(new Set([...currentTargets, ...newItems]));
    const updatedKeywordStr = merged.join(', ').slice(0, 4000);

    setInlineInputs(prev => ({ ...prev, [rule.id]: '' }));

    // Store metadata for added targets
    setTargetStreamMetaMap(prev => {
      const next = { ...prev };
      for (const item of newItems) {
        next[`${targetRuleId}::${item}`] = {
          live: inlineTrackLive,
          post: inlineTrackPost,
          story: inlineTrackStory,
          warmup: inlineWarmup,
        };
      }
      try {
        localStorage.setItem('pulseradar_target_stream_meta_v1', JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });

    await handleSaveRule({
      id: targetRuleId,
      keyword: updatedKeywordStr,
      excludedKeywords: ruleExists ? rule.excludedKeywords : `${defaultDomain} |`,
      matchType: ruleExists ? rule.matchType : 'contains',
      platforms: [targetPlatform],
      webhookServerId: ruleExists ? rule.webhookServerId : (servers[0]?.id || 'srv_sandbox_local'),
      enabled: ruleExists ? rule.enabled : true,
    });
  };

  // Inline remove a target from a rule
  const handleInlineRemoveTarget = async (rule: KeywordRuleItem, targetToRemove: string) => {
    const currentTargets = parseTrackedTargets(rule.keyword);
    const nextTargets = currentTargets.filter(t => t !== targetToRemove);
    if (currentUser && nextTargets.length === 0) {
      return;
    }
    setLiveStatusMap(prev => {
      const next = { ...prev };
      delete next[`${rule.id}::${targetToRemove}`];
      return next;
    });
    setTargetStreamMetaMap(prev => {
      const next = { ...prev };
      delete next[`${rule.id}::${targetToRemove}`];
      try {
        localStorage.setItem('pulseradar_target_stream_meta_v1', JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
    await handleSaveRule({
      id: rule.id,
      keyword: nextTargets.join(', '),
      excludedKeywords: rule.excludedKeywords,
      matchType: rule.matchType,
      platforms: [(rule.platforms.split(',')[0]?.trim() as SocialPlatform) || 'reddit'],
      webhookServerId: rule.webhookServerId,
      enabled: rule.enabled,
    });
  };

  const handleToggleRule = async (rule: KeywordRuleItem) => {
    const nextEnabled = !rule.enabled;
    if (currentUser) {
      try {
        await updateDoc(doc(db, 'keyword_rules', rule.id), {
          enabled: nextEnabled,
          matchCount: rule.matchCount,
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `keyword_rules/${rule.id}`);
      }
    } else {
      setRules(prev =>
        prev.map(r =>
          r.id === rule.id
            ? { ...r, enabled: nextEnabled, updatedAt: new Date().toISOString() }
            : r
        )
      );
    }
  };

  const handleDeleteRule = async (rule: KeywordRuleItem) => {
    if (currentUser) {
      try {
        await deleteDoc(doc(db, 'keyword_rules', rule.id));
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, `keyword_rules/${rule.id}`);
      }
    } else {
      setRules(prev => prev.filter(r => r.id !== rule.id));
    }
  };

  // Save or update a Webhook Server
  const handleSaveServer = async (input: {
    id?: string;
    name: string;
    url: string;
    format: WebhookFormat;
    secretHeader: string;
    enabled: boolean;
  }) => {
    const nowIso = new Date().toISOString();
    if (currentUser) {
      const serverId = input.id || `srv_${Date.now()}`;
      if (input.id) {
        try {
          await updateDoc(doc(db, 'webhook_servers', serverId), {
            name: input.name.slice(0, 80),
            url: input.url.slice(0, 500),
            format: input.format,
            secretHeader: input.secretHeader.slice(0, 128),
            enabled: input.enabled,
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, `webhook_servers/${serverId}`);
        }
      } else {
        try {
          await setDoc(doc(db, 'webhook_servers', serverId), {
            ownerId: currentUser.uid,
            name: input.name.slice(0, 80),
            url: input.url.slice(0, 500),
            format: input.format,
            secretHeader: input.secretHeader.slice(0, 128),
            enabled: input.enabled,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.CREATE, `webhook_servers/${serverId}`);
        }
      }
    } else if (input.id) {
      setServers(prev =>
        prev.map(s =>
          s.id === input.id
            ? {
                ...s,
                name: input.name.slice(0, 80),
                url: input.url.slice(0, 500),
                format: input.format,
                secretHeader: input.secretHeader.slice(0, 128),
                enabled: input.enabled,
                updatedAt: nowIso,
              }
            : s
        )
      );
    } else {
      const newServer: WebhookServerItem = {
        id: `srv_${Date.now()}`,
        ownerId: 'demo_user',
        name: input.name.slice(0, 80),
        url: input.url.slice(0, 500),
        format: input.format,
        secretHeader: input.secretHeader.slice(0, 128),
        enabled: input.enabled,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      setServers(prev => [newServer, ...prev]);
    }
  };

  const handleToggleServer = async (server: WebhookServerItem) => {
    const nextEnabled = !server.enabled;
    if (currentUser) {
      try {
        await updateDoc(doc(db, 'webhook_servers', server.id), {
          enabled: nextEnabled,
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `webhook_servers/${server.id}`);
      }
    } else {
      setServers(prev =>
        prev.map(s =>
          s.id === server.id
            ? { ...s, enabled: nextEnabled, updatedAt: new Date().toISOString() }
            : s
        )
      );
    }
  };

  const handleDeleteServer = async (server: WebhookServerItem) => {
    if (currentUser) {
      try {
        await deleteDoc(doc(db, 'webhook_servers', server.id));
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, `webhook_servers/${server.id}`);
      }
    } else {
      setServers(prev => prev.filter(s => s.id !== server.id));
    }
  };

  const handleSaveScannerSettings = (next: LiveScannerSettings) => {
    setScannerSettings(next);
    try {
      localStorage.setItem('pulseradar_live_scanner_settings_v1', JSON.stringify(next));
    } catch {
      // ignore
    }
  };

  const handleRetryWebhook = async (alertItem: AlertDetectionItem) => {
    try {
      let parsedPayload: Record<string, unknown> = {};
      try {
        parsedPayload = JSON.parse(alertItem.payloadJson);
      } catch {
        parsedPayload = { raw: alertItem.payloadJson };
      }

      const res = await fetch('/api/webhook/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverName: alertItem.webhookServerName,
          payload: parsedPayload,
          format: 'json',
        }),
      });
      const data = await res.json();
      const updatedStatus = data.ok ? 'delivered' : 'failed';
      const updatedStatusCode = data.status || (data.ok ? 200 : 502);

      setAlerts(prev =>
        prev.map(a =>
          a.id === alertItem.id
            ? {
                ...a,
                webhookStatus: updatedStatus,
                httpStatusCode: updatedStatusCode,
                updatedAt: new Date().toISOString(),
              }
            : a
        )
      );

      if (inspectingAlert && inspectingAlert.id === alertItem.id) {
        setInspectingAlert(prev =>
          prev
            ? {
                ...prev,
                webhookStatus: updatedStatus,
                httpStatusCode: updatedStatusCode,
                updatedAt: new Date().toISOString(),
              }
            : null
        );
      }
    } catch (err) {
      alert(`Không thể gửi lại Request: ${err instanceof Error ? err.message : 'Lỗi mạng'}`);
    }
  };

  // Configured cookie count
  const configuredCookieCount = [
    scannerSettings.cookies.tiktok,
    scannerSettings.cookies.instagram,
    scannerSettings.cookies.facebook,
    scannerSettings.cookies.x,
  ].filter(c => Boolean(c && c.trim())).length;

  // Multi-platform statistics
  const platformList: SocialPlatformKey[] = ['tiktok', 'instagram', 'facebook', 'x'];

  const platformTargetMap: Record<SocialPlatformKey, Array<{ rule: KeywordRuleItem; target: string }>> = {
    tiktok: [],
    instagram: [],
    facebook: [],
    x: [],
  };

  for (const rule of rules) {
    const pKey = getPlatformKeyForRule(rule);
    const targets = parseTrackedTargets(rule.keyword);
    for (const t of targets) {
      platformTargetMap[pKey].push({ rule, target: t });
    }
  }

  const platformLiveCounts: Record<SocialPlatformKey, number> = {
    tiktok: platformTargetMap.tiktok.filter(
      item => liveStatusMap[`${item.rule.id}::${item.target}`]?.status === 'LIVE'
    ).length,
    instagram: platformTargetMap.instagram.filter(
      item => liveStatusMap[`${item.rule.id}::${item.target}`]?.status === 'LIVE'
    ).length,
    facebook: platformTargetMap.facebook.filter(
      item => liveStatusMap[`${item.rule.id}::${item.target}`]?.status === 'LIVE'
    ).length,
    x: platformTargetMap.x.filter(
      item => liveStatusMap[`${item.rule.id}::${item.target}`]?.status === 'LIVE'
    ).length,
  };

  // Selected Platform Rule & Targets
  const activePlatformRules = rules.filter(r => getPlatformKeyForRule(r) === selectedPlatform);
  const activePlatformRule: KeywordRuleItem =
    activePlatformRules[0] ||
    rules.find(r => r.id === `rule_${selectedPlatform}_source`) ||
    INITIAL_KEYWORD_RULES.find(r => getPlatformKeyForRule(r) === selectedPlatform) ||
    INITIAL_KEYWORD_RULES[0];

  const activePlatformTargets = platformTargetMap[selectedPlatform];
  const activePlatformLiveCount = platformLiveCounts[selectedPlatform];

  // Normalized Platform Tracking Config
  const multiSettings = normalizeMultiPlatformSettings(scannerSettings.platforms);
  const currentPlatformConfig = multiSettings[selectedPlatform];

  // Cookie check for story collector on current platform
  const hasPlatformCookie = (() => {
    switch (selectedPlatform) {
      case 'tiktok':
        return Boolean(scannerSettings.cookies.tiktok.trim());
      case 'instagram':
        return Boolean(scannerSettings.cookies.instagram.trim());
      case 'facebook':
        return Boolean(scannerSettings.cookies.facebook.trim());
      case 'x':
        return Boolean(scannerSettings.cookies.x.trim());
    }
  })();

  // Platform collector health from watcher status
  const collectorHealth = watcherStatus?.health || {};
  const currentLiveHealth = collectorHealth[`${selectedPlatform}_live`];
  const currentPostHealth = collectorHealth[`${selectedPlatform}_post`];
  const currentStoryHealth = collectorHealth[`${selectedPlatform}_story`];

  // KPI Overall Metrics
  const totalTrackedTargetsCount = Object.values(platformTargetMap).reduce(
    (sum, arr) => sum + arr.length,
    0
  );
  const totalLiveNowCount = Object.values(platformLiveCounts).reduce(
    (sum, cnt) => sum + cnt,
    0
  );
  const deliveredCount = alerts.filter(a => a.webhookStatus === 'delivered').length;
  const avgLatencyMs =
    alerts.length > 0
      ? Math.round(alerts.reduce((acc, a) => acc + (a.latencyMs || 0), 0) / alerts.length)
      : 0;

  // Filtered alerts
  const filteredAlerts = alerts.filter(item => {
    if (logScope === 'platform') {
      const targetPlatform = SOCIAL_KEY_TO_PLATFORM[selectedPlatform];
      if (item.platform !== targetPlatform) return false;
    }
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      item.author.toLowerCase().includes(q) ||
      item.keyword.toLowerCase().includes(q) ||
      item.title.toLowerCase().includes(q) ||
      item.contentSnippet.toLowerCase().includes(q)
    );
  });

  const isPlatformView =
    activeTab === 'tiktok' ||
    activeTab === 'instagram' ||
    activeTab === 'facebook' ||
    activeTab === 'x' ||
    activeTab === 'overview' ||
    activeTab === 'rules';

  return (
    <div className="min-h-screen bg-[#060911] text-slate-100 flex flex-col pb-20 md:pb-0">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="bg-[#0B0F1A]/95 backdrop-blur-md border-b border-slate-800/80 px-4 sm:px-6 py-3.5 flex items-center justify-between gap-4 sm:gap-8">
        {/* Zone 1: Single text element Brand Wordmark */}
        <a
          href="#tiktok"
          onClick={e => {
            e.preventDefault();
            navigateToTab('tiktok', 'tiktok');
          }}
          className="min-h-[44px] md:min-h-0 inline-flex items-center gap-2 text-lg font-bold tracking-tight text-slate-100 whitespace-nowrap shrink-0"
        >
          <span className="w-2.5 h-2.5 rounded-full bg-indigo-500 shadow-xs" />
          PulseRadar
        </a>

        {/* Zone 2: Dedicated Navigation Links separating all 4 Platforms + Servers + Sandbox */}
        <nav
          aria-label="Điều hướng chính"
          className="hidden md:flex items-center gap-4 lg:gap-6 text-sm font-medium text-slate-400"
        >
          <a
            href="#tiktok"
            onClick={e => {
              e.preventDefault();
              navigateToTab('tiktok', 'tiktok');
            }}
            className={`py-1 md:min-h-[36px] transition-colors whitespace-nowrap shrink-0 inline-flex items-center gap-1.5 ${
              (activeTab === 'tiktok' || (isPlatformView && selectedPlatform === 'tiktok'))
                ? 'text-cyan-400 font-bold underline underline-offset-8 decoration-2'
                : 'hover:text-slate-100'
            }`}
          >
            <span>TikTok</span>
            {platformLiveCounts.tiktok > 0 && (
              <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse" />
            )}
          </a>

          <a
            href="#instagram"
            onClick={e => {
              e.preventDefault();
              navigateToTab('instagram', 'instagram');
            }}
            className={`py-1 md:min-h-[36px] transition-colors whitespace-nowrap shrink-0 inline-flex items-center gap-1.5 ${
              (activeTab === 'instagram' || (isPlatformView && selectedPlatform === 'instagram'))
                ? 'text-fuchsia-400 font-bold underline underline-offset-8 decoration-2'
                : 'hover:text-slate-100'
            }`}
          >
            <span>Instagram</span>
            {platformLiveCounts.instagram > 0 && (
              <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse" />
            )}
          </a>

          <a
            href="#facebook"
            onClick={e => {
              e.preventDefault();
              navigateToTab('facebook', 'facebook');
            }}
            className={`py-1 md:min-h-[36px] transition-colors whitespace-nowrap shrink-0 inline-flex items-center gap-1.5 ${
              (activeTab === 'facebook' || (isPlatformView && selectedPlatform === 'facebook'))
                ? 'text-blue-400 font-bold underline underline-offset-8 decoration-2'
                : 'hover:text-slate-100'
            }`}
          >
            <span>Facebook</span>
            {platformLiveCounts.facebook > 0 && (
              <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse" />
            )}
          </a>

          <a
            href="#x"
            onClick={e => {
              e.preventDefault();
              navigateToTab('x', 'x');
            }}
            className={`py-1 md:min-h-[36px] transition-colors whitespace-nowrap shrink-0 inline-flex items-center gap-1.5 ${
              (activeTab === 'x' || (isPlatformView && selectedPlatform === 'x'))
                ? 'text-slate-100 font-bold underline underline-offset-8 decoration-2'
                : 'hover:text-slate-100'
            }`}
          >
            <span>X (Twitter)</span>
            {platformLiveCounts.x > 0 && (
              <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse" />
            )}
          </a>

          <div className="w-px h-4 bg-slate-800" />

          <a
            href="#activity"
            onClick={e => {
              e.preventDefault();
              navigateToTab('activity');
            }}
            className={`py-1 md:min-h-[36px] inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'activity'
                ? 'text-emerald-400 font-semibold underline underline-offset-8 decoration-2'
                : 'hover:text-slate-100'
            }`}
          >
            <Activity className="w-3.5 h-3.5 text-emerald-400" />
            <span>Lịch Sử Hoạt Động</span>
          </a>

          <a
            href="#servers"
            onClick={e => {
              e.preventDefault();
              navigateToTab('servers');
            }}
            className={`py-1 md:min-h-[36px] inline-flex items-center transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'servers'
                ? 'text-indigo-400 font-semibold underline underline-offset-8 decoration-2'
                : 'hover:text-slate-100'
            }`}
          >
            Máy Chủ Xử Lý
          </a>

          <a
            href="#sandbox"
            onClick={e => {
              e.preventDefault();
              navigateToTab('sandbox');
            }}
            className={`py-1 md:min-h-[36px] inline-flex items-center transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'sandbox'
                ? 'text-indigo-400 font-semibold underline underline-offset-8 decoration-2'
                : 'hover:text-slate-100'
            }`}
          >
            Request Đã Nhận
          </a>
        </nav>

        {/* Zone 3: 1 Primary Action */}
        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={() => runSocialScan()}
            disabled={isScanning}
            className="min-h-[44px] md:min-h-[38px] inline-flex items-center gap-2 px-3.5 sm:px-4 py-2 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-500 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0"
          >
            {isScanning ? (
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Play className="w-3.5 h-3.5" />
            )}
            <span className="hidden sm:inline">
              {isScanning ? 'Đang quét tất cả...' : 'Quét tất cả nguồn ngay'}
            </span>
            <span className="sm:hidden">
              {isScanning ? 'Đang quét...' : 'Quét ngay'}
            </span>
          </button>
        </div>
      </header>

      {/* Workspace Control & Cloud Sync Bar */}
      <div className="bg-[#090D16] border-b border-slate-800/70 px-4 sm:px-6 py-2.5">
        <div className="max-w-7xl mx-auto flex flex-col lg:flex-row lg:items-center lg:justify-between gap-2.5">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span className="font-semibold text-slate-200">Trạng thái Bot:</span>
            <span className="leading-relaxed">{lastScanSummary}</span>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 min-w-0">
            <button
              type="button"
              onClick={() => setIsCookieModalOpen(true)}
              className={`min-h-[44px] md:min-h-[36px] inline-flex items-center gap-1.5 px-3 py-2 md:py-1.5 text-xs font-medium rounded-lg border transition-colors max-w-full whitespace-normal text-left sm:whitespace-nowrap shrink-0 ${
                configuredCookieCount > 0
                  ? 'border-indigo-500/50 bg-indigo-500/15 text-indigo-200'
                  : 'border-slate-800 bg-slate-900 text-slate-300 hover:border-slate-700 hover:text-slate-100'
              }`}
            >
              <KeyRound className="w-3.5 h-3.5 shrink-0" />
              Chu kỳ & Cookie ({configuredCookieCount > 0 ? `${configuredCookieCount} Cookie` : 'Mặc định ẩn danh'})
            </button>

            {serverAutoScanManaged ? (
              <InfoPopover
                placement="popover"
                align="left"
                ariaLabel="Xem chi tiết trạng thái Server Auto-Scan"
                title="Server Auto-Scan"
                triggerClassName="min-h-[44px] md:min-h-[36px] px-3 py-2 md:py-1.5 text-xs font-medium rounded-lg border border-emerald-500/50 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/20 max-w-full whitespace-normal text-left sm:whitespace-nowrap"
                trigger={
                  <>
                    <Radio
                      className={`w-3.5 h-3.5 shrink-0 ${
                        androidStatus?.scanner.scanning ? 'animate-pulse' : ''
                      }`}
                    />
                    <span>
                      Server Auto-Scan: Bật (
                      {androidStatus?.scanner.pollIntervalSeconds ?? scannerSettings.pollIntervalSeconds}
                      s)
                      {androidStatus?.scanner.scanning ? ' · Đang quét...' : ''}
                      {(androidStatus?.scanner.activeLiveCount ?? 0) > 0
                        ? ` · ${androidStatus?.scanner.activeLiveCount} Live`
                        : ''}
                    </span>
                    <Info className="w-3.5 h-3.5 opacity-75 shrink-0" />
                  </>
                }
              >
                <div className="space-y-1">
                  <p>
                    {androidStatus?.scanner.lastScanAt
                      ? `Lần quét server gần nhất: ${formatTimestamp(androidStatus.scanner.lastScanAt)}`
                      : 'Máy chủ đang tự động quét Live theo chu kỳ.'}
                  </p>
                  <p className="text-slate-400 font-mono text-[11px]">
                    Chu kỳ: {androidStatus?.scanner.pollIntervalSeconds ?? scannerSettings.pollIntervalSeconds}s · Đang phát Live: {androidStatus?.scanner.activeLiveCount ?? 0}
                  </p>
                </div>
              </InfoPopover>
            ) : (
              <button
                type="button"
                onClick={() => setAutoScanEnabled(prev => !prev)}
                className={`min-h-[44px] md:min-h-[36px] inline-flex items-center gap-1.5 px-3 py-2 md:py-1.5 text-xs font-medium rounded-lg border transition-colors max-w-full whitespace-normal text-left sm:whitespace-nowrap shrink-0 ${
                  autoScanEnabled
                    ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
                    : 'border-slate-800 bg-slate-900 text-slate-300 hover:border-slate-700 hover:text-slate-100'
                }`}
              >
                <Clock className="w-3.5 h-3.5 shrink-0" />
                {autoScanEnabled
                  ? `Quét tự động: Bật (${scannerSettings.pollIntervalSeconds}s)`
                  : `Bật quét tự động (${scannerSettings.pollIntervalSeconds}s)`}
              </button>
            )}

            <InfoPopover
              placement="popover"
              align="right"
              ariaLabel="Xem chi tiết trạng thái kết nối Android"
              title="Thiết bị Android StreamRecorder"
              triggerClassName={`min-h-[44px] md:min-h-[36px] px-3 py-2 md:py-1.5 text-xs font-medium rounded-lg border transition-colors max-w-full whitespace-normal text-left sm:whitespace-nowrap ${
                androidStatus?.scanner.lastDispatchError
                  ? 'border-amber-500/50 bg-amber-500/15 text-amber-200 hover:bg-amber-500/20'
                  : androidStatus?.device
                  ? 'border-indigo-500/50 bg-indigo-500/15 text-indigo-200 hover:bg-indigo-500/20'
                  : 'border-slate-800 bg-slate-900 text-slate-400 hover:bg-slate-800'
              }`}
              trigger={
                <>
                  <Server className="w-3.5 h-3.5 shrink-0" />
                  {androidStatus?.device ? (
                    <span>
                      Android: {androidStatus.device.ip}:{androidStatus.device.port}
                      {androidStatus.device.lastSyncAt
                        ? ` · Sync ${formatTimestamp(androidStatus.device.lastSyncAt)}`
                        : ''}
                    </span>
                  ) : (
                    <span>Android: Chờ đăng ký IP</span>
                  )}
                  <Info className="w-3.5 h-3.5 opacity-75 shrink-0" />
                </>
              }
            >
              <div className="space-y-1.5">
                {androidStatus?.scanner.lastDispatchError && (
                  <p className="text-amber-300 font-medium">
                    Lỗi gửi lệnh gần nhất: {androidStatus.scanner.lastDispatchError}
                  </p>
                )}
                {androidStatus?.device ? (
                  <div className="space-y-1 text-[11px] font-mono text-slate-300">
                    <p className="break-all">
                      Endpoint: {androidStatus.device.callbackUrl || `${androidStatus.device.ip}:${androidStatus.device.port}`}
                    </p>
                    {androidStatus.device.lastSeenAt && (
                      <p>Hoạt động gần nhất: {formatTimestamp(androidStatus.device.lastSeenAt)}</p>
                    )}
                    {androidStatus.device.lastSyncAt && (
                      <p>Đồng bộ gần nhất: {formatTimestamp(androidStatus.device.lastSyncAt)}</p>
                    )}
                  </div>
                ) : (
                  <p>Chưa có thiết bị Android đăng ký IP.</p>
                )}
              </div>
            </InfoPopover>

            {currentUser ? (
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <span className="truncate max-w-[160px] sm:max-w-[200px]">
                  Cloud: {currentUser.email || currentUser.displayName}
                </span>
                <button
                  type="button"
                  onClick={() => logOutUser()}
                  className="min-h-[44px] md:min-h-[36px] inline-flex items-center gap-1 px-3 py-2 md:px-2.5 md:py-1.5 text-xs font-medium text-slate-300 bg-slate-800 rounded-lg hover:bg-slate-700 transition-colors whitespace-nowrap shrink-0"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  Đăng xuất
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => signInWithGoogle().catch(() => {})}
                className="min-h-[44px] md:min-h-[36px] inline-flex items-center gap-1.5 px-3 py-2 md:py-1.5 text-xs font-medium text-slate-300 bg-slate-900 border border-slate-800 rounded-lg hover:bg-slate-800 hover:text-slate-100 transition-colors whitespace-nowrap shrink-0"
              >
                <LogIn className="w-3.5 h-3.5" />
                Đồng bộ Cloud (Google)
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Main Content Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-5 sm:py-8 space-y-6 sm:space-y-8">
        {/* PLATFORM-SEPARATED AUTO TRACKING VIEW */}
        {isPlatformView && (
          <>
            {/* 1. Primary Platform Switcher Bar */}
            <div className="space-y-2.5">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono uppercase tracking-wider text-indigo-400 font-semibold">
                    Nền Tảng Theo Dõi Độc Lập
                  </span>
                  <span className="text-xs text-slate-400 hidden sm:inline">
                    · Chọn tab nền tảng để xem Command Center và danh sách kênh riêng biệt
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setEditingRule(null);
                    setIsRuleModalOpen(true);
                  }}
                  className="min-h-[44px] md:min-h-[36px] self-start sm:self-auto inline-flex items-center gap-1.5 px-3.5 py-2 md:px-3 md:py-1.5 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-500 transition-colors whitespace-nowrap shrink-0"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Thêm Mục Tiêu Nguồn Mới
                </button>
              </div>

              {/* 4 Dedicated Platform Tabs */}
              <div
                role="tablist"
                aria-label="Danh sách các nền tảng mạng xã hội"
                className="grid grid-cols-2 sm:grid-cols-4 gap-2.5"
              >
                {platformList.map(p => {
                  const isSelected = selectedPlatform === p;
                  const theme = PLATFORM_THEMES[p];
                  const liveCount = platformLiveCounts[p];
                  const tCount = platformTargetMap[p].length;

                  return (
                    <button
                      key={p}
                      type="button"
                      role="tab"
                      aria-selected={isSelected}
                      onClick={() => {
                        navigateToTab(p, p);
                      }}
                      className={`min-h-[56px] p-3 rounded-2xl border text-left transition-all flex items-center justify-between gap-3 ${
                        isSelected
                          ? `${theme.border} ${theme.bg} shadow-md ring-1 ring-inset ${theme.border}`
                          : `bg-[#0C111D] border-slate-800 text-slate-400 ${theme.hoverBorder} hover:text-slate-200`
                      }`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span
                          className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                            liveCount > 0
                              ? 'bg-rose-500 animate-pulse'
                              : 'bg-emerald-400'
                          }`}
                        />
                        <div className="min-w-0">
                          <div
                            className={`text-xs font-bold truncate ${
                              isSelected ? theme.text : 'text-slate-200'
                            }`}
                          >
                            {PLATFORM_BRAND_NAMES[p]}
                          </div>
                          <div className="text-[11px] text-slate-400 font-mono truncate">
                            {tCount} kênh theo dõi
                          </div>
                        </div>
                      </div>

                      {liveCount > 0 ? (
                        <span className="px-2 py-0.5 text-[10px] font-mono font-bold rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/50 shrink-0">
                          {liveCount} LIVE
                        </span>
                      ) : (
                        <span className="text-[11px] font-mono text-slate-500 shrink-0">
                          0 live
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 2. Platform Command Center (Per-Platform Bento Grid & 3 Independent Tracking Cards) */}
            <section className="bg-[#0C111D] border border-slate-800/90 rounded-2xl p-4 sm:p-6 space-y-5">
              {/* Command Center Platform Header */}
              <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 pb-4 border-b border-slate-800/80">
                <div className="space-y-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`px-2 py-0.5 rounded text-[11px] font-mono font-bold uppercase border ${
                        PLATFORM_THEMES[selectedPlatform].badge
                      }`}
                    >
                      {PLATFORM_BRAND_NAMES[selectedPlatform]}
                    </span>
                    <h1 className="text-lg sm:text-xl font-bold tracking-tight text-slate-100">
                      Auto Tracking Command Center
                    </h1>
                    <span
                      className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                        activePlatformRule?.enabled
                          ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                          : 'bg-slate-800 text-slate-400 border border-slate-700'
                      }`}
                    >
                      {activePlatformRule?.enabled ? '🟢 Đang quét (Active)' : '⚪ Tạm dừng'}
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    Theo dõi đồng thời 3 luồng <strong className="text-rose-300">Live</strong>,{' '}
                    <strong className="text-blue-300">Post</strong>,{' '}
                    <strong className="text-amber-300">Story</strong> với cơ chế Deduplication chống gửi trùng và Khởi tạo êm (First-run Warmup).
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <button
                    type="button"
                    disabled={isScanning || activePlatformTargets.length === 0}
                    onClick={() =>
                      runSocialScan({
                        specificRule: activePlatformRule,
                      })
                    }
                    className="min-h-[44px] md:min-h-[38px] inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-rose-100 bg-rose-600/90 hover:bg-rose-600 border border-rose-500 rounded-xl transition-colors max-w-full whitespace-normal text-left sm:whitespace-nowrap shadow-xs disabled:opacity-50"
                  >
                    {isScanning && !scanningTargetKey ? (
                      <RefreshCw className="w-3.5 h-3.5 animate-spin shrink-0" />
                    ) : (
                      <Play className="w-3.5 h-3.5 shrink-0" />
                    )}
                    <span>Quét toàn bộ {PLATFORM_BRAND_NAMES[selectedPlatform]} ngay</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setIsCookieModalOpen(true)}
                    className="min-h-[44px] md:min-h-[38px] inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-indigo-200 bg-indigo-950/70 border border-indigo-700/70 rounded-xl hover:bg-indigo-900/70 transition-colors whitespace-nowrap"
                  >
                    <KeyRound className="w-3.5 h-3.5" />
                    Cookie & Chu kỳ
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setEditingRule(activePlatformRule);
                      setIsRuleModalOpen(true);
                    }}
                    className="min-h-[44px] md:min-h-[38px] inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-300 bg-slate-900 border border-slate-700 rounded-xl hover:bg-slate-800 transition-colors whitespace-nowrap"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                    Cấu hình nguồn
                  </button>
                </div>
              </div>

              {/* Collector Health, Warmup State & Dedup Metrics Banner */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
                <div className="p-3 rounded-xl bg-slate-950/80 border border-slate-800/80 space-y-1">
                  <span className="text-slate-400 block">Sức khỏe Collector</span>
                  <div className="flex items-center gap-1.5 font-bold text-slate-200">
                    <span
                      className={`w-2 h-2 rounded-full ${
                        watcherStatus?.running ? 'bg-emerald-400' : 'bg-amber-400'
                      }`}
                    />
                    <span>
                      {(() => {
                        const totalErrors = Object.values(watcherStatus?.health || {}).reduce(
                          (sum, h) => sum + (h.consecutiveErrors || 0),
                          0
                        );
                        if (!watcherStatus?.running) return 'Đang khởi động...';
                        return totalErrors > 0
                          ? `Cảnh báo (${totalErrors} lỗi liên tiếp)`
                          : 'Khỏe mạnh (0 lỗi liên tiếp)';
                      })()}
                    </span>
                  </div>
                  <span className="text-[11px] text-slate-500 block truncate">
                    Multi-Loop Scheduler
                  </span>
                </div>

                <div className="p-3 rounded-xl bg-slate-950/80 border border-slate-800/80 space-y-1">
                  <span className="text-slate-400 block">Chống gửi trùng (Deduplication)</span>
                  <div className="font-bold text-emerald-400 font-mono tabular-nums text-sm">
                    {watcherStatus?.metrics?.seenEventsCount ?? 0} sự kiện
                  </div>
                  <span className="text-[11px] text-slate-500 block">
                    Đã ghi nhận trong stateStore
                  </span>
                </div>

                <div className="p-3 rounded-xl bg-slate-950/80 border border-slate-800/80 space-y-1">
                  <span className="text-slate-400 block">Khởi tạo êm (Warmup State)</span>
                  <div className="font-bold text-indigo-400 font-mono tabular-nums text-sm">
                    {watcherStatus?.metrics?.trackedUsersCount ?? activePlatformTargets.length} tài khoản
                  </div>
                  <span className="text-[11px] text-slate-500 block">
                    Baseline ID đã đồng bộ
                  </span>
                </div>

                <div className="p-3 rounded-xl bg-slate-950/80 border border-slate-800/80 space-y-1">
                  <span className="text-slate-400 block">Kênh Đang LIVE Hiện Tại</span>
                  <div
                    className={`font-bold font-mono tabular-nums text-sm ${
                      activePlatformLiveCount > 0 ? 'text-rose-400' : 'text-slate-200'
                    }`}
                  >
                    {activePlatformLiveCount} / {activePlatformTargets.length} kênh
                  </div>
                  <span className="text-[11px] text-slate-500 block">
                    Bắt Origin FLV / HLS URL
                  </span>
                </div>
              </div>

              {/* 3 Independent Tracking Cards: Live Tracking, Post Tracking, Story Tracking */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {/* 1. Live Tracking Card */}
                <div className="p-4 rounded-2xl bg-slate-950/90 border border-rose-900/40 flex flex-col justify-between space-y-4 hover:border-rose-700/60 transition-colors">
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <div className="p-2 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-300">
                          <Radio className="w-4 h-4" />
                        </div>
                        <div>
                          <h3 className="text-sm font-bold text-slate-100">1. Live Tracking</h3>
                          <span className="text-[11px] text-rose-300/80 font-mono">
                            Stream Detection
                          </span>
                        </div>
                      </div>
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                        🟢 Hoạt động
                      </span>
                    </div>

                    <div className="space-y-1.5 text-xs text-slate-400 divide-y divide-slate-800/60 pt-1">
                      <div className="py-1 flex items-center justify-between gap-2">
                        <span>Chu kỳ quét:</span>
                        <span className="font-mono text-slate-200 font-semibold text-right">
                          {currentPlatformConfig.liveIntervalSeconds}s (Jitter 10-20%)
                        </span>
                      </div>
                      <div className="py-1 flex items-center justify-between gap-2">
                        <span>Chống trùng (Dedup):</span>
                        <span className="font-mono text-indigo-300 text-right">room_id</span>
                      </div>
                      <div className="py-1 flex items-center justify-between gap-2">
                        <span>Đang phát Live:</span>
                        <span
                          className={`font-mono font-bold text-right ${
                            activePlatformLiveCount > 0 ? 'text-rose-400' : 'text-slate-300'
                          }`}
                        >
                          {activePlatformLiveCount} / {activePlatformTargets.length} kênh
                        </span>
                      </div>
                      <div className="py-1 flex items-center justify-between gap-2">
                        <span>Sức khỏe luồng:</span>
                        <span
                          className={`font-mono text-right ${
                            (currentLiveHealth?.consecutiveErrors ?? 0) > 0
                              ? 'text-amber-400 font-bold'
                              : 'text-emerald-400'
                          }`}
                        >
                          {currentLiveHealth?.consecutiveErrors ?? 0} lỗi liên tiếp
                        </span>
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    disabled={isScanning || activePlatformTargets.length === 0}
                    onClick={() =>
                      runSocialScan({
                        specificRule: activePlatformRule,
                      })
                    }
                    className="w-full min-h-[44px] md:min-h-[36px] inline-flex items-center justify-center gap-1.5 px-3 py-2 md:py-1.5 text-xs font-semibold text-rose-200 bg-rose-950/70 hover:bg-rose-900/70 border border-rose-800/80 rounded-xl transition-colors disabled:opacity-50"
                  >
                    <Radio className="w-3.5 h-3.5" />
                    Quét Live {PLATFORM_BRAND_NAMES[selectedPlatform]}
                  </button>
                </div>

                {/* 2. Post Tracking Card */}
                <div className="p-4 rounded-2xl bg-slate-950/90 border border-blue-900/40 flex flex-col justify-between space-y-4 hover:border-blue-700/60 transition-colors">
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <div className="p-2 rounded-xl bg-blue-500/15 border border-blue-500/30 text-blue-300">
                          <FileText className="w-4 h-4" />
                        </div>
                        <div>
                          <h3 className="text-sm font-bold text-slate-100">2. Post Tracking</h3>
                          <span className="text-[11px] text-blue-300/80 font-mono">
                            Video / Post Collector
                          </span>
                        </div>
                      </div>
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                        🟢 Khởi tạo êm
                      </span>
                    </div>

                    <div className="space-y-1.5 text-xs text-slate-400 divide-y divide-slate-800/60 pt-1">
                      <div className="py-1 flex items-center justify-between gap-2">
                        <span>Chu kỳ quét:</span>
                        <span className="font-mono text-slate-200 font-semibold text-right">
                          {currentPlatformConfig.postIntervalSeconds}s (3-5 phút)
                        </span>
                      </div>
                      <div className="py-1 flex items-center justify-between gap-2">
                        <span>Chống trùng (Dedup):</span>
                        <span className="font-mono text-indigo-300 text-right">video_id (bỏ qua ghim)</span>
                      </div>
                      <div className="py-1 flex items-center justify-between gap-2">
                        <span>Tài khoản theo dõi:</span>
                        <span className="font-mono text-slate-200 font-semibold text-right">
                          {activePlatformTargets.length} tài khoản
                        </span>
                      </div>
                      <div className="py-1 flex items-center justify-between gap-2">
                        <span>Trạng thái Warmup:</span>
                        <span className="font-mono text-emerald-400 text-right">Đã nạp baseline</span>
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    disabled={isScanning || activePlatformTargets.length === 0}
                    onClick={() =>
                      runSocialScan({
                        specificRule: activePlatformRule,
                        activityType: 'post',
                        injectedText: `Kiểm tra video mới nhất từ ${PLATFORM_BRAND_NAMES[selectedPlatform]}`,
                      })
                    }
                    className="w-full min-h-[44px] md:min-h-[36px] inline-flex items-center justify-center gap-1.5 px-3 py-2 md:py-1.5 text-xs font-semibold text-blue-200 bg-blue-950/70 hover:bg-blue-900/70 border border-blue-800/80 rounded-xl transition-colors disabled:opacity-50"
                  >
                    <FileText className="w-3.5 h-3.5" />
                    Quét Post {PLATFORM_BRAND_NAMES[selectedPlatform]}
                  </button>
                </div>

                {/* 3. Story Tracking Card */}
                <div className="p-4 rounded-2xl bg-slate-950/90 border border-amber-900/40 flex flex-col justify-between space-y-4 hover:border-amber-700/60 transition-colors">
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <div className="p-2 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-300">
                          <Sparkles className="w-4 h-4" />
                        </div>
                        <div>
                          <h3 className="text-sm font-bold text-slate-100">3. Story Tracking</h3>
                          <span className="text-[11px] text-amber-300/80 font-mono">
                            Story 24h Collector
                          </span>
                        </div>
                      </div>
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-bold border ${
                          hasPlatformCookie
                            ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                            : 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30'
                        }`}
                      >
                        {hasPlatformCookie ? '🟢 Ưu tiên Cookie' : '🟢 Mặc định Ẩn danh'}
                      </span>
                    </div>

                    <div className="space-y-1.5 text-xs text-slate-400 divide-y divide-slate-800/60 pt-1">
                      <div className="py-1 flex items-center justify-between gap-2">
                        <span>Chu kỳ quét:</span>
                        <span className="font-mono text-slate-200 font-semibold text-right">
                          {currentPlatformConfig.storyIntervalSeconds}s (5-10 phút)
                        </span>
                      </div>
                      <div className="py-1 flex items-center justify-between gap-2">
                        <span>Chống trùng (Dedup):</span>
                        <span className="font-mono text-indigo-300 text-right">story_id (lưu 48h)</span>
                      </div>
                      <div className="py-1 flex items-center justify-between gap-2">
                        <span>Chế độ quét:</span>
                        <span
                          className={`font-mono font-semibold text-right ${
                            hasPlatformCookie ? 'text-emerald-400' : 'text-indigo-400'
                          }`}
                        >
                          {hasPlatformCookie ? 'Đã nạp Cookie' : 'Ẩn danh (Guest)'}
                        </span>
                      </div>
                      <div className="py-1 flex items-center justify-between gap-2">
                        <span>Trạng thái Story:</span>
                        <span className="font-mono text-slate-300 text-right">
                          {hasPlatformCookie ? 'Đang theo dõi 24h (Cookie)' : 'Đang theo dõi 24h (Ẩn danh)'}
                        </span>
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    disabled={isScanning || activePlatformTargets.length === 0}
                    onClick={() => {
                      void runSocialScan({
                        specificRule: activePlatformRule,
                        activityType: 'story',
                        injectedText: `Kiểm tra story 24h mới nhất từ ${PLATFORM_BRAND_NAMES[selectedPlatform]}`,
                      });
                    }}
                    className="w-full min-h-[44px] md:min-h-[36px] inline-flex items-center justify-center gap-1.5 px-3 py-2 md:py-1.5 text-xs font-semibold text-amber-200 bg-amber-950/70 hover:bg-amber-900/70 border border-amber-800/80 rounded-xl transition-colors disabled:opacity-50"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    Quét Story {PLATFORM_BRAND_NAMES[selectedPlatform]} ({hasPlatformCookie ? 'Cookie' : 'Ẩn danh'})
                  </button>
                </div>
              </div>
            </section>

            {/* 3. Multi-Stream Target Management Table (Per-Platform Watchlist) */}
            <section className="bg-[#0C111D] border border-slate-800/90 rounded-2xl p-4 sm:p-6 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pb-3 border-b border-slate-800/80">
                <div>
                  <div className="text-xs font-mono uppercase tracking-wider text-emerald-400 font-semibold">
                    Watchlist Quản Lý Đa Luồng · {PLATFORM_BRAND_NAMES[selectedPlatform]}
                  </div>
                  <h2 className="text-base sm:text-lg font-bold text-slate-100 mt-0.5">
                    Danh Sách Kênh Theo Dõi ({activePlatformTargets.length} mục tiêu)
                  </h2>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono text-slate-400 tabular-nums">
                    Đang Live: {activePlatformLiveCount} | Tổng: {activePlatformTargets.length}
                  </span>
                </div>
              </div>

              {/* Inline Add Form for Selected Platform */}
              <form
                onSubmit={e => {
                  e.preventDefault();
                  handleInlineAddTarget(activePlatformRule);
                }}
                className="p-3.5 bg-slate-950/90 border border-slate-800/90 rounded-2xl space-y-3"
              >
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="text"
                    value={inlineInputs[activePlatformRule.id] || ''}
                    onChange={e =>
                      setInlineInputs(prev => ({
                        ...prev,
                        [activePlatformRule.id]: e.target.value,
                      }))
                    }
                    placeholder={`Nhập @username hoặc URL kênh ${PLATFORM_BRAND_NAMES[selectedPlatform]} (VD: @mixigaming, https://${selectedPlatform}.com/...)...`}
                    aria-label={`Thêm mục tiêu theo dõi vào ${PLATFORM_BRAND_NAMES[selectedPlatform]}`}
                    className="w-full sm:w-auto flex-1 min-h-[44px] px-3.5 py-2 text-sm bg-slate-900 border border-slate-700 rounded-xl text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-indigo-400"
                  />
                  <button
                    type="submit"
                    className="w-full sm:w-auto min-h-[44px] inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-xl transition-colors whitespace-nowrap shrink-0 shadow-sm"
                  >
                    <Plus className="w-4 h-4" />
                    Thêm kênh
                  </button>
                </div>

                {/* Multi-stream subscription toggles and warmup checkbox for new target */}
                <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-800/60 text-xs">
                  <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                    <span className="text-slate-400 font-medium">Bật theo dõi:</span>
                    <label className="min-h-[44px] md:min-h-0 px-3 py-2 md:px-0 md:py-0 rounded-xl md:rounded-none bg-slate-900/70 md:bg-transparent border border-slate-800 md:border-0 inline-flex items-center gap-2 md:gap-1.5 cursor-pointer text-rose-300 font-medium">
                      <input
                        type="checkbox"
                        checked={inlineTrackLive}
                        onChange={e => setInlineTrackLive(e.target.checked)}
                        className="w-4 h-4 rounded border-slate-700 bg-slate-900 text-rose-500 focus:ring-rose-500"
                      />
                      <span>[Live]</span>
                    </label>
                    <label className="min-h-[44px] md:min-h-0 px-3 py-2 md:px-0 md:py-0 rounded-xl md:rounded-none bg-slate-900/70 md:bg-transparent border border-slate-800 md:border-0 inline-flex items-center gap-2 md:gap-1.5 cursor-pointer text-blue-300 font-medium">
                      <input
                        type="checkbox"
                        checked={inlineTrackPost}
                        onChange={e => setInlineTrackPost(e.target.checked)}
                        className="w-4 h-4 rounded border-slate-700 bg-slate-900 text-blue-500 focus:ring-blue-500"
                      />
                      <span>[Post]</span>
                    </label>
                    <label className="min-h-[44px] md:min-h-0 px-3 py-2 md:px-0 md:py-0 rounded-xl md:rounded-none bg-slate-900/70 md:bg-transparent border border-slate-800 md:border-0 inline-flex items-center gap-2 md:gap-1.5 cursor-pointer text-amber-300 font-medium">
                      <input
                        type="checkbox"
                        checked={inlineTrackStory}
                        onChange={e => setInlineTrackStory(e.target.checked)}
                        className="w-4 h-4 rounded border-slate-700 bg-slate-900 text-amber-500 focus:ring-amber-500"
                      />
                      <span>[Story]</span>
                    </label>
                  </div>

                  <label className="min-h-[44px] md:min-h-0 px-3 py-2 md:px-0 md:py-0 rounded-xl md:rounded-none bg-slate-900/70 md:bg-transparent border border-slate-800 md:border-0 inline-flex items-center gap-2 md:gap-1.5 cursor-pointer text-emerald-300 font-medium">
                    <input
                      type="checkbox"
                      checked={inlineWarmup}
                      onChange={e => setInlineWarmup(e.target.checked)}
                      className="w-4 h-4 rounded border-slate-700 bg-slate-900 text-emerald-500 focus:ring-emerald-500"
                    />
                    <Flame className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Khởi tạo êm (First-run Warmup)</span>
                  </label>
                </div>
              </form>

              {/* Live Channels Highlight Banner (If any target is currently LIVE) */}
              {activePlatformTargets.some(
                item => liveStatusMap[`${item.rule.id}::${item.target}`]?.status === 'LIVE'
              ) && (
                <div className="p-3.5 rounded-2xl bg-gradient-to-r from-rose-950/60 via-slate-950/80 to-slate-950/90 border border-rose-500/40 space-y-2.5 shadow-lg">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="relative flex h-2.5 w-2.5">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-rose-500"></span>
                      </span>
                      <span className="text-xs font-bold text-rose-300 uppercase tracking-wider font-mono">
                        Kênh Đang Phát Trực Tiếp ({activePlatformLiveCount})
                      </span>
                    </div>
                    <span className="text-[11px] font-mono text-slate-400 hidden sm:inline-block">
                      Tự động chuyển tiếp đến Android StreamRecorder
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2.5 pt-1">
                    {activePlatformTargets
                      .filter(item => liveStatusMap[`${item.rule.id}::${item.target}`]?.status === 'LIVE')
                      .map(({ rule, target }) => {
                        const targetKey = `${rule.id}::${target}`;
                        const live = liveStatusMap[targetKey];
                        return (
                          <div
                            key={`highlight_${targetKey}`}
                            className="flex items-center gap-2.5 px-3 py-1.5 rounded-xl bg-slate-900/95 border border-rose-500/40 hover:border-rose-400 transition-colors shadow-sm"
                          >
                            <UserAvatar
                              target={target}
                              platform={selectedPlatform}
                              isLive={true}
                              size="sm"
                            />
                            <div className="flex flex-col min-w-0">
                              <span className="font-mono font-bold text-slate-100 text-xs truncate max-w-[140px]">
                                {target}
                              </span>
                              <span className="text-[10px] text-rose-300 truncate max-w-[140px]">
                                {live?.title || 'Đang phát trực tiếp'}
                              </span>
                            </div>
                            {live?.streamUrl && (
                              <button
                                type="button"
                                onClick={() => handleCopyStreamUrl(targetKey, live.streamUrl!)}
                                aria-label={`Sao chép Stream URL của ${target}`}
                                className="min-h-[44px] min-w-[44px] md:min-h-[32px] md:min-w-[32px] inline-flex items-center justify-center gap-1 px-2.5 md:px-2 py-2 md:py-1 rounded-lg bg-rose-500/20 text-rose-300 hover:bg-rose-500/30 transition-colors shrink-0 ml-1 text-[11px] font-semibold"
                              >
                                {copiedStreamKey === targetKey ? (
                                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                                ) : (
                                  <Copy className="w-3.5 h-3.5" />
                                )}
                                <span>{copiedStreamKey === targetKey ? 'Đã chép' : 'Copy'}</span>
                              </button>
                            )}
                          </div>
                        );
                      })}
                  </div>
                </div>
              )}

              {/* Multi-Stream Watchlist (Responsive Mobile Cards + Desktop Table) */}
              <WatchlistSection
                selectedPlatform={selectedPlatform}
                targets={activePlatformTargets}
                liveStatusMap={liveStatusMap}
                targetStreamMetaMap={targetStreamMetaMap}
                hasPlatformCookie={hasPlatformCookie}
                isScanning={isScanning}
                scanningTargetKey={scanningTargetKey}
                copiedStreamKey={copiedStreamKey}
                onToggleStream={(targetKey, stream) =>
                  handleToggleStreamSubscription(targetKey, stream)
                }
                onScanTarget={(rule, target) =>
                  runSocialScan({
                    specificRule: rule,
                    specificTargets: [target],
                  })
                }
                onCopyStreamUrl={(targetKey, streamUrl) =>
                  handleCopyStreamUrl(targetKey, streamUrl)
                }
                onEditRule={rule => {
                  setEditingRule(rule);
                  setIsRuleModalOpen(true);
                }}
                onRemoveTarget={(rule, target) => handleInlineRemoveTarget(rule, target)}
              />
            </section>

            {/* 4. Section 02: Activity Detections & Server Request Logs */}
            <ActivityLogSection
              selectedPlatform={selectedPlatform}
              logScope={logScope}
              onChangeLogScope={setLogScope}
              searchQuery={searchQuery}
              onChangeSearchQuery={setSearchQuery}
              totalAlertsCount={alerts.length}
              filteredAlerts={filteredAlerts}
              onInspectAlert={setInspectingAlert}
            />
          </>
        )}

        {/* VIEW 2: SERVERS */}
        {activeTab === 'servers' && (
          <div className="space-y-6 sm:space-y-8">
            <section className="bg-[#0C111D] border border-slate-800 rounded-2xl overflow-hidden">
              <div className="px-4 sm:px-6 py-5 border-b border-slate-800 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div>
                  <h1 className="text-lg font-bold text-slate-100">
                    Máy Chủ Xử Lý (Destination Webhook Servers)
                  </h1>
                  <p className="text-xs text-slate-400 mt-1">
                    Cấu hình máy chủ nhận Webhook payload khi phát hiện Live hoặc bài đăng mới.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setEditingServer(null);
                    setIsWebhookModalOpen(true);
                  }}
                  className="min-h-[44px] md:min-h-[40px] self-start sm:self-auto inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-500 transition-colors whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Thêm Máy Chủ Mới
                </button>
              </div>

              <div className="divide-y divide-slate-800">
                {servers.map(srv => (
                  <div
                    key={srv.id}
                    className="p-4 sm:p-6 flex flex-col md:flex-row md:items-center justify-between gap-4 hover:bg-slate-800/20 transition-colors"
                  >
                    <div className="space-y-1.5 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-slate-100 break-words">{srv.name}</span>
                        <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-indigo-950 text-indigo-300 border border-indigo-800">
                          {srv.format.toUpperCase()}
                        </span>
                        {srv.url.startsWith('/api/webhook-sandbox') && (
                          <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-950 text-emerald-300 border border-emerald-800">
                            Cục bộ Sandbox
                          </span>
                        )}
                      </div>
                      <div className="font-mono text-xs text-slate-400 truncate max-w-xl">
                        POST {srv.url}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => handleToggleServer(srv)}
                        className={`min-h-[44px] md:min-h-[36px] px-3.5 py-2 md:px-3 md:py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
                          srv.enabled
                            ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
                            : 'border-slate-700 bg-slate-900 text-slate-400'
                        }`}
                      >
                        {srv.enabled ? 'Đang nhận request' : 'Tạm dừng'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingServer(srv);
                          setIsWebhookModalOpen(true);
                        }}
                        aria-label={`Chỉnh sửa máy chủ ${srv.name}`}
                        className="min-h-[44px] min-w-[44px] md:min-h-[36px] md:min-w-[36px] inline-flex items-center justify-center text-slate-400 hover:text-slate-100 rounded-lg hover:bg-slate-800 transition-colors"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </button>
                      {servers.length > 1 && (
                        <button
                          type="button"
                          onClick={() => handleDeleteServer(srv)}
                          aria-label={`Xóa máy chủ ${srv.name}`}
                          className="min-h-[44px] min-w-[44px] md:min-h-[36px] md:min-w-[36px] inline-flex items-center justify-center text-slate-400 hover:text-rose-400 rounded-lg hover:bg-slate-800 transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}

        {/* VIEW 3: SANDBOX */}
        {activeTab === 'sandbox' && (
          <section className="bg-[#0C111D] border border-slate-800 rounded-2xl overflow-hidden">
            <div className="px-4 sm:px-6 py-5 border-b border-slate-800 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div>
                <h1 className="text-lg font-bold text-slate-100">
                  Request Đã Nhận (/api/webhook-sandbox)
                </h1>
                <p className="text-xs text-slate-400 mt-1">
                  Kiểm tra trực tiếp các Webhook JSON payload và chữ ký HMAC-SHA256 gửi từ bot.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => fetchSandboxLogs()}
                  className="min-h-[44px] md:min-h-[36px] inline-flex items-center gap-1.5 px-3.5 py-2 md:px-3 md:py-1.5 text-xs font-medium text-slate-200 bg-slate-800 rounded-lg hover:bg-slate-700 transition-colors"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Làm mới
                </button>
              </div>
            </div>

            {sandboxReceipts.length === 0 ? (
              <div className="p-8 text-center space-y-2">
                <p className="text-sm text-slate-400">
                  Chưa có request nào gửi về Sandbox. Hãy chạy Quét Live trên một tab nền tảng để xem payload.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-slate-800">
                {sandboxReceipts.map(rcpt => (
                  <div key={rcpt.id} className="p-4 sm:p-6 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <div className="flex flex-wrap items-center gap-2 font-mono text-slate-400 tabular-nums">
                        <span className="font-semibold text-indigo-300">
                          POST /api/webhook-sandbox
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{formatTimestamp(rcpt.receivedAt)}</span>
                        <span aria-hidden="true">·</span>
                        <span>Kênh: {rcpt.channel}</span>
                      </div>
                      <div className="font-mono text-xs">
                        {rcpt.signatureVerified ? (
                          <span className="text-emerald-400 font-medium">
                            X-PulseBot-Signature: Hợp lệ ({rcpt.signatureHeader.slice(0, 22)}...)
                          </span>
                        ) : (
                          <span className="text-amber-400 font-medium">
                            Không có chữ ký HMAC
                          </span>
                        )}
                      </div>
                    </div>
                    <pre className="p-4 bg-slate-950 border border-slate-800 text-slate-200 rounded-xl text-xs font-mono overflow-x-auto max-h-56 leading-relaxed">
                      {JSON.stringify(rcpt.payload, null, 2)}
                    </pre>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* VIEW 4: ACTIVITY LOG & SYSTEM HISTORY */}
        {activeTab === 'activity' && (
          <div className="space-y-6 sm:space-y-8">
            {/* System Status Dashboard Card */}
            <section className="bg-[#0C111D] border border-slate-800 rounded-2xl p-4 sm:p-6 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div>
                  <h1 className="text-lg font-bold text-slate-100 flex items-center gap-2">
                    <Activity className="w-5 h-5 text-emerald-400" />
                    Lịch Sử & Trạng Thái Hoạt Động Hệ Thống
                  </h1>
                  <p className="text-xs text-slate-400 mt-1">
                    Theo dõi thời gian thực quá trình quét kênh, nhịp tim điện thoại Android và nhật ký request.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      void fetchAndroidStatus();
                      void fetchSandboxLogs();
                      void fetchWatcherStatus();
                      void fetchStorageStatus();
                    }}
                    className="min-h-[44px] md:min-h-[36px] inline-flex items-center gap-1.5 px-3.5 py-2 md:px-3 md:py-1.5 text-xs font-semibold text-slate-200 bg-slate-800 rounded-lg hover:bg-slate-700 transition-colors"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Làm mới trạng thái
                  </button>
                </div>
              </div>

              {/* Status Metric Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                {/* Companion Device Card */}
                <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-mono text-slate-400 uppercase">Thiết Bị Ghi Hình</span>
                    <span
                      className={`inline-block w-2 h-2 rounded-full ${
                        androidStatus?.device ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'
                      }`}
                    />
                  </div>
                  <div className="text-sm font-bold text-slate-200 truncate">
                    {androidStatus?.device ? androidStatus.device.deviceId : 'Chưa kết nối'}
                  </div>
                  <div className="text-[11px] text-slate-400 truncate">
                    IP: {androidStatus?.device?.ip || 'N/A'} ({androidStatus?.device?.networkType || 'LAN'})
                  </div>
                  <div className="text-[10px] text-emerald-400 font-mono">
                    {androidStatus?.device?.lastSeenAt
                      ? `Ping: ${new Date(androidStatus.device.lastSeenAt).toLocaleTimeString()}`
                      : 'Chưa có nhịp tim'}
                  </div>
                </div>

                {/* Auto Scan Engine */}
                <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-mono text-slate-400 uppercase">Bộ Quét Tự Động</span>
                    <span
                      className={`inline-block w-2 h-2 rounded-full ${
                        androidStatus?.scanner?.running ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'
                      }`}
                    />
                  </div>
                  <div className="text-sm font-bold text-slate-200">
                    {androidStatus?.scanner?.running ? 'Đang chạy liên tục' : 'Tạm dừng'}
                  </div>
                  <div className="text-[11px] text-slate-400">
                    Chu kỳ: {androidStatus?.scanner?.pollIntervalSeconds ?? 30}s / lần
                  </div>
                  <div className="text-[10px] text-slate-400 font-mono">
                    {androidStatus?.scanner?.lastScanAt
                      ? `Lần quét cuối: ${new Date(androidStatus.scanner.lastScanAt).toLocaleTimeString()}`
                      : 'Đang khởi động'}
                  </div>
                </div>

                {/* Live Channels */}
                <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-mono text-slate-400 uppercase">Kênh Đang Live</span>
                    <Flame className="w-3.5 h-3.5 text-rose-500" />
                  </div>
                  <div className="text-sm font-bold text-rose-300">
                    {activePlatformLiveCount} kênh đang phát
                  </div>
                  <div className="text-[11px] text-slate-400">
                    Tổng mục tiêu: {rules.reduce((acc, r) => acc + (r.keyword.match(/@?[a-zA-Z0-9._-]+/g) || []).length, 0)} kênh
                  </div>
                  <div className="text-[10px] text-slate-400 font-mono">
                    Tự động đồng bộ Companion
                  </div>
                </div>

                {/* Webhook & Sandbox */}
                <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-mono text-slate-400 uppercase">Sự Kiện Đã Bắn</span>
                    <Code2 className="w-3.5 h-3.5 text-indigo-400" />
                  </div>
                  <div className="text-sm font-bold text-indigo-300">
                    {alerts.length} sự kiện ghi nhận
                  </div>
                  <div className="text-[11px] text-slate-400">
                    Sandbox: {sandboxReceipts.length} request đã nhận
                  </div>
                  <div className="text-[10px] text-slate-400 font-mono">
                    Máy chủ: {servers.length} webhook server
                  </div>
                </div>
              </div>

              {/* Cloud Storage Providers: Google Drive API & Telegram */}
              <div className="p-4 rounded-xl bg-slate-950/80 border border-slate-800 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-slate-200 uppercase tracking-wider font-mono">
                      Lưu Trữ Đám Mây (Cloud Storage)
                    </span>
                  </div>
                  <p className="text-xs text-slate-400">
                    Tự động đẩy bài Post & Story đã tải lên Google Drive của bạn hoặc Kênh Telegram.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  {/* Google Drive Status */}
                  <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-xs font-mono">
                    <span className="text-slate-400">Google Drive:</span>
                    {storageStatus?.googleDrive?.configured ? (
                      <span className="text-emerald-400 font-bold flex items-center gap-1">
                        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                        Đã kết nối API ({storageStatus.googleDrive.clientEmail?.split('@')[0]})
                      </span>
                    ) : (
                      <span className="text-amber-400 font-medium">
                        Lưu máy cục bộ / Chờ Key Drive API
                      </span>
                    )}
                  </div>

                  {/* Telegram Status */}
                  <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-xs font-mono">
                    <span className="text-slate-400">Telegram:</span>
                    {storageStatus?.telegram?.configured ? (
                      <span className="text-emerald-400 font-bold flex items-center gap-1">
                        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                        Đã kết nối Bot ({storageStatus.telegram.chatId})
                      </span>
                    ) : (
                      <span className="text-slate-400">
                        Sẵn sàng cấu hình sau
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </section>

            {/* Section: Activity Log Table & Mobile Cards */}
            <ActivityLogSection
              selectedPlatform={selectedPlatform}
              logScope={logScope}
              onChangeLogScope={setLogScope}
              searchQuery={searchQuery}
              onChangeSearchQuery={setSearchQuery}
              totalAlertsCount={alerts.length}
              filteredAlerts={filteredAlerts}
              onInspectAlert={setInspectingAlert}
            />
          </div>
        )}
      </main>

      {/* Clean Footer */}
      <footer className="border-t border-slate-800/80 bg-[#090D16] px-4 sm:px-6 py-4 mt-auto">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-400">
          <span>
            PulseRadar — Hệ thống Bot quét Trang Web Nguồn, phát hiện Đăng bài / Livestream / Story & đẩy Request về máy chủ
          </span>
          <div className="flex flex-wrap items-center justify-center gap-1 sm:gap-4">
            <a
              href="#tiktok"
              onClick={e => {
                e.preventDefault();
                navigateToTab('tiktok', 'tiktok');
              }}
              className="min-h-[44px] md:min-h-0 inline-flex items-center px-2.5 py-2 md:px-0 md:py-0 hover:text-slate-100 transition-colors"
            >
              TikTok
            </a>
            <a
              href="#instagram"
              onClick={e => {
                e.preventDefault();
                navigateToTab('instagram', 'instagram');
              }}
              className="min-h-[44px] md:min-h-0 inline-flex items-center px-2.5 py-2 md:px-0 md:py-0 hover:text-slate-100 transition-colors"
            >
              Instagram
            </a>
            <a
              href="#facebook"
              onClick={e => {
                e.preventDefault();
                navigateToTab('facebook', 'facebook');
              }}
              className="min-h-[44px] md:min-h-0 inline-flex items-center px-2.5 py-2 md:px-0 md:py-0 hover:text-slate-100 transition-colors"
            >
              Facebook
            </a>
            <a
              href="#x"
              onClick={e => {
                e.preventDefault();
                navigateToTab('x', 'x');
              }}
              className="min-h-[44px] md:min-h-0 inline-flex items-center px-2.5 py-2 md:px-0 md:py-0 hover:text-slate-100 transition-colors"
            >
              X / Twitter
            </a>
            <a
              href="#servers"
              onClick={e => {
                e.preventDefault();
                navigateToTab('servers');
              }}
              className="min-h-[44px] md:min-h-0 inline-flex items-center px-2.5 py-2 md:px-0 md:py-0 hover:text-slate-100 transition-colors"
            >
              Máy Chủ
            </a>
          </div>
        </div>
      </footer>

      {/* Mobile Bottom Tab Bar */}
      <nav
        aria-label="Điều hướng di động"
        className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-[#0B0F1A]/95 backdrop-blur-md border-t border-slate-800 grid grid-cols-7 h-16"
      >
        <button
          type="button"
          onClick={() => {
            navigateToTab('tiktok', 'tiktok');
          }}
          className={`min-h-[44px] min-w-[44px] flex flex-col items-center justify-center gap-1 text-[10px] font-medium transition-colors ${
            activeTab === 'tiktok' || (isPlatformView && selectedPlatform === 'tiktok')
              ? 'text-cyan-400 font-bold'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <span className="font-bold">TikTok</span>
        </button>
        <button
          type="button"
          onClick={() => {
            navigateToTab('instagram', 'instagram');
          }}
          className={`min-h-[44px] min-w-[44px] flex flex-col items-center justify-center gap-1 text-[10px] font-medium transition-colors ${
            activeTab === 'instagram' || (isPlatformView && selectedPlatform === 'instagram')
              ? 'text-fuchsia-400 font-bold'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <span className="font-bold">Insta</span>
        </button>
        <button
          type="button"
          onClick={() => {
            navigateToTab('facebook', 'facebook');
          }}
          className={`min-h-[44px] min-w-[44px] flex flex-col items-center justify-center gap-1 text-[10px] font-medium transition-colors ${
            activeTab === 'facebook' || (isPlatformView && selectedPlatform === 'facebook')
              ? 'text-blue-400 font-bold'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <span className="font-bold">FB</span>
        </button>
        <button
          type="button"
          onClick={() => {
            navigateToTab('x', 'x');
          }}
          className={`min-h-[44px] min-w-[44px] flex flex-col items-center justify-center gap-1 text-[10px] font-medium transition-colors ${
            activeTab === 'x' || (isPlatformView && selectedPlatform === 'x')
              ? 'text-slate-100 font-bold'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <span className="font-bold">X</span>
        </button>
        <button
          type="button"
          onClick={() => navigateToTab('activity')}
          className={`min-h-[44px] min-w-[44px] flex flex-col items-center justify-center gap-1 text-[10px] font-medium transition-colors ${
            activeTab === 'activity'
              ? 'text-emerald-400 font-bold'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Activity className="w-3.5 h-3.5 text-emerald-400" />
          <span>Lịch sử</span>
        </button>
        <button
          type="button"
          onClick={() => navigateToTab('servers')}
          className={`min-h-[44px] min-w-[44px] flex flex-col items-center justify-center gap-1 text-[10px] font-medium transition-colors ${
            activeTab === 'servers'
              ? 'text-indigo-400 font-bold'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Server className="w-3.5 h-3.5" />
          <span>Server</span>
        </button>
        <button
          type="button"
          onClick={() => navigateToTab('sandbox')}
          className={`min-h-[44px] min-w-[44px] flex flex-col items-center justify-center gap-1 text-[10px] font-medium transition-colors ${
            activeTab === 'sandbox'
              ? 'text-indigo-400 font-bold'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Terminal className="w-3.5 h-3.5" />
          <span>Sandbox</span>
        </button>
      </nav>

      {/* Modals */}
      <RuleModal
        isOpen={isRuleModalOpen}
        onClose={() => setIsRuleModalOpen(false)}
        onSave={handleSaveRule}
        editingRule={editingRule}
        servers={servers}
        defaultPlatform={SOCIAL_KEY_TO_PLATFORM[selectedPlatform]}
      />

      <WebhookModal
        isOpen={isWebhookModalOpen}
        onClose={() => setIsWebhookModalOpen(false)}
        onSave={handleSaveServer}
        editingServer={editingServer}
      />

      <PayloadInspectorModal
        alertItem={inspectingAlert}
        onClose={() => setInspectingAlert(null)}
        onRetryWebhook={handleRetryWebhook}
      />

      <CookieSettingsModal
        isOpen={isCookieModalOpen}
        onClose={() => setIsCookieModalOpen(false)}
        settings={scannerSettings}
        onSave={handleSaveScannerSettings}
      />
    </div>
  );
}
