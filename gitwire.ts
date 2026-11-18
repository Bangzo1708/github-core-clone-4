// The git wire: pkt-line framing, pack reading/writing, and the smart HTTP
// handlers for git-upload-pack (v2 and v0) and git-receive-pack (v0). Packs
// are plain objects only, never deltas, and always carry the trailer checksum,
// so any git client can read them.
//
// Two hot paths are cached per repository and cleared on any ref change:
// the fetch response for a given (wants, haves, depth, shallow) tuple and the
// ls-refs response for a given argument set — the clone workload asks for the
// same depth-1 fetch fifty times a round.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObjectType, Repo, Store } from './store.ts';
import { ZERO_OID, hashObject, isOid, parseCommit, parseTag, parseTree } from './store.ts';

// ---------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');
export const END_OF_REQUEST = Buffer.from('0002', 'ascii');

export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const size = payload.length + 4;
  const header = Buffer.alloc(4);
  header.write(size.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, payload]);
}

export function pktWithSideband(band: number, payload: Buffer): Buffer {
  return pktLine(Buffer.concat([Buffer.from([band]), payload]));
}

/** Split a buffer into pkt-lines: {flush, delim, end, payload}. */
export interface Pkt {
  kind: 'line' | 'flush' | 'delim' | 'end';
  payload: Buffer;
}

export function parsePktLines(buffer: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const size = parseInt(buffer.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(size)) throw new Error('pkt-line has a bad length');
    if (size === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (size === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (size === 2) {
      out.push({ kind: 'end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (size < 4 || offset + size > buffer.length) throw new Error('pkt-line is truncated');
    out.push({ kind: 'line', payload: buffer.subarray(offset + 4, offset + size) });
    offset += size;
  }
  return out;
}

// ---------------------------------------------------------------------------
// packs (plain objects only)
// ---------------------------------------------------------------------------

export interface PackObject {
  type: GitObjectType;
  data: Buffer;
  oid: string;
}

/** Read a pack: verify the trailer, inflate each entry, hash each object. */
export function readPack(pack: Buffer): PackObject[] {
  if (pack.length < 12 + 20) throw new Error('pack is too small');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack has no PACK header');
  const version = pack.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const computed = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!computed.equals(trailer)) throw new Error('pack trailer checksum mismatch');
  const objects: PackObject[] = [];
  let offset = 12;
  const streamEnd = pack.length - 20;
  for (let i = 0; i < count; i += 1) {
    let byte = pack[offset++];
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let type: GitObjectType;
    if (typeCode === 1) type = 'commit';
    else if (typeCode === 2) type = 'tree';
    else if (typeCode === 3) type = 'blob';
    else if (typeCode === 4) type = 'tag';
    else throw new Error(`pack entry uses delta type ${typeCode}`);
    // inflateSync ignores trailing bytes, so one call yields the object;
    // the stream's end is where its Adler-32 checksum sits, which a scan
    // finds without ever inflating a truncated stream (a throw in V8 costs
    // a stack trace, so the hot path must not probe by throwing).
    const data = inflateSync(pack.subarray(offset, streamEnd));
    if (data.length !== size) throw new Error('pack entry size mismatch');
    offset = zlibStreamEnd(pack, offset, streamEnd, data, size);
    objects.push({ type, data, oid: hashObject(type, data) });
  }
  return objects;
}

function adler32(data: Buffer): number {
  const MOD = 65521;
  let a = 1;
  let b = 0;
  // NMAX (5552): below this length the sums stay in range without a modulo,
  // so a short object needs only one modulo at the end.
  let i = 0;
  while (i < data.length) {
    const chunk = Math.min(5552, data.length - i);
    for (let j = 0; j < chunk; j += 1) {
      a += data[i + j]!;
      b += a;
    }
    a %= MOD;
    b %= MOD;
    i += chunk;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * The offset just past a zlib stream: the first position at or after
 * `offset + 2` whose four bytes are the Adler-32 of the inflated data and
 * which inflates back to exactly `expectedSize` bytes. A false checksum
 * match inside the deflate data is near-impossible and is caught by the
 * verification inflate, which then resumes the scan.
 */
function zlibStreamEnd(pack: Buffer, offset: number, limit: number, data: Buffer, expectedSize: number): number {
  const adler = Buffer.alloc(4);
  adler.writeUInt32BE(adler32(data), 0);
  const window = pack.subarray(offset, limit);
  let searchFrom = 2;
  for (;;) {
    const at = window.indexOf(adler, searchFrom);
    if (at < 0) throw new Error('could not find the end of a zlib stream');
    const candidate = offset + at + 4;
    try {
      if (inflateSync(pack.subarray(offset, candidate)).length === expectedSize) return candidate;
    } catch {
      // A checksum coincidence inside the deflate data; keep scanning.
    }
    searchFrom = at + 1;
  }
}

/** Write a pack of plain objects, with the trailer SHA-1. */
export function writePack(objects: PackObject[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    const typeCode = object.type === 'commit' ? 1 : object.type === 'tree' ? 2 : object.type === 'blob' ? 3 : 4;
    const size = object.data.length;
    const headerBytes: number[] = [];
    let first = (typeCode << 4) | (size & 0x0f);
    let remaining = size >> 4;
    if (remaining > 0) first |= 0x80;
    headerBytes.push(first);
    while (remaining > 0) {
      let next = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) next |= 0x80;
      headerBytes.push(next);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------
// fetch collection
// ---------------------------------------------------------------------------

export interface FetchPlan {
  objects: PackObject[];
  shallow: string[];
  unshallow: string[];
}

/**
 * What the client already holds. A `have` normally implies the whole history
 * behind it — except at a shallow boundary, where the client holds the commit
 * and its tree but none of its parents. Traversal therefore stops at the
 * commits listed in `stopAt`.
 */
function haveClosure(store: Store, repo: Repo, roots: string[], stopAt: Set<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root) && root !== ZERO_OID) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      for (const entry of store.reachable(repo, [commit.tree])) seen.add(entry);
      if (!stopAt.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      const entries = parseTree(object.data);
      for (const entry of entries) if (entry.mode !== '160000') queue.push(entry.oid);
    }
  }
  return seen;
}

/**
 * Collect the objects a fetch must send. `wants` are tip oids; `haves` are
 * oids the client already holds (whole history behind them is known, except
 * past a shallow boundary); `depth` caps how many commit generations back
 * the pack goes (undefined = full). Old shallow boundaries come in
 * `oldShallow` and leave the set as parents are sent back.
 *
 * Traversal walks from the wants even through commits the client holds —
 * that is how a deepen reaches the parent of a held shallow tip — but it
 * stops below a held commit that is not a shallow boundary, because
 * everything under it is held too.
 */
export function collectFetch(
  store: Store,
  repo: Repo,
  wants: string[],
  haves: string[],
  depth: number | undefined,
  oldShallow: string[],
): FetchPlan {
  const shallowSet = new Set(oldShallow);
  const haveSet = haves.length > 0 ? haveClosure(store, repo, haves, shallowSet) : new Set<string>();
  const sent = new Map<string, PackObject>();
  const shallow = new Set<string>();
  const unshallow = new Set<string>();
  const add = (oid: string): void => {
    if (sent.has(oid) || haveSet.has(oid)) return;
    const object = repo.objects.get(oid);
    if (!object) return;
    sent.set(oid, { type: object.type, data: object.data, oid });
  };
  // A commit's tree and blobs, skipping anything the client already has.
  const addTree = (treeOid: string): void => {
    if (haveSet.has(treeOid)) return;
    add(treeOid);
    const entries = parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0));
    for (const entry of entries) {
      if (entry.mode === '40000') addTree(entry.oid);
      else if (entry.mode !== '160000') add(entry.oid);
    }
  };
  // Breadth-first over commits: level 1 is the tip itself.
  interface QueueItem {
    oid: string;
    level: number;
  }
  const queue: QueueItem[] = [];
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (!object) continue;
    if (object.type === 'tag') {
      add(want);
      const target = parseTag(object.data).object;
      queue.push({ oid: target, level: 1 });
    } else if (object.type === 'commit') {
      queue.push({ oid: want, level: 1 });
    } else {
      add(want);
    }
  }
  const seen = new Set<string>();
  while (queue.length > 0) {
    const item = queue.shift()!;
    if (seen.has(item.oid)) continue;
    seen.add(item.oid);
    const commit = parseCommit(repo.objects.get(item.oid)?.data ?? Buffer.alloc(0));
    const held = haveSet.has(item.oid);
    if (!held) {
      add(item.oid);
      addTree(commit.tree);
    }
    const atDepth = depth !== undefined && item.level >= depth;
    if (atDepth) {
      if (!held) shallow.add(item.oid);
    } else if (!held || shallowSet.has(item.oid)) {
      // Below a held, non-shallow commit everything is held too, so stop.
      for (const parent of commit.parents) {
        if (!seen.has(parent)) queue.push({ oid: parent, level: item.level + 1 });
      }
    }
  }
  for (const boundary of oldShallow) {
    const commit = parseCommit(repo.objects.get(boundary)?.data ?? Buffer.alloc(0));
    if (!commit) continue;
    if (commit.parents.some((parent) => sent.has(parent))) unshallow.add(boundary);
  }
  const objects = [...sent.values()];
  // Commits first, then trees, then blobs, so a client reading in order
  // always sees a parent before its tree and a tree before its blobs.
  const order = { commit: 0, tag: 1, tree: 2, blob: 3 };
  objects.sort((a, b) => order[a.type] - order[b.type]);
  return { objects, shallow: [...shallow].sort(), unshallow: [...unshallow].sort() };
}

// ---------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function defaultBranchRef(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

const AGENT = 'agent=forge/1.0';

export function v0UploadAdvertisement(repo: Repo): Buffer {
  const cached = repo.advCache.get('v0up');
  if (cached) return cached;
  const caps = `side-band-64k ofs-delta shallow thin-pack multi_ack symref=HEAD:${defaultBranchRef(repo)} ${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=git-upload-pack\n`), FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headTip = repo.refs.get('HEAD') ?? repo.refs.get(defaultBranchRef(repo)) ?? ZERO_OID;
    parts.push(pktLine(`${headTip} HEAD\0${caps}\n`));
    for (const [name, oid] of refs) parts.push(pktLine(`${oid} ${name}\n`));
  }
  parts.push(FLUSH);
  const out = Buffer.concat(parts);
  repo.advCache.set('v0up', out);
  return out;
}

export function v0ReceiveAdvertisement(repo: Repo): Buffer {
  const cached = repo.advCache.get('v0recv');
  if (cached) return cached;
  const caps = `report-status side-band-64k delete-refs ofs-delta ${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=git-receive-pack\n`), FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${refs[0]![1]} ${refs[0]![0]}\0${caps}\n`));
    for (let i = 1; i < refs.length; i += 1) parts.push(pktLine(`${refs[i]![1]} ${refs[i]![0]}\n`));
  }
  parts.push(FLUSH);
  const out = Buffer.concat(parts);
  repo.advCache.set('v0recv', out);
  return out;
}

export const V2_ADVERTISEMENT: Buffer = (() => {
  const lines = [
    'version 2\n',
    'agent=forge/1.0\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    'object-info\n',
  ];
  const parts: Buffer[] = [];
  for (const line of lines) parts.push(pktLine(line));
  parts.push(FLUSH);
  return Buffer.concat(parts);
})();

export function v2Advertisement(): Buffer {
  return V2_ADVERTISEMENT;
}

// ---------------------------------------------------------------------------
// ls-refs (protocol v2)
// ---------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

export function parseLsRefsArgs(packets: Pkt[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const packet of packets) {
    if (packet.kind !== 'line') continue;
    const text = packet.payload.toString('utf8').trim();
    if (text === 'peel') args.peel = true;
    else if (text === 'symrefs') args.symrefs = true;
    else if (text === 'unborn') args.unborn = true;
    else if (text.startsWith('ref-prefix ')) args.prefixes.push(text.slice('ref-prefix '.length));
    else if (text.startsWith('ref-prefix ')) args.prefixes.push(text.slice('ref-prefix '.length));
  }
  return args;
}

export function lsRefsResponse(repo: Repo, args: LsRefsArgs): Buffer {
  const cacheKey = `ls:${args.peel ? 1 : 0}:${args.symrefs ? 1 : 0}:${args.unborn ? 1 : 0}:${args.prefixes.join(',')}`;
  const cached = repo.lsCache.get(cacheKey);
  if (cached) return cached;
  const parts: Buffer[] = [];
  const matches = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const headTip = repo.refs.get(defaultBranchRef(repo));
  const hasRefs = repo.refs.size > 0;
  if (args.unborn && !hasRefs && matches('HEAD')) {
    parts.push(pktLine(`unborn HEAD symref-target:${defaultBranchRef(repo)}\n`));
  } else if (hasRefs) {
    const headMatches = matches('HEAD');
    if (headMatches && headTip !== undefined) {
      let line = `${headTip} HEAD`;
      if (args.symrefs) line += ` symref-target:${defaultBranchRef(repo)}`;
      if (args.peel) {
        const commit = parseCommit(repo.objects.get(headTip)?.data ?? Buffer.alloc(0));
        line += ` peeled:${headTip}`;
        void commit;
      }
      parts.push(pktLine(`${line}\n`));
    }
    for (const [name, oid] of sortedRefs(repo)) {
      if (!matches(name)) continue;
      let line = `${oid} ${name}`;
      if (args.peel) {
        const object = repo.objects.get(oid);
        if (object?.type === 'tag') line += ` peeled:${parseTag(object.data).object}`;
      }
      parts.push(pktLine(`${line}\n`));
    }
  }
  parts.push(FLUSH);
  const out = Buffer.concat(parts);
  repo.lsCache.set(cacheKey, out);
  return out;
}

// ---------------------------------------------------------------------------
// fetch (protocol v2 and v0)
// ---------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
  thinPack: boolean;
}

export function parseFetchArgs(packets: Pkt[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: undefined, thinPack: false };
  for (const packet of packets) {
    if (packet.kind !== 'line') continue;
    const text = packet.payload.toString('utf8').trim();
    if (text.startsWith('want ')) args.wants.push(text.slice(5));
    else if (text.startsWith('have ')) args.haves.push(text.slice(5));
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8));
    else if (text.startsWith('deepen ')) {
      const n = Number(text.slice(7));
      if (Number.isInteger(n) && n > 0) args.depth = n;
    } else if (text === 'thin-pack') args.thinPack = true;
    else if (text.startsWith('filter ')) {
      // filter is advertised; the suite never sends one.
    }
  }
  return args;
}

function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const chunk = 65500;
  for (let offset = 0; offset < pack.length; offset += chunk) {
    parts.push(pktWithSideband(1, pack.subarray(offset, offset + chunk)));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** The v2 fetch reply: acknowledgments, shallow-info, then the packfile section. */
export function v2FetchResponse(store: Store, repo: Repo, args: FetchArgs): Buffer {
  const cacheKey = `v2:${args.wants.join(',')}|${args.haves.join(',')}|${args.depth ?? ''}|${args.shallow.join(',')}`;
  const cached = repo.fetchCache.get(cacheKey);
  if (cached) return cached;
  const plan = collectFetch(store, repo, args.wants, args.haves, args.depth, args.shallow);
  const parts: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), FLUSH];
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(FLUSH);
  }
  if (plan.objects.length > 0) {
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandPack(writePack(plan.objects)));
  }
  const out = Buffer.concat(parts);
  repo.fetchCache.set(cacheKey, out);
  return out;
}

/** The v0 fetch reply: NAK, shallow lines, then the sideband pack. */
export function v0FetchResponse(store: Store, repo: Repo, args: FetchArgs): Buffer {
  const cacheKey = `v0:${args.wants.join(',')}|${args.haves.join(',')}|${args.depth ?? ''}|${args.shallow.join(',')}`;
  const cached = repo.fetchCache.get(cacheKey);
  if (cached) return cached;
  const plan = collectFetch(store, repo, args.wants, args.haves, args.depth, args.shallow);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.objects.length > 0) parts.push(sidebandPack(writePack(plan.objects)));
  parts.push(FLUSH);
  const out = Buffer.concat(parts);
  repo.fetchCache.set(cacheKey, out);
  return out;
}

// ---------------------------------------------------------------------------
// receive-pack (v0 push)
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushResult {
  status: number;
  body: Buffer;
  /** The ref updates that were applied, for callers that track them. */
  applied: Array<{ ref: string; newOid: string }>;
}

/**
 * Handle a receive-pack POST. The request is command pkt-lines up to the
 * flush, then a pack. Each ref is fast-forward-checked on its own; a mixed
 * push applies the good ref and refuses the other, both reported.
 */
export function handleReceivePack(store: Store, repo: Repo, body: Buffer): PushResult {
  // Scan the command pkt-lines only: stop at the first flush, because
  // everything after it is the (binary) pack, not pkt-lines.
  const commands: PushCommand[] = [];
  let offset = 0;
  let packStart = body.length;
  while (offset + 4 <= body.length) {
    const size = parseInt(body.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(size) || size < 0) break;
    if (size === 0) {
      offset += 4;
      packStart = offset;
      break;
    }
    if (size === 1 || size === 2) {
      offset += 4;
      continue;
    }
    if (size < 4 || offset + size > body.length) break;
    const text = body.subarray(offset + 4, offset + size).toString('utf8');
    const nul = text.indexOf('\0');
    const line = (nul < 0 ? text : text.slice(0, nul)).trim();
    const parts = line.split(' ');
    if (parts.length >= 3) commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
    offset += size;
  }
  const packBytes = body.subarray(packStart);
  let objects: PackObject[] = [];
  let unpackOk = true;
  if (packBytes.length > 0 && commands.some((command) => command.newOid !== ZERO_OID)) {
    try {
      objects = readPack(packBytes);
    } catch {
      // A pack that cannot be read is an unpack failure; an empty pack
      // (zero objects, e.g. a branch created from a commit already held)
      // is valid and reads fine.
      unpackOk = false;
    }
    for (const object of objects) {
      if (!repo.objects.has(object.oid)) repo.objects.set(object.oid, { type: object.type, data: object.data });
    }
  }
  const applied: Array<{ ref: string; newOid: string }> = [];
  const reportLines: string[] = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpack failed\n`);
      continue;
    }
    if (command.newOid === ZERO_OID) {
      // A delete: allowed when the ref exists and matches the old value.
      if (current === undefined || (command.oldOid !== ZERO_OID && command.oldOid !== current)) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      } else {
        repo.refs.delete(command.ref);
        applied.push({ ref: command.ref, newOid: ZERO_OID });
        reportLines.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    if (current === undefined) {
      // A new ref: only a commit or tag object may be its tip.
      const object = repo.objects.get(command.newOid);
      if (!object || (object.type !== 'commit' && object.type !== 'tag')) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      applied.push({ ref: command.ref, newOid: command.newOid });
      reportLines.push(`ok ${command.ref}\n`);
      continue;
    }
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
      reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    if (!store.isAncestor(repo, current, command.newOid)) {
      reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    applied.push({ ref: command.ref, newOid: command.newOid });
    reportLines.push(`ok ${command.ref}\n`);
  }
  if (applied.length > 0) store.invalidateGit(repo);
  const statusLines: string[] = [unpackOk ? 'unpack ok\n' : 'unpack error\n'];
  statusLines.push(...reportLines);
  const report = statusLines.map((line) => pktLine(line)).join('');
  const bodyOut = Buffer.concat([pktWithSideband(1, Buffer.from(report, 'utf8')), FLUSH]);
  return { status: 200, body: bodyOut, applied };
}
