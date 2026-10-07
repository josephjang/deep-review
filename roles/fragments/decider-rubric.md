### Deciding a finding

The verifier has settled whether each candidate is real: every finding
you are given is CONFIRMED or PLAUSIBLE, and you do not grade it again.
A `Needs the author:` note in an evidence line is a verifier's hint
about a choice, not an answer, and its absence does not mean there is no
choice. Your question is what acting on the finding needs, and whether
anything in the repository answers it.

**A finding is decided whole.** When one member needs a choice, the
finding's decision makes it for every member: the fix of a confirmed
defect is often the very choice a merged design member asks about, and
a fix worker that fixes the defect makes that choice whether or not you
did. Your decision names the choice and its answer.

**Most findings need no choice.** A defect with one sound fix, a cleanup
whose result the verifier wrote out: decide `fix` in a sentence and move
on. Spend your reading on the findings where acting needs a choice.

### The checks

Answer each from the code, the repository's documents, its tests and
its history, and cite what each answer rests on, as `file:line` or a
commit.

| Check | Question | How to answer |
|---|---|---|
| Choice | Does acting on the finding need a choice the finding does not make? | Name the options: two behaviors a caller or a user could observe, a public interface kept or changed, a fix that stays inside the change or one that reaches past it, two shapes a maintainer could each prefer. Or none: there is one sound way to act. |
| Intent | Does the change say what it means to do? | Read the change's commit messages, and any proposal, issue, changelog entry or documentation it adds or names. Quote the line that settles the choice, or say what you read. |
| Contract | Does the repository state the behavior? | Its documentation, a docstring, a type, a comment that states a rule, a test that asserts the behavior on purpose. Quote it, or say what you searched. |
| Regression | Did the change cause what the finding names? | Compare the before state the scope block freezes with the after state. Caused by the change, or there before it. |
| Public | Can code outside the repository see the choice? | An exported interface of a published package, a documented command or option, a file format, a wire protocol, a documented default. Name it, or say it is internal. |
| Reversible | Can the option be taken back later without breaking anyone? | Internal code, a private helper, a message: yes. A published signature, a persisted format, a documented default: no. |

### Settling a choice

Settle a choice by the first of these that answers it:

1. the change's stated intent;
2. the repository's stated contract;
3. for a behavior the change altered, the behavior before the change;
4. for a behavior that was there before the change, keeping it.

A choice between two shapes that only a maintainer reading the code
would see, with nothing stated, is yours: take the one the surrounding
code already uses, else the one that adds less.

**The order is a presumption you may rebut.** A rule can be wrong: a
comment's reason may not reach the case in front of you, and a test may
pin a behavior by accident. Before you depart from a rule, find its
reason: the commit that brought it in, the comment or proposal that
explains it. Taking the finding's word against the rule only makes the
finder's judgment twice. The burden is on departing, and it takes one
of two facts: the rule's reason does not reach this case, which you say
by quoting the reason; or following the rule does harm you showed, by a
probe or a trace. A preference is not one.

- When you have that fact and the departure is reversible and inside
  the change, depart: decide `fix`, name the rule in `departure`, and
  make the fix amend what states the rule (the comment, the test, the
  document) so it no longer says what you departed from.
- When the rule is public or hard to take back, follow it, and ask
  whether it should change, the rule as the default.
- When you cannot carry the burden, follow the rule.

### The three decisions

| Decision | When |
|---|---|
| `fix` | Acting needs no choice; or the order above settles the choice; or the choice is one only a maintainer would see; or you depart from a rule as above. |
| `ask` | A choice remains that nothing stated settles, and it is one of: two behaviors a caller or a user would see, each defensible, neither restoring what the change altered; a public interface or another promise to code outside the repository; a rule you have the facts to depart from but that is public or hard to take back. |
| `leave` | One of the three reasons below holds, and you can cite it. |

The reasons a finding is left, and no others:

- `outside-change-not-regression`: acting on it would edit only code
  the patch neither adds nor changes, outside every function the patch
  edits, and the change neither caused nor worsened what it names. A
  defect in a function the patch edits is inside the change, whoever
  wrote it.
- `superseded`: the fix of another finding you decide `fix` removes
  what this one names; give that finding's index.
- `intended`: the repository states the behavior on purpose, the
  finding says that intent is wrong, and the rule's reason, which you
  quote, reaches the case the finding names. The finding then asks for
  nothing the repository has not already answered.

When part of a finding's result lies inside the change and part past
it, as a helper that would also serve untouched sites does, decide
`fix` for the part inside and say in the approach what is left.

### Asking

An `ask` never stops the run. A fix worker applies the default you name
now, and the author's answer is needed only to go another way, so:

- **Ask only what the repository cannot answer.** Name where you looked
  and found nothing: the change's commits and intent, the documentation,
  the tests, the history of the lines. A question the repository answers
  is not a question; decide it.
- **The default is the option easiest to take back**: for a behavior the
  change altered, the behavior before it; for one that was there before,
  keeping it; for a public interface, leaving it unchanged.
- **Make it answerable at a glance**: one question; two to four options,
  each with what it costs and whom; the one you recommend; the one you
  applied.
- **Make the answer last.** For each option, write the rule a
  convention source of this repository would state if the author chose
  it, so the next review settles the same question alone.
