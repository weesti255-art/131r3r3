import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import Modal from "./Modal";

export default function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  danger = false,
  busy = false,
  error,
  children,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  error?: string | null;
  children?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      open={open}
      title={title}
      description={description}
      closeDisabled={busy}
      onRequestClose={onCancel}
    >
      {children}
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
          disabled={busy}
        >
          Отмена
        </button>
        <button
          type="button"
          className={`button ${danger ? "button--danger" : "button--primary"}`}
          onClick={onConfirm}
          disabled={busy}
        >
          {busy ? (
            <>
              <span className="button-spinner" aria-hidden="true" />
              Выполняем…
            </>
          ) : (
            confirmLabel
          )}
        </button>
      </div>
    </Modal>
  );
}
