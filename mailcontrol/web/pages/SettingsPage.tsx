import { useEffect, useState } from "react";
import { AlertTriangle, Check, ShieldAlert } from "lucide-react";
import type { Health, Settings } from "../../shared/contracts";
import ConfirmDialog from "../components/ConfirmDialog";
import { api, displayError } from "../lib/api";
import { formatDateTime } from "../lib/format";

export default function SettingsPage({
  health,
  onToast,
  onSettingsChanged,
}: {
  health: Health | null;
  onToast: (message: string) => void;
  onSettingsChanged: () => void;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    retryMaxAttempts: "3",
    retryBaseMinutes: "30",
    retryMaxMinutes: "120",
    testSenderDelayMs: "300",
  });
  const [saving, setSaving] = useState(false);
  const [confirmMail, setConfirmMail] = useState(false);

  const load = async () => {
    try {
      const next = await api.settings();
      setSettings(next);
      setForm({
        retryMaxAttempts: String(next.retryMaxAttempts),
        retryBaseMinutes: String(next.retryBaseMinutes),
        retryMaxMinutes: String(next.retryMaxMinutes),
        testSenderDelayMs: String(next.testSenderDelayMs),
      });
      setError(null);
    } catch (loadError) {
      setError(displayError(loadError).message);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const numbers = {
    retryMaxAttempts: Number(form.retryMaxAttempts),
    retryBaseMinutes: Number(form.retryBaseMinutes),
    retryMaxMinutes: Number(form.retryMaxMinutes),
    testSenderDelayMs: Number(form.testSenderDelayMs),
  };
  const valid =
    Object.values(form).every((value) => /^\d+$/.test(value)) &&
    numbers.retryBaseMinutes >= 1 &&
    numbers.retryMaxMinutes >= numbers.retryBaseMinutes;

  const save = async (patch: { senderKind?: "test" | "mail" } = {}) => {
    setSaving(true);
    setError(null);
    try {
      const next = await api.updateSettings({ ...numbers, ...patch });
      setSettings(next);
      onToast("Настройки сохранены");
      onSettingsChanged();
    } catch (saveError) {
      setError(displayError(saveError).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <span className="page-header__eyebrow">Редкие настройки</span>
          <h1>Настройки</h1>
          <p className="page-header__description">
            Повторы временных ошибок и режим отправителя. Обычная работа этих
            настроек не требует.
          </p>
        </div>
      </div>
      {error ? (
        <div className="submit-error" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}
      {settings ? (
        <div className="settings-grid">
          <section className="card settings-card">
            <span className="card-kicker">Отправитель</span>
            <h2>Режим отправки</h2>
            <label className="radio-row">
              <input
                type="radio"
                name="sender"
                checked={settings.senderKind === "test"}
                disabled={saving}
                onChange={() => void save({ senderKind: "test" })}
              />
              <span>
                <strong>Тестовый отправитель</strong> — письма не покидают
                компьютер; результат определяется шаблонами адресов
                (fail-address*, fail-temp*, fail-content*, unknown*; аккаунты
                auth-error*, needs-check*, blocked*, temp-error*).
              </span>
            </label>
            <label className="radio-row">
              <input
                type="radio"
                name="sender"
                checked={settings.senderKind === "mail"}
                disabled={saving || !settings.mailSenderAllowed}
                onChange={() => setConfirmMail(true)}
              />
              <span>
                <strong>Реальная отправка через Mail</strong> —
                smtp.mail.ru:465, TLS, вход полным email и сохранённым паролем
                приложения.
                {!settings.mailSenderAllowed
                  ? " Недоступно в демонстрационном режиме и удалённом Preview."
                  : ""}
              </span>
            </label>
            <div
              className={`info-strip${settings.senderKind === "mail" ? " info-strip--warning" : ""}`}
            >
              <ShieldAlert size={16} aria-hidden="true" />
              <span>
                {settings.senderKind === "mail"
                  ? "Сейчас включена реальная отправка. Перед первой рассылкой отправьте тестовое письмо на разрешённый адрес."
                  : "Сейчас письма во внешний мир не отправляются."}
              </span>
            </div>
          </section>
          <section className="card settings-card">
            <span className="card-kicker">Временные ошибки</span>
            <h2>Повторы</h2>
            <fieldset className="form-fieldset" disabled={saving}>
              <div className="form-grid form-grid--two">
                <label className="form-field">
                  <span className="form-field__label">
                    Повторов после первой попытки
                  </span>
                  <input
                    type="number"
                    min={0}
                    max={20}
                    value={form.retryMaxAttempts}
                    onChange={(event) =>
                      setForm({ ...form, retryMaxAttempts: event.target.value })
                    }
                  />
                </label>
                <label className="form-field">
                  <span className="form-field__label">Первая пауза, минут</span>
                  <input
                    type="number"
                    min={1}
                    value={form.retryBaseMinutes}
                    onChange={(event) =>
                      setForm({ ...form, retryBaseMinutes: event.target.value })
                    }
                  />
                </label>
                <label className="form-field">
                  <span className="form-field__label">
                    Максимальная пауза, минут
                  </span>
                  <input
                    type="number"
                    min={1}
                    value={form.retryMaxMinutes}
                    onChange={(event) =>
                      setForm({ ...form, retryMaxMinutes: event.target.value })
                    }
                  />
                </label>
                <label className="form-field">
                  <span className="form-field__label">
                    Задержка тестового отправителя, мс
                  </span>
                  <input
                    type="number"
                    min={0}
                    max={60000}
                    value={form.testSenderDelayMs}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        testSenderDelayMs: event.target.value,
                      })
                    }
                  />
                </label>
              </div>
              <span className="field-hint">
                Пауза удваивается с каждым повтором до максимума. Ожидание квоты
                попыткой не считается; смена аккаунта не сбрасывает счётчик.
              </span>
              <div className="modal-actions">
                <button
                  type="button"
                  className="button button--primary"
                  disabled={!valid}
                  onClick={() => void save()}
                >
                  {saving ? (
                    <span className="button-spinner" aria-hidden="true" />
                  ) : (
                    <Check size={16} aria-hidden="true" />
                  )}
                  Сохранить
                </button>
              </div>
            </fieldset>
          </section>
          <section className="card settings-card">
            <span className="card-kicker">Состояние</span>
            <h2>Система</h2>
            <dl className="definition-list">
              <dt>Версия</dt>
              <dd>
                {health?.version ?? "—"} · {health?.stage ?? ""}
              </dd>
              <dt>Режим данных</dt>
              <dd>{settings.mode === "demo" ? "Демонстрация" : "Локальный"}</dd>
              <dt>Процессов отправки в работе</dt>
              <dd>{health?.workersAlive ?? "—"}</dd>
              <dt>Настройки обновлены</dt>
              <dd>{formatDateTime(settings.updatedAt)}</dd>
            </dl>
            <p className="muted-value">
              Резервная копия создаётся командой BACKUP.cmd (дамп БД и файл
              ключа), восстановление — RESTORE.cmd. Подробности в README.
            </p>
          </section>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirmMail}
        title="Включить реальную отправку через Mail?"
        description="Новые отправки пойдут через smtp.mail.ru с сохранёнными паролями приложений. Лимиты, очередь и история те же; отменить можно переключением обратно."
        confirmLabel="Включить реальную отправку"
        danger
        busy={saving}
        onCancel={() => setConfirmMail(false)}
        onConfirm={() => {
          setConfirmMail(false);
          void save({ senderKind: "mail" });
        }}
      />
    </>
  );
}
