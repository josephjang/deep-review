/**
 * The engine's one way to GitHub: `gh api` as a child process (TD1 and R15
 * of the review on the pull request). `gh` holds the account, the host of
 * an Enterprise server, the proxy and the token of a workflow, so the
 * engine sends no token of its own and keeps none. Each call is one run of
 * `gh`, started without a shell and ended after `ghTimeoutMs`, with
 * `--include`, so the answer carries the status line and the headers of
 * each page beside its body.
 */
import { spawnSync } from 'node:child_process';

/**
 * The variables of the environment that hold a token for `gh`. Only the
 * engine's own calls of `gh` need them, so a run of a pull request launches
 * its workers without them (R15), since a worker runs the code of the change.
 */
export const ghTokenVariables = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'] as const;

/** How long one run of `gh` may take, all its pages included, before it is ended. */
export const ghTimeoutMs = 120_000;

/** The most bytes the engine reads of what one run of `gh` prints: the files of a pull request of 3000 files, with their patches, fit. */
const maxOutputBytes = 256 * 1024 * 1024;

/** `gh`'s exit code when it has no account for the host, and so made no request. */
const exitAuthRequired = 4;

/**
 * How the engine runs `gh`: the executable that `github.executable`
 * resolved to, the arguments of `github.args` that go before `api`, and the
 * directory it runs in, whose clone fills `{owner}` and `{repo}` in an
 * endpoint. `environment` and `timeoutMs` default to the engine's own and
 * to `ghTimeoutMs`.
 */
export interface Gh {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

/**
 * One call of `gh api`: the endpoint, a path relative to the API's root,
 * which may hold `{owner}` and `{repo}`; the method, GET when absent; the
 * host, the one `gh` takes for the clone when null or absent; whether to
 * follow every page; and the body of a write, sent as JSON on stdin.
 */
export interface GhCall {
  readonly endpoint: string;
  readonly method?: 'GET' | 'POST';
  readonly hostname?: string | null;
  readonly paginate?: boolean;
  readonly input?: unknown;
}

/**
 * An answer of GitHub: the status and the headers of the last page, with
 * the names of the headers in lower case, GitHub's message when the status
 * is not a success, and the JSON body of each page in order, one without
 * `paginate`, null for a page with no body.
 */
export interface GhAnswer {
  readonly kind: 'answer';
  readonly status: number;
  readonly headers: ReadonlyMap<string, string>;
  readonly message: string | null;
  readonly bodies: readonly unknown[];
}

/**
 * What a call of `gh api` gave: an answer of GitHub, whatever its status;
 * `gh` that could not be started; a run of `gh` ended at its timeout; `gh`
 * with no account for the host, with the action that gives it one; or what
 * the engine cannot read as an answer, such as a run of `gh` that failed
 * before GitHub answered, with `gh`'s own words.
 */
export type GhResult =
  | GhAnswer
  | { readonly kind: 'missing'; readonly executable: string; readonly detail: string }
  | { readonly kind: 'timeout'; readonly timeoutMs: number }
  | { readonly kind: 'no-account'; readonly host: string | null; readonly action: string }
  | { readonly kind: 'unreadable'; readonly detail: string };

/** Whether `result` is an answer whose status is a success. */
export function succeeded(result: GhResult): result is GhAnswer {
  return result.kind === 'answer' && result.status >= 200 && result.status < 300;
}

/**
 * Whether `gh` takes `GH_TOKEN` for `host`, as it does for github.com and
 * for a host of GitHub Enterprise Cloud with data residency, under
 * `ghe.com`; for any other host, a GitHub Enterprise Server, it takes
 * `GH_ENTERPRISE_TOKEN`.
 */
function takesGhToken(host: string): boolean {
  const name = host.toLowerCase();
  return name === 'github.com' || name.endsWith('.ghe.com');
}

/** What gives `gh` an account for `host`, or for the host it takes for the clone when `host` is null. */
export function accountAction(host: string | null): string {
  if (host === null) return 'run `gh auth login`, or set GH_TOKEN (GH_ENTERPRISE_TOKEN for a GitHub Enterprise Server)';
  return `run \`gh auth login --hostname ${host}\`, or set ${takesGhToken(host) ? 'GH_TOKEN' : 'GH_ENTERPRISE_TOKEN'}`;
}

/** The arguments of `gh` for `call`, after those of `gh.args`. */
function apiArguments(call: GhCall): string[] {
  return [
    'api',
    '--include',
    '-X',
    call.method ?? 'GET',
    ...(call.hostname === undefined || call.hostname === null ? [] : ['--hostname', call.hostname]),
    ...(call.paginate === true ? ['--paginate'] : []),
    ...(call.input === undefined ? [] : ['--input', '-']),
    call.endpoint,
  ];
}

/**
 * Run `gh api` for `call` and read what it gave. Never throws for what
 * `gh` or GitHub did: each outcome is a kind of the result.
 */
export function runGhApi(gh: Gh, call: GhCall): GhResult {
  const timeoutMs = gh.timeoutMs ?? ghTimeoutMs;
  const run = spawnSync(gh.executable, [...gh.args, ...apiArguments(call)], {
    cwd: gh.cwd,
    env: gh.environment ?? process.env,
    input: call.input === undefined ? '' : JSON.stringify(call.input),
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: maxOutputBytes,
    windowsHide: true,
  });
  const code = (run.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT' || code === 'EACCES') return { kind: 'missing', executable: gh.executable, detail: run.error!.message };
  if (code === 'ETIMEDOUT') return { kind: 'timeout', timeoutMs };
  if (run.error !== undefined) return { kind: 'unreadable', detail: `gh failed: ${run.error.message}` };
  const stderr = run.stderr.trim();
  if (run.status === exitAuthRequired) return { kind: 'no-account', host: call.hostname ?? null, action: accountAction(call.hostname ?? null) };
  if (run.stdout === '') {
    const exit = run.status === null ? `was ended by ${String(run.signal)}` : `exited ${String(run.status)}`;
    return { kind: 'unreadable', detail: `gh ${exit} with no answer${stderr === '' ? '' : `: ${stderr}`}` };
  }
  const read = readPages(run.stdout);
  if (typeof read === 'string') return { kind: 'unreadable', detail: read };
  const last = read.at(-1)!;
  const success = last.status >= 200 && last.status < 300;
  // gh exits 0 exactly when the last page is a success; anything else means it failed after GitHub answered.
  if (success !== (run.status === 0)) return { kind: 'unreadable', detail: `gh exited ${String(run.status)} after an answer of ${String(last.status)}${stderr === '' ? '' : `: ${stderr}`}` };
  return { kind: 'answer', status: last.status, headers: last.headers, message: success ? null : messageOf(last.body), bodies: read.map((page) => page.body) };
}

/** One page of what `gh api --include` prints. */
interface Page {
  readonly status: number;
  readonly headers: ReadonlyMap<string, string>;
  readonly body: unknown;
}

/** The status line of a page, as `gh` prints it: the protocol and the status, with the line ending in `\n`. */
const statusLine = /^HTTP\/[\d.]+ (\d{3})(?: [^\r\n]*)?\r?\n/;

/** Where the next page starts: `gh` prints a newline after the body of each page but the last. */
const nextPage = /\nHTTP\/[\d.]+ \d{3}(?: [^\r\n]*)?\r?\n/;

/**
 * The pages of what `gh api --include` printed, or why they cannot be
 * read. Each page is a status line, the headers, each `Name: value` on a
 * line ending in `\r\n`, an empty line, and the body; with `--paginate`
 * the pages follow one another, a newline between two. A JSON body that
 * `gh` prints has no newline but inside a string, where JSON escapes it, so
 * a status line after a newline is the start of the next page.
 */
function readPages(output: string): Page[] | string {
  const pages: Page[] = [];
  let rest = output;
  while (rest !== '') {
    const status = statusLine.exec(rest);
    if (status === null) return `page ${String(pages.length + 1)} has no status line`;
    rest = rest.slice(status[0].length);
    const headers = new Map<string, string>();
    for (;;) {
      const end = rest.indexOf('\n');
      if (end === -1) return `the headers of page ${String(pages.length + 1)} do not end`;
      const line = rest.slice(0, end).replace(/\r$/, '');
      rest = rest.slice(end + 1);
      if (line === '') break;
      const colon = line.indexOf(':');
      if (colon <= 0) return `page ${String(pages.length + 1)} has a header line with no name: ${line}`;
      headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }
    const next = nextPage.exec(rest);
    const text = (next === null ? rest : rest.slice(0, next.index)).trim();
    rest = next === null ? '' : rest.slice(next.index + 1);
    let body: unknown = null;
    if (text !== '') {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        return `the body of page ${String(pages.length + 1)} is not JSON: ${text.slice(0, 200)}`;
      }
    }
    pages.push({ status: Number(status[1]), headers, body });
  }
  return pages.length === 0 ? 'gh printed nothing' : pages;
}

/**
 * GitHub's message in the body of an answer that is not a success, with
 * each of its `errors`, as `gh` prints them: the error's own message, else
 * `<resource>.<field> is <code>`. Null when the body has none.
 */
function messageOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const { message, errors } = body as { message?: unknown; errors?: unknown };
  const details = (Array.isArray(errors) ? errors : []).map((error: unknown) => {
    if (typeof error === 'string') return error;
    if (typeof error !== 'object' || error === null) return JSON.stringify(error);
    const fields = error as { message?: unknown; resource?: unknown; field?: unknown; code?: unknown };
    if (typeof fields.message === 'string' && fields.message !== '') return fields.message;
    return `${String(fields.resource)}.${String(fields.field)} is ${String(fields.code)}`;
  });
  const head = typeof message === 'string' && message !== '' ? message : null;
  if (details.length === 0) return head;
  return head === null ? details.join('; ') : `${head}: ${details.join('; ')}`;
}

/** A sentence that says what `result`, a call that gave no success, was. */
export function ghFailureOf(result: GhResult): string {
  switch (result.kind) {
    case 'answer':
      return `GitHub answered ${String(result.status)}${result.message === null ? '' : `: ${result.message}`}`;
    case 'missing':
      return `${result.executable} could not be started (${result.detail}); install the GitHub CLI, gh, or set github.executable to its path`;
    case 'timeout':
      return `gh did not finish within ${String(result.timeoutMs / 1000)} s and was ended`;
    case 'no-account':
      return `gh has no account for ${result.host ?? 'the host of the clone'}; ${result.action}`;
    case 'unreadable':
      return `gh gave nothing the engine can read as an answer: ${result.detail}`;
  }
}
