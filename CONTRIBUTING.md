# Contributing

Thanks for looking. This is a small, deliberately dependency-free project, and it stays that way: no runtime dependencies beyond Node.js, and no build step.

## Before you open a pull request

```sh
npm test        # the whole suite, with mocked inference; spends nothing
npm run check   # parses the server, the page, and the command line
```

Both must pass. The browser smoke test is `scripts/browser-check.mjs` and needs `PLAYWRIGHT_MODULE` pointed at an installed Playwright; it drives a real page against a temporary data directory.

## What a change should carry

- **A test.** The suite runs meetings end to end with scripted members, so most behaviour can be tested without a model call. Look at `test/reliability.test.mjs` for the pattern.
- **Honest wording.** The interface and the documents say what is a boundary the machine enforces and what is only an instruction to a model. If your change blurs that line, it will be asked about.
- **No new runtime dependency** unless the case for it is overwhelming. Adapters, parsers and sandboxing are all written against Node's standard library on purpose.

## Things worth knowing

- `lib/meeting.mjs` is pure: rules of order, prompts, speaker order, planning, metrics. Test it directly.
- `lib/mesh.mjs` runs meetings and persists them; `server.mjs` is the HTTP API; `public/` is the interface, served from disk, so a page change needs no restart.
- `public/meeting-state.js` is shared by the server and the browser so the verdict, budgets and citations are computed the same way in both.
- Prompts are part of the product. A wording change to the rules of order is a real change: say what you expect it to do to member behaviour, and why.

## Security

Please read [SECURITY.md](SECURITY.md) first. Several things that look like vulnerabilities are deliberate and documented, and the trust model explains which. Report anything genuine through GitHub's private vulnerability reporting rather than a public issue.
