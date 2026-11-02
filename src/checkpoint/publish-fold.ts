/**
 * What the events of `deep-review publish` say about a run, and the
 * reducers that fold them (R13, TD5 of the review on the pull request): each
 * publication in ledger order, prepared before its post, then posted or
 * dropped. The fold holds a run to one open publication at a time, on the
 * pull request and the head the run reviewed, and to at most one posted
 * review, so a run is posted at most once.
 */
import { publicationMarker } from '../review/markers.ts';
import type { PublishDropped, PublishPosted, PublishPrepared } from './events.ts';
import type { DecodedEvent, Reducer, RunState } from './fold.ts';
import { invalid, requireRun } from './review-fold.ts';

/**
 * One publication of a run: prepared and not settled yet, which a stop
 * can leave so and the next `publish` settles by its marker; posted, with
 * the review and the comments GitHub made; or dropped, with the reason.
 */
export type Publication =
  | { readonly status: 'prepared'; readonly prepared: PublishPrepared }
  | { readonly status: 'posted'; readonly prepared: PublishPrepared; readonly posted: PublishPosted }
  | { readonly status: 'dropped'; readonly prepared: PublishPrepared; readonly dropped: PublishDropped };

/** The URL of the review of the run's posted publication, or null while none is posted; a run is posted at most once. */
export function postedReviewUrl(run: Pick<RunState, 'publications'>): string | null {
  for (const publication of run.publications) if (publication.status === 'posted') return publication.posted.review.url;
  return null;
}

/**
 * A publication before its post (R13 of the review on the pull request):
 * only in a run whose scope has a pull request, while no other is open and
 * none was posted; marked with the next serial of the run; on the pull
 * request the capture recorded and at the run's head (PD2 of the
 * requirements); and placing only findings the run ranked.
 */
const publishPrepared: Reducer<PublishPrepared> = (state, payload, event) => {
  const current = requireRun(state, event);
  const scope = current.scope;
  if (scope?.pullRequest == null) throw invalid(event, 'prepares a publication, but its scope has no pull request');
  const open = current.publications.find((publication) => publication.status === 'prepared');
  if (open !== undefined) throw invalid(event, `prepares a publication while ${open.prepared.marker} is open`);
  const posted = current.publications.find((publication) => publication.status === 'posted');
  if (posted !== undefined) throw invalid(event, `prepares a publication after ${posted.prepared.marker} was posted`);
  const marker = publicationMarker(event.runId, current.publications.length + 1);
  if (payload.marker !== marker) throw invalid(event, `marks its publication ${payload.marker}, not ${marker}`);
  const { host, owner, repository, number } = scope.pullRequest;
  const target = payload.target;
  if (target.host !== host || target.owner !== owner || target.repository !== repository || target.number !== number) {
    throw invalid(event, `prepares a publication to ${target.host}/${target.owner}/${target.repository}#${String(target.number)}, not to the pull request it reviewed, ${host}/${owner}/${repository}#${String(number)}`);
  }
  if (payload.commit !== scope.head) throw invalid(event, `prepares a publication on ${payload.commit}, not on the head it reviewed, ${scope.head}`);
  const ranked = new Set((current.review?.ranking ?? []).map((finding) => finding.id));
  const stray = payload.places.find((place) => !ranked.has(place.finding));
  if (stray !== undefined) throw invalid(event, `places ${stray.finding}, which is not a finding of the run`);
  return { ...current, publications: [...current.publications, { status: 'prepared', prepared: payload }], lastSequence: event.sequence };
};

/** The open publication, which must be the one `marker` names; `verb` names what the event does with it. */
function requireOpen(current: RunState, marker: string, event: DecodedEvent, verb: string): PublishPrepared {
  const last = current.publications.at(-1);
  if (last?.status !== 'prepared' || last.prepared.marker !== marker) throw invalid(event, `${verb} the publication ${marker}, which no open publication of the run is`);
  return last.prepared;
}

/** The run with its last publication, the open one, replaced. */
const settled = (current: RunState, publication: Publication, event: DecodedEvent): RunState => ({ ...current, publications: [...current.publications.slice(0, -1), publication], lastSequence: event.sequence });

/** The open publication, posted (R13): each comment of a finding it put on a line. */
const publishPosted: Reducer<PublishPosted> = (state, payload, event) => {
  const current = requireRun(state, event);
  const prepared = requireOpen(current, payload.marker, event, 'posts');
  const onLine = new Set(prepared.places.filter((place) => place.place === 'line').map((place) => place.finding));
  const stray = payload.comments.find((comment) => !onLine.has(comment.finding));
  if (stray !== undefined) throw invalid(event, `matches a comment to ${stray.finding}, which the publication did not put on a line`);
  return settled(current, { status: 'posted', prepared, posted: payload }, event);
};

/** The open publication, dropped (R13): GitHub refused it, or a settle found no review that carries its marker. */
const publishDropped: Reducer<PublishDropped> = (state, payload, event) => {
  const current = requireRun(state, event);
  const prepared = requireOpen(current, payload.marker, event, 'drops');
  return settled(current, { status: 'dropped', prepared, dropped: payload }, event);
};

export const publishReducers = {
  'publish.prepared@1': publishPrepared,
  'publish.posted@1': publishPosted,
  'publish.dropped@1': publishDropped,
} as const;
