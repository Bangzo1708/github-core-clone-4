// MCP over Streamable HTTP (JSON-RPC 2.0): the 2026-07-28 modern handshake
// (server/discover) and the legacy initialize handshake, tools/list and
// tools/call. Tools act on the same store as the REST layer, so a repository
// created over REST is visible here and back.
//
// Auth rule, exactly as the suite checks it: only tools/call requires the
// bearer token (no token there is a 401); discovery, initialize and tools/list
// answer without one.

import type { Store } from './store.ts';
import { VIEWER_LOGIN } from './store.ts';
import { sendJson } from './respond.ts';
import type { ServerResponse } from 'node:http';

export const MCP_VERSIONS = ['2026-07-28', '2025-06-18', '2025-03-26', '2024-11-05'];
export const SERVER_NAME = 'forge';
export const SERVER_VERSION = '1.0.0';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by its owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
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
        owner: { type: 'string', description: 'The owner of the repository.' },
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
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        head: { type: 'string', description: 'The branch with the changes.' },
        base: { type: 'string', description: 'The branch the changes merge into.' },
        body: { type: 'string', description: 'The body of the pull request.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'number', description: 'The number of the pull request.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// The tools list never changes; build its JSON once so repeated tools/list
// calls answer with identical bytes.
const TOOLS_LIST_JSON = JSON.stringify({ tools: TOOLS });

function result(res: ServerResponse, id: unknown, payload: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, result: payload });
}

function rpcError(res: ServerResponse, id: unknown, code: number, message: string): void {
  sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function toolResult(res: ServerResponse, id: unknown, object: unknown, isError = false): void {
  const text = typeof object === 'string' ? object : JSON.stringify(object);
  result(res, id, {
    content: [{ type: 'text', text }],
    structuredContent: object,
    isError,
  });
}

function toolError(res: ServerResponse, id: unknown, message: string): void {
  toolResult(res, id, { error: message }, true);
}

/** owner/repo from tool args, accepting either the pair or a full_name. */
function repoFromArgs(args: Record<string, unknown>): { owner: string; repo: string } | null {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((owner === '' || repo === '') && typeof args.full_name === 'string') {
    const parts = (args.full_name as string).split('/');
    if (parts.length === 2) {
      owner = parts[0]!;
      repo = parts[1]!;
    }
  }
  if (owner === '' || repo === '') return null;
  return { owner, repo };
}

function missingRequired(args: Record<string, unknown>, required: string[]): string | null {
  for (const name of required) {
    const value = args[name];
    if (value === undefined || value === null || value === '') return name;
  }
  return null;
}

export function handleMcp(store: Store, body: unknown, authenticated: boolean, res: ServerResponse): void {
  const requests = Array.isArray(body) ? body : [body];
  const responses: Array<Record<string, unknown>> = [];
  let notificationOnly = false;

  for (const raw of requests) {
    const request = (raw ?? {}) as Record<string, unknown>;
    const method = typeof request.method === 'string' ? request.method : '';
    const id = 'id' in request ? request.id : undefined;
    const params = (request.params ?? {}) as Record<string, unknown>;

    // Notifications carry no id and get a 202 with an empty body.
    if (id === undefined) {
      notificationOnly = true;
      continue;
    }

    if (method === 'server/discover') {
      responses.push({
        jsonrpc: '2.0',
        id,
        result: {
          supportedVersions: MCP_VERSIONS,
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          capabilities: { tools: {} },
          instructions: 'A GitHub-compatible git forge. Use the tools to manage repositories, issues and pull requests.',
        },
      });
      continue;
    }

    if (method === 'initialize') {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = MCP_VERSIONS.includes(requested) ? requested : MCP_VERSIONS[0]!;
      responses.push({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
      });
      continue;
    }

    if (method === 'tools/list') {
      responses.push({
        jsonrpc: '2.0',
        id,
        result: JSON.parse(TOOLS_LIST_JSON) as Record<string, unknown>,
      });
      continue;
    }

    if (method === 'tools/call') {
      if (!authenticated) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (!tool) {
        responses.push({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${name}` } });
        continue;
      }
      const missing = missingRequired(args, tool.inputSchema.required);
      if (missing !== null) {
        responses.push({ jsonrpc: '2.0', id, error: { code: -32602, message: `Missing required argument: ${missing}` } });
        continue;
      }
      dispatchTool(store, tool.name, args, res, id, responses);
      if (responses.length === 0) return; // dispatchTool already answered
      continue;
    }

    if (method === 'ping') {
      responses.push({ jsonrpc: '2.0', id, result: {} });
      continue;
    }

    responses.push({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }

  if (notificationOnly && responses.length === 0) {
    res.writeHead(202, { 'Content-Type': 'application/json', 'Content-Length': '0' });
    res.end();
    return;
  }
  if (Array.isArray(body)) {
    sendJson(res, 200, responses);
    return;
  }
  if (responses.length === 1) {
    sendJson(res, 200, responses[0]);
    return;
  }
  if (responses.length === 0) {
    res.writeHead(202, { 'Content-Type': 'application/json', 'Content-Length': '0' });
    res.end();
    return;
  }
  sendJson(res, 200, responses);
}

function dispatchTool(
  store: Store,
  name: string,
  args: Record<string, unknown>,
  res: ServerResponse,
  id: unknown,
  responses: Array<Record<string, unknown>>,
): void {
  const fail = (message: string): void => {
    responses.push({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], structuredContent: { error: message }, isError: true },
    });
  };
  const ok = (object: unknown): void => {
    responses.push({
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: typeof object === 'string' ? object : JSON.stringify(object) }],
        structuredContent: object,
        isError: false,
      },
    });
  };

  if (name === 'create_repo') {
    const repoName = String(args.name ?? '');
    const description = typeof args.description === 'string' ? args.description : '';
    const isPrivate = args.private === true;
    const repo = store.createRepo(VIEWER_LOGIN, repoName, description, isPrivate);
    if (!repo) return fail(`Repository ${repoName} already exists`);
    return ok(store.repoObject(repo));
  }

  if (name === 'get_repo') {
    const target = repoFromArgs(args);
    if (!target) return fail('owner and repo are required');
    const repo = store.getRepo(target.owner, target.repo);
    if (!repo) return fail(`Repository ${target.owner}/${target.repo} not found`);
    return ok(store.repoObject(repo));
  }

  if (name === 'create_issue') {
    const target = repoFromArgs(args);
    if (!target) return fail('owner and repo are required');
    const repo = store.getRepo(target.owner, target.repo);
    if (!repo) return fail(`Repository ${target.owner}/${target.repo} not found`);
    const created = store.createIssue(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', []);
    if ('error' in created) return fail(created.error);
    return ok(store.issueObject(repo, created));
  }

  if (name === 'list_issues') {
    const target = repoFromArgs(args);
    if (!target) return fail('owner and repo are required');
    const repo = store.getRepo(target.owner, target.repo);
    if (!repo) return fail(`Repository ${target.owner}/${target.repo} not found`);
    const state = typeof args.state === 'string' ? args.state : 'open';
    const list = store.listIssues(repo, state, 'created', 'desc');
    return ok({ issues: list.map((issue) => store.issueObject(repo, issue)) });
  }

  if (name === 'create_pull_request') {
    const target = repoFromArgs(args);
    if (!target) return fail('owner and repo are required');
    const repo = store.getRepo(target.owner, target.repo);
    if (!repo) return fail(`Repository ${target.owner}/${target.repo} not found`);
    const created = store.createPR(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', String(args.head ?? ''), String(args.base ?? ''));
    if ('error' in created) return fail(created.error);
    return ok(store.prObject(repo, created));
  }

  if (name === 'merge_pull_request') {
    const target = repoFromArgs(args);
    if (!target) return fail('owner and repo are required');
    const repo = store.getRepo(target.owner, target.repo);
    if (!repo) return fail(`Repository ${target.owner}/${target.repo} not found`);
    const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
    const pr = repo.pullsByNumber.get(number);
    if (!pr) return fail(`Pull request ${number} not found`);
    const merged = store.mergePR(repo, pr);
    if ('error' in merged) return fail(merged.error);
    return ok({ sha: merged.sha, merged: true, message: 'Pull request successfully merged' });
  }
}
