// A stand-in for the GitHub CLI's `gh api`: a test names it with
// `executable: process.execPath` and `args: [fakeGh]`, as it names a fake
// runtime, so it starts without a shell on every platform. It is steered by
// the JSON file FAKE_GH_SCRIPT names, a list of steps (FakeGhStep). Each
// call takes the first step not yet taken whose method and endpoint are the
// call's, and answers as `gh api --include` does: for each page, a status
// line, the headers, each on a line ending in \r\n, an empty line and the
// body, with a newline between two pages; every page with --paginate, else
// the first. It exits 0 when the last page is a success, else 1 with gh's
// line on stderr. A call that no step answers exits 1 with no answer.
// Every call appends a line of JSON to `<FAKE_GH_SCRIPT>.calls` with its
// arguments and its stdin (FakeGhCall), before it answers, and the steps
// taken are listed in `<FAKE_GH_SCRIPT>.taken`. A step marked `held`
// answers from the reviews the stand-in holds, in `<FAKE_GH_SCRIPT>.held`,
// as GitHub holds what is posted to it: a post of a review is held and
// answered with it, and a list of the reviews of a pull request or of the
// comments of one review is answered with what is held. fakeGhWith gives a
// test a `gh` that runs it under a script of its own.
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TestContext } from 'node:test';
import type { Gh } from '../../src/github/gh.ts';

/** The stand-in's script, steered by FAKE_GH_SCRIPT (see the top of this file). */
export const fakeGh = resolve(import.meta.dirname, 'fake-gh.ts');

/** One page of an answer: its status, 200 when absent; its headers; and its body, as JSON, or as `raw` text that is not. */
export interface FakeGhPage {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly raw?: string;
}

/**
 * A step of the script: the call it answers, by its method, GET when
 * absent, and its endpoint as the engine wrote it; and how it answers:
 * with `pages`; with `held`, from the reviews the stand-in holds (see the
 * top of this file), or with `pages` once it holds a post; with `noAccount`, as gh does with no account for the
 * host, exit 4 and no answer; or with `hang`, never ending. With `stop`,
 * the step ends the process that started the stand-in with SIGKILL,
 * `before` it logs the call and answers, as a stop before the call does,
 * or `after`, as a stop after GitHub took it does, and writes
 * `<FAKE_GH_SCRIPT>.stopped`.
 */
export interface FakeGhStep {
  readonly method?: string;
  readonly endpoint: string;
  readonly pages?: readonly FakeGhPage[];
  readonly held?: boolean;
  readonly noAccount?: boolean;
  readonly hang?: boolean;
  readonly stop?: 'before' | 'after';
}

/** A comment of a review the stand-in holds. */
export interface HeldComment {
  readonly id: number;
  readonly path: string;
  readonly line: number;
  readonly body: string;
}

/** A review the stand-in holds: its id, from 1 in the order of the posts, the pull request's endpoint it was posted to, and what was posted. */
export interface HeldReview {
  readonly id: number;
  readonly pull: string;
  readonly commit: string;
  readonly event: string;
  readonly body: string;
  readonly comments: readonly HeldComment[];
}

/** The reviews the stand-in under `script` holds, in the order they were posted. */
export function fakeGhHeld(script: string): HeldReview[] {
  const file = `${script}.held`;
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as HeldReview[]) : [];
}

/** A call as the stand-in logged it. */
export interface FakeGhCall {
  readonly args: readonly string[];
  readonly stdin: string;
}

/** The calls the stand-in under `script` logged, in order. */
export function fakeGhCalls(script: string): FakeGhCall[] {
  const log = `${script}.calls`;
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as FakeGhCall);
}

/** Write `steps` as the script at `script`, for FAKE_GH_SCRIPT. */
export function writeFakeGhScript(script: string, steps: readonly FakeGhStep[]): void {
  writeFileSync(script, JSON.stringify(steps));
}

/** A `gh` that is the stand-in under `steps`, in a temporary directory removed when `t` ends, with the script's path. */
export function fakeGhWith(t: TestContext, steps: readonly FakeGhStep[], timeoutMs?: number): { readonly gh: Gh; readonly script: string } {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'deep-review-gh-')));
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const script = join(directory, 'script.json');
  writeFakeGhScript(script, steps);
  const gh: Gh = { executable: process.execPath, args: [fakeGh], cwd: directory, environment: { ...process.env, FAKE_GH_SCRIPT: script }, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
  return { gh, script };
}

const reasons: Readonly<Record<number, string>> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
};

/** The value of the option `name` in `args`, or undefined. */
function option(args: readonly string[], ...names: string[]): string | undefined {
  const index = args.findIndex((arg) => names.includes(arg));
  return index === -1 ? undefined : args[index + 1];
}

/** The endpoint of a `gh api` command line: its one argument that is neither an option nor an option's value. */
function endpointOf(args: readonly string[]): string | undefined {
  const takesValue = new Set(['-X', '--method', '--hostname', '--input', '-H', '--header']);
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]!;
    if (takesValue.has(arg)) index += 1;
    else if (!arg.startsWith('-')) return arg;
  }
  return undefined;
}

/** What `gh api --include` prints for `page`, or `gh api` without it. */
function printed(page: FakeGhPage, include: boolean): string {
  const status = page.status ?? 200;
  const body = page.raw ?? (page.body === undefined ? '' : JSON.stringify(page.body));
  if (!include) return body;
  const headers = { 'Content-Type': 'application/json; charset=utf-8', ...page.headers };
  const lines = Object.keys(headers).sort().map((name) => `${name}: ${headers[name as keyof typeof headers]}\r\n`);
  return `HTTP/2.0 ${String(status)} ${reasons[status] ?? ''}\n${lines.join('')}\r\n${body}`;
}

/** The URL GitHub gives what `pull`, `repos/<owner>/<repo>/pulls/<n>`, holds on `host`, with `anchor`. */
const heldUrl = (host: string, pull: string, anchor: string): string => `https://${host}/${pull.replace(/^repos\//, '').replace('/pulls/', '/pull/')}#${anchor}`;

/**
 * The page a `held` step answers `endpoint` with, from what the stand-in
 * under `script` holds: a post to `<pull>/reviews` is held, with its
 * comments, and answered with the review; `<pull>/reviews?...` lists the
 * reviews held for `<pull>`, and `<pull>/reviews/<id>/comments?...` the
 * comments of one, as GitHub lists them.
 */
function heldPage(script: string, method: string, endpoint: string, host: string, stdin: string): FakeGhPage {
  const held = fakeGhHeld(script);
  const review = (entry: HeldReview): unknown => ({ id: entry.id, html_url: heldUrl(host, entry.pull, `pullrequestreview-${String(entry.id)}`), body: entry.body });
  const post = /^(repos\/[^/]+\/[^/]+\/pulls\/\d+)\/reviews$/.exec(endpoint);
  if (method === 'POST' && post !== null) {
    const input = JSON.parse(stdin) as { commit_id: string; body: string; event: string; comments: { path: string; line: number; body: string }[] };
    const id = held.length + 1;
    const entry: HeldReview = { id, pull: post[1]!, commit: input.commit_id, event: input.event, body: input.body, comments: input.comments.map((comment, index) => ({ id: id * 1000 + index + 1, path: comment.path, line: comment.line, body: comment.body })) };
    writeFileSync(`${script}.held`, JSON.stringify([...held, entry]));
    return { body: review(entry) };
  }
  const comments = /^(repos\/[^/]+\/[^/]+\/pulls\/\d+)\/reviews\/(\d+)\/comments(?:\?.*)?$/.exec(endpoint);
  if (comments !== null) {
    const entry = held.find((candidate) => candidate.pull === comments[1] && candidate.id === Number(comments[2]));
    if (entry === undefined) return { status: 404, body: { message: 'Not Found' } };
    return { body: entry.comments.map((comment) => ({ id: comment.id, html_url: heldUrl(host, entry.pull, `discussion_r${String(comment.id)}`), body: comment.body })) };
  }
  const reviews = /^(repos\/[^/]+\/[^/]+\/pulls\/\d+)\/reviews(?:\?.*)?$/.exec(endpoint);
  if (reviews !== null) return { body: held.filter((entry) => entry.pull === reviews[1]).map(review) };
  return { status: 404, body: { message: `fake-gh holds nothing at ${endpoint}` } };
}

/** End the process that started this one, and this one, after writing the `stopped` marker. */
function stopParent(script: string): never {
  writeFileSync(`${script}.stopped`, '');
  process.kill(process.ppid, 'SIGKILL');
  process.exit(137);
}

function main(): number {
  const args = process.argv.slice(2);
  const script = process.env.FAKE_GH_SCRIPT;
  if (script === undefined) {
    process.stderr.write('fake-gh: FAKE_GH_SCRIPT is not set\n');
    return 1;
  }
  const stdin = readFileSync(0, 'utf8');
  const method = option(args, '-X', '--method') ?? 'GET';
  const endpoint = endpointOf(args);
  const steps = JSON.parse(readFileSync(script, 'utf8')) as FakeGhStep[];
  const takenFile = `${script}.taken`;
  const taken = existsSync(takenFile) ? (JSON.parse(readFileSync(takenFile, 'utf8')) as number[]) : [];
  const index = steps.findIndex((step, at) => !taken.includes(at) && (step.method ?? 'GET') === method && step.endpoint === endpoint);
  const step = steps[index];
  // A step is taken before a stop, so the command run after the stop meets the next one.
  if (step !== undefined) writeFileSync(takenFile, JSON.stringify([...taken, index]));
  if (step?.stop === 'before') stopParent(script);
  appendFileSync(`${script}.calls`, `${JSON.stringify({ args, stdin } satisfies FakeGhCall)}\n`);
  if (step === undefined) {
    process.stderr.write(`fake-gh: no step answers ${method} ${String(endpoint)}\n`);
    return 1;
  }
  if (step.hang === true) {
    setInterval(() => {}, 1000);
    return -1;
  }
  if (step.noAccount === true) {
    process.stderr.write('To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n');
    return 4;
  }
  // A held step answers with what it holds, or with its own pages once it holds a post, as GitHub that made a review and answered 502 does.
  const held = step.held === true ? heldPage(script, method, endpoint!, option(args, '--hostname') ?? 'github.com', stdin) : null;
  const pages = step.pages ?? (held === null ? [{}] : [held]);
  const shown = args.includes('--paginate') ? pages : pages.slice(0, 1);
  const include = args.includes('--include') || args.includes('-i');
  process.stdout.write(shown.map((page) => printed(page, include)).join('\n'));
  const last = shown.at(-1)!;
  const status = last.status ?? 200;
  if (step.stop === 'after') stopParent(script);
  if (status >= 400) {
    const message = (last.body as { message?: unknown } | undefined)?.message;
    process.stderr.write(`gh: ${typeof message === 'string' ? message : 'error'} (HTTP ${String(status)})\n`);
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  const code = main();
  if (code >= 0) process.exitCode = code;
}
