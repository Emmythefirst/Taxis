const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:8787";

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(path: string, options: RequestInit & { userId?: string } = {}): Promise<T> {
  const { userId, headers, ...rest } = options;
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...rest,
    headers: {
      "Content-Type": "application/json",
      ...(userId ? { "x-user-id": userId } : {}),
      ...headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, (body as { error?: string }).error ?? `Request failed: ${res.status}`);
  }
  return body as T;
}

export const api = {
  get: <T>(path: string, userId?: string) => request<T>(path, { method: "GET", userId }),
  post: <T>(path: string, body?: unknown, userId?: string) =>
    request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined, userId }),
};

export interface SyncUserResult {
  userId: string;
  walletId: string | null;
  walletAddress: string | null;
  linked: boolean;
}

/**
 * Links a logged-in user's embedded wallet server-side (backend/src/http/
 * routes/users.ts). Must be called once per login, after Privy confirms
 * the user's embedded wallet exists — see providers/AppProviders.tsx's
 * useLogin onComplete callback. Everything execution-side (obligations,
 * checkout) depends on this having already run.
 */
export function syncUser(userId: string): Promise<SyncUserResult> {
  return api.post<SyncUserResult>("/users/sync", { userId });
}
