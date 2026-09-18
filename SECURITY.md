# Security policy

Overrule runs code chosen by language models on the machine that hosts it, with whatever access its owner grants. Please read the trust model before reporting, because several things that look like vulnerabilities are deliberate and documented.

## Trust model

- **One owner, one machine.** The app is a single-owner tool. Everyone who holds the pairing code is the owner. There are no user accounts, no roles, and no separation between paired devices. Do not expose it to the public Internet.
- **The pairing code is the key to code execution.** A paired device can attach any host directory that passes the path rules and run members against it at the access level it chooses, upload documents into the app's data directory, and change connections. This is by design: the owner runs the server headless and works from other machines. LAN traffic is plain HTTP.
- **Access levels are a boundary only where the canary proves one.** Read-only and workspace-write rely on the Codex sandbox and on Claude Code's own sandbox and permission layer. The app measures those boundaries on the host before offering a level, records the result with every meeting, and refuses a level whose canary fails. Full access is offered on purpose, behind a per-meeting acknowledgement, and provides no containment at all.
- **Repository text and attached documents are untrusted input to members.** Members are told so, project instruction files are not loaded, and the controller commits with hooks disabled. None of that stops a model from being steered by what it reads; the sandbox levels and the apply step are what limit the damage.
- **The account that runs the app is the exposure.** From the read-only level a Codex member can read anything that account can read, including the app's own vault key and the account's credential files. Run the app under an account that holds nothing you would mind a model reading.

## What is in scope

Reports are welcome for anything that lets someone do more than the trust model above allows:

- Reaching the API or running members without the pairing code, or from a host header, origin, or cookie the server should reject.
- Reading a saved provider key back out through the browser, the API, or a log.
- A workspace path rule that can be bypassed: system directories, the home directory itself, the app's own directory and data, hidden or symlinked paths.
- A canary that reports a boundary the sandbox does not actually hold, or a launcher argument that weakens a level below what its label says.
- Archive or document handling that writes outside the attachments directory, executes anything, or bypasses the size caps.
- Anything a child process receives from the server's environment that it should not.

Out of scope: the full-access level doing what it says, the pairing code granting execution to whoever holds it, plain HTTP on the LAN, denial of service by the owner's own devices, and prompt injection that stays inside the granted access level.

## Reporting

Use GitHub's private vulnerability reporting on this repository. If that is unavailable, open an issue that says only that you have a security report and how to reach you; do not put details in a public issue. Expect an acknowledgement within a week. There is no bounty.

## Supported versions

Only the current `main` branch is supported. The CLIs the app launches (Codex, Claude Code) must be current versions for the isolation flags to exist; an older CLI is refused or reported, not silently run without them.
