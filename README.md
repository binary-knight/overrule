# Overrule

A local web app where several AI models hold a meeting about your problem and have to show their work. Each member opens with an independent position, then they argue on a shared floor: quoting the claim they answer, raising objections with a condition that would resolve them, and citing what changed their mind. A drafter writes the candidate, the others vote on that exact text, and the result carries the council record: how the floor closed, the vote, and every objection verbatim.

What makes it different from a group chat is the receipts. A meeting can be pointed at a project on your machine, at an access level whose boundary the app measures before offering it. The drafter implements in an isolated checkout, the app commits what it left behind, runs the checks you named on that exact commit, and shows voters the diff and the check output. Nothing touches your working tree until you press Apply.

Runs on Node.js 22 or newer with no runtime dependencies. Models come from your own subscriptions and keys: the Codex and Claude Code CLIs signed in on the host, or API keys for OpenAI, Anthropic, Gemini, Grok, Hugging Face, and any OpenAI-compatible server such as Ollama, LM Studio, or vLLM.

## Install

```sh
git clone https://github.com/binary-knight/overrule.git
cd overrule
npm start
```

Open http://localhost:4310 and choose **Try a scripted demo** to see a meeting without spending any credits. Set `PORT` if the default is busy. `npm restart` (or `./restart.sh`) restarts a server running in the background and logs to `data/server.log`. The server binds to all interfaces so other devices on your LAN can pair with it; set `OVERRULE_HOST=127.0.0.1` to keep it to this machine.

Optional host tools: `pdftotext` (poppler-utils) to read PDFs attached to a meeting, LibreOffice for old `.doc` and `.xls` files, Python 3.10+ to install [agentsec-pack](https://github.com/binary-knight/agentsec-pack) from inside the app for sandbox measurement.

## Connect your models

The default council seats Codex and Claude Code. Install their official CLIs and sign in from your own terminal:

```sh
codex login
claude auth login
```

The app checks each CLI's sign-in status at start and on demand, never reads their token files, and refuses to start a meeting that would fail on a signed-out member. Add more members from **Connections**:

| Connection | Authentication | Protocol |
| --- | --- | --- |
| Codex | The CLI's own sign-in | `codex exec --json` |
| Claude Code | The CLI's own sign-in | `claude --print --output-format json` |
| OpenAI API | Saved key or `OPENAI_API_KEY` | Responses API |
| Anthropic API | Saved key or `ANTHROPIC_API_KEY` | Messages API |
| Gemini API | Saved key or `GEMINI_API_KEY` | OpenAI compatibility endpoint |
| Grok API | Saved key or `XAI_API_KEY` | Chat Completions |
| Hugging Face Inference Providers | Saved token or `HF_TOKEN` | OpenAI-compatible, via the HF router |
| OpenAI-compatible | Optional saved key | Any `/chat/completions` endpoint, with presets for local servers |

Every connection names one model, and you can hold several connections per provider, so one council can seat different models from the same vendor beside a local one. Each member gets a perspective: pick one of ten archetypes or write your own. A meeting seats two to eight members. Saved keys are encrypted at rest and never sent back to the browser.

Subscription sign-ins are personal credentials. The app launches the unmodified CLIs on your machine and leaves authentication with the vendor. Do not turn it into a shared subscription proxy.

## How a meeting runs

1. **Brief.** Describe the problem, pick the members, choose how many cycles the floor runs (a cycle is one turn per member) and who drafts. Attach documents or a workspace if you want.
2. **Openings.** Every member writes a position without seeing the others. They are revealed together so nobody anchors the rest.
3. **Floor.** Members speak one at a time, reading the whole thread. A turn must quote the exact claim it answers. Objections carry the claim and a condition that would resolve them, get an id, and stay open until the member who raised them says the condition is met. A member who moves from disagree to agree must cite the entry that changed its mind, or the change is not accepted. Speaking order goes to the target of an unanswered objection first, then the previous speaker's nominee, then whoever has been heard least recently.
4. **You can speak.** Anything you type is delivered at the next turn boundary and the next member must address it. Speaking after a candidate exists voids the ballots on it.
5. **Close.** By consensus, on budget, or as stalled when two full cycles pass with no movement. The reason is recorded.
6. **Draft and ratify.** The drafter writes the candidate. Every other member votes independently on that text. If anyone objects, the drafter revises and the vote repeats, for as many rounds as you allowed.
7. **Verdict.** The result is headed **Approved**, **Objections remain**, **Checks failed**, or **Verification incomplete**, judged separately from floor consensus. Approval needs every eligible reviewer's approval, no open objection, and finished checks for workspace changes; a failed check outranks any vote. An evidence panel links each ballot, objection, validated quote, check result, and the reviewed commit to its place in the transcript.
8. **Pause or stop, then change your mind.** **Pause** lets the step in flight finish and holds the meeting there, so no call is thrown away; **Stop** ends the current call immediately. Either way the **Adjust and resume** panel lets you change what the council works with before picking it up again: the access level, whether the implementer and the checks get the network, the check commands, the implementer's time limit, the number of cycles, how many revisions are allowed, internet and deep research, the time limit for one member's turn, and the session limits. Add a note and the next member has to answer it. The change itself goes on the record. An implementation that was interrupted keeps its checkout, so the drafter resumes on its own partial work rather than starting over. The brief, the members, and the workspace folder stay fixed, because everyone has already read them.
9. **Reconvene.** A closed meeting can be reopened with a new instruction. The same members carry on with the whole record, the workspace branch, and the documents, in a new session with its own budget, draft, and vote. Use it for work that does not fit one sitting.

Every prompt states what each member can actually do this turn and that only the drafter writes files, so nobody spends a turn asking who has access. A concession must quote a passage that really appears in the entry it cites; a quote that does not match stays visible as rejected and cannot justify a change of stance. A meeting where every member agreed from the first turn with no cited concession is labelled **no deliberation occurred**. Agreement does not establish correctness; validate important outputs yourself.

Members are stateless between calls and each turn reads the whole thread, so meetings are slow and cost tokens: a three-member, three-cycle meeting at CLI speeds takes ten to twenty minutes. Every session has a call limit and a time limit, shown with the usage as it runs; hitting one stops the meeting with its progress kept, and you can raise the limits and resume. The session limit must cover the implementer's time limit, or the meeting is refused. Failed members are skipped and dropped after two consecutive failures; an interrupted meeting can be resumed from the last committed entry.

## Research

Two separate settings, before the meeting or on a stopped one:

- **Internet research** lets members who can reach the web search it where it bears on the question. Every external fact must be cited with its source and date.
- **Deep research** adds the habit: research before taking a position rather than after, several independent sources, primary ones preferred, sources that disagree reconciled instead of one being picked, and a list of what could not be verified. It needs internet research, and ticking it turns that on.

A page a member reads is evidence to weigh, never an instruction. Searching takes minutes, so ticking deep research raises the per-turn time limit to 15 minutes; a member cut off mid-search loses its turn.

Who can actually browse is stated in every prompt, member by member, because it differs: Codex and Claude Code search through their own tools, OpenAI and Anthropic members search through their provider's search tool, and Gemini, Grok, Hugging Face, and other compatible endpoints cannot browse at all and are told to rely on what others quote. A Claude Code member reading a workspace at read-only can search but cannot fetch a page directly, because its restricted mode removes that tool. You can switch either setting on or off from **Adjust and resume** on a stopped meeting.

Research sends your brief's subject matter to each provider's search service. Deep research makes meetings slower and more expensive, since members search before they speak.

## Documents

Drop files on the brief or press **Attach files**, from any paired device. The host reads each file's text once and shows how many characters it found. Members get that text in every prompt, labelled as material to evaluate and never as instructions. PDF, Word, Excel, PowerPoint, OpenDocument, old Office formats, plain text, code, and zip archives are read; images are not. Archives are read in memory with path, size, and nesting guards, and nothing inside them is executed or written under a name the archive chose. Uploaded files are deleted when the meeting closes; the extracted text stays until you remove it or the meeting ages out of the history, so the meeting can be reconvened.

## From the command line

Another agent can convene the council while the server runs. `bin/overrule.mjs` drives the same server, so the meeting appears in the browser, uses the same members and limits, and lands in the same history.

```sh
node bin/overrule.mjs review . --playbook changes --cycles 1
node bin/overrule.mjs ask "Is this migration plan sound?" --deep-research --json
node bin/overrule.mjs list
```

`review` attaches a folder read-only and takes a report template; `ask` holds a plain meeting. Both wait for the verdict, print the report on standard output, and set the exit status: **0** approved, **2** objections remain, **3** checks failed, **4** verification incomplete, **1** error. With `--json` the output is one object with the verdict, the final text, and the meeting id, which is what an agent should read. `--no-wait` prints the id instead of waiting, and `watch` or `show` picks it up later. `--attach` sends a file, `--members` and `--drafter` pick the council, and `--level workspace-write` lets the drafter implement rather than only report.

A coding agent can therefore finish a change and hand it straight to the council:

```sh
node bin/overrule.mjs review . --playbook changes --json || echo "the council objected"
```

`npm link` puts it on the path as `overrule`. `OVERRULE_URL` points it at another machine, and `--code` pairs with that machine's pairing code.

## Reviewing a repository

Paste a repository address in the Workspace section and press **Clone and attach**. The clone is shallow, lands in `~/overrule-repos` (set `OVERRULE_REPO_DIR` to move it), and is attached read-only. Cloning the same repository again refreshes that checkout in place. Only `https` addresses are accepted, so nothing reaches for this machine's ssh keys or a local path, and git is never allowed to ask for a password: a private repository fails quickly unless git is already signed in on the host.

**Private repositories** work when the host's git can already read them, because the clone runs as the account that runs the app and uses that account's git credentials. On a machine with the GitHub CLI, `gh auth login` followed by `gh auth setup-git` is enough; any credential helper does. The app stores no token of its own, and whatever that account can read, the council can read. If git cannot read the repository, the clone stops with git's own reason and a pointer to signing in.

Once a workspace is attached, **Start from a report template** fills the brief with one of seven reviews: security, correctness bugs, dependencies and supply chain, architecture, test coverage, performance, and release readiness. Each asks for a report the owner can act on, with findings tied to a file and a line, quoted evidence, an agreed severity, and an explicit list of what nobody looked at. Edit the text before you start; it is your brief.

The commit under review is named in every prompt, in the meeting header, and in the Markdown export, so a report always says what it was about. A candidate applied to a clone changes that local clone only; nothing is pushed back.

## Workspaces

By default no member touches your machine: CLI members run in an empty temporary directory with tools off, and API members have no tools. To let the council work on code, browse to a project folder in the **Workspace** section, press **Inspect**, and choose a level:

- **Talk only.** Nothing runs.
- **Read-only tools.** Codex members read and run commands inside Codex's operating-system sandbox with writes and network blocked. Claude Code members read and search files with no shell.
- **Workspace-write.** Needs a git repository with a clean tree. The floor stays read-only. After it closes, the drafter implements in an isolated `git worktree` on a `mesh/<id>` branch inside its sandbox, with network off unless you allow it. The app commits what it left behind as the candidate, runs your check commands on that commit in a disposable checkout, and gives voters the diff, the check output, and a clean checkout to inspect. **Apply** merges the exact recorded commit into your branch; **Discard** deletes it.
- **Full access.** No boundary. Every member with tools can do anything your account can do, every turn, including reading this app's saved keys and your credential files. Offered because it is your machine, behind an acknowledgement for every meeting, shown in red.

Before offering a level the app runs a canary under that sandbox on your host: a write inside must succeed only at write level, a write outside and a network connection must fail. A level whose canary fails is refused. If agentsec-pack is installed, Inspect also measures the blast radius of each level and lists which of your credential files a member could read from inside. Repository text is treated as untrusted: Codex does not load `AGENTS.md`, Claude Code runs in safe mode without `CLAUDE.md`, and the controller commits with hooks disabled. Read the [security policy](SECURITY.md) before granting write access: this runs code chosen by models, and text in the repository can steer them.

The **Security** page lists every member at every level with its boundary stated in words, measures each through the exact launcher a meeting would use, and includes a sandbox lab for measuring any named agentsec configuration or container image, applying its recommendations, and measuring again.

## Access from other devices

Open **LAN access** on the host to see its addresses and a pairing code, then enter the code on another device on the same network. The code changes on every start and can be rotated, which signs everyone out. Paired devices can do everything the owner can, including attaching workspaces and uploading documents, so the code is the key to code execution on the host. Traffic is plain HTTP: use it on a network you trust, and never expose the app to the public Internet without HTTPS and a different trust model.

## Limits and privacy

- Everything is stored under `data/`: meetings, encrypted keys and their key file, attachments, measurements. Keep that directory private and back it up as a whole.
- Prompts, contributions, and anything members read from a workspace or document go to the providers of the members you selected.
- Child processes get a minimal environment; provider keys from the server's environment never reach a member unless you list them in `OVERRULE_CLI_ENV_PASSTHROUGH`.
- The thread each turn reads keeps the brief and the openings in full, the last six floor turns in full, and reduces older turns to their structured fields. Long meetings with many members can exceed a model's context window.

## Documentation

[docs/REFERENCE.md](docs/REFERENCE.md) describes every feature and limit in full. [SECURITY.md](SECURITY.md) states the trust model and how to report a problem.

## Development

```sh
npm test
npm run check
```

Tests use mocked inference and spend no credits. `scripts/browser-check.mjs` is a headless smoke test that needs Playwright (`PLAYWRIGHT_MODULE` set to an installed module). `scripts/live-check.mjs` runs one real two-member meeting against a running app and spends CLI allowance.

The code is small on purpose: `server.mjs` is the HTTP API, `lib/meeting.mjs` the pure meeting logic (rules, prompts, speaker order, planning), `lib/mesh.mjs` runs and persists meetings, `lib/workspace.mjs` handles paths, git isolation, canaries and measurement, `lib/attachments.mjs` handles documents, `lib/security.mjs` the Security page, `lib/providers.mjs` the model adapters, and `public/` the interface. The **Package agentsec-pack** workflow keeps the vendored agentsec-pack bundle current.

## License

Apache 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
