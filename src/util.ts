// Shared HTTP helpers for the forge: JSON replies, auth, pagination, deterministic time.
// Everything the suite sees must be deterministic across two runs of the same trial:
// no wall clock, no Math.random — ids and timestamps come from counters seeded at a
// fixed base (MAKEFUN_TRIAL_NOW when the trial sets it, else a fixed constant).

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

/** The login the bearer token names: the suite's seeded viewer (wire.ts
 *  buildScenario, fixed SCENARIO_SEED 0x6a09e667f3bcc909n). Verified by running
 *  buildScenario() from the kit: viewer id 1000, login "adaiversen". */
export const OWNER_LOGIN = 'adaiversen';
export const OWNER_ID = 1000;
export const OWNER_NAME = 'ada iversen';
export const OWNER_EMAIL = 'adaiversen@example.invalid';
/** The scenario's other users, for owner-mismatch (404, never 403) checks. */
export const STRANGER_LOGIN = 'olgabauer';
export const TEAMMATE_LOGIN = 'quinnkeller';

/** Base time for every timestamp the forge emits. The trial sets MAKEFUN_TRIAL_NOW;
 *  locally the runner does not, so a fixed constant keeps local runs deterministic too. */
const BASE_MS = Date.parse(process.env.MAKEFUN_TRIAL_NOW ?? '2026-11-14T06:30:00.000Z');

let tick = 0;
/** Next deterministic timestamp: base + 1s per mutation, ISO 8601. */
export function nowIso(): string {
  tick += 1;
  return new Date(BASE_MS + tick * 1000).toISOString();
}
/** Current deterministic timestamp without advancing the clock (reads only). */
export function nowIsoRead(): string {
  return new Date(BASE_MS + tick * 1000).toISOString();
}

let reqSeq = 0;
/** Deterministic X-GitHub-Request-Id: non-empty, unique per request, stable across runs. */
export function nextRequestId(): string {
  reqSeq += 1;
  return `req-${reqSeq.toString(16).padStart(8, '0')}`;
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

export function sendRaw(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(body);
}

export function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

export function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Bad credentials' });
}

export function badJson(res: ServerResponse): void {
  sendJson(res, 400, { message: 'Problems parsing JSON' });
}

/** The path of a request URL, or '/' when it does not parse (never throws). */
export function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

export function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Read the whole request body as a Buffer. Rejects on stream error. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Parse a JSON body. Returns { ok: true, value } or { ok: false } when the body is
 * present but not valid JSON (the suite expects HTTP 400 for that). An empty body
 * parses as undefined with ok: true.
 */
export function parseJsonBody(
  buf: Buffer,
): { ok: true; value: unknown } | { ok: false } {
  if (buf.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(buf.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

/** The bearer token this request presents, or null. */
export function bearerToken(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer\s+(.+)$/.exec(h);
  return m ? m[1] : null;
}

/** The token the trial configured for this process (MAKEFUN_SHOP_TOKEN). */
export const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** True when the request carries the trial's token. /healthz is exempt by the caller. */
export function authorized(req: IncomingMessage): boolean {
  const tok = bearerToken(req);
  if (tok === null) return false;
  if (SHOP_TOKEN === '') return true; // local dev without a configured token: accept any
  return tok === SHOP_TOKEN;
}

export interface PageParams {
  page: number;
  perPage: number;
}

/** GitHub pagination: ?page=N&per_page=M, defaults page 1, per_page 30, capped at 100. */
export function pageParams(q: URLSearchParams): PageParams {
  const page = Math.max(1, Number.parseInt(q.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(q.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

/** Slice a list to one page and build the Link header (rel="next" only when more). */
export function paginate<T>(
  items: readonly T[],
  p: PageParams,
  basePath: string,
  extraQuery: string,
): { page: T[]; link: string | null } {
  const start = (p.page - 1) * p.perPage;
  const page = items.slice(start, start + p.perPage);
  let link: string | null = null;
  if (start + p.perPage < items.length) {
    const q = extraQuery ? `${extraQuery}&` : '';
    link = `<${basePath}?${q}page=${p.page + 1}&per_page=${p.perPage}>; rel="next"`;
  }
  return { page, link };
}

/** Link header value for a paginated response, or undefined when there is no next page. */
export function linkHeader(link: string | null): Record<string, string> {
  return link === null ? {} : { link };
}
