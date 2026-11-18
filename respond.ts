// Small response helpers shared by the REST, GraphQL and MCP layers. Every
// reply carries a Content-Length so keep-alive connections stay fast, and
// REST replies also carry X-GitHub-Request-Id.

import type { ServerResponse } from 'node:http';

export interface SendOptions {
  requestId?: string;
  headers?: Record<string, string>;
}

export function sendJson(res: ServerResponse, status: number, body: string | object, options: SendOptions = {}): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(text)),
  };
  if (options.requestId !== undefined) headers['X-GitHub-Request-Id'] = options.requestId;
  if (options.headers !== undefined) Object.assign(headers, options.headers);
  res.writeHead(status, headers);
  res.end(text);
}

/** Send an already-serialized JSON body without re-encoding it per request. */
export function sendJsonBuf(res: ServerResponse, status: number, body: Buffer, options: SendOptions = {}): void {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
  };
  if (options.requestId !== undefined) headers['X-GitHub-Request-Id'] = options.requestId;
  if (options.headers !== undefined) Object.assign(headers, options.headers);
  res.writeHead(status, headers);
  res.end(body);
}

export function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string, options: SendOptions = {}): void {
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Content-Length': String(body.length),
  };
  if (options.requestId !== undefined) headers['X-GitHub-Request-Id'] = options.requestId;
  if (options.headers !== undefined) Object.assign(headers, options.headers);
  res.writeHead(status, headers);
  res.end(body);
}

export function sendError(res: ServerResponse, status: number, message: string, requestId?: string): void {
  sendJson(res, status, { message }, { requestId });
}

export function sendNoContent(res: ServerResponse, requestId?: string): void {
  const headers: Record<string, string> = {};
  if (requestId !== undefined) headers['X-GitHub-Request-Id'] = requestId;
  res.writeHead(204, headers);
  res.end();
}
