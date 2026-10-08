## Applying a fix

Fix each assigned finding in the order your task numbers them, which
puts the most severe first. Apply each with clean design in mind: fix
the underlying cause, do not patch around the smell. After each fix,
re-read the touched code and its enclosing function to confirm the fix
is correct and has not broken adjacent logic.

**Keep your edits within the repository's conventions.** The scope block
lists the convention sources the repository survey named. Write each
fix, its tests and any documentation it touches as the sources that
govern those files ask, and where they say nothing, follow the style of
the code around your edit. A rules file the scope block does not list is
not one this repository asks you to keep.

**Snapshot after each finding.** Your task gives a snapshot command.
When you have finished a finding, whatever its status, and before you
start the next, run that command with the finding's index. It copies
what you changed into your scratch directory, so the engine can tell
each finding's edits apart and commit them one by one; a finding you do
not snapshot is folded into the next one's commit.

**A finding's stated reason is part of the fix, not commentary.** Each
finding names the failure it fears or the divergence it sees — its
failure scenario, its value statement, or the verifier's evidence line.
After applying, re-read that statement and check every fact it cites
against your change: the divergence it names must be gone, the failure
it names must no longer be reachable. Doing what a finding literally
asks while leaving its reason standing is the classic incomplete fix — a
finding that asks for a shared helper BECAUSE the copies have diverged
is not fixed by a helper that preserves the divergence. If a cited fact
still stands and resolving it is beyond what you can safely do here,
report the finding `deferred` with that fact named, never `applied`.

**A finding may already be resolved in the code you receive** — an
interrupted earlier pass may have applied it before dying. Treat that as
a success to verify, not an anomaly: check the resolution against the
finding's stated reason exactly as if you had just made the change, and
report it `already-applied` — never `deferred`, and never re-apply it
on top of itself.

**Pre-existing bugs in the files you own are in scope** even when they
predate the diff. A real bug in code under your edit window is a real
bug, whoever wrote it.

**Defer only when you cannot safely resolve the finding here.** Every
defer is provisional: a later adversarial pass re-opens it with a
stricter, fix-biased bar, so a defer is a hypothesis to be retested, not
a settled skip. The criteria:

- No tests cover the area and the change would alter observable behavior.
- The decision you were given did not see a fact you found; name it.
- Your task gives you no decision, as a repair's does not, and the
  semantics are genuinely ambiguous and need a human design call, or the
  change crosses a public API boundary whose consumers you cannot audit
  from this repo.
- The finding is a genuine refactor that EITHER changes observable
  behavior the tests don't cover and you cannot pin with a new test, OR
  is a discretionary restructuring that expands beyond this change. An
  in-scope cleanup of code the change already touches is a CLEAR win: fix
  it now, whatever its size.

**Diff size is not a defer reason. Tedium is not a defer reason.** A
large but mechanical, fully-validatable fix is FIX, not defer. Size
matters only when it brings un-validatable risk or discretionary scope.
Never grounds to defer: regression risk you can validate, "well-tested",
"heavily commented", "the code is pre-existing".
