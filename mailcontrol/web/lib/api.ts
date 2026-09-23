import type {
  Account,
  Campaign,
  CampaignSummary,
  CreateDraft,
  CreateGroup,
  Event,
  Group,
  Health,
  Overview,
  Page,
  UpdateDraft,
} from "../../shared/contracts";

export class ApiRequestError extends Error {
  readonly network: boolean;
  readonly status: number | null;
  readonly code: string;
  readonly fields?: Record<string, string>;

  constructor(
    message: string,
    options: {
      network?: boolean;
      status?: number | null;
      code?: string;
      fields?: Record<string, string>;
    } = {}
  ) {
    super(message);
    this.name = "ApiRequestError";
    this.network = options.network ?? false;
    this.status = options.status ?? null;
    this.code = options.code ?? "request_failed";
    this.fields = options.fields;
  }
}

type ErrorPayload = {
  error?: {
    code?: string;
    message?: string;
    fields?: Record<string, string>;
  };
};

type RequestOptions = {
  signal?: AbortSignal;
};

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const requestController = new AbortController();
  const callerSignal = init?.signal;
  let timedOut = false;
  const timeoutId = globalThis.setTimeout(() => {
    timedOut = true;
    requestController.abort();
  }, 15_000);
  const abortFromCaller = () => requestController.abort();

  if (callerSignal) {
    if (callerSignal.aborted) {
      requestController.abort();
    } else {
      callerSignal.addEventListener("abort", abortFromCaller, { once: true });
    }
  }

  try {
    let response: Response;
    try {
      response = await fetch(path, {
        ...init,
        signal: requestController.signal,
        headers: {
          Accept: "application/json",
          ...(init?.body ? { "Content-Type": "application/json" } : {}),
          ...init?.headers,
        },
      });
    } catch {
      if (callerSignal?.aborted) {
        throw new ApiRequestError("Запрос отменён.", {
          network: true,
          code: "request_aborted",
        });
      }
      if (timedOut) {
        throw new ApiRequestError(
          "Сервер не ответил за 15 секунд. Проверьте соединение и повторите попытку.",
          { network: true, code: "request_timeout" }
        );
      }
      throw new ApiRequestError(
        "Сервер недоступен. Проверьте, что MailControl запущен, и повторите попытку.",
        { network: true, code: "network_error" }
      );
    }

    let payload: T | ErrorPayload | null = null;
    let hasJson = false;
    try {
      payload = (await response.json()) as T | ErrorPayload;
      hasJson = true;
    } catch {
      if (callerSignal?.aborted) {
        throw new ApiRequestError("Запрос отменён.", {
          network: true,
          code: "request_aborted",
        });
      }
      if (timedOut) {
        throw new ApiRequestError(
          "Сервер не ответил за 15 секунд. Проверьте соединение и повторите попытку.",
          { network: true, code: "request_timeout" }
        );
      }
      payload = null;
    }

    if (!response.ok) {
      const error = payload as ErrorPayload | null;
      throw new ApiRequestError(
        error?.error?.message ?? `Запрос не выполнен (${response.status}).`,
        {
          status: response.status,
          code: error?.error?.code ?? "request_failed",
          network: response.status === 503,
          fields: error?.error?.fields,
        }
      );
    }

    if (!hasJson || payload === null) {
      throw new ApiRequestError(
        "Сервер вернул некорректный ответ. Повторите попытку.",
        { status: response.status, code: "invalid_response" }
      );
    }

    return payload as T;
  } finally {
    globalThis.clearTimeout(timeoutId);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined) search.set(key, String(value));
  });
  const result = search.toString();
  return result ? `?${result}` : "";
}

export function createRequestKey(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }

  if (
    typeof crypto === "undefined" ||
    typeof crypto.getRandomValues !== "function"
  ) {
    throw new Error("Безопасный UUID недоступен в этом окружении.");
  }

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const api = {
  health: () => requestJson<Health>("/api/health"),

  overview: (options: RequestOptions = {}) =>
    requestJson<Overview>("/api/overview", { signal: options.signal }),

  groups: (
    params: { page?: number; pageSize?: number; q?: string } = {},
    options: RequestOptions = {}
  ) =>
    requestJson<Page<Group>>(`/api/groups${query(params)}`, {
      signal: options.signal,
    }),

  createGroup: (body: CreateGroup) =>
    requestJson<Group>("/api/groups", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  accounts: (
    params: {
      page?: number;
      pageSize?: number;
      q?: string;
      groupId?: string;
      status?: string;
    } = {},
    options: RequestOptions = {}
  ) =>
    requestJson<Page<Account>>(`/api/accounts${query(params)}`, {
      signal: options.signal,
    }),

  campaigns: (
    params: { page?: number; pageSize?: number; q?: string } = {},
    options: RequestOptions = {}
  ) =>
    requestJson<Page<CampaignSummary>>(`/api/campaigns${query(params)}`, {
      signal: options.signal,
    }),

  campaign: (id: string, options: RequestOptions = {}) =>
    requestJson<Campaign>(`/api/campaigns/${encodeURIComponent(id)}`, {
      signal: options.signal,
    }),

  createDraft: (body: CreateDraft) =>
    requestJson<Campaign>("/api/campaigns", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  updateDraft: (id: string, body: UpdateDraft) =>
    requestJson<Campaign>(`/api/campaigns/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  events: (
    params: {
      page?: number;
      pageSize?: number;
      kind?: string;
    } = {},
    options: RequestOptions = {}
  ) =>
    requestJson<Page<Event>>(`/api/events${query(params)}`, {
      signal: options.signal,
    }),
};

export function isRequestAborted(error: unknown): boolean {
  return error instanceof ApiRequestError && error.code === "request_aborted";
}

export function displayError(error: unknown): {
  message: string;
  network: boolean;
  code: string;
  fields?: Record<string, string>;
} {
  if (error instanceof ApiRequestError) {
    return {
      message: error.message,
      network: error.network,
      code: error.code,
      fields: error.fields,
    };
  }
  return {
    message: "Не удалось выполнить запрос. Повторите попытку.",
    network: false,
    code: "unknown_error",
  };
}
