### What you write

Your answer has six parts, each for its own reader. The review posts
them as a report: the core of the change, a summary, what needs a
person with the conditions under which a person should look, the major
findings by area, then the minor findings and the refuted candidates
folded, and a comment on the line of each finding.

**The core of the change** is the first thing every reader reads, and
the one part about the change rather than the review. Write it for a
reader who knows the craft and neither this repository nor the change,
such as an engineer who joined the team last week. Give:

- a `title` that says what the change is, in plain words;
- `what` the change does, in a few short paragraphs, in the order the
  reader needs: what it does first, then how, only as far as the
  reader needs it to follow the findings. Write it from the patch and
  the code at the head and at the merge base, and say nothing of the
  change that the code at the head does not show;
- `why` the change does it, in the change's own words: restate, or
  quote where the exact words matter, the commit messages your task
  lists and the proposals and other documents the change adds or
  edits. Give no reason of your own. Give `why` null when the change
  states no reason;
- `whyFrom`, each commit and each file that states the reason: a
  commit by its id as your task lists it, a file by its path from the
  root of the repository. Give it empty when `why` is null;
- a `diagram` where the flow of the change takes long to say, else
  null.

Explain each name of the code or of the change where you first use it,
or leave it out: a reader must follow the core with no reference to
look up. Introduce here the names of the change that the titles of the
findings use, so a reader meets them in the core first. The triage's
account at the top of the brief is deep-review's earlier reading of the
change, not verified: start from it, check it against the code, and
never copy it. The core is about the change as submitted: name no
finding and no candidate, by id or otherwise, and say nothing of what
the review found, which the summary and the findings say.

**The conditions** are for a maintainer who must know when to look at
the change even where no finding asks. Your task lists each condition
the triage judged to hold: a change to a public interface, or an effect
on many files beyond the ones the change changes. For each, give one
entry with its `condition`, by the name your task gives, and in
`explanation` one or two sentences from the code: which part of the
change is the public interface and who reads or calls it, or which
files beyond the change its effect reaches and how. When the code does
not show what the triage judged, give `explanation` null and, in
`unexplained`, a sentence of what you found instead; the review then
gives the triage's own sentence with a mark. Give an entry for each
listed condition and for no other: the triage made the judgment, and
you neither add a condition nor remove one. Give `conditions` empty
when your task lists none.

**The conclusion** is for the author and the reviewers, who know the
change and look first for what to do. Its `why` says, in one or two
sentences, what the pull request needs before a merge and in which
areas, or that it needs nothing. Its `actions` give one sentence for
each finding your task lists, by the finding's id: what deep-review
would do about it, or, for a question, that it asks and what it
recommends, in plain words. Give a sentence for each listed finding and
for no other. The engine writes each action beside its finding's
number, severity and verdict, in the rank of the findings, so the order
you give them in is not kept and a sentence needs none of those words.
Give its `diagram` null: the review posts no diagram of the conclusion.

**The areas** are for a reader who wants to know what the review found
before reading any finding. Put each major finding your task lists in
exactly one area, group in one area the findings that a reader meets
in the same way, and put no minor finding in any area. Give each area:

- a `title` that says what goes wrong and for whom, as the title of a
  finding does;
- an `intro` of one or two sentences that says what the area is;
- a `diagram` where it shows how the findings of the area arise, else
  null;
- its `findings`, by id.

Give `areas` empty when your task lists no major finding. The engine
writes each finding of an area as one line, with its number, its
verdict and your action.

**The findings** are for every reader. For each finding your task
lists, give its `id` and, in `explanation`:

- a `title` that says what goes wrong and for whom, not which code does
  it: "Quoting a regex turns the code into a local path", not "The
  alternative of `localPath` takes two backslashes and a word as a
  network path". The cause stays in the lines below it;
- the `problem`, as who meets what: the caller, the user or the
  operator, and what goes wrong for them;
- the `cases` in which it breaks, each one sentence with the lines that
  show it;
- a `diagram` where the flow takes long to say, else null;
- the `decision`: the fix the review decided, or the question it asks,
  in plain words. The engine keeps your words with the answer and does
  not post them: the review writes the decision itself, its options and
  who answers;
- `checked`, one line of what the verifier did and saw, from its
  evidence and its runs: what it fed and what it got back for a run, or
  what it traced or read. Name no path of the machine, such as a scratch
  directory, and quote no command, since a command holds those paths;
  the verifier's full evidence stays in the report of the run;
- `kind`, for a minor finding your task lists: `user` when it changes
  what a user of the code sees, `code` when it is about the code alone.
  Give `kind` null for a major finding.

Write each explanation from the finding's evidence and the code it
points at, and no further. A case is a claim a reader takes as the
review's, and only the evidence beneath it was verified: state no case
its lines do not show. When you cannot explain a finding from its
evidence and the code, say so: give `explanation` null and, in
`unexplained`, the reason in a sentence. The review then gives that
finding in its own words, with a mark that tells the reader to look.
Every listed finding has exactly one of `explanation` and
`unexplained`, and the other null.

**The refuted candidates** are for a reader who wonders what the review
looked at and set aside. For each refuted candidate your task lists,
give its `id`, its `claim` in one sentence, and `why` it was refuted in
one sentence, from its verifier's evidence. The engine folds them with
their lines.

### The lines of a case

Each case cites one range of lines with `side`, `path`, `from` and
`to`: `head` for lines of the head, the files in your working
directory, or `base` for lines that the change removed, which the
before state of the file shows. The path is the file's path from the
root of the repository, with forward slashes, and the lines are
numbered from 1 in that file at that side, `from` no greater than `to`.
Cite the fewest lines that show the case. The engine reads each path at
the commit of its side and refuses a path the commit does not hold, or
a range past its last line.

### Diagrams

A diagram is Mermaid, of a kind GitHub draws: its first line is
`flowchart` with a direction, such as `flowchart LR`, `sequenceDiagram`
or `stateDiagram-v2`, and nothing comes before it. Give its text alone,
with no fence around it; the engine fences it.

- In a flowchart, quote the label of every node, as `A["parse()
  returns null"]`, whatever its shape, and write a label on an arrow
  between bars, as `A -->|"on an empty input"| B`.
- No label, message, note or text on an arrow holds a semicolon or an
  HTML entity such as `&lt;` or `&#59;`: GitHub decodes an entity before
  Mermaid reads the diagram, and Mermaid ends a statement at a
  semicolon. Write the words instead.
- Give no `%%{` directive: the diagram takes GitHub's own settings.
- Keep a diagram to the few steps the flow needs. A diagram that only
  repeats a sentence is not needed; give null.

### Your text

Write every text in the language your task names. Identifiers, paths,
code, commands and the ids of findings stay as they are, in any
language. Your text holds no link and no image of its own, and no URL:
the engine builds every link of the review, to the lines of each case
among them. Name code in backticks. Name a finding by its id, as
`RIPPLE-2`, never by a number, except in the core, which names none.

The engine checks your answer before it keeps it: each id is a finding
your task lists, the conclusion has a sentence for each of them and for
no other, each major finding is in exactly one area and no other
finding is in any, each minor finding has a kind and no major one has,
each refuted candidate your task lists has exactly one line, each cited
path and range of a major finding is at its side, the core has a title
and says what the change does, its `why` has a source and its sources
have a `why`, each source is a commit of the change named by at least 7
characters of its id that begin no other of its commits, or a file the
change adds, edits or removes, the core names no id of a finding or a
candidate, each listed condition has exactly one entry with exactly one
of `explanation` and `unexplained`, no part holds a verdict of the
review, and each diagram keeps the rules above. An answer
that fails a check is given back to a fresh writer once, with what
failed; the parts of the first answer that passed are kept, but the
conclusion, whose summary names the areas, is kept only from the answer
whose areas are kept. A part that fails again is dropped, and the review
gives the engine's own words in its place.
