// The forge's store: every repository, git object, issue, pull request, label and
// comment, in memory, with deterministic ids and timestamps (no wall clock, no
// Math.random: two runs on the same requests leave the same bytes).
//
// A repository owns a git object database (Map<oid, {type, data}>) plus refs, and
// the REST resources that sit on top of it. Issues and pull requests share one
// per-repo numbering sequence, as on GitHub. JSON bodies for the hot reads are
// built once and cached as strings until the object changes.

import { createHash } from 'node:crypto';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export const ZERO_OID = '0'.repeat(40);

/** The login the bearer token names (MAKEFUN_FORGE_LOGIN overrides it locally). */
export const VIEWER_LOGIN = process.env.MAKEFUN_FORGE_LOGIN ?? 'adaiversen';
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_ID = 1000;

/** The scenario's day one: every generated timestamp is this plus a sequence. */
export const EPOCH_SEC = 1735689600;

const HEX40 = /^[0-9a-f]{40}$/;
export function isOid(value: string): boolean {
  return HEX40.test(value);
}

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as `name/`. */
function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object's bytes from entries, sorted the way git sorts them. */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a commit object's bytes. */
export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

/** Parse an annotated tag object's bytes. */
export function parseTag(data: Buffer): { object: string; type: GitObjectType; tag: string; tagger: string; message: string } {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

export interface CommitBuild {
  tree: string;
  parents: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}

/** Build a commit object's bytes; the message gains a trailing newline, as git writes it. */
export function buildCommitBytes(fields: CommitBuild): Buffer {
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${fields.timestamp} +0000`, `committer ${fields.committer} ${fields.timestamp} +0000`, '');
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

// ---------------------------------------------------------------------------
// global ids (opaque, stable): R_<b64>, I_<b64>, PR_<b64>, IC_<b64>
// ---------------------------------------------------------------------------

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function unb64url(text: string): string | null {
  try {
    return Buffer.from(text, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

export function repoGlobalId(dbId: number): string {
  return `R_${b64url(`Repository:${dbId}`)}`;
}
export function issueGlobalId(dbId: number, number: number): string {
  return `I_${b64url(`Issue:${dbId}:${number}`)}`;
}
export function prGlobalId(dbId: number, number: number): string {
  return `PR_${b64url(`PullRequest:${dbId}:${number}`)}`;
}
export function commentGlobalId(dbId: number, issueNumber: number, commentId: number): string {
  return `IC_${b64url(`Comment:${dbId}:${issueNumber}:${commentId}`)}`;
}

export interface DecodedGlobalId {
  kind: 'Repository' | 'Issue' | 'PullRequest' | 'Comment';
  dbId: number;
  number: number;
  commentId: number;
}

export function decodeGlobalId(id: string): DecodedGlobalId | null {
  const prefix = id.slice(0, id.indexOf('_'));
  const rest = id.slice(id.indexOf('_') + 1);
  const decoded = unb64url(rest);
  if (decoded === null) return null;
  const parts = decoded.split(':');
  if (parts[0] === 'Repository' && prefix === 'R' && parts.length === 2) {
    return { kind: 'Repository', dbId: Number(parts[1]), number: 0, commentId: 0 };
  }
  if (parts[0] === 'Issue' && prefix === 'I' && parts.length === 3) {
    return { kind: 'Issue', dbId: Number(parts[1]), number: Number(parts[2]), commentId: 0 };
  }
  if (parts[0] === 'PullRequest' && prefix === 'PR' && parts.length === 3) {
    return { kind: 'PullRequest', dbId: Number(parts[1]), number: Number(parts[2]), commentId: 0 };
  }
  if (parts[0] === 'Comment' && prefix === 'IC' && parts.length === 4) {
    return { kind: 'Comment', dbId: Number(parts[1]), number: Number(parts[2]), commentId: Number(parts[3]) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// resources
// ---------------------------------------------------------------------------

export interface Label {
  id: number;
  nodeId: string;
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  createdSeq: number;
  updatedSeq: number;
  closedSeq: number;
  json: string | null;
  buf: Buffer | null;
}

export interface Comment {
  id: number;
  nodeId: string;
  body: string;
  createdSeq: number;
  updatedSeq: number;
  issueNumber: number;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface PullRequest {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeable: boolean | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeCommitSha: string | null;
  createdSeq: number;
  updatedSeq: number;
  closedSeq: number;
  mergedSeq: number;
  files: PullFile[] | null;
  additions: number;
  deletions: number;
  json: string | null;
  buf: Buffer | null;
}

export interface Repo {
  id: number;
  nodeId: string;
  owner: string;
  name: string;
  fullName: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  updatedSeq: number;
  labels: Map<string, Label>;
  labelSeq: number;
  issues: Issue[];
  issuesByNumber: Map<number, Issue>;
  pulls: PullRequest[];
  pullsByNumber: Map<number, PullRequest>;
  nextNumber: number;
  nextCommentId: number;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  commitCache: Map<string, CommitView>;
  treeCache: Map<string, TreeEntry[]>;
  flatCache: Map<string, Map<string, { oid: string; mode: string }>>;
  packCache: Map<string, Buffer>;
  fetchCache: Map<string, Buffer>;
  advCache: Map<string, Buffer>;
  lsCache: Map<string, Buffer>;
  json: string | null;
  buf: Buffer | null;
}

function userJson(login: string, id: number): Record<string, unknown> {
  return { login, id, node_id: `U_${b64url(`User:${id}`)}`, avatar_url: '', gravatar_id: '', url: '', html_url: '', type: 'User', site_admin: false };
}

export class Store {
  repos = new Map<string, Repo>();
  reposById = new Map<number, Repo>();
  repoList: Repo[] = [];
  nextRepoId = 1;
  nextIssueId = 1;
  nextCommentId = 1;
  seq = 0;

  /** A deterministic timestamp: base epoch plus one second per mutation, ISO form. */
  stamp(): string {
    this.seq += 1;
    return new Date((EPOCH_SEC + this.seq) * 1000).toISOString();
  }

  /** The git timestamp (seconds) for a server-made commit. */
  gitTs(): number {
    return 1700000000 + this.seq;
  }

  /** The deterministic ISO timestamp for sequence `n` (no mutation). */
  stampAt(n: number): string {
    return new Date((EPOCH_SEC + n) * 1000).toISOString();
  }

  // ------------------------------------------------------------- repos

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    const key = `${owner}/${name}`;
    if (this.repos.has(key)) return null;
    const id = this.nextRepoId++;
    const createdSeq = ++this.seq;
    const repo: Repo = {
      id,
      nodeId: repoGlobalId(id),
      owner,
      name,
      fullName: key,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdSeq,
      updatedSeq: createdSeq,
      labels: new Map(),
      labelSeq: 0,
      issues: [],
      issuesByNumber: new Map(),
      pulls: [],
      pullsByNumber: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      refs: new Map(),
      objects: new Map(),
      commitCache: new Map(),
      treeCache: new Map(),
      flatCache: new Map(),
      packCache: new Map(),
      fetchCache: new Map(),
      advCache: new Map(),
      lsCache: new Map(),
      json: null,
      buf: null,
    };
    this.repos.set(key, repo);
    this.reposById.set(id, repo);
    this.repoList.push(repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  getRepoById(id: number): Repo | undefined {
    return this.reposById.get(id);
  }

  deleteRepo(owner: string, name: string): boolean {
    const key = `${owner}/${name}`;
    const repo = this.repos.get(key);
    if (!repo) return false;
    this.repos.delete(key);
    this.reposById.delete(repo.id);
    const at = this.repoList.indexOf(repo);
    if (at >= 0) this.repoList.splice(at, 1);
    return true;
  }

  listReposByOwner(owner: string): Repo[] {
    return this.repoList.filter((repo) => repo.owner === owner);
  }

  // ------------------------------------------------------------- git objects

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  commitOf(repo: Repo, oid: string): CommitView | null {
    const cached = repo.commitCache.get(oid);
    if (cached) return cached;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') return null;
    const parsed = parseCommit(object.data);
    repo.commitCache.set(oid, parsed);
    return parsed;
  }

  treeOf(repo: Repo, oid: string): TreeEntry[] | null {
    const cached = repo.treeCache.get(oid);
    if (cached) return cached;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'tree') return null;
    const parsed = parseTree(object.data);
    repo.treeCache.set(oid, parsed);
    return parsed;
  }

  /** A tree flattened to path -> {oid, mode}, cached per tree oid. */
  flatTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const cached = repo.flatCache.get(treeOid);
    if (cached) return cached;
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const entries = this.treeOf(repo, oid);
      if (!entries) return;
      for (const entry of entries) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    repo.flatCache.set(treeOid, out);
    return out;
  }

  /** All objects reachable from `roots` (full closure). */
  reachable(repo: Repo, roots: Iterable<string>): Set<string> {
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
        const commit = this.commitOf(repo, oid);
        if (!commit) continue;
        queue.push(commit.tree);
        for (const parent of commit.parents) queue.push(parent);
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        const entries = this.treeOf(repo, oid);
        if (!entries) continue;
        for (const entry of entries) if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
    return seen;
  }

  /** True when `ancestor` is reachable from `tip` (or equal to it). */
  isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    if (ancestor === ZERO_OID) return true;
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const commit = this.commitOf(repo, oid);
      if (!commit) continue;
      for (const parent of commit.parents) queue.push(parent);
    }
    return false;
  }

  /** The merge-base of two tips: the first common ancestor found walking B's history. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const inA = new Set<string>();
    const queueA = [a];
    while (queueA.length > 0) {
      const oid = queueA.pop()!;
      if (inA.has(oid)) continue;
      inA.add(oid);
      const commit = this.commitOf(repo, oid);
      if (!commit) continue;
      for (const parent of commit.parents) queueA.push(parent);
    }
    const queueB = [b];
    const seenB = new Set<string>();
    while (queueB.length > 0) {
      const oid = queueB.pop()!;
      if (inA.has(oid)) return oid;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      const commit = this.commitOf(repo, oid);
      if (!commit) continue;
      for (const parent of commit.parents) queueB.push(parent);
    }
    return null;
  }

  /** Commits reachable from `tip`, newest first (depth-first, parents in order). */
  commitsFrom(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (oid === ZERO_OID || seen.has(oid)) continue;
      seen.add(oid);
      const commit = this.commitOf(repo, oid);
      if (!commit) continue;
      out.push(oid);
      for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i]!);
    }
    return out;
  }

  /** Build a tree from a flat path map, creating intermediate tree objects. */
  buildTreeFromMap(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of flat) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i]!;
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name)!;
      }
      node.files.set(segments[segments.length - 1]!, entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** Diff two trees (flat maps) into changed paths. */
  diffTrees(repo: Repo, oldTree: string, newTree: string): Array<{ path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }> {
    const oldMap = oldTree === ZERO_OID ? new Map() : this.flatTree(repo, oldTree);
    const newMap = newTree === ZERO_OID ? new Map() : this.flatTree(repo, newTree);
    const out: Array<{ path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }> = [];
    const paths = new Set([...oldMap.keys(), ...newMap.keys()]);
    for (const path of [...paths].sort()) {
      const oldEntry = oldMap.get(path);
      const newEntry = newMap.get(path);
      if (oldEntry && !newEntry) out.push({ path, status: 'removed', oldOid: oldEntry.oid, newOid: null });
      else if (!oldEntry && newEntry) out.push({ path, status: 'added', oldOid: null, newOid: newEntry.oid });
      else if (oldEntry && newEntry && oldEntry.oid !== newEntry.oid) out.push({ path, status: 'modified', oldOid: oldEntry.oid, newOid: newEntry.oid });
    }
    return out;
  }

  /** Line counts for a diff: additions = lines in new not in old (multiset), deletions the reverse. */
  lineDiff(repo: Repo, oldOid: string | null, newOid: string | null): { additions: number; deletions: number } {
    const oldText = oldOid === null ? '' : (repo.objects.get(oldOid)?.data.toString('utf8') ?? '');
    const newText = newOid === null ? '' : (repo.objects.get(newOid)?.data.toString('utf8') ?? '');
    const oldLines = oldText === '' ? [] : oldText.split('\n');
    const newLines = newText === '' ? [] : newText.split('\n');
    const oldCount = new Map<string, number>();
    for (const line of oldLines) oldCount.set(line, (oldCount.get(line) ?? 0) + 1);
    let additions = 0;
    const remaining = new Map(oldCount);
    for (const line of newLines) {
      const left = remaining.get(line) ?? 0;
      if (left > 0) remaining.set(line, left - 1);
      else additions += 1;
    }
    let deletions = 0;
    for (const left of remaining.values()) deletions += left;
    return { additions, deletions };
  }

  /** A commit on `branch` (creating the branch from `baseRef` when it does not exist). */
  commitOnBranch(repo: Repo, branch: string, message: string, mutate: (flat: Map<string, { oid: string; mode: string }>) => void): { sha: string; tree: string } | null {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    let baseTree = '';
    const parents: string[] = [];
    if (tip !== undefined && tip !== ZERO_OID) {
      const commit = this.commitOf(repo, tip);
      if (!commit) return null;
      baseTree = commit.tree;
      parents.push(tip);
    } else if (branch !== repo.defaultBranch) {
      const baseTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (baseTip !== undefined && baseTip !== ZERO_OID) {
        const commit = this.commitOf(repo, baseTip);
        if (!commit) return null;
        baseTree = commit.tree;
        parents.push(baseTip);
      }
    }
    const flat = baseTree === '' ? new Map<string, { oid: string; mode: string }>() : new Map(this.flatTree(repo, baseTree));
    mutate(flat);
    const tree = this.buildTreeFromMap(repo, flat);
    const who = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
    const bytes = buildCommitBytes({ tree, parents, message, author: who, committer: who, timestamp: this.gitTs() });
    const sha = this.putObject(repo, 'commit', bytes);
    repo.refs.set(ref, sha);
    this.invalidateGit(repo);
    return { sha, tree };
  }

  /** Clear the per-repo git caches after a ref or object change. */
  invalidateGit(repo: Repo): void {
    repo.packCache.clear();
    repo.fetchCache.clear();
    repo.advCache.clear();
    repo.lsCache.clear();
  }

  // ------------------------------------------------------------- labels

  createLabel(repo: Repo, name: string, color: string): Label {
    const existing = repo.labels.get(name);
    if (existing) return existing;
    const id = ++repo.labelSeq;
    const label: Label = { id, nodeId: `L_${b64url(`Label:${repo.id}:${id}`)}`, name, color: color || 'ededed', description: '' };
    repo.labels.set(name, label);
    return label;
  }

  labelJson(label: Label, repo: Repo): Record<string, unknown> {
    return { id: label.id, node_id: label.nodeId, url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`, name: label.name, color: label.color, default: false, description: label.description };
  }

  // ------------------------------------------------------------- issues

  createIssue(repo: Repo, title: string, body: string, labelNames: string[]): Issue | { error: string } {
    const labels: Label[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name);
      if (!label) return { error: `Label "${name}" does not exist` };
      labels.push(label);
    }
    const number = repo.nextNumber++;
    const id = this.nextIssueId++;
    const createdSeq = ++this.seq;
    const issue: Issue = {
      id,
      nodeId: issueGlobalId(repo.id, number),
      number,
      title,
      body: body ?? '',
      state: 'open',
      labels,
      comments: [],
      createdSeq,
      updatedSeq: createdSeq,
      closedSeq: 0,
      json: null,
      buf: null,
    };
    repo.issues.push(issue);
    repo.issuesByNumber.set(number, issue);
    return issue;
  }

  issueJson(repo: Repo, issue: Issue): string {
    if (issue.json !== null) return issue.json;
    const body = {
      id: issue.id,
      node_id: issue.nodeId,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
      repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
      labels_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels{/name}`,
      comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
      events_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/events`,
      html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
      number: issue.number,
      state: issue.state,
      title: issue.title,
      body: issue.body,
      user: userJson(VIEWER_LOGIN, VIEWER_ID),
      labels: issue.labels.map((label) => this.labelJson(label, repo)),
      assignee: null,
      assignees: [],
      locked: false,
      comments: issue.comments.length,
      created_at: this.stampAt(issue.createdSeq),
      updated_at: this.stampAt(issue.updatedSeq),
      closed_at: issue.closedSeq === 0 ? null : this.stampAt(issue.closedSeq),
      author_association: 'OWNER',
      state_reason: null,
    };
    issue.json = JSON.stringify(body);
    issue.buf = Buffer.from(issue.json);
    return issue.json;
  }

  /** The issue body as bytes, built once alongside the string. */
  issueJsonBuf(repo: Repo, issue: Issue): Buffer {
    if (issue.buf === null) this.issueJson(repo, issue);
    return issue.buf!;
  }

  issueObject(repo: Repo, issue: Issue): Record<string, unknown> {
    return JSON.parse(this.issueJson(repo, issue)) as Record<string, unknown>;
  }

  listIssues(repo: Repo, state: string, sort: string, direction: string): Issue[] {
    let list = repo.issues;
    if (state === 'open') list = list.filter((issue) => issue.state === 'open');
    else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
    const sorted = [...list];
    if (sort === 'created') {
      sorted.sort((a, b) => (direction === 'desc' ? b.number - a.number : a.number - b.number));
    } else {
      sorted.sort((a, b) => (direction === 'desc' ? b.number - a.number : a.number - b.number));
    }
    return sorted;
  }

  patchIssue(repo: Repo, issue: Issue, fields: { state?: string; title?: string; body?: string }): void {
    if (fields.state === 'closed' && issue.state !== 'closed') {
      issue.state = 'closed';
      issue.closedSeq = ++this.seq;
    } else if (fields.state === 'open' && issue.state !== 'open') {
      issue.state = 'open';
      issue.closedSeq = 0;
    }
    if (typeof fields.title === 'string') issue.title = fields.title;
    if (typeof fields.body === 'string') issue.body = fields.body;
    issue.updatedSeq = ++this.seq;
    issue.json = null;
    issue.buf = null;
  }

  addComment(repo: Repo, issue: Issue, body: string): Comment {
    const id = this.nextCommentId++;
    const createdSeq = ++this.seq;
    const comment: Comment = {
      id,
      nodeId: commentGlobalId(repo.id, issue.number, id),
      body,
      createdSeq,
      updatedSeq: createdSeq,
      issueNumber: issue.number,
    };
    issue.comments.push(comment);
    issue.updatedSeq = ++this.seq;
    issue.json = null;
    issue.buf = null;
    return comment;
  }

  commentJson(repo: Repo, comment: Comment): Record<string, unknown> {
    return {
      id: comment.id,
      node_id: comment.nodeId,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
      html_url: `/${repo.owner}/${repo.name}/issues/${comment.issueNumber}#issuecomment-${comment.id}`,
      body: comment.body,
      user: userJson(VIEWER_LOGIN, VIEWER_ID),
      created_at: this.stampAt(comment.createdSeq),
      updated_at: this.stampAt(comment.updatedSeq),
      issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${comment.issueNumber}`,
      author_association: 'OWNER',
    };
  }

  // ------------------------------------------------------------- pull requests

  createPR(repo: Repo, title: string, body: string, head: string, base: string): PullRequest | { error: string } {
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (headSha === undefined) return { error: `head branch "${head}" does not exist` };
    if (baseSha === undefined) return { error: `base branch "${base}" does not exist` };
    const number = repo.nextNumber++;
    const id = this.nextIssueId++;
    const createdSeq = ++this.seq;
    const pr: PullRequest = {
      id,
      nodeId: prGlobalId(repo.id, number),
      number,
      title,
      body: body ?? '',
      state: 'open',
      merged: false,
      mergeable: null,
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      mergeCommitSha: null,
      createdSeq,
      updatedSeq: createdSeq,
      closedSeq: 0,
      mergedSeq: 0,
      files: null,
      additions: 0,
      deletions: 0,
      json: null,
      buf: null,
    };
    repo.pulls.push(pr);
    repo.pullsByNumber.set(number, pr);
    return pr;
  }

  /** The changed files of a PR, computed from base tip vs head tip and cached on the PR. */
  prFiles(repo: Repo, pr: PullRequest): PullFile[] {
    if (pr.files !== null) return pr.files;
    const baseCommit = this.commitOf(repo, pr.baseSha);
    const headCommit = this.commitOf(repo, pr.headSha);
    const files: PullFile[] = [];
    let additions = 0;
    let deletions = 0;
    if (baseCommit && headCommit) {
      const changes = this.diffTrees(repo, baseCommit.tree, headCommit.tree);
      for (const change of changes) {
        const counts = this.lineDiff(repo, change.oldOid, change.newOid);
        additions += counts.additions;
        deletions += counts.deletions;
        files.push({ filename: change.path, status: change.status, additions: counts.additions, deletions: counts.deletions, changes: counts.additions + counts.deletions });
      }
    }
    pr.files = files;
    pr.additions = additions;
    pr.deletions = deletions;
    return files;
  }

  /** Whether a PR can merge cleanly (same three-way check the merge uses). */
  prMergeable(repo: Repo, pr: PullRequest): boolean {
    if (pr.mergeable !== null) return pr.mergeable;
    pr.mergeable = !this.prConflicts(repo, pr);
    return pr.mergeable;
  }

  prConflicts(repo: Repo, pr: PullRequest): boolean {
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
    const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
    if (baseTip === undefined || headTip === undefined) return true;
    if (baseTip === pr.baseSha && headTip === pr.headSha) {
      // unchanged since creation: compare against the creation base
    }
    const base = this.mergeBase(repo, headTip, baseTip);
    if (base === null) return true;
    const baseCommit = this.commitOf(repo, base);
    const headCommit = this.commitOf(repo, headTip);
    const baseTipCommit = this.commitOf(repo, baseTip);
    if (!baseCommit || !headCommit || !baseTipCommit) return true;
    const headChanges = new Map(this.diffTrees(repo, baseCommit.tree, headCommit.tree).map((c) => [c.path, c]));
    const baseChanges = new Map(this.diffTrees(repo, baseCommit.tree, baseTipCommit.tree).map((c) => [c.path, c]));
    for (const [path, headChange] of headChanges) {
      const baseChange = baseChanges.get(path);
      if (!baseChange) continue;
      if (headChange.newOid !== baseChange.newOid) return true;
    }
    return false;
  }

  /** Squash-merge a PR onto its base branch. */
  mergePR(repo: Repo, pr: PullRequest): { sha: string } | { error: string; status: number } {
    if (pr.state !== 'open') return { error: 'pull request is not open', status: 405 };
    if (this.prConflicts(repo, pr)) return { error: 'merge conflict', status: 405 };
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`)!;
    const headTip = repo.refs.get(`refs/heads/${pr.headRef}`)!;
    const base = this.mergeBase(repo, headTip, baseTip);
    const baseCommit = this.commitOf(repo, baseTip)!;
    const headCommit = this.commitOf(repo, headTip)!;
    const baseBaseCommit = base === null ? null : this.commitOf(repo, base);
    const flat = new Map(this.flatTree(repo, baseCommit.tree));
    const changes = baseBaseCommit ? this.diffTrees(repo, baseBaseCommit.tree, headCommit.tree) : this.diffTrees(repo, '', headCommit.tree);
    for (const change of changes) {
      if (change.newOid === null) flat.delete(change.path);
      else flat.set(change.path, { oid: change.newOid, mode: '100644' });
    }
    const tree = this.buildTreeFromMap(repo, flat);
    const who = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
    const message = `Merge pull request #${pr.number} from ${repo.owner}/${pr.headRef}\n\n${pr.title}`;
    const bytes = buildCommitBytes({ tree, parents: [baseTip], message, author: who, committer: who, timestamp: this.gitTs() });
    const sha = this.putObject(repo, 'commit', bytes);
    repo.refs.set(`refs/heads/${pr.baseRef}`, sha);
    this.invalidateGit(repo);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergeCommitSha = sha;
    pr.mergedSeq = ++this.seq;
    pr.closedSeq = pr.mergedSeq;
    pr.updatedSeq = pr.mergedSeq;
    pr.json = null;
    pr.buf = null;
    return { sha };
  }

  prJson(repo: Repo, pr: PullRequest): string {
    if (pr.json !== null) return pr.json;
    this.prFiles(repo, pr);
    const headRepo = { id: repo.id, node_id: repo.nodeId, name: repo.name, full_name: repo.fullName, owner: userJson(repo.owner, VIEWER_ID) };
    const body = {
      id: pr.id,
      node_id: pr.nodeId,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
      html_url: `/${repo.owner}/${repo.name}/pull/${pr.number}`,
      diff_url: `/${repo.owner}/${repo.name}/pull/${pr.number}.diff`,
      patch_url: `/${repo.owner}/${repo.name}/pull/${pr.number}.patch`,
      issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${pr.number}`,
      number: pr.number,
      state: pr.state,
      locked: false,
      title: pr.title,
      body: pr.body,
      created_at: this.stampAt(pr.createdSeq),
      updated_at: this.stampAt(pr.updatedSeq),
      closed_at: pr.closedSeq === 0 ? null : this.stampAt(pr.closedSeq),
      merged_at: pr.mergedSeq === 0 ? null : this.stampAt(pr.mergedSeq),
      merge_commit_sha: pr.mergeCommitSha,
      mergeable: this.prMergeable(repo, pr),
      mergeable_state: this.prMergeable(repo, pr) ? 'clean' : 'dirty',
      merged: pr.merged,
      merged_by: null,
      user: userJson(VIEWER_LOGIN, VIEWER_ID),
      head: { label: `${repo.owner}:${pr.headRef}`, ref: pr.headRef, sha: pr.headSha, user: userJson(repo.owner, VIEWER_ID), repo: headRepo },
      base: { label: `${repo.owner}:${pr.baseRef}`, ref: pr.baseRef, sha: pr.baseSha, user: userJson(repo.owner, VIEWER_ID), repo: headRepo },
      author_association: 'OWNER',
      draft: false,
      commits: 1,
      additions: pr.additions,
      deletions: pr.deletions,
      changed_files: pr.files?.length ?? 0,
      comments: 0,
      review_comments: 0,
      maintainer_can_modify: false,
    };
    pr.json = JSON.stringify(body);
    pr.buf = Buffer.from(pr.json);
    return pr.json;
  }

  /** The pull request body as bytes, built once alongside the string. */
  prJsonBuf(repo: Repo, pr: PullRequest): Buffer {
    if (pr.buf === null) this.prJson(repo, pr);
    return pr.buf!;
  }

  prObject(repo: Repo, pr: PullRequest): Record<string, unknown> {
    return JSON.parse(this.prJson(repo, pr)) as Record<string, unknown>;
  }

  listPRs(repo: Repo, state: string): PullRequest[] {
    if (state === 'all') return [...repo.pulls];
    if (state === 'closed') return repo.pulls.filter((pr) => pr.state === 'closed');
    return repo.pulls.filter((pr) => pr.state === 'open');
  }

  // ------------------------------------------------------------- repo JSON

  repoJson(repo: Repo): string {
    if (repo.json !== null) return repo.json;
    const openIssues = repo.issues.filter((issue) => issue.state === 'open').length + repo.pulls.filter((pr) => pr.state === 'open').length;
    const body = {
      id: repo.id,
      node_id: repo.nodeId,
      name: repo.name,
      full_name: repo.fullName,
      owner: userJson(repo.owner, VIEWER_ID),
      private: repo.private,
      html_url: `/${repo.owner}/${repo.name}`,
      description: repo.description,
      fork: false,
      url: `/api/v3/repos/${repo.owner}/${repo.name}`,
      created_at: this.stampAt(repo.createdSeq),
      updated_at: this.stampAt(repo.updatedSeq),
      pushed_at: this.stampAt(repo.updatedSeq),
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
      mirror_url: null,
      archived: false,
      disabled: false,
      open_issues_count: openIssues,
      license: null,
      allow_forking: true,
      is_template: false,
      topics: [],
      visibility: repo.private ? 'private' : 'public',
      default_branch: repo.defaultBranch,
      permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    };
    repo.json = JSON.stringify(body);
    repo.buf = Buffer.from(repo.json);
    return repo.json;
  }

  /** The repository body as bytes, built once alongside the string. */
  repoJsonBuf(repo: Repo): Buffer {
    if (repo.buf === null) this.repoJson(repo);
    return repo.buf!;
  }

  repoObject(repo: Repo): Record<string, unknown> {
    return JSON.parse(this.repoJson(repo)) as Record<string, unknown>;
  }

  touchRepo(repo: Repo): void {
    repo.updatedSeq = ++this.seq;
    repo.json = null;
    repo.buf = null;
  }
}

export function sha1Of(data: Buffer): string {
  return sha1Hex(data);
}
