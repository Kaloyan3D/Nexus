# Registry R6.4 — Claude Orchestrator Compatibility Assessment

Branch: feature/model-registry-v1. Verdict: ORCHESTRATION STAYS DISABLED.
Status: assessment only. No role was enabled; no controller policy was weakened.

Scope: whether the existing Claude CLI subscription-agent adapter
(config/registry/subscription-connections.cjs: runClaudeAgent / buildClaudeArgv /
parseClaudeStreamEvents / checkBillingSeparation) can safely serve as an EM
orchestrator. The execution contract is agent-sdk, not raw-model: the Claude
model record ships with engines: [] (eligible for NO engine in R5) and the
runtime projection fails closed on agent-sdk as a raw transport
(config/registry/runtime-projection.cjs lines 13-15). Enabling any role needs a
deliberate engines-scope change under the R6.3 flag, never silence.

## Proof-point evaluation

1. Controller-owned task identity and working-directory authority — PARTIAL.
   The adapter tags every parsed event with the caller taskId and accepts a
   caller-provided cwd, but it trusts both inputs. No Nexus-owned spawn host
   exists (defaultHooks provides NO spawnEvents; runClaudeAgent fails with
   claude-spawn-unavailable unless a host injects one), so nothing validates
   cwd against the session execution root or pins taskId today.
2. Bounded and cancellable process execution — CONTRACT PROVEN (tests).
   --max-turns (default 10), bounded timeout (default 120s), caller
   AbortSignal passthrough, output budgets (1MB / 500 events, truncation with
   errors). R5.1 suite covers cancel/timeout/budget paths with injected hooks.
3. Correct handling of streamed results — CONTRACT ONLY, live UNVERIFIED.
   Line-delimited stream-json parsing, malformed-line skip, secret-shape scan,
   session_id extraction. No Claude CLI exists in this environment, so real CLI
   event shapes are unverified (declared surface: --print, stream-json,
   --max-turns, --model, --system-prompt, --resume, --permission-mode,
   --allowedTools).
4. Session resume identity and pinning — MISSING. resumeSessionId is a
   passthrough and sessionId is extracted, but no code binds a resume id to a
   taskInstanceId or refuses cross-task resume. Active-session pinning rules
   (R6.1 section 5) have no adapter-side equivalent yet.
5. Tool permissions and approval enforcement — MISSING. allowedTools and
   permissionMode are caller-asserted strings forwarded to the CLI. There is no
   Nexus-owned allowlist, no role-to-permission mapping, and no audit of which
   tools the CLI actually executed. The CLI owns its tool loop.
6. Reviewer read-only / solver approval restrictions — MISSING. No mapping
   exists from reviewer to permission-mode plan, nor from solver to an
   approval-gated acceptEdits path. The R6.1 enforcement points (Routing.ps1
   solver flag, reviewer never exposed as a tool) stop at the Dual/Muse planes.
7. Subscription versus API billing separation — PROVEN (tests).
   checkBillingSeparation fails closed on ANTHROPIC_API_KEY / AUTH_TOKEN /
   BASE_URL / Bedrock / Vertex unless an explicit per-call opt-in is passed;
   R5.1 suite pins per-source behavior. The R6.0 preflight (f21d9bd) closed the
   remaining classifier gaps (explicit login, negative-first ordering).
8. No uncontrolled tool execution by the external agent — NOT PROVABLE.
   --max-turns bounds iterations, not tool selection. Nexus observes only
   stream-json stdout; it cannot enumerate, allow, or audit tool executions.
9. No automatic provider substitution — PARTIAL. Billing guard plus explicit
   opt-ins prevent silent API billing, but --model passthrough is
   caller-controlled with no Nexus model-selection policy.

## Missing capabilities (all required before any role is enabled)

- (a) Nexus-owned CLI spawn host: validates cwd against the bound execution
  root, pins taskId/taskInstanceId on every event, enforces timeout/cancel.
- (b) Resume-id pinning: resume ids bound to one taskInstanceId; cross-task
  resume refused.
- (c) Role-to-permission policy: reviewer implies permission-mode plan with no
  edit tools; solver implies approval-gated acceptEdits; enforced Nexus-side,
  never caller-asserted. Dual/Muse approval boundaries must extend, not bend.
- (d) Tool-execution audit: derive the executed tool set from stream-json and
  enforce a deny-by-default allowlist per role.
- (e) Model-selection policy: explicit allowed-model set per binding; no silent
  substitution via --model.
- (f) Live CLI verification: real-cli shape, permission, and billing-path tests
  on a host with the official CLI installed (none exists here).

## Decision

Leave orchestration disabled. The adapter remains a connection plus execution
contract (check/discover/run building blocks) and is NOT an Engineering Mode
orchestrator in R6. Do not weaken the controller (solver flag, reviewer
isolation, engine binding, fail-closed routing) to make Claude fit.
Revisit only when (a)-(f) are implemented under the R6.3 flag with parity gates.
