import { useState } from "react";
import type { ChangeEvent } from "react";
import { AlertTriangle, Check, UploadCloud, Users } from "lucide-react";
import type {
  Campaign,
  ImportFormat,
  RecipientsPreview,
} from "../../shared/contracts";
import { api, createRequestKey, displayError } from "../lib/api";
import { plural, readFileText } from "../lib/format";

type Tab = "text" | "txt" | "csv";

/** Step 2 of the wizard: recipients of an already saved draft. */
export default function RecipientsEditor({
  campaign,
  disabled,
  onSaved,
}: {
  campaign: Campaign;
  disabled: boolean;
  onSaved: (campaign: Campaign) => void;
}) {
  const [tab, setTab] = useState<Tab>("text");
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<RecipientsPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const format: ImportFormat = tab === "csv" ? "csv" : "lines";
  const locked = campaign.status !== "draft";

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      setText(await readFileText(file));
      setFileName(file.name);
      setPreview(null);
      setError(null);
    } catch (fileError) {
      setError((fileError as Error).message);
    }
  };

  const runPreview = async () => {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      setPreview(await api.previewRecipients(campaign.id, text, format));
    } catch (previewError) {
      setError(displayError(previewError).message);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.setRecipients(campaign.id, {
        text,
        format,
        requestKey: createRequestKey(),
      });
      setSaved(
        `Список сохранён: ${result.validCount} ${plural(result.validCount, "адрес", "адреса", "адресов")}.`
      );
      setPreview(null);
      setText("");
      setFileName("");
      onSaved(result.campaign);
    } catch (saveError) {
      setError(displayError(saveError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wizard-panel">
      <div className="wizard-intro">
        <span className="wizard-panel__number">02</span>
        <div>
          <h3>Получатели</h3>
          <p>
            Сейчас в черновике {campaign.counts.total}{" "}
            {plural(campaign.counts.total, "адрес", "адреса", "адресов")}.
            Загрузка нового списка заменяет прежний; повторы внутри рассылки
            схлопываются в одну задачу.
          </p>
        </div>
      </div>
      {locked ? (
        <div className="form-callout">
          <Users size={16} aria-hidden="true" />
          <span>
            Список зафиксирован при запуске. Для других получателей создайте
            новую рассылку.
          </span>
        </div>
      ) : (
        <fieldset className="form-fieldset" disabled={disabled || busy}>
          <div
            className="import-tabs"
            role="tablist"
            aria-label="Формат получателей"
          >
            {(
              [
                ["text", "Вставка строк"],
                ["txt", "TXT-файл"],
                ["csv", "CSV (столбец email)"],
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
                  setPreview(null);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          {tab === "text" ? (
            <textarea
              className="import-textarea"
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setPreview(null);
              }}
              placeholder={"reader1@example.com\nreader2@example.com"}
              aria-label="Адреса получателей"
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
                  : "Один адрес в строке"}
              </span>
              <input
                type="file"
                accept={tab === "csv" ? ".csv,text/csv" : ".txt,text/plain"}
                onChange={onFile}
              />
            </label>
          )}
          {error ? (
            <div className="submit-error" role="alert">
              <AlertTriangle size={16} aria-hidden="true" />
              <span>{error}</span>
            </div>
          ) : null}
          {saved ? (
            <div className="import-result import-result--compact">
              <Check size={18} aria-hidden="true" />
              <span>{saved}</span>
            </div>
          ) : null}
          {preview ? (
            <div className="recipients-preview">
              <div className="preview-summary">
                <span className="summary-pill summary-pill--green">
                  Корректных: {preview.validCount}
                </span>
                <span className="summary-pill summary-pill--amber">
                  Повторов: {preview.duplicateCount}
                </span>
                <span className="summary-pill summary-pill--red">
                  Некорректных: {preview.invalidCount}
                </span>
              </div>
              {preview.invalid.length ? (
                <div className="table-scroll table-scroll--modal">
                  <table>
                    <thead>
                      <tr>
                        <th>Строка</th>
                        <th>Адрес</th>
                        <th>Причина</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.invalid.slice(0, 100).map((row) => (
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
              <span className="field-hint">
                Некорректные строки будут пропущены; в рассылку попадут только
                корректные адреса.
              </span>
            </div>
          ) : null}
          <div className="button-row">
            <button
              type="button"
              className="button button--secondary"
              disabled={!text.trim()}
              onClick={() => void runPreview()}
            >
              Проверить адреса
            </button>
            <button
              type="button"
              className="button button--primary"
              disabled={!preview || preview.validCount === 0}
              onClick={() => void apply()}
            >
              {busy ? (
                <span className="button-spinner" aria-hidden="true" />
              ) : (
                <Check size={16} aria-hidden="true" />
              )}
              Сохранить список{preview ? ` (${preview.validCount})` : ""}
            </button>
          </div>
        </fieldset>
      )}
    </div>
  );
}
