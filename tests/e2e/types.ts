export type CanonicalPlatform = 'TIKTOK' | 'INSTAGRAM' | 'FACEBOOK' | 'X';

export type AndroidUserStatus = 'IDLE' | 'LIVE' | 'RECORDING' | 'UPLOADING' | 'ERROR';

export type ServerLiveStatus = 'IDLE' | 'LIVE' | 'ERROR';

export interface ErrorResponse {
  ok: false;
  error: string;
}

export interface RegisterRequest {
  deviceId?: string;
  ip?: string;
  port: number;
  appVersion?: string;
  networkType?: string;
  timestamp?: string;
}

export interface RegisterResponse {
  ok: true;
  deviceId: string;
  ip: string;
  port: number;
  callbackUrl: string;
  serverTime: string;
}

export interface RecordRequest {
  eventId?: string;
  platform: string;
  username?: string;
  usernameOrUrl?: string;
  streamUrl: string;
  title?: string;
  sourceUrl?: string;
  qualityInfo?: string;
  ruleId?: string;
  detectedAt?: string;
}

export type RecordResponseStatus =
  | 'RECORDING_STARTED'
  | 'ALREADY_RECORDING'
  | 'SKIPPED_CELLULAR_POLICY';

export interface RecordResponse {
  ok: true;
  status: RecordResponseStatus;
  platform: CanonicalPlatform;
  username: string;
}

export interface AndroidSyncUserInput {
  username?: string;
  usernameOrUrl?: string;
  platform: string;
  nickname?: string;
  status: AndroidUserStatus;
  isEnabled: boolean;
  allowCellular?: boolean;
  lastStreamUrl?: string | null;
  lastCheckedTimestamp?: number;
}

export interface SyncRequest {
  deviceId?: string;
  ip?: string;
  port?: number;
  reportedAt?: string;
  users: AndroidSyncUserInput[];
}

export interface AuthoritativeUserItem {
  username: string;
  usernameOrUrl: string;
  platform: CanonicalPlatform;
  nickname: string;
  isEnabled: boolean;
  serverStatus: ServerLiveStatus;
  effectiveStatus: AndroidUserStatus;
  streamUrl: string | null;
  streamTitle: string | null;
  sourceUrl: string | null;
  qualityInfo: string | null;
}

export interface SyncUpdateItem {
  username: string;
  usernameOrUrl: string;
  platform: CanonicalPlatform;
  isEnabled: boolean;
  status: AndroidUserStatus;
  effectiveStatus: AndroidUserStatus;
  streamUrl: string | null;
  streamTitle: string | null;
  sourceUrl: string | null;
  qualityInfo: string | null;
}

export interface SyncRemoveItem {
  username: string;
  usernameOrUrl: string;
  platform: CanonicalPlatform;
}

export interface RecordTriggerItem {
  eventId: string;
  platform: CanonicalPlatform;
  username: string;
  usernameOrUrl: string;
  streamUrl: string;
  title: string;
  sourceUrl: string;
  qualityInfo: string;
  detectedAt: string;
}

export interface SyncResponse {
  ok: true;
  syncedAt: string;
  authoritativeUsers: AuthoritativeUserItem[];
  toAdd: AuthoritativeUserItem[];
  toUpdate: SyncUpdateItem[];
  toRemove: SyncRemoveItem[];
  recordTriggers: RecordTriggerItem[];
}

export interface AndroidDeviceRecord {
  deviceId: string;
  ip: string;
  port: number;
  callbackUrl: string;
  appVersion?: string;
  networkType?: string;
  lastSeenAt: string;
  lastSyncAt: string | null;
}

export interface ScannerStatus {
  enabled: boolean;
  running: boolean;
  pollIntervalSeconds: number;
  lastScanAt: string | null;
  activeLiveCount: number;
  lastDispatchError: string | null;
}

export interface HealthResponse {
  ok: true;
  port: number;
  autoScanEnabled: boolean;
  autoScanRunning: boolean;
  androidDevice: AndroidDeviceRecord | null;
  trackedUsersCount: number;
  serverTime: string;
}

export interface AndroidStatusResponse {
  ok: true;
  device: AndroidDeviceRecord | null;
  scanner: ScannerStatus;
}

export interface AndroidHealthResponse {
  ok: true;
  pollingDisabled: boolean;
  listeningPort: number;
  ip: string;
  activeRecordings: number;
  userCount: number;
  lastSyncAt: string | null;
}

export interface WorkspaceRule {
  id: string;
  ownerId: string;
  keyword: string;
  excludedKeywords: string;
  matchType: 'contains' | 'exact' | 'regex';
  platforms: string;
  webhookServerId: string;
  enabled: boolean;
  matchCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceServer {
  id: string;
  ownerId: string;
  name: string;
  url: string;
  format: 'json' | 'slack' | 'discord';
  secretHeader: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceScannerSettings {
  cookies: {
    tiktok: string;
    instagram: string;
    facebook: string;
    x: string;
  };
  pollIntervalSeconds: number;
  deduplicateLive: boolean;
}

export interface WorkspaceState {
  rules: WorkspaceRule[];
  servers: WorkspaceServer[];
  alerts: unknown[];
  scannerSettings: WorkspaceScannerSettings;
  updatedAt?: string;
}

export interface LiveSimulationInput {
  platform: string;
  username: string;
  status: 'LIVE' | 'NOT_LIVE' | 'ERROR';
  streamUrl?: string;
  title?: string;
  sourceUrl?: string;
  qualityInfo?: string;
  errorMessage?: string;
  checkerDelayMs?: number;
}

export interface MockFaultConfig {
  statusCode?: number;
  failCount?: number;
  delayMs?: number;
  networkOnline?: boolean;
  isWifi?: boolean;
  simulateLowStorageAbort?: boolean;
  customBody?: unknown;
  activeRecordings?: string[];
}

export interface MockAndroidUserState {
  platform: CanonicalPlatform;
  username: string;
  usernameOrUrl: string;
  nickname: string;
  isEnabled: boolean;
  allowCellular: boolean;
  telegramTopicId: number | null;
  status: AndroidUserStatus;
  lastStreamUrl: string | null;
  lastCheckedTimestamp: number;
}

export interface CapturedRecordRequest {
  receivedAt: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  body: Record<string, unknown> | null;
  statusCode: number;
  responseStatus: string;
}

export interface MockAndroidReceiver {
  readonly port: number;
  readonly ip: string;
  readonly url: string;
  readonly outboundPlatformPollRequests: number;
  readonly outboundTelegramSyncChecks: number;
  setIp(ip: string): void;
  setFaultConfig(config: Partial<MockFaultConfig>): void;
  resetFaultConfig(): void;
  seedUser(user: Omit<Partial<MockAndroidUserState>, 'platform'> & { platform: string; username: string }): void;
  setUsers(users: Array<Omit<Partial<MockAndroidUserState>, 'platform'> & { platform: string; username: string }>): void;
  getUsers(): MockAndroidUserState[];
  setUserStatus(platform: string, username: string, status: AndroidUserStatus): void;
  clearActiveRecording(platform: string, username: string): void;
  getActiveRecordings(): string[];
  setLastSyncAt(iso: string | null): void;
  getCapturedRequests(): CapturedRecordRequest[];
  clearCapturedRequests(): void;
  waitForRecord(
    predicate?: (req: CapturedRecordRequest) => boolean,
    timeoutMs?: number
  ): Promise<CapturedRecordRequest>;
  triggerTelegramPendingSyncCheck(): void;
  registerWithPulseRadar(
    pulseRadarUrl: string,
    overrides?: Partial<RegisterRequest>
  ): Promise<{ status: number; body: Record<string, unknown> }>;
  syncWithPulseRadar(
    pulseRadarUrl: string,
    overrides?: Partial<SyncRequest>
  ): Promise<{ status: number; body: SyncResponse | ErrorResponse }>;
  close(): Promise<void>;
}

export interface HttpJsonResult<T = Record<string, unknown>> {
  status: number;
  headers: Headers;
  body: T;
  rawText: string;
}

export interface E2EHarness {
  readonly mode: 'self-test' | 'live-target';
  readonly pulseRadarUrl: string;
  readonly androidTargetUrl: string;
  readonly dataDir: string;
  readonly mockAndroid: MockAndroidReceiver;
  readonly isLiveMode: boolean;
  httpJson<T = Record<string, unknown>>(
    baseUrl: string,
    pathname: string,
    init?: RequestInit
  ): Promise<HttpJsonResult<T>>;
  httpRaw(baseUrl: string, pathname: string, init?: RequestInit): Promise<{ status: number; text: string; headers: Headers }>;
  getHealth(): Promise<HttpJsonResult<HealthResponse>>;
  getAndroidStatus(): Promise<HttpJsonResult<AndroidStatusResponse>>;
  getWorkspaceState(): Promise<HttpJsonResult<{ ok: boolean; state: WorkspaceState | null }>>;
  putWorkspaceState(state: unknown): Promise<HttpJsonResult<{ ok: boolean; error?: string }>>;
  registerAndroid(payload: Record<string, unknown>): Promise<HttpJsonResult<RegisterResponse | ErrorResponse>>;
  syncAndroid(payload: Record<string, unknown>): Promise<HttpJsonResult<SyncResponse | ErrorResponse>>;
  simulateLiveUser(input: LiveSimulationInput): Promise<boolean>;
  tickScan(): Promise<boolean>;
  restartReferenceServer(): Promise<void>;
  cleanup(): Promise<void>;
}
