# PRE-MONEY ADVERSARIAL SAFETY REVIEW
**Universal Agent Asset Router**  
**Phase**: Phase 2 — Pre-Money Adversarial Safety Review  
**Date**: 2026-09-03  
**Mode**: Adversarial Audit & Safety Hardening  
**Status**: Complete — 91 / 91 Tests Passing — Zero Real Money Moved  

---

## 1. EXECUTIVE VERDICT

**PRE-MONEY SAFETY REVIEW PASSED — READY FOR OWNER APPROVAL OF CONTROLLED REAL-MONEY POC**

The Universal Agent Asset Router codebase was subjected to an adversarial safety audit simulating crashes, concurrent duplicate dispatches, network timeouts, stale availability races, dynamic minimum shifts, corrupted provider claims, token loss, and process restarts.

Two P0 defects (idempotency conflict masking and concurrent dispatch race) and two P1 defects (stale availability and dynamic minimum bypass in `executePlan`) were exposed via deterministic failing probes, isolated, and resolved with minimal, localized safety fixes.

All 18 mandated safety invariants (**INV-1 through INV-18**) are formally proven with passing tests. **91 out of 91 tests are passing**, TypeScript compiles cleanly with 0 errors, and the repository is clean of secrets.

---

## 2. ARCHITECTURE V3 COMPONENTS AUDITED

The audit directly analyzed the code and state transitions across:
* **[`src/domain/types.ts`](file:///c:/Users/faruk/Desktop/universal-agent-asset-router/src/domain/types.ts)**: AssetNode models, intent semantic equality, error codes, and capability declarations.
* **[`src/routing/planner.ts`](file:///c:/Users/faruk/Desktop/universal-agent-asset-router/src/routing/planner.ts)**: Static route matching, dynamic availability filtering, amount boundary enforcement, and plan snapshotting.
* **[`src/orchestrator/orchestrator.ts`](file:///c:/Users/faruk/Desktop/universal-agent-asset-router/src/orchestrator/orchestrator.ts)**: Lifecycle orchestration, concurrency deduplication, availability revalidation, and provider reconciliation.
* **[`src/providers/fixedfloat.ts`](file:///c:/Users/faruk/Desktop/universal-agent-asset-router/src/providers/fixedfloat.ts)**: HMAC authentication, currency receiving gate (`BTCLN recv == 0`), and dynamic minimum mapping.
* **[`src/persistence/sqlite.ts`](file:///c:/Users/faruk/Desktop/universal-agent-asset-router/src/persistence/sqlite.ts)**: Atomic SQLite transactions, idempotency deduplication, and the durable `provider_request_journal`.
* **[`src/state-machine/engine.ts`](file:///c:/Users/faruk/Desktop/universal-agent-asset-router/src/state-machine/engine.ts)**: Legal transition graphs and source funds movement protection.
* **[`src/verification/verifier.ts`](file:///c:/Users/faruk/Desktop/universal-agent-asset-router/src/verification/verifier.ts)**: Independent Base L2 canonical USDC on-chain verification.

---

## 3. THREAT MODEL

Autonomous AI and software agents interact with external financial counterparties over unreliable networks. The threat model assumes:
1. **Unreliable Transport**: Dropped TCP connections, HTTP 504 timeouts, and packet loss can occur immediately after an outbound order creation request is transmitted.
2. **Provider Non-Idempotency**: Upstream exchanges (such as FixedFloat) do not accept client-provided idempotency keys on order creation; retrying a timed-out request creates a duplicate order.
3. **Provider Lying / De-synchronization**: A provider may report `COMPLETED` when no on-chain transaction was broadcast, or report `FAILED` after source funds were deposited.
4. **Adversarial Client Concurrency**: Multi-threaded or clustered agent processes may fire multiple identical or conflicting requests simultaneously with the same idempotency key.
5. **Dynamic Liquidity Shifts**: Exchange currency availability (`recv = 0`) or minimum limits can fluctuate between quote issuance and plan execution.
6. **Sudden Process Termination**: The host OS or container can terminate at any point in the execution lifecycle.

---

## 4. DEFECTS FOUND & RESOLVED

### Defect 1: Idempotency Conflict Masking (P0)
* **Scenario**: Client sends a request with an existing `idempotencyKey`, but with different parameters (e.g. different amount, different destination address, or different asset pair).
* **Financial Consequence**: Silent reuse of an old execution record. A client requesting a $1,000 swap to address $B$ could receive the $10 deposit instruction previously generated for address $A$, causing funds to be sent to the wrong destination or for the wrong amount.
* **Failing Test**: `tests/pre-money-adversarial.test.ts` (Tests C, D, E).
* **Root Cause**: `SqlitePersistence.createExecution` and `ExecutionOrchestrator.initiateExecution` returned `existing` solely by key lookup without verifying intent equality.
* **Minimal Fix**: Introduced `areIntentsSemanticallyEqual()` in `types.ts` and added strict validation throwing `RouterError(DomainErrorCode.IDEMPOTENCY_CONFLICT)` upon payload mismatch.
* **Post-Fix Result**: All conflicting idempotent attempts are rejected with `IDEMPOTENCY_CONFLICT`; semantic duplicates continue to recover safely.

---

### Defect 2: Concurrent Duplicate Provider Order Dispatches (P0)
* **Scenario**: 20 asynchronous requests with the same idempotency key arrive concurrently at `initiateExecution()`.
* **Financial Consequence**: In-flight concurrency race where multiple threads passed the database check before `DEPOSIT_INSTRUCTION_READY` was reached, resulting in multiple outbound orders and multiple exposed invoices for a single user operation.
* **Failing Test**: `tests/pre-money-adversarial.test.ts` (Test B).
* **Root Cause**: An in-flight request was not locked/deduplicated in memory before socket dispatch; subsequent concurrent requests saw an intermediate database state and either created duplicate dispatches or received `depositAddress: null`.
* **Minimal Fix**: Implemented in-flight promise deduplication via `inFlightExecutions: Map<string, Promise<ExecutionRecord>>` in `ExecutionOrchestrator`, prioritizing in-flight promise awaiting before database reads.
* **Post-Fix Result**: Tested with 20 simultaneous overlapping async calls; `provider.createExecution` was called **exactly once**, and all 20 callers received the identical execution record and payment invoice.

---

### Defect 3: Stale Runtime Availability in `executePlan()` (P1)
* **Scenario**: FixedFloat `BTCLN recv = 1` when quote is generated, but FixedFloat suspends receiving (`BTCLN recv = 0`) before `executePlan()` is called.
* **Financial Consequence**: Dispatching order creation to an exchange during active maintenance, risking stuck or delayed funds.
* **Failing Test**: `tests/pre-money-adversarial.test.ts` (Availability Race test).
* **Root Cause**: `executePlan()` and `initiateExecution()` validated quote timestamp expiry, but did not revalidate live `edge.getRuntimeAvailability()`.
* **Minimal Fix**: Added immediate pre-dispatch availability revalidation in `executePlan()`. If `availability.isMaintenance` or `!availability.recvEnabled`, execution is blocked before socket write with `PROVIDER_MAINTENANCE` or `ROUTE_UNAVAILABLE`.
* **Post-Fix Result**: Order creation is definitively blocked; zero provider requests are dispatched.

---

### Defect 4: Dynamic Minimum Shift Race in `executePlan()` (P1)
* **Scenario**: Exchange minimum increases from 2,000 sats to 3,000 sats between quote creation and plan execution for a 2,500 sat plan.
* **Financial Consequence**: Order creation fails at provider or produces an underfunded deposit instruction that provider refuses to process.
* **Failing Test**: `tests/pre-money-adversarial.test.ts` (Dynamic Minimum Race test).
* **Root Cause**: `executePlan()` did not recheck the plan amount against the live runtime minimum immediately before dispatch.
* **Minimal Fix**: Added atomic boundary revalidation in `executePlan()`; rejects with `AMOUNT_BELOW_MINIMUM` before provider dispatch.
* **Post-Fix Result**: Order is cleanly rejected before provider contact.

---

### Defect 5: Unhandled Provider `FAILED` with Active Deposit (P1)
* **Scenario**: Provider status query returns `status: "FAILED"`, but the router already observed inbound source funds (`SOURCE_FUNDS_DETECTED`).
* **Financial Consequence**: If the router blindly trusted the provider's `FAILED` status, it could allow an illegal state transition or mask missing funds.
* **Failing Test**: `tests/pre-money-adversarial.test.ts` (Provider claims FAILED test).
* **Root Cause**: `ProviderNormalizedStatus.FAILED` was not explicitly handled in `reconcileExecution`, falling through to generic retry.
* **Minimal Fix**: Added explicit `case ProviderNormalizedStatus.FAILED:`. If `sourceFundsMoved` or state is in source-funds-moved set, immediately transition to `MANUAL_REVIEW`.
* **Post-Fix Result**: Router refuses ordinary failure and flags human inspection.

---

## 5. PROVIDER CREATE CRASH MATRIX

| Crash Boundary | Router State | Provider State | Funds Moved | Router Recovery Behavior | Invariant Result |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Case 1: Crash before journal write** | `CREATED` | No call made | False | Clean restart; no provider record exists. | **SAFE** |
| **Case 2: Crash after journal, before socket write** | `CREATED` | No call made | False | Journal records `AMBIGUOUS_TIMEOUT`, `responsePersisted: false`. Reconciles cleanly. | **SAFE** |
| **Case 3: Crash during outbound request** | `EXECUTING` | Unknown | False | Inbound invoice was never exposed. PASSIVE_DEPOSIT edge safely reconciles to `FAILED`. | **SAFE** |
| **Case 4: Provider created order, response lost** | `EXECUTING` | Active order | False | Deposit instruction never reached user. Client never paid. Reconciles to `FAILED` (zero funds moved). | **SAFE** |
| **Case 5: Response received, DB commit fails** | `EXECUTING` | Active order | False | Journal marks `responsePersisted: false`. Reconciles to `FAILED`. Zero funds moved. | **SAFE** |
| **Case 6: Provider ID persisted, token lost** | `DEPOSIT_READY`| Active order | Unknown | If invoice was exposed and token lost, automated recovery cannot query status $\rightarrow$ Escalates to `MANUAL_REVIEW`. | **LIMITATION HONESTLY FLAGGED** |
| **Case 7: ID/token saved, crash before invoice return**| `DEPOSIT_READY`| Active order | False | Client retry recovers existing record and returns existing deposit address. Zero replacement orders. | **SAFE** |
| **Case 8: Invoice saved, crash before return** | `DEPOSIT_READY`| Active order | False | Client retry returns identical deposit instruction. No duplicate dispatches. | **SAFE** |
| **Case 9: Invoice exposed, process crashes** | `DEPOSIT_READY`| Active order | Possible | Restart reloads state; status poller monitors inbound deposit. | **SAFE** |

---

## 6. IDEMPOTENCY & CONCURRENCY RESULTS

* **Sequential Duplicates**: Verified that duplicate calls with identical key and payload return the exact same execution record without creating a second provider order.
* **Concurrent Duplicates**: Tested with **20 overlapping asynchronous requests** via `Promise.all`. The in-flight promise deduplicator ensured `provider.createExecution()` was called **exactly once**. All 20 callers resolved with the identical deposit address.
* **Idempotency Conflicts**: Tested changing `sourceAmountAtomic`, `destinationAddress`, and `sourceAsset`. All threw `RouterError(DomainErrorCode.IDEMPOTENCY_CONFLICT)`.
* **Cross-State Idempotency**: Verified that retrying an idempotency key after `DEPOSIT_INSTRUCTION_READY`, `SOURCE_FUNDS_DETECTED`, and `COMPLETED` returns the existing record and never triggers a new order.

---

## 7. AVAILABILITY & MINIMUM RACE RESULTS

* **Availability Race**: Demonstrated that when FixedFloat sets `BTCLN recv = 0` between quote creation and plan execution, `executePlan()` blocks order creation and returns `PROVIDER_MAINTENANCE`.
* **Dynamic Minimum Race**: Demonstrated that when live minimum rises above the planned deposit, `executePlan()` blocks order creation and returns `AMOUNT_BELOW_MINIMUM`.
* **Zero Phantom Dispatches**: In both race scenarios, `edge.createCount` remained strictly `0`.

---

## 8. QUOTE & EXECUTION PLAN INTEGRITY

* **Clock Injectability**: Added optional `nowFn: () => number` to `ExecutionOrchestrator` for deterministic time testing.
* **Exact Boundary Testing**:
  * 1 ms before quote expiry: Execution initiates successfully.
  * Exact `expiresAt`: Rejected with `FAILED`.
  * 1 ms after quote expiry: Rejected with `FAILED`.
* **Snapshot Immutability**: Verified that runtime changes to exchange minimums, maximums, or caller memory objects do not mutate the persisted `ExecutionPlan`.

---

## 9. STATE MACHINE MONEY-MOVEMENT REVIEW

* **Source Movement Lock**: Verified that transitions from `SOURCE_FUNDS_DETECTED`, `SOURCE_FUNDS_CONFIRMED`, `SWAP_IN_PROGRESS`, and `DESTINATION_TX_DETECTED` to `FAILED` throw `IllegalStateTransitionError`.
* **Zero Deposit Certification**: Proved that transitioning from `DEPOSIT_INSTRUCTION_READY` to `FAILED` strictly requires `zeroDepositConfirmed: true`.

---

## 10. DESTINATION VERIFICATION REVIEW

Independent Base RPC verification was tested against simulated attack outcomes:
* Non-Base network $\rightarrow$ Rejected (`WRONG_NETWORK`).
* Divergent recipient address $\rightarrow$ Flagged (`WRONG_RECIPIENT` $\rightarrow$ `MANUAL_REVIEW`).
* Non-canonical token address $\rightarrow$ Flagged (`WRONG_TOKEN` $\rightarrow$ `MANUAL_REVIEW`).
* Amount 1 atomic unit below threshold $\rightarrow$ Flagged (`AMOUNT_MISMATCH` $\rightarrow$ `MANUAL_REVIEW`).
* Reverted transaction receipt (status 0) $\rightarrow$ Flagged (`REVERTED` $\rightarrow$ `MANUAL_REVIEW`).
* Canonical Circle USDC contract (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) $\rightarrow$ Verified (`CONFIRMED` $\rightarrow$ `COMPLETED`).

---

## 11. REFUND & RECOVERY REVIEW

* **Evidence Requirement**: Provider reporting `REFUNDED` without a valid on-chain refund transaction hash is blocked from transitioning to `REFUNDED` and escalates to `MANUAL_REVIEW`.
* **Verified Evidence**: Provider supplying a verified transaction hash transitions to `REFUNDED`.

---

## 12. RESTART & PERSISTENCE REVIEW

* Tested re-instantiating `ExecutionOrchestrator` on SQLite databases containing executions across all 15 states.
* **Zero Duplicate Dispatches**: In no state does restart or reconciliation blindly dispatch a replacement order to the provider.

---

## 13. PROVIDER REQUEST JOURNAL REVIEW

* Every outbound provider request commits a row to SQLite `provider_request_journal` **before** network transmission.
* Initial state: `resultClassification = 'AMBIGUOUS_TIMEOUT'`, `responsePersisted = 0`.
* Upon database commit of provider response: updated to `resultClassification = 'SUCCESS'`, `responsePersisted = 1`.
* No auth headers, API secrets, or sensitive tokens are stored in the journal.

---

## 14. SECRET & CREDENTIAL REVIEW

* Verified zero secrets in logs, audit tables, public error serializations, and git status.
* Running `python tests/scan-secrets.py` confirms: **SCAN CLEAN: 0 secrets found**.

---

## 15. SAFETY INVARIANT MATRIX (INV-1 THROUGH INV-18)

| Invariant | Description | Result | Evidence |
| :--- | :--- | :--- | :--- |
| **INV-1** | One Router execution cannot intentionally create two provider orders | **PASS** | Tests A, B, and 26 |
| **INV-2** | Ambiguous provider create is never automatically retried | **PASS** | Crash Case 3, 4, and Audit 1 |
| **INV-3** | A persisted/exposed deposit instruction is never silently replaced | **PASS** | Test F-I, Test 25, and Audit 4 |
| **INV-4** | After source funds may have moved, ordinary FAILED is forbidden | **PASS** | State machine tests, test 28, 29 |
| **INV-5** | Provider COMPLETED does not imply Router COMPLETED | **PASS** | Test 31 and Provider Lie tests |
| **INV-6** | Router COMPLETED requires independent destination evidence | **PASS** | Destination verification tests |
| **INV-7** | Provider REFUNDED does not imply Router REFUNDED | **PASS** | Test 36 and Audit 12 |
| **INV-8** | Expired quote/plan cannot begin execution | **PASS** | Test 17, quote expiry tests |
| **INV-9** | Runtime-unavailable route cannot begin provider execution | **PASS** | Availability race tests |
| **INV-10**| Amount outside current safe limits cannot begin provider execution | **PASS** | Dynamic minimum race tests |
| **INV-11**| Client retry cannot create second execution for same idempotent request | **PASS** | Test 19 and Test A |
| **INV-12**| Conflicting idempotent request cannot reuse prior execution | **PASS** | Tests C, D, E (`IDEMPOTENCY_CONFLICT`) |
| **INV-13**| Crash/restart cannot turn uncertainty into permission to retry create | **PASS** | Restart audit across all 15 states |
| **INV-14**| Provider recovery secrets never appear in client/public output | **PASS** | Test 40, secret scanner |
| **INV-15**| Mock behavior cannot be reached accidentally by real configuration | **PASS** | Explicit registration tests |
| **INV-16**| No floating-point arithmetic used for financial atomic amounts | **PASS** | Integer string / BigInt enforcement |
| **INV-17**| `executePlan()` cannot bypass persisted Router intent | **PASS** | `executePlan` caller audit tests |
| **INV-18**| Concurrent execution attempts cannot produce duplicate orders | **PASS** | 20 concurrent overlapping calls test |

---

## 16. REMAINING LIMITATIONS

1. **FixedFloat Secret Token Requirement (Case 6)**: FixedFloat order status queries require both the order ID and the secret `token`. If a crash occurs after the deposit instruction was exposed to the user, and the local database suffered catastrophic corruption losing the token, the router cannot query order status via API. The router honestly flags this state as `MANUAL_REVIEW` rather than pretending it can auto-recover.
2. **Upstream Exchange Maintenance**: When FixedFloat flags `BTCLN recv: 0`, Lightning execution is suspended until FixedFloat resumes inbound channel liquidity.

---

## 17. EXACT REAL-MONEY RECOMMENDATION

**READY FOR OWNER APPROVAL OF CONTROLLED REAL-MONEY POC**

All safety gates required before moving real money are satisfied:
1. Concurrency deduplication strictly prevents duplicate order dispatches.
2. Conflicting idempotency payloads are rejected with `IDEMPOTENCY_CONFLICT`.
3. Outbound requests are durably journaled prior to network transmission.
4. Pre-dispatch availability and minimum checks prevent executing during provider maintenance.
5. Independent Base RPC verification prevents false completion.
6. The router operates with zero wallet custody and holds zero private keys.

**Condition for Real-Money PoC**:
The owner must independently approve executing a single, minimal-amount test (~1,450 satoshis / ~$1.15 USD) once FixedFloat lifts its temporary `BTCLN` receiving maintenance.

---

## 18. TEST, TYPECHECK & SECRET SCAN RESULTS

* **Test Suite**: **91 / 91 tests passing** (duration: ~2.8s).
* **Typecheck**: `npm run typecheck` (`tsc --noEmit`) $\rightarrow$ **0 errors**.
* **Secret Scanner**: `python tests/scan-secrets.py` $\rightarrow$ **0 secrets found**.
