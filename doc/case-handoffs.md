# Persistent case handoffs

Developer notes for the Cases experiment: handoff delivery, native case tools, and where the tests live.

The Cases experiment supports prompt-driven agent workflows on one ordinary task.
The application service owns transaction/idempotency and assignment policy;
`case-handoff-delivery.ts` owns durable retry/lease and wake admission;
`heartbeat/case-handoff-lifecycle.ts` owns execution release proof and stale-run
mutation fencing. Keep network/process work outside the acceptance transaction.
`heartbeat/process-settlement.ts` checks local process-tree absence independently
of scratch-directory preparation. A local process handoff stays pending while
the owned PID or process group is alive, or termination evidence is missing.
HTTP adapters use their awaited nonprocess invocation contract instead of host
PID probes. Stopping a run cancels its own intents; cancelling an unbound
terminal intent additionally requires fenced, current task ownership.
`case-context.ts` builds the bounded authorized case snapshot shared by native
and legacy task preparation, including resumed sessions.

Native case tools are `create_case`, `read_case`, `update_case`, and
`handoff_case`. Native creation requires `kickoff` and delegates to the same
principal-idempotent handoff service. Both `kickoff` and nonblank
`workflow_document_text` are mandatory; missing either fails before any writes.
The text is preserved in ordinary Markdown task document `workflow`, title
`Workflow`, in the acceptance transaction. New-case handoff API requests require
the same field. The workflow plus optional document seeds share a 200,000-character
budget; `workflow` cannot appear in `initialDocuments`. Later phase handoffs omit
the text; normal revision tools manage changes. Read `workflow` before routing:
its reference is prioritized in case context, without injecting its full body.
Recommend both a Mermaid `stateDiagram-v2` map and prose defining each transition's
trigger, evidence, next agent, human wait/resume behavior and correction/escalation
limits. State IDs match phase names and prose defines named edge outcomes.
This guidance adds no server-enforced transition semantics. There is
no passive creation branch or `createOnly` REST extension. Historical
generic REST upsert semantics remain compatible. `initialDocuments` is valid only for
new first-task kickoff; ordinary task documents and audit are committed before
delivery. Case detail/context roll up authorized task document metadata through
`case-task-documents.ts`; system keys and inaccessible task documents are
excluded before the document limit. Standard task document tools handle new
documents; historical case document REST/storage remains intact.
`read_case` keeps small responses structured. Large responses return bounded
`readPage.text` JSON chunks with case/task routing versions on every page. Use
`section: "fields"` to retrieve the entire fields object, including large keys,
strings, and arrays. Continue with the same `section` and `snapshot`, passing
`offsetBytes: readPage.nextOffsetBytes` until it is null; concatenate the text
before parsing JSON. A 409 means facts, accessible references, or routing changed:
restart at offset zero without the old snapshot. Each page reauthorizes current case access through
`GET /api/cases/:id?agentRead=true`; no generic API tool or asset grant is needed.
`limitBytes` is 4–8192 UTF-8 bytes. Ordinary REST reads retain their existing full
response, and ordinary `update_case` mutation receipts remain unchanged.
Use `section: "document"` and `documentKey` for a historical case-owned body;
add `documentIssueId` for a primary or currently linked task document. This
selection retains the same bounded JSON paging and does not enable generic API
tools. Each page checks current case access, task access, linkage, and document
trust. System and quarantined documents are excluded. Document edits and routing
changes invalidate the snapshot; restart from zero after a 409.
Each page reloads case metadata and the complete selected body to check access
and compute its snapshot. These limits bound the response, not total database
work; the read cost grows with source size and the number of pages.

Keep native schemas aligned with their services/routes. Transactional source
run checks must precede case writes, so Stop or an accepted handoff cannot race
an HTTP request into a late mutation. Generic API rollout settings do not remove
these dedicated tools; case, mode and resource authorization still apply.
Company deletion removes cases before task/agent dependencies. Individual agent
purge preserves handoff attribution and returns `agent_case_history_retained`
before destructive cleanup when history references that agent. Termination stays available.

The native constructor preserves full case context for bootstrap and resume
failure. Compatible continuations carry a versioned case projection tied to the
actual prior native input and exact agent/task/session. Stable facts fingerprints
include document revisions and accessible references, while phase/version and
incoming instructions are refreshed separately. Do not use a prepared
`contextSnapshot.proprioCase` as proof that a compact provider turn received
those facts. Legacy adapters continue to receive their bounded case snapshot.

Start work through `handoff_case` or
`POST /api/companies/:companyId/case-handoffs`. Subsequent calls use the same
primary task and observed case/task revisions. GET the case's `/handoffs` for
history; `/handoffs/:handoffId/retry` retries delivery without creating new work,
and `/cancel` cancels pending delivery without reversing an applied assignment.
Ordinary task completion leaves the case unchanged. For an existing primary
task, `to: "done"` records a non-yielding terminal handoff; its `awaiting_completion`
intent is settled atomically by the normal issue-service completion transaction.
The case remains open during review or user waits. Stop/cancel/reassignment
invalidate the intent. Keep terminal intents outside agent-transfer mutation
fencing, outgoing yield detection and recipient dispatch.

## Versioned handoff offers

Native `handoff_case` supports an opt-in `offer` for standard-mode native runs
with generic API tools and agent JWT signing available. The offer requires an
authenticated source run on the same task, a completion contract, and a different
native recipient who can read the Case and use the decision API. The recipient
can use `search_api` and `call_api` to call
`GET /api/companies/:companyId/case-handoff-offers`. The list contains routing
metadata for the agent's own readable pending offers. Use the returned Case ID
to read the requirements in Case handoff history. Follow the cursor until it is
null, even when a page contains no readable items.

The offer preserves the source assignment and records the task brief and the
completion-contract and workflow revisions. A task brief change, Stop, or Case
cancellation closes an unanswered offer.
The named recipient can post a decision to `/api/cases/:caseId/handoffs/:handoffId/decision`
using the observed handoff and completion-contract revisions. An identical reply
returns the saved decision metadata. The Case-scoped history retains any message
sent with a clarification or decline. Acceptance waits for the normal source
release and recipient admission checks. The outcomes are `accepted`,
`clarification`, and `declined`. Clarification and decline require a categorized
`reasonCode` and a message. A reply with a mismatched handoff or requirement
revision returns `409` and leaves a current offer open. An attempt to decide on
an offer whose stored requirements have since been superseded returns `409`
and closes the offer. Reread the task and handoff after either response. If
requirements change after assignment but before admission, the handoff remains
held for the operator. Clarification or decline closes the offer and keeps the
source assigned. The audit event records the category and elapsed time.

Stage the versioned-offer schema before admitting pilot work. If ownership
diverges or an effect is uncertain, pause new offers, retain the handoff and
run receipts, and reconcile active work before retrying. Verify any rollback
or roll-forward against the retained offer states and the intended runner
profiles before resuming. See the
[release plan](https://github.com/groktopus/proprio/issues/222) for the candidate
and evidence requirements.

If a recipient's native completion still lacks evidence after the automatic
continuation, or no continuation is available, the recovery action records the accepted requirement revision, the assessed
contract revision, and the status decision. The receipt belongs to the current
delivered handoff and its recipient. Task recovery shows counts of unmet
criteria and evidence gaps. It directs readers to the authorized Case view for
the checklist and keeps the Case receipt in durable storage.

Status commitment rechecks the accepted handoff for the receiving run and
its completion corrective wake. If the Case is cancelled, the handoff is
withdrawn or superseded, or the recipient no longer owns the task, the
result, assessment, and final reply remain in run history. The status decision
records `case_handoff_superseded` at the task's current status.

## Board and verification

The board case list/detail pages are read-only. URL query parameters retain
search/status/type/project filters through detail navigation; list paging and
the `GET /api/companies/:companyId/cases/types` read use authorized server data.
Storybook's Cases / Read-only pages stories mount those same production pages
with HTTP fixtures, including document previews, waiting handoffs and mobile.

Cases do not have a quarantine/promotion contract. Low-trust runs must save
findings through their governed task/review path rather than write case data.
Historical low-trust case provenance also blocks automatic execution context
and handoffs; operator reads remain available for review. Skill-test runs omit
workflow context to preserve their task-only scope. Cancelled or unapplied
handoff intent is history, not an incoming phase instruction.

Focused verification lives in the case route, handoff service, native handoff,
durable admission, and legacy process integration tests. Linux source
qualification requires the assembled native handoff case to pass with the
Rust Runner and a scripted provider. Run the explicit-only
case-handoffs Product E2E workflow for provider/browser qualification; fixture
and service tests do not establish that a live model followed the workflow.
See [implementation and acceptance](plans/2026-10-19-persistent-case-handoffs.md)
and the [agent case reference](../skills/proprio/references/cases.md).
