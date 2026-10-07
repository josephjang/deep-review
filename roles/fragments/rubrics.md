### All rubrics — verify before you judge

A grade is decided by the answers to a few checks. Each check is a fact
you establish in the code, and each rubric's table says which answers
give which grade. How sure you feel decides nothing, and neither does
any of these: how old the code is (code a change touches is in scope
whenever it was written), whether a test exists or passes (a green test
can assert the bug or never reach the case), how large or risky the fix
would be.

**Grade the claim as written.** The candidate's `summary` and its fourth
field are the claim. When its central statement is false the grade is
REFUTED, even if something near it is true. If a narrower statement
survives, grade that statement by the same table and open the evidence
line with `Narrowed to:` and the statement. It gets no credit from the
original: it must pass every check on its own. For a design & cleanup
candidate, narrowing may replace the proposed result with a smaller one
that fixes the same problem. It never replaces the problem: when the
problem the candidate names is not there, no other problem rescues it.
*Why: a fixer acts on what the candidate says. A grade reached on some
other claim sends it to change something nobody checked.*

**Try to break it before you grade it.** Every table has an `Against`
check: the strongest fact that would defeat the candidate. Look for that
fact, and say in the evidence line what you looked for and what you
found. "Looked for a guard, found none" is an answer. Not having looked
is not.
*Why: finders are told to surface candidates they only half believe, so
your grade is the one filter between a candidate and an edit to the
tree.*

**Answer from the code.** Cite the lines each answer rests on, as
`file:line`. Where the question is what the code does when it runs and a
probe can run, run it; otherwise trace it line by line. When a check
cannot be answered here at all, because the code it needs is not in the
repository or nothing here can run it, say which check and grade
PLAUSIBLE.

**The evidence line** gives each check's answer in a clause, in the
table's order, and ends with the one answer that separates the grade
from the neighbouring one: `Not CONFIRMED: ...`, `Not REFUTED: ...`. It
holds at most 1000 characters, so keep each answer to a clause. If
acting on a real candidate would mean choosing between two behaviors the
code and its tests leave open, add `Needs the author:` and the choice.
That note never changes the grade.

### Rubric for the correctness & cost angles

Angles `SCAN`, `REMOVALS`, `RIPPLE`, `FOOTGUNS`, `WRAPPERS` and
`EFFICIENCY`. CONFIRMED and PLAUSIBLE both go to the decision step,
PLAUSIBLE telling it which condition is unsettled. REFUTED removes the
candidate.

| Check | Question | How to answer |
|---|---|---|
| Mechanism | Do the lines do what the candidate says? | Read them. Quote the line. |
| Trigger | Which input or state reaches it, and what does a user then see? | Name both: the input, and the wrong output, crash or wasted work. |
| Producer | What produces that input or state? | Name the caller, the entry point or the documented use. In a library published for others to use, a public interface has callers outside the repository: one that uses it as its signature and documentation allow is a producer, though the repository holds none. Otherwise say what you searched and that nothing produces it. |
| Against | What would stop it? | Search for a guard, a type, an invariant, a check in every caller. Cite it, or say none. |
| Cost (`EFFICIENCY` only) | How much work, at what input size, how often, and compared with what? | Count or measure it at a size the input can reach, and name the size. Name the path and how often it runs. Compare with the code before the change when the candidate says the change added the work, otherwise with the plain way to do the same thing. |

| Grade | Mechanism | Trigger | Producer | Against |
|---|---|---|---|---|
| CONFIRMED | as claimed | you ran or traced the named input to the wrong result | named | none found |
| PLAUSIBLE | as claimed | reached only under one condition you could not settle here: name it, and what would settle it | named | none found |
| REFUTED | not as claimed | or: no result a user could observe | or: nothing produces the state | or: a guard stops it |

For `EFFICIENCY` the grade is also REFUTED when the work stays within a
small constant factor of the comparison at every size the input can
reach, or is trivial wherever it lands: a few allocations, a loop over a
handful of items. Running once excuses nothing by itself: work that
grows faster than its input, such as a walk that is quadratic or
exponential in the size of what a user builds, is CONFIRMED once you
measured it at a size the input can reach, however rarely it runs. When
the candidate says the change added the work and the code before the
change did the same, the claim as written is false: grade the narrowed
claim, that the cost exists, on its own.

**Deliberate is not refuted.** A comment, a test or the documentation
may show that the behavior is intended. When the mechanism and the
trigger are real and the candidate names a result a user would call
wrong, the candidate stays: it may be saying the intent is wrong, and
that is the author's to decide. Grade it by the table and add
`Needs the author:` with the two behaviors.

**A false comment is a wrong result.** A comment, a docstring or a line
of documentation that says something untrue of the code as the change
leaves it misleads everyone who reads it, though nothing fails when the
code runs. For such a candidate the user is the reader and the wrong
result is the false statement: quote the statement and the lines that
contradict it. It is REFUTED when the statement is true of those lines,
or is only less exact than it could be and says nothing false.

What separates the grades:

- **CONFIRMED from PLAUSIBLE: the trigger, and nothing else.** In
  CONFIRMED you can write the input and the wrong result. In PLAUSIBLE
  you can write the mechanism and one named condition you could not
  settle: an interleaving of two requests, a platform or version, a
  configuration, an input size.
- **PLAUSIBLE from REFUTED: the producer and the guard.** A rare state
  still has a producer: an error handler, a cold cache, a missing
  optional field, an empty or zero value, two requests at once, an input
  that grows without bound. "Rare" and "speculative" are not "nothing
  produces it". In code only this repository calls, a state none of its
  callers produces is REFUTED, and so is one a guard you can cite
  excludes.
- **Refuting takes a fact you established**: the guard you cite, the
  search that found no producer, the run that showed no effect, the
  count or measurement that showed no added work. An argument that the
  effect ought to be harmless or the cost ought to be small is not that
  fact: grade PLAUSIBLE and name what would settle it.

Each side of each line:

- CONFIRMED: you ran `parse("")` and it threw at the line named, and no
  caller filters the empty string.
- PLAUSIBLE: a handler reads a field after an `await`, a second event
  can replace the field in between, and nothing here can run two events
  at once. Unsettled: the interleaving.
- REFUTED, no producer: the function is private, and its two callers
  each pass a value they checked on the line before.
- CONFIRMED, cost: building the index compares every pair of entries
  and took 4 s at 10,000 entries, a size the documentation names, though
  it runs once at startup.
- REFUTED, cost: the loop adds one pass over a list that never holds
  more than its handful of fields.

### Rubric for the design & cleanup angles

Angles `DESIGN`, `DUPLICATION` and `ALTITUDE`. CONFIRMED and PLAUSIBLE
both go to the decision step, PLAUSIBLE telling it the scope or the
choice that keeps the candidate from CONFIRMED. REFUTED removes the
candidate. The candidate's `value_statement` is the claim, and you are
its filter.

| Check | Question | How to answer |
|---|---|---|
| Problem | Is what the candidate calls a problem there? | Point to the lines that repeat, mislead or sit at the wrong level. |
| Against | Is it already solved, or is the construct there for a reason? | Look for a single home that already exists (a helper, a constant), a sibling the construct pairs with, a test seam, a comment that states the intent. Cite it, or say none. |
| Benefit | What can a maintainer no longer get wrong, or no longer has to read, once it is applied? | Write the result: the signature, the one home. Then test the `value_statement` against it: does the result still need what the candidate says it removes? If the proposed result fails but the problem is there, look for the smallest result that fixes that problem and grade it as the narrowed claim. |
| Price | What does the result add for a reader? | Count what is new: a function, a parameter, a flag or callback, a nesting level, a hop to follow. |
| Scope | Would it edit only lines the patch adds or changes, or lines of a function the patch edits? | Compare the lines with the patch. Inside or outside. |
| Choice | Does applying it need a decision the code does not settle? | Name it: a change a caller could observe, a public interface, or two results a maintainer could each prefer. Or none. |

| Grade | Problem | Against | Benefit and price | Scope | Choice |
|---|---|---|---|---|---|
| CONFIRMED | there | none found | the benefit holds and the result adds less than it removes | inside | none |
| PLAUSIBLE | there | none found | the benefit holds and the result adds less than it removes | outside | or: one, named |
| REFUTED | not there | or: already solved, or the construct earns its place | or: the benefit is not delivered, or the result adds as much as it removes | not asked | not asked |

PLAUSIBLE takes either of its two answers: Scope outside, or a Choice.

What separates the grades:

- **REFUTED from the other two: Problem, Against, Benefit and Price,
  and nothing else.** Scope, size and risk never refute: a real
  improvement that is large, risky or outside the patch is PLAUSIBLE.
  That a change can be made, compiles and keeps behavior is not a
  benefit: the benefit is the mistake that can no longer be made or the
  thing that no longer has to be read.
- **PLAUSIBLE from CONFIRMED: Scope and Choice, and nothing else.**
  PLAUSIBLE is not a place for doubt about the benefit. Settle the
  benefit, then let Scope and Choice decide between the two.

Each side of each line:

- REFUTED, already solved: two handlers "duplicate" a message that both
  already take from one helper. Only the call repeats.
- REFUTED, price: a new helper would replace two one-line expressions
  with two one-line calls and needs a flag to serve both.
- Kept, benefit holds: two sites restate a rule that an existing helper
  already implements. Calling it adds nothing and gives the rule one
  home.
- CONFIRMED: a local the patch adds is named for what it no longer
  holds, and one name fits.
- PLAUSIBLE, scope: the same rename, in a function the patch does not
  touch.
- PLAUSIBLE, choice: merging two branches removes a repeated statement
  and adds a nesting level, and each shape has a reader who would
  prefer it.

### Rubric for the CONVENTIONS angle

`CONVENTIONS` is precision-first, so the verifier mostly confirms what the
finder already quoted. CONFIRMED and PLAUSIBLE both go to the decision
step. REFUTED removes it.

- **CONFIRMED** — the cited file is a convention source the scope block
  lists, or a file such a source imports or links to, it genuinely
  governs the changed file (the paths its source applies to, when it
  names any, cover that file; when it names none, judge from where the
  source lives and what it says whether it reaches that file: a rules
  file in one package's directory governs that package, not its
  siblings) AND the quoted line breaks the quoted rule.
  Both quotes present and accurate.
- **PLAUSIBLE** — the rule governs and the line looks like a violation, but
  whether it actually breaks the rule turns on a reading the verifier can't
  settle alone. State the ambiguity.
- **REFUTED** — the cited file is neither a listed convention source nor
  a file one imports or links to, or doesn't govern this file, the line
  doesn't actually violate the rule, or the "rule" is the finder's own
  style preference rather than something a listed source states.

What separates the grades: CONFIRMED from PLAUSIBLE is whether the
rule's own words settle that the line breaks it, or two readings of
those words remain, both of which you state. Either of them from REFUTED
is whether a listed source states the rule and governs the file.
