import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";
import { X } from "lucide-react";

interface ModalProps {
  open: boolean;
  title: string;
  description?: string;
  wide?: boolean;
  closeDisabled?: boolean;
  onRequestClose: () => void;
  children: ReactNode;
}

export default function Modal({
  open,
  title,
  description,
  wide = false,
  closeDisabled = false,
  onRequestClose,
  children,
}: ModalProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const closeHandlerRef = useRef(onRequestClose);
  const closeDisabledRef = useRef(closeDisabled);

  useEffect(() => {
    closeHandlerRef.current = onRequestClose;
  }, [onRequestClose]);

  useEffect(() => {
    closeDisabledRef.current = closeDisabled;
  }, [closeDisabled]);

  useEffect(() => {
    if (!open) {
      if (restoreFocusRef.current?.isConnected) restoreFocusRef.current.focus();
      restoreFocusRef.current = null;
      return;
    }

    if (!restoreFocusRef.current) {
      const activeElement = document.activeElement;
      restoreFocusRef.current =
        activeElement instanceof HTMLElement ? activeElement : null;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const backgroundElements = Array.from(
      document.querySelectorAll<HTMLElement>(".sidebar, .app-main")
    );
    const previousInert = backgroundElements.map((element) => ({
      element,
      inert: element.inert,
    }));
    backgroundElements.forEach((element) => {
      element.inert = true;
      element.setAttribute("inert", "");
    });

    const focusableSelector =
      "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";
    const getFocusableElements = () => {
      const dialog = dialogRef.current;
      if (!dialog) return [];
      return Array.from(
        dialog.querySelectorAll<HTMLElement>(focusableSelector)
      ).filter((element) => !element.closest("fieldset[disabled]"));
    };
    const focusInsideDialog = () => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const activeElement = document.activeElement;
      if (
        activeElement instanceof HTMLElement &&
        activeElement !== dialog &&
        dialog.contains(activeElement)
      ) {
        return;
      }
      const initialFocus =
        getFocusableElements().find((element) =>
          element.matches("[data-autofocus]")
        ) ?? getFocusableElements()[0];
      (initialFocus ?? dialog).focus();
    };
    focusInsideDialog();

    const dialogObserver = new MutationObserver(() => {
      focusInsideDialog();
    });
    if (dialogRef.current) {
      dialogObserver.observe(dialogRef.current, {
        attributes: true,
        attributeFilter: ["disabled"],
        childList: true,
        subtree: true,
      });
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (closeDisabledRef.current) return;
        event.preventDefault();
        closeHandlerRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const elements = getFocusableElements();
      if (!elements.length) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (!dialogRef.current.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      dialogObserver.disconnect();
      document.body.style.overflow = previousOverflow;
      previousInert.forEach(({ element, inert }) => {
        element.inert = inert;
        if (inert) element.setAttribute("inert", "");
        else element.removeAttribute("inert");
      });
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="modal-layer" role="presentation">
      <button
        type="button"
        className="modal-backdrop"
        aria-label="Закрыть окно"
        tabIndex={-1}
        disabled={closeDisabled}
        onClick={closeDisabled ? undefined : onRequestClose}
      />
      <div
        ref={dialogRef}
        className={`modal-dialog${wide ? " modal-dialog--wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
      >
        <div className="modal-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description ? (
              <p id={descriptionId} className="modal-description">
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Закрыть окно"
            disabled={closeDisabled}
            onClick={onRequestClose}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <div className="modal-content">{children}</div>
      </div>
    </div>
  );
}
