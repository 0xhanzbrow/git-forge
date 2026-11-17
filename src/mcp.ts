// MCP over Streamable HTTP: POST /mcp, JSON-RPC 2.0, plain-JSON replies.
// Modern era (revision 2026-07-28) via server/discover; initialize is also
// answered so a legacy-era client can fall back. Tools act on the same store
// as REST, so every effect is visible over /api/v3.
//
// Wire notes from the suite (mcp-client.ts / spec §5):
// - parse the body first: a non-JSON body is HTTP 400 + JSON-RPC -32700.
// - auth is decided per request, before tool lookup: no token is HTTP 401.
// - unknown tool is -32601; missing required arguments are -32602.
// - tools/list must be byte-identical across calls: the tool list is a constant.
// - responses echo the request id exactly (string or number).

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  OWNER_LOGIN,
  authorized,
  nextRequestId,
  nowIso,
  parseJsonBody,
  pathOf,
  readBody,
  sendJson,
} from './util.ts';
import { doMerge, type Issue, type Pull, type Store } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

const SERVER_NAME = 'git-forge';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };
}

/** The tool list: a module constant, so two tools/list calls are byte-identical. */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository to create.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        body: { type: 'string', description: 'The body of the pull request.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'integer', description: 'The number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** A JSON-RPC error thrown by a handler; answered with its code, never HTTP 500. */
class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

type JsonObject = Record<string, unknown>;

/** First present, non-empty value among the synonym keys. */
function arg(args: JsonObject, names: readonly string[]): unknown {
  for (const name of names) {
    const value = args[name];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function reqString(args: JsonObject, names: readonly string[], label: string): string {
  const value = arg(args, names);
  if (typeof value !== 'string' || value === '') throw new RpcError(-32602, `Missing required argument: ${label}`);
  return value;
}

function reqNumber(args: JsonObject, names: readonly string[], label: string): number {
  const value = arg(args, names);
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isInteger(n) || n < 1) throw new RpcError(-32602, `Missing required argument: ${label}`);
  return n;
}

function textResult(value: unknown, structured?: JsonObject): JsonObject {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    structuredContent: structured ?? (value as JsonObject),
    isError: false,
  };
}

function errorResult(message: string): JsonObject {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

interface McpCtx {
  req: IncomingMessage;
  store: Store;
}

function requireRepo(ctx: McpCtx, owner: string, name: string) {
  if (owner !== OWNER_LOGIN) throw new RpcError(-32602, `Repository ${owner}/${name} not found`);
  const repo = ctx.store.getRepo(name);
  if (repo === undefined) throw new RpcError(-32602, `Repository ${owner}/${name} not found`);
  return repo;
}

function callCreateRepo(ctx: McpCtx, args: JsonObject): JsonObject {
  const name = reqString(args, ['name', 'repo', 'repository', 'repository_name', 'repo_name'], 'name');
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.length > 100) {
    return errorResult(`Invalid repository name: ${name}`);
  }
  if (ctx.store.getRepo(name) !== undefined) return errorResult(`Repository ${name} already exists`);
  const description = arg(args, ['description', 'about', 'summary', 'body']);
  const isPrivate = arg(args, ['private', 'is_private']) === true;
  const repo = ctx.store.createRepo(
    name,
    typeof description === 'string' ? description : null,
    isPrivate,
    'main',
  );
  const json = repoJson(ctx.req, repo);
  return textResult(json);
}

function callGetRepo(ctx: McpCtx, args: JsonObject): JsonObject {
  const owner = reqString(args, ['owner', 'owner_login', 'org', 'user', 'login'], 'owner');
  const repoName = reqString(args, ['repo', 'repository', 'repository_name', 'repo_name'], 'repo');
  const repo = ctx.store.getRepo(repoName);
  if (owner !== OWNER_LOGIN || repo === undefined) return errorResult(`Repository ${owner}/${repoName} not found`);
  return textResult(repoJson(ctx.req, repo));
}

function callCreateIssue(ctx: McpCtx, args: JsonObject): JsonObject {
  const owner = reqString(args, ['owner', 'owner_login', 'org', 'user', 'login'], 'owner');
  const repoName = reqString(args, ['repo', 'repository', 'repository_name', 'repo_name'], 'repo');
  const title = reqString(args, ['title', 'issue_title', 'subject'], 'title');
  const repo = requireRepo(ctx, owner, repoName);
  const body = arg(args, ['body', 'issue_body', 'description', 'content', 'text']);
  const t = nowIso();
  const issue: Issue = {
    id: ctx.store.nextIssueId++,
    number: repo.nextNumber++,
    title,
    body: typeof body === 'string' ? body : null,
    state: 'open',
    labels: [],
    assignees: [],
    user: { login: OWNER_LOGIN, id: 1000, type: 'User' },
    created_at: t,
    updated_at: t,
    closed_at: null,
    comments: [],
  };
  repo.issues.set(issue.number, issue);
  return textResult(issueJson(ctx.req, repo, issue));
}

function callListIssues(ctx: McpCtx, args: JsonObject): JsonObject {
  const owner = reqString(args, ['owner', 'owner_login', 'org', 'user', 'login'], 'owner');
  const repoName = reqString(args, ['repo', 'repository', 'repository_name', 'repo_name'], 'repo');
  const repo = requireRepo(ctx, owner, repoName);
  const state = arg(args, ['state', 'status']);
  let issues = [...repo.issues.values()];
  if (state === 'open' || state === 'closed') issues = issues.filter((i) => i.state === state);
  issues.sort((a, b) => b.number - a.number);
  const json = issues.map((issue) => issueJson(ctx.req, repo, issue));
  return textResult(json, { issues: json });
}

function callCreatePullRequest(ctx: McpCtx, args: JsonObject): JsonObject {
  const owner = reqString(args, ['owner', 'owner_login', 'org', 'user', 'login'], 'owner');
  const repoName = reqString(args, ['repo', 'repository', 'repository_name', 'repo_name'], 'repo');
  const title = reqString(args, ['title', 'pr_title', 'pull_request_title', 'subject'], 'title');
  const head = reqString(args, ['head', 'head_ref', 'head_branch', 'source', 'source_branch', 'from_branch'], 'head');
  const base = reqString(args, ['base', 'base_ref', 'base_branch', 'target', 'target_branch', 'into_branch'], 'base');
  const repo = requireRepo(ctx, owner, repoName);
  const headSha = ctx.store.branchSha(repo, head);
  const baseSha = ctx.store.branchSha(repo, base);
  if (headSha === null || baseSha === null) {
    return errorResult(`Head or base branch does not exist: ${head} / ${base}`);
  }
  if (head === base) return errorResult('Head and base must differ');
  const body = arg(args, ['body', 'description', 'content', 'text']);
  const t = nowIso();
  const pull: Pull = {
    id: ctx.store.nextPullId++,
    number: repo.nextNumber++,
    title,
    body: typeof body === 'string' ? body : null,
    state: 'open',
    merged: false,
    mergeable: null,
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    mergeCommitSha: null,
    user: { login: OWNER_LOGIN, id: 1000, type: 'User' },
    created_at: t,
    updated_at: t,
    closed_at: null,
    merged_at: null,
  };
  repo.pulls.set(pull.number, pull);
  return textResult(pullJson(ctx.req, ctx.store, repo, pull));
}

function callMergePullRequest(ctx: McpCtx, args: JsonObject): JsonObject {
  const owner = reqString(args, ['owner', 'owner_login', 'org', 'user', 'login'], 'owner');
  const repoName = reqString(args, ['repo', 'repository', 'repository_name', 'repo_name'], 'repo');
  const number = reqNumber(
    args,
    ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index'],
    'pull_number',
  );
  const repo = requireRepo(ctx, owner, repoName);
  const pull = repo.pulls.get(number);
  if (pull === undefined) return errorResult(`Pull request #${number} not found`);
  if (pull.state !== 'open') return errorResult(`Pull request #${number} is already closed`);
  const merged = doMerge(ctx.store, repo, pull, 'squash');
  if (!merged.ok) return errorResult(merged.reason);
  const json = { sha: merged.sha, merged: true, number, message: 'Pull request successfully merged' };
  return textResult(json);
}

const TOOL_HANDLERS: Record<string, (ctx: McpCtx, args: JsonObject) => JsonObject> = {
  create_repo: callCreateRepo,
  get_repo: callGetRepo,
  create_issue: callCreateIssue,
  list_issues: callListIssues,
  create_pull_request: callCreatePullRequest,
  merge_pull_request: callMergePullRequest,
};

function serverInfo(): JsonObject {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

function rpcResult(res: ServerResponse, id: unknown, result: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(res: ServerResponse, status: number, id: unknown, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

/** Handle POST /mcp (and DELETE /mcp on client close). True when the path was /mcp. */
export async function handleMcp(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  const path = pathOf(req);
  if (path !== '/mcp') return false;
  const method = req.method ?? 'GET';

  if (method === 'DELETE') {
    res.writeHead(200, { 'x-github-request-id': nextRequestId() });
    res.end();
    return true;
  }
  if (method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }

  // Parse first: a non-JSON body is HTTP 400 + -32700, even before auth.
  const buf = await readBody(req);
  const parsed = parseJsonBody(buf);
  if (!parsed.ok) {
    rpcError(res, 400, null, -32700, 'Parse error');
    return true;
  }
  const value = parsed.value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    rpcError(res, 200, null, -32600, 'Invalid Request');
    return true;
  }
  const body = value as JsonObject;
  const id = body.id;
  const rpcMethod = typeof body.method === 'string' ? body.method : '';

  // Notifications (no id) get no JSON-RPC reply; auth still applies.
  const isNotification = id === undefined;

  // Auth is decided per request, before tool lookup.
  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return true;
  }

  if (isNotification) {
    // notifications/initialized and friends: acknowledge with an empty 202.
    res.writeHead(202, { 'x-github-request-id': nextRequestId() });
    res.end();
    return true;
  }

  const params = (body.params ?? {}) as JsonObject;

  try {
    if (rpcMethod === 'server/discover') {
      const info = serverInfo();
      rpcResult(res, id, {
        supportedVersions: [PROTOCOL_VERSION],
        serverInfo: info,
        capabilities: { tools: {} },
        instructions: 'A GitHub-compatible git forge: repositories, issues, pull requests and git smart HTTP.',
        _meta: { serverInfo: info },
      });
      return true;
    }
    if (rpcMethod === 'initialize') {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
      rpcResult(res, id, {
        protocolVersion: offered,
        capabilities: { tools: {} },
        serverInfo: serverInfo(),
      });
      return true;
    }
    if (rpcMethod === 'ping') {
      rpcResult(res, id, {});
      return true;
    }
    if (rpcMethod === 'tools/list') {
      rpcResult(res, id, { tools: TOOLS });
      return true;
    }
    if (rpcMethod === 'tools/call') {
      const name = typeof params.name === 'string' ? params.name : '';
      const handler = TOOL_BY_NAME.has(name) ? TOOL_HANDLERS[name] : undefined;
      if (handler === undefined) {
        rpcError(res, 200, id, -32601, `Unknown tool: ${name}`);
        return true;
      }
      const args = (params.arguments ?? {}) as JsonObject;
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        rpcError(res, 200, id, -32602, 'Invalid params: arguments must be an object');
        return true;
      }
      const result = handler({ req, store }, args);
      rpcResult(res, id, result);
      return true;
    }
    rpcError(res, 200, id, -32601, `Method not found: ${rpcMethod}`);
    return true;
  } catch (err) {
    if (err instanceof RpcError) {
      rpcError(res, 200, id, err.code, err.message);
      return true;
    }
    rpcError(res, 200, id, -32603, err instanceof Error ? err.message : 'Internal error');
    return true;
  }
}
