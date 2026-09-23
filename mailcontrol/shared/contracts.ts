export type AppMode = "local" | "demo";
export type GroupColor = "blue" | "violet" | "teal" | "amber";
export type SenderKind = "test" | "mail";

/** Derived operator-facing account status. */
export type AccountStatus =
  | "active"
  | "quota_exhausted"
  | "temporary_error"
  | "auth_error"
  | "needs_check"
  | "blocked"
  | "disabled"
  | "unverified";
export type ConnectionStatus =
  | "unverified"
  | "ok"
  | "auth_error"
  | "needs_check"
  | "blocked"
  | "temporary_error";

export type CampaignStatus =
  | "draft"
  | "running"
  | "paused"
  | "stopped"
  | "completed"
  | "completed_with_errors";
export type TaskStatus =
  | "pending"
  | "reserved"
  | "sending"
  | "accepted"
  | "failed"
  | "unclear"
  | "cancelled"
  | "excluded"
  | "closed_unconfirmed";
export type AttemptOutcome = "accepted" | "rejected" | "unknown";
export type RejectCategory =
  | "auth"
  | "needs_check"
  | "account_blocked"
  | "recipient"
  | "content_or_policy"
  | "temporary"
  | "connection";
export type EventLevel = "info" | "warning" | "error";

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Health {
  status: "ok";
  database: "connected";
  mode: AppMode;
  stage: "MVP-1";
  version: string;
  senderKind: SenderKind;
  /** True only when real Mail sending is selected in local mode. */
  sendingEnabled: boolean;
  workersAlive: number;
  archiveAvailable: boolean;
}

export interface Group {
  id: string;
  name: string;
  color: GroupColor;
  limitCount: number;
  periodHours: number;
  accountCount: number;
  createdAt: string;
}

export interface Account {
  id: string;
  email: string;
  groupId: string;
  groupName: string;
  groupColor: GroupColor;
  status: AccountStatus;
  connectionStatus: ConnectionStatus;
  connectionError: string | null;
  connectionCheckedAt: string | null;
  manualDisabled: boolean;
  disabledReason: string | null;
  limitCount: number;
  periodHours: number;
  /** Accepted + possible sends inside the sliding window plus in-flight reserves. */
  quotaUsed: number;
  quotaRemaining: number;
  /** When the next slot frees up if the quota is exhausted; null otherwise. */
  nextFreeAt: string | null;
  hasPassword: boolean;
  demo: boolean;
  createdAt: string;
}

export interface CampaignCounts {
  total: number;
  pending: number;
  reserved: number;
  sending: number;
  accepted: number;
  failed: number;
  unclear: number;
  cancelled: number;
  excluded: number;
  closedUnconfirmed: number;
}

export interface CampaignSummary {
  id: string;
  name: string;
  groupId: string;
  groupName: string;
  groupColor: GroupColor;
  subject: string;
  bodyPreview: string;
  senderName: string;
  status: CampaignStatus;
  isTest: boolean;
  revision: number;
  counts: CampaignCounts;
  pauseReason: string | null;
  waitReason: string | null;
  waitUntil: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Campaign extends CampaignSummary {
  body: string;
}

export interface Task {
  id: string;
  campaignId: string;
  email: string;
  position: number;
  status: TaskStatus;
  attemptCount: number;
  nextAttemptAt: string | null;
  accountId: string | null;
  accountEmail: string | null;
  lastErrorCode: string | null;
  lastError: string | null;
  finishedAt: string | null;
  resolvedByOperator: boolean;
  updatedAt: string;
}

export interface Attempt {
  id: string;
  taskId: string;
  campaignId: string;
  accountId: string;
  accountEmail: string;
  number: number;
  workerId: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: AttemptOutcome | null;
  errorCategory: RejectCategory | null;
  errorCode: string | null;
  errorMessage: string | null;
  operatorDecision: "accepted" | "failed" | "closed" | null;
  lateOutcome: string | null;
  lateMessage: string | null;
  lateAt: string | null;
}

export interface Event {
  id: string;
  kind: string;
  level: EventLevel;
  title: string;
  detail: string;
  entityType: string;
  entityId: string | null;
  campaignId: string | null;
  accountId: string | null;
  taskId: string | null;
  attemptId: string | null;
  createdAt: string;
}

export interface WorkerInfo {
  id: string;
  hostname: string;
  pid: number;
  senderKind: string;
  startedAt: string;
  lastHeartbeatAt: string;
  alive: boolean;
}

export interface Overview {
  mode: AppMode;
  senderKind: SenderKind;
  sendingEnabled: boolean;
  /** Attempts accepted by the service since `since` (operator's local midnight). */
  acceptedSince: number;
  since: string;
  queuedTasks: number;
  sendingTasks: number;
  unclearTasks: number;
  accountCount: number;
  availableAccountCount: number;
  problemAccountCount: number;
  groupCount: number;
  campaignCount: number;
  activeCampaigns: CampaignSummary[];
  recentCampaigns: CampaignSummary[];
  recentEvents: Event[];
  workers: WorkerInfo[];
}

export interface Settings {
  mode: AppMode;
  senderKind: SenderKind;
  /** Real Mail sending can be selected only in local mode outside a remote preview. */
  mailSenderAllowed: boolean;
  retryMaxAttempts: number;
  retryBaseMinutes: number;
  retryMaxMinutes: number;
  testSenderDelayMs: number;
  updatedAt: string;
}

export interface UpdateSettings {
  senderKind?: SenderKind;
  retryMaxAttempts?: number;
  retryBaseMinutes?: number;
  retryMaxMinutes?: number;
  testSenderDelayMs?: number;
}

export interface CreateGroup {
  name: string;
  color: GroupColor;
  limitCount: number;
  periodHours: number;
  requestKey: string;
}

export interface DraftInput {
  name: string;
  groupId: string;
  subject: string;
  body: string;
  senderName: string;
}

export interface CreateDraft extends DraftInput {
  requestKey: string;
}

export interface UpdateDraft extends DraftInput {
  revision: number;
}

export type ImportFormat = "lines" | "csv";

export interface ImportPreviewRow {
  line: number;
  email: string | null;
  kind: "new" | "duplicate" | "error";
  reason: string | null;
  existingGroupName: string | null;
  existingGroupId: string | null;
}

export interface AccountImportPreview {
  rows: ImportPreviewRow[];
  newCount: number;
  duplicateCount: number;
  errorCount: number;
  /** Preview stops listing rows after this many but still counts them all. */
  truncated: boolean;
}

export interface AccountImportRequest {
  text: string;
  format: ImportFormat;
  groupId: string;
  limitCount: number;
  periodHours: number;
  duplicateAction: "keep" | "move";
  requestKey: string;
}

export interface ImportErrorRow {
  line: number;
  email: string | null;
  reason: string;
}

export interface AccountImportResult {
  added: number;
  duplicatesKept: number;
  duplicatesMoved: number;
  errors: ImportErrorRow[];
  errorCount: number;
  repeated: boolean;
}

export type BulkAccountAction =
  | { action: "set_limit"; limitCount: number; periodHours: number }
  | { action: "move"; groupId: string }
  | { action: "disable" }
  | { action: "enable" }
  | { action: "check" };

export interface BulkAccountSelection {
  ids?: string[];
  filter?: { q?: string; groupId?: string; status?: string };
}

export type BulkAccountRequest = BulkAccountAction &
  BulkAccountSelection & { requestKey: string };

export interface BulkAccountResult {
  affected: number;
  /** For "check": per-account outcome summary. */
  checked?: { ok: number; problems: number };
}

export interface AccountCheckResult {
  account: Account;
  /** Honest label of what was actually verified. */
  method: "mail_smtp" | "test_sender";
}

export interface RecipientsPreview {
  validCount: number;
  duplicateCount: number;
  invalid: ImportErrorRow[];
  invalidCount: number;
  sample: string[];
}

export interface RecipientsRequest {
  text: string;
  format: ImportFormat;
  requestKey: string;
}

export interface RecipientsResult {
  campaign: Campaign;
  validCount: number;
  duplicateCount: number;
  invalid: ImportErrorRow[];
  invalidCount: number;
}

export interface CampaignActionRequest {
  requestKey: string;
}

export interface TestSendRequest {
  recipient: string;
  requestKey: string;
}

export interface ResolveTaskRequest {
  decision: "accepted" | "failed" | "closed";
  requestKey: string;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    fields?: Record<string, string>;
  };
}
