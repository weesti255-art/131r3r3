import { useEffect, useState } from "react";
import type { ChangeEvent } from "react";
import {
  AlertTriangle,
  Check,
  Download,
  FileSpreadsheet,
  ShieldCheck,
  UploadCloud,
} from "lucide-react";
import type {
  AccountImportPreview,
  AccountImportResult,
  Group,
  ImportFormat,
} from "../../shared/contracts";
import { api, createRequestKey, displayError, templateUrl } from "../lib/api";
import { downloadCsv, readFileText } from "../lib/format";
import Modal from "./Modal";

type Tab = "text" | "txt" | "csv";

export default function ImportAccountsModal({
  open,
  groups,
  onClose,
  onImported,
}: {
  open: boolean;
  groups: Group[];
  onClose: () => void;
  onImported: (result: AccountImportResult) => void;
}) {
  const [tab, setTab] = useState<Tab>("text");
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [groupId, setGroupId] = useState("");
  const [limitCount, setLimitCount] = useState("15");
  const [periodHours, setPeriodHours] = useState("24");
  const [duplicateAction, setDuplicateAction] = useState<"keep" | "move">(
    "keep"
  );
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [preview, setPreview] = useState<AccountImportPreview | null>(null);
  const [result, setResult] = useState<AccountImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestKey, setRequestKey] = useState(createRequestKey());
  const format: ImportFormat = tab === "csv" ? "csv" : "lines";

  useEffect(() => {
    if (!open) return;
    setTab("text");
    setText("");
    setFileName("");
    setStep(1);
    setPreview(null);
    setResult(null);
    setError(null);
    setDuplicateAction("keep");
    setRequestKey(createRequestKey());
    const first = groups[0];
    setGroupId(first?.id ?? "");
    setLimitCount(String(first?.limitCount ?? 15));
    setPeriodHours(String(first?.periodHours ?? 24));
  }, [open, groups]);

  const selectGroup = (id: string) => {
    setGroupId(id);
    const group = groups.find((item) => item.id === id);
    if (group) {
      setLimitCount(String(group.limitCount));
      setPeriodHours(String(group.periodHours));
    }
  };

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      setText(await readFileText(file));
      setFileName(file.name);
      setError(null);
    } catch (fileError) {
      setError((fileError as Error).message);
    }
  };

  const limitOk = /^\d+$/.test(limitCount) && Number(limitCount) > 0;
  const periodOk = /^\d+$/.test(periodHours) && Number(periodHours) > 0;
  const canPreview = text.trim().length > 0 && groupId && limitOk && periodOk;

  const runPreview = async () => {
    setBusy(true);
    setError(null);
    try {
      setPreview(await api.previewAccountImport(text, format));
      setStep(2);
    } catch (previewError) {
      setError(displayError(previewError).message);
    } finally {
      setBusy(false);
    }
  };

  const runImport = async () => {
    setBusy(true);
    setError(null);
    try {
      const imported = await api.importAccounts({
        text,
        format,
        groupId,
        limitCount: Number(limitCount),
        periodHours: Number(periodHours),
        duplicateAction,
        requestKey,
      });
      setResult(imported);
      setStep(3);
      onImported(imported);
    } catch (importError) {
      setError(displayError(importError).message);
    } finally {
      setBusy(false);
    }
  };

  const groupName = groups.find((group) => group.id === groupId)?.name ?? "—";

  return (
    <Modal
      open={open}
      title="Импорт почтовых аккаунтов"
      description="Пароли приложений шифруются в базе локальным ключом и никогда не показываются в интерфейсе, событиях и выгрузках."
      wide
      closeDisabled={busy}
      onRequestClose={onClose}
    >
      {error ? (
        <div className="submit-error" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}
      {step === 1 ? (
        <fieldset className="form-fieldset" disabled={busy}>
          <div
            className="import-tabs"
            role="tablist"
            aria-label="Формат импорта"
          >
            {(
              [
                ["text", "Вставка строк"],
                ["txt", "TXT-файл"],
                ["csv", "CSV-файл"],
              ] as Array<[Tab, string]>
            ).map(([value, label]) => (
              <button
                type="button"
                role="tab"
                key={value}
                aria-selected={tab === value}
                className={
                  tab === value ? "import-tab import-tab--active" : "import-tab"
                }
                onClick={() => {
                  setTab(value);
                  setText("");
                  setFileName("");
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="import-preview">
            <div className="import-preview__heading">
              <div>
                <strong>
                  {tab === "csv" ? "Файл CSV" : "Строки аккаунтов"}
                </strong>
                <span>
                  {tab === "csv"
                    ? "UTF-8, заголовок email,app_password, стандартные кавычки"
                    : "Одна строка на аккаунт: email | app_password"}
                </span>
              </div>
              <a
                className="text-button"
                href={templateUrl(tab === "csv" ? "csv" : "lines")}
                download
              >
                <Download size={14} aria-hidden="true" /> Шаблон
              </a>
            </div>
            {tab === "text" ? (
              <textarea
                className="import-textarea"
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={
                  "user1@mail.ru | пароль-приложения\nuser2@inbox.ru | пароль-приложения"
                }
                aria-label="Строки аккаунтов"
                spellCheck={false}
              />
            ) : (
              <label className="file-dropzone file-dropzone--active">
                <UploadCloud size={25} aria-hidden="true" />
                <strong>
                  {fileName ||
                    (tab === "csv" ? "Выберите CSV-файл" : "Выберите TXT-файл")}
                </strong>
                <span>
                  {text
                    ? `${text.split(/\r?\n/).filter(Boolean).length} строк прочитано`
                    : "Файл разбирается в браузере и отправляется только на этот сервер"}
                </span>
                <input
                  type="file"
                  accept={tab === "csv" ? ".csv,text/csv" : ".txt,text/plain"}
                  onChange={onFile}
                />
              </label>
            )}
          </div>
          <div className="form-grid form-grid--two">
            <div className="form-field">
              <span className="form-field__label">
                Группа для новых аккаунтов
              </span>
              <div className="select-wrap">
                <select
                  value={groupId}
                  onChange={(event) => selectGroup(event.target.value)}
                >
                  {groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="form-field">
              <span className="form-field__label">
                Лимит каждого нового аккаунта
              </span>
              <div className="limit-inputs">
                <label className="input-suffix">
                  <input
                    type="number"
                    min={1}
                    value={limitCount}
                    onChange={(event) => setLimitCount(event.target.value)}
                    aria-label="Писем"
                    aria-invalid={!limitOk}
                  />
                  <span>писем</span>
                </label>
                <span className="limit-inputs__sep">за</span>
                <label className="input-suffix">
                  <input
                    type="number"
                    min={1}
                    value={periodHours}
                    onChange={(event) => setPeriodHours(event.target.value)}
                    aria-label="Часов"
                    aria-invalid={!periodOk}
                  />
                  <span>ч</span>
                </label>
              </div>
              <span className="field-hint">
                Скользящее окно; настройки пачки меняют только новые строки.
              </span>
            </div>
          </div>
          <div className="form-field">
            <span className="form-field__label">
              Если адрес уже есть в базе
            </span>
            <label className="radio-row">
              <input
                type="radio"
                name="dup"
                checked={duplicateAction === "keep"}
                onChange={() => setDuplicateAction("keep")}
              />
              <span>
                <strong>Оставить существующий</strong> — группа, лимит и пароль
                не меняются
              </span>
            </label>
            <label className="radio-row">
              <input
                type="radio"
                name="dup"
                checked={duplicateAction === "move"}
                onChange={() => setDuplicateAction("move")}
              />
              <span>
                <strong>
                  Перенести в выбранную группу с выбранным лимитом
                </strong>{" "}
                — история, попытки и расход лимита сохраняются, пароль не
                обновляется
              </span>
            </label>
          </div>
          <div className="import-safe-note">
            <ShieldCheck size={16} aria-hidden="true" />
            <span>
              Выгрузка ошибок содержит номер строки, email и причину — без
              паролей и исходных строк.
            </span>
          </div>
          <div className="modal-actions">
            <button
              type="button"
              className="button button--ghost"
              onClick={onClose}
            >
              Отмена
            </button>
            <button
              type="button"
              className="button button--primary"
              disabled={!canPreview}
              onClick={() => void runPreview()}
            >
              {busy ? (
                <span className="button-spinner" aria-hidden="true" />
              ) : (
                <FileSpreadsheet size={16} aria-hidden="true" />
              )}
              Проверить строки
            </button>
          </div>
        </fieldset>
      ) : null}
      {step === 2 && preview ? (
        <fieldset className="form-fieldset" disabled={busy}>
          <div className="preview-summary">
            <span className="summary-pill summary-pill--green">
              Новых: {preview.newCount}
            </span>
            <span className="summary-pill summary-pill--amber">
              Дублей: {preview.duplicateCount}
            </span>
            <span className="summary-pill summary-pill--red">
              Ошибок: {preview.errorCount}
            </span>
            <span className="summary-pill">
              Группа «{groupName}», лимит {limitCount}/{periodHours} ч, дубли:{" "}
              {duplicateAction === "keep" ? "оставить" : "перенести"}
            </span>
          </div>
          <div className="table-scroll table-scroll--modal">
            <table>
              <thead>
                <tr>
                  <th>Строка</th>
                  <th>Email</th>
                  <th>Результат</th>
                  <th>Пояснение</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row) => (
                  <tr key={row.line}>
                    <td>{row.line}</td>
                    <td>
                      {row.email ?? (
                        <span className="muted-value">
                          — (адрес не распознан)
                        </span>
                      )}
                    </td>
                    <td>
                      <span
                        className={`status-badge status-badge--${row.kind === "new" ? "active" : row.kind === "duplicate" ? "quota_exhausted" : "auth_error"}`}
                      >
                        <span className="status-dot" aria-hidden="true" />
                        {row.kind === "new"
                          ? "Новый"
                          : row.kind === "duplicate"
                            ? "Дубль"
                            : "Ошибка"}
                      </span>
                    </td>
                    <td className="muted-value">
                      {row.kind === "duplicate"
                        ? `Уже в группе «${row.existingGroupName}»`
                        : row.reason ?? ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.truncated ? (
            <span className="field-hint">
              Показаны первые {preview.rows.length} строк; счётчики учитывают
              все.
            </span>
          ) : null}
          <div className="modal-actions">
            <button
              type="button"
              className="button button--ghost"
              onClick={() => setStep(1)}
            >
              Назад
            </button>
            <button
              type="button"
              className="button button--primary"
              disabled={
                preview.newCount +
                  (duplicateAction === "move" ? preview.duplicateCount : 0) ===
                0
              }
              onClick={() => void runImport()}
            >
              {busy ? (
                <span className="button-spinner" aria-hidden="true" />
              ) : (
                <UploadCloud size={16} aria-hidden="true" />
              )}
              Импортировать {preview.newCount} новых
              {duplicateAction === "move" && preview.duplicateCount
                ? `, перенести ${preview.duplicateCount}`
                : ""}
            </button>
          </div>
        </fieldset>
      ) : null}
      {step === 3 && result ? (
        <div className="wizard-panel">
          <div className="import-result">
            <Check size={22} aria-hidden="true" />
            <div>
              <strong>
                {result.repeated
                  ? "Этот импорт уже был применён раньше"
                  : "Импорт выполнен"}
              </strong>
              <span>
                Добавлено {result.added}, дублей оставлено{" "}
                {result.duplicatesKept}, перенесено {result.duplicatesMoved},
                ошибок {result.errorCount}.
              </span>
            </div>
          </div>
          {result.errorCount ? (
            <div className="table-scroll table-scroll--modal">
              <table>
                <thead>
                  <tr>
                    <th>Строка</th>
                    <th>Email</th>
                    <th>Причина</th>
                  </tr>
                </thead>
                <tbody>
                  {result.errors.slice(0, 200).map((row) => (
                    <tr key={row.line}>
                      <td>{row.line}</td>
                      <td>{row.email ?? "—"}</td>
                      <td className="muted-value">{row.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <div className="modal-actions">
            {result.errorCount ? (
              <button
                type="button"
                className="button button--secondary"
                onClick={() =>
                  downloadCsv("mailcontrol-import-errors.csv", [
                    ["Строка", "Email", "Причина"],
                    ...result.errors.map((row) => [
                      String(row.line),
                      row.email ?? "",
                      row.reason,
                    ]),
                  ])
                }
              >
                <Download size={16} aria-hidden="true" /> Скачать ошибки CSV
              </button>
            ) : null}
            <button
              type="button"
              className="button button--primary"
              onClick={onClose}
            >
              Готово
            </button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
