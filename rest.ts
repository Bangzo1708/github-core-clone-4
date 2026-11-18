// The REST v3 API. One handler per route family, all served from the same
// store as the git, GraphQL and MCP layers.
//
// Conventions that matter to the suite: every reply is JSON and carries
// X-GitHub-Request-Id; errors are `{message: string}`; a repo under a
// different owner is a 404, never a 403; issue and pull request numbers share
// one per-repo sequence; commit messages in REST views carry no trailing
// newline; the issue/PR JSON bodies are cached strings on the store objects,
// so the read workload serves them without re-serializing.

import type { ServerResponse } from 'node:http';
import type { Repo, Store } from './store.ts';
import { VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME, isOid } from './store.ts';
import { sendError, sendJson, sendJsonBuf, sendNoContent } from './respond.ts';

export interface RestContext {
  store: Store;
  /** Path segments below /api/v3 (already URL-decoded). */
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  host: string;
  requestId: string;
  res: ServerResponse;
}

function bodyObject(ctx: RestContext): Record<string, unknown> {
  const body = ctx.body;
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  return {};
}

/** Join already-serialized JSON bodies into a JSON array, as bytes. */
function joinJsonBuffers(parts: Buffer[]): Buffer {
  if (parts.length === 0) return Buffer.from('[]', 'ascii');
  const chunks: Buffer[] = [Buffer.from('[', 'ascii')];
  for (let i = 0; i < parts.length; i += 1) {
    if (i > 0) chunks.push(Buffer.from(',', 'ascii'));
    chunks.push(parts[i]!);
  }
  chunks.push(Buffer.from(']', 'ascii'));
  return Buffer.concat(chunks);
}

function repoOr404(ctx: RestContext, owner: string, name: string): Repo | null {
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) {
    sendError(ctx.res, 404, 'Not Found', ctx.requestId);
    return null;
  }
  return repo;
}

function parseNumber(text: string): number | null {
  const n = Number(text);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function viewerUser(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: `U_${Buffer.from(`User:${VIEWER_ID}`, 'utf8').toString('base64url')}`,
    avatar_url: '',
    gravatar_id: '',
    url: '/api/v3/user',
    html_url: `/${VIEWER_LOGIN}`,
    type: 'User',
    site_admin: false,
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
    public_repos: 0,
    followers: 0,
    following: 0,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

function commitPerson(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!match) return { name: line, email: '', date: '2025-01-01T00:00:00Z' };
  return {
    name: match[1]!,
    email: match[2]!,
    date: new Date(Number(match[3]!) * 1000).toISOString(),
  };
}

function commitJson(store: Store, repo: Repo, oid: string): Record<string, unknown> | null {
  const commit = store.commitOf(repo, oid);
  if (!commit) return null;
  const author = commitPerson(commit.author);
  const committer = commitPerson(commit.committer);
  const message = commit.message.endsWith('\n') ? commit.message.slice(0, -1) : commit.message;
  return {
    sha: oid,
    node_id: `C_${Buffer.from(`Commit:${repo.id}:${oid}`, 'utf8').toString('base64url')}`,
    commit: {
      author,
      committer,
      message,
      tree: { sha: commit.tree, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${commit.tree}` },
      url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${oid}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null, verified_at: null },
    },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
    html_url: `/${repo.owner}/${repo.name}/commit/${oid}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}/comments`,
    author: null,
    committer: null,
    parents: commit.parents.map((parent) => ({
      sha: parent,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${parent}`,
      html_url: `/${repo.owner}/${repo.name}/commit/${parent}`,
    })),
  };
}

function resolveRef(store: Store, repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  if (isOid(ref)) return store.getObject(repo, ref) ? ref : null;
  if (ref.startsWith('refs/')) return repo.refs.get(ref) ?? null;
  return repo.refs.get(`refs/heads/${ref}`) ?? null;
}

/** The contents of a path inside a tree, or null when the path does not exist. */
function lookupPath(
  store: Store,
  repo: Repo,
  treeOid: string,
  segments: string[],
): { kind: 'file' | 'dir'; oid: string; name: string; path: string } | null {
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const entries = store.treeOf(repo, current);
    if (!entries) return null;
    const entry = entries.find((candidate) => candidate.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) {
      return {
        kind: entry.mode === '40000' ? 'dir' : 'file',
        oid: entry.oid,
        name: entry.name,
        path: segments.join('/'),
      };
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return { kind: 'dir', oid: treeOid, name: '', path: '' };
}

function contentsFileJson(store: Store, repo: Repo, found: { oid: string; name: string; path: string }): Record<string, unknown> {
  const object = store.getObject(repo, found.oid);
  const data = object?.data ?? Buffer.alloc(0);
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name: found.name,
    path: found.path,
    content: data.toString('base64'),
    sha: found.oid,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${found.path}`,
    git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${found.oid}`,
    html_url: `/${repo.owner}/${repo.name}/blob/HEAD/${found.path}`,
    download_url: null,
    _links: { git: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${found.oid}`, self: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${found.path}`, html: `/${repo.owner}/${repo.name}/blob/HEAD/${found.path}` },
  };
}

function contentsDirJson(store: Store, repo: Repo, found: { oid: string; path: string }): Array<Record<string, unknown>> {
  const entries = store.treeOf(repo, found.oid) ?? [];
  return entries.map((entry) => ({
    type: entry.mode === '40000' ? 'dir' : 'file',
    size: entry.mode === '40000' ? 0 : (store.getObject(repo, entry.oid)?.data.length ?? 0),
    name: entry.name,
    path: found.path === '' ? entry.name : `${found.path}/${entry.name}`,
    sha: entry.oid,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${found.path === '' ? entry.name : `${found.path}/${entry.name}`}`,
    git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${entry.mode === '40000' ? 'trees' : 'blobs'}/${entry.oid}`,
    html_url: `/${repo.owner}/${repo.name}/${entry.mode === '40000' ? 'tree' : 'blob'}/HEAD/${found.path === '' ? entry.name : `${found.path}/${entry.name}`}`,
    download_url: null,
    _links: { git: '', self: '', html: '' },
  }));
}

function commitSummary(store: Store, repo: Repo, sha: string, message: string): Record<string, unknown> {
  const commit = store.commitOf(repo, sha);
  const author = commit ? commitPerson(commit.author) : { name: VIEWER_NAME, email: VIEWER_EMAIL, date: '2025-01-01T00:00:00Z' };
  return {
    sha,
    node_id: `C_${Buffer.from(`Commit:${repo.id}:${sha}`, 'utf8').toString('base64url')}`,
    message: message.endsWith('\n') ? message.slice(0, -1) : message,
    author,
    committer: author,
    parents: commit ? commit.parents.map((parent) => ({ sha: parent })) : [],
    url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}`,
    html_url: `/${repo.owner}/${repo.name}/commit/${sha}`,
  };
}

export function handleRest(ctx: RestContext, method: string): void {
  const { store, segments: seg, res } = ctx;
  const rid = ctx.requestId;

  // GET /api/v3/ — the service root.
  if (seg.length === 0) {
    if (method !== 'GET') return sendError(res, 404, 'Not Found', rid);
    return sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      current_user_authorizations_html_url: '',
      authorizations_url: '',
      code_search_url: '',
      commit_search_url: '',
      emails_url: '/api/v3/user/emails',
      emojis_url: '',
      events_url: '',
      feeds_url: '',
      followers_url: '',
      following_url: '',
      gists_url: '',
      hub_url: '',
      issue_search_url: '',
      issues_url: '',
      keys_url: '',
      labels_url: '',
      notifications_url: '',
      organizations_url: '',
      public_gists_url: '',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      repository_search_url: '',
      current_user_repositories_url: '/api/v3/user/repos',
      user_url: '/api/v3/users/{user}',
      user_organizations_url: '',
      user_repositories_url: '',
      user_search_url: '',
    }, { requestId: rid, headers: { 'X-OAuth-Scopes': 'repo, user' } });
  }

  // GET /api/v3/meta
  if (seg.length === 1 && seg[0] === 'meta') {
    if (method !== 'GET') return sendError(res, 404, 'Not Found', rid);
    return sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: false }, { requestId: rid });
  }

  // GET /api/v3/user and /api/v3/user/repos
  if (seg[0] === 'user') {
    if (seg.length === 1) {
      if (method !== 'GET') return sendError(res, 404, 'Not Found', rid);
      return sendJson(res, 200, viewerUser(), { requestId: rid });
    }
    if (seg.length === 2 && seg[1] === 'repos') {
      if (method === 'GET') {
        const perPage = Math.min(Math.max(Number(ctx.query.get('per_page') ?? '30') || 30, 1), 100);
        const page = Math.max(Number(ctx.query.get('page') ?? '1') || 1, 1);
        const all = store.listReposByOwner(VIEWER_LOGIN);
        const total = all.length;
        const start = (page - 1) * perPage;
        const slice = all.slice(start, start + perPage);
        const body = joinJsonBuffers(slice.map((repo) => store.repoJsonBuf(repo)));
        const headers: Record<string, string> = {};
        const base = `http://${ctx.host}/api/v3/user/repos`;
        const links: string[] = [];
        if (start + perPage < total) links.push(`<${base}?per_page=${perPage}&page=${page + 1}>; rel="next"`);
        if (page > 1) links.push(`<${base}?per_page=${perPage}&page=${page - 1}>; rel="prev"`);
        const lastPage = Math.max(1, Math.ceil(total / perPage));
        if (lastPage > 1) {
          links.push(`<${base}?per_page=${perPage}&page=1>; rel="first"`);
          links.push(`<${base}?per_page=${perPage}&page=${lastPage}>; rel="last"`);
        }
        if (links.length > 0) headers.Link = links.join(', ');
        return sendJsonBuf(res, 200, body, { requestId: rid, headers });
      }
      if (method === 'POST') {
        const body = bodyObject(ctx);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (name === '') return sendError(res, 422, 'name is required', rid);
        const description = typeof body.description === 'string' ? body.description : '';
        const isPrivate = body.private === true;
        const repo = store.createRepo(VIEWER_LOGIN, name, description, isPrivate);
        if (!repo) return sendError(res, 422, 'name already exists on this account', rid);
        return sendJsonBuf(res, 201, store.repoJsonBuf(repo), { requestId: rid });
      }
      return sendError(res, 404, 'Not Found', rid);
    }
    return sendError(res, 404, 'Not Found', rid);
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (seg[0] === 'repos' && seg.length >= 3) {
    const owner = seg[1]!;
    const name = seg[2]!;
    const rest = seg.slice(3);

    // The repo itself: GET / PATCH / DELETE.
    if (rest.length === 0) {
      if (method === 'GET') {
        const repo = repoOr404(ctx, owner, name);
        if (!repo) return;
        return sendJsonBuf(res, 200, store.repoJsonBuf(repo), { requestId: rid });
      }
      if (method === 'PATCH') {
        const repo = repoOr404(ctx, owner, name);
        if (!repo) return;
        const body = bodyObject(ctx);
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.private = body.private;
        store.touchRepo(repo);
        return sendJsonBuf(res, 200, store.repoJsonBuf(repo), { requestId: rid });
      }
      if (method === 'DELETE') {
        const repo = repoOr404(ctx, owner, name);
        if (!repo) return;
        store.deleteRepo(owner, name);
        return sendNoContent(res, rid);
      }
      return sendError(res, 404, 'Not Found', rid);
    }

    const repo = repoOr404(ctx, owner, name);
    if (!repo) return;
    const kind = rest[0]!;

    // Branches.
    if (kind === 'branches') {
      if (rest.length === 1) {
        if (method !== 'GET') return sendError(res, 404, 'Not Found', rid);
        const branches = [...repo.refs.entries()]
          .filter(([ref]) => ref.startsWith('refs/heads/'))
          .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha, url: `/api/v3/repos/${owner}/${name}/commits/${sha}` }, protected: false }))
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        return sendJson(res, 200, branches, { requestId: rid });
      }
      if (rest.length === 2 && method === 'GET') {
        const sha = repo.refs.get(`refs/heads/${rest[1]}`);
        if (sha === undefined) return sendError(res, 404, 'Not Found', rid);
        return sendJson(res, 200, { name: rest[1], commit: { sha, url: `/api/v3/repos/${owner}/${name}/commits/${sha}` }, protected: false }, { requestId: rid });
      }
      return sendError(res, 404, 'Not Found', rid);
    }

    // Commits.
    if (kind === 'commits') {
      if (rest.length === 1 && method === 'GET') {
        const tip = resolveRef(store, repo, ctx.query.get('sha'));
        if (tip === null) return sendJson(res, 200, '[]', { requestId: rid });
        const oids = store.commitsFrom(repo, tip);
        const body = `[${oids.map((oid) => JSON.stringify(commitJson(store, repo, oid))).join(',')}]`;
        return sendJson(res, 200, body, { requestId: rid });
      }
      if (rest.length === 2 && method === 'GET') {
        const oid = rest[1]!;
        const json = commitJson(store, repo, oid);
        if (!json) return sendError(res, 404, 'Not Found', rid);
        return sendJson(res, 200, json, { requestId: rid });
      }
      return sendError(res, 404, 'Not Found', rid);
    }

    // git/refs — create a branch, or read one.
    if (kind === 'git' && rest[1] === 'refs') {
      if (rest.length === 2 && method === 'POST') {
        const body = bodyObject(ctx);
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !isOid(sha)) return sendError(res, 422, 'Invalid ref or sha', rid);
        const object = store.getObject(repo, sha);
        if (!object || (object.type !== 'commit' && object.type !== 'tag')) return sendError(res, 422, 'Invalid sha', rid);
        if (repo.refs.has(ref)) return sendError(res, 422, 'Reference already exists', rid);
        repo.refs.set(ref, sha);
        store.invalidateGit(repo);
        return sendJson(res, 201, {
          ref,
          node_id: `R_${Buffer.from(`Ref:${repo.id}:${ref}`, 'utf8').toString('base64url')}`,
          url: `/api/v3/repos/${owner}/${name}/git/refs/${ref.slice('refs/'.length)}`,
          object: { sha, type: object.type, url: `/api/v3/repos/${owner}/${name}/git/${object.type}s/${sha}` },
        }, { requestId: rid });
      }
      if (rest.length >= 3 && method === 'GET') {
        const ref = `refs/${rest.slice(2).join('/')}`;
        const sha = repo.refs.get(ref);
        if (sha === undefined) return sendError(res, 404, 'Not Found', rid);
        const object = store.getObject(repo, sha);
        return sendJson(res, 200, {
          ref,
          node_id: `R_${Buffer.from(`Ref:${repo.id}:${ref}`, 'utf8').toString('base64url')}`,
          url: `/api/v3/repos/${owner}/${name}/git/refs/${ref.slice('refs/'.length)}`,
          object: { sha, type: object?.type ?? 'commit', url: `/api/v3/repos/${owner}/${name}/git/commits/${sha}` },
        }, { requestId: rid });
      }
      return sendError(res, 404, 'Not Found', rid);
    }

    // Contents.
    if (kind === 'contents') {
      const pathSegments = rest.slice(1);
      const path = pathSegments.join('/');
      if (method === 'GET') {
        const tip = resolveRef(store, repo, ctx.query.get('ref'));
        if (tip === null) return sendError(res, 404, 'Not Found', rid);
        const commit = store.commitOf(repo, tip);
        if (!commit) return sendError(res, 404, 'Not Found', rid);
        if (pathSegments.length === 0) {
          return sendJson(res, 200, contentsDirJson(store, repo, { oid: commit.tree, path: '' }), { requestId: rid });
        }
        const found = lookupPath(store, repo, commit.tree, pathSegments);
        if (!found) return sendError(res, 404, 'Not Found', rid);
        if (found.kind === 'file') return sendJson(res, 200, contentsFileJson(store, repo, found), { requestId: rid });
        return sendJson(res, 200, contentsDirJson(store, repo, found), { requestId: rid });
      }
      if (method === 'PUT') {
        const body = bodyObject(ctx);
        const message = typeof body.message === 'string' ? body.message : 'Update file';
        const content = typeof body.content === 'string' ? body.content : '';
        const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        const sha = typeof body.sha === 'string' ? body.sha : undefined;
        const data = Buffer.from(content, 'base64');
        const tip = repo.refs.get(`refs/heads/${branch}`);
        let existing: { oid: string } | null = null;
        if (tip !== undefined) {
          const commit = store.commitOf(repo, tip);
          if (commit) {
            const found = lookupPath(store, repo, commit.tree, pathSegments);
            if (found && found.kind === 'file') existing = { oid: found.oid };
          }
        }
        if (sha !== undefined) {
          if (!existing || existing.oid !== sha) return sendError(res, 409, 'sha does not match', rid);
        }
        const isUpdate = existing !== null;
        const blobOid = store.putObject(repo, 'blob', data);
        const made = store.commitOnBranch(repo, branch, message, (flat) => {
          flat.set(path, { oid: blobOid, mode: '100644' });
        });
        if (!made) return sendError(res, 422, 'could not create commit', rid);
        store.touchRepo(repo);
        return sendJson(res, isUpdate ? 200 : 201, {
          content: {
            name: pathSegments[pathSegments.length - 1],
            path,
            sha: blobOid,
            size: data.length,
            url: `/api/v3/repos/${owner}/${name}/contents/${path}`,
            git_url: `/api/v3/repos/${owner}/${name}/git/blobs/${blobOid}`,
            html_url: `/${owner}/${name}/blob/${branch}/${path}`,
            download_url: null,
            type: 'file',
            encoding: 'base64',
          },
          commit: commitSummary(store, repo, made.sha, message),
        }, { requestId: rid });
      }
      if (method === 'DELETE') {
        const body = bodyObject(ctx);
        const message = typeof body.message === 'string' ? body.message : 'Delete file';
        const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        const sha = typeof body.sha === 'string' ? body.sha : undefined;
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (tip === undefined) return sendError(res, 404, 'Not Found', rid);
        const commit = store.commitOf(repo, tip);
        if (!commit) return sendError(res, 404, 'Not Found', rid);
        const found = lookupPath(store, repo, commit.tree, pathSegments);
        if (!found || found.kind !== 'file') return sendError(res, 404, 'Not Found', rid);
        if (sha !== undefined && found.oid !== sha) return sendError(res, 409, 'sha does not match', rid);
        const made = store.commitOnBranch(repo, branch, message, (flat) => {
          flat.delete(path);
        });
        if (!made) return sendError(res, 422, 'could not create commit', rid);
        store.touchRepo(repo);
        return sendJson(res, 200, { content: null, commit: commitSummary(store, repo, made.sha, message) }, { requestId: rid });
      }
      return sendError(res, 404, 'Not Found', rid);
    }

    // Labels.
    if (kind === 'labels') {
      if (method === 'GET') {
        return sendJson(res, 200, [...repo.labels.values()].map((label) => store.labelJson(label, repo)), { requestId: rid });
      }
      if (method === 'POST') {
        const body = bodyObject(ctx);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (name === '') return sendError(res, 422, 'name is required', rid);
        const color = typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed';
        const label = store.createLabel(repo, name, color);
        return sendJson(res, 201, store.labelJson(label, repo), { requestId: rid });
      }
      return sendError(res, 404, 'Not Found', rid);
    }

    // Issues.
    if (kind === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          const sort = ctx.query.get('sort') ?? 'created';
          const direction = ctx.query.get('direction') ?? 'desc';
          const list = store.listIssues(repo, state, sort, direction);
          return sendJsonBuf(res, 200, joinJsonBuffers(list.map((issue) => store.issueJsonBuf(repo, issue))), { requestId: rid });
        }
        if (method === 'POST') {
          const body = bodyObject(ctx);
          const title = typeof body.title === 'string' ? body.title : '';
          if (title === '') return sendError(res, 422, 'title is required', rid);
          const bodyText = typeof body.body === 'string' ? body.body : '';
          const rawLabels = Array.isArray(body.labels) ? body.labels : [];
          const labelNames: string[] = [];
          for (const raw of rawLabels) {
            if (typeof raw === 'string') labelNames.push(raw);
            else if (raw !== null && typeof raw === 'object' && typeof (raw as Record<string, unknown>).name === 'string') labelNames.push((raw as Record<string, unknown>).name as string);
          }
          const created = store.createIssue(repo, title, bodyText, labelNames);
          if ('error' in created) return sendError(res, 422, created.error, rid);
          return sendJsonBuf(res, 201, store.issueJsonBuf(repo, created), { requestId: rid });
        }
        return sendError(res, 404, 'Not Found', rid);
      }
      const number = parseNumber(rest[1]!);
      if (number === null) return sendError(res, 404, 'Not Found', rid);
      const issue = repo.issuesByNumber.get(number);
      if (!issue) return sendError(res, 404, 'Not Found', rid);
      if (rest.length === 2) {
        if (method === 'GET') return sendJsonBuf(res, 200, store.issueJsonBuf(repo, issue), { requestId: rid });
        if (method === 'PATCH') {
          const body = bodyObject(ctx);
          store.patchIssue(repo, issue, {
            state: typeof body.state === 'string' ? body.state : undefined,
            title: typeof body.title === 'string' ? body.title : undefined,
            body: typeof body.body === 'string' ? body.body : undefined,
          });
          return sendJsonBuf(res, 200, store.issueJsonBuf(repo, issue), { requestId: rid });
        }
        return sendError(res, 404, 'Not Found', rid);
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'GET') {
          return sendJson(res, 200, issue.comments.map((comment) => store.commentJson(repo, comment)), { requestId: rid });
        }
        if (method === 'POST') {
          const body = bodyObject(ctx);
          const text = typeof body.body === 'string' ? body.body : '';
          if (text === '') return sendError(res, 422, 'body is required', rid);
          const comment = store.addComment(repo, issue, text);
          return sendJson(res, 201, store.commentJson(repo, comment), { requestId: rid });
        }
        return sendError(res, 404, 'Not Found', rid);
      }
      return sendError(res, 404, 'Not Found', rid);
    }

    // Pull requests.
    if (kind === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          const list = store.listPRs(repo, state);
          return sendJsonBuf(res, 200, joinJsonBuffers(list.map((pr) => store.prJsonBuf(repo, pr))), { requestId: rid });
        }
        if (method === 'POST') {
          const body = bodyObject(ctx);
          const title = typeof body.title === 'string' ? body.title : '';
          const head = typeof body.head === 'string' ? body.head : '';
          const base = typeof body.base === 'string' ? body.base : '';
          if (title === '' || head === '' || base === '') return sendError(res, 422, 'title, head and base are required', rid);
          const bodyText = typeof body.body === 'string' ? body.body : '';
          const created = store.createPR(repo, title, bodyText, head, base);
          if ('error' in created) return sendError(res, 422, created.error, rid);
          return sendJsonBuf(res, 201, store.prJsonBuf(repo, created), { requestId: rid });
        }
        return sendError(res, 404, 'Not Found', rid);
      }
      const number = parseNumber(rest[1]!);
      if (number === null) return sendError(res, 404, 'Not Found', rid);
      const pr = repo.pullsByNumber.get(number);
      if (!pr) return sendError(res, 404, 'Not Found', rid);
      if (rest.length === 2) {
        if (method === 'GET') return sendJsonBuf(res, 200, store.prJsonBuf(repo, pr), { requestId: rid });
        return sendError(res, 404, 'Not Found', rid);
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const files = store.prFiles(repo, pr).map((file) => ({
          sha: '',
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
          blob_url: '',
          raw_url: '',
          contents_url: '',
          patch: '',
        }));
        return sendJson(res, 200, files, { requestId: rid });
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        const merged = store.mergePR(repo, pr);
        if ('error' in merged) return sendError(res, merged.status, merged.error, rid);
        return sendJson(res, 200, { sha: merged.sha, merged: true, message: 'Pull request successfully merged' }, { requestId: rid });
      }
      return sendError(res, 404, 'Not Found', rid);
    }

    return sendError(res, 404, 'Not Found', rid);
  }

  return sendError(res, 404, 'Not Found', rid);
}
