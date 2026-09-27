### Angle SCAN — line-by-line diff scan (triage)
Read every hunk in the diff, line by line. Then read the enclosing function
for each hunk. For every line ask: what input, state, timing, or platform
makes this line wrong? Look for inverted/wrong conditions, off-by-one,
null/undefined deref, missing `await`, falsy-zero checks, wrong-variable
copy-paste, error swallowed in catch, unescaped regex metachars.
