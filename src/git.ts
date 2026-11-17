// Git smart HTTP: info/refs (v0 + protocol v2), upload-pack (ls-refs, fetch)
// and receive-pack (v0). Packfiles are written plain (no deltas) and read
// with full delta resolution. Objects round-trip byte-exactly: the server
// stores what the client pushed and serves it back verbatim.
//
// The wire contract is the one git-client.ts implements: pkt-lines capped at
// 65,520 bytes, sideband bands 1/2/3, v2 sections acknowledgments /
// shallow-info / wanted-refs / packfile, and report-status lines
// `unpack ok` / `ok <ref>` / `ng <ref> <reason>`.

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  OWNER_LOGIN,
  authorized,
  notFound,
  nowIso,
  pathOf,
  queryOf,
  readBody,
  sendJson,
  sendRaw,
  unauthorized,
} from './util.ts';
import {
  getCommitInfo,
  isAncestor,
  objectSha,
  parseTree,
  type GitObject,
  type ObjectType,
  type Repo,
  type Store,
} from './store.ts';

export const ZERO_OID = '0'.repeat(40);
const PKT_MAX = 65_520;

/* ------------------------------------------------------------------ */
/* pkt-line framing                                                    */
/* ------------------------------------------------------------------ */

function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  if (len > PKT_MAX) throw new Error(`pkt-line of ${len} bytes exceeds ${PKT_MAX}`);
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, payload]);
}

const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

function encodePktLines(items: Array<string | Buffer | 'flush' | 'delim'>): Buffer {
  // Strings are framed here; Buffers are already complete pkt-lines
  // (e.g. sideband packets) and pass through untouched.
  return Buffer.concat(
    items.map((item) =>
      item === 'flush'
        ? pktFlush()
        : item === 'delim'
          ? pktDelim()
          : typeof item === 'string'
            ? pktLine(item)
            : item,
    ),
  );
}

type Packet = { kind: 'data' | 'flush' | 'delim' | 'end'; payload: Buffer };

/** Strict pkt-line decoding; throws on any malformed framing. */
function decodePktLines(buf: Buffer): Packet[] {
  const out: Packet[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line length');
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    const len = Number.parseInt(head, 16);
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len === 2) {
      out.push({ kind: 'end', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len < 4 || len > PKT_MAX) throw new Error(`bad pkt-line length ${len}`);
    if (off + len > buf.length) throw new Error('truncated pkt-line payload');
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return out;
}

/** One sideband packet: a pkt-line whose payload starts with the band byte. */
function sideband(band: 1 | 2 | 3, data: Buffer): Buffer {
  return pktLine(Buffer.concat([Buffer.from([band]), data]));
}

/** Split a payload into sideband packets of at most 65,515 data bytes each. */
function sidebandChunks(band: 1 | 2 | 3, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = PKT_MAX - 4 - 1;
  if (data.length === 0) {
    out.push(sideband(band, Buffer.alloc(0)));
    return out;
  }
  for (let off = 0; off < data.length; off += CHUNK) {
    out.push(sideband(band, data.subarray(off, Math.min(data.length, off + CHUNK))));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Packfiles: plain objects out, full objects + deltas in.             */
/* ------------------------------------------------------------------ */

const PACK_TYPE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackEntry(type: ObjectType, data: Buffer): Buffer {
  const typeCode = PACK_TYPE[type];
  // Size/type varint: low 4 bits of size in the first byte, then 7 bits/byte.
  const head: number[] = [];
  let size = data.length;
  let first = (size & 0x0f) | (typeCode << 4);
  size >>= 4;
  if (size > 0) first |= 0x80;
  head.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    head.push(byte);
  }
  return Buffer.concat([Buffer.from(head), deflateSync(data)]);
}

/** A v2 pack of plain (non-delta) objects, trailer SHA-1 included. */
export function writePack(objects: Array<{ type: ObjectType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) parts.push(writePackEntry(obj.type, obj.data));
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++] as number;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start] as number;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++] as number;
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset past it. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++] as number;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++] as number;
    if (op & 0x80) {
      let copyOff = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOff |= (delta[offset++] as number) << (8 * i);
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize |= (delta[offset++] as number) << (8 * i);
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOff + copySize > base.length || written + copySize > targetSize) {
        throw new Error('delta copy runs past its buffer');
      }
      base.copy(out, written, copyOff, copyOff + copySize);
      written += copySize;
    } else if (op !== 0) {
      if (offset + op > delta.length || written + op > targetSize) throw new Error('delta insert runs past its buffer');
      delta.copy(out, written, offset, offset + op);
      offset += op;
      written += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} bytes, expected ${targetSize}`);
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/**
 * Parse a packfile, resolve every object (including OFS/REF deltas, whose
 * bases may come from `resolveBase`), verify sizes, SHAs and the trailer.
 * Throws on any corruption.
 */
export function readPack(
  pack: Buffer,
  resolveBase?: (oid: string) => GitObject | undefined,
): Map<string, GitObject> {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (CODE_TYPE[typeCode] === undefined) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const objects = new Map<string, GitObject>();
  const resolved = new Map<number, { type: ObjectType; data: Buffer; oid: string }>();
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): { type: ObjectType; data: Buffer; oid: string } => {
    const done = resolved.get(entry.offset);
    if (done !== undefined) return done;
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: ObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (baseEntry === undefined) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid as string;
      const baseEntry = [...resolved.values()].find((r) => r.oid === wanted);
      if (baseEntry !== undefined) {
        type = baseEntry.type;
        data = applyDelta(baseEntry.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (external === undefined) throw new Error(`ref-delta base ${wanted} is neither in the pack nor in the store`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode] as ObjectType;
      data = entry.data;
    }
    const oid = objectSha(type, data);
    const out = { type, data, oid };
    resolved.set(entry.offset, out);
    resolving.delete(entry.offset);
    return out;
  };
  for (const entry of raw) {
    const { type, data, oid } = resolve(entry);
    if (!objects.has(oid)) objects.set(oid, { type, data });
  }
  return objects;
}

/* ------------------------------------------------------------------ */
/* Reachability: what a fetch must send.                               */
/* ------------------------------------------------------------------ */

/** Add a tree and everything under it (subtrees + blobs) to `out`. */
function addTree(store: Store, repo: Repo, treeSha: string, out: Map<string, GitObject>): void {
  const obj = store.getObject(repo, treeSha);
  if (obj === undefined || obj.type !== 'tree' || out.has(treeSha)) return;
  out.set(treeSha, obj);
  for (const entry of parseTree(obj.data)) {
    if (entry.mode === '40000') addTree(store, repo, entry.sha, out);
    else {
      const blob = store.getObject(repo, entry.sha);
      if (blob !== undefined && !out.has(entry.sha)) out.set(entry.sha, blob);
    }
  }
}

/**
 * Collect the objects reachable from `tips`.
 * - `depth`: null for the full closure; N limits commit depth (1 = tips only).
 * - `stopAt`: commits whose parents are NOT traversed (shallow boundaries the
 *   client already holds).
 * Returns the objects plus, when depth-limited, the boundary commits (included
 * commits at the depth limit that have parents in the store).
 */
function collectReachable(
  store: Store,
  repo: Repo,
  tips: readonly string[],
  opts: { depth: number | null; stopAt: ReadonlySet<string> },
): { objects: Map<string, GitObject>; boundaries: string[] } {
  const objects = new Map<string, GitObject>();
  const boundaries: string[] = [];
  const seenCommits = new Set<string>();
  // Queue of [oid, depth]: depth 1 = a tip commit.
  const queue: Array<{ oid: string; depth: number }> = [];
  const enqueueCommit = (oid: string, depth: number): void => {
    if (seenCommits.has(oid)) return;
    seenCommits.add(oid);
    queue.push({ oid, depth });
  };
  const visitTag = (oid: string, depth: number): void => {
    const obj = store.getObject(repo, oid);
    if (obj === undefined || obj.type !== 'tag' || objects.has(oid)) return;
    objects.set(oid, obj);
    const target = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'))?.[1];
    if (target === undefined) return;
    const targetObj = store.getObject(repo, target);
    if (targetObj === undefined) return;
    if (targetObj.type === 'commit') enqueueCommit(target, depth);
    else if (targetObj.type === 'tag') visitTag(target, depth);
    else if (targetObj.type === 'tree') addTree(store, repo, target, objects);
    else objects.set(target, targetObj);
  };

  for (const tip of tips) {
    const obj = store.getObject(repo, tip);
    if (obj === undefined) continue;
    if (obj.type === 'commit') enqueueCommit(tip, 1);
    else if (obj.type === 'tag') visitTag(tip, 1);
    else if (obj.type === 'tree') addTree(store, repo, tip, objects);
    else objects.set(tip, obj);
  }

  while (queue.length > 0) {
    const { oid, depth } = queue.shift() as { oid: string; depth: number };
    const info = getCommitInfo(store, repo, oid);
    if (info === undefined || objects.has(oid)) continue;
    const obj = store.getObject(repo, oid);
    if (obj === undefined) continue;
    objects.set(oid, obj);
    addTree(store, repo, info.tree, objects);
    const atLimit = opts.depth !== null && depth >= opts.depth;
    if (atLimit) {
      if (info.parents.length > 0 && info.parents.some((p) => store.getObject(repo, p) !== undefined)) {
        boundaries.push(oid);
      }
      continue;
    }
    if (opts.stopAt.has(oid)) continue;
    for (const parent of info.parents) enqueueCommit(parent, depth + 1);
  }
  return { objects, boundaries };
}

interface FetchPlan {
  /** Objects to send, sorted by sha for determinism. */
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/** Plan a fetch: wanted closure minus held closure, with shallow boundaries. */
function planFetch(
  store: Store,
  repo: Repo,
  wants: string[],
  haves: string[],
  knownShallow: string[],
  depth: number | null,
): FetchPlan {
  const held = collectReachable(store, repo, haves, { depth: null, stopAt: new Set(knownShallow) });
  const wanted = collectReachable(store, repo, wants, { depth, stopAt: new Set() });
  const objects: GitObject[] = [];
  for (const [sha, obj] of wanted.objects) {
    if (!held.objects.has(sha)) objects.push(obj);
  }
  objects.sort((a, b) => {
    const sa = objectSha(a.type, a.data);
    const sb = objectSha(b.type, b.data);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });
  const sent = new Set([...held.objects.keys(), ...objects.map((o) => objectSha(o.type, o.data))]);
  const shallow = [...new Set(wanted.boundaries)].sort();
  const unshallow: string[] = [];
  for (const boundary of [...knownShallow].sort()) {
    const info = getCommitInfo(store, repo, boundary);
    if (info === undefined) continue;
    const parents = info.parents;
    if (parents.length > 0 && parents.every((p) => sent.has(p))) unshallow.push(boundary);
  }
  return { objects, shallow, unshallow };
}

/* ------------------------------------------------------------------ */
/* Refs.                                                               */
/* ------------------------------------------------------------------ */

interface RefInfo {
  name: string;
  oid: string;
  type: 'commit' | 'tag' | 'other';
  /** For annotated tags: the commit the tag peels to. */
  peeled?: string;
}

/** All refs, sorted; tags carry their peeled commit when annotated. */
function listRefs(store: Store, repo: Repo): RefInfo[] {
  const out: RefInfo[] = [];
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name) as string;
    const obj = store.getObject(repo, oid);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      const target = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'))?.[1];
      let peeled = target;
      let cursor = target;
      while (cursor !== undefined) {
        const targetObj = store.getObject(repo, cursor);
        if (targetObj === undefined || targetObj.type !== 'tag') break;
        cursor = /^object ([0-9a-f]{40})$/m.exec(targetObj.data.toString('utf8'))?.[1];
        peeled = cursor;
      }
      out.push({ name, oid, type: 'tag', peeled });
    } else if (obj.type === 'commit') {
      out.push({ name, oid, type: 'commit' });
    } else {
      out.push({ name, oid, type: 'other' });
    }
  }
  return out;
}

/** The tip of the default branch, or ZERO_OID when the repo is unborn. */
function headOid(store: Store, repo: Repo): string {
  return store.branchSha(repo, repo.defaultBranch) ?? ZERO_OID;
}

/* ------------------------------------------------------------------ */
/* info/refs                                                           */
/* ------------------------------------------------------------------ */

function advertisementV0(store: Store, repo: Repo, service: string): Buffer {
  const cacheKey = `v0:${service}`;
  const cached = repo.adCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const isUpload = service === 'git-upload-pack';
  const caps = isUpload
    ? `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k thin-pack multi_ack ofs-delta shallow object-format=sha1 agent=git-forge/1.0`
    : `symref=HEAD:refs/heads/${repo.defaultBranch} report-status report-status-v2 side-band-64k delete-refs ofs-delta object-format=sha1 agent=git-forge/1.0`;
  const parts: Array<string | Buffer | 'flush'> = [`# service=${service}\n`, 'flush'];
  parts.push(`${headOid(store, repo)} HEAD\0${caps}\n`);
  for (const ref of listRefs(store, repo)) {
    parts.push(`${ref.oid} ${ref.name}\n`);
    if (ref.type === 'tag' && ref.peeled !== undefined && ref.peeled !== ref.oid) {
      parts.push(`${ref.peeled} ${ref.name}^{}\n`);
    }
  }
  parts.push('flush');
  const out = encodePktLines(parts);
  repo.adCache.set(cacheKey, out);
  return out;
}

function advertisementV2(repo: Repo): Buffer {
  const cached = repo.adCache.get('v2');
  if (cached !== undefined) return cached;
  const out = encodePktLines([
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    'agent=git-forge/1.0\n',
    'flush',
  ]);
  repo.adCache.set('v2', out);
  return out;
}

/* ------------------------------------------------------------------ */
/* upload-pack: ls-refs + fetch (v2), fetch (v0 fallback)              */
/* ------------------------------------------------------------------ */

function handleLsRefs(store: Store, repo: Repo, lines: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of lines) {
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  void unborn;
  const cacheKey = `ls-refs:${peel ? 'p' : ''}${symrefs ? 's' : ''}:${prefixes.join(',')}`;
  const cached = repo.adCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const refs = listRefs(store, repo);
  const out: string[] = [];
  const empty = refs.length === 0;
  if (prefixes.length === 0) {
    if (symrefs) {
      const tip = headOid(store, repo);
      if (empty || tip === ZERO_OID) {
        out.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
      } else {
        out.push(`${tip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
      }
    }
    for (const ref of refs) {
      let line = `${ref.oid} ${ref.name}`;
      if (peel && ref.type === 'tag' && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
      out.push(`${line}\n`);
    }
  } else {
    for (const ref of refs) {
      if (!prefixes.some((p) => ref.name.startsWith(p))) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (peel && ref.type === 'tag' && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
      out.push(`${line}\n`);
    }
  }
  out.push('flush');
  const encoded = encodePktLines(out);
  repo.adCache.set(cacheKey, encoded);
  return encoded;
}

function handleFetchV2(store: Store, repo: Repo, lines: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowKnown: string[] = [];
  let depth: number | null = null;
  for (const line of lines) {
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallowKnown.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isInteger(n) && n > 0) depth = n;
    }
  }
  const plan = planFetch(store, repo, wants, haves, shallowKnown, depth);
  const pack = writePack(plan.objects);
  const parts: Array<string | Buffer | 'flush' | 'delim'> = [];
  parts.push('acknowledgments\n');
  const common = haves.filter((h) => store.getObject(repo, h) !== undefined);
  if (common.length > 0) {
    for (const oid of [...new Set(common)].sort()) parts.push(`ACK ${oid}\n`);
    parts.push('ready\n');
  } else {
    parts.push('NAK\n');
  }
  parts.push('delim');
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push('shallow-info\n');
    for (const oid of plan.shallow) parts.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) parts.push(`unshallow ${oid}\n`);
    parts.push('delim');
  }
  parts.push('packfile\n');
  for (const chunk of sidebandChunks(1, pack)) parts.push(chunk);
  parts.push('flush');
  return encodePktLines(parts);
}

function handleFetchV0(store: Store, repo: Repo, lines: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowKnown: string[] = [];
  let depth: number | null = null;
  for (const line of lines) {
    if (line.startsWith('want ')) wants.push(line.slice(5).trim().split(' ')[0] as string);
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallowKnown.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isInteger(n) && n > 0) depth = n;
    }
  }
  const plan = planFetch(store, repo, wants, haves, shallowKnown, depth);
  const pack = writePack(plan.objects);
  const parts: Array<string | Buffer | 'flush'> = [];
  const common = haves.filter((h) => store.getObject(repo, h) !== undefined);
  if (common.length > 0) {
    for (const oid of [...new Set(common)].sort()) parts.push(`ACK ${oid}\n`);
  } else {
    parts.push('NAK\n');
  }
  for (const oid of plan.shallow) parts.push(`shallow ${oid}\n`);
  for (const oid of plan.unshallow) parts.push(`unshallow ${oid}\n`);
  for (const chunk of sidebandChunks(1, pack)) parts.push(chunk);
  parts.push('flush');
  return encodePktLines(parts);
}

/* ------------------------------------------------------------------ */
/* receive-pack                                                        */
/* ------------------------------------------------------------------ */

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(store: Store, repo: Repo, body: Buffer): Buffer {
  // Scan pkt-lines one at a time up to the first flush; everything after it
  // is the pack (pack bytes are not pkt-lines and must not be decoded).
  let commands: PushCommand[] = [];
  let caps: string[] = [];
  let packStart = 0;
  let unpackError: string | null = null;
  try {
    let off = 0;
    let sawFlush = false;
    while (off < body.length) {
      if (off + 4 > body.length) throw new Error('truncated pkt-line length');
      const head = body.subarray(off, off + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
      const len = Number.parseInt(head, 16);
      if (len === 0) {
        sawFlush = true;
        off += 4;
        break;
      }
      if (len < 4 || len > PKT_MAX || off + len > body.length) throw new Error('truncated pkt-line payload');
      const text = body.subarray(off + 4, off + len).toString('utf8');
      const nul = text.indexOf('\0');
      const capsText = nul >= 0 ? text.slice(nul + 1) : '';
      const line = (nul >= 0 ? text.slice(0, nul) : text).replace(/\n$/, '');
      if (commands.length === 0 && capsText !== '') caps = capsText.trim().split(/\s+/).filter(Boolean);
      const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
      if (m === null) throw new Error(`bad receive-pack command line ${JSON.stringify(line.slice(0, 60))}`);
      commands.push({ oldOid: m[1] as string, newOid: m[2] as string, ref: m[3] as string });
      off += len;
    }
    if (!sawFlush) throw new Error('receive-pack command list has no flush');
    packStart = off;
  } catch (err) {
    unpackError = err instanceof Error ? err.message : 'bad command list';
    commands = [];
  }

  const report: string[] = [];
  if (unpackError !== null) {
    report.push(`unpack ${unpackError}\n`);
  } else {
    const packBytes = body.subarray(packStart);
    let unpackOk = true;
    let unpackDetail = 'ok';
    if (packBytes.length > 0) {
      try {
        const objects = readPack(packBytes, (oid) => store.getObject(repo, oid));
        for (const [sha, obj] of objects) {
          if (store.getObject(repo, sha) === undefined) store.putObject(repo, obj.type, obj.data);
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : 'invalid pack';
      }
    }
    if (!unpackOk) {
      report.push(`unpack ${unpackDetail}\n`);
      for (const cmd of commands) report.push(`ng ${cmd.ref} unpack failed\n`);
    } else {
      report.push('unpack ok\n');
      for (const cmd of commands) {
        const current = repo.refs.get(cmd.ref);
        if (cmd.newOid === ZERO_OID) {
          // Delete.
          if (current !== undefined) store.deleteRef(repo, cmd.ref);
          report.push(`ok ${cmd.ref}\n`);
          continue;
        }
        const newObj = store.getObject(repo, cmd.newOid);
        if (newObj === undefined) {
          report.push(`ng ${cmd.ref} object not found\n`);
          continue;
        }
        if (cmd.oldOid === ZERO_OID) {
          // Create.
          if (current !== undefined) {
            report.push(`ng ${cmd.ref} already exists\n`);
            continue;
          }
          if (cmd.ref.startsWith('refs/heads/') && newObj.type !== 'commit') {
            report.push(`ng ${cmd.ref} not a commit\n`);
            continue;
          }
          store.setRef(repo, cmd.ref, cmd.newOid);
          report.push(`ok ${cmd.ref}\n`);
          continue;
        }
        // Update.
        if (current === undefined) {
          report.push(`ng ${cmd.ref} reference does not exist\n`);
          continue;
        }
        if (current !== cmd.oldOid) {
          report.push(`ng ${cmd.ref} non-fast-forward\n`);
          continue;
        }
        if (cmd.ref.startsWith('refs/heads/')) {
          if (newObj.type !== 'commit' || !isAncestor(store, repo, cmd.oldOid, cmd.newOid)) {
            report.push(`ng ${cmd.ref} non-fast-forward\n`);
            continue;
          }
        }
        store.setRef(repo, cmd.ref, cmd.newOid);
        report.push(`ok ${cmd.ref}\n`);
      }
      repo.updatedAt = nowIso();
    }
  }

  const useSideband = caps.includes('side-band-64k');
  const parts: Array<string | Buffer | 'flush'> = [];
  for (const line of report) {
    parts.push(useSideband ? sideband(1, Buffer.from(line, 'utf8')) : line);
  }
  parts.push('flush');
  return encodePktLines(parts);
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

function decodeSeg(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Handle a git smart-HTTP request. True when the path was a git route. */
export async function handleGit(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  const method = req.method ?? 'GET';
  const rawPath = pathOf(req);
  const seg = rawPath.split('/').filter((s) => s !== '').map(decodeSeg);
  if (seg.length < 2 || !seg[1]?.endsWith('.git')) return false;
  const owner = seg[0] as string;
  const repoName = (seg[1] as string).slice(0, -'.git'.length);
  const tail = seg.slice(2);

  if (!authorized(req)) {
    unauthorized(res);
    return true;
  }
  if (owner !== OWNER_LOGIN) {
    notFound(res);
    return true;
  }
  const repo = store.getRepo(repoName);
  if (repo === undefined) {
    notFound(res);
    return true;
  }

  try {
    if (method === 'GET' && tail[0] === 'info' && tail[1] === 'refs' && tail.length === 2) {
      const service = queryOf(req).get('service') ?? '';
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        notFound(res);
        return true;
      }
      const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
      const body = wantsV2 ? advertisementV2(repo) : advertisementV0(store, repo, service);
      const type = wantsV2
        ? 'application/x-git-upload-pack-advertisement'
        : service === 'git-upload-pack'
          ? 'application/x-git-upload-pack-advertisement'
          : 'application/x-git-receive-pack-advertisement';
      sendRaw(res, 200, body, type);
      return true;
    }

    if (method === 'POST' && tail[0] === 'git-upload-pack' && tail.length === 1) {
      const body = await readBody(req);
      let packets: Packet[];
      try {
        packets = decodePktLines(body);
      } catch {
        sendJson(res, 400, { message: 'Bad request: malformed pkt-line stream' });
        return true;
      }
      const lines = packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8').replace(/\n$/, ''));
      const first = lines[0] ?? '';
      if (first === 'command=ls-refs') {
        sendRaw(res, 200, handleLsRefs(store, repo, lines.slice(1)), 'application/x-git-upload-pack-result');
        return true;
      }
      if (first === 'command=fetch') {
        sendRaw(res, 200, handleFetchV2(store, repo, lines.slice(1)), 'application/x-git-upload-pack-result');
        return true;
      }
      if (first.startsWith('want ')) {
        sendRaw(res, 200, handleFetchV0(store, repo, lines), 'application/x-git-upload-pack-result');
        return true;
      }
      sendJson(res, 400, { message: 'Bad request: unknown upload-pack command' });
      return true;
    }

    if (method === 'POST' && tail[0] === 'git-receive-pack' && tail.length === 1) {
      const body = await readBody(req);
      sendRaw(res, 200, handleReceivePack(store, repo, body), 'application/x-git-receive-pack-result');
      return true;
    }
  } catch (err) {
    if (!res.headersSent) {
      sendJson(res, 400, { message: err instanceof Error ? err.message : 'Bad request' });
    }
    return true;
  }

  notFound(res);
  return true;
}
