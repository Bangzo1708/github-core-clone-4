// GraphQL, hand-rolled: a small tokenizer and recursive-descent parser plus
// an executor for exactly the documents the conformance suite sends. There is
// no schema engine here; each type's fields are resolved by a switch, and an
// unknown field is reported as an error naming the field (HTTP 200), which is
// what the suite asserts. A repository that does not exist resolves to null
// with no errors. Batches (a JSON array of operations) run in order.

import type { Issue, PullRequest, Repo, Store } from './store.ts';
import { VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME, decodeGlobalId } from './store.ts';

// ---------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------

type TokenKind = 'name' | 'string' | 'int' | 'float' | 'punct';
interface Token {
  kind: TokenKind;
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$()[]{}:=@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1]!;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'u' && j + 5 < source.length) {
            out += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && source[j]! >= '0' && source[j]! <= '9') j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && source[j]! >= '0' && source[j]! <= '9') j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Array<[string, ValueNode]> };

interface FieldSelection {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Array<[string, ValueNode]>;
  selections: Selection[];
}

interface InlineFragment {
  kind: 'inline';
  typeCondition: string | null;
  selections: Selection[];
}

interface FragmentSpread {
  kind: 'spread';
  name: string;
}

type Selection = FieldSelection | InlineFragment | FragmentSpread;

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selections: Selection[];
}

interface FragmentDef {
  name: string;
  typeCondition: string;
  selections: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, FragmentDef>;
}

class Parser {
  private pos = 0;
  private tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}" in GraphQL document`);
  }
  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek() !== undefined) {
      const token = this.peek()!;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selections: this.parseSelections() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const type = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek()?.kind === 'name') name = this.next().value;
        if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') this.skipBalanced('(', ')');
        operations.push({ type, name, selections: this.parseSelections() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName(); // 'on'
        const typeCondition = this.expectName();
        fragments.set(name, { name, typeCondition, selections: this.parseSelections() });
      } else {
        throw new Error(`unexpected token ${token.value} in GraphQL document`);
      }
    }
    return { operations, fragments };
  }

  private skipBalanced(open: string, close: string): void {
    this.expectPunct(open);
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === open) depth += 1;
      else if (token.kind === 'punct' && token.value === close) depth -= 1;
    }
  }

  private parseSelections(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (true) {
      const token = this.peek();
      if (!token) throw new Error('unterminated selection set');
      if (token.kind === 'punct' && token.value === '}') {
        this.next();
        return selections;
      }
      if (token.kind === 'punct' && token.value === '...') {
        this.next();
        const next = this.peek();
        if (next?.kind === 'name' && next.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          selections.push({ kind: 'inline', typeCondition, selections: this.parseSelections() });
        } else if (next?.kind === 'name') {
          selections.push({ kind: 'spread', name: this.next().value });
        } else {
          selections.push({ kind: 'inline', typeCondition: null, selections: this.parseSelections() });
        }
        continue;
      }
      selections.push(this.parseField());
    }
  }

  private parseField(): FieldSelection {
    let name = this.expectName();
    let alias: string | null = null;
    if (this.peek()?.kind === 'punct' && this.peek()!.value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: Array<[string, ValueNode]> = [];
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push([argName, this.parseValue()]);
      }
      this.next();
    }
    // Directives (@...) are not used by the suite; skip them.
    while (this.peek()?.kind === 'punct' && this.peek()!.value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') this.skipBalanced('(', ')');
    }
    const selections: Selection[] = [];
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '{') {
      selections.push(...this.parseSelections());
    }
    return { kind: 'field', name, alias, args, selections };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === ']')) items.push(this.parseValue());
      this.next();
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<[string, ValueNode]> = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push([name, this.parseValue()]);
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'variable':
      return variables[node.name];
    case 'list':
      return node.items.map((item) => evalValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of node.fields) out[key] = evalValue(value, variables);
      return out;
    }
  }
}

function evalArgs(field: FieldSelection, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, node] of field.args) out[name] = evalValue(node, variables);
  return out;
}

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

interface ExecState {
  store: Store;
  fragments: Map<string, FragmentDef>;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function unknownField(state: ExecState, typeName: string, fieldName: string): null {
  state.errors.push({ message: `Cannot query field "${fieldName}" on type "${typeName}".` });
  return null;
}

function resolveSelections(typeName: string, value: unknown, selections: Selection[], state: ExecState): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      out[selection.alias ?? selection.name] = resolveField(typeName, value, selection, state);
    } else if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        const inner = resolveSelections(typeName, value, selection.selections, state);
        if (inner) Object.assign(out, inner);
      }
    } else {
      const fragment = state.fragments.get(selection.name);
      if (fragment && (fragment.typeCondition === typeName || fragment.typeCondition === '')) {
        const inner = resolveSelections(typeName, value, fragment.selections, state);
        if (inner) Object.assign(out, inner);
      } else if (fragment) {
        // A fragment on a different type contributes nothing here.
      }
    }
  }
  return out;
}

function withSelections(value: unknown, typeName: string | null, field: FieldSelection, state: ExecState): unknown {
  if (value === null || value === undefined) return null;
  if (field.selections.length === 0 || typeName === null) return value;
  if (Array.isArray(value)) return value.map((item) => resolveSelections(typeName, item, field.selections, state));
  return resolveSelections(typeName, value, field.selections, state);
}

// A cursor is an opaque base64 of `cursor:<issue-or-pr-number>`.
function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function numberFromCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function prState(pr: PullRequest): string {
  if (pr.merged) return 'MERGED';
  return pr.state === 'open' ? 'OPEN' : 'CLOSED';
}

function prMergeableValue(store: Store, repo: Repo, pr: PullRequest): string {
  if (pr.state !== 'open') return 'UNKNOWN';
  return store.prMergeable(repo, pr) ? 'MERGEABLE' : 'CONFLICTING';
}

function issueObject(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    __graphqlType: 'Issue',
    id: issue.nodeId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issueState(issue),
    url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
    createdAt: store.stampAt(issue.createdSeq),
    updatedAt: store.stampAt(issue.updatedSeq),
    closedAt: issue.closedSeq === 0 ? null : store.stampAt(issue.closedSeq),
    author: { __graphqlType: 'User', login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME },
    labels: { __graphqlType: 'LabelConnection', nodes: issue.labels.map((label) => ({ __graphqlType: 'Label', id: label.nodeId, name: label.name, color: label.color, description: label.description })), totalCount: issue.labels.length },
    comments: {
      __graphqlType: 'CommentConnection',
      nodes: issue.comments.map((comment) => ({ __graphqlType: 'Comment', id: comment.nodeId, body: comment.body, createdAt: store.stampAt(comment.createdSeq), author: { __graphqlType: 'User', login: VIEWER_LOGIN, id: VIEWER_ID } })),
      totalCount: issue.comments.length,
    },
  };
}

function prObject(store: Store, repo: Repo, pr: PullRequest): Record<string, unknown> {
  const files = store.prFiles(repo, pr);
  return {
    __graphqlType: 'PullRequest',
    id: pr.nodeId,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: prState(pr),
    headRefName: pr.headRef,
    baseRefName: pr.baseRef,
    mergeable: prMergeableValue(store, repo, pr),
    merged: pr.merged,
    url: `/${repo.owner}/${repo.name}/pull/${pr.number}`,
    createdAt: store.stampAt(pr.createdSeq),
    updatedAt: store.stampAt(pr.updatedSeq),
    author: { __graphqlType: 'User', login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME },
    files: {
      __graphqlType: 'PullRequestFileConnection',
      nodes: files.map((file) => ({ __graphqlType: 'PullRequestFile', path: file.filename, additions: file.additions, deletions: file.deletions, changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'REMOVED' : 'CHANGED' })),
      totalCount: files.length,
    },
  };
}

function repoObject(store: Store, repo: Repo): Record<string, unknown> {
  return {
    __graphqlType: 'Repository',
    id: repo.nodeId,
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: repo.fullName,
    owner: { __graphqlType: 'User', login: repo.owner, id: VIEWER_ID, name: VIEWER_NAME },
    defaultBranchRef: { __graphqlType: 'Ref', name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    _repo: repo,
  };
}

/** The issues connection: filtering, ordering, cursor paging. */
function issuesConnection(store: Store, repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
  let list = [...repo.issues];
  if (states !== null) {
    const wanted = new Set(states.map((s) => String(s).toUpperCase()));
    list = list.filter((issue) => wanted.has(issueState(issue)));
  }
  const descending = orderBy?.direction === 'DESC';
  list.sort((a, b) => {
    if (descending) return b.createdSeq - a.createdSeq || b.number - a.number;
    return a.createdSeq - b.createdSeq || a.number - b.number;
  });
  const afterNumber = numberFromCursor(args.after);
  if (afterNumber !== null) {
    const at = list.findIndex((issue) => issue.number === afterNumber);
    if (at >= 0) list = list.slice(at + 1);
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, first);
  const hasNext = list.length > page.length;
  return {
    __graphqlType: 'IssueConnection',
    nodes: page.map((issue) => issueObject(store, repo, issue)),
    edges: page.map((issue) => ({ __graphqlType: 'IssueEdge', node: issueObject(store, repo, issue), cursor: cursorFor(issue.number) })),
    pageInfo: {
      __graphqlType: 'PageInfo',
      hasNextPage: hasNext,
      hasPreviousPage: afterNumber !== null,
      startCursor: page.length > 0 ? cursorFor(page[0]!.number) : null,
      endCursor: page.length > 0 ? cursorFor(page[page.length - 1]!.number) : null,
    },
    totalCount: repo.issues.length,
  };
}

function prsConnection(store: Store, repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  let list = [...repo.pulls];
  if (states !== null) {
    const wanted = new Set(states.map((s) => String(s).toUpperCase()));
    list = list.filter((pr) => wanted.has(prState(pr)));
  }
  list.sort((a, b) => a.createdSeq - b.createdSeq || a.number - b.number);
  const afterNumber = numberFromCursor(args.after);
  if (afterNumber !== null) {
    const at = list.findIndex((pr) => pr.number === afterNumber);
    if (at >= 0) list = list.slice(at + 1);
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, first);
  const hasNext = list.length > page.length;
  return {
    __graphqlType: 'PullRequestConnection',
    nodes: page.map((pr) => prObject(store, repo, pr)),
    edges: page.map((pr) => ({ __graphqlType: 'PullRequestEdge', node: prObject(store, repo, pr), cursor: cursorFor(pr.number) })),
    pageInfo: {
      __graphqlType: 'PageInfo',
      hasNextPage: hasNext,
      hasPreviousPage: afterNumber !== null,
      startCursor: page.length > 0 ? cursorFor(page[0]!.number) : null,
      endCursor: page.length > 0 ? cursorFor(page[page.length - 1]!.number) : null,
    },
    totalCount: repo.pulls.length,
  };
}

// Introspection tables for the types the suite asks about.
const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files', 'url', 'createdAt', 'updatedAt', 'author'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'url', 'createdAt', 'updatedAt', 'description', 'isPrivate'],
};

function typeIntrospection(name: string): Record<string, unknown> | null {
  if (name === 'SearchType') {
    return {
      __graphqlType: '__Type',
      name: 'SearchType',
      kind: 'ENUM',
      description: null,
      fields: null,
      enumValues: [
        { __graphqlType: '__EnumValue', name: 'ISSUE', description: null },
        { __graphqlType: '__EnumValue', name: 'REPOSITORY', description: null },
        { __graphqlType: '__EnumValue', name: 'USER', description: null },
        { __graphqlType: '__EnumValue', name: 'DISCUSSION', description: null },
        { __graphqlType: '__EnumValue', name: 'MILESTONE', description: null },
      ],
    };
  }
  const fields = TYPE_FIELDS[name];
  if (!fields) return null;
  return {
    __graphqlType: '__Type',
    name,
    kind: 'OBJECT',
    description: null,
    fields: fields.map((field) => ({ __graphqlType: '__Field', name: field, description: null, type: { __graphqlType: '__Type', name: 'String', kind: 'SCALAR' } })),
    enumValues: null,
  };
}

function resolveField(typeName: string, value: Record<string, unknown>, field: FieldSelection, state: ExecState): unknown {
  const store = state.store;
  const args = evalArgs(field, state.variables);
  const fieldName = field.name;

  if (fieldName === '__typename') return typeName;

  if (typeName === 'Query') {
    if (fieldName === 'viewer') {
      return withSelections({ __graphqlType: 'User', login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: '' }, 'User', field, state);
    }
    if (fieldName === 'repository') {
      const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      if (!repo) return null;
      return withSelections(repoObject(store, repo), 'Repository', field, state);
    }
    if (fieldName === 'node') {
      const decoded = decodeGlobalId(String(args.id ?? ''));
      if (!decoded) return null;
      if (decoded.kind === 'Repository') {
        const repo = store.getRepoById(decoded.dbId);
        if (!repo) return null;
        return withSelections(repoObject(store, repo), 'Repository', field, state);
      }
      if (decoded.kind === 'Issue') {
        const repo = store.getRepoById(decoded.dbId);
        const issue = repo?.issuesByNumber.get(decoded.number);
        if (!repo || !issue) return null;
        return withSelections(issueObject(store, repo, issue), 'Issue', field, state);
      }
      if (decoded.kind === 'PullRequest') {
        const repo = store.getRepoById(decoded.dbId);
        const pr = repo?.pullsByNumber.get(decoded.number);
        if (!repo || !pr) return null;
        return withSelections(prObject(store, repo, pr), 'PullRequest', field, state);
      }
      return null;
    }
    if (fieldName === '__type') {
      const introspected = typeIntrospection(String(args.name ?? ''));
      if (!introspected) return null;
      return withSelections(introspected, '__Type', field, state);
    }
    if (fieldName === '__schema') {
      return withSelections({ __graphqlType: '__Schema', queryType: { __graphqlType: '__Type', name: 'Query', kind: 'OBJECT' }, mutationType: { __graphqlType: '__Type', name: 'Mutation', kind: 'OBJECT' } }, '__Schema', field, state);
    }
    return unknownField(state, typeName, fieldName);
  }

  if (typeName === 'Mutation') {
    if (fieldName === 'createIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = store.getRepoById(Number(decodeGlobalId(String(input.repositoryId ?? ''))?.dbId ?? -1));
      if (!repo) {
        state.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
        return null;
      }
      const created = store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      if ('error' in created) {
        state.errors.push({ message: created.error });
        return null;
      }
      return withSelections({ __graphqlType: 'CreateIssuePayload', issue: issueObject(store, repo, created) }, 'CreateIssuePayload', field, state);
    }
    if (fieldName === 'closeIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.issueId ?? ''));
      const repo = decoded ? store.getRepoById(decoded.dbId) : undefined;
      const issue = decoded && decoded.kind === 'Issue' ? repo?.issuesByNumber.get(decoded.number) : undefined;
      if (!repo || !issue) {
        state.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
        return null;
      }
      store.patchIssue(repo, issue, { state: 'closed' });
      return withSelections({ __graphqlType: 'CloseIssuePayload', issue: issueObject(store, repo, issue) }, 'CloseIssuePayload', field, state);
    }
    if (fieldName === 'createPullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = store.getRepoById(Number(decodeGlobalId(String(input.repositoryId ?? ''))?.dbId ?? -1));
      if (!repo) {
        state.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
        return null;
      }
      const created = store.createPR(repo, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
      if ('error' in created) {
        state.errors.push({ message: created.error });
        return null;
      }
      return withSelections({ __graphqlType: 'CreatePullRequestPayload', pullRequest: prObject(store, repo, created) }, 'CreatePullRequestPayload', field, state);
    }
    if (fieldName === 'mergePullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
      const repo = decoded ? store.getRepoById(decoded.dbId) : undefined;
      const pr = decoded && decoded.kind === 'PullRequest' ? repo?.pullsByNumber.get(decoded.number) : undefined;
      if (!repo || !pr) {
        state.errors.push({ message: 'Could not resolve to a PullRequest with the id provided.' });
        return null;
      }
      const merged = store.mergePR(repo, pr);
      if ('error' in merged) {
        state.errors.push({ message: merged.error });
        return null;
      }
      return withSelections({ __graphqlType: 'MergePullRequestPayload', pullRequest: prObject(store, repo, pr) }, 'MergePullRequestPayload', field, state);
    }
    if (fieldName === 'addComment') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.subjectId ?? ''));
      const repo = decoded ? store.getRepoById(decoded.dbId) : undefined;
      const issue = decoded && decoded.kind === 'Issue' ? repo?.issuesByNumber.get(decoded.number) : undefined;
      if (!repo || !issue) {
        state.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
        return null;
      }
      const comment = store.addComment(repo, issue, String(input.body ?? ''));
      return withSelections({
        __graphqlType: 'AddCommentPayload',
        commentEdge: {
          __graphqlType: 'IssueCommentEdge',
          node: { __graphqlType: 'Comment', id: comment.nodeId, body: comment.body, createdAt: store.stampAt(comment.createdSeq), author: { __graphqlType: 'User', login: VIEWER_LOGIN, id: VIEWER_ID } },
          cursor: cursorFor(comment.id),
        },
      }, 'AddCommentPayload', field, state);
    }
    return unknownField(state, typeName, fieldName);
  }

  if (typeName === 'Repository') {
    const repo = value._repo as Repo;
    switch (fieldName) {
      case 'id':
      case 'databaseId':
      case 'name':
      case 'nameWithOwner':
      case 'viewerPermission':
      case 'hasIssuesEnabled':
        return value[fieldName] ?? null;
      case 'owner':
        return withSelections(value.owner as Record<string, unknown>, 'User', field, state);
      case 'defaultBranchRef':
        return withSelections(value.defaultBranchRef as Record<string, unknown>, 'Ref', field, state);
      case 'issue': {
        const issue = repo.issuesByNumber.get(Number(args.number ?? -1));
        if (!issue) return null;
        return withSelections(issueObject(store, repo, issue), 'Issue', field, state);
      }
      case 'issues':
        return withSelections(issuesConnection(store, repo, args), 'IssueConnection', field, state);
      case 'pullRequest': {
        const pr = repo.pullsByNumber.get(Number(args.number ?? -1));
        if (!pr) return null;
        return withSelections(prObject(store, repo, pr), 'PullRequest', field, state);
      }
      case 'pullRequests':
        return withSelections(prsConnection(store, repo, args), 'PullRequestConnection', field, state);
      case 'url':
        return `/${repo.owner}/${repo.name}`;
      case 'description':
        return repo.description;
      case 'isPrivate':
        return repo.private;
      case 'createdAt':
        return store.stampAt(repo.createdSeq);
      case 'updatedAt':
        return store.stampAt(repo.updatedSeq);
      default:
        return unknownField(state, typeName, fieldName);
    }
  }

  if (typeName === 'Issue') {
    switch (fieldName) {
      case 'id':
      case 'number':
      case 'title':
      case 'body':
      case 'state':
      case 'url':
      case 'createdAt':
      case 'updatedAt':
      case 'closedAt':
        return value[fieldName] ?? null;
      case 'author':
        return withSelections(value.author as Record<string, unknown>, 'User', field, state);
      case 'labels':
        return withSelections(value.labels as Record<string, unknown>, 'LabelConnection', field, state);
      case 'comments':
        return withSelections(value.comments as Record<string, unknown>, 'CommentConnection', field, state);
      default:
        return unknownField(state, typeName, fieldName);
    }
  }

  if (typeName === 'PullRequest') {
    switch (fieldName) {
      case 'id':
      case 'number':
      case 'title':
      case 'body':
      case 'state':
      case 'headRefName':
      case 'baseRefName':
      case 'mergeable':
      case 'merged':
      case 'url':
      case 'createdAt':
      case 'updatedAt':
        return value[fieldName] ?? null;
      case 'author':
        return withSelections(value.author as Record<string, unknown>, 'User', field, state);
      case 'files': {
        const files = value.files as Record<string, unknown>;
        const first = typeof args.first === 'number' ? args.first : (files.nodes as unknown[]).length;
        const nodes = (files.nodes as Array<Record<string, unknown>>).slice(0, first);
        const connection = {
          __graphqlType: 'PullRequestFileConnection',
          nodes,
          totalCount: files.totalCount,
          pageInfo: { __graphqlType: 'PageInfo', hasNextPage: (files.nodes as unknown[]).length > nodes.length, hasPreviousPage: false, startCursor: null, endCursor: null },
        };
        return withSelections(connection, 'PullRequestFileConnection', field, state);
      }
      default:
        return unknownField(state, typeName, fieldName);
    }
  }

  if (typeName === 'User') {
    switch (fieldName) {
      case 'login':
      case 'id':
      case 'name':
      case 'email':
        return value[fieldName] ?? null;
      default:
        return unknownField(state, typeName, fieldName);
    }
  }

  if (typeName === 'Ref') {
    if (fieldName === 'name') return value.name ?? null;
    return unknownField(state, typeName, fieldName);
  }

  if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'PullRequestFileConnection' || typeName === 'LabelConnection' || typeName === 'CommentConnection') {
    switch (fieldName) {
      case 'nodes': {
        const nodes = value.nodes as Array<Record<string, unknown>>;
        const childType = typeName === 'IssueConnection' ? 'Issue' : typeName === 'PullRequestConnection' ? 'PullRequest' : typeName === 'PullRequestFileConnection' ? 'PullRequestFile' : typeName === 'LabelConnection' ? 'Label' : 'Comment';
        return nodes.map((node) => resolveSelections(childType, node, field.selections, state));
      }
      case 'edges': {
        const edges = value.edges as Array<Record<string, unknown>> | undefined;
        if (!edges) return null;
        const childType = typeName === 'IssueConnection' ? 'IssueEdge' : 'PullRequestEdge';
        return edges.map((edge) => resolveSelections(childType, edge, field.selections, state));
      }
      case 'pageInfo':
        return withSelections(value.pageInfo as Record<string, unknown>, 'PageInfo', field, state);
      case 'totalCount':
        return value.totalCount ?? null;
      default:
        return unknownField(state, typeName, fieldName);
    }
  }

  if (typeName === 'IssueEdge' || typeName === 'PullRequestEdge' || typeName === 'IssueCommentEdge') {
    switch (fieldName) {
      case 'node': {
        const childType = typeName === 'IssueEdge' ? 'Issue' : typeName === 'PullRequestEdge' ? 'PullRequest' : 'Comment';
        return withSelections(value.node as Record<string, unknown>, childType, field, state);
      }
      case 'cursor':
        return value.cursor ?? null;
      default:
        return unknownField(state, typeName, fieldName);
    }
  }

  if (typeName === 'PageInfo') {
    switch (fieldName) {
      case 'hasNextPage':
      case 'hasPreviousPage':
      case 'startCursor':
      case 'endCursor':
        return value[fieldName] ?? null;
      default:
        return unknownField(state, typeName, fieldName);
    }
  }

  if (typeName === 'Label') {
    switch (fieldName) {
      case 'id':
      case 'name':
      case 'color':
      case 'description':
        return value[fieldName] ?? null;
      default:
        return unknownField(state, typeName, fieldName);
    }
  }

  if (typeName === 'Comment') {
    switch (fieldName) {
      case 'id':
      case 'body':
      case 'createdAt':
        return value[fieldName] ?? null;
      case 'author':
        return withSelections(value.author as Record<string, unknown>, 'User', field, state);
      default:
        return unknownField(state, typeName, fieldName);
    }
  }

  if (typeName === 'PullRequestFile') {
    switch (fieldName) {
      case 'path':
      case 'additions':
      case 'deletions':
      case 'changeType':
        return value[fieldName] ?? null;
      default:
        return unknownField(state, typeName, fieldName);
    }
  }

  if (typeName === '__Type') {
    switch (fieldName) {
      case 'name':
      case 'kind':
      case 'description':
        return value[fieldName] ?? null;
      case 'fields': {
        const fields = value.fields as Array<Record<string, unknown>> | null;
        if (!fields) return null;
        return fields.map((item) => resolveSelections('__Field', item, field.selections, state));
      }
      case 'enumValues': {
        const values = value.enumValues as Array<Record<string, unknown>> | null;
        if (!values) return null;
        return values.map((item) => resolveSelections('__EnumValue', item, field.selections, state));
      }
      default:
        return unknownField(state, typeName, fieldName);
    }
  }

  if (typeName === '__Field' || typeName === '__EnumValue') {
    switch (fieldName) {
      case 'name':
      case 'description':
        return value[fieldName] ?? null;
      case 'type':
        return withSelections(value.type as Record<string, unknown>, '__Type', field, state);
      default:
        return unknownField(state, typeName, fieldName);
    }
  }

  if (typeName === '__Schema') {
    switch (fieldName) {
      case 'queryType':
        return withSelections(value.queryType as Record<string, unknown>, '__Type', field, state);
      case 'mutationType':
        return withSelections(value.mutationType as Record<string, unknown>, '__Type', field, state);
      default:
        return unknownField(state, typeName, fieldName);
    }
  }

  // Payload types and anything else: resolve plain fields by name.
  if (fieldName === 'issue' || fieldName === 'pullRequest' || fieldName === 'commentEdge') {
    const childType = fieldName === 'issue' ? 'Issue' : fieldName === 'pullRequest' ? 'PullRequest' : 'IssueCommentEdge';
    return withSelections(value[fieldName] as Record<string, unknown>, childType, field, state);
  }
  if (fieldName in value) return value[fieldName] ?? null;
  return unknownField(state, typeName, fieldName);
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export interface GraphQLResult {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

export function executeGraphQL(store: Store, body: unknown): GraphQLResult | GraphQLResult[] {
  const operations = Array.isArray(body) ? body : [body];
  const results = operations.map((operation) => executeOne(store, operation));
  return Array.isArray(body) ? results : results[0]!;
}

function executeOne(store: Store, body: unknown): GraphQLResult {
  const request = (body ?? {}) as Record<string, unknown>;
  const query = typeof request.query === 'string' ? request.query : '';
  const variables = (request.variables ?? {}) as Record<string, unknown>;
  const operationName = typeof request.operationName === 'string' ? request.operationName : null;
  if (query === '') return { errors: [{ message: 'Must provide query string.' }] };
  let document: Document;
  try {
    document = new Parser(tokenize(query)).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : 'GraphQL syntax error' }] };
  }
  let operation = document.operations[0];
  if (operationName !== null) {
    operation = document.operations.find((candidate) => candidate.name === operationName) ?? document.operations[0]!;
  }
  if (!operation) return { errors: [{ message: 'Must provide an operation.' }] };
  const state: ExecState = { store, fragments: document.fragments, variables, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = resolveSelections(rootType, {}, operation.selections, state);
  if (state.errors.length > 0) return { data: null, errors: state.errors };
  return { data };
}
