# Session PLAN-0: implementation plan for Flocked

You are the planning agent for **Flocked**, a daily minority game built on Cloudflare and Base. The repo currently contains only the specification. Your job in this session is to turn the spec into an end-to-end implementation plan, carried out later by many separate Claude Code sessions, and to write it to disk. Write no application code in this session.

## Read first

1. `Product_Spec.md` is the single source of truth (about 1,270 lines). Read all of it once; this is the only session that should. Pay particular attention to Revision notes, Smart contract, Settlement and payout math, Sealed picks, Architecture, Data model, Non-functional requirements, Testing and acceptance criteria, Launch gates and the Decision log.
2. `Design_Language.md` holds the visual rules for all UI and share cards.

## What the owner requires

These come from the owner and are not up for debate:

- **Whole implementation.** Convert the entire implementation into a plan divided into multiple sessions.
- **Small context per session.** Each session uses only as much context as it needs. The number of sessions doesn't matter; keeping each session's context small to avoid attention dilution does.
- **End to end.** When the last session finishes, the app is production-ready.
- **Rigorous testing** in every session.
- **Parallel waves.** Sessions run in parallel where possible, in waves.
- **Paste-ready handoffs.** Every session ends with prompts that can be pasted into the next session(s). The plan includes a prompt format that agents use to write those prompts.
- **Wave shape.** A wave has four sessions. Three start in parallel; when they finish, the fourth starts. The fourth emits the prompt for a consolidation session. The consolidation session consolidates the wave and ends by emitting every prompt for the next wave, redrafting any prompts drafted earlier, since consolidation can change them.
- **Design before UI code.** The UI is designed and finalized in Paper before any session implements it. See "UI design first (Paper)" below.
- **Clarify first.** If you have questions about the task, ask them before drafting the plan.

## Proposed protocol (confirm with the owner before drafting)

Everything in this section is the prompt author's proposal, not an owner decision. During clarification, show it to the owner as one batch to confirm or change. Then write the agreed version into the plan.

**Sessions and roles**

- `W{n}-A`, `W{n}-B` and `W{n}-C` are parallel build sessions. They must be independent: disjoint file ownership, and no dependency on each other's output.
- `W{n}-D` is a build session for work that depends on A, B and C. It starts by merging their branches and fixing any integration breaks, then builds what needed their output.
- `W{n}-Z` is the consolidation session. It reviews the wave, makes only the fixes needed to get to green, merges the wave into `main`, updates the plan, revises later waves if needed, and emits the next wave's prompts. Z adds no features.
- **Waves that don't fit.** A wave may run fewer than three parallel sessions when the dependencies don't allow three; never pad a wave with filler. If a wave has no D, its last session emits the Z prompt.
- **Hold points.** External waits (the contract audit, legal sign-off, Coinbase personhood confirmation) are hold points between waves, not sessions. Work that doesn't depend on a wait runs meanwhile. Plan the spec's path where Free launches without Stakes if gate 2 slips.

**Bootstrapping wave 1.** Wave 1 has no earlier Z, and its parallel sessions need a workspace root that only one session may own. The default design:

- W1-A owns the repo scaffold: root `package.json`, `pnpm-workspace.yaml`, base `tsconfig`, lint config, `.gitignore`, CI workflow, a `packages/shared` skeleton, the canonical commands and a spec-section extraction script.
- W1-B owns `contracts/` as a standalone Foundry project.
- W1-C owns `packages/settle` as a self-contained package that installs and tests on its own.
- W1-D wires B and C into A's workspace and CI.

If that doesn't work, add a single foundation session `W0` before wave 1. In that case this plan session emits only the W0 prompt, and W0 ends by emitting the wave-1 prompts.

**Prompt flow**

- This plan session emits the first wave's prompts (or W0's).
- A, B and C write handoff files. Each ends with a short message for the owner: its status, plus "When W{n}-A, B and C all report complete, start W{n}-D from `docs/prompts/W{n}-D.md`".
- D emits the Z prompt.
- Z emits every prompt for the next wave.
- **The final Z** confirms the production-readiness checklist is complete, with only owner actions and launch gates left open, each listed with what it unblocks. If any agent work remains, Z adds a wave instead of ending.
- **Prompt files.** Every emitted prompt is printed in its own fenced block and also saved to `docs/prompts/W{n}-{X}.md` and committed, so prompts survive across chats.

**State on disk**

- Prompts stay short and point at files and exact headings.
- **Handoff files.** Each session writes `docs/sessions/W{n}-{X}.md` from a template in `plan.md`, kept under about 120 lines. Sections:
  - Status: complete, partial or blocked;
  - Summary;
  - Branch and head commit;
  - Files touched;
  - Tests run, with commands and results;
  - Deviations;
  - Spec issues;
  - Open issues;
  - Notes for D and Z.
- **Wave summary.** Z writes `docs/sessions/W{n}-Z.md`: what's on `main` now, changed interfaces, decisions and carry-over issues. The next wave's prompts point at that file, not at the four session handoffs.
- **Plan files.** Only Z sessions edit the plan files after this session creates them. Build sessions record everything in their handoff.

**Git**

- **Own workspace.** Each session's first step is to create its own workspace from the base its prompt names, for example `git worktree add ../flocked-w{n}-{x} -b w{n}-{x}-{slug} <base>` and then `pnpm install`. Two sessions never share a working directory.
- **Branches.** D works on `w{n}-integration`, created from `main`. Z merges `w{n}-integration` into `main` only when the full suite, the e2e tests that exist so far, and CI are green, then tags `wave-{n}`. No branch shares a tag's name.
- **Staging.** Stage files by name, never with `git add -A`.

**File ownership and interfaces**

- Every parallel session lists the paths it may create or edit; parallel sessions never share paths. Shared files belong to exactly one session per wave.
- **Interfaces before parallelism.** When parallel sessions must agree on something, the plan pins it first: its path, owner and shape. Examples:
  - the settlement vector format shared by `packages/settle` and the Foundry tests;
  - zod schemas and enums in `packages/shared`;
  - contract ABIs and events;
  - D1 migrations;
  - queue message shapes;
  - Durable Object RPC signatures.

  If it can't be pinned in advance, that work goes to D.

**Failure handling**

- **Running out of context.** A session running low stops at a green commit, writes its handoff as `partial`, and emits a continuation prompt `W{n}-{X}.2` that resumes on the same branch.
- **Blocked.** A session blocked on an owner action or a spec question stops, writes `blocked`, and tells the owner exactly what it needs. It never fakes a credential or stubs around a launch gate.
- **D checks first.** D reads the three handoffs before merging. If any isn't `complete`, D stops and emits the continuation prompts to run first.
- **Z never merges a red wave.** Small fixes it makes itself. Anything larger becomes a fix session `W{n}-F{k}`, and Z emits that prompt plus a fresh Z prompt to run after it.

**Spec changes**

- Build sessions never edit `Product_Spec.md`; they record problems under "Spec issues" in their handoff.
- Z raises each one with the owner. Once the owner decides, Z edits the affected section, adds a Decision log row, and names the changed sections in the next wave's prompts.

**Context budgets**

- A session's size is the total context it uses by the end: S is at most 50k tokens, M at most 100k, L at most 150k. Confirm these against the owner's model and context window. Split anything that would be L.
- **No full-spec reads.** Build sessions never read the whole spec. Prompts name spec sections by their exact `## ` heading. Sessions load only those sections, with the extraction script W1-A creates, or until then with:

  ```
  awk '/^## <heading>$/{p=1;print;next} /^## /{p=0} p' Product_Spec.md
  ```

- **Z works light.** Z works from handoff files, `git diff --stat` and test results. It reads full diffs only where a handoff flags a risk.

## UI design first (Paper)

The owner has the Paper desktop app installed, with its MCP server connected to Claude Code. This is an owner requirement: the UI design is finalized in Paper before any session writes UI code.

- **Design sessions.** Plan design sessions that work only in Paper and in `docs/design/`, never in application code. Each works from `Design_Language.md` and only the spec sections its surface needs, for example Client app, Real-time and the reveal, Share cards and distribution, Profiles, leaderboards and rooms, Notifications, Admin console, Compliance and responsible play, and the user-facing parts of Modes: Free and Stakes and Identity and personhood. Split the design work by surface so each session stays within budget. One way to split: core round flow (onboarding, sign-in, picking, sealed state, reveal, settlement, claims); profiles, leaderboards and rooms; share cards and notifications; the admin console.
- **What gets designed.** First the foundations in Paper: color tokens, typography, spacing and shape, the mascot and motion notes, all matching `Design_Language.md`. Then a component set. Then every screen in every state the spec implies: empty, loading, error, offline, sealed, revealed and settled; Free and Stakes; signed out and signed in; responsible-play limits and blocked regions. Cover the breakpoints the Client app section needs, mobile first.
- **What gets written to the repo.** Paper is the design record, but build sessions shouldn't have to open it to know what exists. Design sessions write:
  - `docs/design/screens.md`: a screen and state inventory mapping each item to its Paper artboard name and spec heading;
  - exported tokens at a path the plan pins (for example `packages/shared/design-tokens.json`), which the UI build imports instead of retyping;
  - PNG exports of each final artboard under `docs/design/exports/`, used as visual references and as baselines for screenshot tests.
- **Design freeze.** Owner sign-off on the design is an owner action and a hold point before the first UI build session. The owner reviews in Paper. Once frozen, design changes go through Z the same way spec changes do. If designing exposes a spec gap, or the design needs to break `Design_Language.md`, record it under Spec issues for Z to raise with the owner.
- **Scheduling.** Design doesn't depend on the backend or contracts, so run it in parallel slots in the earliest waves. That way the freeze lands before UI build waves and stays off the critical path. Pin the API and real-time shapes the screens show early enough that design and backend agree.
- **UI build sessions.** Each reads `docs/design/screens.md`, the exports for its screens, and, through the Paper MCP, only the artboards it implements. It builds to match them. Its tests include Playwright screenshot comparisons against the exports for its screens, alongside the usual checks.
- **Tool check.** A design session's first step is to confirm the Paper MCP tools are available. If they aren't, it stops as `blocked` and tells the owner. It never substitutes a design invented in code.

## Testing (required in every session)

Each session's definition of done includes, wherever it applies:

- unit and integration tests;
- typecheck and lint with no errors;
- the full existing suite green;
- for `packages/settle`: property tests (fast-check) and recorded vectors that the contract tests also use;
- for the contracts: Foundry unit, fuzz and invariant tests;
- for Workers and Durable Objects: tests in the Workers test runtime;
- once enough of the app exists: Playwright end-to-end tests on the local stack (wrangler dev, an anvil fork of Base and a local drand network).

CI (GitHub Actions) exists from the first wave with code and stays green. W1-A defines canonical commands that every prompt cites, for example `pnpm check` (which runs everything), `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`, `forge test` and `pnpm e2e`.

No session skips, deletes or weakens a test to get green without recording it in its handoff with a reason. Z confirms that every traceability row assigned to its wave has a passing test.

Traceability covers every item in the spec's Required tests and Acceptance criteria, every row of the Non-functional requirements table, and every Alert. Each maps to the session that implements it and the test or check that proves it.

## Owner actions and launch gates

Some work can't be done by an agent:

- **Accounts and keys:**
  - Cloudflare, including the plan tier the Architecture needs, a second account for the watcher, and Cloudflare Access for `/admin`;
  - Base RPC, bundler and paymaster;
  - a Coinbase Developer Platform OAuth app;
  - an Anthropic API key;
  - a Farcaster app and signer;
  - a domain, email and web push;
  - GitHub settings: Actions secrets, branch protection, and deploy environments with required reviewers.
- **Keys and wallets:**
  - generating and holding the operator, ticket-signer, receipt-signer and anchor keys;
  - funding the operator and anchor keys with ETH;
  - setting up the multisig and the guardian multisig;
  - a guardian paging channel and an independently hosted dead-man's switch.
- **The four launch gates:** legal sign-off, Coinbase personhood confirmation, the contract audit, and load-test sign-off.
- **Design freeze:** reviewing and signing off the Paper design before UI build starts.
- **Production deploy approvals.**

Treat this list as a starting point and add any other owner-only step the spec implies. List each as an **Owner action**, with:

- what it unblocks;
- the latest wave that needs it;
- the wave by which the owner should start it, given its lead time (the audit and legal review take weeks).

Sessions never fake these. They build against testnets, local stacks and mocks until the real thing exists, and stop and ask when they are blocked.

## Prompt format

Define a reusable prompt template in `plan.md` that every session prompt follows. At minimum it has these sections:

- **Session ID and role:** build, integrate or consolidate.
- **Read first:** exact files, spec sections by heading, handoff or wave-summary files.
- **Objective:** one paragraph.
- **Starting point:** base branch and branches to merge.
- **Scope and file ownership:** what it may edit and what it must not touch.
- **Pinned interfaces:** what it must conform to.
- **Tasks:** in order.
- **Tests and checks:** the exact commands that must pass.
- **Definition of done.**
- **Constraints:** secrets, spec edits, owner actions, and when to stop and ask.
- **End of session:** commit and push, the handoff path, and which prompts to emit and save.

Keep prompts self-contained but lean: point at files and headings instead of pasting their contents.

## What to write

Keep the plan loadable in pieces, and write it file by file and section by section rather than in one call:

- `plan.md` is the entry point. It contains:
  1. how to use this plan (for the owner);
  2. the agreed protocol;
  3. the prompt and handoff templates;
  4. global conventions: the repo layout from the spec's Architecture section, the toolchain, environments (local, staging, production), secrets handling, CI and canonical commands;
  5. the dependency graph and critical path, including the design track and where the design freeze sits;
  6. owner actions and launch gates mapped to waves;
  7. production readiness;
  8. a Status table, with one row per session and one per owner action;
  9. an Assumptions list of every default you chose.
- `docs/plan/wave-{n}.md`, one file per wave. It gives the wave's goal and, for each session: objective, read-first list, file ownership, pinned interfaces, deliverables, required tests, acceptance checks, size and risks. It also includes the Z checklist and any open questions that session will hit. A session's entry is its outline prompt; Z fills in the template from it.
- `docs/plan/traceability.md`, the traceability table.
- `docs/prompts/` holds the first wave's prompts (or W0's) in full.
- `docs/design/` paths are created by the design sessions, not by this session; the plan only pins them.

Production readiness covers the security review, the audit handoff and fixes, the load test (gate 4), a staging soak, the production deploy, monitoring and alerts, runbooks and rollback.

**Staging chain ID.** Staging on Base Sepolia needs a configurable chain ID: the spec's EIP-712 ticket and receipt domains currently fix chainId 8453. Plan the change, and raise it with the owner during clarification.

## Before you draft: clarify

- **How to ask.** Ask at most two rounds of up to four questions each, using AskUserQuestion (or a numbered list in chat if the tool isn't available, then stop until the owner answers). Put your recommendation first in each. Round one includes confirming the proposed protocol above.
- **What's settled.** Don't re-ask what the owner has settled: their requirements above, and every Decision log row in the spec.
- **Spec ambiguities.** If one doesn't change the plan's structure, sequencing or scope, don't ask about it now. Record it as an open question in the wave file of the session that will meet it.
- **Likely topics:**
  - wave-1 bootstrap (W0 or not);
  - how parallel sessions run (worktrees, separate clones, or cloud sessions) and whether they may push branches and run CI;
  - who merges into `main`;
  - the model and context window behind the size limits;
  - locally installed tooling (Node, pnpm, Foundry, and Docker for local drand);
  - which accounts and keys exist;
  - whether staging on Base Sepolia is in scope;
  - what "production-ready" means at the end: real users with Stakes live, or deployed with Stakes held behind its gates;
  - whether sessions may use subagents or multi-agent workflows within their budget;
  - the design track: whether the whole UI must be frozen before any UI code, or the freeze may go surface by surface (for example core round flow first, admin console later), and whether the Paper MCP is available to parallel and cloud sessions or only to local ones on the owner's machine.

## End of this session

1. Write the plan files above, plus a `.gitignore` that excludes `.DS_Store`.
2. Commit them, along with this prompt file, staging files by name. Commit to `main` unless the owner chose otherwise. Wave-1 branches are cut from this commit, so it must land before any wave-1 session starts. Push if the owner allowed it.
3. Print the first prompts to run (W1-A, W1-B, W1-C and W1-D, or only W0), each in its own fenced code block and also saved under `docs/prompts/`. Say which sessions to start in parallel and when to start the next one.
