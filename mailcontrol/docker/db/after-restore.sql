-- Applied after restoring a backup. Letters may have left after the copy was
-- taken, so nothing continues automatically: running campaigns pause with a
-- reason and in-flight sends become unclear for the operator to reconcile.
BEGIN;
UPDATE attempts SET finished_at = now(), outcome = 'unknown',
       error_message = 'Восстановление из резервной копии: результат отправки после копии неизвестен'
 WHERE finished_at IS NULL;
UPDATE tasks SET status = 'unclear', owner_worker_id = NULL, owner_token = NULL, reserved_until = NULL,
       last_error_code = 'unknown', last_error = 'Восстановление из резервной копии: письмо могло уйти после копии', updated_at = now()
 WHERE status = 'sending';
UPDATE tasks SET status = 'pending', owner_worker_id = NULL, owner_token = NULL, reserved_until = NULL, updated_at = now()
 WHERE status = 'reserved';
UPDATE campaigns SET status = 'paused',
       pause_reason = 'Восстановлено из резервной копии: сверьте уже отправленные письма и нажмите «Продолжить» осознанно',
       wait_reason = NULL, wait_until = NULL, updated_at = now()
 WHERE status = 'running';
UPDATE workers SET stopped_at = now() WHERE stopped_at IS NULL;
INSERT INTO events(kind, level, title, detail, entity_type)
VALUES ('restore_applied', 'warning', 'База восстановлена из резервной копии',
        'Выполняющиеся рассылки поставлены на паузу, начатые отправки помечены неясными. Продолжение — только по решению оператора.', 'system');
COMMIT;
