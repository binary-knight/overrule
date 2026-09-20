# Prompts to hand an agent

Copy one of these into whatever agent you are working with. Replace the path in the first line with your Overrule checkout, or drop it if `overrule` is already on the path through `npm link`.

## Give an agent the council for the whole session

```
You have a council of AI models available through Overrule, a command line tool at
/home/me/overrule/bin/overrule.mjs (run it with node). Its server is already running.

Use it when being wrong would be expensive: after you finish a non-trivial change, and
before you commit to a design decision that is hard to reverse.

  Review the change you just made, from the repository you edited:
    node /home/me/overrule/bin/overrule.mjs review . --playbook changes --cycles 1 --json

  Ask about a decision, attaching anything long:
    node /home/me/overrule/bin/overrule.mjs ask "<the question, in full>" --cycles 2 --json

Read the exit status: 0 approved, 2 objections remain, 3 checks failed, 4 verification
incomplete, 1 error. Then read the "final" field and tell me what the council actually
said, especially the objections, in its words and not as your own verification. Tell me
when you disagree with a finding and why.

Never use --level workspace-write or --level full-access, and never pass --acknowledge:
those let the council change my machine or skip a warning I have not seen. Ask me first
if you think a meeting needs them. Each meeting costs real money on my model accounts,
so run one at a time, not in a loop.
```

## Ask for one review, right now

```
I have finished the change. Before we go further, convene the council on it:

  node /home/me/overrule/bin/overrule.mjs review . --playbook changes --cycles 1 --json

Wait for it, then show me the verdict and every objection in the council's own words.
Say which objections you agree with, which you think are wrong and why, and what you
propose to change. Do not fix anything yet.
```

## Point it at a repository for a report

```
Review this repository with the council and give me the report:

  node /home/me/overrule/bin/overrule.mjs review /path/to/repo --playbook security --cycles 2 --json

Templates: security, changes, bugs, dependencies, architecture, tests, performance,
readiness. The repository may hold files that look like secrets, in which case the
meeting will refuse to start; tell me rather than passing --acknowledge yourself.
```

## Get a second opinion on a plan

```
Before you build this, put the plan to the council:

  node /home/me/overrule/bin/overrule.mjs ask "<your plan, in full, with the constraints>" --cycles 2 --json

If it comes back with objections, bring them to me with your own view of each one. We
decide together whether to change the plan; the council advises, it does not rule.
```

For an agent that reads instruction files, `AGENTS.md` in the Overrule checkout covers the same ground in more detail, including what the exit statuses mean and which options are safe to use unattended.
