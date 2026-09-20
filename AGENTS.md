# Using Overrule as an agent

Overrule convenes a council of AI models that argue under rules of order and return a verdict with its reasoning on the record. You can call it from the command line while you work, to get a second opinion that is not your own.

It is not a linter and not a search. It is slow, it spends model credits, and it is worth it when being wrong is expensive.

## Before you can use it

The server must be running on the machine (`npm start` in the Overrule checkout, default `http://127.0.0.1:4310`). Check with:

```sh
node /path/to/overrule/bin/overrule.mjs list
```

If that prints meetings, you are connected. If it says no server, tell the person rather than starting one yourself: the server holds their model sign-ins and their meeting history. Set `OVERRULE_URL` if it runs somewhere else. After `npm link`, the command is simply `overrule`.

## The two calls you will actually make

**Review a change you just made.** Run this from the repository you edited:

```sh
overrule review . --playbook changes --cycles 1 --json
```

The council reads your working tree, finds the change with `git status` and `git diff`, and judges that change, not the project. The exit status is the answer: **0** approved, **2** objections remain, **3** checks failed, **4** verification incomplete, **1** something went wrong.

**Ask a question that has no single right answer.** Design choices, migration plans, tradeoffs:

```sh
overrule ask "Is this migration plan sound? <the plan in full>" --cycles 2 --json
```

Attach material instead of pasting it when it is long: `--attach plan.md`, repeatable.

## What to do with the answer

Read the whole report, not just the verdict. The value is in the objections, which are recorded verbatim with the condition that would resolve each one.

- **Approved.** Say so, and name anything the council flagged anyway.
- **Objections remain.** Do not treat this as failure. Report the objections to the person in their own words, say which ones you agree with, and fix what is worth fixing.
- **Checks failed.** A command the council ran on the candidate failed. That is a fact, not an opinion; act on it.
- **Error.** Report what the message said. Do not retry in a loop.

Never present the council's findings as your own verification. Say where they came from. If a finding contradicts what you know about the code, check it yourself before passing it on: the members read the tree, but they can be wrong, and two of them agreeing does not make a thing true.

## Rules

- **Ask the person before spending their credits** on anything beyond a single quick meeting, and before a long one. Every meeting costs real money on their accounts.
- **Never pass `--level workspace-write` or `--level full-access` on your own initiative.** Those let the council's drafter change files or run unrestricted on the machine. Read-only is the default for a reason.
- **Never pass `--acknowledge` or `--acknowledge-full-access` to get past a warning** the person has not seen. The warning is the point: it means the tree holds secrets, or uncommitted work, or that the level has no boundary.
- **Do not send anything you would not paste into a chat window.** Everything the council reads reaches every model provider seated on it, including private code.
- **Do not run meetings in a loop.** One meeting, read the result, act.

## Useful options

| Option | What it does |
| --- | --- |
| `--playbook <id>` | Start from a report template. `overrule playbooks` lists them: security, changes, bugs, dependencies, architecture, tests, performance, readiness. |
| `--members <names>` | Pick the council by connection name. The default seats everything ready, up to eight. |
| `--cycles <n>` | Turns per member. 1 is a quick read, 2 is a real argument, more is a long meeting. |
| `--deep-research` | Members that can browse research the subject before taking a position, citing sources. Slower and more expensive. |
| `--attach <file>` | Give the council a document: a plan, a diff, a spec. Repeatable. |
| `--no-wait` | Print the meeting id and return immediately; pick it up later with `overrule watch <id>`. |
| `--json` | One object: `{ id, status, verdict, final, error, url }`. Use this, and read `final`. |

## If you are working on Overrule itself

`npm test` runs the whole suite with mocked inference and spends nothing. `npm run check` parses the server, the page, and the command line. The browser smoke test is `scripts/browser-check.mjs` and needs `PLAYWRIGHT_MODULE` set. Changes to `public/` are live; changes to the server need a restart, which interrupts running meetings and invalidates pairings, so ask before restarting. `docs/REFERENCE.md` describes every feature in full.
