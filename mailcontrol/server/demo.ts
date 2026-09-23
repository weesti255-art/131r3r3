import type { PoolClient } from "pg";

const groups = [
  {
    id: `a1000000-0000-4000-8000-${String(1).padStart(12, "0")}`,
    name: "Основная группа",
    color: "blue",
    limit: 15,
    hours: 24,
  },
  {
    id: `a1000000-0000-4000-8000-${String(2).padStart(12, "0")}`,
    name: "Новые аккаунты",
    color: "violet",
    limit: 10,
    hours: 24,
  },
  {
    id: `a1000000-0000-4000-8000-${String(3).padStart(12, "0")}`,
    name: "Тестовая группа",
    color: "teal",
    limit: 5,
    hours: 12,
  },
] as const;

export async function seedDemo(client: PoolClient) {
  for (const group of groups) {
    await client.query(
      `INSERT INTO account_groups(id, request_key, name, color, limit_count, period_hours)
       VALUES ($1, $1, $2, $3, $4, $5)`,
      [group.id, group.name, group.color, group.limit, group.hours]
    );
  }
  const domains = [
    "mail.ru",
    "inbox.ru",
    "bk.ru",
    "list.ru",
    "internet.ru",
    "xmail.ru",
  ];
  const statuses = [
    "active",
    "active",
    "active",
    "auth_error",
    "active",
    "needs_check",
    "active",
    "disabled",
    "active",
    "active",
    "unverified",
    "active",
  ];
  for (let index = 0; index < 12; index++) {
    const group = groups[index < 6 ? 0 : index < 10 ? 1 : 2];
    await client.query(
      `INSERT INTO accounts(id, email, group_id, health_status, limit_count, period_hours, is_demo)
       VALUES ($1, $2, $3, $4, $5, $6, true)`,
      [
        `b1000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        `demo.sender${String(index + 1).padStart(2, "0")}@${domains[index % domains.length]}`,
        group.id,
        statuses[index],
        group.limit,
        group.hours,
      ]
    );
  }
  const drafts = [
    {
      name: "Знакомство с MailControl",
      subject: "Рады знакомству!",
      body: "Здравствуйте!\n\nСпасибо, что присоединились к нашему проекту. Здесь будет ваше обращение к получателям.\n\nЭто демонстрационный черновик. В M1 письма не отправляются.",
      group: 0,
      senderName: "Команда проекта",
    },
    {
      name: "Новости для подписчиков",
      subject: "Немного новостей от нашей команды",
      body: "Здравствуйте!\n\nВ этом письме мы расскажем о последних обновлениях. Текст можно заменить своим и сохранить — черновик останется в базе данных.",
      group: 1,
      senderName: "Наша команда",
    },
    {
      name: "Первое тестовое обращение",
      subject: "Проверка оформления письма",
      body: "Здравствуйте!\n\nЭто пример обычного текстового письма. Пока можно проверить интерфейс и сохранение. Настоящая отправка появится на отдельном этапе.",
      group: 2,
      senderName: "",
    },
  ];
  for (const [index, draft] of drafts.entries()) {
    const id = `c1000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    await client.query(
      `INSERT INTO campaigns(id, request_key, group_id, name, subject, body, sender_name,
                             created_at, updated_at)
       VALUES ($1, $1, $2, $3, $4, $5, $6, now() - ($7 * interval '1 hour'), now() - ($7 * interval '1 hour'))`,
      [
        id,
        groups[draft.group].id,
        draft.name,
        draft.subject,
        draft.body,
        draft.senderName,
        index + 1,
      ]
    );
    await client.query(
      `INSERT INTO events(kind, title, detail, entity_type, entity_id, created_at)
       VALUES ('draft_created', 'Добавлен демонстрационный черновик', $1, 'campaign', $2,
               now() - ($3 * interval '1 hour'))`,
      [draft.name, id, index + 1]
    );
  }
  await client.query(
    `INSERT INTO events(kind, title, detail, entity_type)
     VALUES ('demo_seeded', 'Демонстрационный режим готов',
             '3 группы, 12 примеров аккаунтов и 3 черновика. Подключения к Mail нет.', 'system')`
  );
}
