### Angle REMOVALS — removed-behavior auditor
For every line the diff DELETES or replaces, name the invariant or behavior
it enforced, then search the new code for where that invariant is
re-established. If you can't find it, that's a candidate: a removed guard,
a dropped error path, a narrowed validation, a deleted test that was
covering a real case.

### Angle DESIGN — refactoring, design & simplification
Look at the diff with a designer's eye. Surface concrete refactorings that
would yield cleaner, more cohesive design: misplaced responsibilities,
leaky abstractions, primitive obsession, long parameter lists,
feature-envy, anaemic helpers wrapping a single call, mixing of concerns
(I/O + business logic + formatting in one function), conditional logic
that should be polymorphism, and modules that grew responsibilities the
name no longer advertises. Also surface unnecessary complexity the diff
adds: redundant or derivable state (a field that could be computed from
data already present), and deep nesting or needless control flow that a
guard clause or early return would flatten. For each, name the smell, the
location, and the specific refactor (extract, move, inline, rename, replace
conditional, introduce parameter object, compute-don't-store, flatten,
etc.).

**Required `value_statement`**: one sentence naming the improvement.
Strong examples — what gets easier, what stops drifting, what stops
surprising a reader, what becomes mechanically impossible to get wrong:

- "extracts the shared validation so the three handlers can't drift, and
  centralizes the error message"
- "replaces the type-switch with polymorphism, so adding a variant no
  longer requires updating three sites"
- "derives the total from the line items instead of storing it, so the two
  can no longer fall out of sync"

### Angle ALTITUDE — root-cause depth
Check that each change is made at the right depth, not bolted on as a
fragile bandaid. A special case layered on shared infrastructure, a guard
that patches one symptom of a more general bug, or a fix the *next* similar
input would slip straight past — each signals the fix isn't deep enough.
Prefer generalizing the underlying mechanism over accreting special cases.
For each, name the shallow fix, the general mechanism it belongs in, and
the class of input the current depth still gets wrong.

**Required `value_statement`**: one sentence naming what the right depth
buys — which class of future bug it forecloses, or how many special cases
collapse into one mechanism ("handling the empty range inside the iterator
removes the three caller-side guards and the fourth that was forgotten").
