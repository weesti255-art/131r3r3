import { z } from "zod";

const shortText = (limit: number) =>
  z.string().trim().max(limit, `Не более ${limit} символов`);
const positiveInteger = z
  .number()
  .int("Нужно целое число")
  .min(1, "Минимум 1")
  .max(2147483647, "Слишком большое число");
const uuid = z.string().uuid("Некорректный идентификатор");

export const groupSchema = z
  .object({
    name: shortText(80).min(1, "Введите название группы"),
    color: z.enum(["blue", "violet", "teal", "amber"]).default("blue"),
    limitCount: positiveInteger,
    periodHours: positiveInteger,
    requestKey: uuid,
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
  .object({ ...draftFields, requestKey: uuid })
  .strict();
export const updateDraftSchema = z
  .object({ ...draftFields, revision: positiveInteger })
  .strict();
export const idSchema = uuid;

const optionalGroup = z
  .union([uuid, z.literal(""), z.literal("all")])
  .optional()
  .transform((value) => (value === "" || value === "all" ? undefined : value));

export const listSchema = z
  .object({
    page: z.coerce.number().int().min(1).max(1000000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(10),
    q: shortText(100).default(""),
    groupId: optionalGroup,
    status: z
      .enum([
        "all",
        "problem",
        "active",
        "auth_error",
        "needs_check",
        "disabled",
        "unverified",
      ])
      .default("all"),
    kind: z
      .enum([
        "all",
        "group_created",
        "draft_created",
        "draft_updated",
        "demo_seeded",
      ])
      .default("all"),
  })
  .strict();

export type ListInput = z.infer<typeof listSchema>;

export function searchPattern(query: string) {
  return `%${query.replace(/[\\%_]/g, "\\$&")}%`;
}
