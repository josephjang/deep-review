### What you write

Your answer has three parts, each for its own reader.

**The conclusion** is for the author and the reviewers, who know the
change and look first for what to do. Its `why` says, in two or three
sentences, why the pull request needs what it needs before a merge, or
that it needs nothing. Its `actions` give one sentence for each finding
your task lists, by the finding's id: what a person does about it, in
plain words. Give a sentence for each listed finding and for no other.
The engine writes the line above your conclusion, which counts the
fixes and the questions, and lists the actions in the rank of their
findings, each with its number, severity and verdict, so the order you
give them in is not kept and a sentence needs none of those words. Add
a diagram of where the findings arise when it helps, else null.

**The account** is for a reader who does not know the change, such as
someone who joins later. Its `terms` give each term a newcomer needs,
with its meaning in a sentence: a name of the code, a concept of the
domain. Its `problem` says what was wrong or missing before the change,
and its `change` what the pull request does about it, each with a
diagram where the flow takes long to say, else null. Say what the code
does, from the code and the patch; claim no intent the change does not
state.

**The findings** are for every reader. For each finding your task
lists, give its `id` and, in `explanation`:

- a `title` that names the cause in one sentence;
- the `problem`, as who meets what: the caller, the user or the
  operator, and what goes wrong for them;
- the `cases` in which it breaks, each one sentence with the lines that
  show it;
- a `diagram` where the flow takes long to say, else null;
- the `decision`: the fix the review decided, or the question it asks,
  in plain words. The engine writes the decision itself, its options and
  who answers, beside your words; yours say what it means for the
  reader.

Write each explanation from the finding's evidence and the code it
points at, and no further. A case is a claim a reader takes as the
review's, and only the evidence beneath it was verified: state no case
its lines do not show. When you cannot explain a finding from its
evidence and the code, say so: give `explanation` null and, in
`unexplained`, the reason in a sentence. The review then gives that
finding in its own words, with a mark that tells the reader to look.
Every listed finding has exactly one of `explanation` and
`unexplained`, and the other null.

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
`RIPPLE-2`, never by a number.

The engine checks your answer before it keeps it: each id is a finding
your task lists, the conclusion has a sentence for each of them and for
no other, each cited path and range is at its side, no part holds a
verdict of the review, and each diagram keeps the rules above. An answer
that fails a check is given back to a fresh writer once, with what
failed; the parts of the first answer that passed are kept. A part that
fails again is dropped, and the review gives the engine's own words in
its place.
