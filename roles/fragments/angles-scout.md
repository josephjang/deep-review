### Angle RIPPLE — cross-file tracer
For each function the diff changes, find its callers (search for the symbol)
and check whether the change breaks any call site: a new precondition, a
changed return shape, a new exception, a timing/ordering dependency. Also
check callees: does a parallel change in the same diff make a call unsafe?

**A contract the diff clarifies or fixes at one call site must be checked at every caller, including unchanged callers that predate the diff.**
Trace the shared callee even when its implementation is unchanged. Different
callers' compensations for that contract are leads to inspect, not scope
exclusions based on code age. Surface a candidate when you can name the
required failure scenario; tie it to that contract rather than treating
every old caller or differing implementation as a bug.

### Angle FOOTGUNS — language-pitfall specialist
Scan for the classic pitfalls of the diff's language/framework — for
example: JS falsy-zero, `==` coercion, closure-captured loop var; Python
mutable default args, late-binding closures; Go nil-map write, range-var
capture; SQL injection; timezone/DST drift; float equality. Flag any
instance the diff introduces.

### Angle WRAPPERS — wrapper/proxy correctness
When the diff adds or modifies a type that wraps another (cache, proxy,
decorator, adapter): check that every method routes to the wrapped instance
and not back through a registry/session/global — e.g. a caching provider
holding a `delegate` field that resolves IDs via `session.get(...)` instead
of `delegate.get(...)` will re-enter the cache or recurse. Also check that
the wrapper forwards all the methods the callers actually use.

### Angle EFFICIENCY — wasted work & resource cost
Flag performance costs the diff introduces: redundant computation or
repeated I/O, independent operations run sequentially that could overlap,
blocking work added to startup or a hot path, an O(n²)-or-worse pattern on
data that can grow. Also flag long-lived objects built from closures or
captured environments — they pin the whole enclosing scope in memory for
the object's lifetime (a leak when that scope holds large values); prefer a
struct/class that copies only the fields it needs. Name the cheaper
alternative.

**Required `failure_scenario`**: the concrete cost — what is recomputed,
re-fetched, serialized, or retained, and at what scale or frequency it
bites ("re-parses the 2 MB manifest on every keystroke"; "the timeout
closure captures the 50 MB response, keeping it alive for 30 s"). Surface
the candidate whenever you can name the wasted work, even without a
benchmark; the verifier filters.

### Angle DUPLICATION — duplication, reuse & single-callsite
Three sub-searches — within the diff, against the files the diff touches,
and (for reuse) against the helpers the wider codebase already provides:

- **Duplication to extract.** Flag any case where the diff introduces (or
  leaves untouched in a touched file) two or more near-identical fragments.
  For each, name the duplicated mechanism, the locations, and the shape of
  the extracted helper. The verifier will decide whether extraction
  actually helps (three or more usually does; two depends on whether the
  call sites read better after) and whether the similarity is real vs.
  coincidental (two domains that happen to look alike right now but will
  evolve independently).
- **Reuse over reinvention.** Flag new code that re-implements a helper,
  utility, or pattern the codebase already provides (search for the
  capability before assuming it's new) — name the existing symbol to call
  instead. Also flag dead code the diff leaves behind: a branch the change
  made unreachable, a helper or import it orphaned.
- **Single-callsite inlining.** Flag classes, structs, types, methods, or
  functions added or touched by the diff that have exactly one caller, and
  recommend inlining. The verifier will decide whether the construct
  actually earns its keep — documents intent, provides a test seam, or
  otherwise contributes to clean design.

**Required `value_statement`**: one sentence naming the improvement.
Strong examples:

- "three identical 8-line blocks collapse into one helper, so the next fix
  happens in one place instead of three"
- "this single-caller class is a thin shell around `serialize()` and
  inlining removes a level of indirection without losing any test seam"
- "the two near-identical branches differ only in the field name; a small
  helper parameterized on the field reads more cleanly than the
  side-by-side blocks"
