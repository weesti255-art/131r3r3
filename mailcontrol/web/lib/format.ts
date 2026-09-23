import type {
  AccountStatus,
  CampaignStatus,
  RejectCategory,
  TaskStatus,
} from "../../shared/contracts";

export const accountStatusLabels: Record<AccountStatus, string> = {
  active: "Активен",
  quota_exhausted: "Лимит исчерпан",
  temporary_error: "Временная ошибка",
  auth_error: "Ошибка авторизации",
  needs_check: "Требует проверки",
  blocked: "Заблокирован",
  disabled: "Отключён",
  unverified: "Не проверен",
};

export const campaignStatusLabels: Record<CampaignStatus, string> = {
  draft: "Черновик",
  running: "Выполняется",
  paused: "Пауза",
  stopped: "Остановлена",
  completed: "Завершена",
  completed_with_errors: "Завершена с ошибками",
};

export const taskStatusLabels: Record<TaskStatus, string> = {
  pending: "В очереди",
  reserved: "Зарезервировано",
  sending: "Отправляется",
  accepted: "Принято сервисом",
  failed: "Ошибка",
  unclear: "Неясный исход",
  cancelled: "Отменено",
  excluded: "Исключено",
  closed_unconfirmed: "Закрыто без подтверждения",
};

export const rejectCategoryLabels: Record<RejectCategory, string> = {
  auth: "ошибка авторизации",
  needs_check: "требует проверки владельцем",
  account_blocked: "ящик заблокирован",
  recipient: "адрес получателя",
  content_or_policy: "содержание или запрет рассылки",
  temporary: "временная ошибка",
  connection: "ошибка соединения",
};

export const eventKindLabels: Record<string, string> = {
  group_created: "Создана группа",
  draft_created: "Создан черновик",
  draft_updated: "Обновлён черновик",
  demo_seeded: "Демо-данные",
  accounts_imported: "Импорт аккаунтов",
  account_moved: "Перенос аккаунта",
  accounts_moved: "Перенос аккаунтов",
  accounts_limit_changed: "Изменение лимита",
  accounts_disabled: "Отключение аккаунтов",
  accounts_enabled: "Включение аккаунтов",
  account_checked: "Проверка подключения",
  account_excluded: "Аккаунт исключён",
  recipients_loaded: "Получатели загружены",
  campaign_started: "Запуск рассылки",
  campaign_paused: "Пауза",
  campaign_resumed: "Продолжение",
  campaign_stopped: "Остановка",
  campaign_completed: "Завершение",
  campaign_auto_paused: "Пауза сервисом",
  task_failed: "Ошибка задачи",
  task_unclear: "Неясный исход",
  task_resolved: "Решение оператора",
  task_excluded: "Получатель исключён",
  attempt_failed: "Временная ошибка",
  late_response: "Поздний ответ",
  worker_started: "Процесс отправки",
  worker_recovered_tasks: "Восстановление очереди",
  settings_updated: "Настройки",
  sender_mode_changed: "Режим отправки",
  test_send: "Тестовая отправка",
};

const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function timeZoneLabel(): string {
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZoneName: "short",
  }).formatToParts(new Date());
  return parts.find((part) => part.type === "timeZoneName")?.value ?? timeZone;
}

/** Operator's local time with an explicit zone label; the database keeps UTC. */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const text = new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
  return `${text} (${timeZoneLabel()})`;
}

export function formatShortDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function startOfTodayIso(): string {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now.toISOString();
}

export function plural(count: number, one: string, few: string, many: string) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod100 >= 11 && mod100 <= 19) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

export function campaignProgress(counts: {
  total: number;
  accepted: number;
  failed: number;
  cancelled: number;
  excluded: number;
  closedUnconfirmed: number;
  unclear: number;
}) {
  const done =
    counts.accepted +
    counts.failed +
    counts.cancelled +
    counts.excluded +
    counts.closedUnconfirmed;
  const percent = counts.total ? Math.round((done / counts.total) * 100) : 0;
  return { done, percent };
}

/** Builds a client-side CSV without any passwords. */
export function downloadCsv(filename: string, rows: string[][]) {
  const escape = (value: string) =>
    /[";\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  const content =
    "\uFEFF" +
    rows.map((row) => row.map(escape).join(";")).join("\r\n") +
    "\r\n";
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Не удалось прочитать файл."));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsText(file, "utf-8");
  });
}
