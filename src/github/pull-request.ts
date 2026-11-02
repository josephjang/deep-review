/**
 * What the engine reads of a pull request on GitHub, and the one review it
 * posts there, each through `gh api` (the table of "Reading GitHub" in the
 * design of the review on the pull request). Each answer is parsed here, at
 * the boundary, and only what the design keeps is kept. Every call but the
 * first read of a pull request by its number names the host, so `gh`
 * never chooses it again. A call that gives no usable answer throws
 * `GitHubCallError` with what it gave.
 *
 * The module also holds two readings of a pull request's files that need
 * no call: the changed paths they imply (TD3), and the new lines of a
 * file's patch, which take a comment (TD4).
 */
import { z } from 'zod';
import { GitHubCallError, PullRequestRefusedError } from './errors.ts';
import { runGhApi, succeeded, type Gh, type GhCall } from './gh.ts';

/** A repository on a host of GitHub, github.com or an Enterprise server. */
export interface GitHubRepository {
  readonly host: string;
  readonly owner: string;
  readonly repository: string;
}

/** A pull request by where it is: its repository and its number. */
export interface PullRequestTarget extends GitHubRepository {
  readonly number: number;
}

/** A pull request as a refusal names it: its number and the repository it lives in. */
export const pullRequestLabel = (target: Pick<PullRequestTarget, 'number' | 'owner' | 'repository'>): string => `pull request #${String(target.number)} of ${target.owner}/${target.repository}`;

/**
 * A pull request as a command names it: its number, and its repository as
 * `<host>/<owner>/<repo>` when the command gave its URL, or null for a
 * number, which `gh` resolves against the clone.
 */
export interface PullRequestName {
  readonly number: number;
  readonly repository: string | null;
}

/**
 * The segments of the path of a pull request's URL,
 * `/<owner>/<repo>/pull/<number>`, as the URL spells them, with the
 * segments after the number in `rest`.
 */
export interface PullRequestPath {
  readonly owner: string;
  readonly repository: string;
  readonly number: string;
  readonly rest: readonly string[];
}

/**
 * The path of `url` split as a pull request's, or null when it has no
 * owner, repository and number around a `pull` segment. Each caller checks
 * the segments as its source asks: `--pr` allows text after the number,
 * and GitHub's URL of a pull request must be of the number asked for.
 */
export function pullRequestPathOf(url: URL): PullRequestPath | null {
  const [owner, repository, pull, number, ...rest] = url.pathname.split('/').slice(1);
  if (owner === undefined || repository === undefined || pull !== 'pull' || number === undefined) return null;
  return { owner, repository, number, rest };
}

/**
 * What the engine keeps of a pull request: where it is, read from its URL;
 * whether it is open and whether it was merged; the commit of its head;
 * the name of its base branch; how many files it changes; and its title
 * and body, the body null when GitHub gives none or an empty one.
 */
export interface PullRequest extends PullRequestTarget {
  readonly url: string;
  readonly state: 'open' | 'closed';
  readonly merged: boolean;
  readonly head: string;
  readonly baseRef: string;
  readonly changedFiles: number;
  readonly title: string;
  readonly body: string | null;
}

/** The statuses GitHub gives a file of a pull request. */
export const pullRequestFileStatuses = ['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged'] as const;
export type PullRequestFileStatus = (typeof pullRequestFileStatuses)[number];

/** A file of a pull request: its path at the head, its status, the path it had before a rename or a copy, and its patch, null when GitHub shows no diff for it. */
export interface PullRequestFile {
  readonly path: string;
  readonly status: PullRequestFileStatus;
  readonly previousPath: string | null;
  readonly patch: string | null;
}

/** A review of a pull request, or a comment of one: its id, its URL and its body. */
export interface PostedText {
  readonly id: number;
  readonly url: string;
  readonly body: string;
}

/** A comment of a review to post, on a line of the new side of the diff of `path`. */
export interface NewReviewComment {
  readonly path: string;
  readonly line: number;
  readonly body: string;
}

/** A review to post: the commit it is made on, its body, and its comments on lines. */
export interface NewReview {
  readonly commit: string;
  readonly body: string;
  readonly comments: readonly NewReviewComment[];
}

/** The most files GitHub lists for a pull request; one that changes more is refused before its files are listed. */
export const maxListedFiles = 3000;

/** How many paths of each side a difference of the changed paths names. */
export const maxNamedPaths = 10;

const commitSha = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);

const pullRequestSchema = z.object({
  html_url: z.string(),
  number: z.number().int().positive(),
  state: z.enum(['open', 'closed']),
  merged: z.boolean(),
  head: z.object({ sha: commitSha }),
  base: z.object({ ref: z.string().min(1) }),
  changed_files: z.number().int().nonnegative(),
  title: z.string(),
  body: z.string().nullable(),
});

const refSchema = z.object({ object: z.object({ sha: commitSha }) });

const comparisonSchema = z.object({ merge_base_commit: z.object({ sha: commitSha }) });

const filesSchema = z.array(
  z.object({
    filename: z.string().min(1),
    status: z.enum(pullRequestFileStatuses),
    previous_filename: z.string().min(1).optional(),
    patch: z.string().optional(),
  }),
);

const postedTextSchema = z.object({ id: z.number().int().positive(), html_url: z.string(), body: z.string().nullable() });

/** The bodies of a call that succeeded, or the error of one that did not. */
function bodiesOf(gh: Gh, what: string, call: GhCall): readonly unknown[] {
  const result = runGhApi(gh, call);
  if (!succeeded(result)) throw new GitHubCallError(what, result);
  return result.bodies;
}

/** `body` parsed with `schema`, or the error of an answer the engine cannot read. */
function parsed<T>(schema: z.ZodType<T>, body: unknown, what: string): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new GitHubCallError(what, { kind: 'unreadable', detail: z.prettifyError(result.error) });
  return result.data;
}

/** The one body of a call that does not follow pages, parsed. */
function readOne<T>(gh: Gh, what: string, call: GhCall, schema: z.ZodType<T>): T {
  return parsed(schema, bodiesOf(gh, what, call)[0], what);
}

/** The items of every page of a list, each page parsed. */
function readAll<T>(gh: Gh, what: string, call: GhCall, schema: z.ZodType<T[]>): T[] {
  return bodiesOf(gh, what, { ...call, paginate: true }).flatMap((body) => parsed(schema, body, what));
}

/** The endpoint of `repository`, each part percent-encoded. */
function repositoryPath(repository: GitHubRepository): string {
  return `repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}`;
}

/** The endpoint of the pull request `target`. */
function pullPath(target: PullRequestTarget): string {
  return `${repositoryPath(target)}/pulls/${String(target.number)}`;
}

/** The host, the owner and the repository of `name`, which is `<host>/<owner>/<repo>`. */
function repositoryOfName(name: string): GitHubRepository {
  const parts = name.split('/');
  const [host, owner, repository] = parts;
  if (parts.length !== 3 || host === undefined || owner === undefined || repository === undefined || parts.some((part) => part === '')) {
    throw new PullRequestRefusedError(`${name} is not <host>/<owner>/<repo>`);
  }
  return { host, owner, repository };
}

/** The call that reads the pull request `name`: in the clone for a number, on its host for a URL or a target. */
function pullRequestCall(name: PullRequestName | PullRequestTarget): GhCall {
  if ('host' in name) return { endpoint: pullPath(name), hostname: name.host };
  if (name.repository === null) return { endpoint: `repos/{owner}/{repo}/pulls/${String(name.number)}` };
  const repository = repositoryOfName(name.repository);
  return { endpoint: pullPath({ ...repository, number: name.number }), hostname: repository.host };
}

/** Where the pull request of `url`, `https://<host>/<owner>/<repo>/pull/<number>`, is, or null when the URL is not of that form or of another number. */
function targetOfUrl(url: string, number: number): PullRequestTarget | null {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return null;
  }
  const path = pullRequestPathOf(parsedUrl);
  if (path === null || path.rest.length > 0 || path.owner === '' || path.repository === '' || path.number !== String(number)) return null;
  return { host: parsedUrl.host, owner: decodeURIComponent(path.owner), repository: decodeURIComponent(path.repository), number };
}

/**
 * Read the pull request `name`, as a command names it or where a run
 * recorded it. A number is read in the clone that `gh.cwd` names, which
 * fills `{owner}` and `{repo}` with the repository `gh` takes for it; a
 * URL's repository and a target are read on their host. The host, the
 * owner and the repository are those of the pull request's own URL, so
 * every later call names the host that GitHub gave.
 */
export function readPullRequest(gh: Gh, name: PullRequestName | PullRequestTarget): PullRequest {
  const what = `reading pull request #${String(name.number)}`;
  const answer = readOne(gh, what, pullRequestCall(name), pullRequestSchema);
  const target = targetOfUrl(answer.html_url, name.number);
  if (target === null) throw new GitHubCallError(what, { kind: 'unreadable', detail: `${answer.html_url} is not the URL of pull request #${String(name.number)}` });
  return {
    ...target,
    url: answer.html_url,
    state: answer.state,
    merged: answer.merged,
    head: answer.head.sha,
    baseRef: answer.base.ref,
    changedFiles: answer.changed_files,
    title: answer.title,
    body: answer.body === null || answer.body === '' ? null : answer.body,
  };
}

/**
 * The commit at the head of the branch `ref` of `repository`. Each segment
 * of the name is percent-encoded, since a branch name can hold `#` or `%`,
 * and its slashes stay the separators of the ref.
 */
export function readBranchHead(gh: Gh, repository: GitHubRepository, ref: string): string {
  const encoded = ref.split('/').map(encodeURIComponent).join('/');
  return readOne(gh, `reading the head of branch ${ref}`, { endpoint: `${repositoryPath(repository)}/git/ref/heads/${encoded}`, hostname: repository.host }, refSchema).object.sha;
}

/** The merge base that GitHub's comparison of the commits `base` and `head` of `repository` gives. */
export function readMergeBase(gh: Gh, repository: GitHubRepository, base: string, head: string): string {
  return readOne(gh, `comparing ${base} with ${head}`, { endpoint: `${repositoryPath(repository)}/compare/${base}...${head}`, hostname: repository.host }, comparisonSchema).merge_base_commit.sha;
}

/**
 * Every file of the pull request, 100 a page and every page. A pull
 * request of more files than GitHub lists is refused before any is listed,
 * from its `changedFiles`.
 */
export function listPullRequestFiles(gh: Gh, pullRequest: PullRequestTarget & Pick<PullRequest, 'changedFiles'>): PullRequestFile[] {
  if (pullRequest.changedFiles > maxListedFiles) {
    throw new PullRequestRefusedError(`pull request #${String(pullRequest.number)} changes ${String(pullRequest.changedFiles)} files, and GitHub lists no more than ${String(maxListedFiles)}`);
  }
  const files = readAll(gh, `listing the files of pull request #${String(pullRequest.number)}`, { endpoint: `${pullPath(pullRequest)}/files?per_page=100`, hostname: pullRequest.host }, filesSchema);
  return files.map((file) => ({ path: file.filename, status: file.status, previousPath: file.previous_filename ?? null, patch: file.patch ?? null }));
}

/** Every review of the pull request, every page. */
export function listReviews(gh: Gh, target: PullRequestTarget): PostedText[] {
  return readAll(gh, `listing the reviews of pull request #${String(target.number)}`, { endpoint: `${pullPath(target)}/reviews?per_page=100`, hostname: target.host }, z.array(postedTextSchema)).map(postedText);
}

/** Every comment of the review `review` of the pull request, every page. */
export function listReviewComments(gh: Gh, target: PullRequestTarget, review: number): PostedText[] {
  return readAll(gh, `listing the comments of review ${String(review)}`, { endpoint: `${pullPath(target)}/reviews/${String(review)}/comments?per_page=100`, hostname: target.host }, z.array(postedTextSchema)).map(postedText);
}

/**
 * The JSON body of the post of `review`: one review whose event is
 * `COMMENT`, each comment on its line of the new side. `publish` freezes
 * it before it posts it, so the record holds what was sent.
 */
export function reviewInput(review: NewReview): unknown {
  return {
    commit_id: review.commit,
    body: review.body,
    event: 'COMMENT',
    comments: review.comments.map((comment) => ({ path: comment.path, line: comment.line, side: 'RIGHT', body: comment.body })),
  };
}

/**
 * Post `review` to the pull request as one review whose event is
 * `COMMENT` (`reviewInput`). Gives the review's id and URL; throws
 * `GitHubCallError` with what the call gave otherwise, whose `failure`
 * tells a refusal of GitHub from a post whose outcome is unknown.
 */
export function postReview(gh: Gh, target: PullRequestTarget, review: NewReview): { readonly id: number; readonly url: string } {
  const input = reviewInput(review);
  const posted = readOne(gh, `posting the review of pull request #${String(target.number)}`, { endpoint: `${pullPath(target)}/reviews`, method: 'POST', hostname: target.host, input }, postedTextSchema);
  return { id: posted.id, url: posted.html_url };
}

function postedText(text: z.infer<typeof postedTextSchema>): PostedText {
  return { id: text.id, url: text.html_url, body: text.body ?? '' };
}

/**
 * The changed paths that the files of a pull request imply, sorted, as
 * `git diff --no-renames` lists them: the path of each file that is not
 * `removed` is at the head, and that of a `removed` one is deleted; the
 * previous path of a `renamed` file is deleted too, while that of a
 * `copied` one stays in place; an `unchanged` file is no path.
 */
export function impliedPaths(files: readonly Pick<PullRequestFile, 'path' | 'status' | 'previousPath'>[]): string[] {
  const paths = new Set<string>();
  for (const file of files) {
    if (file.status === 'unchanged') continue;
    paths.add(file.path);
    if (file.status === 'renamed' && file.previousPath !== null) paths.add(file.previousPath);
  }
  return [...paths].sort();
}

/**
 * The changed paths on which a pull request's files and a change differ:
 * up to `maxNamedPaths` of each side, sorted, with how many there are.
 * `onGitHub` are paths the files imply that the change does not hold, and
 * `inChange` paths of the change that the files do not imply.
 */
export interface PathDifference {
  readonly onGitHub: readonly string[];
  readonly onGitHubCount: number;
  readonly inChange: readonly string[];
  readonly inChangeCount: number;
}

/** How the paths that `files` imply differ from `changed`, the changed paths of a change, or null when they are the same. */
export function pathDifference(files: readonly Pick<PullRequestFile, 'path' | 'status' | 'previousPath'>[], changed: readonly string[]): PathDifference | null {
  const github = new Set(impliedPaths(files));
  const change = new Set(changed);
  const onGitHub = [...github].filter((path) => !change.has(path)).sort();
  const inChange = [...change].filter((path) => !github.has(path)).sort();
  if (onGitHub.length === 0 && inChange.length === 0) return null;
  return { onGitHub: onGitHub.slice(0, maxNamedPaths), onGitHubCount: onGitHub.length, inChange: inChange.slice(0, maxNamedPaths), inChangeCount: inChange.length };
}

/** Whether a line of the new side of a patch is added by the pull request or a context line that it does not change. */
export type NewLineKind = 'added' | 'context';

const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * The lines of the new side of a file's patch, as GitHub gives it, each
 * added or context, or null when the file has no patch. A hunk header
 * `@@ -a,b +c,d @@` gives the new lines `c` to `c + d - 1`, a count left
 * out meaning 1. In the hunk a line that starts with `+` is added, one that
 * starts with a space is context, and one that starts with `-` has no new
 * line; a `\` line, such as "No newline at end of file", is neither. A
 * hunk ends when both of its counts are spent.
 */
export function newLinesOf(patch: string | null): ReadonlyMap<number, NewLineKind> | null {
  if (patch === null) return null;
  const lines = new Map<number, NewLineKind>();
  let oldLeft = 0;
  let newLeft = 0;
  let next = 0;
  for (const line of patch.split('\n')) {
    if (oldLeft === 0 && newLeft === 0) {
      const header = hunkHeader.exec(line);
      if (header !== null) {
        oldLeft = Number(header[2] ?? '1');
        next = Number(header[3]);
        newLeft = Number(header[4] ?? '1');
      }
      continue;
    }
    if (line.startsWith('\\')) continue;
    if (line.startsWith('-')) {
      oldLeft = Math.max(0, oldLeft - 1);
    } else if (line.startsWith('+')) {
      lines.set(next, 'added');
      next += 1;
      newLeft = Math.max(0, newLeft - 1);
    } else {
      // A context line; one that lost its leading space to a tool that trims lines is still one.
      lines.set(next, 'context');
      next += 1;
      oldLeft = Math.max(0, oldLeft - 1);
      newLeft = Math.max(0, newLeft - 1);
    }
  }
  return lines;
}
