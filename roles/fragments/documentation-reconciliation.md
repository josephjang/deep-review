## Bringing the documentation in line

**When assigned documentation reconciliation:** read the full task and
verify each named document against the current code of the tree, which
holds every fix. The patches your task names hold the edits of this run
alone: read them to tell what this run changed from what the change
under review changed. **Search the repository for renamed members and stale descriptions yourself, even when no drift was reported.**
Documentation is text for a person: a document, a changelog, or a
comment in the code that describes the changed behavior. Bring in line
each fact that the edits of this run made out of date, and only those:
leave a fact that was out of date before this run as it is.

**Write only what the repository settles.** Write what the code of the
tree, a decision your task names or an answer of the author settles,
and never invent shipped behavior from an unanswered design question:
when the correct text needs a choice that nothing settled, leave the
document as it is and report it `deferred` with that reason. Do not
change code, a test or a configuration to make a document true.

**Leave the rules of the repository as they are.** The scope block
lists the convention sources the repository survey named. Leave each of
them as it is, with the amendment of a rule that a fix departing from
it made; when the edits of this run made a statement of one false,
report it `deferred` with that reason. Respect the repository's rules
for historical or append-only records: leave such a record as it is and
report it `deferred`, naming the rule. Leave each path that the
`scope.exclude` patterns of your task match, and name that setting as
the reason for a stale fact there.

**Write each edit as the convention sources of the file ask**, and
where they say nothing, as the text around it. Before each snapshot,
run the checks your task gives that finish quickly, such as a lint, on
what the item touched, and correct within the item what they show,
since each snapshot becomes a commit the repository must accept on its
own. A generator's output is not an edit of documentation: restore what
a build, an install or a test rewrote before the snapshot.

**Answer each item once.** An item is `applied` when you brought its
document in line, `already-applied` when you verified its facts are
already correct, with `edits` null unless an earlier attempt's edits
hold them, and `deferred` when you leave it, with the reason in `note`:
a choice that nothing settled, a rule, or a path you cannot edit. No
item is `blocked`: nothing holds a file from you, and `requiredFiles`
stays empty. Every defer is reported to the person, who decides what
becomes of it, so a defer states the evidence that stopped you, not a
settled skip. For each document you edited, give one `static`
validation line: the document as its `source`, and in `evidence` the
code you compared it with. In `drift`, list each document you found out
of date at your end and did not bring in line. Return `tests` and
`suite` once.
