import { z } from "zod";

const shortText = (limit: number) =>
  z.string().trim().max(limit, `Не более ${limit} символов`);
const positiveInteger = z
  .number()
  .int("Нужно целое число")
  .min(1, "Минимум 1")
  .max(2147483647, "Слишком большое число");
const uuid = z.string().uuid("Некорректный идентификатор");
const requestKey = uuid;
const importText = z
  .string()
  .max(5_000_000, "Слишком большой объём данных: разделите импорт на части");
const importFormat = z.enum(["lines", "csv"]);

export const groupSchema = z
  .object({
    name: shortText(80).min(1, "Введите название группы"),
    color: z.enum(["blue", "violet", "teal", "amber"]).default("blue"),
    limitCount: positiveInteger,
    periodHours: positiveInteger.max(8760, "Не более 8760 часов"),
    requestKey,
  })
  .strict();

export const draftFields = {
  name: shortText(120).min(1, "Введите название рассылки"),
  groupId: uuid,
  subject: shortText(240)
    .refine((value) => !/[\r\n]/.test(value), "Тема должна быть одной строкой")
    .default(""),
  body: z.string().max(50000, "Не более 50 000 символов").default(""),
  senderName: shortText(100)
    .refine((value) => !/[\r\n]/.test(value), "Имя должно быть одной строкой")
    .default(""),
};
export const createDraftSchema = z
  .object({ ...draftFields, requestKey })
  .strict();
export const updateDraftSchema = z
  .object({ ...draftFields, revision: positiveInteger })
  .strict();
export const idSchema = uuid;
export const bigIdSchema = z
  .string()
  .regex(/^\d{1,18}$/, "Некорректный идентификатор");

const optionalGroup = z
  .union([uuid, z.literal(""), z.literal("all")])
  .optional()
  .transform((value) => (value === "" || value === "all" ? undefined : value));

const pageFields = {
  page: z.coerce.number().int().min(1).max(1000000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  q: shortText(100).default(""),
};

export const accountStatuses = [
  "all",
  "problem",
  "active",
  "quota_exhausted",
  "temporary_error",
  "auth_error",
  "needs_check",
  "blocked",
  "disabled",
  "unverified",
] as const;

export const listSchema = z
  .object({
    ...pageFields,
    groupId: optionalGroup,
    status: z
      .enum([
        ...accountStatuses,
        "draft",
        "running",
        "paused",
        "stopped",
        "completed",
        "completed_with_errors",
      ])
      .default("all"),
  })
  .strict();
export type ListInput = z.infer<typeof listSchema>;

export const taskListSchema = z
  .object({
    ...pageFields,
    status: z
      .enum([
        "all",
        "pending",
        "reserved",
        "sending",
        "accepted",
        "failed",
        "unclear",
        "cancelled",
        "excluded",
        "closed_unconfirmed",
      ])
      .default("all"),
  })
  .strict();
export type TaskListInput = z.infer<typeof taskListSchema>;

export const eventListSchema = z
  .object({
    ...pageFields,
    kind: z
      .string()
      .trim()
      .regex(/^[a-z_]{1,40}$/, "Некорректный вид события")
      .default("all"),
    level: z.enum(["all", "info", "warning", "error"]).default("all"),
    campaignId: optionalGroup,
    accountId: optionalGroup,
  })
  .strict();
export type EventListInput = z.infer<typeof eventListSchema>;

export const overviewSchema = z
  .object({ since: z.string().datetime({ offset: true }).optional() })
  .strict();

export const settingsSchema = z
  .object({
    senderKind: z.enum(["test", "mail"]).optional(),
    retryMaxAttempts: z
      .number()
      .int()
      .min(0, "Минимум 0")
      .max(20, "Не более 20")
      .optional(),
    retryBaseMinutes: z
      .number()
      .int()
      .min(1, "Минимум 1")
      .max(1440, "Не более 1440")
      .optional(),
    retryMaxMinutes: z
      .number()
      .int()
      .min(1, "Минимум 1")
      .max(10080, "Не более 10080")
      .optional(),
    testSenderDelayMs: z.number().int().min(0).max(60000).optional(),
  })
  .strict();

export const importPreviewSchema = z
  .object({ text: importText, format: importFormat })
  .strict();

export const accountImportSchema = z
  .object({
    text: importText,
    format: importFormat,
    groupId: uuid,
    limitCount: positiveInteger,
    periodHours: positiveInteger.max(8760, "Не более 8760 часов"),
    duplicateAction: z.enum(["keep", "move"]).default("keep"),
    requestKey,
  })
  .strict();

export const templateSchema = z
  .object({ format: importFormat.default("csv") })
  .strict();

const selection = {
  ids: z.array(uuid).max(10000).optional(),
  filter: z
    .object({
      q: shortText(100).default(""),
      groupId: optionalGroup,
      status: z.enum(accountStatuses).default("all"),
    })
    .strict()
    .optional(),
  requestKey,
};
export const bulkAccountSchema = z
  .discriminatedUnion("action", [
    z
      .object({
        action: z.literal("set_limit"),
        limitCount: positiveInteger,
        periodHours: positiveInteger.max(8760),
        ...selection,
      })
      .strict(),
    z
      .object({ action: z.literal("move"), groupId: uuid, ...selection })
      .strict(),
    z.object({ action: z.literal("disable"), ...selection }).strict(),
    z.object({ action: z.literal("enable"), ...selection }).strict(),
    z.object({ action: z.literal("check"), ...selection }).strict(),
  ])
  .refine(
    (value) => (value.ids && value.ids.length > 0) !== Boolean(value.filter),
    {
      message: "Укажите либо выбранные аккаунты, либо фильтр",
    }
  );
export type BulkAccountInput = z.infer<typeof bulkAccountSchema>;

export const requestKeySchema = z.object({ requestKey }).strict();
export const recipientsSchema = z
  .object({ text: importText, format: importFormat, requestKey })
  .strict();
export const testSendSchema = z
  .object({
    recipient: shortText(254).min(3, "Укажите адрес получателя"),
    requestKey,
  })
  .strict();
export const resolveTaskSchema = z
  .object({ decision: z.enum(["accepted", "failed", "closed"]), requestKey })
  .strict();

export function searchPattern(query: string) {
  return `%${query.replace(/[\\%_]/g, "\\$&")}%`;
}
