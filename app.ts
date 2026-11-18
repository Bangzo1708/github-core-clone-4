// The HTTP layer: one server, four surfaces. Routing is a manual path split
// (no URL object per request), the body is read once, and the bearer token
// from MAKEFUN_SHOP_TOKEN gates the git, REST and GraphQL surfaces; MCP only
// gates tools/call (its handshake answers without a token).
//
//   GET  /healthz                                  -> 200 {"ok":true}
//   /api/v3/...                                    -> REST v3
//   POST /api/graphql                             -> GraphQL
//   POST /mcp                                     -> MCP
//   /{owner}/{repo}.git/info/refs                 -> git advertisements
//   /{owner}/{repo}.git/git-upload-pack           -> git fetch (v2 or v0)
//   /{owner}/{repo}.git/git-receive-pack          -> git push (v0)

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Store } from './store.ts';
import { handleRest } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  lsRefsResponse,
  parseFetchArgs,
  parseLsRefsArgs,
  parsePktLines,
  v0FetchResponse,
  v0ReceiveAdvertisement,
  v0UploadAdvertisement,
  v2Advertisement,
  v2FetchResponse,
  handleReceivePack,
  pktLine,
  pktWithSideband,
  FLUSH,
} from './gitwire.ts';
import { sendError, sendJson, sendRaw } from './respond.ts';

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** Shared empty query set, so requests without a query string skip parsing. */
const EMPTY_QUERY = new URLSearchParams('');

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  if (header.startsWith('Bearer ')) return header.slice('Bearer '.length);
  if (header.startsWith('token ')) return header.slice('token '.length);
  return null;
}

function authenticated(req: IncomingMessage): boolean {
  const token = bearerToken(req);
  if (token === null || token === '') return false;
  if (SHOP_TOKEN === '') return true;
  return token === SHOP_TOKEN;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function splitPath(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      if (!segment.includes('%')) return segment;
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

export function createForgeServer(store: Store) {
  let requestCounter = 0;

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        sendError(res, 500, error instanceof Error ? error.message : 'internal error', `req-${++requestCounter}`);
      } else {
        res.end();
      }
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = `req-${++requestCounter}`;
    const method = req.method ?? 'GET';
    const rawUrl = req.url ?? '/';
    const question = rawUrl.indexOf('?');
    const pathname = question < 0 ? rawUrl : rawUrl.slice(0, question);
    const query = question < 0 ? EMPTY_QUERY : new URLSearchParams(rawUrl.slice(question + 1));

    if (pathname === '/healthz') {
      return sendJson(res, 200, '{"ok":true}', { requestId });
    }

    const segments = splitPath(pathname);

    // REST v3.
    if (segments[0] === 'api' && segments[1] === 'v3') {
      if (!authenticated(req)) return sendError(res, 401, 'Requires authentication', requestId);
      let body: unknown = null;
      if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
        const raw = await readBody(req);
        if (raw.length > 0) {
          try {
            body = JSON.parse(raw.toString('utf8')) as unknown;
          } catch {
            return sendError(res, 400, 'Invalid JSON', requestId);
          }
        }
      }
      handleRest({ store, segments: segments.slice(2), query, body, host: req.headers.host ?? '127.0.0.1', requestId, res }, method);
      return;
    }

    // GraphQL.
    if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
      if (method !== 'POST') return sendError(res, 404, 'Not Found', requestId);
      if (!authenticated(req)) return sendError(res, 401, 'Requires authentication', requestId);
      const raw = await readBody(req);
      let body: unknown;
      try {
        body = raw.length === 0 ? {} : JSON.parse(raw.toString('utf8'));
      } catch {
        return sendJson(res, 400, { errors: [{ message: 'Invalid JSON' }] }, { requestId });
      }
      const result = executeGraphQL(store, body);
      return sendJson(res, 200, result, { requestId });
    }

    // MCP.
    if (segments.length === 1 && segments[0] === 'mcp') {
      if (method !== 'POST') return sendError(res, 404, 'Not Found', requestId);
      const raw = await readBody(req);
      let body: unknown;
      try {
        body = raw.length === 0 ? {} : JSON.parse(raw.toString('utf8'));
      } catch {
        return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, { requestId });
      }
      handleMcp(store, body, authenticated(req), res);
      return;
    }

    // Git smart HTTP: /{owner}/{repo}.git/...
    if (segments.length >= 2 && segments[1]!.endsWith('.git')) {
      if (!authenticated(req)) return sendError(res, 401, 'Requires authentication', requestId);
      const owner = segments[0]!;
      const repoName = segments[1]!.slice(0, -'.git'.length);
      const repo = store.getRepo(owner, repoName);
      if (!repo) return sendError(res, 404, 'Not Found', requestId);
      const tail = segments.slice(2);

      if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
        const service = query.get('service') ?? '';
        const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
        if (service === 'git-upload-pack') {
          const ad = wantsV2 ? v2Advertisement() : v0UploadAdvertisement(repo);
          return sendRaw(res, 200, ad, 'application/x-git-upload-pack-advertisement', { requestId });
        }
        if (service === 'git-receive-pack') {
          return sendRaw(res, 200, v0ReceiveAdvertisement(repo), 'application/x-git-receive-pack-advertisement', { requestId });
        }
        return sendError(res, 404, 'Not Found', requestId);
      }

      if (method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
        const raw = await readBody(req);
        const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
        try {
          const packets = parsePktLines(raw);
          const command = packets.find((packet) => packet.kind === 'line')?.payload.toString('utf8').trim() ?? '';
          if (wantsV2 && command === 'command=ls-refs') {
            return sendRaw(res, 200, lsRefsResponse(repo, parseLsRefsArgs(packets)), 'application/x-git-upload-pack-result', { requestId });
          }
          if (wantsV2 && command === 'command=fetch') {
            return sendRaw(res, 200, v2FetchResponse(store, repo, parseFetchArgs(packets)), 'application/x-git-upload-pack-result', { requestId });
          }
          if (!wantsV2) {
            return sendRaw(res, 200, v0FetchResponse(store, repo, parseFetchArgs(packets)), 'application/x-git-upload-pack-result', { requestId });
          }
          return sendError(res, 400, 'unknown command', requestId);
        } catch {
          // A malformed fetch must not take the server down.
          return sendRaw(res, 200, Buffer.concat([pktLine('NAK\n'), FLUSH]), 'application/x-git-upload-pack-result', { requestId });
        }
      }

      if (method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
        const raw = await readBody(req);
        try {
          const result = handleReceivePack(store, repo, raw);
          return sendRaw(res, result.status, result.body, 'application/x-git-receive-pack-result', { requestId });
        } catch {
          // Even on failure the report must stay sideband-framed.
          const report = Buffer.concat([pktLine('unpack error\n'), pktLine(`ng refs/heads/${repo.defaultBranch} unpack failed\n`)]);
          const wrapped = Buffer.concat([pktWithSideband(1, report), FLUSH]);
          return sendRaw(res, 200, wrapped, 'application/x-git-receive-pack-result', { requestId });
        }
      }

      return sendError(res, 404, 'Not Found', requestId);
    }

    return sendError(res, 404, 'Not Found', requestId);
  }

  return server;
}
