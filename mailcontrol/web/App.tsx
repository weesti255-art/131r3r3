import {
  Activity,
  AlertCircle,
  Archive,
  ArrowLeft,
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
  CampaignSummary,
  Event,
  Group,
  GroupColor,
  Health,
  Overview,
  Page,
} from "../shared/contracts";
import Modal from "./components/Modal";
import {
  api,
  createRequestKey,
  displayError,
  isRequestAborted,
} from "./lib/api";

type PageName = "overview" | "accounts" | "campaigns" | "events";
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
];

const groupColors: Array<{ value: GroupColor; label: string }> = [
  { value: "blue", label: "Синий" },
  { value: "violet", label: "Фиолетовый" },
  { value: "teal", label: "Бирюзовый" },
  { value: "amber", label: "Янтарный" },
];

const statusLabels: Record<Account["status"], string> = {
  active: "Активен",
  auth_error: "Ошибка входа",
  needs_check: "Требует проверки",
  disabled: "Отключён",
  unverified: "Не проверен",
};

const eventLabels: Record<Event["kind"], string> = {
  group_created: "Создана группа",
  draft_created: "Создан черновик",
  draft_updated: "Обновлён черновик",
  demo_seeded: "Демо-данные подготовлены",
};

function routeFromPath(): PageName {
  const path = window.location.pathname.replace(/\/$/, "") || "/";
  if (path === "/accounts") return "accounts";
  if (path === "/campaigns") return "campaigns";
  if (path === "/events") return "events";
  return "overview";
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

function eventIcon(kind: Event["kind"]): ReactNode {
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
          Письма не отправляются · данные отделены от локальной работы
        </span>
      </div>
      <span className="demo-banner__tag">M1</span>
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
  const [campaignSearch, setCampaignSearch] = useState("");
  const [campaignPage, setCampaignPage] = useState(1);
  const [eventKind, setEventKind] = useState("all");
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
    const onPopState = () => setRoute(routeFromPath());
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
      const nextOverview = await api.overview({ signal: request.signal });
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
          pageSize: 10,
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
  }, [accountGroupId, accountPage, accountSearch, accountStatus, beginRequest]);

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
  }, [beginRequest, campaignPage, campaignSearch]);

  const loadEvents = useCallback(async () => {
    const request = beginRequest("events");
    setEventsLoading(true);
    setEventsError(null);
    try {
      const nextEvents = await api.events(
        { page: eventPage, pageSize: 15, kind: eventKind },
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
  }, [beginRequest, eventKind, eventPage]);

  useEffect(() => {
    if (route === "overview") void loadOverview();
  }, [loadOverview, refreshToken, route]);

  useEffect(() => {
    if (route === "overview" || route === "accounts" || route === "campaigns") {
      void loadGroups();
    }
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
      try {
        const campaign = await api.campaign(id, { signal: request.signal });
        if (!request.isCurrent()) return;
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
    [beginRequest]
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

  const nextDraftStep = useCallback(() => {
    if (draftSavingRef.current || draftSaving) return;
    if (draftStep === 1 && Object.keys(validateDraftRequired()).length > 0)
      return;
    setDraftStep((step) => Math.min(4, step + 1));
  }, [draftSaving, draftStep, validateDraftRequired]);

  const saveDraft = useCallback(async () => {
    if (draftSavingRef.current || draftSaving) return;
    if (Object.keys(validateDraftRequired()).length > 0) {
      setDraftStep(1);
      return;
    }
    draftSavingRef.current = true;
    setDraftSaving(true);
    setDraftSubmitError(null);
    try {
      const input = {
        name: draftForm.name.trim(),
        groupId: draftForm.groupId,
        senderName: draftForm.senderName.trim(),
        subject: draftForm.subject,
        body: draftForm.body,
      };
      if (draftMode === "create") {
        const campaign = await api.createDraft({
          ...input,
          requestKey: draftRequestKey,
        });
        setDraftId(campaign.id);
        setDraftRevision(campaign.revision);
      } else if (draftId) {
        const campaign = await api.updateDraft(draftId, {
          ...input,
          revision: draftRevision,
        });
        setDraftRevision(campaign.revision);
      }
      setDraftDirty(false);
      setDraftModalOpen(false);
      setRefreshToken((value) => value + 1);
      showToast("Черновик сохранён");
    } catch (error) {
      const nextError = displayError(error);
      setDraftSubmitError(nextError);
      if (nextError.fields) setDraftFieldErrors(nextError.fields);
      if (nextError.network) setDraftRetrySignature(formSignature(draftForm));
    } finally {
      draftSavingRef.current = false;
      setDraftSaving(false);
    }
  }, [
    draftForm,
    draftId,
    draftMode,
    draftRequestKey,
    draftRevision,
    draftSaving,
    showToast,
    validateDraftRequired,
  ]);

  const retryDraftDetail = useCallback(() => {
    if (draftId) void openDraft(draftId);
  }, [draftId, openDraft]);

  const headerTitle =
    route === "overview"
      ? "Главная"
      : route === "accounts"
        ? "Аккаунты"
        : route === "campaigns"
          ? "Рассылки"
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
              <a className="archive-link" href="/download/mailcontrol-m1.zip">
                <Archive size={15} aria-hidden="true" />
                Скачать M1 .zip
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
              onOpenDraft={openDraft}
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
              page={campaignPage}
              onSearch={(value) => {
                setCampaignPage(1);
                setCampaignSearch(value);
              }}
              onPage={setCampaignPage}
              onRetry={loadCampaigns}
              onCreate={resetDraft}
              onOpen={openDraft}
            />
          ) : null}
          {route === "events" ? (
            <EventsPage
              events={eventsPage}
              loading={eventsLoading}
              error={eventsError}
              kind={eventKind}
              page={eventPage}
              onKind={(value) => {
                setEventPage(1);
                setEventKind(value);
              }}
              onPage={setEventPage}
              onRetry={loadEvents}
              onOpenCampaign={openDraft}
              onOpenGroup={openGroup}
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

      <ImportModal
        open={importModalOpen}
        onClose={() => setImportModalOpen(false)}
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
        onNext={nextDraftStep}
        onSave={saveDraft}
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
            <strong>Первый этап M1</strong>
            <span>Сохранение и обзор</span>
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
  onOpenDraft,
}: {
  overview: Overview | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onCreateDraft: () => void;
  onNavigate: (path: string) => void;
  onOpenDraft: (id: string) => void;
}) {
  return (
    <>
      <PageHeader
        eyebrow="Обзор рабочей области"
        title="Главная"
        description="Сводка по аккаунтам, черновикам и последним действиям"
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
              label="Принято сегодня"
              value={overview.acceptedToday}
              hint="Отправка отключена в M1"
              tone="blue"
            />
            <MetricCard
              icon={<Inbox size={19} aria-hidden="true" />}
              label="Задач в очереди"
              value={overview.queuedTasks}
              hint="Очередь появится в M3"
              tone="violet"
            />
            <MetricCard
              icon={<Mail size={19} aria-hidden="true" />}
              label="Почтовых аккаунтов"
              value={overview.accountCount}
              hint={
                overview.problemAccountCount
                  ? `${overview.problemAccountCount} требуют внимания`
                  : "Состояние из базы"
              }
              tone="green"
            />
            <MetricCard
              icon={<FilePenLine size={19} aria-hidden="true" />}
              label="Черновиков"
              value={overview.draftCount}
              hint="Можно редактировать и сохранять"
              tone="amber"
            />
          </section>
          <section className="overview-grid">
            <article className="card stage-card">
              <div className="card-heading">
                <div>
                  <span className="card-kicker">Текущее состояние</span>
                  <h2>M1 · Сохранение и обзор</h2>
                </div>
                <span className="stage-mark">
                  <Check size={16} aria-hidden="true" />
                </span>
              </div>
              <p className="stage-card__lead">
                Группы и черновики сохраняются через API. Реальной отправки
                писем пока нет — это честно отражено в счётчиках и действиях.
              </p>
              <div className="stage-checklist">
                <div>
                  <CheckCircle2 size={17} aria-hidden="true" />
                  Демо-режим отделён от локальных данных
                </div>
                <div>
                  <CheckCircle2 size={17} aria-hidden="true" />
                  Отправитель появится на следующих этапах
                </div>
                <div>
                  <CircleHelp size={17} aria-hidden="true" />
                  Лимиты без расчёта до M2
                </div>
              </div>
              <div className="stage-card__footer">
                <span className="subtle-label">
                  <Database size={15} aria-hidden="true" />
                  {overview.groupCount} групп сохранено
                </span>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => onNavigate("/accounts")}
                >
                  Открыть группы <ArrowRight size={14} aria-hidden="true" />
                </button>
              </div>
            </article>
            <article className="card list-card">
              <div className="card-heading">
                <div>
                  <span className="card-kicker">Работа с контентом</span>
                  <h2>Последние черновики</h2>
                </div>
                <button
                  type="button"
                  className="icon-link"
                  onClick={() => onNavigate("/campaigns")}
                >
                  Все черновики <ArrowRight size={14} aria-hidden="true" />
                </button>
              </div>
              {overview.recentCampaigns.length ? (
                <div className="compact-list">
                  {overview.recentCampaigns.slice(0, 4).map((campaign) => (
                    <button
                      type="button"
                      className="compact-list__item"
                      key={campaign.id}
                      onClick={() => onOpenDraft(campaign.id)}
                    >
                      <span className="compact-list__icon">
                        <FileText size={16} aria-hidden="true" />
                      </span>
                      <span className="compact-list__body">
                        <strong>{campaign.name}</strong>
                        <span>
                          {campaign.groupName} ·{" "}
                          {formatShortDate(campaign.updatedAt)}
                        </span>
                      </span>
                      <Pencil size={14} aria-hidden="true" />
                    </button>
                  ))}
                </div>
              ) : (
                <EmptyState
                  icon={<FilePenLine size={22} aria-hidden="true" />}
                  title="Пока нет черновиков"
                  description="Создайте первую рассылку, чтобы сохранить тему и текст."
                  action={
                    <button
                      type="button"
                      className="button button--secondary button--small"
                      onClick={onCreateDraft}
                    >
                      <Plus size={15} aria-hidden="true" />
                      Создать черновик
                    </button>
                  }
                />
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
                  {overview.recentEvents.slice(0, 5).map((event) => (
                    <div className="event-row" key={event.id}>
                      <span
                        className={`event-dot event-dot--${event.kind}`}
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
  onSearch,
  onStatus,
  onGroup,
  onPage,
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
  onSearch: (value: string) => void;
  onStatus: (value: string) => void;
  onGroup: (value: string) => void;
  onPage: (value: number) => void;
  onRetry: () => void;
  onCreateGroup: () => void;
  onImport: () => void;
}) {
  const problemCount =
    accounts?.items.filter((account) =>
      ["auth_error", "needs_check"].includes(account.status)
    ).length ?? 0;
  return (
    <>
      <PageHeader
        eyebrow="Группы и отправители"
        title="Аккаунты"
        description="Группы уже можно создавать. Импорт почтовых доступов и лимиты откроются в M2."
        action={
          <div className="button-row">
            <button
              type="button"
              className="button button--secondary"
              onClick={onImport}
            >
              <UploadCloud size={17} aria-hidden="true" />
              Импорт · M2
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
            <small>Групп на странице</small>
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
            <Info size={17} aria-hidden="true" />
          </span>
          <span>
            <strong>Без квоты</strong>
            <small>Расчёт доступен с M2</small>
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
              Групп пока нет. Создайте первую, чтобы сохранить черновик
              рассылки.
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
            {groups.slice(0, 6).map((group) => (
              <button
                type="button"
                className="group-card"
                key={group.id}
                onClick={() => onGroup(group.id)}
              >
                <span
                  className={`group-card__mark ${groupColorClass(group.color)}`}
                >
                  <Users size={16} aria-hidden="true" />
                </span>
                <span className="group-card__body">
                  <strong>{group.name}</strong>
                  <span>{group.accountCount} аккаунтов</span>
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
            <span className="card-kicker">Состояние подключений</span>
            <h2>Почтовые аккаунты</h2>
          </div>
          <span className="table-note">
            M1 показывает только сохранённые данные
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
              <option value="active">Активные</option>
              <option value="problem">Требуют внимания</option>
              <option value="auth_error">Ошибка входа</option>
              <option value="needs_check">Требуют проверки</option>
              <option value="disabled">Отключённые</option>
              <option value="unverified">Не проверены</option>
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
        </div>
        {loading && !accounts ? <LoadingState /> : null}
        {error && !accounts ? (
          <ErrorState message={error} onRetry={onRetry} />
        ) : null}
        {accounts && accounts.items.length ? (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Группа</th>
                    <th>Статус</th>
                    <th>Лимит аккаунта</th>
                    <th>Режим</th>
                    <th className="table-actions-cell">
                      <span className="sr-only">Действия</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.items.map((account) => (
                    <tr key={account.id}>
                      <td>
                        <div className="email-cell">
                          <span className="avatar-placeholder">
                            <Mail size={14} aria-hidden="true" />
                          </span>
                          <strong>{account.email}</strong>
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
                      </td>
                      <td>
                        <span className="muted-value">
                          {account.limitCount} писем / {account.periodHours} ч
                        </span>
                      </td>
                      <td>
                        <span className="mode-label">
                          <span className="mode-dot" aria-hidden="true" />
                          {account.demo ? "Демо" : "Локальный"}
                        </span>
                      </td>
                      <td className="table-actions-cell">
                        <button
                          type="button"
                          className="icon-button icon-button--small"
                          aria-label={`Действия для ${account.email}`}
                          disabled
                        >
                          <MoreHorizontal size={17} aria-hidden="true" />
                        </button>
                      </td>
                    </tr>
                  ))}
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
                : "Добавление почтовых доступов появится в M2. Сейчас можно подготовить группу."
            }
            action={
              !search && status === "all" && !groupId ? (
                <button
                  type="button"
                  className="button button--secondary button--small"
                  onClick={onImport}
                >
                  Открыть макет импорта
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
  page,
  onSearch,
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
  page: number;
  onSearch: (value: string) => void;
  onPage: (value: number) => void;
  onRetry: () => void;
  onCreate: () => void;
  onOpen: (id: string) => void;
}) {
  return (
    <>
      <PageHeader
        eyebrow="Контент и черновики"
        title="Рассылки"
        description="Четыре шага помогают собрать письмо. Запуск и получатели будут доступны в M3."
        action={
          <button
            type="button"
            className="button button--primary"
            onClick={onCreate}
          >
            <Plus size={17} aria-hidden="true" />
            Новый черновик
          </button>
        }
      />
      <section className="card table-card campaign-card">
        <div className="table-card__header">
          <div>
            <span className="card-kicker">История подготовки</span>
            <h2>Черновики рассылок</h2>
          </div>
          <span className="table-note">{campaigns?.total ?? 0} сохранено</span>
        </div>
        <div className="table-toolbar">
          <label className="search-field search-field--wide">
            <Search size={16} aria-hidden="true" />
            <span className="sr-only">Поиск по черновикам</span>
            <input
              type="search"
              value={search}
              onChange={(event) => onSearch(event.target.value)}
              placeholder="Поиск по названию или теме…"
            />
          </label>
          <span className="toolbar-hint">
            <Info size={15} aria-hidden="true" />В M1 доступно только сохранение
          </span>
        </div>
        {loading && !campaigns ? <LoadingState /> : null}
        {error && !campaigns ? (
          <ErrorState message={error} onRetry={onRetry} />
        ) : null}
        {campaigns && campaigns.items.length ? (
          <>
            <div className="campaign-list">
              {campaigns.items.map((campaign) => (
                <button
                  type="button"
                  className="campaign-row"
                  key={campaign.id}
                  onClick={() => onOpen(campaign.id)}
                >
                  <span
                    className={`campaign-row__icon ${groupColorClass(campaign.groupColor)}`}
                  >
                    <FileText size={18} aria-hidden="true" />
                  </span>
                  <span className="campaign-row__main">
                    <strong>{campaign.name}</strong>
                    <span>
                      {campaign.subject || "Без темы"} ·{" "}
                      {campaign.bodyPreview || "Текст пока не добавлен"}
                    </span>
                  </span>
                  <span className="campaign-row__group">
                    <GroupBadge
                      group={{
                        name: campaign.groupName,
                        color: campaign.groupColor,
                      }}
                    />
                  </span>
                  <span className="draft-status">
                    <span className="status-dot" aria-hidden="true" />
                    Черновик
                  </span>
                  <span className="campaign-row__date">
                    {formatShortDate(campaign.updatedAt)}
                  </span>
                  <ChevronRight size={17} aria-hidden="true" />
                </button>
              ))}
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
              search ? "Черновики не найдены" : "Начните с первого черновика"
            }
            description={
              search
                ? "Проверьте поисковый запрос."
                : groups.length
                  ? "Сохраните название, группу, тему и обычный текст — без фиктивного запуска."
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
                Создать черновик
              </button>
            }
          />
        ) : null}
      </section>
      <div className="info-strip">
        <span className="info-strip__icon">
          <ShieldCheck size={17} aria-hidden="true" />
        </span>
        <div>
          <strong>Письма не отправляются</strong>
          <span>
            Кнопка запуска намеренно отключена до M3. Данные черновика можно
            менять и сохранять повторно.
          </span>
        </div>
      </div>
    </>
  );
}

function EventsPage({
  events,
  loading,
  error,
  kind,
  page,
  onKind,
  onPage,
  onRetry,
  onOpenCampaign,
  onOpenGroup,
}: {
  events: Page<Event> | null;
  loading: boolean;
  error: string | null;
  kind: string;
  page: number;
  onKind: (value: string) => void;
  onPage: (value: number) => void;
  onRetry: () => void;
  onOpenCampaign: (id: string) => void;
  onOpenGroup: (id: string) => void;
}) {
  return (
    <>
      <PageHeader
        eyebrow="Прозрачная история действий"
        title="События"
        description="Изменения групп и черновиков с локальным временем оператора."
        action={
          <span className="page-header__quiet">
            <Clock3 size={16} aria-hidden="true" />
            Часовой пояс: {timeZone}
          </span>
        }
      />
      <section className="card events-card">
        <div className="table-card__header">
          <div>
            <span className="card-kicker">Журнал действий</span>
            <h2>Последние события</h2>
          </div>
          <label className="select-field">
            <ListFilter size={15} aria-hidden="true" />
            <span className="sr-only">Фильтр событий</span>
            <select
              value={kind}
              onChange={(event) => onKind(event.target.value)}
            >
              <option value="all">Все события</option>
              <option value="group_created">Создание группы</option>
              <option value="draft_created">Новые черновики</option>
              <option value="draft_updated">Изменение черновиков</option>
              <option value="demo_seeded">Подготовка демо</option>
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
              {events.items.map((event) => (
                <div className="event-detail-row" key={event.id}>
                  <span
                    className={`event-detail-icon event-detail-icon--${event.kind}`}
                  >
                    {eventIcon(event.kind)}
                  </span>
                  <div className="event-detail-row__main">
                    <strong>{event.title}</strong>
                    <span>{event.detail}</span>
                    <span className="event-kind">
                      {eventLabels[event.kind]}
                    </span>
                  </div>
                  <time dateTime={event.createdAt}>
                    {formatDate(event.createdAt)} <small>{timeZone}</small>
                  </time>
                  {event.entityId && event.entityType === "campaign" ? (
                    <button
                      type="button"
                      className="text-button text-button--muted"
                      onClick={() => onOpenCampaign(event.entityId!)}
                    >
                      Открыть черновик{" "}
                      <ArrowRight size={14} aria-hidden="true" />
                    </button>
                  ) : null}
                  {event.entityId && event.entityType === "group" ? (
                    <button
                      type="button"
                      className="text-button text-button--muted"
                      onClick={() => onOpenGroup(event.entityId!)}
                    >
                      Открыть группу <ArrowRight size={14} aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
              ))}
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
            icon={<Activity size={23} aria-hidden="true" />}
            title="Событий пока нет"
            description="После первого действия здесь появится понятная запись с датой и ссылкой."
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

function ImportModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"text" | "csv">("text");
  return (
    <Modal
      open={open}
      title="Импорт почтовых аккаунтов"
      description="Макет подготовлен заранее; безопасное сохранение доступов появится на этапе M2."
      onRequestClose={onClose}
    >
      <div className="import-tabs" role="tablist" aria-label="Формат импорта">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "text"}
          className={
            tab === "text" ? "import-tab import-tab--active" : "import-tab"
          }
          onClick={() => setTab("text")}
        >
          Вставка строк
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "csv"}
          className={
            tab === "csv" ? "import-tab import-tab--active" : "import-tab"
          }
          onClick={() => setTab("csv")}
        >
          CSV-файл
        </button>
      </div>
      <div className="import-preview">
        <div className="import-preview__heading">
          <div>
            <strong>{tab === "text" ? "Строки аккаунтов" : "Файл CSV"}</strong>
            <span>
              {tab === "text"
                ? "Формат: email | app_password"
                : "UTF-8, заголовок email,app_password"}
            </span>
          </div>
          <span className="locked-label">
            <ShieldCheck size={14} aria-hidden="true" />
            M2
          </span>
        </div>
        {tab === "text" ? (
          <textarea
            disabled
            placeholder="Ввод паролей отключён до M2. Реальные доступы не принимаются на этом этапе."
            aria-label="Строки аккаунтов, недоступно в M1"
          />
        ) : (
          <div className="file-dropzone">
            <UploadCloud size={25} aria-hidden="true" />
            <strong>Выбор файла будет доступен в M2</strong>
            <span>Загрузка и разбор CSV пока заблокированы</span>
          </div>
        )}
        <div className="import-safe-note">
          <LockKeyholeIcon />
          <span>
            Пароли не сохраняются в браузере и не могут попасть в этот макет.
            Сначала будет включено защищённое хранение в БД.
          </span>
        </div>
      </div>
      <div className="modal-actions">
        <button
          type="button"
          className="button button--ghost"
          onClick={onClose}
        >
          Закрыть
        </button>
        <button type="button" className="button button--primary" disabled>
          <UploadCloud size={16} aria-hidden="true" />
          Импортировать · M2
        </button>
      </div>
    </Modal>
  );
}

function LockKeyholeIcon() {
  return <ShieldCheck size={16} aria-hidden="true" />;
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
  onRequestClose: () => void;
  onCancelClose: () => void;
  onConfirmClose: () => void;
  onRetryLoad: () => void;
}) {
  const stepNames = ["Параметры", "Получатели", "Текст", "Проверка"];
  return (
    <Modal
      open={open}
      title={
        mode === "create"
          ? "Новый черновик рассылки"
          : "Редактирование черновика"
      }
      description="Содержимое фиксируется только при запуске на следующих этапах. Сейчас можно сохранять незавершённый черновик."
      wide
      closeDisabled={saving}
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
              disabled={saving || number > step}
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
        <fieldset className="form-fieldset" disabled={saving}>
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
              <div className="wizard-panel wizard-panel--centered">
                <span className="wizard-illustration">
                  <Users size={27} aria-hidden="true" />
                </span>
                <h3>Получатели появятся в M3</h3>
                <p>
                  Импорт TXT/CSV и проверка адресов ещё не включены. На этом
                  шаге можно продолжить без получателей и сохранить черновик.
                </p>
                <span className="feature-placeholder">
                  <Clock3 size={15} aria-hidden="true" />
                  Этот шаг — честная заглушка, без фиктивной очереди
                </span>
              </div>
            ) : null}
            {step === 3 ? (
              <div className="wizard-panel">
                <div className="wizard-intro">
                  <span className="wizard-panel__number">03</span>
                  <div>
                    <h3>Текст письма</h3>
                    <p>
                      Обычный текст без HTML-конструктора. Тему и тело можно
                      оставить незавершёнными.
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
                    Дальнейшее изменение содержания будет отдельной версией
                    рассылки после запуска. Сейчас это только черновик.
                  </span>
                </div>
              </div>
            ) : null}
            {step === 4 ? (
              <div className="wizard-panel review-panel">
                <div className="wizard-intro">
                  <span className="wizard-panel__number">04</span>
                  <div>
                    <h3>Проверка перед сохранением</h3>
                    <p>
                      Проверьте поля. Сохранение не отправляет письма и не
                      создаёт задачи.
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
                    value={form.senderName || "Не задано"}
                  />
                  <ReviewRow
                    label="Тема"
                    value={form.subject || "Пока без темы"}
                  />
                  <ReviewRow
                    label="Текст"
                    value={
                      form.body
                        ? `${form.body.length} симв.`
                        : "Пока без текста"
                    }
                  />
                  <ReviewRow
                    label="Получатели"
                    value="Будут доступны в M3"
                    state="unavailable"
                  />
                </div>
                <div className="launch-disabled">
                  <ShieldCheck size={17} aria-hidden="true" />
                  <div>
                    <strong>Запуск отключён</strong>
                    <span>
                      В M1 нет отправителя, очереди и тестовой отправки. Эта
                      кнопка не обещает несуществующий успех.
                    </span>
                  </div>
                </div>
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
                    disabled
                  >
                    <Send size={16} aria-hidden="true" />
                    Запустить · M3
                  </button>
                  <button
                    type="button"
                    className="button button--primary"
                    onClick={onSave}
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
