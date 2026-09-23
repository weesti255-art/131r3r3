# MailControl API (MVP-1)

Типы ответов — в `shared/contracts.ts`. Все изменяющие запросы — JSON,
с проверкой Host/Origin. Ошибки — `ApiError` (`400 VALIDATION_ERROR` с `fields`,
`404`, `409 REQUEST_CONFLICT | REVISION_CONFLICT | INVALID_STATE`, `403`, `503`).
Повтор запроса с тем же `requestKey` возвращает прежний результат и не создаёт дублей.

| Метод и путь | Тело → Ответ |
| --- | --- |
| `GET /api/health` | → `Health` |
| `GET /api/overview?since=ISO` | → `Overview` (`since` — начало «сегодня» оператора) |
| `GET /api/settings` · `PATCH /api/settings` | `UpdateSettings` → `Settings` |
| `GET /api/groups?page&pageSize&q` · `POST /api/groups` | `CreateGroup` → `Group` |
| `GET /api/accounts?page&pageSize&q&groupId&status` | `status`: `all`, `problem`, или `AccountStatus` → `Page<Account>` |
| `POST /api/accounts/import/preview` | `{text, format}` → `AccountImportPreview` |
| `POST /api/accounts/import` | `AccountImportRequest` → `AccountImportResult` |
| `GET /api/accounts/import/template?format=csv\|lines` | → файл-шаблон |
| `POST /api/accounts/bulk` | `BulkAccountRequest` → `BulkAccountResult` |
| `POST /api/accounts/:id/check` | `{requestKey}` → `AccountCheckResult` |
| `GET /api/campaigns?page&pageSize&q&groupId&status` | `status`: `all`, `active` (running+paused), или `CampaignStatus` → `Page<CampaignSummary>` |
| `POST /api/campaigns` · `GET /api/campaigns/:id` · `PATCH /api/campaigns/:id` | `CreateDraft` / `UpdateDraft` → `Campaign` (PATCH только для `draft`) |
| `POST /api/campaigns/:id/recipients/preview` | `{text, format}` → `RecipientsPreview` |
| `PUT /api/campaigns/:id/recipients` | `RecipientsRequest` → `RecipientsResult` (только `draft`, заменяет список) |
| `GET /api/campaigns/:id/tasks?page&pageSize&status&q` | → `Page<Task>` |
| `GET /api/campaigns/:id/tasks/:taskId/attempts` | → `Attempt[]` |
| `POST /api/campaigns/:id/start` `/pause` `/resume` `/stop` | `{requestKey}` → `Campaign` |
| `POST /api/campaigns/:id/test-send` | `TestSendRequest` → `Campaign` (отдельная тестовая рассылка на один адрес) |
| `POST /api/campaigns/:id/tasks/:taskId/exclude` | `{requestKey}` → `Task` |
| `POST /api/campaigns/:id/tasks/:taskId/resolve` | `ResolveTaskRequest` → `Task` (только `unclear`) |
| `GET /api/campaigns/:id/report.csv` | → CSV, UTF-8 с BOM |
| `GET /api/events?page&pageSize&kind&level&campaignId&accountId&q` | → `Page<Event>` |
| `GET /api/attempts/:id` | → `Attempt` |

Страницы интерфейса: `/`, `/accounts`, `/campaigns`, `/campaigns/:id`, `/events`, `/settings`.
