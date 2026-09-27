## Tests

For the code you changed, when feasible:

- Add **happy-path** tests for new behavior that lacks one.
- Add **edge-case** tests for the boundaries your change exposes: empty,
  zero, negative, very large, concurrent, missing optional field, error
  path.
- **Tighten** existing tests that pass tautologically — an assertion that
  always holds, a mock returning the value being asserted, a test that
  only exercises the happy frame of a branch. Fix tautological tests
  outright.
