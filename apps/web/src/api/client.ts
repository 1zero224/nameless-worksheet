import type { ErrorBody, ErrorCode } from '@nw/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}

let getConnectionIdFn: () => string | null = () => null;
let onUnauthenticatedFn: () => void = () => {};

export function configureApiClient(opts: {
  getConnectionId: () => string | null;
  onUnauthenticated: () => void;
}): void {
  getConnectionIdFn = opts.getConnectionId;
  onUnauthenticatedFn = opts.onUnauthenticated;
}

export async function apiFetch<T>(
  path: string,
  opts: {
    method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
    body?: unknown;
    skipAuthRedirect?: boolean;
  } = {},
): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = {};

  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const connId = getConnectionIdFn();
  if (connId) {
    headers['X-Connection-Id'] = connId;
  }

  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  if (res.status === 204) {
    return undefined as T;
  }

  let data: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const errBody = data as Partial<ErrorBody> | null;
    const code: ErrorCode = errBody?.error?.code ?? 'INTERNAL';
    const message = errBody?.error?.message ?? '请求失败，请稍后再试';
    const fields = errBody?.error?.fields;

    if (res.status === 401 && code === 'UNAUTHENTICATED' && !opts.skipAuthRedirect) {
      onUnauthenticatedFn();
    }

    throw new ApiError(res.status, code, message, fields);
  }

  return data as T;
}
