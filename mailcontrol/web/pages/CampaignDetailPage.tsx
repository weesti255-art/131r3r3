import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ChevronDown,
  Download,
  Pause,
  Pencil,
  Play,
  Search,
  Square,
} from "lucide-react";
import type {
  Attempt,
  Campaign,
  Task,
  TaskStatus,
} from "../../shared/contracts";
import ConfirmDialog from "../components/ConfirmDialog";
import Modal from "../components/Modal";
import {
  api,
  createRequestKey,
  displayError,
  isRequestAborted,
  reportUrl,
} from "../lib/api";
import {
  campaignProgress,
  campaignStatusLabels,
  formatDateTime,
  rejectCategoryLabels,
  taskStatusLabels,
} from "../lib/format";

type Action = "pause" | "resume" | "stop" | "start";
type Decision = "accepted" | "failed" | "closed";

const countKeys: Array<[keyof Campaign["counts"], TaskStatus]> = [
  ["pending", "pending"],
  ["reserved", "reserved"],
  ["sending", "sending"],
  ["accepted", "accepted"],
  ["failed", "failed"],
  ["unclear", "unclear"],
  ["cancelled", "cancelled"],
  ["excluded", "excluded"],
  ["closedUnconfirmed", "closed_unconfirmed"],
];

const actionTexts: Record<
  Action,
  { title: string; description: string; confirm: string; toast: string }
> = {
  pause: {
    title: "Поставить рассылку на паузу?",
    description:
      "Новые отправки не будут начинаться. Уже начатые могут завершиться. Пауза сохраняется после перезапуска.",
    confirm: "Поставить на паузу",
    toast: "Рассылка на паузе",
  },
  resume: {
    title: "Продолжить рассылку?",
    description:
      "Очередь продолжит работу с текущим составом группы и актуальными лимитами.",
    confirm: "Продолжить",
    toast: "Рассылка продолжена",
  },
  stop: {
    title: "Остановить рассылку окончательно?",
    description:
      "Все ещё не начатые задачи будут отменены. Отменить это нельзя; начатые отправки завершатся, неясные исходы останутся ждать решения.",
    confirm: "Остановить",
    toast: "Рассылка остановлена",
  },
  start: {
    title: "Запустить рассылку?",
    description:
      "Тема, текст и список получателей будут зафиксированы. Изменить их потом можно только новой рассылкой.",
    confirm: "Запустить",
    toast: "Рассылка запущена",
  },
};

export function CampaignStatusBadge({
  campaign,
}: {
  campaign: Pick<Campaign, "status" | "waitReason">;
}) {
  const waiting = campaign.status === "running" && campaign.waitReason;
  return (
    <span
      className={`status-badge status-badge--campaign-${waiting ? "waiting" : campaign.status}`}
    >
      <span className="status-dot" aria-hidden="true" />
      {waiting ? "Ожидание" : campaignStatusLabels[campaign.status]}
    </span>
  );
}

function ErrorLine({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="submit-error" role="alert">
      <AlertTriangle size={16} aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

export default function CampaignDetailPage({
  id,
  onBack,
  onEditDraft,
  onToast,
}: {
  id: string;
  onBack: () => void;
  onEditDraft: (id: string) => void;
  onToast: (message: string) => void;
}) {
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<{
    items: Task[];
    total: number;
    page: number;
    pageSize: number;
  } | null>(null);
  const [tasksError, setTasksError] = useState<string | null>(null);
  const [taskStatus, setTaskStatus] = useState("all");
  const [taskSearch, setTaskSearch] = useState("");
  const [taskPage, setTaskPage] = useState(1);
  const [action, setAction] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [excluding, setExcluding] = useState<Task | null>(null);
  const [resolving, setResolving] = useState<Task | null>(null);
  const [decision, setDecision] = useState<Decision>("accepted");
  const [attemptsFor, setAttemptsFor] = useState<Task | null>(null);
  const [attempts, setAttempts] = useState<Attempt[] | null>(null);
  const controllers = useRef<{
    campaign?: AbortController;
    tasks?: AbortController;
  }>({});

  const load = useCallback(async () => {
    controllers.current.campaign?.abort();
    const controller = new AbortController();
    controllers.current.campaign = controller;
    try {
      const next = await api.campaign(id, { signal: controller.signal });
      if (!controller.signal.aborted) {
        setCampaign(next);
        setError(null);
      }
    } catch (loadError) {
      if (!isRequestAborted(loadError))
        setError(displayError(loadError).message);
    }
  }, [id]);

  const loadTasks = useCallback(async () => {
    controllers.current.tasks?.abort();
    const controller = new AbortController();
    controllers.current.tasks = controller;
    try {
      const next = await api.tasks(
        id,
        {
          page: taskPage,
          pageSize: 20,
          status: taskStatus,
          q: taskSearch.trim() || undefined,
        },
        { signal: controller.signal }
      );
      if (!controller.signal.aborted) {
        setTasks(next);
        setTasksError(null);
      }
    } catch (loadError) {
      if (!isRequestAborted(loadError))
        setTasksError(displayError(loadError).message);
    }
  }, [id, taskPage, taskStatus, taskSearch]);

  useEffect(() => {
    void load();
    void loadTasks();
  }, [load, loadTasks]);

  // Live progress while the campaign can still change.
  const live = campaign
    ? ["running", "paused"].includes(campaign.status)
    : false;
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => {
      void load();
      void loadTasks();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [live, load, loadTasks]);

  useEffect(() => {
    const current = controllers.current;
    return () =>
      Object.values(current).forEach((controller) => controller?.abort());
  }, []);

  const refresh = () => {
    void load();
    void loadTasks();
  };

  const perform = async (work: () => Promise<void>, toast: string) => {
    setBusy(true);
    setActionError(null);
    try {
      await work();
      onToast(toast);
      refresh();
      return true;
    } catch (runError) {
      setActionError(displayError(runError).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const runAction = async () => {
    if (!action || !campaign) return;
    const ok = await perform(async () => {
      setCampaign(
        await api.campaignAction(campaign.id, action, createRequestKey())
      );
    }, actionTexts[action].toast);
    if (ok) setAction(null);
  };

  const runExclude = async () => {
    if (!excluding || !campaign) return;
    const ok = await perform(async () => {
      await api.excludeTask(campaign.id, excluding.id, createRequestKey());
    }, "Получатель исключён из очереди");
    if (ok) setExcluding(null);
  };

  const runResolve = async () => {
    if (!resolving || !campaign) return;
    const ok = await perform(async () => {
      await api.resolveTask(
        campaign.id,
        resolving.id,
        decision,
        createRequestKey()
      );
    }, "Решение по задаче сохранено");
    if (ok) setResolving(null);
  };

  const openAttempts = async (task: Task) => {
    setAttemptsFor(task);
    setAttempts(null);
    try {
      setAttempts(await api.attempts(id, task.id));
    } catch (loadError) {
      setActionError(displayError(loadError).message);
    }
  };

  if (error && !campaign)
    return (
      <div className="state-card">
        <AlertTriangle size={22} aria-hidden="true" />
        <p>{error}</p>
        <button
          type="button"
          className="button button--secondary button--small"
          onClick={() => void load()}
        >
          Повторить
        </button>
      </div>
    );
  if (!campaign)
    return (
      <div className="loading-state">
        <span className="spinner" aria-hidden="true" />
        Загружаем рассылку…
      </div>
    );

  const progress = campaignProgress(campaign.counts);
  const { status, counts } = campaign;
  const share = (value: number) =>
    counts.total ? `${(value / counts.total) * 100}%` : "0%";

  return (
    <>
      <div className="page-header page-header--detail">
        <div>
          <button type="button" className="text-button" onClick={onBack}>
            <ArrowLeft size={14} aria-hidden="true" /> К списку рассылок
          </button>
          <h1>
            {campaign.name}
            {campaign.isTest ? (
              <span className="test-mark">тестовая отправка</span>
            ) : null}
          </h1>
          <p className="page-header__description">
            <CampaignStatusBadge campaign={campaign} /> · группа «
            {campaign.groupName}» · тема: {campaign.subject || "—"}
            {campaign.senderName ? ` · от имени «${campaign.senderName}»` : ""}
          </p>
        </div>
        <div className="button-row">
          {status === "draft" ? (
            <>
              <button
                type="button"
                className="button button--secondary"
                onClick={() => onEditDraft(campaign.id)}
              >
                <Pencil size={16} aria-hidden="true" /> Открыть в мастере
              </button>
              <button
                type="button"
                className="button button--primary"
                onClick={() => setAction("start")}
              >
                <Play size={16} aria-hidden="true" /> Запустить
              </button>
            </>
          ) : null}
          {status === "running" ? (
            <button
              type="button"
              className="button button--secondary"
              onClick={() => setAction("pause")}
            >
              <Pause size={16} aria-hidden="true" /> Пауза
            </button>
          ) : null}
          {status === "paused" ? (
            <button
              type="button"
              className="button button--primary"
              onClick={() => setAction("resume")}
            >
              <Play size={16} aria-hidden="true" /> Продолжить
            </button>
          ) : null}
          {status === "running" || status === "paused" ? (
            <button
              type="button"
              className="button button--danger"
              onClick={() => setAction("stop")}
            >
              <Square size={16} aria-hidden="true" /> Остановить
            </button>
          ) : null}
          {status !== "draft" ? (
            <a className="button button--ghost" href={reportUrl(campaign.id)}>
              <Download size={16} aria-hidden="true" /> CSV
            </a>
          ) : null}
        </div>
      </div>

      {campaign.pauseReason ? (
        <div className="info-strip info-strip--warning" role="status">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{campaign.pauseReason}</span>
        </div>
      ) : null}
      {status === "running" && campaign.waitReason ? (
        <div className="info-strip" role="status">
          <span className="info-strip__icon" aria-hidden="true" />
          <span>
            Ожидание: {campaign.waitReason}
            {campaign.waitUntil
              ? ` — не раньше ${formatDateTime(campaign.waitUntil)}`
              : ""}
            . Работа продолжится автоматически.
          </span>
        </div>
      ) : null}
      {counts.unclear ? (
        <div className="info-strip info-strip--warning" role="status">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>
            {counts.unclear} задач с неясным исходом ждут решения оператора.
            Автоматического повтора нет; резерв квоты удерживается.
          </span>
        </div>
      ) : null}

      <section className="card progress-card">
        <div className="progress-card__top">
          <div>
            <span className="card-kicker">Прогресс</span>
            <h2>
              {progress.done} из {counts.total} задач получили итог · принято
              сервисом {counts.accepted}
            </h2>
            <span className="muted-value">
              «Принято сервисом» означает приём письма Mail, не доставку во
              «Входящие». Сумма статусов равна числу получателей.
            </span>
          </div>
          <span className="progress-percent">{progress.percent}%</span>
        </div>
        <div className="progress-bar" aria-hidden="true">
          <span
            className="progress-bar__accepted"
            style={{ width: share(counts.accepted) }}
          />
          <span
            className="progress-bar__failed"
            style={{ width: share(counts.failed + counts.closedUnconfirmed) }}
          />
          <span
            className="progress-bar__other"
            style={{ width: share(counts.cancelled + counts.excluded) }}
          />
        </div>
        <div className="counts-grid">
          {countKeys.map(([key, statusKey]) => (
            <button
              type="button"
              key={key}
              className={`count-chip${taskStatus === statusKey ? " count-chip--active" : ""}`}
              onClick={() => {
                setTaskPage(1);
                setTaskStatus(taskStatus === statusKey ? "all" : statusKey);
              }}
            >
              <strong>{counts[key]}</strong>
              <span>{taskStatusLabels[statusKey]}</span>
            </button>
          ))}
        </div>
        <div className="detail-meta">
          <span>Запущена: {formatDateTime(campaign.startedAt)}</span>
          <span>Завершена: {formatDateTime(campaign.finishedAt)}</span>
          <span>Обновлена: {formatDateTime(campaign.updatedAt)}</span>
        </div>
      </section>

      <section className="card table-card">
        <div className="table-card__header">
          <div>
            <span className="card-kicker">Получатели</span>
            <h2>Задачи рассылки</h2>
          </div>
          <span className="table-note">{tasks?.total ?? 0} по фильтру</span>
        </div>
        <div className="table-toolbar">
          <label className="search-field">
            <Search size={16} aria-hidden="true" />
            <span className="sr-only">Поиск по адресу</span>
            <input
              type="search"
              value={taskSearch}
              onChange={(event) => {
                setTaskPage(1);
                setTaskSearch(event.target.value);
              }}
              placeholder="Поиск по адресу…"
            />
          </label>
          <label className="select-field">
            <span className="sr-only">Статус задачи</span>
            <select
              value={taskStatus}
              onChange={(event) => {
                setTaskPage(1);
                setTaskStatus(event.target.value);
              }}
            >
              <option value="all">Все статусы</option>
              {countKeys.map(([, statusKey]) => (
                <option key={statusKey} value={statusKey}>
                  {taskStatusLabels[statusKey]}
                </option>
              ))}
            </select>
            <ChevronDown size={14} aria-hidden="true" />
          </label>
        </div>
        <ErrorLine message={tasksError} />
        {tasks && tasks.items.length ? (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>№</th>
                    <th>Получатель</th>
                    <th>Статус</th>
                    <th>Попыток</th>
                    <th>Аккаунт</th>
                    <th>Последняя ошибка</th>
                    <th>Следующая попытка</th>
                    <th className="table-actions-cell">
                      <span className="sr-only">Действия</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.items.map((task) => (
                    <tr key={task.id}>
                      <td className="muted-value">{task.position}</td>
                      <td>
                        <strong>{task.email}</strong>
                      </td>
                      <td>
                        <span
                          className={`status-badge status-badge--task-${task.status}`}
                        >
                          <span className="status-dot" aria-hidden="true" />
                          {taskStatusLabels[task.status]}
                        </span>
                      </td>
                      <td>
                        {task.attemptCount ? (
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => void openAttempts(task)}
                          >
                            {task.attemptCount} · попытки
                          </button>
                        ) : (
                          <span className="muted-value">0</span>
                        )}
                      </td>
                      <td className="muted-value">
                        {task.accountEmail ?? "—"}
                      </td>
                      <td
                        className="muted-value cell-wrap"
                        title={task.lastError ?? ""}
                      >
                        {task.lastError ?? "—"}
                      </td>
                      <td className="muted-value">
                        {task.status === "pending"
                          ? formatDateTime(task.nextAttemptAt)
                          : "—"}
                      </td>
                      <td className="table-actions-cell">
                        {task.status === "pending" ||
                        task.status === "reserved" ? (
                          <button
                            type="button"
                            className="button button--ghost button--small"
                            onClick={() => setExcluding(task)}
                          >
                            Исключить
                          </button>
                        ) : null}
                        {task.status === "unclear" ? (
                          <button
                            type="button"
                            className="button button--secondary button--small"
                            onClick={() => {
                              setDecision("accepted");
                              setResolving(task);
                            }}
                          >
                            Разрешить
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {tasks.total > tasks.pageSize ? (
              <div className="pagination">
                <span>
                  Страница {tasks.page} из{" "}
                  {Math.ceil(tasks.total / tasks.pageSize)}
                </span>
                <div className="pagination__buttons">
                  <button
                    type="button"
                    className="button button--ghost button--small"
                    disabled={tasks.page <= 1}
                    onClick={() => setTaskPage(tasks.page - 1)}
                  >
                    Назад
                  </button>
                  <button
                    type="button"
                    className="button button--ghost button--small"
                    disabled={tasks.page * tasks.pageSize >= tasks.total}
                    onClick={() => setTaskPage(tasks.page + 1)}
                  >
                    Вперёд
                  </button>
                </div>
              </div>
            ) : null}
          </>
        ) : null}
        {tasks && !tasks.items.length ? (
          <p className="muted-value table-empty">Задач по этому фильтру нет.</p>
        ) : null}
      </section>

      <ConfirmDialog
        open={action !== null}
        title={action ? actionTexts[action].title : ""}
        description={action ? actionTexts[action].description : undefined}
        confirmLabel={action ? actionTexts[action].confirm : ""}
        danger={action === "stop"}
        busy={busy}
        error={actionError}
        onCancel={() => {
          setAction(null);
          setActionError(null);
        }}
        onConfirm={() => void runAction()}
      />

      <ConfirmDialog
        open={excluding !== null}
        title="Исключить получателя из очереди?"
        description={
          excluding
            ? `${excluding.email} не получит письмо в этой рассылке. Задача останется в истории со статусом «исключено».`
            : undefined
        }
        confirmLabel="Исключить"
        danger
        busy={busy}
        error={actionError}
        onCancel={() => {
          setExcluding(null);
          setActionError(null);
        }}
        onConfirm={() => void runExclude()}
      />

      <Modal
        open={resolving !== null}
        title="Неясный исход: решение оператора"
        description={
          resolving
            ? `${resolving.email} через ${resolving.accountEmail ?? "—"}: ${resolving.lastError ?? "ответ сервера не получен"}`
            : undefined
        }
        closeDisabled={busy}
        onRequestClose={() => {
          setResolving(null);
          setActionError(null);
        }}
      >
        <fieldset className="form-fieldset" disabled={busy}>
          <label className="radio-row">
            <input
              type="radio"
              name="decision"
              checked={decision === "accepted"}
              onChange={() => setDecision("accepted")}
            />
            <span>
              <strong>Подтвердить принятие</strong> — письмо точно ушло: задача
              закрывается как принятая, одна отправка учитывается в квоте.
            </span>
          </label>
          <label className="radio-row">
            <input
              type="radio"
              name="decision"
              checked={decision === "failed"}
              onChange={() => setDecision("failed")}
            />
            <span>
              <strong>Подтвердить отказ</strong> — есть доказательство, что
              письмо не принято: задача закрывается ошибкой, резерв квоты
              освобождается. Новый цикл не запускается автоматически.
            </span>
          </label>
          <label className="radio-row">
            <input
              type="radio"
              name="decision"
              checked={decision === "closed"}
              onChange={() => setDecision("closed")}
            />
            <span>
              <strong>Закрыть без повтора</strong> — исход неизвестен: повтора
              не будет, квота аккаунта занята ещё на период лимита как возможная
              отправка. Не считается успехом.
            </span>
          </label>
          <ErrorLine message={actionError} />
          <div className="modal-actions">
            <button
              type="button"
              className="button button--ghost"
              onClick={() => setResolving(null)}
            >
              Отмена
            </button>
            <button
              type="button"
              className="button button--primary"
              onClick={() => void runResolve()}
            >
              {busy ? (
                <span className="button-spinner" aria-hidden="true" />
              ) : null}
              Сохранить решение
            </button>
          </div>
        </fieldset>
      </Modal>

      <Modal
        open={attemptsFor !== null}
        title={attemptsFor ? `Попытки: ${attemptsFor.email}` : ""}
        description="Каждая попытка — отдельная запись; получатель считается один раз."
        wide
        onRequestClose={() => setAttemptsFor(null)}
      >
        {!attempts ? (
          <div className="loading-state">
            <span className="spinner" aria-hidden="true" />
            Загружаем попытки…
          </div>
        ) : (
          <div className="table-scroll table-scroll--modal">
            <table>
              <thead>
                <tr>
                  <th>№</th>
                  <th>Аккаунт</th>
                  <th>Начало</th>
                  <th>Окончание</th>
                  <th>Исход</th>
                  <th>Ошибка</th>
                  <th>Решение оператора</th>
                  <th>Поздний ответ</th>
                </tr>
              </thead>
              <tbody>
                {attempts.map((attempt) => (
                  <tr key={attempt.id}>
                    <td>{attempt.number}</td>
                    <td>{attempt.accountEmail}</td>
                    <td className="muted-value">
                      {formatDateTime(attempt.startedAt)}
                    </td>
                    <td className="muted-value">
                      {formatDateTime(attempt.finishedAt)}
                    </td>
                    <td>
                      {attempt.outcome === "accepted"
                        ? "принято"
                        : attempt.outcome === "rejected"
                          ? "отказ"
                          : attempt.outcome === "unknown"
                            ? "неизвестно"
                            : "выполняется"}
                    </td>
                    <td className="muted-value cell-wrap">
                      {attempt.errorCategory
                        ? `${rejectCategoryLabels[attempt.errorCategory]}${attempt.errorCode ? ` (${attempt.errorCode})` : ""}: `
                        : ""}
                      {attempt.errorMessage ?? "—"}
                    </td>
                    <td>
                      {attempt.operatorDecision === "accepted"
                        ? "принятие подтверждено"
                        : attempt.operatorDecision === "failed"
                          ? "отказ подтверждён"
                          : attempt.operatorDecision === "closed"
                            ? "закрыто без повтора"
                            : "—"}
                    </td>
                    <td className="muted-value cell-wrap">
                      {attempt.lateOutcome
                        ? `${attempt.lateOutcome}: ${attempt.lateMessage ?? ""} (${formatDateTime(attempt.lateAt)})`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Modal>
    </>
  );
}
