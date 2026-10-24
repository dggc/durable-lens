## What and why

<!-- What does this change, and why is it needed? Link the issue it closes. -->

## Checklist

- [ ] `npm run verify` passes.
- [ ] If the page or the server changed: `CHROME_BIN=... npm run check:ui` passes, and a screenshot made from a fixture is attached.
- [ ] Tests cover the change, and use fixtures or small hand-written stores. No real data.
- [ ] The invariants hold: no writes to the store, loopback with token, Host check and CSP, content rendered as text, no runtime dependencies.
- [ ] `CHANGELOG.md` has an entry under "Unreleased", if a user would notice the change.
- [ ] Documentation is updated (`README.md` or `docs/`), if behavior or options changed.
- [ ] I did not attach or paste a real store, transcript or `--json` output.
- [ ] If an AI tool wrote part of this change: I say so here, and I have read and tested all of it.
