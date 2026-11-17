// GraphQL v4: POST /api/graphql. A small executor for the documents the suite
// sends (fixed set, §4.1 of the spec): a subset parser (operations, aliases,
// variables, inline enums/objects/lists, inline fragments) plus resolvers
// over the same store as REST/MCP. Unknown fields answer HTTP 200 with an
// `errors` entry naming the field; unknown repositories answer
// `data.repository: null` with no errors; a JSON array body is answered with
// an array of envelopes in order.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  OWNER_LOGIN,
  authorized,
  badJson,
  nowIso,
  parseJsonBody,
  pathOf,
  readBody,
  sendJson,
  unauthorized,
} from './util.ts';
import {
  diffFlat,
  doMerge,
  mergeBase,
  mergeWouldConflict,
  treeFlatAt,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

/* ------------------------------------------------------------------ */
/* Global ids: opaque base64, stable across reads.                     */
/* ------------------------------------------------------------------ */

function gid(...parts: Array<string | number>): string {
  return Buffer.from(parts.join(':'), 'utf8').toString('base64');
}

function ungid(id: string): string[] | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    return parts.length >= 2 ? parts : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Document parsing (subset).                                          */
/* ------------------------------------------------------------------ */

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: Record<string, ValueNode>;
  selections?: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition: string;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface OperationNode {
  type: 'query' | 'mutation';
  name?: string;
  selections: SelectionNode[];
}

interface Token {
  type: 'name' | 'int' | 'float' | 'string' | 'punct';
  value: string;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1] as string;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'u') {
            out += String.fromCharCode(Number.parseInt(src.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
        } else {
          out += src[j] as string;
          j += 1;
        }
      }
      tokens.push({ type: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      let isFloat = false;
      if (src[j] === '.' && /[0-9]/.test(src[j + 1] as string)) {
        isFloat = true;
        j += 1;
        while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      }
      tokens.push({ type: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j] as string)) j += 1;
      tokens.push({ type: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if ('{}():$![]=...'.includes(ch)) {
      if (ch === '.' && src.slice(i, i + 3) === '...') {
        tokens.push({ type: 'punct', value: '...' });
        i += 3;
        continue;
      }
      tokens.push({ type: 'punct', value: ch });
      i += 1;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  next(): Token {
    const tok = this.tokens[this.pos];
    if (tok === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return tok;
  }

  expectPunct(value: string): void {
    const tok = this.next();
    if (tok.type !== 'punct' || tok.value !== value) throw new Error(`expected ${value}, got ${tok.value}`);
  }

  expectName(value?: string): string {
    const tok = this.next();
    if (tok.type !== 'name') throw new Error(`expected a name, got ${tok.value}`);
    if (value !== undefined && tok.value !== value) throw new Error(`expected ${value}, got ${tok.value}`);
    return tok.value;
  }

  parseDocument(): OperationNode[] {
    const ops: OperationNode[] = [];
    while (this.peek() !== undefined) {
      ops.push(this.parseOperation());
    }
    return ops;
  }

  parseOperation(): OperationNode {
    const tok = this.next();
    let type: 'query' | 'mutation' = 'query';
    let name: string | undefined;
    if (tok.type === 'punct' && tok.value === '{') {
      this.pos -= 1;
    } else if (tok.type === 'name' && (tok.value === 'query' || tok.value === 'mutation')) {
      type = tok.value;
      const next = this.peek();
      if (next !== undefined && next.type === 'name') name = this.next().value;
    } else {
      throw new Error(`unexpected operation start ${tok.value}`);
    }
    // Variable definitions: ($x: Type!, ...) — record nothing; values come from `variables`.
    if (this.peek()?.type === 'punct' && this.peek()?.value === '(') {
      this.next();
      let depth = 1;
      while (depth > 0) {
        const t = this.next();
        if (t.type === 'punct' && t.value === '(') depth += 1;
        else if (t.type === 'punct' && t.value === ')') depth -= 1;
      }
    }
    const selections = this.parseSelectionSet();
    return { type, name, selections };
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const out: SelectionNode[] = [];
    while (!(this.peek()?.type === 'punct' && this.peek()?.value === '}')) {
      out.push(this.parseSelection());
    }
    this.expectPunct('}');
    return out;
  }

  parseSelection(): SelectionNode {
    const tok = this.peek();
    if (tok?.type === 'punct' && tok.value === '...') {
      this.next();
      this.expectName('on');
      const typeCondition = this.expectName();
      const selections = this.parseSelectionSet();
      return { kind: 'fragment', typeCondition, selections };
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.peek()?.type === 'punct' && this.peek()?.value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: Record<string, ValueNode> = {};
    if (this.peek()?.type === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.type === 'punct' && this.peek()?.value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
      this.expectPunct(')');
    }
    let selections: SelectionNode[] | undefined;
    if (this.peek()?.type === 'punct' && this.peek()?.value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  parseValue(): ValueNode {
    const tok = this.next();
    if (tok.type === 'punct' && tok.value === '$') return { kind: 'variable', name: this.expectName() };
    if (tok.type === 'int') return { kind: 'int', value: Number.parseInt(tok.value, 10) };
    if (tok.type === 'float') return { kind: 'float', value: Number.parseFloat(tok.value) };
    if (tok.type === 'string') return { kind: 'string', value: tok.value };
    if (tok.type === 'punct' && tok.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.type === 'punct' && this.peek()?.value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (tok.type === 'punct' && tok.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek()?.type === 'punct' && this.peek()?.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (tok.type === 'name') {
      if (tok.value === 'true') return { kind: 'boolean', value: true };
      if (tok.value === 'false') return { kind: 'boolean', value: false };
      if (tok.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: tok.value };
    }
    throw new Error(`unexpected value token ${tok.value}`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Schema: known fields and their return types.                        */
/* ------------------------------------------------------------------ */

const FIELD_TYPES: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  Repository: {
    owner: 'User',
    defaultBranchRef: 'Ref',
    issue: 'Issue',
    issues: 'IssueConnection',
    pullRequests: 'PullRequestConnection',
    pullRequest: 'PullRequest',
  },
  IssueConnection: { nodes: '[Issue]', pageInfo: 'PageInfo' },
  PullRequestConnection: { nodes: '[PullRequest]', pageInfo: 'PageInfo' },
  PullRequest: { files: 'PullRequestChangedFileConnection' },
  PullRequestChangedFileConnection: { nodes: '[PullRequestChangedFile]' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge' },
  IssueCommentEdge: { node: 'IssueComment' },
  __Type: { fields: '[__Field]', enumValues: '[__EnumValue]' },
};

const KNOWN_FIELDS: Record<string, Set<string>> = {
  Query: new Set(['viewer', 'repository', 'node', '__type', '__typename']),
  Mutation: new Set(['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', '__typename']),
  User: new Set(['login', 'id', '__typename']),
  Repository: new Set([
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate',
    'url', 'createdAt', 'updatedAt', '__typename',
  ]),
  Ref: new Set(['name', '__typename']),
  Issue: new Set(['id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'closedAt', '__typename']),
  IssueConnection: new Set(['nodes', 'pageInfo', 'totalCount', '__typename']),
  PullRequestConnection: new Set(['nodes', 'pageInfo', 'totalCount', '__typename']),
  PullRequest: new Set([
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'headRef', 'baseRef', 'files', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'mergeCommitSha',
    'author', 'url', '__typename',
  ]),
  PullRequestChangedFileConnection: new Set(['nodes', 'pageInfo', 'totalCount', '__typename']),
  PullRequestChangedFile: new Set(['path', '__typename']),
  PageInfo: new Set(['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor', '__typename']),
  IssueComment: new Set(['id', 'body', '__typename']),
  IssueCommentEdge: new Set(['node', 'cursor', '__typename']),
  CreateIssuePayload: new Set(['issue', 'clientMutationId', '__typename']),
  CloseIssuePayload: new Set(['issue', 'clientMutationId', '__typename']),
  CreatePullRequestPayload: new Set(['pullRequest', 'clientMutationId', '__typename']),
  MergePullRequestPayload: new Set(['pullRequest', 'clientMutationId', '__typename']),
  AddCommentPayload: new Set(['commentEdge', 'clientMutationId', '__typename']),
  __Type: new Set(['name', 'kind', 'fields', 'enumValues', '__typename']),
  __Field: new Set(['name', '__typename']),
  __EnumValue: new Set(['name', '__typename']),
  Node: new Set(['id', '__typename']),
};

/* ------------------------------------------------------------------ */
/* Introspection data.                                                 */
/* ------------------------------------------------------------------ */

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'headRef', 'baseRef', 'files', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'mergeCommitSha', 'author', 'url',
  ],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate',
    'url', 'createdAt', 'updatedAt',
  ],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['COMMIT', 'ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

/* ------------------------------------------------------------------ */
/* Resolvers.                                                          */
/* ------------------------------------------------------------------ */

interface GqlCtx {
  store: Store;
}

type GqlValue = Record<string, unknown>;

function gqlRepo(repo: Repo): GqlValue {
  return {
    __typename: 'Repository',
    id: gid('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${OWNER_LOGIN}/${repo.name}`,
    owner: { __typename: 'User', login: OWNER_LOGIN },
    defaultBranchRef: { __typename: 'Ref', name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    isPrivate: repo.private,
    url: `/api/v3/repos/${OWNER_LOGIN}/${repo.name}`,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
    _repo: repo,
  };
}

function gqlIssue(repo: Repo, issue: Issue): GqlValue {
  return {
    __typename: 'Issue',
    id: gid('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    url: `/api/v3/repos/${OWNER_LOGIN}/${repo.name}/issues/${issue.number}`,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    closedAt: issue.closed_at,
    _repo: repo,
    _issue: issue,
  };
}

function gqlPull(ctx: GqlCtx, repo: Repo, pull: Pull): GqlValue {
  let state = 'OPEN';
  if (pull.state === 'closed') state = pull.merged ? 'MERGED' : 'CLOSED';
  let mergeable = 'UNKNOWN';
  if (pull.state === 'open') {
    const headSha = ctx.store.branchSha(repo, pull.headRef);
    const baseSha = ctx.store.branchSha(repo, pull.baseRef);
    if (headSha !== null && baseSha !== null) {
      mergeable = mergeWouldConflict(ctx.store, repo, headSha, baseSha) ? 'CONFLICTING' : 'MERGEABLE';
    }
  }
  return {
    __typename: 'PullRequest',
    id: gid('PullRequest', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body ?? '',
    state,
    merged: pull.merged,
    mergeable,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    createdAt: pull.created_at,
    updatedAt: pull.updated_at,
    closedAt: pull.closed_at,
    mergedAt: pull.merged_at,
    mergeCommitSha: pull.mergeCommitSha,
    _repo: repo,
    _pull: pull,
  };
}

function findRepoById(ctx: GqlCtx, id: number): Repo | undefined {
  return ctx.store.listRepos().find((r) => r.id === id);
}

function repoFromGlobalId(ctx: GqlCtx, globalId: string): Repo | undefined {
  const parts = ungid(globalId);
  if (parts === null || parts[0] !== 'Repository') return undefined;
  const id = Number(parts[1]);
  if (!Number.isInteger(id)) return undefined;
  return findRepoById(ctx, id);
}

function issueFromGlobalId(ctx: GqlCtx, globalId: string): { repo: Repo; issue: Issue } | undefined {
  const parts = ungid(globalId);
  if (parts === null || parts[0] !== 'Issue') return undefined;
  const repo = findRepoById(ctx, Number(parts[1]));
  const issue = repo?.issues.get(Number(parts[2]));
  if (repo === undefined || issue === undefined) return undefined;
  return { repo, issue };
}

function pullFromGlobalId(ctx: GqlCtx, globalId: string): { repo: Repo; pull: Pull } | undefined {
  const parts = ungid(globalId);
  if (parts === null || parts[0] !== 'PullRequest') return undefined;
  const repo = findRepoById(ctx, Number(parts[1]));
  const pull = repo?.pulls.get(Number(parts[2]));
  if (repo === undefined || pull === undefined) return undefined;
  return { repo, pull };
}

function cursorFor(number: number): string {
  return Buffer.from(`issue-cursor:${number}`, 'utf8').toString('base64');
}

function cursorNumber(cursor: string | null | undefined): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^issue-cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

type Resolver = (ctx: GqlCtx, parent: GqlValue, args: Record<string, unknown>) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => ({ __typename: 'User', login: OWNER_LOGIN }),
    repository: (ctx, _parent, args) => {
      const owner = args.owner as string;
      const name = args.name as string;
      if (owner !== OWNER_LOGIN) return null;
      const repo = ctx.store.getRepo(name);
      return repo === undefined ? null : gqlRepo(repo);
    },
    node: (ctx, _parent, args) => {
      const id = args.id as string;
      if (typeof id !== 'string') return null;
      const parts = ungid(id);
      if (parts === null) return null;
      if (parts[0] === 'Repository') {
        const repo = findRepoById(ctx, Number(parts[1]));
        return repo === undefined ? null : gqlRepo(repo);
      }
      if (parts[0] === 'Issue') {
        const found = issueFromGlobalId(ctx, id);
        return found === undefined ? null : gqlIssue(found.repo, found.issue);
      }
      if (parts[0] === 'PullRequest') {
        const found = pullFromGlobalId(ctx, id);
        return found === undefined ? null : gqlPull(ctx, found.repo, found.pull);
      }
      return null;
    },
    __type: (_ctx, _parent, args) => {
      const name = args.name as string;
      const fields = TYPE_FIELDS[name] ?? [];
      const enumValues = TYPE_ENUM_VALUES[name] ?? [];
      return {
        __typename: '__Type',
        name,
        kind: fields.length > 0 ? 'OBJECT' : enumValues.length > 0 ? 'ENUM' : 'OBJECT',
        fields: fields.map((f) => ({ __typename: '__Field', name: f })),
        enumValues: enumValues.map((v) => ({ __typename: '__EnumValue', name: v })),
      };
    },
  },
  Repository: {
    issue: (_ctx, parent, args) => {
      const repo = parent._repo as Repo;
      const issue = repo.issues.get(Number(args.number));
      return issue === undefined ? null : gqlIssue(repo, issue);
    },
    issues: (_ctx, parent, args) => {
      const repo = parent._repo as Repo;
      let issues = [...repo.issues.values()];
      const states = args.states as string[] | undefined;
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((s) => String(s).toLowerCase()));
        issues = issues.filter((i) => wanted.has(i.state));
      }
      const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
      const direction = orderBy?.direction === 'ASC' ? 1 : -1;
      issues.sort((a, b) => (a.number - b.number) * direction);
      const first = typeof args.first === 'number' ? args.first : 30;
      const afterNumber = cursorNumber(args.after as string | null | undefined);
      let start = 0;
      if (afterNumber !== null) {
        const idx = issues.findIndex((i) => i.number === afterNumber);
        start = idx === -1 ? issues.length : idx + 1;
      }
      const page = issues.slice(start, start + first);
      const hasNextPage = start + first < issues.length;
      const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]?.number as number) : null;
      return {
        __typename: 'IssueConnection',
        nodes: page.map((i) => gqlIssue(repo, i)),
        pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor, hasPreviousPage: start > 0, startCursor: page.length > 0 ? cursorFor(page[0]?.number as number) : null },
        totalCount: issues.length,
      };
    },
    pullRequests: (ctx, parent, args) => {
      const repo = parent._repo as Repo;
      const first = typeof args.first === 'number' ? args.first : 30;
      const pulls = [...repo.pulls.values()]
        .filter((p) => p.state === 'open')
        .sort((a, b) => b.number - a.number)
        .slice(0, first);
      return {
        __typename: 'PullRequestConnection',
        nodes: pulls.map((p) => gqlPull(ctx, repo, p)),
        pageInfo: { __typename: 'PageInfo', hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null },
        totalCount: pulls.length,
      };
    },
    pullRequest: (ctx, parent, args) => {
      const repo = parent._repo as Repo;
      const pull = repo.pulls.get(Number(args.number));
      return pull === undefined ? null : gqlPull(ctx, repo, pull);
    },
  },
  PullRequest: {
    files: (ctx, parent, args) => {
      const repo = parent._repo as Repo;
      const pull = parent._pull as Pull;
      const first = typeof args.first === 'number' ? args.first : 30;
      const headSha = ctx.store.branchSha(repo, pull.headRef);
      const baseSha = ctx.store.branchSha(repo, pull.baseRef);
      let paths: string[] = [];
      if (headSha !== null && baseSha !== null) {
        const mb = mergeBase(ctx.store, repo, headSha, baseSha);
        const baseFlat = mb === null ? new Map() : treeFlatAt(ctx.store, repo, mb);
        const headFlat = treeFlatAt(ctx.store, repo, headSha);
        paths = diffFlat(ctx.store, repo, baseFlat, headFlat).map((c) => c.path);
      }
      return {
        __typename: 'PullRequestChangedFileConnection',
        nodes: paths.slice(0, first).map((p) => ({ __typename: 'PullRequestChangedFile', path: p })),
        pageInfo: { __typename: 'PageInfo', hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null },
        totalCount: paths.length,
      };
    },
  },
  Mutation: {
    createIssue: (ctx, _parent, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = typeof input.repositoryId === 'string' ? repoFromGlobalId(ctx, input.repositoryId) : undefined;
      if (repo === undefined) throw new Error(`repository not found: ${String(input.repositoryId)}`);
      const title = typeof input.title === 'string' ? input.title : '';
      if (title === '') throw new Error('title is required');
      const t = nowIso();
      const issue: Issue = {
        id: ctx.store.nextIssueId++,
        number: repo.nextNumber++,
        title,
        body: typeof input.body === 'string' ? input.body : null,
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
      return { __typename: 'CreateIssuePayload', issue: gqlIssue(repo, issue) };
    },
    closeIssue: (ctx, _parent, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = typeof input.issueId === 'string' ? issueFromGlobalId(ctx, input.issueId) : undefined;
      if (found === undefined) throw new Error(`issue not found: ${String(input.issueId)}`);
      const { repo, issue } = found;
      issue.state = 'closed';
      issue.closed_at = nowIso();
      issue.updated_at = nowIso();
      return { __typename: 'CloseIssuePayload', issue: gqlIssue(repo, issue) };
    },
    createPullRequest: (ctx, _parent, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = typeof input.repositoryId === 'string' ? repoFromGlobalId(ctx, input.repositoryId) : undefined;
      if (repo === undefined) throw new Error(`repository not found: ${String(input.repositoryId)}`);
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch;
      const title = typeof input.title === 'string' ? input.title : '';
      const headSha = ctx.store.branchSha(repo, head);
      const baseSha = ctx.store.branchSha(repo, base);
      if (headSha === null || baseSha === null) throw new Error('head or base branch does not exist');
      const t = nowIso();
      const pull: Pull = {
        id: ctx.store.nextPullId++,
        number: repo.nextNumber++,
        title,
        body: typeof input.body === 'string' ? input.body : null,
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
      return { __typename: 'CreatePullRequestPayload', pullRequest: gqlPull(ctx, repo, pull) };
    },
    mergePullRequest: (ctx, _parent, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = typeof input.pullRequestId === 'string' ? pullFromGlobalId(ctx, input.pullRequestId) : undefined;
      if (found === undefined) throw new Error(`pull request not found: ${String(input.pullRequestId)}`);
      const { repo, pull } = found;
      if (pull.state !== 'open') throw new Error(`pull request #${pull.number} is already closed`);
      const method = input.mergeMethod === 'MERGE' ? 'merge' : 'squash';
      const merged = doMerge(ctx.store, repo, pull, method);
      if (!merged.ok) throw new Error(merged.reason);
      return { __typename: 'MergePullRequestPayload', pullRequest: gqlPull(ctx, repo, pull) };
    },
    addComment: (ctx, _parent, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = typeof input.subjectId === 'string' ? issueFromGlobalId(ctx, input.subjectId) : undefined;
      if (found === undefined) throw new Error(`subject not found: ${String(input.subjectId)}`);
      const { repo, issue } = found;
      const body = typeof input.body === 'string' ? input.body : '';
      if (body === '') throw new Error('body is required');
      const t = nowIso();
      const comment = {
        id: repo.nextCommentId++,
        body,
        user: { login: OWNER_LOGIN, id: 1000, type: 'User' },
        created_at: t,
        updated_at: t,
      };
      issue.comments.push(comment);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'IssueCommentEdge',
          node: { __typename: 'IssueComment', id: gid('IssueComment', repo.id, issue.number, comment.id), body },
          cursor: cursorFor(issue.number),
        },
      };
    },
  },
};

/* ------------------------------------------------------------------ */
/* Execution.                                                          */
/* ------------------------------------------------------------------ */

interface GqlError {
  message: string;
  path?: Array<string | number>;
}

function executeSelection(
  ctx: GqlCtx,
  parentType: string,
  parent: GqlValue,
  selections: SelectionNode[],
  variables: Record<string, unknown>,
  errors: GqlError[],
  path: Array<string | number>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      const actual = (parent.__typename as string | undefined) ?? parentType;
      if (actual === selection.typeCondition) {
        const sub = executeSelection(ctx, selection.typeCondition, parent, selection.selections, variables, errors, path);
        Object.assign(out, sub);
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    const fieldPath = [...path, key];
    if (selection.name === '__typename') {
      out[key] = (parent.__typename as string | undefined) ?? parentType;
      continue;
    }
    const known = KNOWN_FIELDS[parentType];
    if (known !== undefined && !known.has(selection.name)) {
      errors.push({ message: `Cannot query field "${selection.name}" on type "${parentType}".`, path: fieldPath });
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [name, node] of Object.entries(selection.args)) args[name] = resolveValue(node, variables);
    let value: unknown;
    const resolver = RESOLVERS[parentType]?.[selection.name];
    try {
      value = resolver !== undefined ? resolver(ctx, parent, args) : parent[selection.name];
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : 'Internal error', path: fieldPath });
      out[key] = null;
      continue;
    }
    if (value === undefined) value = null;
    if (selection.selections !== undefined) {
      if (value === null) {
        out[key] = null;
      } else if (Array.isArray(value)) {
        const elemType = (FIELD_TYPES[parentType]?.[selection.name] ?? '').replace(/^\[(.*)\]$/, '$1');
        out[key] = value.map((item, index) =>
          item !== null && typeof item === 'object'
            ? executeSelection(ctx, elemType, item as GqlValue, selection.selections as SelectionNode[], variables, errors, [...fieldPath, index])
            : item,
        );
      } else if (typeof value === 'object') {
        const subType = FIELD_TYPES[parentType]?.[selection.name] ?? parentType;
        out[key] = executeSelection(ctx, subType, value as GqlValue, selection.selections, variables, errors, fieldPath);
      } else {
        out[key] = value;
      }
    } else {
      out[key] = typeof value === 'object' && value !== null ? stripTypename(value as GqlValue) : value;
    }
  }
  return out;
}

function stripTypename(value: GqlValue): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === '__typename' || k.startsWith('_')) continue;
    out[k] = v;
  }
  return out;
}

function executeOperation(
  ctx: GqlCtx,
  op: OperationNode,
  variables: Record<string, unknown>,
): { data: Record<string, unknown> | null; errors: GqlError[] } {
  const errors: GqlError[] = [];
  const rootType = op.type === 'mutation' ? 'Mutation' : 'Query';
  const root: GqlValue = { __typename: rootType };
  const data = executeSelection(ctx, rootType, root, op.selections, variables, errors, []);
  return { data, errors };
}

function executeDocument(
  ctx: GqlCtx,
  query: string,
  variables: Record<string, unknown>,
  operationName?: string,
): { data: Record<string, unknown> | null; errors: GqlError[] } {
  let ops: OperationNode[];
  try {
    ops = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax error' }] };
  }
  const op = operationName !== undefined ? ops.find((o) => o.name === operationName) : ops[0];
  if (op === undefined) {
    return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
  }
  return executeOperation(ctx, op, variables);
}

/* ------------------------------------------------------------------ */
/* HTTP handler.                                                       */
/* ------------------------------------------------------------------ */

export async function handleGraphql(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  const path = pathOf(req);
  if (path !== '/api/graphql') return false;
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  if (!authorized(req)) {
    unauthorized(res);
    return true;
  }
  const buf = await readBody(req);
  const parsed = parseJsonBody(buf);
  if (!parsed.ok) {
    badJson(res);
    return true;
  }
  const ctx: GqlCtx = { store };
  const runOne = (body: unknown): Record<string, unknown> => {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { data: null, errors: [{ message: 'Request body must be a GraphQL operation object.' }] };
    }
    const obj = body as Record<string, unknown>;
    const query = typeof obj.query === 'string' ? obj.query : '';
    const variables = (obj.variables ?? {}) as Record<string, unknown>;
    const operationName = typeof obj.operationName === 'string' ? obj.operationName : undefined;
    if (query === '') {
      return { data: null, errors: [{ message: 'Must provide a query.' }] };
    }
    const { data, errors } = executeDocument(ctx, query, variables, operationName);
    return errors.length > 0 ? { data, errors } : { data };
  };
  if (Array.isArray(parsed.value)) {
    sendJson(res, 200, parsed.value.map(runOne));
  } else {
    sendJson(res, 200, runOne(parsed.value));
  }
  return true;
}
