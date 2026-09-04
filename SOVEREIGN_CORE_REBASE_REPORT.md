# SOVEREIGN CORE REBASE REPORT
**Universal Agent Asset Router**  
**Phase**: Architecture V4 — Sovereign Atomic Core Rebase  
**Date**: 2026-09-03  
**Status**: COMPLETE, VERIFIED & PASSING (Zero Real Money Moved)  

> [!NOTE]
> **HISTORICAL PHASE REPORT — SUPERSEDED BY DIRECT BASE V4 (PHASE 4)**  
> This report records the initial Architecture V4 Sovereign Core rebase as of September 3, 2026. The initial route was subsequently finalized and frozen as the Direct Base canonical USDC HTLC route (Phase 4 / `DIRECT_BASE_USDC_ROUTE_REPORT.md`), superseding intermediate Arbitrum/CCTP execution concepts.

---

## 1. EXECUTIVE SUMMARY

In accordance with the owner's strategic pivot, the **Universal Agent Asset Router** has been fundamentally rebased from an external swap aggregator into a **Sovereign Non-Custodial Atomic Execution Engine**.

Key accomplishments of this phase:
1. **Threat Model & Security Invariants Frozen**: Authored [`SECURITY_MODEL_V1.md`](SECURITY_MODEL_V1.md) analyzing 30 distinct failure modes and freezing 25 inviolable security invariants (`SEC-1` through `SEC-25`).
2. **Architecture V4 Frozen**: Authored [`ARCHITECTURE_V4_SOVEREIGN_CORE.md`](ARCHITECTURE_V4_SOVEREIGN_CORE.md) establishing the 33-section specification for the primary sovereign rail:
   $$\mathbf{BTC\ (Lightning)\ \longrightarrow\ Canonical\ USDC\ (Base\ L2)}$$
3. **Core Local Abstractions Implemented**: Developed `AtomicCoordinator`, `ILightningAtomicBackend`, `FakeLightningAtomicBackend`, `IEvmAtomicBackend`, `FakeEvmAtomicBackend`, and `FakeLiquidityInventory`.
4. **Codebase Reorganization & De-Cluttering**: Isolated third-party swap providers (`FixedFloat`, `SideShift`) into `src/adapters/external/` as optional, disabled-by-default plugins. Removed legacy price probes and maintenance scripts.
5. **Zero Hosted Vendor Dependency**: Proved that the core engine boots, compiles, tests, and operates 100% offline with zero hosted swap credentials.
6. **134 / 134 Tests Passing**: 38 new sovereign atomic security tests implemented and verified alongside the existing cross-process and adversarial regression suite.
7. **Typecheck & Secret Scan Clean**: Static TypeScript typecheck returned 0 errors; secret scanning verified 0 leaks across all repository files.

---

## 2. THREAT MODEL SUMMARY (30 MODES)

The 30 threat modes analyzed in [`SECURITY_MODEL_V1.md`](SECURITY_MODEL_V1.md) cover every layer of the sovereign atomic lifecycle across 8 dimensions (Asset at Risk, Trust Boundary, Scenario, Consequence, Prevention, Detection, Recovery, Residual Risk):

* **T-01 to T-05**: User / Agent Intent & Key Isolation (malicious intents, fee drain, unauthorized spends).
* **T-06 to T-10**: Lightning Hold Invoice Lifecycle (unfunded expiry, griefing, invoice collision, early cancellation).
* **T-11 to T-15**: EVM HTLC Execution (front-running, reorgs, timelock skew, contract reversion).
* **T-16 to T-20**: Atomic Coupling & Settlement (asymmetric settlement, secret leak, double-claim/refund races).
* **T-21 to T-25**: Cross-Chain Bridging & CCTP (Circle Iris delay, domain spoofing, wrong USDC contract).
* **T-26 to T-30**: Infrastructure, Concurrency & Operator Faults (DB corruption, duplicate worker dispatch, relayer gas exhaustion).

---

## 3. FROZEN SECURITY INVARIANTS (SEC-1 THROUGH SEC-25)

The 25 security invariants frozen in [`SECURITY_MODEL_V1.md`](SECURITY_MODEL_V1.md) govern all current and future implementations:

| Invariant | Description |
| :--- | :--- |
| **SEC-1** | Router **never** stores, sees, or handles user private keys. |
| **SEC-2** | Router **never** stores, sees, or handles user mnemonics or seed phrases. |
| **SEC-3** | Client retains unilateral on-chain recovery capability (`doomsday`). |
| **SEC-4** | Client cryptographic authorization is required for every financial action. |
| **SEC-5** | Durable side-effect registration prior to external network dispatch. |
| **SEC-6** | Ambiguous financial actions are **never** automatically retried. |
| **SEC-7** | Idempotency key collision with mismatched intent payload is rejected. |
| **SEC-8** | State machine strictly enforces unidirectional linear progression. |
| **SEC-9** | Transitions to ordinary `FAILED` are forbidden once funds move or are held. |
| **SEC-10** | Claim and refund paths are programmatically and cryptographically mutually exclusive. |
| **SEC-11** | Secret-bearing material is sanitized from all public interfaces, logs, and database records. |
| **SEC-12** | Database write-ahead logging (WAL) and immediate transactions for all mutations. |
| **SEC-13** | Crash recovery restores in-flight state without re-dispatching side effects. |
| **SEC-14** | Exactly one worker process owns an execution action at any time. |
| **SEC-15** | Router core possesses zero hardcoded vendor dependencies. |
| **SEC-16** | Core build, tests, and boot succeed with zero hosted provider credentials. |
| **SEC-17** | Optional external adapters remain isolated and disabled by default. |
| **SEC-18** | Schema and protocol versions are persisted; version mismatches fail closed. |
| **SEC-19** | Mock and fake backends are strictly prohibited in production mode. |
| **SEC-20** | Independent multi-source verification for on-chain settlement proof. |
| **SEC-21** | Consensus block timestamps govern all contract timelocks. |
| **SEC-22** | Circuit breaker halts execution upon anomalous failure rates. |
| **SEC-23** | Blast-radius value caps enforced per swap, aggregate in-flight, and daily. |
| **SEC-24** | Relayer gas wallets hold minimal micro-balances and cannot divert funds. |
| **SEC-25** | Automated continuous secret scanning in all local and CI/CD pipelines. |

---

## 4. ARCHITECTURE V4 SUMMARY

Architecture V4 decouples the Router from centralized counterparties:
1. **Core Sovereignty**: Router directly operates LND/CLN and EVM nodes.
2. **Dual-Leg Symmetry**: Lightning hold invoice and Arbitrum `HTLCErc20` are cryptographically bound to the same hashlock $H = \text{SHA256}(S)$.
3. **Asymmetric Timelock Shield**: Arbitrum EVM timelock (12h) is strictly shorter than Lightning invoice CLTV (24h), guaranteeing operator collateral safety.
4. **Canonical Base Delivery**: Claimed funds on Arbitrum flow through Circle CCTP to mint canonical USDC on Base.

---

## 5. CODEBASE CLEANUP SUMMARY

| Category | Action | Files / Locations | Rationale |
| :--- | :--- | :--- | :--- |
| **Deleted** | Removed | `src/cli/fixedfloat-validate.ts` | Obsolete development probe script |
| **Moved** | Relocated | `src/providers/fixedfloat.ts` $\rightarrow$ `src/adapters/external/fixedfloat.ts` | External provider isolated to optional plugin |
| **Moved** | Relocated | `src/providers/sideshift.ts` $\rightarrow$ `src/adapters/external/sideshift.ts` | External provider isolated to optional plugin |
| **New Core** | Created | `src/atomic/types.ts` | Sovereign atomic types, interfaces, state enums |
| **New Core** | Created | `src/atomic/lightning/fake-backend.ts` | Deterministic local Lightning hold invoice backend |
| **New Core** | Created | `src/atomic/evm/fake-backend.ts` | Deterministic local EVM HTLC backend |
| **New Core** | Created | `src/atomic/liquidity/fake-inventory.ts` | Collateral reservation and cap management |
| **New Core** | Created | `src/atomic/coordinator/coordinator.ts` | Sovereign atomic swap lifecycle coordinator |
| **Updated** | Modified | `src/cli/quote-demo.ts` | Demonstrates 100% offline sovereign atomic execution |
| **Updated** | Modified | `package.json` | Removed `fixedfloat:validate` script |
| **Cleaned** | Overwritten | `.env.example` | Zero hosted swap provider credentials required |

---

## 6. TEST SUITE RESULTS (134 / 134 PASSING)

```
✔ 134 tests pass across 11 test suites (0 failed, 0 skipped, 0 cancelled)
Duration: ~6.2s
```

### Breakdown by Category:
1. **Sovereign Atomic Core (38 tests in `tests/sovereign-atomic-core.test.ts`)**:
   - **Core Independence**: Tests 1–4 (Boots with 0 credentials, 0 hosted providers registered, 0 outbound calls, adapter deletion safe).
   - **Atomic Binding & Mutual Exclusion**: Tests 5–12 (Identical hashlock binding, wrong preimage rejection, valid claim evidence, timelock refund eligibility, mutual exclusion of claim vs refund).
   - **State Machine Integrity**: Tests 13–17 (`HELD != SETTLED`, `HTLC_FUNDED != COMPLETED`, `DESTINATION_SEEN != VERIFIED`, ordinary `FAILED` prohibited).
   - **Crash / Recovery**: Tests 18–23 (Restarts across invoice creation, hold detection, HTLC funding, preimage revelation, settlement, refund).
   - **Durable Action Ownership**: Tests 24–27 (Concurrent prepare deduplication, single action owner for funding, ambiguous side-effect protection).
   - **Custody & Privacy**: Tests 28–32 (Zero user private keys, mnemonics, or seeds; serialization cleanliness; client public hash/address only).
   - **Security & Fail-Closed**: Tests 33–38 (Unknown states fail closed, invalid transitions rejected, mock backend forbidden in prod, secret redaction, protocol versioning).
2. **Cross-Process Concurrency Safety (5 tests in `tests/cross-process-safety.test.ts`)**:
   - SQLite `BEGIN IMMEDIATE` transactions, `provider_dispatch_claims` uniqueness, zero duplicate orders across worker processes.
3. **Pre-Money Adversarial Safety Review (21 tests in `tests/pre-money-adversarial.test.ts`)**:
   - Duplicate requests, payload tampering, network drops, crash recovery, Base USDC receipt verification.
4. **Architecture V3 Baseline & Persistence (70 tests in existing suites)**:
   - Preserved all generic routing, SQLite WAL, evidence storage, and state machine validation.

---

## 7. DEPENDENCY & SECRET SCAN STATE

* **Runtime Dependencies**: Strictly minimal (`zod`, Node.js native standard library).
* **TypeScript Compilation**: `npm run typecheck` $\rightarrow$ **0 errors (CLEAN)**.
* **Secret Scanner**: `python tests/scan-secrets.py` $\rightarrow$ **SCAN CLEAN: 0 secrets found across all repository files**.
* **Git Status**: Clean working tree ready for review.

---

## 8. COMPARISON: ARCHITECTURE V3 VS. ARCHITECTURE V4

| Dimension | Architecture V3 (Superseded) | Architecture V4 (Active Sovereign Core) |
| :--- | :--- | :--- |
| **Primary Execution Rail** | Third-party swap provider (FixedFloat) | **Sovereign Atomic Swap (Lightning $\leftrightarrow$ EVM)** |
| **Core Dependency** | Hosted REST API & API Secret | **Self-hosted Node / Open-Source Contracts** |
| **Counterparty Risk** | Trusted custodial intermediary | **Trust-minimized cryptographic atomic contracts** |
| **Testing Requirement** | Mocked third-party API | **Deterministic local protocol simulation** |
| **Offline Operability** | Dependent on external API availability | **100% offline verifiable without internet connection** |
| **User Key Custody** | None (funds sent to deposit address) | **None (strictly client-side hashlock & signatures)** |
| **Failure Recovery** | Dependent on provider refund policy | **Unilateral on-chain refund via contract timelock** |
| **External Providers** | Primary execution edges | **Optional fallback plugins (disabled by default)** |

---

## 9. LOCAL REGTEST READINESS

The local abstractions implemented in Phase 4A directly map to live node RPC interfaces:
* `ILightningAtomicBackend` $\longrightarrow$ LND `invoicesrpc` (`AddHoldInvoice`, `SettleInvoice`, `CancelInvoice`)
* `IEvmAtomicBackend` $\longrightarrow$ Viem / Ethers contract calls to `HTLCErc20.sol` and `HTLCCoordinator.sol`
* `ILiquidityInventory` $\longrightarrow$ Hot-wallet collateral inventory manager

---

## 10. RECOMMENDED NEXT PHASE: PHASE 4B (DOCKER REGTEST ENVIRONMENT)

With the local deterministic sovereign core fully established, tested, and verified, the recommended next step is:

**Phase 4B: Local Docker Regtest Environment**
1. Spin up a local regtest Docker Compose stack (`bitcoind`, 2x `lnd` nodes, Foundry `anvil` Arbitrum fork).
2. Deploy open-source `HTLCErc20.sol` and `HTLCCoordinator.sol` locally.
3. Wire live RPC adapters (`LndAtomicBackend` and `EvmRpcAtomicBackend`) against the regtest containers.
4. Execute an automated, live-software end-to-end atomic swap using fake regtest coins.
