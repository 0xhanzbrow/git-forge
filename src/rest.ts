// GitHub REST v3 surface: /api/v3 — repositories, branches, commits, contents,
// labels, issues (+comments) and pull requests (+files, squash merge).
//
// The contract is the one the suite's checks-rest.ts asserts: exact statuses,
// JSON shapes, pagination Link headers, 401 without a token, 404 (never 403)
// for another owner's name, 409 on a stale contents sha, 422 on an unknown
// label or a duplicate repository name, and application/json on every reply.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  OWNER_EMAIL,
  OWNER_ID,
  OWNER_LOGIN,
  OWNER_NAME,
  authorized,
  badJson,
  nextRequestId,
  notFound,
  nowIso,
  nowIsoRead,
  pageParams,
  parseJsonBody,
  pathOf,
  queryOf,
  readBody,
  sendJson,
  unauthorized,
} from './util.ts';
import {
  buildTreeFromFlat,
  createCommit,
  diffFlat,
  doMerge,
  flattenTree,
  getCommitInfo,
  isAncestor,
  mergeBase,
  mergeWouldConflict,
  parseTree,
  resolveRef,
  treeFlatAt,
  walkCommits,
  type FileChange,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// -------------------------------------------------------------------------------------------
// Serializers: the GitHub shapes the checks read back.
// -------------------------------------------------------------------------------------------

function repoUrl(req: IncomingMessage, repo: Repo): string {
  return `${baseOf(req)}/api/v3/repos/${OWNER_LOGIN}/${repo.name}`;
}

export function baseOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

function userJson(): Record<string, unknown> {
  return {
    login: OWNER_LOGIN,
    id: OWNER_ID,
    node_id: `MDQ6VXNlcjEwMDA=`,
    avatar_url: `https://avatars.githubusercontent.com/u/${OWNER_ID}?v=4`,
    gravatar_id: '',
    url: `/api/v3/users/${OWNER_LOGIN}`,
    html_url: `https://github.com/${OWNER_LOGIN}`,
    type: 'User',
    site_admin: false,
    name: OWNER_NAME,
    email: OWNER_EMAIL,
  };
}

export function repoJson(req: IncomingMessage, repo: Repo): Record<string, unknown> {
  const url = repoUrl(req, repo);
  return {
    id: repo.id,
    node_id: `MDEwOlJlcG9zaXRvcnk${repo.id}`,
    name: repo.name,
    full_name: `${OWNER_LOGIN}/${repo.name}`,
    private: repo.private,
    owner: userJson(),
    html_url: `https://github.com/${OWNER_LOGIN}/${repo.name}`,
    description: repo.description,
    fork: false,
    url,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    git_url: `git://github.com/${OWNER_LOGIN}/${repo.name}.git`,
    ssh_url: `git@github.com:${OWNER_LOGIN}/${repo.name}.git`,
    clone_url: `https://github.com/${OWNER_LOGIN}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return {
    id: label?.id ?? 0,
    node_id: `MDU6TGFiZWw${label?.id ?? 0}`,
    url: `/api/v3/repos/${OWNER_LOGIN}/${repo.name}/labels/${encodeURIComponent(name)}`,
    name,
    color: label?.color ?? 'ededed',
    default: label !== undefined && ['bug', 'documentation', 'duplicate', 'enhancement', 'good first issue', 'help wanted', 'invalid', 'question', 'wontfix'].includes(name),
    description: label?.description ?? '',
  };
}

export function issueJson(req: IncomingMessage, repo: Repo, issue: Issue): Record<string, unknown> {
  const url = `${repoUrl(req, repo)}/issues/${issue.number}`;
  return {
    id: issue.id,
    node_id: `MDU6SXNzdWU${issue.id}`,
    url,
    repository_url: repoUrl(req, repo),
    labels_url: `${url}/labels{/name}`,
    comments_url: `${url}/comments`,
    events_url: `${url}/events`,
    html_url: `https://github.com/${OWNER_LOGIN}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body ?? '',
    user: userJson(),
    labels: issue.labels.map((name) => labelJson(repo, name)),
    assignees: issue.assignees,
    locked: false,
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    author_association: 'OWNER',
    state_reason: issue.state === 'closed' ? 'completed' : null,
  };
}

function commentJson(req: IncomingMessage, repo: Repo, issue: Issue, comment: Issue['comments'][number]): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `MDEyOklzc3VlQ29tbWVudA${comment.id}`,
    url: `${repoUrl(req, repo)}/issues/comments/${comment.id}`,
    html_url: `https://github.com/${OWNER_LOGIN}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userJson(),
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    author_association: 'OWNER',
  };
}

function commitJson(req: IncomingMessage, store: Store, repo: Repo, sha: string): Record<string, unknown> | null {
  const info = getCommitInfo(store, repo, sha);
  if (info === undefined) return null;
  const date = new Date(info.committerTime * 1000).toISOString();
  const authorDate = new Date(info.authorTime * 1000).toISOString();
  return {
    sha,
    node_id: `MDY6Q29tbWl0${sha}`,
    commit: {
      author: { name: info.authorName, email: info.authorEmail, date: authorDate },
      committer: { name: info.committerName, email: info.committerEmail, date },
      message: info.message,
      tree: { sha: info.tree, url: `/api/v3/repos/${OWNER_LOGIN}/${repo.name}/git/trees/${info.tree}` },
      url: `/api/v3/repos/${OWNER_LOGIN}/${repo.name}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `/api/v3/repos/${OWNER_LOGIN}/${repo.name}/commits/${sha}`,
    html_url: `https://github.com/${OWNER_LOGIN}/${repo.name}/commit/${sha}`,
    comments_url: `/api/v3/repos/${OWNER_LOGIN}/${repo.name}/commits/${sha}/comments`,
    author: userJson(),
    committer: userJson(),
    parents: info.parents.map((p) => ({ sha: p, url: `/api/v3/repos/${OWNER_LOGIN}/${repo.name}/commits/${p}`, html_url: `https://github.com/${OWNER_LOGIN}/${repo.name}/commit/${p}` })),
  };
}

/** Live head/base shas: GitHub's pull head.sha/base.sha follow the branch tips. */
function pullTipShas(store: Store, repo: Repo, pull: Pull): { headSha: string | null; baseSha: string | null } {
  return {
    headSha: store.branchSha(repo, pull.headRef),
    baseSha: store.branchSha(repo, pull.baseRef),
  };
}

export function pullJson(req: IncomingMessage, store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const { headSha, baseSha } = pullTipShas(store, repo, pull);
  const url = `${repoUrl(req, repo)}/pulls/${pull.number}`;
  let mergeable: boolean | null = null;
  if (pull.state === 'open' && headSha !== null && baseSha !== null) {
    mergeable = !mergeWouldConflict(store, repo, headSha, baseSha);
  } else if (pull.state === 'open') {
    mergeable = true;
  }
  return {
    id: pull.id,
    node_id: `MDExOlB1bGxSZXF1ZXN0${pull.id}`,
    url,
    html_url: `https://github.com/${OWNER_LOGIN}/${repo.name}/pull/${pull.number}`,
    diff_url: `${url}.diff`,
    patch_url: `${url}.patch`,
    issue_url: `${repoUrl(req, repo)}/issues/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body ?? '',
    user: userJson(),
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.closed_at,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable,
    mergeable_state: pull.state === 'open' ? (mergeable === true ? 'clean' : 'dirty') : 'unknown',
    merged_by: pull.merged ? userJson() : null,
    head: {
      label: `${OWNER_LOGIN}:${pull.headRef}`,
      ref: pull.headRef,
      sha: headSha ?? pull.headSha ?? '',
      user: userJson(),
      repo: repoJson(req, repo),
    },
    base: {
      label: `${OWNER_LOGIN}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: baseSha ?? pull.baseSha ?? '',
      user: userJson(),
      repo: repoJson(req, repo),
    },
    author_association: 'OWNER',
    draft: false,
  };
}

function contentFileJson(
  req: IncomingMessage,
  repo: Repo,
  path: string,
  blobSha: string,
  content: Buffer,
): Record<string, unknown> {
  const name = path.split('/').pop() ?? path;
  const base = `${baseOf(req)}/api/v3/repos/${OWNER_LOGIN}/${repo.name}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
  return {
    type: 'file',
    encoding: 'base64',
    size: content.length,
    name,
    path,
    content: content.toString('base64'),
    sha: blobSha,
    url: base,
    html_url: `https://github.com/${OWNER_LOGIN}/${repo.name}/blob/HEAD/${path}`,
    git_url: `${baseOf(req)}/api/v3/repos/${OWNER_LOGIN}/${repo.name}/git/blobs/${blobSha}`,
    download_url: `https://raw.githubusercontent.com/${OWNER_LOGIN}/${repo.name}/HEAD/${path}`,
    _links: { git: `${baseOf(req)}/api/v3/repos/${OWNER_LOGIN}/${repo.name}/git/blobs/${blobSha}`, self: base, html: `https://github.com/${OWNER_LOGIN}/${repo.name}/blob/HEAD/${path}` },
  };
}

// -------------------------------------------------------------------------------------------
// Routing helpers.
// -------------------------------------------------------------------------------------------

type Handler = (ctx: Ctx, ...args: string[]) => void | Promise<void>;

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  store: Store;
  /** Parsed JSON body (undefined when no body was sent). */
  body: unknown;
  query: URLSearchParams;
}

function decodeSeg(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Look a repository up under the token's owner; 404 (never 403) otherwise. */
function requireRepo(ctx: Ctx, owner: string, name: string): Repo | null {
  if (owner !== OWNER_LOGIN) {
    notFound(ctx.res);
    return null;
  }
  const repo = ctx.store.getRepo(name);
  if (repo === undefined) {
    notFound(ctx.res);
    return null;
  }
  return repo;
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { 'x-github-request-id': nextRequestId() });
  res.end();
}

/** Paginate a list; emits an absolute Link rel="next" when more pages remain. */
function sendPage<T>(
  ctx: Ctx,
  items: readonly T[],
  serialize: (item: T) => unknown,
  extraQuery = '',
): void {
  const p = pageParams(ctx.query);
  const start = (p.page - 1) * p.perPage;
  const page = items.slice(start, start + p.perPage);
  const headers: Record<string, string> = {};
  if (start + p.perPage < items.length) {
    const path = pathOf(ctx.req);
    const q = extraQuery ? `${extraQuery}&` : '';
    headers.link = `<${baseOf(ctx.req)}${path}?${q}page=${p.page + 1}&per_page=${p.perPage}>; rel="next"`;
  }
  sendJson(ctx.res, 200, page.map(serialize), headers);
}

function err(ctx: Ctx, status: number, message: string): void {
  sendJson(ctx.res, status, { message });
}

/** Resolve the tip commit for a ref query (?ref= / branch / sha); null + 404 sent. */
function resolveTip(ctx: Ctx, repo: Repo, refParam: string | null): string | null {
  const ref = refParam ?? repo.defaultBranch;
  const sha = resolveRef(ctx.store, repo, ref);
  if (sha === null) {
    notFound(ctx.res);
    return null;
  }
  return sha;
}

/** The tree sha of a directory path inside a commit ('' = root). */
function dirTreeSha(ctx: Ctx, repo: Repo, commitSha: string, dirPath: string): string | null {
  const info = getCommitInfo(ctx.store, repo, commitSha);
  if (info === undefined) return null;
  let treeSha = info.tree;
  if (dirPath === '') return treeSha;
  for (const seg of dirPath.split('/')) {
    const treeObj = ctx.store.getObject(repo, treeSha);
    if (treeObj === undefined || treeObj.type !== 'tree') return null;
    const entry = parseTree(treeObj.data).find((e) => e.name === seg && e.mode === '40000');
    if (entry === undefined) return null;
    treeSha = entry.sha;
  }
  return treeSha;
}

/** Commit a new tree on a branch (or the first commit of an unborn repo). */
function commitTree(
  ctx: Ctx,
  repo: Repo,
  branch: string,
  flat: Map<string, { mode: string; sha: string }>,
  message: string,
): { commitSha: string; treeSha: string } {
  const treeSha = buildTreeFromFlat(ctx.store, repo, flat);
  const tip = ctx.store.branchSha(repo, branch);
  const time = Math.floor(Date.parse(nowIso()) / 1000);
  const commitSha = createCommit(ctx.store, repo, {
    tree: treeSha,
    parents: tip === null ? [] : [tip],
    message,
    time,
  });
  ctx.store.setBranch(repo, branch, commitSha);
  return { commitSha, treeSha };
}

// -------------------------------------------------------------------------------------------
// Handlers.
// -------------------------------------------------------------------------------------------

function handleRoot(ctx: Ctx): void {
  sendJson(
    ctx.res,
    200,
    {
      current_user_url: `${baseOf(ctx.req)}/api/v3/user`,
      current_user_authorizations_html_url: 'https://github.com/settings/applications',
      authorizations_url: `${baseOf(ctx.req)}/api/v3/authorizations`,
      code_search_url: `${baseOf(ctx.req)}/api/v3/search/code?q={query}{&page,per_page,sort,order}`,
      commit_search_url: `${baseOf(ctx.req)}/api/v3/search/commits?q={query}{&page,per_page,sort,order}`,
      emails_url: `${baseOf(ctx.req)}/api/v3/user/emails`,
      emojis_url: `${baseOf(ctx.req)}/api/v3/emojis`,
      events_url: `${baseOf(ctx.req)}/api/v3/events`,
      feeds_url: `${baseOf(ctx.req)}/api/v3/feeds`,
      followers_url: `${baseOf(ctx.req)}/api/v3/user/followers`,
      following_url: `${baseOf(ctx.req)}/api/v3/user/following{/target}`,
      gists_url: `${baseOf(ctx.req)}/api/v3/gists{/gist_id}`,
      hub_url: `${baseOf(ctx.req)}/api/v3/hub`,
      issue_search_url: `${baseOf(ctx.req)}/api/v3/search/issues?q={query}{&page,per_page,sort,order}`,
      issues_url: `${baseOf(ctx.req)}/api/v3/issues`,
      keys_url: `${baseOf(ctx.req)}/api/v3/user/keys`,
      label_search_url: `${baseOf(ctx.req)}/api/v3/search/labels?q={query}{&page,per_page,sort,order}`,
      notifications_url: `${baseOf(ctx.req)}/api/v3/notifications`,
      organization_url: `${baseOf(ctx.req)}/api/v3/orgs/{org}`,
      organization_repositories_url: `${baseOf(ctx.req)}/api/v3/orgs/{org}/repos{?type,page,per_page,sort}`,
      organization_teams_url: `${baseOf(ctx.req)}/api/v3/orgs/{org}/teams`,
      public_gists_url: `${baseOf(ctx.req)}/api/v3/gists/public`,
      rate_limit_url: `${baseOf(ctx.req)}/api/v3/rate_limit`,
      repository_url: `${baseOf(ctx.req)}/api/v3/repos/{owner}/{repo}`,
      repository_search_url: `${baseOf(ctx.req)}/api/v3/search/repositories?q={query}{&page,per_page,sort,order}`,
      current_user_repositories_url: `${baseOf(ctx.req)}/api/v3/user/repos{?type,page,per_page,sort}`,
      starred_url: `${baseOf(ctx.req)}/api/v3/user/starred{/owner}{/repo}`,
      starred_gists_url: `${baseOf(ctx.req)}/api/v3/gists/starred`,
      topic_search_url: `${baseOf(ctx.req)}/api/v3/search/topics?q={query}{&page,per_page,sort,order}`,
      user_url: `${baseOf(ctx.req)}/api/v3/users/{user}`,
      user_organizations_url: `${baseOf(ctx.req)}/api/v3/user/orgs`,
      user_repositories_url: `${baseOf(ctx.req)}/api/v3/users/{user}/repos{?type,page,per_page,sort}`,
      user_search_url: `${baseOf(ctx.req)}/api/v3/search/users?q={query}{&page,per_page,sort,order}`,
    },
    { 'x-oauth-scopes': 'repo, read:org' },
  );
}

function handleMeta(ctx: Ctx): void {
  sendJson(ctx.res, 200, {
    verifiable_password_authentication: true,
    installed_version: '1.0.0',
    github_services_sha: '0000000000000000000000000000000000000000',
  });
}

function handleUser(ctx: Ctx): void {
  sendJson(ctx.res, 200, {
    ...userJson(),
    html_url: `https://github.com/${OWNER_LOGIN}`,
    followers_url: `${baseOf(ctx.req)}/api/v3/users/${OWNER_LOGIN}/followers`,
    following_url: `${baseOf(ctx.req)}/api/v3/users/${OWNER_LOGIN}/following{/other_user}`,
    gists_url: `${baseOf(ctx.req)}/api/v3/users/${OWNER_LOGIN}/gists{/gist_id}`,
    starred_url: `${baseOf(ctx.req)}/api/v3/users/${OWNER_LOGIN}/starred{/owner}{/repo}`,
    subscriptions_url: `${baseOf(ctx.req)}/api/v3/users/${OWNER_LOGIN}/subscriptions`,
    organizations_url: `${baseOf(ctx.req)}/api/v3/users/${OWNER_LOGIN}/orgs`,
    repos_url: `${baseOf(ctx.req)}/api/v3/users/${OWNER_LOGIN}/repos`,
    events_url: `${baseOf(ctx.req)}/api/v3/users/${OWNER_LOGIN}/events{/privacy}`,
    received_events_url: `${baseOf(ctx.req)}/api/v3/users/${OWNER_LOGIN}/received_events`,
    followers: 0,
    following: 0,
    created_at: '2026-11-14T06:30:00Z',
    updated_at: nowIsoRead(),
    public_repos: ctx.store.listRepos().length,
    public_gists: 0,
    hireable: null,
    bio: null,
    blog: '',
    company: null,
    location: null,
    site_admin: false,
  });
}

function createRepo(ctx: Ctx): void {
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name === '' || name.length > 100 || /[/\\]/.test(name)) {
    err(ctx, 422, 'Validation Failed: name is invalid');
    return;
  }
  if (ctx.store.getRepo(name) !== undefined) {
    err(ctx, 422, 'Repository creation failed: name already exists on this account');
    return;
  }
  const isPrivate = body.private === true;
  const description = typeof body.description === 'string' ? body.description : null;
  const defaultBranch =
    typeof body.default_branch === 'string' && body.default_branch !== '' ? body.default_branch : 'main';
  const repo = ctx.store.createRepo(name, description, isPrivate, defaultBranch);
  sendJson(ctx.res, 201, repoJson(ctx.req, repo));
}

function listUserRepos(ctx: Ctx): void {
  sendPage(ctx, ctx.store.listRepos(), (repo) => repoJson(ctx.req, repo));
}

function getRepo(ctx: Ctx, owner: string, name: string): void {
  const repo = requireRepo(ctx, owner, name);
  if (repo === null) return;
  sendJson(ctx.res, 200, repoJson(ctx.req, repo));
}

function patchRepo(ctx: Ctx, owner: string, name: string): void {
  const repo = requireRepo(ctx, owner, name);
  if (repo === null) return;
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  if (typeof body.description === 'string' || body.description === null) repo.description = body.description;
  if (body.private === true || body.private === false) repo.private = body.private;
  ctx.store.touch(repo);
  sendJson(ctx.res, 200, repoJson(ctx.req, repo));
}

function deleteRepo(ctx: Ctx, owner: string, name: string): void {
  const repo = requireRepo(ctx, owner, name);
  if (repo === null) return;
  ctx.store.deleteRepo(repo.name);
  sendNoContent(ctx.res);
}

function createRef(ctx: Ctx, owner: string, name: string): void {
  const repo = requireRepo(ctx, owner, name);
  if (repo === null) return;
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  const ref = typeof body.ref === 'string' ? body.ref : '';
  const sha = typeof body.sha === 'string' ? body.sha : '';
  if (!ref.startsWith('refs/heads/') || ref.length <= 'refs/heads/'.length) {
    err(ctx, 422, 'Validation Failed: ref must name a branch under refs/heads/');
    return;
  }
  const branch = ref.slice('refs/heads/'.length);
  const obj = ctx.store.getObject(repo, sha);
  if (obj === undefined || obj.type !== 'commit') {
    err(ctx, 422, 'Validation Failed: sha does not name a commit');
    return;
  }
  if (repo.refs.has(ref)) {
    err(ctx, 422, 'Validation Failed: ref already exists');
    return;
  }
  ctx.store.setRef(repo, ref, sha);
  ctx.store.touch(repo);
  sendJson(ctx.res, 201, {
    ref,
    node_id: `MDM6UmVm${sha}`,
    url: `${repoUrl(ctx.req, repo)}/git/${ref}`,
    object: { sha, type: 'commit', url: `${repoUrl(ctx.req, repo)}/git/commits/${sha}` },
  });
}

function getRefHead(ctx: Ctx, owner: string, name: string, branch: string): void {
  const repo = requireRepo(ctx, owner, name);
  if (repo === null) return;
  const sha = ctx.store.branchSha(repo, branch);
  if (sha === null) {
    notFound(ctx.res);
    return;
  }
  sendJson(ctx.res, 200, {
    ref: `refs/heads/${branch}`,
    node_id: `MDM6UmVm${sha}`,
    url: `${repoUrl(ctx.req, repo)}/git/refs/heads/${branch}`,
    object: { sha, type: 'commit', url: `${repoUrl(ctx.req, repo)}/git/commits/${sha}` },
  });
}

function listBranches(ctx: Ctx, owner: string, name: string): void {
  const repo = requireRepo(ctx, owner, name);
  if (repo === null) return;
  const branches: Array<{ name: string; sha: string }> = [];
  for (const [ref, sha] of repo.refs) {
    if (ref.startsWith('refs/heads/')) branches.push({ name: ref.slice('refs/heads/'.length), sha });
  }
  branches.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  sendJson(
    ctx.res,
    200,
    branches.map((b) => ({
      name: b.name,
      commit: { sha: b.sha, url: `${repoUrl(ctx.req, repo)}/commits/${b.sha}` },
      protected: false,
    })),
  );
}

function listCommits(ctx: Ctx, owner: string, name: string): void {
  const repo = requireRepo(ctx, owner, name);
  if (repo === null) return;
  const tip = resolveTip(ctx, repo, ctx.query.get('sha'));
  if (tip === null) return;
  const shas = walkCommits(ctx.store, repo, tip, 1000);
  const out: unknown[] = [];
  for (const sha of shas) {
    const json = commitJson(ctx.req, ctx.store, repo, sha);
    if (json !== null) out.push(json);
  }
  sendJson(ctx.res, 200, out);
}

function putContents(ctx: Ctx, owner: string, name: string, filePath: string): void {
  const repo = requireRepo(ctx, owner, name);
  if (repo === null) return;
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  const message = typeof body.message === 'string' ? body.message : `Update ${filePath}`;
  const contentB64 = typeof body.content === 'string' ? body.content : '';
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
  const content = Buffer.from(contentB64, 'base64');
  const tip = ctx.store.branchSha(repo, branch);
  if (tip === null && repo.refs.size > 0) {
    err(ctx, 404, 'Branch not found');
    return;
  }
  const flat = tip === null ? new Map<string, { mode: string; sha: string }>() : treeFlatAt(ctx.store, repo, tip);
  const existing = flat.get(filePath);
  if (existing !== undefined) {
    if (givenSha === undefined) {
      err(ctx, 422, 'Validation Failed: sha is required to update a file');
      return;
    }
    if (givenSha.toLowerCase() !== existing.sha.toLowerCase()) {
      err(ctx, 409, 'Conflict: sha does not match the current file');
      return;
    }
    const blobSha = ctx.store.putObject(repo, 'blob', content);
    flat.set(filePath, { mode: existing.mode, sha: blobSha });
    const { commitSha } = commitTree(ctx, repo, branch, flat, message);
    sendJson(ctx.res, 200, {
      content: contentFileJson(ctx.req, repo, filePath, blobSha, content),
      commit: { sha: commitSha, message },
    });
    return;
  }
  if (givenSha !== undefined) {
    err(ctx, 422, 'Validation Failed: sha does not match a file that does not exist');
    return;
  }
  const blobSha = ctx.store.putObject(repo, 'blob', content);
  flat.set(filePath, { mode: '100644', sha: blobSha });
  const { commitSha } = commitTree(ctx, repo, branch, flat, message);
  sendJson(ctx.res, 201, {
    content: contentFileJson(ctx.req, repo, filePath, blobSha, content),
    commit: { sha: commitSha, message },
  });
}

function getContents(ctx: Ctx, owner: string, name: string, filePath: string): void {
  const repo = requireRepo(ctx, owner, name);
  if (repo === null) return;
  const tip = resolveTip(ctx, repo, ctx.query.get('ref'));
  if (tip === null) return;
  const flat = treeFlatAt(ctx.store, repo, tip);
  const entry = filePath === '' ? undefined : flat.get(filePath);
  if (entry !== undefined) {
    const blob = ctx.store.getObject(repo, entry.sha);
    sendJson(ctx.res, 200, contentFileJson(ctx.req, repo, filePath, entry.sha, blob?.data ?? Buffer.alloc(0)));
    return;
  }
  // A directory: immediate children of the path.
  const prefix = filePath === '' ? '' : `${filePath}/`;
  const children = new Map<string, { type: 'file' | 'dir'; sha: string; size: number }>();
  for (const [path, value] of flat) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      const blob = ctx.store.getObject(repo, value.sha);
      children.set(rest, { type: 'file', sha: value.sha, size: blob?.data.length ?? 0 });
    } else {
      const dir = rest.slice(0, slash);
      if (!children.has(dir)) {
        const sha = dirTreeSha(ctx, repo, tip, `${prefix}${dir}`) ?? '0000000000000000000000000000000000000000';
        children.set(dir, { type: 'dir', sha, size: 0 });
      }
    }
  }
  if (children.size === 0) {
    notFound(ctx.res);
    return;
  }
  const base = `${baseOf(ctx.req)}/api/v3/repos/${OWNER_LOGIN}/${repo.name}/contents`;
  const entries = [...children.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([childName, child]) => {
      const childPath = prefix === '' ? childName : `${prefix}${childName}`;
      const url = `${base}/${childPath.split('/').map(encodeURIComponent).join('/')}`;
      return {
        type: child.type,
        size: child.size,
        name: childName,
        path: childPath,
        sha: child.sha,
        url,
        html_url: `https://github.com/${OWNER_LOGIN}/${repo.name}/blob/HEAD/${childPath}`,
        git_url: `${baseOf(ctx.req)}/api/v3/repos/${OWNER_LOGIN}/${repo.name}/git/${child.type === 'dir' ? 'trees' : 'blobs'}/${child.sha}`,
        download_url: child.type === 'file' ? `https://raw.githubusercontent.com/${OWNER_LOGIN}/${repo.name}/HEAD/${childPath}` : null,
        _links: { git: `${baseOf(ctx.req)}/api/v3/repos/${OWNER_LOGIN}/${repo.name}/git/${child.type === 'dir' ? 'trees' : 'blobs'}/${child.sha}`, self: url, html: `https://github.com/${OWNER_LOGIN}/${repo.name}/blob/HEAD/${childPath}` },
      };
    });
  sendJson(ctx.res, 200, entries);
}

function deleteContents(ctx: Ctx, owner: string, name: string, filePath: string): void {
  const repo = requireRepo(ctx, owner, name);
  if (repo === null) return;
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  const message = typeof body.message === 'string' ? body.message : `Delete ${filePath}`;
  const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const tip = ctx.store.branchSha(repo, branch);
  if (tip === null) {
    notFound(ctx.res);
    return;
  }
  const flat = treeFlatAt(ctx.store, repo, tip);
  const existing = flat.get(filePath);
  if (existing === undefined) {
    notFound(ctx.res);
    return;
  }
  if (givenSha !== undefined && givenSha.toLowerCase() !== existing.sha.toLowerCase()) {
    err(ctx, 409, 'Conflict: sha does not match the current file');
    return;
  }
  flat.delete(filePath);
  const { commitSha } = commitTree(ctx, repo, branch, flat, message);
  sendJson(ctx.res, 200, { content: null, commit: { sha: commitSha, message } });
}

function createLabel(ctx: Ctx, owner: string, name: string): void {
  const repo = requireRepo(ctx, owner, name);
  if (repo === null) return;
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  const labelName = typeof body.name === 'string' ? body.name.trim() : '';
  if (labelName === '') {
    err(ctx, 422, 'Validation Failed: name is required');
    return;
  }
  const color = typeof body.color === 'string' && body.color !== '' ? body.color.replace(/^#/, '') : 'ededed';
  const description = typeof body.description === 'string' ? body.description : '';
  let label = repo.labels.get(labelName);
  if (label === undefined) {
    label = { id: repo.nextLabelId++, name: labelName, color, description };
    repo.labels.set(labelName, label);
  }
  sendJson(ctx.res, 201, labelJson(repo, labelName));
}

function listLabels(ctx: Ctx, owner: string, name: string): void {
  const repo = requireRepo(ctx, owner, name);
  if (repo === null) return;
  sendJson(ctx.res, 200, [...repo.labels.keys()].sort().map((n) => labelJson(repo, n)));
}

function createIssue(ctx: Ctx, owner: string, name: string): void {
  const repo = requireRepo(ctx, owner, name);
  if (repo === null) return;
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  const title = typeof body.title === 'string' ? body.title : '';
  if (title === '') {
    err(ctx, 422, 'Validation Failed: title is required');
    return;
  }
  const labelNames: string[] = [];
  if (Array.isArray(body.labels)) {
    for (const entry of body.labels) {
      const labelName = typeof entry === 'string' ? entry : typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>).name : undefined;
      if (typeof labelName !== 'string') continue;
      if (!repo.labels.has(labelName)) {
        err(ctx, 422, `Validation Failed: label "${labelName}" does not exist`);
        return;
      }
      labelNames.push(labelName);
    }
  }
  const t = nowIso();
  const issue: Issue = {
    id: ctx.store.nextIssueId++,
    number: repo.nextNumber++,
    title,
    body: typeof body.body === 'string' ? body.body : null,
    state: 'open',
    labels: labelNames,
    assignees: [],
    user: { login: OWNER_LOGIN, id: OWNER_ID, type: 'User' },
    created_at: t,
    updated_at: t,
    closed_at: null,
    comments: [],
  };
  repo.issues.set(issue.number, issue);
  sendJson(ctx.res, 201, issueJson(ctx.req, repo, issue));
}

function listIssues(ctx: Ctx, owner: string, name: string): void {
  const repo = requireRepo(ctx, owner, name);
  if (repo === null) return;
  const state = ctx.query.get('state') ?? 'open';
  const sort = ctx.query.get('sort') ?? 'created';
  const direction = ctx.query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state === 'open' || state === 'closed') issues = issues.filter((i) => i.state === state);
  if (sort === 'created') {
    issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  }
  sendPage(ctx, issues, (issue) => issueJson(ctx.req, repo, issue), `state=${encodeURIComponent(state)}`);
}

function getIssue(ctx: Ctx, owner: string, name: string, n: string): void {
  const repo = requireRepo(ctx, owner, name);
  if (repo === null) return;
  const issue = repo.issues.get(Number(n));
  if (issue === undefined) {
    notFound(ctx.res);
    return;
  }
  sendJson(ctx.res, 200, issueJson(ctx.req, repo, issue));
}

function patchIssue(ctx: Ctx, owner: string, name: string, n: string): void {
  const repo = requireRepo(ctx, owner, name);
  if (repo === null) return;
  const issue = repo.issues.get(Number(n));
  if (issue === undefined) {
    notFound(ctx.res);
    return;
  }
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string' || body.body === null) issue.body = body.body;
  if (body.state === 'open' || body.state === 'closed') {
    issue.state = body.state;
    issue.closed_at = body.state === 'closed' ? nowIso() : null;
  }
  if (Array.isArray(body.labels)) {
    const labelNames: string[] = [];
    for (const entry of body.labels) {
      const labelName = typeof entry === 'string' ? entry : undefined;
      if (labelName === undefined) continue;
      if (!repo.labels.has(labelName)) {
        err(ctx, 422, `Validation Failed: label "${labelName}" does not exist`);
        return;
      }
      labelNames.push(labelName);
    }
    issue.labels = labelNames;
  }
  issue.updated_at = nowIso();
  sendJson(ctx.res, 200, issueJson(ctx.req, repo, issue));
}

function createComment(ctx: Ctx, owner: string, name: string, n: string): void {
  const repo = requireRepo(ctx, owner, name);
  if (repo === null) return;
  const issue = repo.issues.get(Number(n));
  if (issue === undefined) {
    notFound(ctx.res);
    return;
  }
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  const text = typeof body.body === 'string' ? body.body : '';
  if (text === '') {
    err(ctx, 422, 'Validation Failed: body is required');
    return;
  }
  const t = nowIso();
  const comment: Issue['comments'][number] = {
    id: repo.nextCommentId++,
    body: text,
    user: { login: OWNER_LOGIN, id: OWNER_ID, type: 'User' },
    created_at: t,
    updated_at: t,
  };
  issue.comments.push(comment);
  sendJson(ctx.res, 201, commentJson(ctx.req, repo, issue, comment));
}

function listComments(ctx: Ctx, owner: string, name: string, n: string): void {
  const repo = requireRepo(ctx, owner, name);
  if (repo === null) return;
  const issue = repo.issues.get(Number(n));
  if (issue === undefined) {
    notFound(ctx.res);
    return;
  }
  sendJson(ctx.res, 200, issue.comments.map((c) => commentJson(ctx.req, repo, issue, c)));
}

function createPull(ctx: Ctx, owner: string, name: string): void {
  const repo = requireRepo(ctx, owner, name);
  if (repo === null) return;
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  const title = typeof body.title === 'string' ? body.title : '';
  const head = typeof body.head === 'string' ? body.head : '';
  const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
  if (title === '' || head === '' || base === '') {
    err(ctx, 422, 'Validation Failed: title, head and base are required');
    return;
  }
  const headSha = ctx.store.branchSha(repo, head);
  const baseSha = ctx.store.branchSha(repo, base);
  if (headSha === null || baseSha === null) {
    err(ctx, 422, 'Validation Failed: head or base branch does not exist');
    return;
  }
  if (head === base) {
    err(ctx, 422, 'Validation Failed: head and base must differ');
    return;
  }
  const t = nowIso();
  const pull: Pull = {
    id: ctx.store.nextPullId++,
    number: repo.nextNumber++,
    title,
    body: typeof body.body === 'string' ? body.body : null,
    state: 'open',
    merged: false,
    mergeable: null,
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    mergeCommitSha: null,
    user: { login: OWNER_LOGIN, id: OWNER_ID, type: 'User' },
    created_at: t,
    updated_at: t,
    closed_at: null,
    merged_at: null,
  };
  repo.pulls.set(pull.number, pull);
  sendJson(ctx.res, 201, pullJson(ctx.req, ctx.store, repo, pull));
}

function listPulls(ctx: Ctx, owner: string, name: string): void {
  const repo = requireRepo(ctx, owner, name);
  if (repo === null) return;
  const state = ctx.query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state === 'open' || state === 'closed') pulls = pulls.filter((p) => p.state === state);
  pulls.sort((a, b) => b.number - a.number);
  sendPage(ctx, pulls, (pull) => pullJson(ctx.req, ctx.store, repo, pull), `state=${encodeURIComponent(state)}`);
}

function getPull(ctx: Ctx, owner: string, name: string, n: string): void {
  const repo = requireRepo(ctx, owner, name);
  if (repo === null) return;
  const pull = repo.pulls.get(Number(n));
  if (pull === undefined) {
    notFound(ctx.res);
    return;
  }
  sendJson(ctx.res, 200, pullJson(ctx.req, ctx.store, repo, pull));
}

function listPullFiles(ctx: Ctx, owner: string, name: string, n: string): void {
  const repo = requireRepo(ctx, owner, name);
  if (repo === null) return;
  const pull = repo.pulls.get(Number(n));
  if (pull === undefined) {
    notFound(ctx.res);
    return;
  }
  const headSha = ctx.store.branchSha(repo, pull.headRef);
  const baseSha = ctx.store.branchSha(repo, pull.baseRef);
  if (headSha === null || baseSha === null) {
    sendJson(ctx.res, 200, []);
    return;
  }
  const mb = mergeBase(ctx.store, repo, headSha, baseSha);
  const baseFlat = mb === null ? new Map() : treeFlatAt(ctx.store, repo, mb);
  const headFlat = treeFlatAt(ctx.store, repo, headSha);
  const changes = diffFlat(ctx.store, repo, baseFlat, headFlat);
  sendJson(
    ctx.res,
    200,
    changes.map((c: FileChange) => ({
      sha: headFlat.get(c.path)?.sha ?? baseFlat.get(c.path)?.sha ?? '',
      filename: c.path,
      status: c.status,
      additions: c.additions,
      deletions: c.deletions,
      changes: c.changes,
      blob_url: `https://github.com/${OWNER_LOGIN}/${repo.name}/blob/${headSha}/${c.path}`,
      raw_url: `https://raw.githubusercontent.com/${OWNER_LOGIN}/${repo.name}/${headSha}/${c.path}`,
      contents_url: `${repoUrl(ctx.req, repo)}/contents/${c.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(pull.headRef)}`,
    })),
  );
}

function mergePull(ctx: Ctx, owner: string, name: string, n: string): void {
  const repo = requireRepo(ctx, owner, name);
  if (repo === null) return;
  const pull = repo.pulls.get(Number(n));
  if (pull === undefined) {
    notFound(ctx.res);
    return;
  }
  if (pull.state !== 'open') {
    err(ctx, 405, 'Pull request is already closed');
    return;
  }
  const headSha = ctx.store.branchSha(repo, pull.headRef);
  const baseSha = ctx.store.branchSha(repo, pull.baseRef);
  if (headSha === null || baseSha === null) {
    err(ctx, 405, 'Head or base branch is missing');
    return;
  }
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  const method = typeof body.merge_method === 'string' ? body.merge_method : 'squash';
  const merged = doMerge(ctx.store, repo, pull, method);
  if (!merged.ok) {
    err(ctx, 405, merged.reason);
    return;
  }
  sendJson(ctx.res, 200, { sha: merged.sha, merged: true, message: 'Pull request successfully merged' });
}

// -------------------------------------------------------------------------------------------
// Router. Returns true when the request was a REST route (handled), false otherwise.
// -------------------------------------------------------------------------------------------

/** Read and parse a JSON body for methods that carry one; sends 400 on malformed JSON. */
async function readJsonBody(ctx: Ctx): Promise<boolean> {
  const buf = await readBody(ctx.req);
  if (buf.length === 0) {
    ctx.body = undefined;
    return true;
  }
  const parsed = parseJsonBody(buf);
  if (!parsed.ok) {
    badJson(ctx.res);
    return false;
  }
  ctx.body = parsed.value;
  return true;
}

export async function handleRest(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  const method = req.method ?? 'GET';
  let path = pathOf(req);
  if (path.length > 1) path = path.replace(/\/+$/, '');
  if (!path.startsWith('/api/v3')) return false;

  const ctx: Ctx = { req, res, store, body: undefined, query: queryOf(req) };

  // The API root and meta are public, as on api.github.com; everything else needs the token.
  const isPublic = method === 'GET' && (path === '/api/v3' || path === '/api/v3/' || path === '/api/v3/meta');
  if (!isPublic && !authorized(req)) {
    unauthorized(res);
    return true;
  }

  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    handleRoot(ctx);
    return true;
  }
  if (method === 'GET' && path === '/api/v3/meta') {
    handleMeta(ctx);
    return true;
  }
  if (method === 'GET' && path === '/api/v3/user') {
    handleUser(ctx);
    return true;
  }

  const needsBody = method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE';
  if (needsBody && !(await readJsonBody(ctx))) return true;

  const seg = path.split('/').filter((s) => s !== '').map(decodeSeg);
  // seg[0] = 'api', seg[1] = 'v3', then the resource path.
  if (seg[0] !== 'api' || seg[1] !== 'v3') {
    notFound(res);
    return true;
  }
  const rest = seg.slice(2);

  // /user/repos
  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'GET') listUserRepos(ctx);
    else if (method === 'POST') createRepo(ctx);
    else notFound(res);
    return true;
  }

  // /repos/{owner}/{repo}[...]
  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = rest[1] as string;
    const name = rest[2] as string;
    const tail = rest.slice(3);
    if (tail.length === 0) {
      if (method === 'GET') getRepo(ctx, owner, name);
      else if (method === 'PATCH') patchRepo(ctx, owner, name);
      else if (method === 'DELETE') deleteRepo(ctx, owner, name);
      else notFound(res);
      return true;
    }
    if (tail[0] === 'branches' && tail.length === 1 && method === 'GET') {
      listBranches(ctx, owner, name);
      return true;
    }
    if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') {
      listCommits(ctx, owner, name);
      return true;
    }
    if (tail[0] === 'git' && tail[1] === 'refs' && tail.length === 2 && method === 'POST') {
      createRef(ctx, owner, name);
      return true;
    }
    if (tail[0] === 'git' && tail[1] === 'refs' && tail[2] === 'heads' && tail.length > 3 && method === 'GET') {
      getRefHead(ctx, owner, name, tail.slice(3).join('/'));
      return true;
    }
    if (tail[0] === 'contents') {
      const filePath = tail.slice(1).join('/');
      if (method === 'PUT') putContents(ctx, owner, name, filePath);
      else if (method === 'GET') getContents(ctx, owner, name, filePath);
      else if (method === 'DELETE') deleteContents(ctx, owner, name, filePath);
      else notFound(res);
      return true;
    }
    if (tail[0] === 'labels' && tail.length === 1) {
      if (method === 'POST') createLabel(ctx, owner, name);
      else if (method === 'GET') listLabels(ctx, owner, name);
      else notFound(res);
      return true;
    }
    if (tail[0] === 'issues' && tail.length === 1) {
      if (method === 'POST') createIssue(ctx, owner, name);
      else if (method === 'GET') listIssues(ctx, owner, name);
      else notFound(res);
      return true;
    }
    if (tail[0] === 'issues' && tail.length === 2) {
      if (method === 'GET') getIssue(ctx, owner, name, tail[1] as string);
      else if (method === 'PATCH') patchIssue(ctx, owner, name, tail[1] as string);
      else notFound(res);
      return true;
    }
    if (tail[0] === 'issues' && tail[2] === 'comments' && tail.length === 3) {
      if (method === 'POST') createComment(ctx, owner, name, tail[1] as string);
      else if (method === 'GET') listComments(ctx, owner, name, tail[1] as string);
      else notFound(res);
      return true;
    }
    if (tail[0] === 'pulls' && tail.length === 1) {
      if (method === 'POST') createPull(ctx, owner, name);
      else if (method === 'GET') listPulls(ctx, owner, name);
      else notFound(res);
      return true;
    }
    if (tail[0] === 'pulls' && tail.length === 2) {
      if (method === 'GET') getPull(ctx, owner, name, tail[1] as string);
      else notFound(res);
      return true;
    }
    if (tail[0] === 'pulls' && tail[2] === 'files' && tail.length === 3 && method === 'GET') {
      listPullFiles(ctx, owner, name, tail[1] as string);
      return true;
    }
    if (tail[0] === 'pulls' && tail[2] === 'merge' && tail.length === 3 && method === 'PUT') {
      mergePull(ctx, owner, name, tail[1] as string);
      return true;
    }
    notFound(res);
    return true;
  }

  notFound(res);
  return true;
}
