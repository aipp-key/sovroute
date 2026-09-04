# ARCHITECTURE V4 — SOVEREIGN ATOMIC CORE
**Universal Agent Asset Router**  
**Document Version**: 4.0.0  
**Status**: APPROVED & FROZEN — SYSTEM-WIDE ARCHITECTURAL SPECIFICATION  
**Supersedes**: Architecture V3, All Provider-First Designs  

---

## 1. STRATEGIC CHANGE

The strategic direction of the Universal Agent Asset Router has undergone an absolute rebase:
* **Previous Direction (Architecture V3)**: Universal Router acting as an orchestrator across external hosted swap providers (FixedFloat, Satora hosted API, Boltz, SideShift).
* **New Direction (Architecture V4)**: **THE ROUTER MUST OWN ITS PRIMARY EXECUTION CORE.** The system is architected as a **Sovereign Atomic Execution Engine**. External providers are relegated to optional fallback plugins that are never required for core functionality, testing, or building.

---

## 2. INITIAL PRODUCT & DIRECT BASE ROUTE TOPOLOGY

While the internal execution graph remains generically extensible, the user-facing product is focused on solving **one primary route with uncompromising sovereignty and safety**:

$$\mathbf{BTC\ (Lightning)\ \longleftrightarrow\ Canonical\ USDC\ (Base\ L2)}$$

### Direct Base Route Architecture (Phase 4):
The initial route operates **directly on Base L2** via our generic immutable ERC-20 HTLC contract (`HtlcErc20.sol`):
```
CLIENT / AGENT
      │
      ├── generates S, shares only H = SHA256(S)
      ├── signs/submits EVM claim externally on Base
      ▼
UNIVERSAL ROUTER (AtomicCoordinator)
      │
      ├── [Leg 1] Real Bitcoin Lightning Hold Invoice (LND)
      │
      └── [Leg 2] Direct Base HTLC (Base Sepolia 84532 / Base Mainnet 8453)
              ↓
         Canonical Native Circle USDC
```

### Complete Decoupling of Bridges (CCTP) and DEXs:
1. **NO CCTP in Initial Route**: When operator inventory resides directly on Base, no cross-chain bridge is required in the atomic customer execution path. CCTP is strictly decoupled and reserved for asynchronous background treasury replenishment, never as a synchronous customer execution dependency.
2. **NO DEX in Initial Route**: Operator quotes the BTC/USDC exchange rate and settles directly against native Base USDC inventory. DEXs are not in the atomic critical path, eliminating slippage, sandwich attacks, and pool liquidity risks. Future DEX integrations remain isolated for treasury hedging.
3. **NO Arbitrum Pivot**: The customer atomic HTLC executes directly on Base L2.

---

## 3. SOVEREIGNTY & INDEPENDENCE PRINCIPLE

1. **Zero Hosted Vendor Dependency**: The Router core must build, test, boot, and run with **zero** hosted swap provider credentials (`FIXEDFLOAT_API_KEY`, `SATORA_API_KEY`, etc.).
2. **Protocol Over Vendor**: The Router directly coordinates base protocols (Bitcoin Lightning Network and Base EVM smart contracts) rather than delegating custody to third-party web services.
3. **Turnkey Survivability**: If all centralized swap companies shut down, the Universal Agent Asset Router remains fully operational.

---

## 4. PROTOCOL DEPENDENCY VS. VENDOR DEPENDENCY

| Dependency | Classification | Architectural Role | Redundancy Strategy |
| :--- | :--- | :--- | :--- |
| **Bitcoin / Lightning** | `EXTERNAL_PROTOCOL_INFRA` | Primary source value layer | Run local LND / CLN daemon |
| **Base L2** | `EXTERNAL_PROTOCOL_INFRA` | Direct atomic HTLC settlement layer | Multi-RPC node failover |
| **Atomic Coordinator** | `SELF_HOSTED_CORE` | Sovereign Router engine | Local SQLite + High Availability |
| **Circle CCTP** | `DECOUPLED_TREASURY_INFRA` | Background inventory replenishment | Async treasury operation only (not in client path) |
| **DEX (Uniswap/Aerodrome)** | `DECOUPLED_TREASURY_INFRA` | Background hedging / rebalancing | Async treasury operation only (not in client path) |
| **FixedFloat / Satora API** | `OPTIONAL_HOSTED_PROVIDER` | Optional secondary fallback plugin | Can be deleted without core impact |

---

## 5. CORE VS. OPTIONAL ADAPTERS

```
src/
├── domain/                  # Core immutable types, interfaces, errors
├── state-machine/           # Sovereign atomic state machine engine
├── persistence/             # SQLite storage, WAL, durable claims, journals
├── routing/                 # Sovereign planner (Lightning -> Base USDC)
├── evidence/                # Independent cryptographic and RPC verifiers
│
├── atomic/                  # OUR SOVEREIGN ATOMIC EXECUTION CORE
│   ├── coordinator/         # AtomicCoordinator (manages dual-leg swap lifecycle)
│   ├── lightning/           # ILightningAtomicBackend & Fake/LND implementations
│   ├── evm/                 # IEvmAtomicBackend & Contract callers
│   ├── liquidity/           # Operator inventory reservation abstraction
│   └── recovery/            # Crash reconciler and timeout sweepers
│
└── adapters/                # OPTIONAL PLUGINS (ISOLATED)
    └── external/            # Third-party vendor fallbacks (FixedFloat, etc.)
```

*The core runtime never imports from `adapters/external/` by default.*

---

## 6. TRUST BOUNDARIES

As defined in `SECURITY_MODEL_V1.md`:
1. **User / Agent Domain**: Untrusted. Supplies intents, public keys, and EIP-712 signatures.
2. **Router Core**: High integrity. Executes planning, persistence, and verification. Holds zero user keys.
3. **Atomic Coordinator**: Enforces mutual exclusivity of claim vs. refund. Binds both legs to identical hashlocks.
4. **Lightning Backend**: Manages LND hold invoices.
5. **EVM Backend & Relayer**: Submits smart contract calls (`HtlcErc20`).
6. **Smart Contracts**: Immutable on-chain enforcement (`contracts/HtlcErc20.sol`).

---

## 7. USER CUSTODY BOUNDARY (FROZEN)

* **SEC-1 & SEC-2**: Router NEVER stores user private keys or user seed phrases.
* **Client Autonomy**: The client generates the 32-byte secret $S$ and claims directly on Base. The Router acts as a non-custodial coordinator and gasless relayer.
* **Unilateral Recovery**: If the Router permanently shuts down while an execution is in-flight, the user can claim or refund directly on-chain using open-source recovery tools without Router cooperation.

---

## 8. OPERATOR KEY BOUNDARY

Operator keys are segregated by function:
1. **Lightning Node Macaroon**: Scoped exclusively to hold-invoice creation and settlement.
2. **EVM Relayer Key**: Holds micro-balances of ETH on Base for gas sponsorship. Cannot divert output tokens because the smart contract strictly transfers claimed tokens to the immutable `claimAddress`.
3. **Operator Inventory Key**: Holds and funds `HtlcErc20` counterparty collateral directly on Base with canonical native Circle USDC.

*Compromise of operator keys cannot lead to theft of user funds in flight.*

---

## 9. ATOMIC SWAP BOUNDARY

The customer execution plane operates directly on Base L2 with zero intermediary bridge dependencies:

```
[ CUSTOMER EXECUTION PLANE — ATOMIC SWAP BOUNDARY ]
Lightning BTC (Hold Invoice)  ───┐
                                 ├─► Canonical Native Circle USDC (Base L2 HtlcErc20)
Base USDC HTLC (HtlcErc20)    ───┘

[ ASYNCHRONOUS TREASURY PLANE — OPTIONAL BACKGROUND INFRASTRUCTURE ]
Circle CCTP / DEX Rebalancing ──► Non-customer-path inventory replenishment only
```

1. **Atomic Execution**: Lightning Hold Invoice and Base `HtlcErc20` share the exact same hashlock $H$. Atomic settlement occurs when the client reveals preimage $S$ to claim canonical USDC on Base.
2. **Treasury Decoupling**: Background inventory replenishment (e.g., CCTP across chains, DEX hedging) occurs strictly out-of-band on the treasury plane and is never a synchronous dependency of customer swaps. Zero CCTP or DEX calls exist in the customer critical path.

---

## 10. LIGHTNING ATOMIC BACKEND

Standardized interface `ILightningAtomicBackend`:
* `createHoldInvoice(hashLock, amountSats, cltvExpiry, memo)`: Generates a BOLT11 hold invoice.
* `observeHoldInvoice(paymentHash)`: Watches for incoming payments in state `ACCEPTED`.
* `settleHoldInvoice(preimage)`: Settles the hold payment once on-chain EVM claim is confirmed.
* `cancelHoldInvoice(paymentHash)`: Rejects the held payment if EVM funding fails or times out.

---

## 11. EVM ATOMIC BACKEND

Standardized interface `IEvmAtomicBackend`:
* `fundHtlc(params)`: Locks operator canonical USDC into `HtlcErc20` directly on Base (`0x3e4b1374d2a42ed3aca3470978fc4ec52914ae6f` on Base Sepolia / Base Mainnet).
* `observeHtlc(swapKey)`: Confirms on-chain event `HtlcFunded`.
* `claimHtlc(params)`: Executes or relays on-chain claim with preimage $S$ directly on Base.
* `extractAndVerifyClaimEvidence(params)`: Cryptographically verifies the on-chain claim receipt, preimage, and token transfer.
* `refundHtlc(swapKey)`: Reclaims operator collateral after timelock expiry.

---

## 12. ATOMIC COORDINATOR

The `AtomicCoordinator` enforces the dual-leg state transition:
1. Payer funds Lightning hold invoice $\rightarrow$ Status: `LIGHTNING_HELD`.
2. Coordinator funds Base `HtlcErc20` with canonical native USDC $\rightarrow$ Status: `EVM_FUNDED`.
3. Client broadcasts on-chain claim with preimage $S$ on Base $\rightarrow$ Status: `EVM_CLAIM_DETECTED` / `CLAIMING`.
4. Preimage and claim confirmed on Base $\rightarrow$ Status: `EVM_CLAIM_CONFIRMED`.
5. Coordinator settles Lightning hold invoice with revealed preimage $S$ $\rightarrow$ Status: `LIGHTNING_SETTLED`.
6. Finality verified and swap terminal $\rightarrow$ Status: `COMPLETED`.

---

## 13. HASH & PREIMAGE MODEL

* **Secret Preimage ($S$)**: 32-byte cryptographically secure random value generated by the client.
* **Hashlock ($H$)**: $H = \text{SHA-256}(S)$.
* **Symmetry**: Both the Lightning invoice and the Base `HtlcErc20` contract require the identical $H$.
* **Secrecy**: Preimage is NEVER stored in ordinary Router persistence; it is held in transient memory only during the claim settlement step.

---

## 14. EVIDENCE MODEL

State transitions require persistent, tamper-evident proof:
* `HoldInvoiceEvidence`: `payment_hash`, `bolt11`, `accepted_at`.
* `EvmFundingEvidence`: `tx_hash`, `block_number`, `swap_key`, `htlc_id`.
* `ClaimEvidence`: `preimage`, `claim_tx_hash`, `revealed_at`, `block_number`.
* `DestinationEvidence`: Base RPC transaction receipt + decoded `HtlcClaimed` / `Transfer` event verifying canonical USDC contract (`0x036CbD53842c5426634e7929541eC2318f3dCF7e` on Sepolia / `0x833589fCD6edb6E08f4c7c32D4f71b54bdA02913` on Mainnet), recipient address, and exact token amount.

---

## 15. STATE MACHINE (SOVEREIGN ATOMIC LIFECYCLE)

```
[PLAN_PREPARED]
       │
       ▼
[INVOICE_CREATED] ──(Timeout / Unfunded)──► [EXPIRED] (Terminal)
       │
       ▼
[LIGHTNING_HELD] ──(Funding Failure)──► [INVOICE_CANCELED] (Terminal - 0 Sats Lost)
       │
       ▼
[EVM_FUNDED] ──(Timelock Expiry / No Claim)──► [REFUND_ELIGIBLE] ──► [REFUNDED] (Terminal)
       │
       ▼
[CLAIMING]
       │
       ▼
[LIGHTNING_SETTLED]
       │
       ▼
[DESTINATION_PENDING]
       │
       ▼
[COMPLETED] (Terminal - Verified on Base)
```

*Transitions to ordinary `FAILED` are strictly forbidden once `LIGHTNING_HELD` or `EVM_FUNDED` is reached (SEC-9).*

---

## 16. DURABLE SIDE-EFFECT OWNERSHIP

* Every outbound action that moves or locks funds requires prior registration in `external_side_effect_journal`.
* Atomic CAS state updates guarantee that only one worker process can claim an action.
* Network timeouts create an `AMBIGUOUS_ACTION` state, prohibiting blind retries.

---

## 17. IDEMPOTENCY & CROSS-PROCESS SAFETY

* `idempotency_key` unique constraint in SQLite prevents duplicate swap creation.
* `execution_action_claims` table provides distributed locking across independent processes.
* Winning worker executes; losing worker awaits completion via reactive polling or SQLite change tracking.

---

## 18. CRASH RECOVERY

Upon process startup:
1. `ReconciliationAgent` loads all non-terminal executions.
2. For each execution, it queries external state (LND and EVM RPC).
3. If an action was in-flight, it reconciles the outcome.
4. Dangling executions are either safely progressed or escalated to `MANUAL_REVIEW`.

---

## 19. TIMELOCK SECURITY

* Timelocks on EVM contracts use on-chain block timestamps (SEC-21).
* Asymmetric expiration: EVM timelock (12h) is strictly shorter than Lightning invoice CLTV (24h).

---

## 20. CHAIN FINALITY & REORG MODEL

* Base L2 transactions are considered confirmed upon sequencer receipt + safe confirmation depth (`BaseNetworkGuard`).
* Transactions with receipt status `0` (Reverted) immediately block `COMPLETED` and trigger recovery.

---

## 21. RPC ABSTRACTION

* EVM interactions are abstracted through `IEvmAtomicBackend` / `IEvmRpcClient`.
* Allows seamless failover across multiple RPC providers (Alchemy, Infura, local node) without modifying financial logic.

---

## 22. LIQUIDITY ABSTRACTION

* `ILiquidityInventory` interface manages collateral reservations.
* Ensures that the Router never issues a hold invoice without first reserving the required canonical native USDC directly on Base.

---

## 23. TREASURY PLANE: ASYNCHRONOUS INVENTORY REPLENISHMENT & HEDGING (NON-CUSTOMER PATH)

* **Decoupled Architecture**: Circle CCTP and DEX operations belong strictly to the operator treasury plane. They are NOT part of the synchronous customer execution path.
* **Asynchronous Replenishment**: When operator Base USDC inventory requires replenishment, automated background treasury processes may bridge USDC via Circle CCTP (`TokenMessenger.depositForBurn`) or rebalance inventory.
* **Zero Customer Impact**: A customer swap never waits on CCTP attestations or DEX swap executions. The customer leg executes purely between Lightning and native Base USDC.

---

## 24. OPTIONAL HOSTED PROVIDER PLUGINS

* FixedFloat and future centralized providers are moved to `src/adapters/external/`.
* They are disabled by default and require explicit configuration to activate.
* Core unit tests and build steps run 100% offline without them.

---

## 25. SATORA OPEN-SOURCE REUSE POLICY

* We adapt MIT-licensed smart contracts (`HtlcErc20.sol`) and cryptographic verification patterns from `satoraHQ`.
* Full attribution and copyright notices are preserved in `THIRD_PARTY_NOTICES.md`.
* We do NOT depend on Satora's proprietary hosted API, nor do customer swaps require intermediate multi-hop coordinator contracts.

---

## 26. DEPENDENCY & SUPPLY-CHAIN POLICY

* Minimal runtime dependencies: strictly `zod`, native Node modules (`node:crypto`, `node:sqlite`, `node:test`).
* Zero unnecessary npm packages.
* Automated secret scanning in CI/CD via `python tests/scan-secrets.py`.

---

## 27. VERSIONING & MIGRATION STRATEGY

* Database tables include `schema_version` and `protocol_version`.
* In-flight executions remain pinned to their initial protocol version.
* Schema migrations must be non-destructive.

---

## 28. BACKUP & DISASTER RECOVERY PRINCIPLES

* SQLite database snapshots taken periodically via atomic `VACUUM INTO`.
* LND Static Channel Backups (SCB) synced to secure off-site storage.
* User funds in smart contracts are recoverable offline via `doomsday` without Router availability.

---

## 29. UPGRADE & ROLLBACK SAFETY

* Router performs schema and version checks on boot.
* Fails closed if database schema is newer than application binary.

---

## 30. MAINNET SAFETY CAPS

Runtime safeguards enforce strict caps:
* Maximum single swap: 50,000 satoshis (~$40 USD).
* Maximum aggregate pending value: 200,000 satoshis.
* Maximum daily volume: 1,000,000 satoshis.

---

## 31. SOVEREIGN DEVELOPMENT ROADMAP

1. **Phase 4A**: Base deployment identity and local/public testnet validation.
2. **Phase 4.0A**: Live Base Sepolia direct route proof (`DIRECT_BASE_USDC_ROUTE_REPORT.md`).
3. **Phase 5A / 5B**: Base transaction reliability and coordinator crash recovery.
4. **Phase 6**: Adversarial failure certification and stress resilience.
5. **Phase 7**: Production readiness and V1 Core freeze (`357c5ab85344a2fa5602a5e376efc7ea80685498`).

---

## 32. MAINNET SAFETY GATES

Strict gate checklist before any mainnet transaction:
- [x] Security model & invariants frozen (`SECURITY_MODEL_V1.md`).
- [x] Sovereign core architecture frozen (`ARCHITECTURE_V4_SOVEREIGN_CORE.md`).
- [ ] Docker regtest suite passing.
- [ ] Independent contract security audit.
- [ ] Explicit Owner approval.

---

## 33. EXPLICIT NON-GOALS

The Universal Agent Asset Router is **NOT**:
1. A centralized exchange or order-book marketplace.
2. A custodial user wallet or account balance service.
3. A multi-token trading platform.
4. A high-frequency routing engine.

*It is a focused, sovereign, security-first atomic bridge between Bitcoin Lightning and Base USDC.*

---

## 34. PHASE 2: SECURITY-FIRST LND REGTEST ATOMIC BACKEND SPECIFICATION

### 1. Pinned Software Stack
* **Bitcoin Core**: Version `v28.0.0` (Official Windows x64 release build, standalone binary, zero Docker requirement).
* **Lightning Network Daemon (LND)**: Version `v0.18.5-beta` (Official release build, standalone binary).

### 2. Isolated Regtest Environment Topology
All daemons run as lightweight, native Windows processes bound strictly to loopback (`127.0.0.1`) with dedicated, non-shared data directories in `./regtest-env/data/` (ignored by git).
```
+-----------------------------------------------------------------------+
|                       LOCAL REGTEST TESTBED                           |
|                                                                       |
|  +--------------------+     ZMQ/RPC     +--------------------------+  |
|  |   Bitcoin Core     |<----------------|   LND Node A (Router)    |  |
|  |   v28.0.0          |                 |   v0.18.5-beta           |  |
|  |   127.0.0.1:18443  |                 |   REST: 127.0.0.1:18080  |  |
|  |   P2P: 18444       |                 |   gRPC: 127.0.0.1:10009  |  |
|  +--------------------+                 |   P2P:  127.0.0.1:9735   |  |
|           ^                             +--------------------------+  |
|           |                                          ^                |
|           |                                          | Lightning      |
|           | ZMQ/RPC                                  | Channel        |
|           |                                          | (1M sats)      |
|           v                                          v                |
|  +--------------------+                 +--------------------------+  |
|  |   Bitcoin Core     |---------------->|   LND Node B (Payer)     |  |
|  |   Miner Wallet     |                 |   v0.18.5-beta           |  |
|  |   (101 blocks)     |                 |   REST: 127.0.0.1:18081  |  |
|  +--------------------+                 |   gRPC: 127.0.0.1:10010  |  |
|                                         |   P2P:  127.0.0.1:9736   |  |
|                                         +--------------------------+  |
+-----------------------------------------------------------------------+
```

### 3. Architecture & Separation of Concerns
* `src/atomic/lightning/lnd-types.ts`: Strictly encapsulates LND-specific protobuf and REST payloads. Zero LND protocol leakage into domain models.
* `src/atomic/lightning/lnd-client.ts`: Handles TLS certificate pinning (`tls.cert`), hex macaroon authentication (`invoices.macaroon` / `admin.macaroon`), base64 byte encoding/decoding, and the **P0 Network Safety Guard**.
* `src/atomic/lightning/lnd-backend.ts`: Implements the frozen `ILightningAtomicBackend` interface. Converts LND's invoice states (`OPEN`, `ACCEPTED`, `SETTLED`, `CANCELED`) to Router domain types.
* `src/atomic/lightning/fault-injector.ts`: Decorator providing deterministic, controllable fault injection (`DROP_RESPONSE`, `TIMEOUT`, `ERROR`) to prove ambiguity recovery.

### 4. Core Security Enforcements
1. **P0 Network Safety Guard**: On startup, `verifyNetworkSafety()` queries `/v1/getinfo`. If `chains[0].network !== 'regtest'`, the adapter halts immediately and throws a fatal `SecurityError`. Accidental connection to mainnet, testnet, or signet is strictly impossible.
2. **Ambiguity Reconciliation Without Blind Retries**: If an outbound mutation (`AddHoldInvoice`, `SettleInvoice`, `CancelInvoice`) encounters a network drop or socket timeout, the adapter queries LND by deterministic payment hash to reconcile actual on-node state before taking action.
3. **Dual-Leg Hashlock Identity**: Payment hash on Lightning equals the EVM HTLC hashlock byte-for-byte ($H = \text{SHA256}(S)$).
4. **Settlement Gate**: Preimage revelation on LND is strictly blocked unless the counter-leg EVM HTLC is verified as `FUNDED`.
5. **Mutual Exclusion**: For any given invoice, settlement and cancellation are strictly mutually exclusive.

---

## 35. PHASE 2.1 — LND SECURITY CLOSURE

**Status**: IMPLEMENTED AND VERIFIED  
**Test Suite**: `tests/lnd-security-closure.test.ts` (21 tests, 21/21 passing)

This section documents the three security boundaries closed before EVM HTLC implementation.

---

### A. Preimage Ownership & Handling Model

#### Who Owns the Preimage
The **client/user** generates and owns the preimage `S`. The Router never generates it.

#### Preimage Lifecycle (Honest Description)
1. Client generates `S`, computes `H = SHA256(S)`. Sends only `H` to Router.
2. Router calls `AddHoldInvoice(H)` — `S` absent.
3. Router funds EVM HTLC with `H` — `S` absent.
4. Client pays BOLT11 invoice — payment held.
5. Client calls `claimSwap(executionId, S)` — first and only time `S` enters Router memory.
6. Router wraps `S` in `AuthorizedSettlementPreimage`:
   - Validates 32-byte hex format.
   - Cryptographically verifies `SHA256(S) == H` before any state mutation.
   - `toJSON() => undefined` prevents accidental JSON serialization.
   - `toString() => '[REDACTED_AUTHORIZED_PREIMAGE]'` prevents log leakage.
7. Router calls `settleHoldInvoice(S.getRawHex())` — transient RPC-level parameter.
8. `S` goes out of scope, is never retained anywhere.

#### Accurate Invariant (Corrects Prior Inaccurate Claim)
> "Router may transiently process an authorized preimage at the settlement boundary (`claimSwap()`) solely to satisfy `SettleInvoice`. It never durably stores, logs, exposes, or generates it."

#### Residual Risk (Explicitly Documented)
> If the Router process is compromised at the exact moment the preimage transits `claimSwap()`, an attacker with memory-read access may extract it. No purely software mitigation can eliminate this. Mitigations: minimal lifetime, no persistence, no logging, type enforcement via `AuthorizedSettlementPreimage`.

#### Settlement Boundary Abstraction
The settlement boundary is explicitly defined as the `claimSwap()` → `LndLightningAtomicBackend.settleHoldInvoice()` call path. The `AuthorizedSettlementPreimage` class acts as the `PreimageAuthorizedSettlementPort`, preventing the raw preimage from spreading into generic domain objects.

---

### B. Binary Supply-Chain Verification & Trust Chain (Phase 2.2B Strict)

#### Policy
`OFFICIAL SIGNED RELEASE → OFFLINE TRUST ROOT VERIFY (STRICT OPENPGP QUORUM) → MANIFEST HASH → ARCHIVE HASH → EXTRACT → RUNTIME BINARY VERIFY` is strictly enforced. There is zero `--skip-verification` bypass, zero insecure OpenPGP options (`allowInsecureVerificationWithReformattedKeys` is banned), and zero runtime dynamic trust key downloads.

#### Hardened Quorum & Historical Trust Root Model
1. **Bitcoin Core v28.0.0**: Enforces **$\ge 6$ DISTINCT valid builder signatures** over `SHA256SUMS` evaluated strictly at signature creation time.
   - Authorized signers pinned in `TRUSTED_BINARY_MANIFEST` (9 builders verified from `bitcoin-core/guix.sigs:builder-keys/` with version-appropriate historical key material):
     - `theStack` (6A8F9C26...), `fanquake` (E777299F...), `achow101` (15281230... at 6c3eef4), `hebasto` (D1DBF2C4...), `m3dwards` (E86AE734...), `laanwj` (71A3B167...), `Emzy` (9EDAFF80...), `willcl-ark` (67AA5B46...), `sipa` (133EAC17...).
2. **LND v0.18.5-beta**: Enforces **$\ge 5$ DISTINCT valid maintainer signatures** over `manifest-v0.18.5-beta.txt` evaluated strictly at signature creation time (exact upstream requirement from `scripts/verify-install.sh:MIN_REQUIRED_SIGNATURES=5`).
   - Authorized signers pinned with version-appropriate historical key material: `guggero` (F4FC70F0...), `ellemouton` (26984CB6...), `roasbeef` (A5B61896... at cb0f0dd), `yyforyongyu` (E85497D2...), `ziggie1984` (5F75437E...).
3. **Anti-Sybil Deduplication**: Duplicate signatures from the same signer count only once.
4. **Signature-Time Validity**: All keys, subkeys, and binding signatures are verified strictly at authenticated signature creation time.
5. **Runtime Startup Gate**: `StartupVerifier.verifyTrustedBinarySet()` blocks process launch if `bitcoind.exe`, `lnd.exe`, or `lncli.exe` is missing or tampered.

#### Pinned Checksums (Source: Authenticated Release Manifests)
| Binary | SHA-256 | Source |
|:-------|:--------|:-------|
| `bitcoin-28.0-win64.zip` | `85282f4ec1bcb0cfe8db0f195e8e0f6fb77cfbe89242a81fff2bc2e9292f7acf` | Authenticated `SHA256SUMS` |
| `bitcoind.exe` | `43fd568770dc6060493949a222a0b556c2a417ebb8853d5c313ae3755107f935` | Derived from verified archive |
| `lnd-windows-amd64-v0.18.5-beta.zip` | `24b8b6ad91dd1487dfada1588e55de3d0b67af93e3b3cb1a2548c3fb56309b8e` | Authenticated manifest |
| `lnd.exe` | `18427850a024f58cde8d7b863d71a001bb243449d75d4c5ae32a618be52daed1` | Authenticated manifest |
| `lncli.exe` | `8f87436dbbc7d1e14c5b03e58f9f30a8ffe1cae7d40136a7765a1a5ae4cd6d7c` | Authenticated manifest |

---

### C. LND Macaroon Least-Privilege Model

#### Scoped Macaroon
A dedicated `router-least-privilege.macaroon` is baked with only the permissions required for Router operations:

```
Permissions: info:read, invoices:read, invoices:write
```

#### Forbidden Operations (Proven by Tests 18–21)
The scoped macaroon is denied by LND for:
- `POST /v1/transactions` (on-chain BTC send) — `permission denied`
- `POST /v1/channels` (open channel) — `permission denied`
- `DELETE /v1/channels/{...}` (close channel) — `permission denied`
- `POST /v1/signmessage` (admin sign) — `permission denied`

#### Stolen Macaroon Blast Radius
A stolen `router-least-privilege.macaroon` cannot send BTC, open/close channels, or drain the wallet. Maximum impact: invoice spam + potential active swap disruption (no preimage means cannot settle).

#### Adapter Status Clarification
The `src/atomic/lightning/` adapter is:
> **REAL LND PROTOCOL ADAPTER — REGTEST ENABLED ONLY**

It is NOT a production adapter. Mainnet enablement requires a fresh security review, fresh binary pins, and explicit owner re-authorization.

---

### Cumulative Test Coverage (After Phase 3)

| Suite | Tests | Status |
|:------|:------|:-------|
| Unit Tests (offline) | 155 | ✅ 155/155 |
| Phase 2 — Real LND Regtest Lifecycle | 42 | ✅ 42/42 |
| Phase 2.1 — LND Security Closure | 21 | ✅ 21/21 |
| Phase 3 — EVM HTLC Contract Security | 14 | ✅ 14/14 |
| Phase 3 — EVM Backend Security | 9 | ✅ 9/9 |
| Phase 3 — Real Cross-Rail Atomic Integration | 4 | ✅ 4/4 |
| **Total Automated Executions** | **245** | **✅ 245/245** |

---

## 36. PHASE 3: REAL LOCAL EVM HTLC BACKEND

### Architectural Overview
Phase 3 replaces the second simulated protocol boundary (`FakeEvmAtomicBackend`) with a real on-chain smart contract implementation (`RealLocalEvmAtomicBackend`) running against a deterministic local EVM development chain (`Hardhat node`, Chain ID 31337), leading to the Phase 4 Base Sepolia deployment (`0x3e4b1374d2a42ed3aca3470978fc4ec52914ae6f`).

### Smart Contract (`contracts/HtlcErc20.sol`)
- **Solidity Version**: `0.8.28` pinned with fixed settings (`optimizer: { enabled: true, runs: 200 }`).
- **P0 Hashlock Compatibility**: Uses EVM native `sha256(preimage)` matching Bitcoin Lightning's SHA-256 payment hash byte-for-byte.
- **Deterministic HTLC Identity**:
  $$\text{htlcId} = \text{keccak256}(\text{abi.encode}(\text{hashLock}, \text{amount}, \text{token}, \text{sender}, \text{claimAddress}, \text{refundAddress}, \text{timelock}, \text{chainid}))$$
- **Checks-Effects-Interactions**: Status updated before ERC-20 token transfers, preventing reentrancy.
- **Zero Admin Keys**: No owner, no upgradeability, no proxy pattern, no pause mechanism, no emergency drain function.
- **Pinned Bytecode SHA-256**: `10dc4b0c4864722e9770f035a0d64f2963d642bc165146bba4871a0e131a58cd` (legacy hex) / `8627fe35109888bbb58873f4e8f3beb90c7c0efee1411f81de9aa21a602e1d67` (canonical raw bytecode).

### Dual-Protocol Real Atomic Lifecycle
```
CLIENT                        COORDINATOR / BACKENDS                    SMART CONTRACTS / LND
  │                                     │                                         │
  │ 1. Generate Preimage S, Hash H      │                                         │
  │──── prepareSwap(H) ────────────────>│                                         │
  │                                     │── AddHoldInvoice(H) ───────────────────>│ [LND-A]
  │<─── Invoice Created (BOLT-11) ──────│                                         │
  │                                     │                                         │
  │ 2. Pay Invoice (Payer node)         │                                         │
  │──────────────────────────────────────────────────────────────────────────────>│ [LND-B -> LND-A]
  │                                     │<── Payment HELD (ACCEPTED) ─────────────│ (Locked)
  │                                     │                                         │
  │ 3. Fund EVM HTLC (T_evm = now + 12h)│
  │                                     │── fund(H, amount, client, refund, T) ──>│ [HtlcErc20.sol]
  │                                     │<── Mined + Event HtlcFunded ────────────│ (Locked)
  │                                     │                                         │
  │ 4. Claim EVM Tokens with S          │                                         │
  │──── claimSwap(S) ──────────────────>│── claim(htlcId, S) ────────────────────>│ [HtlcErc20.sol]
  │                                     │<── Tokens Transferred to Client ────────│ (CLAIMED)
  │                                     │                                         │
  │ 5. Settle Lightning with Revealed S │
  │── SettleInvoice(S) ────────────────────>│ [LND-A]
  │<── Invoice SETTLED ─────────────────────│ (SETTLED)
  │                                     │                                         │
  ▼                                     ▼                                         ▼
[BOTH PROTOCOLS TERMINATED ATOMICALLY WITH ZERO INTERMEDIARY CUSTODY]
```

### Asymmetric Timelock Policy
- EVM timelock ($T_{\text{EVM}} = 12\text{h}$) is strictly shorter than Lightning CLTV delta ($T_{\text{LN}} = 24\text{h}$).
- If client vanishes after EVM funding, operator refunds EVM tokens at $T_{\text{EVM}}$, then cancels the Lightning invoice before $T_{\text{LN}}$, ensuring neither party suffers unilateral capital loss.

### Network Guard Boundary
- Controlled development devnet (31337) in Phase 3; Phase 4 onwards exclusively guarded by `BaseNetworkGuard` on Base Sepolia (84532).
- Strict fail-closed checks reject Ethereum Mainnet (1), Arbitrum (42161), Base Mainnet mutations (8453 in test phases), or any unapproved network.
