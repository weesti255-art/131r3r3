import {
  Activity,
  AlertCircle,
  Archive,
  ArrowLeft,
  Settings as SettingsIcon,
  AlertTriangle,
  Cpu,
  Pause,
  Play,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock3,
  Database,
  FilePenLine,
  FileText,
  FolderOpen,
  Home,
  Inbox,
  Info,
  Layers3,
  ListFilter,
  Mail,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  UploadCloud,
  Users,
  WifiOff,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import type {
  Account,
  AccountStatus,
  BulkAccountAction,
  Campaign,
  CampaignSummary,
  Event,
  Group,
  GroupColor,
  Health,
  Overview,
  Page,
} from "../shared/contracts";
import Modal from "./components/Modal";
import BulkActionModal, { type BulkKind } from "./components/BulkActionModal";
import ConfirmDialog from "./components/ConfirmDialog";
import ImportAccountsModal from "./components/ImportAccountsModal";
import RecipientsEditor from "./components/RecipientsEditor";
import CampaignDetailPage, {
  CampaignStatusBadge,
} from "./pages/CampaignDetailPage";
import SettingsPage from "./pages/SettingsPage";
import {
  api,
  createRequestKey,
  displayError,
  isRequestAborted,
} from "./lib/api";
import {
  accountStatusLabels,
  campaignProgress,
  campaignStatusLabels,
  eventKindLabels,
  formatDateTime,
  plural,
  startOfTodayIso,
} from "./lib/format";

type PageName =
  | "overview"
  | "accounts"
  | "campaigns"
  | "campaign"
  | "events"
  | "settings";
type GroupForm = {
  name: string;
  color: GroupColor;
  limitCount: string;
  periodHours: string;
};
type DraftForm = {
  name: string;
  groupId: string;
  senderName: string;
  subject: string;
  body: string;
};
type SubmitError = {
  message: string;
  network: boolean;
  code: string;
  fields?: Record<string, string>;
};
type RequestKey =
  | "overview"
  | "groups"
  | "accounts"
  | "campaigns"
  | "events"
  | "detail";
type ActiveRequest = {
  signal: AbortSignal;
  isCurrent: () => boolean;
};

const EMPTY_GROUP_FORM: GroupForm = {
  name: "",
  color: "blue",
  limitCount: "15",
  periodHours: "24",
};

const EMPTY_DRAFT_FORM: DraftForm = {
  name: "",
  groupId: "",
  senderName: "",
  subject: "",
  body: "",
};

const navItems: Array<{
  path: string;
  label: string;
  page: PageName;
  icon: typeof Home;
}> = [
  { path: "/", label: "Главная", page: "overview", icon: Home },
  { path: "/accounts", label: "Аккаунты", page: "accounts", icon: Mail },
  { path: "/campaigns", label: "Рассылки", page: "campaigns", icon: Send },
  { path: "/events", label: "События", page: "events", icon: Activity },
  {
    path: "/settings",
    label: "Настройки",
    page: "settings",
    icon: SettingsIcon,
  },
];

const groupColors: Array<{ value: GroupColor; label: string }> = [
  { value: "blue", label: "Синий" },
  { value: "violet", label: "Фиолетовый" },
  { value: "teal", label: "Бирюзовый" },
  { value: "amber", label: "Янтарный" },
];

const statusLabels = accountStatusLabels;
const eventLabels = eventKindLabels;

function routeFromPath(): PageName {
  const path = window.location.pathname;
  if (path.startsWith("/accounts")) return "accounts";
  if (/^\/campaigns\/[0-9a-f-]{36}$/i.test(path)) return "campaign";
  if (path.startsWith("/campaigns")) return "campaigns";
  if (path.startsWith("/events")) return "events";
  if (path.startsWith("/settings")) return "settings";
  return "overview";
}

function campaignIdFromPath(): string | null {
  const match = window.location.pathname.match(
    /^\/campaigns\/([0-9a-f-]{36})$/i
  );
  return match ? match[1] : null;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Дата неизвестна";
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

function formatShortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formSignature(form: GroupForm | DraftForm): string {
  return JSON.stringify(form);
}

function parsePositiveInteger(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function groupColorClass(color: GroupColor): string {
  return `color-${color}`;
}

function eventIcon(kind: string): ReactNode {
  if (kind === "group_created") return <Users size={16} aria-hidden="true" />;
  if (kind === "demo_seeded") return <Sparkles size={16} aria-hidden="true" />;
  return <FilePenLine size={16} aria-hidden="true" />;
}

function LoadingState({ label = "Загружаем данные…" }: { label?: string }) {
  return (
    <div className="loading-state" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="state-card state-card--error" role="alert">
      <span className="state-icon state-icon--error">
        <WifiOff size={20} aria-hidden="true" />
      </span>
      <div>
        <strong>Не удалось загрузить данные</strong>
        <p>{message}</p>
      </div>
      <button
        type="button"
        className="button button--secondary"
        onClick={onRetry}
      >
        <RefreshCw size={16} aria-hidden="true" />
        Повторить
      </button>
    </div>
  );
}

function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-state__icon">{icon}</span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
  hint,
  tone = "blue",
}: {
  icon: ReactNode;
  label: string;
  value: string | number;
  hint: string;
  tone?: "blue" | "green" | "amber" | "violet";
}) {
  return (
    <article className="metric-card">
      <span className={`metric-icon metric-icon--${tone}`}>{icon}</span>
      <div className="metric-card__text">
        <span className="metric-label">{label}</span>
        <strong>{value}</strong>
        <span className="metric-hint">{hint}</span>
      </div>
    </article>
  );
}

function GroupBadge({ group }: { group: Pick<Group, "name" | "color"> }) {
  return (
    <span className="group-badge">
      <span
        className={`group-dot ${groupColorClass(group.color)}`}
        aria-hidden="true"
      />
      {group.name}
    </span>
  );
}

function StatusBadge({ status }: { status: Account["status"] }) {
  return (
    <span className={`status-badge status-badge--${status}`}>
      <span className="status-dot" aria-hidden="true" />
      {statusLabels[status]}
    </span>
  );
}

function DemoBanner({ mode }: { mode: Health["mode"] | Overview["mode"] }) {
  if (mode !== "demo") return null;
  return (
    <div className="demo-banner">
      <span className="demo-banner__icon">
        <Sparkles size={17} aria-hidden="true" />
      </span>
      <div>
        <strong>Демонстрационный режим</strong>
        <span>
          Тестовый отправитель, подключений к Mail нет · данные отделены от
          локальной работы
        </span>
      </div>
      <span className="demo-banner__tag">demo</span>
    </div>
  );
}

function App() {
  const [route, setRoute] = useState<PageName>(() => routeFromPath());
  const [health, setHealth] = useState<Health | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [routeCampaignId, setRouteCampaignId] = useState<string | null>(() =>
    campaignIdFromPath()
  );

  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [groupsPage, setGroupsPage] = useState<Page<Group> | null>(null);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [groupsError, setGroupsError] = useState<string | null>(null);
  const [accountsPage, setAccountsPage] = useState<Page<Account> | null>(null);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [campaignsPage, setCampaignsPage] =
    useState<Page<CampaignSummary> | null>(null);
  const [campaignsLoading, setCampaignsLoading] = useState(false);
  const [campaignsError, setCampaignsError] = useState<string | null>(null);
  const [eventsPage, setEventsPage] = useState<Page<Event> | null>(null);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);

  const [accountSearch, setAccountSearch] = useState("");
  const [accountStatus, setAccountStatus] = useState("all");
  const [accountGroupId, setAccountGroupId] = useState("");
  const [accountPage, setAccountPage] = useState(1);
  const [accountPageSize, setAccountPageSize] = useState(20);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectionByFilter, setSelectionByFilter] = useState(false);
  const [bulkKind, setBulkKind] = useState<BulkKind | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [campaignSearch, setCampaignSearch] = useState("");
  const [campaignStatus, setCampaignStatus] = useState("all");
  const [campaignPage, setCampaignPage] = useState(1);
  const [eventKind, setEventKind] = useState("all");
  const [eventLevel, setEventLevel] = useState("all");
  const [eventSearch, setEventSearch] = useState("");
  const [eventPage, setEventPage] = useState(1);

  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [groupForm, setGroupForm] = useState<GroupForm>(EMPTY_GROUP_FORM);
  const [groupRequestKey, setGroupRequestKey] = useState("");
  const [groupDirty, setGroupDirty] = useState(false);
  const [groupClosePrompt, setGroupClosePrompt] = useState(false);
  const [groupSubmitError, setGroupSubmitError] = useState<SubmitError | null>(
    null
  );
  const [groupFieldErrors, setGroupFieldErrors] = useState<
    Record<string, string>
  >({});
  const [groupRetrySignature, setGroupRetrySignature] = useState<string | null>(
    null
  );
  const [groupSaving, setGroupSaving] = useState(false);

  const [importModalOpen, setImportModalOpen] = useState(false);

  const [draftModalOpen, setDraftModalOpen] = useState(false);
  const [draftMode, setDraftMode] = useState<"create" | "edit">("create");
  const [draftId, setDraftId] = useState<string | null>(null);
  const [draftRevision, setDraftRevision] = useState(0);
  const [draftForm, setDraftForm] = useState<DraftForm>(EMPTY_DRAFT_FORM);
  const [draftStep, setDraftStep] = useState(1);
  const [draftDirty, setDraftDirty] = useState(false);
  const [draftClosePrompt, setDraftClosePrompt] = useState(false);
  const [draftRequestKey, setDraftRequestKey] = useState("");
  const [draftRetrySignature, setDraftRetrySignature] = useState<string | null>(
    null
  );
  const [draftSubmitError, setDraftSubmitError] = useState<SubmitError | null>(
    null
  );
  const [draftFieldErrors, setDraftFieldErrors] = useState<
    Record<string, string>
  >({});
  const [draftSaving, setDraftSaving] = useState(false);
  const [draftLoading, setDraftLoading] = useState(false);
  const [draftLoadError, setDraftLoadError] = useState<string | null>(null);
  const [draftCampaign, setDraftCampaign] = useState<Campaign | null>(null);
  const [startPrompt, setStartPrompt] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const groupSavingRef = useRef(false);
  const draftSavingRef = useRef(false);
  const requestControllersRef = useRef<
    Partial<Record<RequestKey, AbortController>>
  >({});
  const requestGenerationsRef = useRef<Partial<Record<RequestKey, number>>>({});

  const beginRequest = useCallback((key: RequestKey): ActiveRequest => {
    requestControllersRef.current[key]?.abort();
    const generation = (requestGenerationsRef.current[key] ?? 0) + 1;
    const controller = new AbortController();
    requestGenerationsRef.current[key] = generation;
    requestControllersRef.current[key] = controller;
    return {
      signal: controller.signal,
      isCurrent: () => requestGenerationsRef.current[key] === generation,
    };
  }, []);

  useEffect(() => {
    return () => {
      Object.values(requestControllersRef.current).forEach((controller) =>
        controller?.abort()
      );
    };
  }, []);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 4200);
  }, []);

  const navigate = useCallback((path: string) => {
    if (window.location.pathname !== path) {
      window.history.pushState({}, "", path);
    }
    setRoute(routeFromPath());
    setRouteCampaignId(campaignIdFromPath());
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const openGroup = useCallback(
    (id: string) => {
      setAccountGroupId(id);
      setAccountPage(1);
      navigate("/accounts");
    },
    [navigate]
  );

  useEffect(() => {
    const onPopState = () => {
      setRoute(routeFromPath());
      setRouteCampaignId(campaignIdFromPath());
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const refreshHealth = useCallback(async () => {
    setHealthLoading(true);
    try {
      const nextHealth = await api.health();
      setHealth(nextHealth);
      setHealthError(null);
    } catch (error) {
      setHealthError(displayError(error).message);
    } finally {
      setHealthLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshHealth();
    const timer = window.setInterval(() => void refreshHealth(), 15_000);
    return () => window.clearInterval(timer);
  }, [refreshHealth]);

  const loadOverview = useCallback(async () => {
    const request = beginRequest("overview");
    setOverviewLoading(true);
    setOverviewError(null);
    try {
      const nextOverview = await api.overview(startOfTodayIso(), {
        signal: request.signal,
      });
      if (request.isCurrent()) setOverview(nextOverview);
    } catch (error) {
      if (request.isCurrent() && !isRequestAborted(error)) {
        setOverviewError(displayError(error).message);
      }
    } finally {
      if (request.isCurrent()) setOverviewLoading(false);
    }
  }, [beginRequest]);

  const loadGroups = useCallback(async () => {
    const request = beginRequest("groups");
    setGroupsLoading(true);
    setGroupsError(null);
    try {
      const nextGroups = await api.groups(
        { page: 1, pageSize: 100 },
        { signal: request.signal }
      );
      if (request.isCurrent()) setGroupsPage(nextGroups);
    } catch (error) {
      if (request.isCurrent() && !isRequestAborted(error)) {
        setGroupsError(displayError(error).message);
      }
    } finally {
      if (request.isCurrent()) setGroupsLoading(false);
    }
  }, [beginRequest]);

  const loadAccounts = useCallback(async () => {
    const request = beginRequest("accounts");
    setAccountsLoading(true);
    setAccountsError(null);
    try {
      const nextAccounts = await api.accounts(
        {
          page: accountPage,
          pageSize: accountPageSize,
          q: accountSearch.trim() || undefined,
          groupId: accountGroupId || undefined,
          status: accountStatus,
        },
        { signal: request.signal }
      );
      if (request.isCurrent()) setAccountsPage(nextAccounts);
    } catch (error) {
      if (request.isCurrent() && !isRequestAborted(error)) {
        setAccountsError(displayError(error).message);
      }
    } finally {
      if (request.isCurrent()) setAccountsLoading(false);
    }
  }, [
    accountGroupId,
    accountPage,
    accountPageSize,
    accountSearch,
    accountStatus,
    beginRequest,
  ]);

  const loadCampaigns = useCallback(async () => {
    const request = beginRequest("campaigns");
    setCampaignsLoading(true);
    setCampaignsError(null);
    try {
      const nextCampaigns = await api.campaigns(
        {
          page: campaignPage,
          pageSize: 10,
          q: campaignSearch.trim() || undefined,
          status: campaignStatus,
        },
        { signal: request.signal }
      );
      if (request.isCurrent()) setCampaignsPage(nextCampaigns);
    } catch (error) {
      if (request.isCurrent() && !isRequestAborted(error)) {
        setCampaignsError(displayError(error).message);
      }
    } finally {
      if (request.isCurrent()) setCampaignsLoading(false);
    }
  }, [beginRequest, campaignPage, campaignSearch, campaignStatus]);

  const loadEvents = useCallback(async () => {
    const request = beginRequest("events");
    setEventsLoading(true);
    setEventsError(null);
    try {
      const nextEvents = await api.events(
        {
          page: eventPage,
          pageSize: 15,
          kind: eventKind,
          level: eventLevel,
          q: eventSearch.trim() || undefined,
        },
        { signal: request.signal }
      );
      if (request.isCurrent()) setEventsPage(nextEvents);
    } catch (error) {
      if (request.isCurrent() && !isRequestAborted(error)) {
        setEventsError(displayError(error).message);
      }
    } finally {
      if (request.isCurrent()) setEventsLoading(false);
    }
  }, [beginRequest, eventKind, eventLevel, eventPage, eventSearch]);

  useEffect(() => {
    if (route !== "overview") return;
    void loadOverview();
    const timer = window.setInterval(() => void loadOverview(), 10_000);
    return () => window.clearInterval(timer);
  }, [loadOverview, refreshToken, route]);

  useEffect(() => {
    if (route !== "events" && route !== "settings") void loadGroups();
  }, [loadGroups, refreshToken, route]);

  useEffect(() => {
    if (route === "accounts") void loadAccounts();
  }, [loadAccounts, refreshToken, route]);

  useEffect(() => {
    if (route === "campaigns") void loadCampaigns();
  }, [loadCampaigns, refreshToken, route]);

  useEffect(() => {
    if (route === "events") void loadEvents();
  }, [loadEvents, refreshToken, route]);

  const groups = groupsPage?.items ?? [];

  const openGroupModal = useCallback(() => {
    if (groupSavingRef.current) return;
    setGroupForm({ ...EMPTY_GROUP_FORM });
    setGroupRequestKey(createRequestKey());
    setGroupDirty(false);
    setGroupClosePrompt(false);
    setGroupSubmitError(null);
    setGroupFieldErrors({});
    setGroupRetrySignature(null);
    setGroupModalOpen(true);
  }, []);

  const requestCloseGroup = useCallback(() => {
    if (groupSavingRef.current || groupSaving) return;
    if (groupDirty) {
      setGroupClosePrompt(true);
      return;
    }
    setGroupModalOpen(false);
  }, [groupDirty, groupSaving]);

  const updateGroupForm = useCallback(
    (patch: Partial<GroupForm>) => {
      if (groupSavingRef.current || groupSaving) return;
      const next = { ...groupForm, ...patch };
      if (
        groupRetrySignature !== null &&
        formSignature(next) !== groupRetrySignature
      ) {
        setGroupRequestKey(createRequestKey());
        setGroupRetrySignature(null);
        setGroupSubmitError(null);
      }
      setGroupForm(next);
      setGroupDirty(true);
      setGroupClosePrompt(false);
    },
    [groupForm, groupRetrySignature, groupSaving]
  );

  const validateGroup = useCallback(() => {
    const errors: Record<string, string> = {};
    if (!groupForm.name.trim()) errors.name = "Введите название группы.";
    if (!parsePositiveInteger(groupForm.limitCount)) {
      errors.limitCount = "Укажите положительное целое число.";
    }
    if (!parsePositiveInteger(groupForm.periodHours)) {
      errors.periodHours = "Укажите положительное целое число.";
    }
    setGroupFieldErrors(errors);
    return errors;
  }, [groupForm]);

  const saveGroup = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (groupSavingRef.current || groupSaving) return;
      if (Object.keys(validateGroup()).length > 0) return;
      groupSavingRef.current = true;
      setGroupSaving(true);
      setGroupSubmitError(null);
      try {
        await api.createGroup({
          name: groupForm.name.trim(),
          color: groupForm.color,
          limitCount: parsePositiveInteger(groupForm.limitCount)!,
          periodHours: parsePositiveInteger(groupForm.periodHours)!,
          requestKey: groupRequestKey,
        });
        setGroupDirty(false);
        setGroupModalOpen(false);
        setRefreshToken((value) => value + 1);
        showToast("Группа сохранена");
      } catch (error) {
        const nextError = displayError(error);
        setGroupSubmitError(nextError);
        if (nextError.fields) setGroupFieldErrors(nextError.fields);
        if (nextError.network) setGroupRetrySignature(formSignature(groupForm));
      } finally {
        groupSavingRef.current = false;
        setGroupSaving(false);
      }
    },
    [groupForm, groupRequestKey, groupSaving, showToast, validateGroup]
  );

  const openImportModal = useCallback(() => setImportModalOpen(true), []);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setSelectionByFilter(false);
  }, []);

  const toggleSelected = useCallback((id: string, checked: boolean) => {
    setSelectionByFilter(false);
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const selectedCount = selectionByFilter
    ? accountsPage?.total ?? 0
    : selectedIds.size;

  const runBulk = useCallback(
    async (action: BulkAccountAction) => {
      if (selectedCount === 0) return;
      setBulkBusy(true);
      setBulkError(null);
      try {
        const selection = selectionByFilter
          ? {
              filter: {
                q: accountSearch.trim(),
                groupId: accountGroupId || undefined,
                status: accountStatus,
              },
            }
          : { ids: [...selectedIds] };
        const result = await api.bulkAccounts({
          ...action,
          ...selection,
          requestKey: createRequestKey(),
        });
        setBulkKind(null);
        if (action.action === "check" && result.checked) {
          showToast(
            `Проверено ${result.affected}: без замечаний ${result.checked.ok}, с проблемами ${result.checked.problems}`
          );
        } else {
          showToast(`Действие применено к ${result.affected} аккаунтам`);
        }
        if (action.action !== "check") clearSelection();
        setRefreshToken((value) => value + 1);
      } catch (error) {
        setBulkError(displayError(error).message);
      } finally {
        setBulkBusy(false);
      }
    },
    [
      accountGroupId,
      accountSearch,
      accountStatus,
      clearSelection,
      selectedCount,
      selectedIds,
      selectionByFilter,
      showToast,
    ]
  );

  const checkOneAccount = useCallback(
    async (account: Account) => {
      try {
        const result = await api.checkAccount(account.id, createRequestKey());
        showToast(
          `${account.email}: ${statusLabels[result.account.status]} (${result.method === "mail_smtp" ? "проверка Mail SMTP" : "тестовый отправитель, не Mail"})`
        );
        setRefreshToken((value) => value + 1);
      } catch (error) {
        showToast(displayError(error).message);
      }
    },
    [showToast]
  );

  const openCampaign = useCallback(
    (id: string) => navigate(`/campaigns/${id}`),
    [navigate]
  );

  const resetDraft = useCallback(() => {
    if (draftSavingRef.current) return;
    beginRequest("detail");
    setDraftMode("create");
    setDraftId(null);
    setDraftRevision(0);
    setDraftForm({ ...EMPTY_DRAFT_FORM, groupId: groups[0]?.id ?? "" });
    setDraftStep(1);
    setDraftDirty(false);
    setDraftClosePrompt(false);
    setDraftRequestKey(createRequestKey());
    setDraftRetrySignature(null);
    setDraftSubmitError(null);
    setDraftFieldErrors({});
    setDraftLoading(false);
    setDraftLoadError(null);
    setDraftCampaign(null);
    setStartError(null);
    setDraftModalOpen(true);
  }, [beginRequest, groups]);

  const openDraft = useCallback(
    async (id: string) => {
      if (draftSavingRef.current) return;
      const request = beginRequest("detail");
      setDraftMode("edit");
      setDraftId(id);
      setDraftRevision(0);
      setDraftForm({ ...EMPTY_DRAFT_FORM });
      setDraftStep(1);
      setDraftDirty(false);
      setDraftClosePrompt(false);
      setDraftRequestKey("");
      setDraftRetrySignature(null);
      setDraftSubmitError(null);
      setDraftFieldErrors({});
      setDraftLoading(true);
      setDraftLoadError(null);
      setDraftModalOpen(true);
      setDraftCampaign(null);
      setStartError(null);
      try {
        const campaign = await api.campaign(id, { signal: request.signal });
        if (!request.isCurrent()) return;
        if (campaign.status !== "draft") {
          setDraftModalOpen(false);
          navigate(`/campaigns/${campaign.id}`);
          return;
        }
        setDraftCampaign(campaign);
        setDraftForm({
          name: campaign.name,
          groupId: campaign.groupId,
          senderName: campaign.senderName,
          subject: campaign.subject,
          body: campaign.body,
        });
        setDraftRevision(campaign.revision);
      } catch (error) {
        if (request.isCurrent() && !isRequestAborted(error)) {
          setDraftLoadError(displayError(error).message);
        }
      } finally {
        if (request.isCurrent()) setDraftLoading(false);
      }
    },
    [beginRequest, navigate]
  );

  const requestCloseDraft = useCallback(() => {
    if (draftSavingRef.current || draftSaving) return;
    if (draftDirty) {
      setDraftClosePrompt(true);
      return;
    }
    setDraftModalOpen(false);
  }, [draftDirty, draftSaving]);

  const updateDraftForm = useCallback(
    (patch: Partial<DraftForm>) => {
      if (draftSavingRef.current || draftSaving) return;
      const next = { ...draftForm, ...patch };
      if (
        draftRetrySignature !== null &&
        formSignature(next) !== draftRetrySignature
      ) {
        if (draftMode === "create") setDraftRequestKey(createRequestKey());
        setDraftRetrySignature(null);
        setDraftSubmitError(null);
      }
      setDraftForm(next);
      setDraftDirty(true);
      setDraftClosePrompt(false);
    },
    [draftForm, draftMode, draftRetrySignature, draftSaving]
  );

  const validateDraftRequired = useCallback(() => {
    const errors: Record<string, string> = {};
    if (!draftForm.name.trim()) errors.name = "Введите название рассылки.";
    if (!draftForm.groupId) errors.groupId = "Выберите группу отправителей.";
    setDraftFieldErrors(errors);
    return errors;
  }, [draftForm]);

  const persistDraft = useCallback(async (): Promise<Campaign | null> => {
    const input = {
      name: draftForm.name.trim(),
      groupId: draftForm.groupId,
      senderName: draftForm.senderName.trim(),
      subject: draftForm.subject,
      body: draftForm.body,
    };
    let campaign: Campaign;
    if (draftMode === "create" || !draftId) {
      campaign = await api.createDraft({
        ...input,
        requestKey: draftRequestKey,
      });
      setDraftMode("edit");
      setDraftId(campaign.id);
    } else {
      campaign = await api.updateDraft(draftId, {
        ...input,
        revision: draftRevision,
      });
    }
    setDraftRevision(campaign.revision);
    setDraftCampaign(campaign);
    setDraftDirty(false);
    return campaign;
  }, [draftForm, draftId, draftMode, draftRequestKey, draftRevision]);

  const saveDraft = useCallback(
    async (options: { close: boolean } = { close: true }) => {
      if (draftSavingRef.current || draftSaving) return null;
      if (Object.keys(validateDraftRequired()).length > 0) {
        setDraftStep(1);
        return null;
      }
      draftSavingRef.current = true;
      setDraftSaving(true);
      setDraftSubmitError(null);
      try {
        const campaign =
          draftDirty || !draftCampaign ? await persistDraft() : draftCampaign;
        if (options.close) {
          setDraftModalOpen(false);
          showToast("Черновик сохранён");
        }
        setRefreshToken((value) => value + 1);
        return campaign;
      } catch (error) {
        const nextError = displayError(error);
        setDraftSubmitError(nextError);
        if (nextError.fields) setDraftFieldErrors(nextError.fields);
        if (nextError.network) setDraftRetrySignature(formSignature(draftForm));
        return null;
      } finally {
        draftSavingRef.current = false;
        setDraftSaving(false);
      }
    },
    [
      draftCampaign,
      draftDirty,
      draftForm,
      draftSaving,
      persistDraft,
      showToast,
      validateDraftRequired,
    ]
  );

  // Recipients belong to a saved draft, so leaving step 1 saves it first.
  const nextDraftStep = useCallback(async () => {
    if (draftSavingRef.current || draftSaving) return;
    if (draftStep === 1) {
      if (Object.keys(validateDraftRequired()).length > 0) return;
      if (!(await saveDraft({ close: false }))) return;
    }
    setDraftStep((step) => Math.min(4, step + 1));
  }, [draftSaving, draftStep, saveDraft, validateDraftRequired]);

  const startDraft = useCallback(async () => {
    setStarting(true);
    setStartError(null);
    try {
      const campaign = await saveDraft({ close: false });
      if (!campaign) {
        setStartError("Сначала исправьте ошибки черновика.");
        return;
      }
      const started = await api.campaignAction(
        campaign.id,
        "start",
        createRequestKey()
      );
      setStartPrompt(false);
      setDraftDirty(false);
      setDraftModalOpen(false);
      showToast("Рассылка запущена");
      navigate(`/campaigns/${started.id}`);
    } catch (error) {
      setStartError(displayError(error).message);
    } finally {
      setStarting(false);
    }
  }, [navigate, saveDraft, showToast]);

  const testSend = useCallback(
    async (recipient: string) => {
      setStarting(true);
      setStartError(null);
      try {
        const campaign = await saveDraft({ close: false });
        if (!campaign) {
          setStartError("Сначала исправьте ошибки черновика.");
          return;
        }
        const test = await api.testSend(
          campaign.id,
          recipient,
          createRequestKey()
        );
        setDraftDirty(false);
        setDraftModalOpen(false);
        showToast("Тестовая отправка поставлена в очередь");
        navigate(`/campaigns/${test.id}`);
      } catch (error) {
        setStartError(displayError(error).message);
      } finally {
        setStarting(false);
      }
    },
    [navigate, saveDraft, showToast]
  );

  const retryDraftDetail = useCallback(() => {
    if (draftId) void openDraft(draftId);
  }, [draftId, openDraft]);

  const headerTitle =
    route === "overview"
      ? "Главная"
      : route === "accounts"
        ? "Аккаунты"
        : route === "campaigns" || route === "campaign"
          ? "Рассылки"
          : route === "settings"
            ? "Настройки"
            : "События";

  return (
    <div className="app-shell">
      <Sidebar
        route={route}
        health={health}
        onNavigate={navigate}
        onCreateDraft={resetDraft}
      />
      <div className="app-main">
        <header className="topbar">
          <div className="topbar__context">
            <span className="topbar__eyebrow">MailControl</span>
            <span className="topbar__divider" aria-hidden="true" />
            <span className="topbar__page">{headerTitle}</span>
          </div>
          <div className="topbar__actions">
            {health?.archiveAvailable ? (
              <a className="archive-link" href="/download/mailcontrol.zip">
                <Archive size={15} aria-hidden="true" />
                Скачать .zip
              </a>
            ) : null}
            <HealthStatus
              health={health}
              loading={healthLoading}
              error={healthError}
              onRetry={refreshHealth}
            />
          </div>
        </header>

        <main className="page-content">
          <DemoBanner mode={health?.mode ?? overview?.mode ?? "local"} />
          {healthError ? (
            <div className="connection-banner" role="alert">
              <WifiOff size={17} aria-hidden="true" />
              <span>{healthError}</span>
              <button
                type="button"
                className="text-button"
                onClick={refreshHealth}
              >
                Повторить
              </button>
            </div>
          ) : null}
          {route === "overview" ? (
            <OverviewPage
              overview={overview}
              loading={overviewLoading}
              error={overviewError}
              onRetry={loadOverview}
              onCreateDraft={resetDraft}
              onNavigate={navigate}
              onOpenCampaign={openCampaign}
            />
          ) : null}
          {route === "accounts" ? (
            <AccountsPage
              groups={groups}
              groupsLoading={groupsLoading}
              groupsError={groupsError}
              accounts={accountsPage}
              loading={accountsLoading}
              error={accountsError}
              search={accountSearch}
              status={accountStatus}
              groupId={accountGroupId}
              page={accountPage}
              onSearch={(value) => {
                setAccountPage(1);
                setAccountSearch(value);
              }}
              onStatus={(value) => {
                setAccountPage(1);
                setAccountStatus(value);
              }}
              onGroup={(value) => {
                setAccountPage(1);
                setAccountGroupId(value);
              }}
              onPage={setAccountPage}
              pageSize={accountPageSize}
              onPageSize={(value) => {
                setAccountPage(1);
                setAccountPageSize(value);
              }}
              selectedIds={selectedIds}
              selectionByFilter={selectionByFilter}
              selectedCount={selectedCount}
              onToggle={toggleSelected}
              onSelectPage={(ids, checked) => {
                setSelectionByFilter(false);
                setSelectedIds((current) => {
                  const next = new Set(current);
                  ids.forEach((id) =>
                    checked ? next.add(id) : next.delete(id)
                  );
                  return next;
                });
              }}
              onSelectFilter={() => {
                setSelectedIds(new Set());
                setSelectionByFilter(true);
              }}
              onClearSelection={clearSelection}
              onBulk={(kind) => {
                setBulkError(null);
                setBulkKind(kind);
              }}
              onCheckOne={(account) => void checkOneAccount(account)}
              onRetry={() => {
                void loadAccounts();
                void loadGroups();
              }}
              onCreateGroup={openGroupModal}
              onImport={openImportModal}
            />
          ) : null}
          {route === "campaigns" ? (
            <CampaignsPage
              campaigns={campaignsPage}
              groups={groups}
              loading={campaignsLoading}
              error={campaignsError}
              search={campaignSearch}
              status={campaignStatus}
              page={campaignPage}
              onSearch={(value) => {
                setCampaignPage(1);
                setCampaignSearch(value);
              }}
              onStatus={(value) => {
                setCampaignPage(1);
                setCampaignStatus(value);
              }}
              onPage={setCampaignPage}
              onRetry={loadCampaigns}
              onCreate={resetDraft}
              onOpen={(campaign) =>
                campaign.status === "draft"
                  ? void openDraft(campaign.id)
                  : openCampaign(campaign.id)
              }
            />
          ) : null}
          {route === "campaign" && routeCampaignId ? (
            <CampaignDetailPage
              key={routeCampaignId}
              id={routeCampaignId}
              onBack={() => navigate("/campaigns")}
              onEditDraft={(id) => void openDraft(id)}
              onToast={showToast}
            />
          ) : null}
          {route === "settings" ? (
            <SettingsPage
              health={health}
              onToast={showToast}
              onSettingsChanged={() => void refreshHealth()}
            />
          ) : null}
          {route === "events" ? (
            <EventsPage
              events={eventsPage}
              loading={eventsLoading}
              error={eventsError}
              kind={eventKind}
              level={eventLevel}
              search={eventSearch}
              page={eventPage}
              onKind={(value) => {
                setEventPage(1);
                setEventKind(value);
              }}
              onLevel={(value) => {
                setEventPage(1);
                setEventLevel(value);
              }}
              onSearch={(value) => {
                setEventPage(1);
                setEventSearch(value);
              }}
              onPage={setEventPage}
              onRetry={loadEvents}
              onOpenCampaign={openCampaign}
              onOpenGroup={openGroup}
              onOpenAccount={(email) => {
                setAccountSearch(email);
                setAccountStatus("all");
                setAccountGroupId("");
                setAccountPage(1);
                navigate("/accounts");
              }}
            />
          ) : null}
        </main>
      </div>

      <GroupModal
        open={groupModalOpen}
        form={groupForm}
        dirty={groupDirty}
        closePrompt={groupClosePrompt}
        saving={groupSaving}
        submitError={groupSubmitError}
        fieldErrors={groupFieldErrors}
        onChange={updateGroupForm}
        onSubmit={saveGroup}
        onRequestClose={requestCloseGroup}
        onCancelClose={() => setGroupClosePrompt(false)}
        onConfirmClose={() => {
          if (groupSavingRef.current || groupSaving) return;
          setGroupDirty(false);
          setGroupClosePrompt(false);
          setGroupModalOpen(false);
        }}
      />

      <ImportAccountsModal
        open={importModalOpen}
        groups={groups}
        onClose={() => setImportModalOpen(false)}
        onImported={() => setRefreshToken((value) => value + 1)}
      />

      <BulkActionModal
        kind={bulkKind}
        count={selectedCount}
        groups={groups}
        senderKind={health?.senderKind ?? "test"}
        busy={bulkBusy}
        error={bulkError}
        onCancel={() => {
          if (!bulkBusy) setBulkKind(null);
        }}
        onConfirm={(action) => void runBulk(action)}
      />

      <DraftWizard
        open={draftModalOpen}
        mode={draftMode}
        form={draftForm}
        step={draftStep}
        groups={groups}
        closePrompt={draftClosePrompt}
        loading={draftLoading}
        loadError={draftLoadError}
        saving={draftSaving}
        submitError={draftSubmitError}
        fieldErrors={draftFieldErrors}
        onChange={updateDraftForm}
        onStep={(nextStep) => {
          if (!draftSavingRef.current && !draftSaving) setDraftStep(nextStep);
        }}
        onNext={() => void nextDraftStep()}
        onSave={() => void saveDraft({ close: true })}
        campaign={draftCampaign}
        starting={starting}
        startError={startError}
        onRecipientsSaved={(campaign) => {
          setDraftCampaign(campaign);
          setRefreshToken((value) => value + 1);
        }}
        onStart={() => {
          setStartError(null);
          setStartPrompt(true);
        }}
        onTestSend={(recipient) => void testSend(recipient)}
        onRequestClose={requestCloseDraft}
        onCancelClose={() => setDraftClosePrompt(false)}
        onConfirmClose={() => {
          if (draftSavingRef.current || draftSaving) return;
          setDraftDirty(false);
          setDraftClosePrompt(false);
          setDraftModalOpen(false);
        }}
        onRetryLoad={retryDraftDetail}
      />

      <ConfirmDialog
        open={startPrompt}
        title="Запустить рассылку?"
        description={`Получателей: ${draftCampaign?.counts.total ?? 0}. Тема, текст и список будут зафиксированы; дальнейшие изменения — только новой рассылкой.`}
        confirmLabel="Запустить"
        busy={starting}
        error={startError}
        onCancel={() => {
          if (!starting) setStartPrompt(false);
        }}
        onConfirm={() => void startDraft()}
      />

      {toast ? (
        <div className="toast" role="status">
          <CheckCircle2 size={18} aria-hidden="true" />
          {toast}
          <button
            type="button"
            className="toast__close"
            onClick={() => setToast(null)}
          >
            <X size={15} aria-label="Закрыть уведомление" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Sidebar({
  route,
  health,
  onNavigate,
  onCreateDraft,
}: {
  route: PageName;
  health: Health | null;
  onNavigate: (path: string) => void;
  onCreateDraft: () => void;
}) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand__mark">
          <Mail size={22} strokeWidth={2.4} aria-hidden="true" />
        </span>
        <span>
          <strong>MailControl</strong>
          <small>Управление рассылками</small>
        </span>
      </div>
      <div className="sidebar__section-label">Рабочая область</div>
      <nav className="sidebar__nav" aria-label="Основная навигация">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <button
              type="button"
              className={`nav-item${route === item.page ? " nav-item--active" : ""}`}
              key={item.path}
              onClick={() => onNavigate(item.path)}
              aria-current={route === item.page ? "page" : undefined}
            >
              <Icon
                size={18}
                strokeWidth={route === item.page ? 2.4 : 1.9}
                aria-hidden="true"
              />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
      <div className="sidebar__create">
        <button
          type="button"
          className="button button--primary button--full"
          onClick={onCreateDraft}
        >
          <Plus size={17} aria-hidden="true" />
          Новый черновик
        </button>
      </div>
      <div className="sidebar__bottom">
        <div className="sidebar-note">
          <span className="sidebar-note__icon">
            <ShieldCheck size={16} aria-hidden="true" />
          </span>
          <div>
            <strong>
              {health?.sendingEnabled
                ? "Реальная отправка Mail"
                : "Тестовый отправитель"}
            </strong>
            <span>
              {health
                ? `${health.workersAlive} ${plural(health.workersAlive, "процесс", "процесса", "процессов")} отправки`
                : "Проверяем состояние…"}
            </span>
          </div>
        </div>
        <div className="sidebar__meta">
          <span className="mini-dot mini-dot--blue" aria-hidden="true" />
          {health?.mode === "demo" ? "Демо-данные" : "Локальная база"}
        </div>
        <div className="sidebar__meta">Время: {timeZone}</div>
      </div>
    </aside>
  );
}

function HealthStatus({
  health,
  loading,
  error,
  onRetry,
}: {
  health: Health | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  if (loading && !health) {
    return (
      <span className="health-pill health-pill--pending">
        Проверяем систему…
      </span>
    );
  }
  if (error) {
    return (
      <button
        type="button"
        className="health-pill health-pill--error"
        onClick={onRetry}
      >
        <span className="health-pill__dot" aria-hidden="true" />
        Нет связи с сервером
      </button>
    );
  }
  return (
    <span className="health-pill">
      <span className="health-pill__dot" aria-hidden="true" />
      API и БД доступны
    </span>
  );
}

function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        {eyebrow ? <div className="page-eyebrow">{eyebrow}</div> : null}
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action ? <div className="page-header__action">{action}</div> : null}
    </div>
  );
}

function OverviewPage({
  overview,
  loading,
  error,
  onRetry,
  onCreateDraft,
  onNavigate,
  onOpenCampaign,
}: {
  overview: Overview | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onCreateDraft: () => void;
  onNavigate: (path: string) => void;
  onOpenCampaign: (id: string) => void;
}) {
  const aliveWorkers = overview?.workers.filter((worker) => worker.alive) ?? [];
  return (
    <>
      <PageHeader
        eyebrow="Обзор рабочей области"
        title="Главная"
        description="Сводка по очереди, аккаунтам, рассылкам и последним событиям"
        action={
          <button
            type="button"
            className="button button--primary"
            onClick={onCreateDraft}
          >
            <Plus size={17} aria-hidden="true" />
            Создать рассылку
          </button>
        }
      />
      {loading && !overview ? <LoadingState /> : null}
      {error && !overview ? (
        <ErrorState message={error} onRetry={onRetry} />
      ) : null}
      {overview ? (
        <>
          <section className="metric-grid" aria-label="Сводные показатели">
            <MetricCard
              icon={<Send size={19} aria-hidden="true" />}
              label="Принято сервисом сегодня"
              value={overview.acceptedSince}
              hint={
                overview.sendingEnabled
                  ? "Приём письмом Mail, не доставка во «Входящие»"
                  : "Тестовый отправитель: письма не уходят в интернет"
              }
              tone="blue"
            />
            <MetricCard
              icon={<Inbox size={19} aria-hidden="true" />}
              label="Задач в ожидании"
              value={overview.queuedTasks}
              hint={
                overview.sendingTasks
                  ? `${overview.sendingTasks} отправляется сейчас`
                  : overview.unclearTasks
                    ? `${overview.unclearTasks} с неясным исходом`
                    : "Очередь хранится в базе"
              }
              tone="violet"
            />
            <MetricCard
              icon={<Mail size={19} aria-hidden="true" />}
              label="Доступных аккаунтов"
              value={overview.availableAccountCount}
              hint={
                overview.problemAccountCount
                  ? `${overview.problemAccountCount} требуют внимания из ${overview.accountCount}`
                  : `Всего ${overview.accountCount}`
              }
              tone="green"
            />
            <MetricCard
              icon={<Cpu size={19} aria-hidden="true" />}
              label="Процессов отправки"
              value={aliveWorkers.length}
              hint={
                aliveWorkers.length
                  ? "По свежим подтверждениям работы"
                  : "Нет подтверждений — отправка не идёт"
              }
              tone="amber"
            />
          </section>
          {overview.unclearTasks ? (
            <div className="info-strip info-strip--warning" role="status">
              <AlertTriangle size={16} aria-hidden="true" />
              <span>
                {overview.unclearTasks}{" "}
                {plural(overview.unclearTasks, "задача", "задачи", "задач")} с
                неясным исходом ждут решения оператора.
              </span>
              <button
                type="button"
                className="text-button"
                onClick={() => onNavigate("/campaigns")}
              >
                К рассылкам <ArrowRight size={14} aria-hidden="true" />
              </button>
            </div>
          ) : null}
          <section className="overview-grid">
            <article className="card list-card">
              <div className="card-heading">
                <div>
                  <span className="card-kicker">В работе</span>
                  <h2>Активные рассылки</h2>
                </div>
                <button
                  type="button"
                  className="icon-link"
                  onClick={() => onNavigate("/campaigns")}
                >
                  Все рассылки <ArrowRight size={14} aria-hidden="true" />
                </button>
              </div>
              {overview.activeCampaigns.length ? (
                <div className="compact-list">
                  {overview.activeCampaigns.slice(0, 5).map((campaign) => {
                    const progress = campaignProgress(campaign.counts);
                    return (
                      <button
                        type="button"
                        className="compact-list__item compact-list__item--progress"
                        key={campaign.id}
                        onClick={() => onOpenCampaign(campaign.id)}
                      >
                        <span className="compact-list__icon">
                          {campaign.status === "paused" ? (
                            <Pause size={16} aria-hidden="true" />
                          ) : (
                            <Play size={16} aria-hidden="true" />
                          )}
                        </span>
                        <span className="compact-list__body">
                          <strong>{campaign.name}</strong>
                          <span>
                            <CampaignStatusBadge campaign={campaign} /> ·
                            принято {campaign.counts.accepted} из{" "}
                            {campaign.counts.total}
                          </span>
                          <span className="mini-progress" aria-hidden="true">
                            <span style={{ width: `${progress.percent}%` }} />
                          </span>
                        </span>
                        <ArrowRight size={14} aria-hidden="true" />
                      </button>
                    );
                  })}
                </div>
              ) : (
                <EmptyState
                  icon={<Send size={22} aria-hidden="true" />}
                  title="Сейчас ничего не отправляется"
                  description="Запустите рассылку из мастера — прогресс появится здесь."
                  action={
                    <button
                      type="button"
                      className="button button--secondary button--small"
                      onClick={onCreateDraft}
                    >
                      <Plus size={15} aria-hidden="true" />
                      Создать рассылку
                    </button>
                  }
                />
              )}
            </article>
            <article className="card list-card">
              <div className="card-heading">
                <div>
                  <span className="card-kicker">Процессы</span>
                  <h2>Отправка</h2>
                </div>
              </div>
              <div className="sender-mode">
                <span
                  className={`status-badge status-badge--${overview.sendingEnabled ? "blocked" : "active"}`}
                >
                  <span className="status-dot" aria-hidden="true" />
                  {overview.sendingEnabled
                    ? "Реальная отправка Mail"
                    : "Тестовый отправитель"}
                </span>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => onNavigate("/settings")}
                >
                  Настройки <ArrowRight size={14} aria-hidden="true" />
                </button>
              </div>
              {overview.workers.length ? (
                <div className="worker-list">
                  {overview.workers.slice(0, 4).map((worker) => (
                    <div
                      className={`worker-row${worker.alive ? "" : " worker-row--stale"}`}
                      key={worker.id}
                    >
                      <span className="mini-dot" aria-hidden="true" />
                      <div>
                        <strong>
                          {worker.hostname} · pid {worker.pid}
                        </strong>
                        <span>
                          {worker.alive ? "работает" : "нет подтверждений"} ·
                          последнее: {formatDateTime(worker.lastHeartbeatAt)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="inline-empty">
                  <Cpu size={19} aria-hidden="true" />
                  <span>
                    Процесс отправки ещё не запускался. В Docker он стартует
                    вместе с приложением.
                  </span>
                </div>
              )}
            </article>
            <article className="card list-card">
              <div className="card-heading">
                <div>
                  <span className="card-kicker">Журнал</span>
                  <h2>Последние события</h2>
                </div>
                <button
                  type="button"
                  className="icon-link"
                  onClick={() => onNavigate("/events")}
                >
                  Все события <ArrowRight size={14} aria-hidden="true" />
                </button>
              </div>
              {overview.recentEvents.length ? (
                <div className="event-list event-list--compact">
                  {overview.recentEvents.slice(0, 6).map((event) => (
                    <div className="event-row" key={event.id}>
                      <span
                        className={`event-dot event-dot--${event.level}`}
                        aria-hidden="true"
                      />
                      <div>
                        <strong>{event.title}</strong>
                        <span>{event.detail}</span>
                      </div>
                      <time dateTime={event.createdAt}>
                        {formatShortDate(event.createdAt)}
                      </time>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState
                  icon={<Activity size={22} aria-hidden="true" />}
                  title="Событий пока нет"
                  description="Здесь появятся действия после создания группы или черновика."
                />
              )}
            </article>
          </section>
        </>
      ) : null}
    </>
  );
}

function AccountsPage({
  groups,
  groupsLoading,
  groupsError,
  accounts,
  loading,
  error,
  search,
  status,
  groupId,
  page,
  pageSize,
  selectedIds,
  selectionByFilter,
  selectedCount,
  onSearch,
  onStatus,
  onGroup,
  onPage,
  onPageSize,
  onToggle,
  onSelectPage,
  onSelectFilter,
  onClearSelection,
  onBulk,
  onCheckOne,
  onRetry,
  onCreateGroup,
  onImport,
}: {
  groups: Group[];
  groupsLoading: boolean;
  groupsError: string | null;
  accounts: Page<Account> | null;
  loading: boolean;
  error: string | null;
  search: string;
  status: string;
  groupId: string;
  page: number;
  pageSize: number;
  selectedIds: Set<string>;
  selectionByFilter: boolean;
  selectedCount: number;
  onSearch: (value: string) => void;
  onStatus: (value: string) => void;
  onGroup: (value: string) => void;
  onPage: (value: number) => void;
  onPageSize: (value: number) => void;
  onToggle: (id: string, checked: boolean) => void;
  onSelectPage: (ids: string[], checked: boolean) => void;
  onSelectFilter: () => void;
  onClearSelection: () => void;
  onBulk: (kind: BulkKind) => void;
  onCheckOne: (account: Account) => void;
  onRetry: () => void;
  onCreateGroup: () => void;
  onImport: () => void;
}) {
  const pageIds = accounts?.items.map((account) => account.id) ?? [];
  const allOnPage =
    pageIds.length > 0 &&
    (selectionByFilter || pageIds.every((id) => selectedIds.has(id)));
  const problemStatuses: AccountStatus[] = [
    "auth_error",
    "needs_check",
    "blocked",
    "temporary_error",
  ];
  const problemCount =
    accounts?.items.filter((account) =>
      problemStatuses.includes(account.status)
    ).length ?? 0;
  const exhaustedCount =
    accounts?.items.filter((account) => account.status === "quota_exhausted")
      .length ?? 0;
  return (
    <>
      <PageHeader
        eyebrow="Группы и отправители"
        title="Аккаунты"
        description="Импорт доступов, индивидуальные скользящие лимиты и состояние подключений"
        action={
          <div className="button-row">
            <button
              type="button"
              className="button button--secondary"
              onClick={onImport}
              disabled={!groups.length}
              title={groups.length ? undefined : "Сначала создайте группу"}
            >
              <UploadCloud size={17} aria-hidden="true" />
              Импорт аккаунтов
            </button>
            <button
              type="button"
              className="button button--primary"
              onClick={onCreateGroup}
            >
              <Plus size={17} aria-hidden="true" />
              Создать группу
            </button>
          </div>
        }
      />
      <section className="account-summary-grid">
        <div className="summary-chip">
          <span className="summary-chip__icon summary-chip__icon--blue">
            <Layers3 size={17} aria-hidden="true" />
          </span>
          <span>
            <strong>{groups.length}</strong>
            <small>Групп</small>
          </span>
        </div>
        <div className="summary-chip">
          <span className="summary-chip__icon summary-chip__icon--green">
            <Mail size={17} aria-hidden="true" />
          </span>
          <span>
            <strong>{accounts?.total ?? 0}</strong>
            <small>Найдено аккаунтов</small>
          </span>
        </div>
        <div className="summary-chip">
          <span className="summary-chip__icon summary-chip__icon--amber">
            <CircleHelp size={17} aria-hidden="true" />
          </span>
          <span>
            <strong>{accounts ? problemCount : 0}</strong>
            <small>Проблем на странице</small>
          </span>
        </div>
        <div className="summary-chip summary-chip--quiet">
          <span className="summary-chip__icon summary-chip__icon--slate">
            <Clock3 size={17} aria-hidden="true" />
          </span>
          <span>
            <strong>{accounts ? exhaustedCount : 0}</strong>
            <small>Лимит исчерпан на странице</small>
          </span>
        </div>
      </section>
      <section className="card groups-strip">
        <div className="section-heading">
          <div>
            <span className="card-kicker">Организация отправителей</span>
            <h2>Группы аккаунтов</h2>
          </div>
          <button type="button" className="text-button" onClick={onCreateGroup}>
            <Plus size={15} aria-hidden="true" /> Новая группа
          </button>
        </div>
        {groupsLoading && !groups.length ? (
          <LoadingState label="Загружаем группы…" />
        ) : null}
        {groupsError && !groups.length ? (
          <ErrorState message={groupsError} onRetry={onRetry} />
        ) : null}
        {!groupsLoading && !groupsError && !groups.length ? (
          <div className="inline-empty">
            <FolderOpen size={19} aria-hidden="true" />
            <span>
              Групп пока нет. Создайте первую, чтобы импортировать аккаунты.
            </span>
            <button
              type="button"
              className="button button--secondary button--small"
              onClick={onCreateGroup}
            >
              Создать группу
            </button>
          </div>
        ) : null}
        {groups.length ? (
          <div className="group-cards">
            {groups.slice(0, 8).map((group) => (
              <button
                type="button"
                className={`group-card${groupId === group.id ? " group-card--active" : ""}`}
                key={group.id}
                onClick={() => onGroup(groupId === group.id ? "" : group.id)}
              >
                <span
                  className={`group-card__mark ${groupColorClass(group.color)}`}
                >
                  <Users size={16} aria-hidden="true" />
                </span>
                <span className="group-card__body">
                  <strong>{group.name}</strong>
                  <span>
                    {group.accountCount}{" "}
                    {plural(
                      group.accountCount,
                      "аккаунт",
                      "аккаунта",
                      "аккаунтов"
                    )}
                  </span>
                </span>
                <span className="group-card__limit">
                  {group.limitCount} / {group.periodHours} ч
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </section>
      <section className="card table-card">
        <div className="table-card__header">
          <div>
            <span className="card-kicker">Состояние подключений и квот</span>
            <h2>Почтовые аккаунты</h2>
          </div>
          <span className="table-note">
            Квота — скользящее окно; время в вашем часовом поясе
          </span>
        </div>
        <div className="table-toolbar">
          <label className="search-field">
            <Search size={16} aria-hidden="true" />
            <span className="sr-only">Поиск по аккаунтам</span>
            <input
              type="search"
              value={search}
              onChange={(event) => onSearch(event.target.value)}
              placeholder="Поиск по email…"
            />
          </label>
          <label className="select-field">
            <ListFilter size={15} aria-hidden="true" />
            <span className="sr-only">Фильтр статуса</span>
            <select
              value={status}
              onChange={(event) => onStatus(event.target.value)}
            >
              <option value="all">Все статусы</option>
              <option value="problem">Требуют внимания</option>
              {(Object.keys(statusLabels) as AccountStatus[]).map((value) => (
                <option key={value} value={value}>
                  {statusLabels[value]}
                </option>
              ))}
            </select>
            <ChevronDown size={14} aria-hidden="true" />
          </label>
          <label className="select-field">
            <Users size={15} aria-hidden="true" />
            <span className="sr-only">Фильтр группы</span>
            <select
              value={groupId}
              onChange={(event) => onGroup(event.target.value)}
            >
              <option value="">Все группы</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
            <ChevronDown size={14} aria-hidden="true" />
          </label>
          <label className="select-field">
            <span className="sr-only">Размер страницы</span>
            <select
              value={pageSize}
              onChange={(event) => onPageSize(Number(event.target.value))}
            >
              {[20, 50, 100].map((size) => (
                <option key={size} value={size}>
                  по {size}
                </option>
              ))}
            </select>
            <ChevronDown size={14} aria-hidden="true" />
          </label>
        </div>
        {selectedCount > 0 ? (
          <div
            className="bulk-bar"
            role="region"
            aria-label="Массовые действия"
          >
            <strong>
              Выбрано {selectedCount}
              {selectionByFilter ? " — все по текущему фильтру" : ""}
            </strong>
            {!selectionByFilter &&
            accounts &&
            accounts.total > selectedCount ? (
              <button
                type="button"
                className="text-button"
                onClick={onSelectFilter}
              >
                Выбрать все по фильтру ({accounts.total})
              </button>
            ) : null}
            <span className="bulk-bar__spacer" />
            <button
              type="button"
              className="button button--ghost button--small"
              onClick={() => onBulk("set_limit")}
            >
              Изменить лимит
            </button>
            <button
              type="button"
              className="button button--ghost button--small"
              onClick={() => onBulk("move")}
            >
              Перенести
            </button>
            <button
              type="button"
              className="button button--ghost button--small"
              onClick={() => onBulk("check")}
            >
              Проверить
            </button>
            <button
              type="button"
              className="button button--ghost button--small"
              onClick={() => onBulk("enable")}
            >
              Включить
            </button>
            <button
              type="button"
              className="button button--ghost button--small button--danger-text"
              onClick={() => onBulk("disable")}
            >
              Отключить
            </button>
            <button
              type="button"
              className="icon-button icon-button--small"
              aria-label="Снять выбор"
              onClick={onClearSelection}
            >
              <X size={15} aria-hidden="true" />
            </button>
          </div>
        ) : null}
        {loading && !accounts ? <LoadingState /> : null}
        {error && !accounts ? (
          <ErrorState message={error} onRetry={onRetry} />
        ) : null}
        {accounts && accounts.items.length ? (
          <>
            <div className="table-scroll">
              <table className="accounts-table">
                <thead>
                  <tr>
                    <th className="checkbox-cell">
                      <input
                        type="checkbox"
                        aria-label="Выбрать все на странице"
                        checked={allOnPage}
                        onChange={(event) =>
                          onSelectPage(pageIds, event.target.checked)
                        }
                      />
                    </th>
                    <th>Email</th>
                    <th>Группа</th>
                    <th>Статус</th>
                    <th>Использовано</th>
                    <th>Лимит</th>
                    <th>Остаток</th>
                    <th>Не раньше</th>
                    <th className="table-actions-cell">
                      <span className="sr-only">Действия</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.items.map((account) => {
                    const ratio = account.limitCount
                      ? Math.min(account.quotaUsed / account.limitCount, 1)
                      : 0;
                    return (
                      <tr
                        key={account.id}
                        className={
                          selectedIds.has(account.id) || selectionByFilter
                            ? "row--selected"
                            : undefined
                        }
                      >
                        <td className="checkbox-cell">
                          <input
                            type="checkbox"
                            aria-label={`Выбрать ${account.email}`}
                            checked={
                              selectionByFilter || selectedIds.has(account.id)
                            }
                            onChange={(event) =>
                              onToggle(account.id, event.target.checked)
                            }
                          />
                        </td>
                        <td>
                          <div className="email-cell">
                            <span
                              className="avatar-placeholder"
                              aria-hidden="true"
                            >
                              {account.email.slice(0, 1).toUpperCase()}
                            </span>
                            <span>
                              <strong>{account.email}</strong>
                              {account.demo ? (
                                <small className="muted-value">
                                  {" "}
                                  · демо, без пароля
                                </small>
                              ) : null}
                            </span>
                          </div>
                        </td>
                        <td>
                          <GroupBadge
                            group={{
                              name: account.groupName,
                              color: account.groupColor,
                            }}
                          />
                        </td>
                        <td>
                          <StatusBadge status={account.status} />
                          {account.connectionError &&
                          account.status !== "active" ? (
                            <div
                              className="cell-note"
                              title={account.connectionError}
                            >
                              {account.connectionError}
                            </div>
                          ) : null}
                          {account.disabledReason &&
                          account.status === "disabled" ? (
                            <div className="cell-note">
                              {account.disabledReason}
                            </div>
                          ) : null}
                        </td>
                        <td>
                          <div className="quota-cell">
                            <span>
                              {account.quotaUsed} / {account.limitCount}
                            </span>
                            <span className="quota-bar" aria-hidden="true">
                              <span
                                className={`quota-bar__fill${ratio >= 1 ? " quota-bar__fill--full" : ""}`}
                                style={{ width: `${ratio * 100}%` }}
                              />
                            </span>
                          </div>
                        </td>
                        <td className="muted-value">
                          {account.limitCount} писем / {account.periodHours} ч
                        </td>
                        <td>
                          <strong>{account.quotaRemaining}</strong>
                        </td>
                        <td className="muted-value">
                          {account.nextFreeAt
                            ? formatDateTime(account.nextFreeAt)
                            : "—"}
                        </td>
                        <td className="table-actions-cell">
                          <button
                            type="button"
                            className="button button--ghost button--small"
                            onClick={() => onCheckOne(account)}
                            disabled={account.status === "disabled"}
                            title="Проверить подключение без письма"
                          >
                            <RefreshCw size={14} aria-hidden="true" />
                            Проверить
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination
              page={page}
              pageSize={accounts.pageSize}
              total={accounts.total}
              onPage={onPage}
            />
          </>
        ) : null}
        {accounts && !accounts.items.length ? (
          <EmptyState
            icon={<Mail size={22} aria-hidden="true" />}
            title={
              search || status !== "all" || groupId
                ? "Ничего не найдено"
                : "Аккаунтов пока нет"
            }
            description={
              search || status !== "all" || groupId
                ? "Измените фильтры и попробуйте снова."
                : "Импортируйте почтовые аккаунты Mail вставкой строк, TXT или CSV."
            }
            action={
              !search && status === "all" && !groupId && groups.length ? (
                <button
                  type="button"
                  className="button button--secondary button--small"
                  onClick={onImport}
                >
                  Импортировать аккаунты
                </button>
              ) : undefined
            }
          />
        ) : null}
      </section>
    </>
  );
}

function CampaignsPage({
  campaigns,
  groups,
  loading,
  error,
  search,
  status,
  page,
  onSearch,
  onStatus,
  onPage,
  onRetry,
  onCreate,
  onOpen,
}: {
  campaigns: Page<CampaignSummary> | null;
  groups: Group[];
  loading: boolean;
  error: string | null;
  search: string;
  status: string;
  page: number;
  onSearch: (value: string) => void;
  onStatus: (value: string) => void;
  onPage: (value: number) => void;
  onRetry: () => void;
  onCreate: () => void;
  onOpen: (campaign: CampaignSummary) => void;
}) {
  return (
    <>
      <PageHeader
        eyebrow="Подготовка и отправка"
        title="Рассылки"
        description="Мастер собирает письмо за четыре шага; карточка рассылки показывает прогресс и действия."
        action={
          <button
            type="button"
            className="button button--primary"
            onClick={onCreate}
            disabled={!groups.length}
          >
            <Plus size={17} aria-hidden="true" />
            Новая рассылка
          </button>
        }
      />
      <section className="card table-card campaign-card">
        <div className="table-card__header">
          <div>
            <span className="card-kicker">Черновики, работа и итоги</span>
            <h2>Все рассылки</h2>
          </div>
          <span className="table-note">{campaigns?.total ?? 0} по фильтру</span>
        </div>
        <div className="table-toolbar">
          <label className="search-field search-field--wide">
            <Search size={16} aria-hidden="true" />
            <span className="sr-only">Поиск по рассылкам</span>
            <input
              type="search"
              value={search}
              onChange={(event) => onSearch(event.target.value)}
              placeholder="Поиск по названию или теме…"
            />
          </label>
          <label className="select-field">
            <ListFilter size={15} aria-hidden="true" />
            <span className="sr-only">Фильтр состояния</span>
            <select
              value={status}
              onChange={(event) => onStatus(event.target.value)}
            >
              <option value="all">Все состояния</option>
              <option value="active">В работе (выполняется и пауза)</option>
              {(
                Object.keys(campaignStatusLabels) as Array<
                  keyof typeof campaignStatusLabels
                >
              ).map((value) => (
                <option key={value} value={value}>
                  {campaignStatusLabels[value]}
                </option>
              ))}
            </select>
            <ChevronDown size={14} aria-hidden="true" />
          </label>
        </div>
        {loading && !campaigns ? <LoadingState /> : null}
        {error && !campaigns ? (
          <ErrorState message={error} onRetry={onRetry} />
        ) : null}
        {campaigns && campaigns.items.length ? (
          <>
            <div className="campaign-list">
              {campaigns.items.map((campaign) => {
                const progress = campaignProgress(campaign.counts);
                return (
                  <button
                    type="button"
                    className="campaign-row"
                    key={campaign.id}
                    onClick={() => onOpen(campaign)}
                  >
                    <span
                      className={`campaign-row__icon ${groupColorClass(campaign.groupColor)}`}
                    >
                      {campaign.status === "draft" ? (
                        <FileText size={18} aria-hidden="true" />
                      ) : (
                        <Send size={18} aria-hidden="true" />
                      )}
                    </span>
                    <span className="campaign-row__main">
                      <strong>
                        {campaign.name}
                        {campaign.isTest ? (
                          <span className="test-mark">тестовая отправка</span>
                        ) : null}
                      </strong>
                      <span>
                        {campaign.subject || "Без темы"} ·{" "}
                        {campaign.status === "draft"
                          ? `${campaign.counts.total} ${plural(campaign.counts.total, "получатель", "получателя", "получателей")}`
                          : `принято ${campaign.counts.accepted} из ${campaign.counts.total}${campaign.counts.unclear ? `, неясных ${campaign.counts.unclear}` : ""}${campaign.counts.failed ? `, ошибок ${campaign.counts.failed}` : ""}`}
                      </span>
                      {campaign.status !== "draft" ? (
                        <span className="mini-progress" aria-hidden="true">
                          <span style={{ width: `${progress.percent}%` }} />
                        </span>
                      ) : null}
                    </span>
                    <span className="campaign-row__group">
                      <GroupBadge
                        group={{
                          name: campaign.groupName,
                          color: campaign.groupColor,
                        }}
                      />
                    </span>
                    <CampaignStatusBadge campaign={campaign} />
                    <span className="campaign-row__date">
                      {formatShortDate(campaign.updatedAt)}
                    </span>
                    <ChevronRight size={17} aria-hidden="true" />
                  </button>
                );
              })}
            </div>
            <Pagination
              page={page}
              pageSize={campaigns.pageSize}
              total={campaigns.total}
              onPage={onPage}
            />
          </>
        ) : null}
        {campaigns && !campaigns.items.length ? (
          <EmptyState
            icon={<FilePenLine size={23} aria-hidden="true" />}
            title={
              search || status !== "all"
                ? "Рассылки не найдены"
                : "Начните с первой рассылки"
            }
            description={
              search || status !== "all"
                ? "Проверьте фильтры."
                : groups.length
                  ? "Название, группа, получатели, тема и текст — затем тестовое письмо и запуск."
                  : "Сначала создайте группу аккаунтов в разделе «Аккаунты»."
            }
            action={
              <button
                type="button"
                className="button button--secondary button--small"
                onClick={onCreate}
                disabled={!groups.length}
              >
                <Plus size={15} aria-hidden="true" />
                Создать рассылку
              </button>
            }
          />
        ) : null}
      </section>
    </>
  );
}

function EventsPage({
  events,
  loading,
  error,
  kind,
  level,
  search,
  page,
  onKind,
  onLevel,
  onSearch,
  onPage,
  onRetry,
  onOpenCampaign,
  onOpenGroup,
  onOpenAccount,
}: {
  events: Page<Event> | null;
  loading: boolean;
  error: string | null;
  kind: string;
  level: string;
  search: string;
  page: number;
  onKind: (value: string) => void;
  onLevel: (value: string) => void;
  onSearch: (value: string) => void;
  onPage: (value: number) => void;
  onRetry: () => void;
  onOpenCampaign: (id: string) => void;
  onOpenGroup: (id: string) => void;
  onOpenAccount: (email: string) => void;
}) {
  const emailIn = (text: string) =>
    text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i)?.[0] ?? null;
  return (
    <>
      <PageHeader
        eyebrow="Журнал"
        title="События"
        description="Действия оператора, ошибки отправки и решения по задачам с переходом к рассылке, аккаунту и попытке"
      />
      <section className="card table-card events-card">
        <div className="table-card__header">
          <div>
            <span className="card-kicker">Хронология</span>
            <h2>Журнал событий</h2>
          </div>
          <span className="table-note">{events?.total ?? 0} по фильтру</span>
        </div>
        <div className="table-toolbar">
          <label className="search-field">
            <Search size={16} aria-hidden="true" />
            <span className="sr-only">Поиск по событиям</span>
            <input
              type="search"
              value={search}
              onChange={(event) => onSearch(event.target.value)}
              placeholder="Поиск по тексту или адресу…"
            />
          </label>
          <label className="select-field">
            <ListFilter size={15} aria-hidden="true" />
            <span className="sr-only">Уровень</span>
            <select
              value={level}
              onChange={(event) => onLevel(event.target.value)}
            >
              <option value="all">Все уровни</option>
              <option value="info">Сведения</option>
              <option value="warning">Предупреждения</option>
              <option value="error">Ошибки</option>
            </select>
            <ChevronDown size={14} aria-hidden="true" />
          </label>
          <label className="select-field">
            <span className="sr-only">Вид события</span>
            <select
              value={kind}
              onChange={(event) => onKind(event.target.value)}
            >
              <option value="all">Все виды</option>
              {Object.entries(eventLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <ChevronDown size={14} aria-hidden="true" />
          </label>
        </div>
        {loading && !events ? <LoadingState /> : null}
        {error && !events ? (
          <ErrorState message={error} onRetry={onRetry} />
        ) : null}
        {events && events.items.length ? (
          <>
            <div className="event-list event-list--full">
              {events.items.map((event) => {
                const email = event.accountId ? emailIn(event.detail) : null;
                return (
                  <div
                    className={`event-detail-row event-detail-row--${event.level}`}
                    key={event.id}
                  >
                    <span
                      className={`event-detail-icon event-detail-icon--${event.level}`}
                    >
                      {event.level === "error" ? (
                        <AlertCircle size={16} aria-hidden="true" />
                      ) : event.level === "warning" ? (
                        <AlertTriangle size={16} aria-hidden="true" />
                      ) : (
                        eventIcon(event.kind)
                      )}
                    </span>
                    <div className="event-detail-row__main">
                      <strong>{event.title}</strong>
                      <span>{event.detail}</span>
                      <div className="event-links">
                        <span className="event-kind">
                          {eventLabels[event.kind] ?? event.kind}
                        </span>
                        {event.campaignId ? (
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => onOpenCampaign(event.campaignId!)}
                          >
                            Рассылка <ArrowRight size={13} aria-hidden="true" />
                          </button>
                        ) : null}
                        {email ? (
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => onOpenAccount(email)}
                          >
                            Аккаунт <ArrowRight size={13} aria-hidden="true" />
                          </button>
                        ) : null}
                        {event.entityType === "group" && event.entityId ? (
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => onOpenGroup(event.entityId!)}
                          >
                            Группа <ArrowRight size={13} aria-hidden="true" />
                          </button>
                        ) : null}
                        {event.attemptId ? (
                          <span className="muted-value">
                            попытка №{event.attemptId}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <time dateTime={event.createdAt}>
                      {formatDateTime(event.createdAt)}
                    </time>
                  </div>
                );
              })}
            </div>
            <Pagination
              page={page}
              pageSize={events.pageSize}
              total={events.total}
              onPage={onPage}
            />
          </>
        ) : null}
        {events && !events.items.length ? (
          <EmptyState
            icon={<Activity size={22} aria-hidden="true" />}
            title="Событий пока нет"
            description="Здесь появятся действия оператора, ошибки и решения по задачам."
          />
        ) : null}
      </section>
    </>
  );
}

function Pagination({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;
  return (
    <div className="pagination">
      <span>
        Показано {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)}{" "}
        из {total}
      </span>
      <div className="pagination__buttons">
        <button
          type="button"
          className="icon-button icon-button--small"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          aria-label="Предыдущая страница"
        >
          <ChevronLeft size={17} aria-hidden="true" />
        </button>
        <span>
          Страница {page} из {pages}
        </span>
        <button
          type="button"
          className="icon-button icon-button--small"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
          aria-label="Следующая страница"
        >
          <ChevronRight size={17} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function GroupModal({
  open,
  form,
  dirty,
  closePrompt,
  saving,
  submitError,
  fieldErrors,
  onChange,
  onSubmit,
  onRequestClose,
  onCancelClose,
  onConfirmClose,
}: {
  open: boolean;
  form: GroupForm;
  dirty: boolean;
  closePrompt: boolean;
  saving: boolean;
  submitError: SubmitError | null;
  fieldErrors: Record<string, string>;
  onChange: (patch: Partial<GroupForm>) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onRequestClose: () => void;
  onCancelClose: () => void;
  onConfirmClose: () => void;
}) {
  return (
    <Modal
      open={open}
      title="Новая группа аккаунтов"
      description="Значения лимита применятся к новым аккаунтам группы в M2."
      closeDisabled={saving}
      onRequestClose={onRequestClose}
    >
      <form onSubmit={onSubmit} noValidate>
        <fieldset className="form-fieldset" disabled={saving}>
          {submitError ? <SubmitErrorBanner error={submitError} /> : null}
          <div className="form-grid">
            <Field label="Название группы" required error={fieldErrors.name}>
              <input
                data-autofocus
                type="text"
                value={form.name}
                onChange={(event) => onChange({ name: event.target.value })}
                placeholder="Например, Основная почта"
                aria-invalid={Boolean(fieldErrors.name)}
              />
            </Field>
            <Field
              label="Цвет группы"
              hint="Помогает быстро отличать группы"
              error={fieldErrors.color}
            >
              <div className="color-options">
                {groupColors.map((color) => (
                  <button
                    type="button"
                    key={color.value}
                    className={`color-option ${groupColorClass(color.value)}${form.color === color.value ? " color-option--selected" : ""}`}
                    onClick={() => onChange({ color: color.value })}
                    aria-pressed={form.color === color.value}
                  >
                    <span className="group-dot" aria-hidden="true" />
                    {color.label}
                  </button>
                ))}
              </div>
            </Field>
            <Field
              label="Лимит писем"
              required
              hint="Положительное целое число"
              error={fieldErrors.limitCount}
            >
              <div className="input-suffix">
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={form.limitCount}
                  onChange={(event) =>
                    onChange({ limitCount: event.target.value })
                  }
                  aria-invalid={Boolean(fieldErrors.limitCount)}
                />
                <span>писем</span>
              </div>
            </Field>
            <Field
              label="Период лимита"
              required
              hint="Скользящее окно, не календарный день"
              error={fieldErrors.periodHours}
            >
              <div className="input-suffix">
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={form.periodHours}
                  onChange={(event) =>
                    onChange({ periodHours: event.target.value })
                  }
                  aria-invalid={Boolean(fieldErrors.periodHours)}
                />
                <span>часов</span>
              </div>
            </Field>
          </div>
          <div className="form-callout">
            <Info size={16} aria-hidden="true" />
            <span>
              Группа — это набор отправителей. У каждого аккаунта будет своя
              история лимита; общий счётчик здесь не создаётся.
            </span>
          </div>
          {closePrompt ? (
            <UnsavedPrompt
              onCancel={onCancelClose}
              onConfirm={onConfirmClose}
            />
          ) : null}
          <div className="modal-actions">
            <button
              type="button"
              className="button button--ghost"
              onClick={onRequestClose}
            >
              Отмена
            </button>
            <button type="submit" className="button button--primary">
              {saving ? (
                <>
                  <span className="button-spinner" aria-hidden="true" />
                  Сохраняем…
                </>
              ) : (
                <>
                  <Check size={16} aria-hidden="true" />
                  Создать группу
                </>
              )}
            </button>
          </div>
          {dirty && submitError?.network ? (
            <p className="retry-note">
              <RefreshCw size={14} aria-hidden="true" />
              Повтор отправит тот же запрос; изменение полей создаст новый ключ
              запроса.
            </p>
          ) : null}
        </fieldset>
      </form>
    </Modal>
  );
}

function DraftWizard({
  open,
  mode,
  form,
  step,
  groups,
  closePrompt,
  loading,
  loadError,
  saving,
  submitError,
  fieldErrors,
  onChange,
  onStep,
  onNext,
  onSave,
  campaign,
  starting,
  startError,
  onRecipientsSaved,
  onStart,
  onTestSend,
  onRequestClose,
  onCancelClose,
  onConfirmClose,
  onRetryLoad,
}: {
  open: boolean;
  mode: "create" | "edit";
  form: DraftForm;
  step: number;
  groups: Group[];
  closePrompt: boolean;
  loading: boolean;
  loadError: string | null;
  saving: boolean;
  submitError: SubmitError | null;
  fieldErrors: Record<string, string>;
  onChange: (patch: Partial<DraftForm>) => void;
  onStep: (step: number) => void;
  onNext: () => void;
  onSave: () => void;
  campaign: Campaign | null;
  starting: boolean;
  startError: string | null;
  onRecipientsSaved: (campaign: Campaign) => void;
  onStart: () => void;
  onTestSend: (recipient: string) => void;
  onRequestClose: () => void;
  onCancelClose: () => void;
  onConfirmClose: () => void;
  onRetryLoad: () => void;
}) {
  const stepNames = ["Параметры", "Получатели", "Текст", "Проверка"];
  const [testRecipient, setTestRecipient] = useState("");
  const recipientCount = campaign?.counts.total ?? 0;
  const readyProblems: string[] = [];
  if (recipientCount === 0) readyProblems.push("нет получателей");
  if (!form.subject.trim()) readyProblems.push("пустая тема");
  if (!form.body.trim()) readyProblems.push("пустой текст");
  const busy = saving || starting;
  return (
    <Modal
      open={open}
      title={mode === "create" ? "Новая рассылка" : "Черновик рассылки"}
      description="Черновик можно сохранять незавершённым. Тема, текст и получатели фиксируются только при запуске."
      wide
      closeDisabled={busy}
      onRequestClose={onRequestClose}
    >
      <div className="wizard-steps" aria-label="Шаги создания рассылки">
        {stepNames.map((name, index) => {
          const number = index + 1;
          return (
            <button
              type="button"
              className={`wizard-step${step === number ? " wizard-step--active" : ""}${step > number ? " wizard-step--done" : ""}`}
              key={name}
              onClick={() => number <= step && onStep(number)}
              disabled={busy || number > step}
            >
              <span>
                {step > number ? (
                  <Check size={13} aria-hidden="true" />
                ) : (
                  number
                )}
              </span>
              {name}
            </button>
          );
        })}
      </div>
      {submitError ? <SubmitErrorBanner error={submitError} /> : null}
      {loading ? <LoadingState label="Загружаем черновик…" /> : null}
      {loadError ? (
        <ErrorState message={loadError} onRetry={onRetryLoad} />
      ) : null}
      {!loading && !loadError ? (
        <fieldset className="form-fieldset" disabled={busy}>
          <>
            {step === 1 ? (
              <div className="wizard-panel">
                <div className="wizard-intro">
                  <span className="wizard-panel__number">01</span>
                  <div>
                    <h3>Основные параметры</h3>
                    <p>
                      Назовите рассылку и выберите группу, от имени которой она
                      будет подготовлена.
                    </p>
                  </div>
                </div>
                <div className="form-grid form-grid--two">
                  <Field
                    label="Название рассылки"
                    required
                    error={fieldErrors.name}
                  >
                    <input
                      data-autofocus
                      type="text"
                      value={form.name}
                      onChange={(event) =>
                        onChange({ name: event.target.value })
                      }
                      placeholder="Например, Весеннее обновление"
                      aria-invalid={Boolean(fieldErrors.name)}
                    />
                  </Field>
                  <Field
                    label="Группа отправителей"
                    required
                    error={fieldErrors.groupId}
                  >
                    <div className="select-wrap">
                      <select
                        value={form.groupId}
                        onChange={(event) =>
                          onChange({ groupId: event.target.value })
                        }
                        aria-invalid={Boolean(fieldErrors.groupId)}
                      >
                        <option value="">Выберите группу…</option>
                        {groups.map((group) => (
                          <option key={group.id} value={group.id}>
                            {group.name}
                          </option>
                        ))}
                      </select>
                      <ChevronDown size={15} aria-hidden="true" />
                    </div>
                    {!groups.length ? (
                      <span className="field-hint field-hint--warning">
                        Сначала создайте группу в разделе «Аккаунты».
                      </span>
                    ) : null}
                  </Field>
                  <Field
                    label="Имя отправителя"
                    hint="Не меняет реальный email аккаунта"
                  >
                    <input
                      type="text"
                      value={form.senderName}
                      onChange={(event) =>
                        onChange({ senderName: event.target.value })
                      }
                      placeholder="Например, Команда MailControl"
                    />
                  </Field>
                </div>
                <div className="form-callout">
                  <Info size={16} aria-hidden="true" />
                  <span>
                    Лимиты аккаунтов и выбор конкретного отправителя появятся
                    вместе с импортом доступов в M2.
                  </span>
                </div>
              </div>
            ) : null}
            {step === 2 ? (
              campaign ? (
                <RecipientsEditor
                  campaign={campaign}
                  disabled={busy}
                  onSaved={onRecipientsSaved}
                />
              ) : (
                <div className="wizard-panel wizard-panel--centered">
                  <span className="wizard-illustration">
                    <Users size={27} aria-hidden="true" />
                  </span>
                  <h3>Сначала сохраните параметры</h3>
                  <p>
                    Список получателей привязывается к сохранённому черновику.
                  </p>
                </div>
              )
            ) : null}
            {step === 3 ? (
              <div className="wizard-panel">
                <div className="wizard-intro">
                  <span className="wizard-panel__number">03</span>
                  <div>
                    <h3>Текст письма</h3>
                    <p>
                      Обычный текст без HTML-конструктора. Для запуска нужны и
                      тема, и текст.
                    </p>
                  </div>
                </div>
                <div className="form-grid">
                  <Field label="Тема письма">
                    <input
                      data-autofocus
                      type="text"
                      value={form.subject}
                      onChange={(event) =>
                        onChange({ subject: event.target.value })
                      }
                      placeholder="Тема письма"
                    />
                  </Field>
                  <Field label="Обычный текст">
                    <textarea
                      className="body-textarea"
                      value={form.body}
                      onChange={(event) =>
                        onChange({ body: event.target.value })
                      }
                      placeholder="Текст письма…"
                    />
                  </Field>
                </div>
                <div className="form-callout">
                  <FileText size={16} aria-hidden="true" />
                  <span>
                    После запуска тема и текст зафиксированы; другое содержание
                    — это новая рассылка.
                  </span>
                </div>
              </div>
            ) : null}
            {step === 4 ? (
              <div className="wizard-panel review-panel">
                <div className="wizard-intro">
                  <span className="wizard-panel__number">04</span>
                  <div>
                    <h3>Проверка перед запуском</h3>
                    <p>
                      Сохранение не отправляет письма. Запуск фиксирует тему,
                      текст и список и передаёт задачи процессу отправки.
                    </p>
                  </div>
                </div>
                <div className="review-list">
                  <ReviewRow
                    label="Название"
                    value={form.name || "Не указано"}
                    missing={!form.name.trim()}
                  />
                  <ReviewRow
                    label="Группа"
                    value={
                      groups.find((group) => group.id === form.groupId)?.name ??
                      "Не выбрана"
                    }
                    missing={!form.groupId}
                  />
                  <ReviewRow
                    label="Имя отправителя"
                    value={
                      form.senderName || "Не задано (только адрес аккаунта)"
                    }
                  />
                  <ReviewRow
                    label="Тема"
                    value={form.subject || "Пока без темы"}
                    missing={!form.subject.trim()}
                  />
                  <ReviewRow
                    label="Текст"
                    value={
                      form.body
                        ? `${form.body.length} симв.`
                        : "Пока без текста"
                    }
                    missing={!form.body.trim()}
                  />
                  <ReviewRow
                    label="Получатели"
                    value={
                      recipientCount
                        ? `${recipientCount} ${plural(recipientCount, "адрес", "адреса", "адресов")}`
                        : "Список пуст"
                    }
                    missing={recipientCount === 0}
                  />
                </div>
                <div className="test-send">
                  <div>
                    <strong>Тестовая отправка</strong>
                    <span>
                      Одно письмо на явно указанный адрес через ту же очередь и
                      квоту. Учитывается в истории и лимите аккаунта.
                    </span>
                  </div>
                  <div className="test-send__row">
                    <input
                      type="email"
                      value={testRecipient}
                      onChange={(event) => setTestRecipient(event.target.value)}
                      placeholder="test@example.com"
                      aria-label="Адрес для тестового письма"
                    />
                    <button
                      type="button"
                      className="button button--secondary"
                      disabled={
                        busy ||
                        !testRecipient.includes("@") ||
                        !form.subject.trim() ||
                        !form.body.trim()
                      }
                      onClick={() => onTestSend(testRecipient.trim())}
                    >
                      <Send size={15} aria-hidden="true" />
                      Отправить тест
                    </button>
                  </div>
                </div>
                {readyProblems.length ? (
                  <div className="launch-disabled">
                    <ShieldCheck size={17} aria-hidden="true" />
                    <div>
                      <strong>Запуск пока недоступен</strong>
                      <span>Причины: {readyProblems.join(", ")}.</span>
                    </div>
                  </div>
                ) : null}
                {startError ? (
                  <div className="submit-error" role="alert">
                    <AlertTriangle size={16} aria-hidden="true" />
                    <span>{startError}</span>
                  </div>
                ) : null}
              </div>
            ) : null}
            {closePrompt ? (
              <UnsavedPrompt
                onCancel={onCancelClose}
                onConfirm={onConfirmClose}
              />
            ) : null}
            <div className="wizard-actions">
              <button
                type="button"
                className="button button--ghost"
                onClick={step === 1 ? onRequestClose : () => onStep(step - 1)}
              >
                {step === 1 ? (
                  "Отмена"
                ) : (
                  <>
                    <ArrowLeft size={16} aria-hidden="true" />
                    Назад
                  </>
                )}
              </button>
              {step < 4 ? (
                <button
                  type="button"
                  className="button button--primary"
                  onClick={onNext}
                >
                  Далее <ArrowRight size={16} aria-hidden="true" />
                </button>
              ) : (
                <div className="wizard-actions__right">
                  <button
                    type="button"
                    className="button button--secondary"
                    onClick={onSave}
                    disabled={busy}
                  >
                    {saving ? (
                      <>
                        <span className="button-spinner" aria-hidden="true" />
                        Сохраняем…
                      </>
                    ) : (
                      <>
                        <Check size={16} aria-hidden="true" />
                        Сохранить черновик
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    className="button button--primary"
                    onClick={onStart}
                    disabled={busy || readyProblems.length > 0}
                  >
                    <Send size={16} aria-hidden="true" />
                    Запустить
                  </button>
                </div>
              )}
            </div>
          </>
        </fieldset>
      ) : null}
    </Modal>
  );
}

function Field({
  label,
  required = false,
  hint,
  error,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="form-field">
      <span className="form-field__label">
        {label}
        {required ? <em aria-hidden="true">*</em> : null}
      </span>
      {children}
      {error ? (
        <span className="field-error" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="field-hint">{hint}</span>
      ) : null}
    </label>
  );
}

function SubmitErrorBanner({ error }: { error: SubmitError }) {
  const conflict = error.code.toUpperCase().includes("CONFLICT");
  return (
    <div
      className={`submit-error${error.network ? " submit-error--network" : ""}`}
      role="alert"
    >
      <AlertCircle size={17} aria-hidden="true" />
      <div>
        <strong>
          {error.network
            ? "Сервер недоступен"
            : conflict
              ? "Изменения устарели"
              : "Не удалось сохранить"}
        </strong>
        <span>{error.message}</span>
      </div>
    </div>
  );
}

function UnsavedPrompt({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="unsaved-prompt" role="alert">
      <div>
        <AlertCircle size={17} aria-hidden="true" />
        <span>
          <strong>Есть несохранённые изменения.</strong> Закрыть форму и
          потерять их?
        </span>
      </div>
      <div className="unsaved-prompt__actions">
        <button
          type="button"
          className="text-button text-button--muted"
          onClick={onCancel}
        >
          Остаться
        </button>
        <button
          type="button"
          className="text-button text-button--danger"
          onClick={onConfirm}
        >
          Закрыть без сохранения
        </button>
      </div>
    </div>
  );
}

function ReviewRow({
  label,
  value,
  missing = false,
  state = "ok",
}: {
  label: string;
  value: string;
  missing?: boolean;
  state?: "ok" | "unavailable";
}) {
  return (
    <div
      className={`review-row${missing ? " review-row--missing" : ""}${state === "unavailable" ? " review-row--unavailable" : ""}`}
    >
      <span>{label}</span>
      <strong>{value}</strong>
      {missing ? (
        <AlertCircle size={15} aria-label="Поле обязательно" />
      ) : state === "unavailable" ? (
        <Clock3 size={15} aria-label="Недоступно в M1" />
      ) : (
        <CheckCircle2 size={15} aria-hidden="true" />
      )}
    </div>
  );
}

export default App;
