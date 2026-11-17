// The forge's store: every repository, issue, pull request and git object lives here,
// in memory, keyed deterministically. No wall clock, no randomness: ids come from
// counters, timestamps from util.nowIso(). A fresh process starts empty — the suite
// creates everything through the forge's own APIs, so two runs on the same instance
// drive the same requests and leave the same state.

import { createHash } from 'node:crypto';
import { OWNER_ID, OWNER_LOGIN, nowIso } from './util.ts';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  /** Raw object payload, without the "<type> <len>\0" header. */
  data: Buffer;
}

/** sha1("<type> <len>\0" + data), hex. */
export function objectSha(type: ObjectType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export interface UserRef {
  login: string;
  id: number;
  type: string;
}

export function ownerUser(): UserRef {
  return { login: OWNER_LOGIN, id: OWNER_ID, type: 'User' };
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: UserRef;
  created_at: string;
  updated_at: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];
  assignees: UserRef[];
  user: UserRef;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  comments: IssueComment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  merged: boolean;
  mergeable: boolean | null;
  headRef: string;
  baseRef: string;
  headSha: string | null;
  baseSha: string | null;
  mergeCommitSha: string | null;
  user: UserRef;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
}

export interface Repo {
  id: number;
  name: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  pushedAt: string;
  /** Full ref name (refs/heads/<branch>, refs/tags/<tag>) -> commit sha. */
  refs: Map<string, string>;
  /** Object id -> object. */
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  /** Shared issue+pull numbering, as on GitHub. */
  nextNumber: number;
  nextLabelId: number;
  nextCommentId: number;
  /** Blob sha of the last squash/contents commit's tree root, for fast lookups. */
  headTreeCache: Map<string, string>;
  /** Bumped on every ref mutation; the git layer caches advertisements keyed off it. */
  refVersion: number;
  /** Cached git advertisement / ls-refs bytes; cleared whenever refVersion bumps. */
  adCache: Map<string, Buffer>;
  /** Parsed commit headers, cached so repeated walks never re-parse bytes. */
  commitMeta: Map<string, CommitInfo>;
}

const DEFAULT_LABELS: Array<[string, string, string]> = [
  ['bug', 'd73a4a', "Something isn't working"],
  ['documentation', '0075ca', 'Improvements or additions to documentation'],
  ['duplicate', 'cfd3d7', 'This issue or pull request already exists'],
  ['enhancement', 'a2eeef', 'New feature or request'],
  ['good first issue', '7057ff', 'Good for newcomers'],
  ['help wanted', '008672', 'Extra attention is needed'],
  ['invalid', 'e4e669', "This doesn't seem right"],
  ['question', 'd876e3', 'Further information is requested'],
  ['wontfix', 'ffffff', 'This will not be worked on'],
];

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  nextIssueId = 1;
  nextPullId = 1;

  createRepo(name: string, description: string | null, isPrivate: boolean, defaultBranch: string): Repo {
    const t = nowIso();
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      description,
      private: isPrivate,
      defaultBranch,
      createdAt: t,
      updatedAt: t,
      pushedAt: t,
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      nextLabelId: 1,
      nextCommentId: 1,
      headTreeCache: new Map(),
      refVersion: 0,
      adCache: new Map(),
      commitMeta: new Map(),
    };
    for (const [lname, color, desc] of DEFAULT_LABELS) {
      repo.labels.set(lname, { id: repo.nextLabelId++, name: lname, color, description: desc });
    }
    this.repos.set(name, repo);
    return repo;
  }

  getRepo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  /** Store an object, returning its sha. Idempotent: same bytes give the same sha. */
  putObject(repo: Repo, type: ObjectType, data: Buffer): string {
    const sha = objectSha(type, data);
    if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
    return sha;
  }

  getObject(repo: Repo, sha: string): GitObject | undefined {
    return repo.objects.get(sha);
  }

  /** The sha a branch points at, or null when the branch does not exist. */
  branchSha(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  setBranch(repo: Repo, branch: string, sha: string): void {
    repo.refs.set(`refs/heads/${branch}`, sha);
    repo.updatedAt = nowIso();
    repo.pushedAt = repo.updatedAt;
    bumpRefVersion(repo);
  }

  /** Set any ref (heads or tags), invalidating cached advertisements. */
  setRef(repo: Repo, ref: string, sha: string): void {
    repo.refs.set(ref, sha);
    repo.updatedAt = nowIso();
    repo.pushedAt = repo.updatedAt;
    bumpRefVersion(repo);
  }

  /** Delete any ref, invalidating cached advertisements. */
  deleteRef(repo: Repo, ref: string): void {
    repo.refs.delete(ref);
    repo.updatedAt = nowIso();
    bumpRefVersion(repo);
  }

  touch(repo: Repo): void {
    repo.updatedAt = nowIso();
  }
}

/** Bump a repo's ref version and drop its cached git advertisements. */
export function bumpRefVersion(repo: Repo): void {
  repo.refVersion += 1;
  repo.adCache.clear();
}

/** A commit's parsed header, cached per repo so walks never re-parse bytes. */
export function getCommitInfo(store: Store, repo: Repo, sha: string): CommitInfo | undefined {
  const cached = repo.commitMeta.get(sha);
  if (cached !== undefined) return cached;
  const obj = store.getObject(repo, sha);
  if (obj === undefined || obj.type !== 'commit') return undefined;
  const info = parseCommit(obj.data);
  repo.commitMeta.set(sha, info);
  return info;
}

/* ------------------------------------------------------------------ */
/* Git object parsing: trees and commits, the shapes the forge reads   */
/* back when it serves clones, contents and merges.                    */
/* ------------------------------------------------------------------ */

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

/** Parse a tree object's payload into entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const mode = data.subarray(off, sp).toString('ascii');
    const nul = data.indexOf(0, sp);
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    off = nul + 21;
  }
  return entries;
}

/** Serialize tree entries (already in git's sort order) into a payload. */
export function buildTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorTime: number;
  authorTz: string;
  committerName: string;
  committerEmail: string;
  committerTime: number;
  committerTz: string;
  message: string;
}

/** Parse a commit object's payload. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd === -1 ? text : text.slice(0, headEnd);
  const message = headEnd === -1 ? '' : text.slice(headEnd + 2);
  const parents: string[] = [];
  let tree = '';
  let authorName = '';
  let authorEmail = '';
  let authorTime = 0;
  let authorTz = '+0000';
  let committerName = '';
  let committerEmail = '';
  let committerTime = 0;
  let committerTz = '+0000';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      const m = /^author (.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
      if (m) {
        authorName = m[1];
        authorEmail = m[2];
        authorTime = Number(m[3]);
        authorTz = m[4];
      }
    } else if (line.startsWith('committer ')) {
      const m = /^committer (.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
      if (m) {
        committerName = m[1];
        committerEmail = m[2];
        committerTime = Number(m[3]);
        committerTz = m[4];
      }
    }
  }
  return { tree, parents, authorName, authorEmail, authorTime, authorTz, committerName, committerEmail, committerTime, committerTz, message };
}

/** Serialize a commit. Timestamps are unix seconds; tz is "+0000". */
export function buildCommit(c: CommitInfo): Buffer {
  const lines = [`tree ${c.tree}`];
  for (const p of c.parents) lines.push(`parent ${p}`);
  lines.push(`author ${c.authorName} <${c.authorEmail}> ${c.authorTime} ${c.authorTz}`);
  lines.push(`committer ${c.committerName} <${c.committerEmail}> ${c.committerTime} ${c.committerTz}`);
  return Buffer.from(`${lines.join('\n')}\n\n${c.message}`, 'utf8');
}

/** Flatten a tree into path -> { mode, sha } for every blob, recursively. */
export function flattenTree(store: Store, repo: Repo, treeSha: string, prefix: string, out: Map<string, { mode: string; sha: string }>): void {
  const obj = store.getObject(repo, treeSha);
  if (obj === undefined || obj.type !== 'tree') return;
  for (const e of parseTree(obj.data)) {
    const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.mode === '40000') flattenTree(store, repo, e.sha, path, out);
    else out.set(path, { mode: e.mode, sha: e.sha });
  }
}

/**
 * Build a tree from a flat path -> { mode, sha } map, reusing existing subtrees
 * where possible. Returns the root tree sha. New tree objects are stored.
 */
export function buildTreeFromFlat(store: Store, repo: Repo, flat: Map<string, { mode: string; sha: string }>): string {
  // Group paths by first segment, recursively.
  const build = (paths: Array<{ rest: string; mode: string; sha: string }>): string => {
    const byFirst = new Map<string, Array<{ rest: string; mode: string; sha: string }>>();
    const files: TreeEntry[] = [];
    for (const p of paths) {
      const slash = p.rest.indexOf('/');
      if (slash === -1) {
        files.push({ mode: p.mode, name: p.rest, sha: p.sha });
      } else {
        const first = p.rest.slice(0, slash);
        const arr = byFirst.get(first) ?? [];
        arr.push({ rest: p.rest.slice(slash + 1), mode: p.mode, sha: p.sha });
        byFirst.set(first, arr);
      }
    }
    const entries: TreeEntry[] = [...files];
    for (const [dir, sub] of [...byFirst.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      entries.push({ mode: '40000', name: dir, sha: build(sub) });
    }
    // Git sorts tree entries with directories as if their name had a trailing '/'.
    entries.sort((a, b) => {
      const an = a.mode === '40000' ? `${a.name}/` : a.name;
      const bn = b.mode === '40000' ? `${b.name}/` : b.name;
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    const data = buildTree(entries);
    return store.putObject(repo, 'tree', data);
  };
  const paths = [...flat.entries()].map(([path, v]) => ({ rest: path, mode: v.mode, sha: v.sha }));
  return build(paths);
}

/** True when `ancestor` is an ancestor of `descendant` (or equal), walking parents. */
export function isAncestor(store: Store, repo: Repo, ancestor: string, descendant: string, maxDepth = 10000): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  let depth = 0;
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (sha === ancestor) return true;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const info = getCommitInfo(store, repo, sha);
    if (info === undefined) continue;
    for (const p of info.parents) stack.push(p);
    depth += 1;
    if (depth > maxDepth) return false;
  }
  return false;
}

/** Walk a commit's history (first-parent order is not assumed: all parents, newest first by time). */
export function walkCommits(store: Store, repo: Repo, tip: string, limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: Array<{ sha: string; time: number }> = [{ sha: tip, time: Number.MAX_SAFE_INTEGER }];
  while (queue.length > 0 && out.length < limit) {
    queue.sort((a, b) => b.time - a.time);
    const cur = queue.shift() as { sha: string; time: number };
    if (seen.has(cur.sha)) continue;
    seen.add(cur.sha);
    const info = getCommitInfo(store, repo, cur.sha);
    if (info === undefined) continue;
    out.push(cur.sha);
    for (const p of info.parents) {
      const t = getCommitInfo(store, repo, p)?.committerTime ?? 0;
      queue.push({ sha: p, time: t });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Extra helpers for the REST / merge layer.                           */
/* ------------------------------------------------------------------ */

/** Resolve a ref to a commit sha: a branch name, a full ref, or a raw sha. */
export function resolveRef(store: Store, repo: Repo, ref: string): string | null {
  if (ref.startsWith('refs/heads/')) {
    return repo.refs.get(ref) ?? null;
  }
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch !== undefined) return branch;
  const obj = store.getObject(repo, ref);
  if (obj !== undefined && obj.type === 'commit') return ref;
  return null;
}

/** The merge-base of two commits: the newest common ancestor (by committer time). */
export function mergeBase(store: Store, repo: Repo, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const stack = [a];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (ancestorsA.has(sha)) continue;
    ancestorsA.add(sha);
    const info = getCommitInfo(store, repo, sha);
    if (info === undefined) continue;
    for (const p of info.parents) stack.push(p);
  }
  // BFS from b, newest first: the first commit that is also an ancestor of a.
  const seen = new Set<string>();
  const queue: Array<{ sha: string; time: number }> = [{ sha: b, time: Number.MAX_SAFE_INTEGER }];
  while (queue.length > 0) {
    queue.sort((x, y) => y.time - x.time);
    const cur = queue.shift() as { sha: string; time: number };
    if (seen.has(cur.sha)) continue;
    seen.add(cur.sha);
    if (ancestorsA.has(cur.sha)) return cur.sha;
    const info = getCommitInfo(store, repo, cur.sha);
    if (info === undefined) continue;
    for (const p of info.parents) {
      const t = getCommitInfo(store, repo, p)?.committerTime ?? 0;
      queue.push({ sha: p, time: t });
    }
  }
  return null;
}

/** Flatten the tree of a commit into path -> { mode, sha }. Empty map when no such commit. */
export function treeFlatAt(store: Store, repo: Repo, commitSha: string): Map<string, { mode: string; sha: string }> {
  const out = new Map<string, { mode: string; sha: string }>();
  const info = getCommitInfo(store, repo, commitSha);
  if (info === undefined) return out;
  flattenTree(store, repo, info.tree, '', out);
  return out;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

function lineList(content: string): string[] {
  if (content === '') return [];
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function lineCounts(oldContent: string, newContent: string): { additions: number; deletions: number } {
  const oldFreq = new Map<string, number>();
  for (const line of lineList(oldContent)) oldFreq.set(line, (oldFreq.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of lineList(newContent)) {
    const left = oldFreq.get(line) ?? 0;
    if (left > 0) oldFreq.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const n of oldFreq.values()) deletions += n;
  return { additions, deletions };
}

/** Diff two flat trees; needs the repo to read blob contents for line counts. */
export function diffFlat(
  store: Store,
  repo: Repo,
  base: Map<string, { mode: string; sha: string }>,
  head: Map<string, { mode: string; sha: string }>,
): FileChange[] {
  const out: FileChange[] = [];
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b !== undefined && h === undefined) {
      const blob = store.getObject(repo, b.sha);
      const deletions = blob === undefined ? 0 : lineList(blob.data.toString('utf8')).length;
      out.push({ path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (b === undefined && h !== undefined) {
      const blob = store.getObject(repo, h.sha);
      const additions = blob === undefined ? 0 : lineList(blob.data.toString('utf8')).length;
      out.push({ path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b !== undefined && h !== undefined && b.sha !== h.sha) {
      const oldBlob = store.getObject(repo, b.sha);
      const newBlob = store.getObject(repo, h.sha);
      const { additions, deletions } = lineCounts(
        oldBlob === undefined ? '' : oldBlob.data.toString('utf8'),
        newBlob === undefined ? '' : newBlob.data.toString('utf8'),
      );
      out.push({ path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

export interface NewCommitInput {
  tree: string;
  parents: string[];
  message: string;
  /** Unix seconds for author/committer; the caller supplies a deterministic value. */
  time: number;
}

/** Create and store a commit object for the viewer; returns its sha. */
export function createCommit(store: Store, repo: Repo, input: NewCommitInput): string {
  const data = buildCommit({
    tree: input.tree,
    parents: input.parents,
    authorName: 'ada iversen',
    authorEmail: 'adaiversen@example.invalid',
    authorTime: input.time,
    authorTz: '+0000',
    committerName: 'ada iversen',
    committerEmail: 'adaiversen@example.invalid',
    committerTime: input.time,
    committerTz: '+0000',
    message: input.message,
  });
  return store.putObject(repo, 'commit', data);
}

/* ------------------------------------------------------------------ */
/* Merge (shared by REST PUT .../merge and the MCP merge_pull_request  */
/* tool): squash-apply the head's changes onto the base tip.           */
/* ------------------------------------------------------------------ */

/** True when a squash merge of head into base would apply cleanly. */
export function mergeWouldConflict(store: Store, repo: Repo, headSha: string, baseSha: string): boolean {
  const mb = mergeBase(store, repo, headSha, baseSha);
  if (mb === null) return true;
  const baseFlat = treeFlatAt(store, repo, mb);
  const headFlat = treeFlatAt(store, repo, headSha);
  const tipFlat = treeFlatAt(store, repo, baseSha);
  for (const change of diffFlat(store, repo, baseFlat, headFlat)) {
    const tipVersion = tipFlat.get(change.path)?.sha;
    const baseVersion = baseFlat.get(change.path)?.sha;
    const headVersion = headFlat.get(change.path)?.sha;
    if (tipVersion !== baseVersion && headVersion !== tipVersion) return true;
  }
  return false;
}

export type MergeResult =
  | { ok: true; sha: string }
  | { ok: false; reason: string };

/**
 * Merge an open pull request onto its base branch. Squash by default (one
 * parent, the base tip); `merge` keeps both parents. Updates the pull's
 * state/merged/merged_at/mergeCommitSha. Returns the merge commit sha.
 */
export function doMerge(store: Store, repo: Repo, pull: Pull, method: string): MergeResult {
  const headSha = store.branchSha(repo, pull.headRef);
  const baseSha = store.branchSha(repo, pull.baseRef);
  if (headSha === null || baseSha === null) return { ok: false, reason: 'Head or base branch is missing' };
  if (mergeWouldConflict(store, repo, headSha, baseSha)) {
    return { ok: false, reason: 'Merge conflict: the pull request cannot be merged' };
  }
  const mb = mergeBase(store, repo, headSha, baseSha) as string;
  const baseFlat = treeFlatAt(store, repo, mb);
  const headFlat = treeFlatAt(store, repo, headSha);
  const merged = treeFlatAt(store, repo, baseSha);
  for (const change of diffFlat(store, repo, baseFlat, headFlat)) {
    const headEntry = headFlat.get(change.path);
    if (headEntry === undefined) merged.delete(change.path);
    else merged.set(change.path, { mode: headEntry.mode, sha: headEntry.sha });
  }
  const treeSha = buildTreeFromFlat(store, repo, merged);
  const time = Math.floor(Date.parse(nowIso()) / 1000);
  const parents = method === 'merge' ? [baseSha, headSha] : [baseSha];
  const message = method === 'squash' ? pull.title : `Merge pull request #${pull.number} from ${OWNER_LOGIN}/${pull.headRef}`;
  const mergeSha = createCommit(store, repo, { tree: treeSha, parents, message, time });
  store.setBranch(repo, pull.baseRef, mergeSha);
  const t = nowIso();
  pull.state = 'closed';
  pull.merged = true;
  pull.merged_at = t;
  pull.closed_at = t;
  pull.updated_at = t;
  pull.mergeCommitSha = mergeSha;
  return { ok: true, sha: mergeSha };
}
