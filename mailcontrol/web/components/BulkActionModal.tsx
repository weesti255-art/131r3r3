import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import type { BulkAccountAction, Group } from "../../shared/contracts";
import Modal from "./Modal";

export type BulkKind = BulkAccountAction["action"];

const titles: Record<BulkKind, string> = {
  set_limit: "Изменить лимит выбранных аккаунтов",
  move: "Перенести аккаунты в другую группу",
  disable: "Отключить аккаунты",
  enable: "Включить аккаунты",
  check: "Проверить подключение",
};

export default function BulkActionModal({
  kind,
  count,
  groups,
  senderKind,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  kind: BulkKind | null;
  count: number;
  groups: Group[];
  senderKind: "test" | "mail";
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (action: BulkAccountAction) => void;
}) {
  const [limitCount, setLimitCount] = useState("15");
  const [periodHours, setPeriodHours] = useState("24");
  const [groupId, setGroupId] = useState(groups[0]?.id ?? "");
  useEffect(() => {
    if (kind) setGroupId((current) => current || groups[0]?.id || "");
  }, [kind, groups]);
  const limitOk = /^\d+$/.test(limitCount) && Number(limitCount) > 0;
  const periodOk = /^\d+$/.test(periodHours) && Number(periodHours) > 0;

  const submit = () => {
    if (!kind) return;
    if (kind === "set_limit")
      onConfirm({
        action: "set_limit",
        limitCount: Number(limitCount),
        periodHours: Number(periodHours),
      });
    else if (kind === "move") onConfirm({ action: "move", groupId });
    else onConfirm({ action: kind });
  };

  return (
    <Modal
      open={kind !== null}
      title={kind ? titles[kind] : ""}
      description={`Действие относится к ${count} явно выбранным аккаунтам.`}
      closeDisabled={busy}
      onRequestClose={onCancel}
    >
      <fieldset className="form-fieldset" disabled={busy}>
        {kind === "set_limit" ? (
          <div className="form-field">
            <span className="form-field__label">
              Новый лимит каждого аккаунта
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
              История отправок сохраняется: остаток пересчитывается по уже
              сделанным отправкам за новое окно.
            </span>
          </div>
        ) : null}
        {kind === "move" ? (
          <div className="form-field">
            <span className="form-field__label">Группа</span>
            <div className="select-wrap">
              <select
                value={groupId}
                onChange={(event) => setGroupId(event.target.value)}
              >
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </div>
            <span className="field-hint">
              Перенос сохраняет историю, попытки и расход лимита. Уже начатые
              отправки завершатся; новые пойдут по новой группе.
            </span>
          </div>
        ) : null}
        {kind === "disable" ? (
          <p className="dialog-text">
            Отключённые аккаунты не участвуют в отправках. Автоматически они не
            восстанавливаются — включить их сможет только оператор.
          </p>
        ) : null}
        {kind === "enable" ? (
          <p className="dialog-text">
            Аккаунты снова станут доступны для отправки. Отметки об ошибках
            входа, проверки и блокировки будут сброшены до следующей проверки.
          </p>
        ) : null}
        {kind === "check" ? (
          <p className="dialog-text">
            {senderKind === "mail"
              ? "Будет выполнено подключение к smtp.mail.ru и вход по сохранённому паролю приложения без отправки письма."
              : "Сейчас включён тестовый отправитель: проверка воспроизводит поведение по шаблонам адресов и не обращается к Mail. Это не настоящая проверка ящика."}
          </p>
        ) : null}
        {error ? (
          <div className="submit-error" role="alert">
            <AlertTriangle size={16} aria-hidden="true" />
            <span>{error}</span>
          </div>
        ) : null}
        <div className="modal-actions">
          <button
            type="button"
            className="button button--ghost"
            onClick={onCancel}
          >
            Отмена
          </button>
          <button
            type="button"
            className={`button ${kind === "disable" ? "button--danger" : "button--primary"}`}
            disabled={
              (kind === "set_limit" && (!limitOk || !periodOk)) ||
              (kind === "move" && !groupId)
            }
            onClick={submit}
          >
            {busy ? (
              <>
                <span className="button-spinner" aria-hidden="true" />
                Выполняем…
              </>
            ) : (
              `Применить к ${count}`
            )}
          </button>
        </div>
      </fieldset>
    </Modal>
  );
}
