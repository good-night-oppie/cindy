# Antigravity native ACP adapter: draft capability contract

Status: unmerged maker-core prototype. Not an installed Desktop integration or a
claim that every advertised model is supported for Cindy. This record describes
the implementation and outstanding acceptance work, not a release announcement.

## Official sources and model boundary

Reviewed 2026-11-14:
- https://antigravity.google/docs/ide/extensions/acp/
- https://antigravity.google/docs/cli/acp/
- https://agentclientprotocol.com/protocol/v1/error

The official CLI exposes ACP v1 over stdio and supports editor-managed execution
with cached CLI authentication. The guide distinguishes general Gemini access
from third-party models offered only to named editors. Cindy is not among those
named editors. A successful individual request is not evidence of official model
eligibility. Keep clientInfo.name as cindy; do not impersonate another editor,
extract tokens, or route a subscription through another agent.

The current live test restriction permits only an explicitly approved model and
one separately approved attempt at a time. That is an operator test constraint,
not a public catalog default. A change to supported models needs a separate
product decision; do not silently substitute Gemini or another paid provider.

## Version evidence

Existing captured initialize responses identify Antigravity ACP Server 1.5.9,
protocolVersion 1. The adapter preflight currently admits CLI versions at least
1.5; this is a minimum check, not a tested compatibility matrix. Documentation is
unversioned and may describe newer behavior. Reconcile reported capabilities with
the exact installed version before enabling features; do not run an account just
to infer capabilities while real calls are paused.

## Current implementation

- Each native session owns an ACP stdio process. New sessions use initialize then
  session/new. Resume uses advertised session/resume or session/load. Never fake
  recovery with a new native session.
- Start and model changes require an explicit model ID. A trusted host can narrow
  models through agyAllowedModels; session input cannot broaden that snapshot.
  This optional restriction must be wired by every constrained production host.
- Configuration receipts must match the requested model, effort and mode.
  Recheck immediately before session/prompt, after asynchronous input preparation.
- Permission requests use Cindy's resolver; the CLI may have native rules that do
  not request approval. This adapter cannot promise a read-only tool policy.
- Cancel requests retain ownership until completion or confirmed process exit.
  A transport error is not proof that native work stopped. Do not replay messages
  automatically after uncertain failure.
- Startup diagnostics preserve method/code and a bounded safe projection of error
  message/data. Unknown free text is omitted explicitly because it can contain
  unlabelled identities. Raw errors are not diagnostic artifacts.

## Authentication and execution environment

ACP -32000 means Authentication required. It does not prove the account was
logged out, suspended, or revoked. Do not automatically start browser login or
change credentials in response.

Captured native logs demonstrate different credential backends: an SSH-launched
process selected file storage, while the desktop-launched process used keyring.
A reachable D-Bus service alone does not establish which backend the CLI selected.
Preserve the intended execution environment; do not copy credentials or remove SSH
markers to disguise the launch context. Login and unlock remain explicit owner
operations. Record only environment-variable presence and process identities for
diagnostics, never arbitrary environment values or command lines.

## Switching an existing task into Antigravity

How this differs from switching a task to Codex, and what the user is told (cindy#19).

- Only a task that runs on this computer can be switched: Antigravity runs where the
  task is hosted. A window that controls the task on another computer, and the phone,
  do not offer it and cannot agree to it.
- The switch is registered and applied when the next message is sent, as for other
  engines. Unlike them it can rewrite the task's permission mode, because Antigravity
  has no "accept edits" or "plan" mode and its Full access removes file and network
  isolation:

  | Mode before the switch | Mode after | Asked first |
  | --- | --- | --- |
  | Ask, Default, Auto | unchanged | no |
  | Full access | Auto (Cindy reviews the approval requests) | yes |
  | any other (accept edits, plan, ...) | Ask | yes |

  Full access is never a starting value; the user can choose it in the task afterwards.
- The host checks the user's agreement to that change where the switch is applied, not
  where it was asked. A message that would apply the switch without it is not sent on
  either engine: it stays first in the queue, marked as held, with a banner.
- A held message is sent by one of two actions of the user's on it and by nothing else:
  confirming on its own banner, or "Continue sending". Picking the engine or a model
  again, changing effort, Fast, thinking or the permission mode, confirming from the
  task's entry, sending or interjecting another message, and a restart all record or
  change settings and send nothing held. When any of them sets the queue moving, the
  queue is paused again in front of the held message.
- A confirmation is about one message in one hold. The host names each hold; the window
  reads the name when its question opens and sends it back with the answer and the
  retry. If the message was removed, edited, merged, moved back or held anew, the
  answer is recorded as an agreement about the permissions and sends nothing. The same
  once the user has closed its banner, stopped the queue or gone back in the task's
  history, in this window or another: every question opened before that is over, and
  "Continue sending" is the only way on.
- A new registration (another model, effort, Fast, thinking) starts with no agreement;
  the next message that needs one asks. An agreement belongs to one registration and
  one permission change.
- A held message cannot be interjected into the running turn: that would deliver it to
  the engine it was not written for, without the send step that applies the switch.
- The mark on a held message is stored with the queue, the pending switch is not. After
  a restart the queue is paused with the message in it. "Continue sending" tries it;
  with no switch pending it is held again and its banner says that the switch is no
  longer pending. The user picks the engine again, or removes the message.

Not verified on a running app, on a phone, or with two windows as of this writing; the
rules above are covered by tests of the host's switch handler joined to the real queue
with a stand-in engine.

## MCP and other capability gaps

The official guide documents HTTP MCP with --process-per-session. The current
adapter launches acp --disable-telemetry and passes an empty mcpServers array.
Therefore HTTP MCP is not integrated in this startup mode; do not describe it as
unsupported by Antigravity generally. Enabling isolated workers requires explicit
process ownership, cancellation, cleanup and permission tests first.

The guide also describes steering, session listing/closing, additional folders,
elicitation and thinking choices. The prototype does not yet integrate all of
these. In particular same-turn steering is disabled, extra directory grants are
rejected, and unknown thinking values must not be silently relabelled. Desktop,
Mobile and device-link registration remain pending; maker-core success does not
establish end-to-end availability.

## Long silence: observed behavior and acceptance gap

The watchdog defaults to status-only silence handling: after one minute without
a session update it reports waiting once per quiet interval, without cancelling.
An explicitly configured positive silence budget reports halfway through and
requests cancellation at the limit. Any session update resets silence. Pending user permission replies pause the timer. Hosts or
sessions may explicitly configure a limit; zero disables automatic silence
cancellation while preserving waiting status. There is
also a separate 24-hour ACP prompt request limit. Disabling silence detection does
not disable process-exit, protocol-error, user cancellation or cleanup handling.

Silence alone cannot distinguish productive native computation from a stall.
The current timeout tests prove timer/cancellation behavior, not that a legitimate
silent task finishes. An 88-second historical task cannot validate the 15-minute
boundary. Do not increase an arbitrary limit and claim this issue solved.

The default is status-only silence, with cancellation only for an explicit
inactivity budget. Validate the behavior and its presentation through the
production send/cancel entry points using virtual time:
- A quiet turn can finish after the configured expected duration without replay.
- Explicit cancellation still works during silence.
- An expired opted-in limit cancels once; missing cancellation acknowledgement
  requires confirmed process exit before any subsequent turn.
- Permission waits and resumed activity do not consume the silence budget.
- Late events from a cancelled/closed turn do not become a new turn's result.

Virtual-time regression covers default completion after twenty quiet minutes and
manual stop during that silence, alongside explicit-budget and permission-wait
cases. Real quiet-task acceptance and desktop status presentation remain pending.
No further real-account tests are implied by this document.

## Source attribution and delivery

ACP transport/client and lifecycle patterns derive from makecindy/cindy PR #5611,
source ref 87cbe126f42dcc3dd436297f3abb5c55ddf36620, with transport ancestry in #2386.
Retain original attribution; do not sign DCO on behalf of another contributor.

Local synthetic tests and one basic READY result do not cover complete coding,
long silent execution, native UI, mobile control, or installed-package acceptance.
Validate each explicitly before a release or upstream completion claim.

## Staged native acceptance request

Each row requires its own confirmation; counts are user prompts, not underlying
model HTTP calls. All rows use the same explicitly approved model and desktop
launch environment. No retries, fallback, credential changes or client spoofing.

| Stage | User prompts | Evidence and stop condition |
| --- | ---: | --- |
| Synthetic coding and tests | 1 | Fix a seeded add/subtract bug without changing tests; record native unittest result and independently inspect files. Denial is reported, not bypassed. |
| Multi-turn and restart resume | 2 | Existing resume scenario; reopen the same native identity and recall the synthetic code word. |
| Permission denial | 1 | Deny a harmless shell permission request. If native rules omit the request, mark untested, not passed; no policy change or retry. |
| Cancellation and subsequent turn | 2 | Existing cancel scenario; prove cancellation and only then one subsequent turn. Unconfirmed exit stops the stage. |
| Longer coding task | 1 | Existing synthetic CSV scenario; inspect artifacts and calculations. It does not prove prolonged silence. |
| Deliberate prolonged silence | 1 proposed, not ready | Prepare and review a deterministic quiet native-tool fixture and its permission path before approval. Do not use natural-language timing as proof or count virtual-time tests as a real run. |

The proposed runtime matrix is eight user prompts in separately approved stages,
not blanket permission to run eight prompts. Native permissions remain unchanged;
no blanket --allow or permission-bypass flag is part of this request. Desktop UI,
mobile control and installed-package acceptance are separate work, not satisfied
by this maker-core smoke matrix.

## Synthetic coding resolver

The coding smoke uses a fixture-only per-request resolver, not blanket approval.
It classifies listing/reading/search/statistics commands and parses their option
values separately from path operands, writes only calculator.py, and runs unittest
module/discover/verbosity variants only while the original
test file and a minimal add/subtract implementation remain intact. Other tools,
commands, shell expansion/composition, redirections, execution predicates,
environment overrides, conflicting path aliases, parent traversal,
symlink escapes and hardlinked files are denied. Denials are logged by fixed
reason code and trigger cancellation; the CLI permission mode remains ask.

These checks govern requests the CLI actually presents. They are not an OS
sandbox or a guarantee about native auto-allowed operations or malicious
concurrent filesystem replacement. Use only the disposable synthetic fixture;
do not expose this policy as a general user-workspace permission mode. Original
test contents are immutable and must be independently checked after a run.

The parser accepts documented safe option classes, not every arbitrary flag:
options that execute a helper, accept an indirect external file list, or write an
output file are rejected. Quoted search/glob patterns are data; unquoted shell
expansion is rejected. Canonical path checks cover operands and file-valued
options; a bounded fixture-tree walk rejects symlinks and non-single-link files
before recursive reads. Optional-valued options such as GNU grep/ls --color must
not consume the next path operand. Unknown syntax fails closed and is reported as
an unverified fixture case, not expanded by an automatic retry.

New synthetic smoke child processes set PYTHONDONTWRITEBYTECODE=1 to avoid stale
same-size Python cache artifacts during baseline/edit/retest. This is scoped to
the test process, not a global setting or credential change. The resolver also
recognizes only ordinary cache names for the two known modules; all link and
immutable-test checks still apply. This does not authorize model-issued cleanup
commands or make a general code-execution sandbox.
