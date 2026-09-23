export type AppMode = "local" | "demo";
export type GroupColor = "blue" | "violet" | "teal" | "amber";
export type AccountStatus =
  | "active"
  | "auth_error"
  | "needs_check"
  | "disabled"
  | "unverified";

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
  stage: "M1";
  version: "0.1.0";
  sendingEnabled: false;
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
  limitCount: number;
  periodHours: number;
  demo: boolean;
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
  status: "draft";
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface Campaign extends CampaignSummary {
  body: string;
}

export interface Event {
  id: string;
  kind: "group_created" | "draft_created" | "draft_updated" | "demo_seeded";
  title: string;
  detail: string;
  entityType: "group" | "campaign" | "system";
  entityId: string | null;
  createdAt: string;
}

export interface Overview {
  mode: AppMode;
  sendingEnabled: false;
  accountCount: number;
  groupCount: number;
  draftCount: number;
  problemAccountCount: number;
  acceptedToday: 0;
  queuedTasks: 0;
  recentCampaigns: CampaignSummary[];
  recentEvents: Event[];
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

export interface ApiError {
  error: {
    code: string;
    message: string;
    fields?: Record<string, string>;
  };
}
