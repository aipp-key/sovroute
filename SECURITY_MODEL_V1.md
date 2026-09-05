# SECURITY MODEL V1 — SOVEREIGN ATOMIC EXECUTION CORE
**SovRoute** (formerly Universal Agent Asset Router)  
**Document Version**: 1.0.0  
**Canonical Domain**: [https://sovroute.com](https://sovroute.com)  
**Status**: ACTIVE — MANDATORY SYSTEM-WIDE SOURCE OF TRUTH  
**Applies To**: Architecture V4+, Sovereign Atomic Core, SovRoute Engine  

---

## 1. THREAT MODEL

This threat model analyzes the 30 primary threat and failure sources across all operational boundaries of the Universal Agent Asset Router.

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                    ROUTER THREAT SURFACE                                        │
├───────────────────────────────┬───────────────────────────────┬─────────────────────────────────┤
│    CLIENT / IDENTITY DOMAIN   │     CORE COORDINATION DOMAIN  │   INFRASTRUCTURE / CHAINS DOMAIN│
├───────────────────────────────┼───────────────────────────────┼─────────────────────────────────┤
│ • Malicious external client   │ • Process crash / restart     │ • Lightning channel failure     │
│ • Compromised client / agent  │ • Concurrent worker race      │ • EVM chain reorg               │
│ • Replay / duplicate request  │ • Ambiguous outbound dispatch │ • Malicious RPC endpoint        │
│ • Secret / preimage leakage   │ • Database corruption         │ • Supply-chain package attack   │
│ • Stale quote exploitation    │ • Timelock clock skew         │ • Third-party vendor outage     │
└───────────────────────────────┴───────────────────────────────┴─────────────────────────────────┘
```

---

### Threat Matrix (30 Failure & Adversarial Modes)

#### T-01: Malicious External Client
* **Asset at Risk**: Operator liquidity, gas funds, compute resources.
* **Trust Boundary**: Client $\rightarrow$ Router Core API.
* **Attack / Failure Scenario**: Client floods Router with spoofed requests, invalid destination addresses, or malformed hashes to exhaust rate limits or reserve liquidity without intending to fund.
* **Possible Consequence**: Denial of service, locked operator inventory, wasted relayer gas.
* **Prevention**: Strict payload validation via Zod schemas, client rate limiting, bounded execution lifespans (TTL), maximum in-flight execution caps per client.
* **Detection**: Anomaly detection on reservation rates vs. actual hold invoice funding; persistent journal audit logs.
* **Recovery**: Expired executions transition cleanly to terminal `EXPIRED` without moving assets; reserved liquidity returned to pool.
* **Residual Risk**: Distributed low-rate reservation attacks within configured caps.

#### T-02: Compromised Client / Agent
* **Asset at Risk**: User’s private funds.
* **Trust Boundary**: Client-side execution environment.
* **Attack / Failure Scenario**: Malware on client device steals user's EVM private key or preimage.
* **Possible Consequence**: Attacker claims user's EVM HTLC or diverts destination address before Router invocation.
* **Prevention**: Client-side hardware isolation / enclave; Router enforces strict address pinning upon plan creation.
* **Detection**: Client-side monitoring.
* **Recovery**: If hashlock is compromised before funding, abort. If already funded, contract ensures only authorized `claiming_address` can claim.
* **Residual Risk**: Client-side endpoint security is outside Router's trust domain.

#### T-03: Compromised Router Process
* **Asset at Risk**: In-flight state, operator relayer keys, operator liquidity.
* **Trust Boundary**: Host OS $\rightarrow$ Router runtime.
* **Attack / Failure Scenario**: Process memory read or RCE allows attacker to access operator environment.
* **Possible Consequence**: Operator relayer ETH drained; database manipulated.
* **Prevention**: Zero user private keys stored in Router (SEC-1); relayer hot wallet capped with strict allowances; read-only root filesystem in containerization.
* **Detection**: Host IDS/EDR, process integrity attestation, database checksum verification.
* **Recovery**: Key revocation, failover to cold backup, contract pause if emergency role exists.
* **Residual Risk**: Operator hot liquidity in active memory is vulnerable to local root compromise.

#### T-04: Compromised Operator Key (Relayer / Hot Wallet)
* **Asset at Risk**: Operator ETH and floating counterparty liquidity (canonical native USDC on Base).
* **Trust Boundary**: Operator Secret Management $\rightarrow$ Blockchain Node.
* **Attack / Failure Scenario**: Attacker obtains operator's relayer private key.
* **Possible Consequence**: Attacker drains relayer gas balance; cannot steal user in-flight funds because contract output is pinned to user destination.
* **Prevention**: Relayer wallet maintains strictly capped minimal balance (`MAX_RELAYER_SPEND`); no withdrawal authority over user funds.
* **Detection**: RPC balance alerts on relayer wallet.
* **Recovery**: Rotate relayer key; update coordinator authorized caller.
* **Residual Risk**: Loss of funds limited to relayer gas balance.

#### T-05: Compromised Lightning Node
* **Asset at Risk**: Operator Lightning channel liquidity, held HTLCs.
* **Trust Boundary**: Operator Lightning Daemon (LND).
* **Attack / Failure Scenario**: Attacker breaches LND node admin RPC/macaroon.
* **Possible Consequence**: Attacker forces channel closure or steals operator routing liquidity; cannot claim held invoices without preimages.
* **Prevention**: Macaroon least-privilege scoping (only invoice and holdinvoice permissions); RPC TLS; network isolation.
* **Detection**: LND log monitors, peer disconnection alerts.
* **Recovery**: Restore node from SCB (Static Channel Backups); close compromised channels to cold on-chain storage.
* **Residual Risk**: Loss of active channel balance.

#### T-06: Compromised EVM Relayer
* **Asset at Risk**: Transaction submission queue, gas balance.
* **Trust Boundary**: Router $\rightarrow$ EVM Mempool.
* **Attack / Failure Scenario**: Relayer attempts to modify transaction data (recipient or amount) when submitting on-chain claim.
* **Possible Consequence**: Transaction reverts on-chain or claims to the pinned `claimAddress`.
* **Prevention**: Smart contract cryptographic enforcement: `HtlcErc20` strictly sends claimed tokens to the immutable `claimAddress` registered at creation.
* **Detection**: On-chain revert monitoring.
* **Recovery**: Re-dispatch via alternative uncompromised relayer.
* **Residual Risk**: Relayer can censor or delay submission, triggering timelock expiry.

#### T-07: Malicious Liquidity Counterparty
* **Asset at Risk**: Router execution throughput, user swap completion.
* **Trust Boundary**: Router $\rightarrow$ Liquidity Provider.
* **Attack / Failure Scenario**: Counterparty commits to quote but refuses to lock counter-asset on Base after user funds Lightning invoice.
* **Possible Consequence**: User's Lightning payment is stuck in `ACCEPTED` hold state until timeout.
* **Prevention**: Router will not settle Lightning hold invoice until counterparty HTLC is verified on-chain.
* **Detection**: In-flight timer expires before `HTLC_FUNDED` state is confirmed.
* **Recovery**: Lightning hold invoice is canceled; user pays 0 satoshis.
* **Residual Risk**: Opportunity cost and temporary satoshi lockup during invoice CLTV period.

#### T-08: Malicious or Compromised RPC Endpoint
* **Asset at Risk**: Verification accuracy, state machine integrity.
* **Trust Boundary**: Router Core $\rightarrow$ External Blockchain RPC.
* **Attack / Failure Scenario**: RPC lies about transaction receipt, logs, or block confirmations.
* **Possible Consequence**: Router falsely assumes EVM HTLC is funded, or falsely transitions to `COMPLETED`.
* **Prevention**: Multi-provider quorum or block-header/proof verification; mandatory event signature + parameter decoding verification (SEC-7, SEC-8).
* **Detection**: Cross-RPC diff checking; receipt status verification.
* **Recovery**: Revert to `RECOVERY_REQUIRED` / `MANUAL_REVIEW` if secondary verification fails.
* **Residual Risk**: Sybil attack across all configured RPC endpoints.

#### T-09: Compromised Third-Party Dependency (Supply Chain)
* **Asset at Risk**: Runtime integrity, environment secrets.
* **Trust Boundary**: npm / registry $\rightarrow$ Router build.
* **Attack / Failure Scenario**: Malicious update in a transitive dependency exfiltrates `.env` or injects backdoors.
* **Possible Consequence**: Secret leakage, altered transaction payloads.
* **Prevention**: Zero runtime dependencies outside minimal audited libraries (`zod`, native Node modules); lockfile pinning; `scan-secrets.py` CI enforcement.
* **Detection**: `npm audit`, static AST analysis, outbound network monitoring.
* **Recovery**: Pin last known good version; rebuild container image.
* **Residual Risk**: Zero-day malicious package in core runtime dependencies.

#### T-10: Database Corruption
* **Asset at Risk**: Persistence of in-flight executions, action ownership claims.
* **Trust Boundary**: SQLite database file on disk.
* **Attack / Failure Scenario**: Disk failure, power outage, or OS crash corrupts `.sqlite` file.
* **Possible Consequence**: Lost tracking of active swaps, inability to reconcile pending claims.
* **Prevention**: SQLite WAL mode (`PRAGMA journal_mode=WAL`), `PRAGMA synchronous=FULL`, periodic atomic backup (`VACUUM INTO`).
* **Detection**: SQLite `PRAGMA integrity_check` on boot; startup failure.
* **Recovery**: Restore from latest WAL snapshot; reconcile pending state directly from LND and EVM RPCs.
* **Residual Risk**: Data between snapshot and crash must be reconstructed from on-chain/LND logs.

#### T-11: Process Crash / Power Loss
* **Asset at Risk**: In-memory execution state.
* **Trust Boundary**: Node.js runtime process.
* **Attack / Failure Scenario**: Process terminates abruptly during HTTP call or immediately after database write.
* **Possible Consequence**: In-flight state lost from RAM; dangling states.
* **Prevention**: Durable SQLite journal before any outbound action (SEC-5); atomic state transitions.
* **Detection**: Startup reconciliation agent queries database for non-terminal states (`EXECUTING`, `HELD`, `CLAIMING`).
* **Recovery**: Reconciler checks external truth (LND + EVM) and resumes or safely terminates execution.
* **Residual Risk**: None; crash recovery is mathematically proven.

#### T-12: Complete Server Loss (Hardware Destruction)
* **Asset at Risk**: Router node availability.
* **Trust Boundary**: Physical/Virtual Machine Infrastructure.
* **Attack / Failure Scenario**: Hosting provider terminates instance or hardware fails irrecoverably.
* **Possible Consequence**: Router offline permanently.
* **Prevention**: Off-site encrypted database replication; non-custodial smart contract design ensures user can self-refund or self-claim without Router.
* **Detection**: External uptime monitoring.
* **Recovery**: User uses `doomsday` CLI or direct smart contract call with secret to claim or refund.
* **Residual Risk**: Downtime until secondary infrastructure is provisioned.

#### T-13: Network Partition (Split-Brain / LND Disconnection)
* **Asset at Risk**: Payment settlement atomicity.
* **Trust Boundary**: Router $\rightarrow$ LND / EVM Node.
* **Attack / Failure Scenario**: Router loses connection to LND while EVM transaction is confirming.
* **Possible Consequence**: Preimage revealed on EVM but Router cannot settle Lightning invoice before CLTV expires.
* **Prevention**: HTLC timelock on EVM is strictly shorter than Lightning invoice CLTV (e.g., EVM lock = 12h, Lightning CLTV = 24h).
* **Detection**: Socket timeout and health check failures.
* **Recovery**: Reconnect to LND and settle invoice before CLTV expires; or sweep on-chain.
* **Residual Risk**: Partition lasting longer than Lightning CLTV allows payer to cancel held payment after EVM claim.

#### T-14: Replay Attack (Duplicate Submissions)
* **Asset at Risk**: Operator funds, duplicate execution side effects.
* **Trust Boundary**: Client $\rightarrow$ Router $\rightarrow$ Blockchain.
* **Attack / Failure Scenario**: Malicious party re-submits previously signed EIP-712 payload or client request.
* **Possible Consequence**: Duplicate payouts or duplicate contract interactions.
* **Prevention**: `HTLCErc20` enforces single-use swap keys (`completed[key] = true`); coordinator enforces unique `callsHash`; Router enforces idempotency keys.
* **Detection**: Smart contract reverts with `AlreadyCompleted` / `DuplicateSwapKey`.
* **Recovery**: Router returns cached historical execution record without re-dispatch.
* **Residual Risk**: None.

#### T-15: Duplicate Inbound Client Request
* **Asset at Risk**: Idempotency state, order queue.
* **Trust Boundary**: External API $\rightarrow$ Router.
* **Attack / Failure Scenario**: Client network timeout triggers automatic client-side retry with same idempotency key.
* **Possible Consequence**: Creating two distinct orders for a single payment.
* **Prevention**: SQLite unique index on `idempotency_key`; atomic lookup-or-insert inside `BEGIN IMMEDIATE`.
* **Detection**: Database constraint violation handled gracefully.
* **Recovery**: Return identical existing execution record.
* **Residual Risk**: None.

#### T-16: Concurrent Workers (Multi-Process Race)
* **Asset at Risk**: Provider dispatch exclusivity, double-spending.
* **Trust Boundary**: Process 1 vs. Process 2 on shared database.
* **Attack / Failure Scenario**: Two instances attempt to fund or claim the same execution simultaneously.
* **Possible Consequence**: Double-funding an HTLC or redundant transaction submission.
* **Prevention**: Durable action claims table (`execution_action_claims`) with atomic CAS in `BEGIN IMMEDIATE`; losing worker definitively rejected (SEC-14).
* **Detection**: SQLite contention log; losing worker CAS returns `false`.
* **Recovery**: Losing worker awaits winning worker's completion or returns cached result.
* **Residual Risk**: None; proven by cross-process safety test suite.

#### T-17: Stale Quote / Market Movements
* **Asset at Risk**: Operator inventory value, user output amount.
* **Trust Boundary**: RoutePlanner $\rightarrow$ Execution.
* **Attack / Failure Scenario**: Market prices move significantly between quote generation and execution dispatch.
* **Possible Consequence**: Execution unprofitable or exceeds operator slippage tolerances.
* **Prevention**: Strict quote TTL (e.g., 60 seconds); Router enforces `quote.expires_at > Date.now()` at dispatch gate; operator inventory quoted with fixed rate bounds.
* **Detection**: `QUOTE_EXPIRED` domain error.
* **Recovery**: Safe abort before funding.
* **Residual Risk**: Sub-second price fluctuations within quoted spread.

#### T-18: Stale Liquidity Data
* **Asset at Risk**: Execution success rate.
* **Trust Boundary**: Liquidity Manager $\rightarrow$ Coordinator.
* **Attack / Failure Scenario**: Router accepts swap assuming counter-liquidity exists, but inventory was consumed by another execution.
* **Possible Consequence**: Swap stalls in pending state.
* **Prevention**: Atomic liquidity reservation prior to invoice generation.
* **Detection**: `INSUFFICIENT_LIQUIDITY` error at reservation step.
* **Recovery**: Request rejected cleanly before Lightning invoice creation.
* **Residual Risk**: None.

#### T-19: Blockchain Chain Reorganization (EVM Reorg)
* **Asset at Risk**: Financial settlement finality.
* **Trust Boundary**: EVM Node $\rightarrow$ Verifier.
* **Attack / Failure Scenario**: 1-block reorg orphans the EVM HTLC funding transaction after Router settles Lightning invoice.
* **Possible Consequence**: User pays Lightning but HTLC funding is reverted on EVM.
* **Prevention**: Minimum confirmation requirement before settling Lightning (e.g., Base L2 sequencing finality + safe confirmation depth).
* **Detection**: Re-checking transaction receipt at higher block height; receipt depth verification.
* **Recovery**: If reorged out, re-broadcast HTLC funding transaction with higher gas.
* **Residual Risk**: Deep reorgs (>64 blocks) on L1.

#### T-20: Contradictory External State
* **Asset at Risk**: State machine consensus.
* **Trust Boundary**: Lightning Node vs. EVM Node.
* **Attack / Failure Scenario**: Lightning node reports payment settled, but EVM contract reports HTLC refunded.
* **Possible Consequence**: Financial discrepancy / double spend.
* **Prevention**: Cryptographic timelock asymmetry makes concurrent claim and refund impossible (SEC-10).
* **Detection**: Reconciler detects conflicting evidence flags.
* **Recovery**: Immediate transition to `MANUAL_REVIEW`; automated processing halted for that execution.
* **Residual Risk**: Operator investigation required.

#### T-21: Fake Settlement Evidence Injection
* **Asset at Risk**: `COMPLETED` state accuracy.
* **Trust Boundary**: Inbound Webhook / External API $\rightarrow$ State Engine.
* **Attack / Failure Scenario**: Attacker sends fake transaction hash claiming payment complete.
* **Possible Consequence**: Premature `COMPLETED` transition.
* **Prevention**: Router NEVER trusts unverified inputs (SEC-7, SEC-24); Verifier directly queries independent RPC, decodes logs, and verifies recipient, amount, and token contract.
* **Detection**: RPC verification rejects fake hash with `DESTINATION_TX_NOT_FOUND`.
* **Recovery**: Execution remains in in-flight status or flags `MANUAL_REVIEW`.
* **Residual Risk**: None.

#### T-22: Secret / Preimage Leakage
* **Asset at Risk**: Swap security, atomic fairness.
* **Trust Boundary**: Router Memory $\rightarrow$ Logs / Disk / Wire.
* **Attack / Failure Scenario**: Preimage is printed to console logs, error dumps, or unencrypted storage before claim.
* **Possible Consequence**: Counterparty or eavesdropper captures preimage and claims funds prematurely.
* **Prevention**: Client generates and retains preimage; Router only receives public hashlock (SEC-11); central redaction on all logging.
* **Detection**: Automated secret scanners (`scan-secrets.py`) in CI/CD.
* **Recovery**: Rotate keys, audit logs.
* **Residual Risk**: Operating system memory dumping.

#### T-23: Accidental Operator Action
* **Asset at Risk**: System integrity, configuration state.
* **Trust Boundary**: Admin CLI $\rightarrow$ Production System.
* **Attack / Failure Scenario**: Operator accidentally deletes database or triggers manual refund on active swap.
* **Possible Consequence**: Broken state reconciliation.
* **Prevention**: CLI commands require explicit confirmation flags (`--force`, `--confirm`); production guardrails block dangerous queries.
* **Detection**: Audit journal of all operator actions.
* **Recovery**: Database PITR (point-in-time recovery).
* **Residual Risk**: Human error with root credentials.

#### T-24: Bad Database Migration
* **Asset at Risk**: Historical financial records.
* **Trust Boundary**: Code Upgrade $\rightarrow$ Database Schema.
* **Attack / Failure Scenario**: Migration script drops column or alters semantics of historical states.
* **Possible Consequence**: Loss of financial audit trail; corrupted active executions.
* **Prevention**: Append-only schema evolution; pre-migration validation; automated rollback test (SEC-18).
* **Detection**: Migration integrity verification on startup.
* **Recovery**: Rollback to pre-migration backup.
* **Residual Risk**: Schema downtime during migration.

#### T-25: Partial Deployment / Split State
* **Asset at Risk**: Cross-process consistency.
* **Trust Boundary**: Multi-node deployment.
* **Attack / Failure Scenario**: One node runs code v1 while another runs code v2 on same database.
* **Possible Consequence**: Inconsistent state machine transitions.
* **Prevention**: `schema_version` and `code_version` locks; binary checks version compatibility at boot.
* **Detection**: Startup version mismatch error.
* **Recovery**: Halt outdated node.
* **Residual Risk**: None.

#### T-26: Old Binary / New Schema Mismatch
* **Asset at Risk**: Application availability.
* **Trust Boundary**: Binary runtime $\rightarrow$ Database.
* **Attack / Failure Scenario**: Rolled-back binary attempts to read new schema columns.
* **Possible Consequence**: Crash on startup.
* **Prevention**: Backward-compatible migrations (expand-contract pattern).
* **Detection**: Fail-closed startup assertion.
* **Recovery**: Deploy compatible binary.
* **Residual Risk**: Operational delay.

#### T-27: External Dependency / Provider Disappearance
* **Asset at Risk**: Route availability.
* **Trust Boundary**: Router $\rightarrow$ External Hosted APIs.
* **Attack / Failure Scenario**: Third-party swap provider (e.g. FixedFloat, Satora hosted) goes offline or bans API key.
* **Possible Consequence**: Complete outage if core depends on provider.
* **Prevention**: Core must own its primary execution rail (Sovereign Core); zero hosted provider dependencies for core operations (SEC-15, SEC-16).
* **Detection**: Health check probes.
* **Recovery**: Route traffic through sovereign atomic rail.
* **Residual Risk**: None for core sovereign rail.

#### T-28: Lightning Channel Force-Close / Depletion
* **Asset at Risk**: Lightning inbound liquidity.
* **Trust Boundary**: Lightning Node $\rightarrow$ Lightning Gossip Network.
* **Attack / Failure Scenario**: Routing peers force-close channels or inbound liquidity exhausts.
* **Possible Consequence**: Payer cannot route hold invoice payment.
* **Prevention**: Multi-channel redundancy, automated rebalancing alarms, fee management.
* **Detection**: LND channel balance monitoring.
* **Recovery**: Open new channels, execute submarine splice.
* **Residual Risk**: Temporary routing failure for payers.

#### T-29: Timelock Expiry During Node Downtime
* **Asset at Risk**: Counter-asset ownership.
* **Trust Boundary**: Clock / Network Availability $\rightarrow$ Smart Contract.
* **Attack / Failure Scenario**: Router crashes for 24 hours while an HTLC is active.
* **Possible Consequence**: EVM timelock expires without claim, enabling counterparty refund.
* **Prevention**: EVM timelocks set with wide safety margins (e.g. 24h to 48h); watchdog process alerts on approaching expiry.
* **Detection**: Offline alert monitor.
* **Recovery**: Emergency sweeping script automatically checks all pending contracts upon reboot.
* **Residual Risk**: Downtime exceeding entire timelock window.

#### T-30: Timelock Clock Skew
* **Asset at Risk**: Refund validity.
* **Trust Boundary**: Local Server Clock vs. Blockchain Consensus Clock.
* **Attack / Failure Scenario**: Local system clock is fast by 1 hour, triggering local refund attempt before on-chain timelock expires.
* **Possible Consequence**: Transaction reverts on-chain; unnecessary gas spend.
* **Prevention**: Local clock NEVER determines refund eligibility; Router queries blockchain MTP (Median Time Past) or block timestamp directly (SEC-21).
* **Detection**: Clock drift monitor vs. NTP.
* **Recovery**: Wait until block timestamp exceeds timelock.
* **Residual Risk**: Miners manipulating block timestamp within standard consensus drift (+/- 15 seconds).

---

## 2. TRUST BOUNDARIES

```
[ USER / AGENT DOMAIN ] ──(Unsigned Intents, Signatures, Preimage)──► [ ROUTER CORE ]
                                                                             │
                         ┌───────────────────────────────────────────────────┼─────────────────────────────────┐
                         ▼                                                   ▼                                 ▼
              [ ATOMIC COORDINATOR ]                               [ OPERATOR LIQUIDITY ]            [ PERSISTENCE / DB ]
                         │                                                   │                                 │
        ┌────────────────┴────────────────┐                                  │ (Inventory Collateral)          │ (Durable Claims)
        ▼                                 ▼                                  ▼                                 ▼
[ LIGHTNING BACKEND ]             [ EVM ATOMIC BACKEND ]             [ EVM RELAYER ]                  [ AUDIT JOURNAL ]
   (LND / CLN)                    (Base / HtlcErc20)                 (Gas Sponsored)
```

1. **User / Agent Trust Domain**:
   * *In*: Quotes, deposit instructions (hold invoice).
   * *Out*: Public hashlock, claiming EVM address, preimage (at claim time).
   * *Trust*: Untrusted. Input must be validated.
   * *Secrets*: User private key, user seed. Router NEVER sees or stores them.

2. **Router Core**:
   * *In*: Client requests, node events.
   * *Out*: Orchestrated lifecycle commands, verified evidence.
   * *Trust*: High integrity. Does NOT hold user keys.
   * *Secrets*: None (operates on public identifiers and internal hashes).

3. **Atomic Coordinator**:
   * *In*: Execution plans, state transitions.
   * *Out*: Hashlock-bound actions to Lightning and EVM backends.
   * *Trust*: High integrity. Enforces atomic invariants.

4. **Lightning Backend**:
   * *In*: Create hold invoice, settle, cancel.
   * *Out*: Payment status (`ACCEPTED`, `SETTLED`, `CANCELED`).
   * *Trust*: Trusted node infrastructure.
   * *Secrets*: LND admin macaroon, channel keys.

5. **Operator Liquidity Domain**:
   * *In*: Reservation requests.
   * *Out*: Collateral commitments on Base.
   * *Trust*: Internal financial balance.
   * *Secrets*: Hot-wallet inventory keys.

6. **EVM Execution Backend**:
   * *In*: `HtlcErc20.fund`, `HtlcErc20.claim`, `HtlcErc20.refund`.
   * *Out*: Transaction receipts, event logs (`HtlcFunded`, `HtlcClaimed`, `HtlcRefunded`).
   * *Trust*: Requires cryptographic verification from RPC.

7. **EVM Relayer**:
   * *In*: Client on-chain claim dispatch.
   * *Out*: Broadcasted Ethereum/Base transaction.
   * *Trust*: Bounded trust. Smart contract enforces recipient binding to `claimAddress`.
   * *Secrets*: Relayer gas private key.

8. **Smart Contracts (`contracts/HtlcErc20.sol`)**:
   * *Trust*: Immutable, non-custodial, mathematically deterministic. No owner, no proxy, no pause.

9. **Treasury DEX & CCTP Infrastructure (Decoupled)**:
   * *Trust*: External protocol liquidity. Strictly out-of-band asynchronous inventory rebalancing; never in the customer atomic swap critical path.

10. **Database (SQLite)**:
    * *Trust*: Local durable truth. WAL mode with strict transaction serialization.

---

## 3. FROZEN SECURITY INVARIANTS

Every implementation phase must satisfy all 25 core security invariants:

* **SEC-1**: Router never stores user private keys.
* **SEC-2**: Router never stores user seed phrases.
* **SEC-3**: User recovery must not depend solely on Router availability (unilateral contract refund/claim via `doomsday` or direct EVM call is always possible).
* **SEC-4**: Operator key compromise should not permit theft of user-controlled funds where cryptographic design can prevent it.
* **SEC-5**: No financial side effect occurs without durable local action ownership recorded in SQLite prior to dispatch.
* **SEC-6**: Ambiguous financial side effects are never blindly retried.
* **SEC-7**: External service, node, or RPC responses are not financial truth by themselves.
* **SEC-8**: State `COMPLETED` strictly requires independently verifiable on-chain/cryptographic evidence.
* **SEC-9**: Once funds may have moved or become cryptographically committed, transition to ordinary `FAILED` is strictly prohibited.
* **SEC-10**: Claim and refund paths must be mutually exclusive.
* **SEC-11**: Secret-bearing material (preimages, private keys, seeds) must never appear in public API output, logs, telemetry, journals, exceptions, or debug output.
* **SEC-12**: Every financially meaningful action must be either locally idempotent or explicitly modeled as ambiguity-sensitive.
* **SEC-13**: Crash/restart must never turn uncertainty into permission to repeat a potentially fund-moving side effect.
* **SEC-14**: Two workers must never perform the same protected financial action concurrently (durable CAS claim enforced).
* **SEC-15**: Hosted vendor dependencies must remain replaceable behind interfaces.
* **SEC-16**: Core startup and core tests require zero hosted swap-provider credentials.
* **SEC-17**: Security-critical transitions must be durable, timestamped, and auditable in append-only storage.
* **SEC-18**: Database migrations must not silently reinterpret or corrupt historical financial state.
* **SEC-19**: Mocks/test providers must never become implicit production fallbacks.
* **SEC-20**: Mainnet capability must never activate merely because environment variables happen to exist.
* **SEC-21**: Timelock and refund eligibility must not rely on local wall-clock time alone; authoritative on-chain block time/MTP is required.
* **SEC-22**: Protocol and contract versions must be bound immutably to individual executions.
* **SEC-23**: A transaction hash alone is not sufficient proof of settlement (receipt status and decoded event parameters required).
* **SEC-24**: User input must never be treated as authoritative financial state.
* **SEC-25**: Old executions must retain the exact semantics and version they started with.

---

## 4. USER CUSTODY MODEL

* **Non-Custodial Invariant**: The Router is an execution graph engine and coordinator, **never a custodian**.
* **Key Boundaries**:
  * **Client / Agent**: Holds the EVM private key, generates the 32-byte secret $S$, computes the hashlock $H = \text{SHA256}(S)$, and signs EIP-712 claim digests.
  * **Router**: Only accepts and persists $H$, the public `claiming_address`, and the public EIP-712 signature. It receives $S$ only at the moment of claim execution to relay to the smart contract.

---

## 5. OPERATOR KEY INVENTORY

| Key Class | Purpose | Storage Location | Blast Radius if Compromised | Rotatable? |
| :--- | :--- | :--- | :--- | :--- |
| **LND Node Macaroon** | Hold-invoice creation & settlement | Encrypted vault / env | Lightning channel liquidity | Yes |
| **EVM Relayer Key** | Gas payment for on-chain Base claims | Encrypted vault / env | Relayer gas balance only (capped) | Yes |
| **Operator Liquidity Key** | Funding `HtlcErc20` on Base with canonical USDC | Hardware / Cold-hot split | Floating operator inventory on Base | Yes |
| **Database Encryption Key** | SQLite WAL encryption (future) | KMS / Host Keyring | Offline database read access | Yes |

*User funds in flight are NEVER exposed to theft if operator keys are compromised.*

---

## 6. SECRET STORAGE POLICY

1. **Strictly Prohibited in Persistence**: User private keys, user seed phrases, unencrypted operator master keys.
2. **Preimage Handling**:
   * In-flight preimages revealed during claim are handled in transient memory.
   * Once settled on-chain, preimages become public blockchain data and may be archived in claim evidence records.
3. **Environment Security**: No credentials printed to standard out. Centralized log scrubber strips hex keys, seeds, and bearer tokens.

---

## 7. BLAST-RADIUS MODEL (SERVER-SIDE CAPS)

Before any mainnet interaction, the Router enforces hard configurable caps (failing closed):
* `MAX_SINGLE_SWAP`: Maximum satoshis per individual execution (e.g. 50,000 sats).
* `MAX_TOTAL_PENDING_VALUE`: Maximum aggregate value of all in-flight swaps.
* `MAX_DAILY_VALUE`: 24-hour throughput ceiling.
* `MAX_CONCURRENT_EXECUTIONS`: Concurrency limiter.
* `MAX_OPERATOR_LIQUIDITY_EXPOSURE`: Cap on total operator capital locked in HTLCs.
* `MAX_RELAYER_SPEND`: Maximum ETH balance allowed in the relayer hot wallet.

---

## 8. EVIDENCE HIERARCHY

Financial transitions require evidence conforming to strict hierarchy:
1. **Cryptographic Proof**: $\text{SHA256}(S) == H$.
2. **On-Chain Event Logs**: Receipt status == `1` (Success) + decoded `HTLCErc20.Redeem` or `USDC.Transfer` with verified `from`, `to`, `value`, `contract`.
3. **Consensus Finality**: L2 confirmation + block depth.
4. *Zero weight given to HTTP response payloads or unverified hashes.*

---

## 9. FINANCIAL SIDE-EFFECT POLICY

* **Durable Intent Prior to Outbound Call**: The Router must write a journal entry to `external_side_effect_journal` before making any network call that moves or commits funds.
* **CAS State Locking**: The execution state must atomically transition from `PLAN_PREPARED` to `EXECUTING` via an atomic SQLite update.
* **No Unbounded Retries**: Network timeouts result in state `AMBIGUOUS_ACTION`, requiring explicit reconciliation before any further dispatch.

---

## 10. IDEMPOTENCY & CONCURRENCY POLICY

* **Client Idempotency**: Guaranteed via SQLite unique constraint on `idempotency_key`. Concurrent requests with identical keys are deduplicated into the existing record.
* **Cross-Process Arbitration**: Handled via `execution_action_claims` table (`execution_id` PRIMARY KEY).
* Winning process acquires claim; losing processes await completion or receive rejection.

---

## 11. CRASH / RESTART PHILOSOPHY

* Every startup invokes `ReconciliationAgent`.
* Non-terminal executions (`HELD`, `FUNDED`, `CLAIMING`) are inspected against external truth (LND and EVM RPC).
* If external state is verified, the execution resumes its state machine. If state is uncertain, it safely halts at `RECOVERY_REQUIRED` or `MANUAL_REVIEW`.

---

## 12. TIMELOCK SECURITY

* **Asymmetric Windows**:
  * Lightning Hold Invoice CLTV: $T_{\text{LN}} = 24\text{ hours}$.
  * EVM HTLC Timelock: $T_{\text{EVM}} = 12\text{ hours}$.
  * Ensures that if the client does not claim on EVM within 12 hours, the operator reclaims EVM collateral before the Lightning hold invoice cancels.
* **Clock Authority**: EVM block timestamp from trusted RPC, never `Date.now()`.

---

## 13. CHAIN FINALITY ASSUMPTIONS

* Base L2: Sequencer receipt + safe confirmation depth (`BaseNetworkGuard`).
* Bitcoin / Lightning: Channel HTLC commitment settled or held with valid route.

---

## 14. DEPENDENCY TRUST CLASSIFICATION

| Category | Dependency | Trust Level | Failure Mode |
| :--- | :--- | :--- | :--- |
| **External Protocol** | Bitcoin Network | Consensus truth | Reorg / Delay |
| **External Protocol** | Lightning Network | Protocol truth | Channel force-close |
| **External Protocol** | Base L2 | Consensus truth | Reorg / RPC downtime |
| **Decoupled Treasury** | Circle CCTP (Async) | Protocol bridge | Attestation delay (treasury only) |
| **Self-Hosted Core** | Router / Coordinator | Sovereign | Process crash |
| **Self-Hosted Core** | LND Daemon | Sovereign | DB lock / Peer disconnect |
| **Optional Vendor** | FixedFloat / External | Zero (Untrusted)| API ban / Maintenance |

---

## 15. SUPPLY-CHAIN SECURITY

* Minimal dependency footprint: `zod`, `@types/node`, `typescript`.
* Zero native binary npm packages.
* Deterministic CI scanner checks for hardcoded private keys or leaked credentials before test execution.

---

## 16. LOGGING & REDACTION POLICY

* Structured JSON logging only.
* Mandatory sanitizer masks all 32-byte hex strings matching private keys or preimages unless explicitly tagged as public hashlocks or transaction hashes.
* Full `.env` file contents are never read into logging context.

---

## 17. BACKUP & DISASTER RECOVERY PRINCIPLES

* **Database**: SQLite WAL files replicated via litestream or atomic `VACUUM INTO`.
* **LND**: Static Channel Backups (SCB) synced to external secure storage on every channel state update.
* **Cold Recovery**: If Router server is permanently destroyed, user claims or refunds directly from `HtlcErc20` contract on Base using standard open-source tools.

---

## 18. VERSIONING & MIGRATION SAFETY

* Executions persist `schema_version` and `protocol_version`.
* Active executions cannot be migrated across breaking protocol versions while in-flight.
* Schema migrations must be additive only (no destructive `DROP COLUMN` on active tables).

---

## 19. MAINNET SAFETY CAPS

* Strict runtime assertions verify environment matches `NODE_ENV === 'production'`.
* In local/test environments, safety caps are set to micro-values (100–1,000 sats).

---

## 20. MAINNET SECURITY GATES

No mainnet transaction may occur until:
1. Threat model and security invariants frozen (Complete in this document).
2. Local deterministic test suite passing 100%.
3. Regtest simulation with actual LND and Foundry contracts passes.
4. Independent security audit / peer review completed.
5. Owner explicit authorization received.

---

## 21. RESIDUAL RISKS

1. **L2 Sequencer Downtime**: Base sequencer outage delaying HTLC claim submission. Mitigated by wide timelock margins (12h on EVM vs. 24h on Lightning).
2. **Treasury Rebalancing Delays**: Background CCTP or exchange congestion delaying inventory replenishment. Mitigated by decoupled execution plane and pre-allocated inventory buffers.
3. **Liquidity Imbalance**: Asymmetric volume exhausting operator canonical Base USDC inventory. Mitigated by automated reservation caps and rate adjustments.

---

## 22. LND REGTEST / FUTURE LND PRODUCTION TRUST BOUNDARY

This section analyzes the 26 specific failure and adversarial threat modes governing the integration between the Router's Sovereign Atomic Coordinator and the Lightning Network Daemon (LND).

### LND Threat Analysis Matrix (26 Modes)

#### LT-01: Compromised LND Macaroon
* **Asset at Risk**: Router node channels, satoshis, hold invoices.
* **Trust Boundary**: File storage / Environment $\rightarrow$ LND REST/gRPC client.
* **Scenario**: An attacker obtains the macaroon file or hex token used by the Router.
* **Consequence**: Unauthorized invoice creation, malicious invoice cancellation, or channel manipulation.
* **Prevention**: Least-privilege baking (strictly `invoices:read` and `invoices:write`), file permissions 0600, dedicated service user, never commit or log macaroons.
* **Detection**: LND RPC access audit logs; monitoring for anomalous invoice requests.
* **Recovery**: Macaroon revocation by updating LND's `macaroon.key`; emergency channel force-close if root key exposed.
* **Residual Risk**: Zero-day OS-level file extraction during runtime.

#### LT-02: Compromised LND TLS Connection
* **Asset at Risk**: Traffic confidentiality, integrity of RPC commands.
* **Trust Boundary**: Router process $\rightarrow$ LND network interface (`localhost` or LAN).
* **Scenario**: Man-in-the-middle (MITM) intercepts unencrypted or unverified HTTP traffic.
* **Consequence**: Eavesdropping on payment hashes; tampering with invoice settlement parameters.
* **Prevention**: Mandatory TLS with explicit `tls.cert` pinning in the Router HTTPS agent. Rejection of unencrypted HTTP.
* **Detection**: TLS certificate fingerprint mismatch fails closed on connection handshake.
* **Recovery**: Terminate connection immediately; re-pin valid certificate.
* **Residual Risk**: Compromised host root certificate authority.

#### LT-03: Malicious or Corrupted LND Response
* **Asset at Risk**: Router state machine integrity, liquidity inventory.
* **Trust Boundary**: LND response $\rightarrow$ Router memory / persistence.
* **Scenario**: Faulty LND binary, memory corruption, or malicious RPC proxy returns spoofed state (e.g. reporting `SETTLED` when payment was canceled).
* **Consequence**: Router premature payout or incorrect counter-leg trigger.
* **Prevention**: Strict Zod schema parsing; independent validation of transaction hashes and state invariants.
* **Detection**: Mismatched evidence checks; cryptographic signature validation on on-chain legs.
* **Recovery**: Escalate to `MANUAL_REVIEW` if response violates protocol state machine.
* **Residual Risk**: Byzantine failure of the underlying node daemon.

#### LT-04: Router Crash After AddHoldInvoice Request Dispatch
* **Asset at Risk**: Database/Node state synchronization, action idempotency.
* **Trust Boundary**: Router process crash during outbound network flight.
* **Scenario**: Router issues `AddHoldInvoice` to LND, LND creates the invoice, but Router process terminates before receiving or persisting response.
* **Consequence**: Dangling invoice exists on LND without local `INVOICE_CREATED` confirmation.
* **Prevention**: Prior journal registration in `external_side_effect_journal`; deterministic payment hash derivation.
* **Detection**: Startup reconciler checks journal for `AMBIGUOUS_ACTION` entries.
* **Recovery**: Query LND with deterministic `paymentHash`. If found and matching, adopt invoice; if missing, evaluate safe re-dispatch.
* **Residual Risk**: Brief recovery delay during process restart.

#### LT-05: Router Crash After Invoice Creation But Before DB Persistence
* **Asset at Risk**: Execution record consistency.
* **Trust Boundary**: SQLite transaction boundary $\rightarrow$ Router crash.
* **Scenario**: LND returned success with `payment_request`, but process crashed before SQLite commit.
* **Consequence**: Local execution remains in `PREPARING` or pending state while LND invoice is live.
* **Prevention**: SQLite `BEGIN IMMEDIATE` transactions; journaled pending action claims.
* **Detection**: Startup reconciliation agent inspects unconfirmed pending claims.
* **Recovery**: Query LND by deterministic hash, recover authoritative `payment_request`, commit local DB record.
* **Residual Risk**: None; deterministic hash enables complete recovery.

#### LT-06: Router Crash After Payment HELD
* **Asset at Risk**: Payer locked satoshis, operator counter-collateral.
* **Trust Boundary**: LND channel HTLC $\rightarrow$ Router offline.
* **Scenario**: Payer funds invoice, LND enters `ACCEPTED` (HELD), but Router crashes before funding EVM counter-HTLC.
* **Consequence**: Satoshis remain locked across Lightning route; payer waits.
* **Prevention**: Durable persistence of incoming hold event; persistent channel HTLC survives LND restarts.
* **Detection**: On restart, query LND for invoices in `ACCEPTED` state.
* **Recovery**: Resume coordinator flow to fund EVM HTLC, or if timelock is near expiry, cancel hold invoice to return funds.
* **Residual Risk**: Upstream HTLC routing timeout if Router remains offline for hours.

#### LT-07: Router Crash During SettleInvoice
* **Asset at Risk**: Settlement certainty, satoshis owed to coordinator.
* **Trust Boundary**: Preimage dispatch $\rightarrow$ LND response.
* **Scenario**: Coordinator reveals preimage to LND via `SettleInvoice`, but crashes before writing `LIGHTNING_SETTLED` to DB.
* **Consequence**: Router DB shows `CLAIMING`, but LND may have settled satoshis.
* **Prevention**: Register `LIGHTNING_SETTLE` action claim in DB before RPC dispatch.
* **Detection**: Startup reconciler queries LND for invoice state.
* **Recovery**: If LND reports `SETTLED`, persist `settled_at` evidence and complete state transition.
* **Residual Risk**: None; preimage settlement on LND is idempotent and final.

#### LT-08: Router Crash During CancelInvoice
* **Asset at Risk**: Cancellation certainty, channel liquidity release.
* **Trust Boundary**: Cancel RPC $\rightarrow$ Router persistence.
* **Scenario**: Coordinator issues `CancelInvoice` to LND, crashes before persisting `INVOICE_CANCELED`.
* **Consequence**: Local DB shows `REFUND_ELIGIBLE`, but LND invoice state is uncertain.
* **Prevention**: Register `LIGHTNING_CANCEL` action claim before dispatch.
* **Detection**: Startup reconciler queries LND invoice status.
* **Recovery**: If LND reports `CANCELED`, transition DB state to `INVOICE_CANCELED` / `REFUNDED`.
* **Residual Risk**: None.

#### LT-09: Network Timeout After SettleInvoice Dispatch
* **Asset at Risk**: Settlement finality.
* **Trust Boundary**: Router $\rightarrow$ LND network socket timeout.
* **Scenario**: Socket drops during `SettleInvoice` call; Router catches `ETIMEDOUT`.
* **Consequence**: Unknown if preimage was accepted by LND. Blind retry could race or fail.
* **Prevention**: Mark action `AMBIGUOUS_SETTLE`; prohibit immediate blind retry (SEC-6).
* **Detection**: RPC error handler catches network disconnect on mutating call.
* **Recovery**: Perform read-only query `LookupInvoiceV2`. If `SETTLED`, complete; if still `ACCEPTED`, safely retry settle with identical preimage.
* **Residual Risk**: Delayed settlement notification to client.

#### LT-10: Network Timeout After CancelInvoice Dispatch
* **Asset at Risk**: Channel HTLC cancellation.
* **Trust Boundary**: Router $\rightarrow$ LND network socket timeout.
* **Scenario**: Socket drops during `CancelInvoice` call.
* **Consequence**: Unknown if invoice was canceled.
* **Prevention**: Mark action `AMBIGUOUS_CANCEL`; avoid blind retry.
* **Detection**: Catch timeout exception.
* **Recovery**: Query invoice status. If `CANCELED`, record cancellation evidence. If still `ACCEPTED`, re-verify timelock and retry cancel.
* **Residual Risk**: Payer HTLC refund delayed until reconnect.

#### LT-11: Duplicate AddHoldInvoice Attempts
* **Asset at Risk**: Node invoice registry pollution, duplicate orders.
* **Trust Boundary**: Orchestrator concurrency.
* **Scenario**: Multiple concurrent requests attempt to create an invoice for the same execution.
* **Consequence**: Redundant network calls; risk of divergent invoice parameters.
* **Prevention**: In-memory in-flight deduplication + SQLite `execution_action_claims` primary key constraint.
* **Detection**: Database unique constraint violation blocks duplicate worker.
* **Recovery**: Return existing in-flight or persisted hold invoice.
* **Residual Risk**: None.

#### LT-12: Duplicate SettleInvoice Attempts
* **Asset at Risk**: Redundant RPC load, race conditions.
* **Trust Boundary**: Multiple workers claiming settlement.
* **Scenario**: Worker A and Worker B both attempt to settle the same invoice.
* **Consequence**: Multiple settle calls to LND.
* **Prevention**: Single action ownership via CAS lock on `LIGHTNING_SETTLE`.
* **Detection**: Second worker receives claim rejection.
* **Recovery**: LND's `SettleInvoice` is idempotent for matching preimage; second caller gets success or no-op.
* **Residual Risk**: None.

#### LT-13: Duplicate CancelInvoice Attempts
* **Asset at Risk**: Redundant RPC load.
* **Trust Boundary**: Worker concurrency.
* **Scenario**: Concurrent cancellation sweeps for the same expired invoice.
* **Consequence**: Multiple cancel calls to LND.
* **Prevention**: CAS lock on `LIGHTNING_CANCEL` action claim.
* **Detection**: SQLite lock conflict blocks second worker.
* **Recovery**: LND's `CancelInvoice` is idempotent on already canceled invoices.
* **Residual Risk**: None.

#### LT-14: Two Router Workers Racing Same Invoice Action
* **Asset at Risk**: Database corruption, split-brain state.
* **Trust Boundary**: Multi-process / distributed Router workers.
* **Scenario**: Worker 1 tries to settle while Worker 2 tries to cancel after timeout.
* **Consequence**: Severe financial loss (double claim/refund).
* **Prevention**: `BEGIN IMMEDIATE` transactions on SQLite `execution_action_claims` table; state machine invariant SEC-10.
* **Detection**: Mutually exclusive state transition failure.
* **Recovery**: Winning worker completes its terminal branch; losing worker fails closed.
* **Residual Risk**: None under ACID SQLite persistence.

#### LT-15: LND Process Restart
* **Asset at Risk**: Transient subscription connections, in-flight RPCs.
* **Trust Boundary**: LND service availability.
* **Scenario**: LND daemon restarts while invoices are in `OPEN` or `ACCEPTED` states.
* **Consequence**: Active gRPC streams drop; RPC calls fail with `ECONNREFUSED`.
* **Prevention**: Router handles connection drops gracefully with exponential backoff on read queries. LND persists channel HTLCs to disk.
* **Detection**: Health check detects node unavailability.
* **Recovery**: Reconnect upon LND startup, re-synchronize invoice states from LND's on-disk database (`channel.db`).
* **Residual Risk**: Temporary execution latency while LND unlocks wallet and syncs graph.

#### LT-16: Router Restart
* **Asset at Risk**: In-memory queues and timers.
* **Trust Boundary**: Host reboot / process restart.
* **Scenario**: Router restarts during active execution lifecycle.
* **Consequence**: In-memory state lost.
* **Prevention**: Zero reliance on in-memory state; all lifecycles anchored in SQLite WAL.
* **Detection**: Boot sequence invokes `ReconciliationAgent`.
* **Recovery**: Read all non-terminal executions from SQLite, query LND, resume state machine.
* **Residual Risk**: None.

#### LT-17: Invoice Unexpectedly SETTLED
* **Asset at Risk**: Protocol correctness, accounting invariants.
* **Trust Boundary**: External node state $\rightarrow$ Coordinator logic.
* **Scenario**: LND reports an invoice is `SETTLED`, but Coordinator never revealed the preimage.
* **Consequence**: Unaccounted settlement (possible preimage leak or bypass).
* **Prevention**: Secret preimage generated solely by client; coordinator only reveals preimage when EVM condition is met.
* **Detection**: State machine detects `SETTLED` without prior `CLAIMING` state.
* **Recovery**: Immediate transition to `MANUAL_REVIEW`; freeze further actions on this execution.
* **Residual Risk**: Cryptographic compromise of preimage outside Router.

#### LT-18: Invoice Unexpectedly CANCELED
* **Asset at Risk**: Operator liquidity, execution viability.
* **Trust Boundary**: External node state $\rightarrow$ Coordinator logic.
* **Scenario**: Payer cancels or upstream peer drops HTLC, causing LND to report `CANCELED` while coordinator expected payment.
* **Consequence**: Swap cannot proceed.
* **Prevention**: Coordinator verifies state before funding EVM leg.
* **Detection**: Query shows state changed to `CANCELED`.
* **Recovery**: If EVM leg not funded: release reserved operator liquidity, transition execution to `INVOICE_CANCELED`. If EVM leg funded: claim EVM refund after timelock.
* **Residual Risk**: Griefing by payer canceling before EVM lock.

#### LT-19: Invoice Expires During Router Downtime
* **Asset at Risk**: In-flight state alignment.
* **Trust Boundary**: Wall clock / block height advancement while offline.
* **Scenario**: Router remains offline past invoice CLTV expiry.
* **Consequence**: Invoice becomes expired on LND; HTLC cancels back to payer.
* **Prevention**: Sufficiently wide CLTV expiry delta (144 blocks / 24 hours).
* **Detection**: Reconciler inspects invoice state upon startup; checks block height vs expiry.
* **Recovery**: Transition execution to `EXPIRED` or `REFUNDED`; release operator collateral.
* **Residual Risk**: Payer waited during downtime without swap execution.

#### LT-20: Wrong Preimage
* **Asset at Risk**: Operator claim validity, settlement security.
* **Trust Boundary**: Client input $\rightarrow$ Settle call.
* **Scenario**: Client submits a 32-byte secret that does not match the payment hash ($H \neq \text{SHA256}(S)$).
* **Consequence**: LND rejects settlement call with `invalid preimage`.
* **Prevention**: Coordinator locally verifies `sha256(preimage) === hashLock` before issuing RPC.
* **Detection**: Pre-flight assertion error in coordinator; LND RPC error if bypassed.
* **Recovery**: Reject client request; preserve `EVM_FUNDED` state; allow retry with correct preimage.
* **Residual Risk**: None.

#### LT-21: Wrong Payment Hash
* **Asset at Risk**: Dual-leg cryptographic binding.
* **Trust Boundary**: Client intent $\rightarrow$ Hold invoice creation.
* **Scenario**: Client passes mismatched hashlock between Lightning intent and EVM intent.
* **Consequence**: Cross-leg atomicity broken.
* **Prevention**: Single immutable `hashLock` field in `CreateAtomicSwapParams` bound to both legs.
* **Detection**: Verification test compares payment hash against EVM contract params.
* **Recovery**: Reject swap creation if hashlock format or binding is inconsistent.
* **Residual Risk**: None.

#### LT-22: Stale Invoice State
* **Asset at Risk**: State machine decisions based on outdated caches.
* **Trust Boundary**: Caching layer $\rightarrow$ Coordinator decision logic.
* **Scenario**: Coordinator relies on an in-memory cached state of an invoice that has since expired or settled.
* **Consequence**: Attempting to fund EVM HTLC for an expired invoice.
* **Prevention**: Critical state transitions require fresh, synchronous read queries to LND.
* **Detection**: LND returns error if action is invalid for current real state.
* **Recovery**: Re-synchronize state from authoritative LND response.
* **Residual Risk**: Minor latency overhead for synchronous checks.

#### LT-23: Mainnet / Regtest Configuration Confusion
* **Asset at Risk**: Real Bitcoin / mainnet funds.
* **Trust Boundary**: Operator deployment configuration.
* **Scenario**: Operator mistakenly points regtest test suite to a production mainnet LND node.
* **Consequence**: Accidental broadcast of test transactions on mainnet; loss of real funds.
* **Prevention**: **P0 Network Safety Guard** in `LndLightningAtomicBackend`. Queries `GET /v1/getinfo`. If `chains[0].network !== 'regtest'`, immediately throws fatal exception and halts.
* **Detection**: Startup network assertion fails immediately on first RPC call.
* **Recovery**: Process exits with code 1; no transactions sent.
* **Residual Risk**: None.

#### LT-24: Accidental Production Credential Loading
* **Asset at Risk**: Mainnet credentials, node authorization.
* **Trust Boundary**: Local test environment $\rightarrow$ filesystem secrets.
* **Scenario**: Automated tests read `~/.lnd/data/chain/bitcoin/mainnet/admin.macaroon`.
* **Consequence**: Production node exposed to local testbed.
* **Prevention**: Tests strictly construct isolated file paths inside `./regtest-env/data/`; `.env.example` requires zero production credentials; CI scanner enforces zero production secrets.
* **Detection**: CI secret scan; path assertions rejecting non-regtest paths.
* **Recovery**: Fail startup if path contains `mainnet`.
* **Residual Risk**: None.

#### LT-25: Insecure Exposed LND gRPC/REST Port
* **Asset at Risk**: Node access, remote exploitation.
* **Trust Boundary**: Local host $\rightarrow$ external network interface.
* **Scenario**: LND daemon binds to `0.0.0.0` without firewall or authentication.
* **Consequence**: External network attackers attempt to access LND endpoints.
* **Prevention**: LND configurations strictly bind to loopback (`127.0.0.1:10009`, `127.0.0.1:8080`); no router port-forwarding.
* **Detection**: Port audit; binding verification in bootstrap scripts.
* **Recovery**: Rebind to `127.0.0.1` and restart.
* **Residual Risk**: Compromised local host user.

#### LT-26: Excessive Macaroon Permissions
* **Asset at Risk**: Principle of least privilege.
* **Trust Boundary**: Router operator key inventory.
* **Scenario**: Router is configured with full `admin.macaroon` in production.
* **Consequence**: Compromise of Router enables full channel closure and fund drainage.
* **Prevention**: Bake dedicated `invoices.macaroon` containing only `invoices:read` and `invoices:write` permissions.
* **Detection**: Permission inspection on startup.
* **Recovery**: Revoke admin access; enforce restricted macaroon in configuration.
* **Residual Risk**: None.

---

### Frozen LND Security Invariants (LND-SEC-1 to LND-SEC-10)

* **LND-SEC-1 (Network Safety Guard)**: `LndLightningAtomicBackend` MUST query `/v1/getinfo` on startup and throw a fatal security error if `network !== 'regtest'`.
* **LND-SEC-2 (Cryptographic Hashlock Identity)**: The BOLT11 hold invoice payment hash must equal the EVM HTLC hashlock byte-for-byte ($H = \text{SHA256}(S)$).
* **LND-SEC-3 (Preimage Transient Boundary)**: The Router MAY transiently receive and process the preimage within the narrow settlement boundary (`claimSwap()`) solely to satisfy `SettleInvoice`. It MUST NOT durably persist, log, or expose it beyond this call path. The preimage MUST originate from the client at claim time.
* **LND-SEC-4 (Settlement Precondition Gate)**: `SettleInvoice` MUST NEVER be called unless the counter-leg HTLC is verified as `FUNDED` on-chain.
* **LND-SEC-5 (Mutual Exclusion of Settle vs Cancel)**: For any given invoice, settlement and cancellation are strictly mutually exclusive.
* **LND-SEC-6 (No Blind Retries on Mutations)**: Ambiguous outbound LND mutations (`AddHoldInvoice`, `SettleInvoice`, `CancelInvoice`) must NEVER be blindly retried; state must be reconciled first via deterministic hash lookup.
* **LND-SEC-7 (Authoritative State Truth)**: Streaming invoice updates are treated as performance optimizations; state reconciliation relies strictly on authoritative query verification.
* **LND-SEC-8 (Least-Privilege Macaroon)**: LND integration uses a dedicated scoped macaroon (`info:read`, `invoices:read`, `invoices:write`), never the unrestricted `admin.macaroon`. Scoped macaroon is baked and stored in `regtest-env/data/lnd-a/data/chain/bitcoin/regtest/router-least-privilege.macaroon`.
* **LND-SEC-9 (Secret Material Sanitization)**: Preimages, macaroons, and TLS private keys must never appear in logs, public API serializations, or test outputs.
* **LND-SEC-10 (Fail-Closed on Unknown State)**: If an LND response cannot be mapped to a known state machine transition, the execution halts safely at `MANUAL_REVIEW`.

---

## 23. PREIMAGE TRANSIENT-HANDLING MODEL

### Exact Preimage Flow (Honest Description)

The following is the complete, unambiguous lifecycle of the preimage in the current implementation:

1. **Client generates preimage**: The client (user/agent) creates a 32-byte random secret `S`. The Router never generates this secret.
2. **Client computes hashlock**: `H = SHA256(S)`. The client transmits only `H` to the Router during `prepareSwap()`. `S` is never transmitted at this stage.
3. **Router creates hold invoice**: `AddHoldInvoice(H)` is called with the hashlock. The preimage `S` is never present at this boundary.
4. **Client pays hold invoice**: The Lightning payment is routed and held in `ACCEPTED` state.
5. **Router funds EVM HTLC**: The EVM HTLC is funded using the same `H`. `S` is not present at this stage.
6. **Client submits preimage at claim time**: When the client calls `claimSwap(executionId, S)`, the preimage `S` enters the Router process in memory for the first time.
7. **Router wraps in `AuthorizedSettlementPreimage`**: The raw hex is immediately wrapped in the `AuthorizedSettlementPreimage` class, which:
   - Validates the 32-byte hex format.
   - Cryptographically verifies that `SHA256(S) == H` before proceeding.
   - Suppresses accidental serialization via `toJSON() => undefined`.
   - Redacts the value in `toString()`.
8. **Router calls `settleHoldInvoice(S.getRawHex())`**: The raw hex is forwarded to the LND REST API as a transient call parameter. This is the narrowest possible scope.
9. **Preimage is discarded**: After `settleHoldInvoice()` returns, `S` is not retained in any field of `SovereignExecutionRecord`, any SQLite table, any audit event, or any log line. The variable goes out of scope.

### What "Transient Handling" Means

The Router transiently processes the preimage within the lexical scope of `claimSwap()`. This is a deliberate and unavoidable boundary: the Router must call LND `SettleInvoice` which requires the preimage. There is no way to delegate this call to the client process.

**The Router does NOT:**
- Generate the preimage
- Store it in `SovereignExecutionRecord`
- Store it in SQLite journals, wallets, or action claims tables
- Include it in audit events or telemetry
- Log it via `console.log()` or structured logging
- Serialize it into exceptions or error messages
- Cache it between restarts

### Prior Inaccurate Claim Correction

The Phase 2 report previously stated:

> "Router never holds, handles, or persists preimages."

**Correction**: This claim is partially inaccurate. The accurate statement is:

> "Router may transiently process an authorized preimage at the settlement boundary (`claimSwap()`) when the client resubmits it, but never durably stores, logs, exposes, or generates it."

---

## 24. PREIMAGE RESIDUAL PROCESS-COMPROMISE RISK

| Risk | Description |
|:-----|:------------|
| **Process memory compromise** | If the Router process is compromised at the exact moment it transiently holds the preimage in memory within `claimSwap()`, an attacker with memory-read capability could extract the value. |
| **Asset at risk** | The held Lightning payment (satoshis) in the HTLC circuit. |
| **Scope** | Narrowed to the single call frame of `claimSwap()` only. |

### Mitigations

- **Minimal lifetime**: Preimage exists in memory only for the duration of one function call.
- **Minimal scope**: No spreading into records, errors, logs, or serialized forms.
- **No persistence**: Zero durability — no SQLite write, no file write.
- **No logging**: No `console.log`, no structured log event.
- **No telemetry**: Not emitted to any external observability system.
- **Type enforcement**: `AuthorizedSettlementPreimage` prevents accidental JSON serialization.
- **Format validation**: Rejected on construction if not a 32-byte hex value.
- **Hashlock verification**: Preimage is matched against the known hashlock before any RPC dispatch.

### Residual Risk Statement

> If the Router process is compromised by an attacker with memory-read capability at the exact moment the preimage transits through `claimSwap()`, the preimage may be exposed. This is an inherent consequence of the Router calling LND `SettleInvoice`. No purely software mitigation can eliminate this residual risk. The mitigations above minimize its probability and blast radius.

---

## 25. BINARY SUPPLY-CHAIN VERIFICATION POLICY & TRUST CHAIN (PHASE 2.2B)

### Strict OpenPGP Policy & Version-Frozen Historical Key Material

Under Phase 2.2B, the supply-chain verifier enforces strict OpenPGP cryptographic standards:
1. **Zero Insecure Overrides**: The verifier strictly rejects `allowInsecureVerificationWithReformattedKeys: true` or any equivalent setting that weakens standard key validity.
2. **Signature-Time Validity**: For every detached signature, validity is evaluated at the authenticated signature creation timestamp (`sig.packets[0].created`). Keys, subkeys, self-signatures, and subkey binding signatures must be valid and unexpired at the exact moment the release was signed.
3. **Version-Frozen Historical Key Roots**: Trust material is not sourced from mutable `master` branches:
   - **Roasbeef (LND)**: Frozen to release-era commit `cb0f0dd8a4f4373c075028473c32e8dbac41b147` (October 2024). A subsequent update on `master` created subkey binding signatures dated October 2025, which strict OpenPGP rightly rejects as future-dated when verifying a February 2025 release signature.
   - **Andrew Chow (Bitcoin Core)**: Frozen to release-era commit `6c3eef4bd9cd3731c33b17d8e0b96d3de84f8724` (August 2024).
4. **100% Offline Trust Roots**: All public keys are bundled locally in `src/supply-chain/keys/`. Runtime performs zero network calls to keyservers or GitHub for key retrieval or trust decisions.

### Complete Binary Trust Chain

```
OFFICIAL UPSTREAM RELEASE ARTIFACTS (Downloaded / Cached)
          ↓
OFFLINE BUNDLED TRUST ROOT (Immutable 40-Character Fingerprints + Frozen Keys)
          ↓
STRICT OPENPGP SIGNATURE-TIME VERIFICATION (Zero Insecure Overrides)
          ↓
DISTINCT SIGNER QUORUM ENFORCEMENT (>=6 distinct Bitcoin Core builders, >=5 distinct LND maintainers)
          ↓
AUTHENTICATED MANIFEST ARCHIVE HASH (SHA-256)
          ↓
DOWNLOADED ARCHIVE INTEGRITY VERIFICATION
          ↓
FAIL-CLOSED EXTRACTION (Archive unlinked immediately on mismatch)
          ↓
DERIVED / PINNED EXECUTABLE HASH (bitcoind.exe, lnd.exe, lncli.exe)
          ↓
STARTUP RUNTIME VERIFIER GATE (StartupVerifier.verifyTrustedBinarySet())
          ↓
PROCESS LAUNCH (bitcoind, LND-A, LND-B)
```

### Version-Bound Trust Root Specifications & Provenance

Public keys are bundled locally in `src/supply-chain/keys/` and verified against immutable fingerprints pinned in `TRUSTED_BINARY_MANIFEST`. Short 8/16-char IDs are strictly rejected; only full 40-character fingerprints are accepted.

#### 1. Bitcoin Core v28.0.0
- **Manifest**: `SHA256SUMS` (detached signatures in `SHA256SUMS.asc`)
- **Required Quorum**: $\ge 6$ DISTINCT verified builder signatures
- **Actual Strict Verified Signers**: 9 distinct builder signatures
- **Authorized Pinned Signers & Authoritative Provenance**:
  1. `6A8F9C266528E25AEB1D7731C2371D91CB716EA7` — Sebastian Falbesoner (`bitcoin-core/guix.sigs:builder-keys/theStack.gpg`)
  2. `E777299FC265DD04793070EB944D35F9AC3DB76A` — Michael Ford (`bitcoin-core/guix.sigs:builder-keys/fanquake.gpg`)
  3. `152812300785C96444D3334D17565732E08E5E41` — Andrew Chow (`bitcoin-core/guix.sigs:6c3eef4:builder-keys/achow101.gpg`)
  4. `D1DBF2C4B96F2DEBF4C16654410108112E7EA81F` — Hennadii Stepanov (`bitcoin-core/guix.sigs:builder-keys/hebasto.gpg`)
  5. `E86AE73439625BBEE306AAE6B66D427F873CB1A3` — Max Edwards (`bitcoin-core/guix.sigs:builder-keys/m3dwards.gpg`)
  6. `71A3B16735405025D447E8F274810B012346C9A6` — Wladimir J. van der Laan (`bitcoin-core/guix.sigs:builder-keys/laanwj.gpg`)
  7. `9EDAFF80E080659604F4A76B2EBB056FD847F8A7` — Emzy (`bitcoin-core/guix.sigs:builder-keys/Emzy.gpg`)
  8. `67AA5B46E7AF78053167FE343B8F814A784218F8` — Will Clark (`bitcoin-core/guix.sigs:builder-keys/willcl-ark.gpg`)
  9. `133EAC179436F14A5CF1B794860FEB804E669320` — Pieter Wuille (`bitcoin-core/guix.sigs:builder-keys/sipa.gpg`)

#### 2. LND v0.18.5-beta
- **Manifest**: `manifest-v0.18.5-beta.txt` (detached signatures in `manifest-<username>-v0.18.5-beta.sig`)
- **Required Quorum**: $\ge 5$ DISTINCT verified maintainer signatures (exact upstream requirement)
- **Actual Strict Verified Signers**: 5 distinct maintainer signatures
- **Authorized Pinned Signers & Authoritative Provenance**:
  1. `F4FC70F07310028424EFC20A8E4256593F177720` — Oliver Gugger (`lightningnetwork/lnd@v0.18.5-beta:scripts/verify-install.sh:KEYS[0]`)
  2. `26984CB69EB8C4A26196F7A4D7D916376026F177` — Elle Mouton (`lightningnetwork/lnd@v0.18.5-beta:scripts/verify-install.sh:KEYS[8]`)
  3. `A5B61896952D9FDA83BC054CDC42612E89237182` — Olaoluwa Osuntokun (`lightningnetwork/lnd:cb0f0dd:scripts/keys/roasbeef.asc`)
  4. `E85497D2DBA0EB9ADB0024279BCD95C4FF296868` — Yong Yu (`lightningnetwork/lnd@v0.18.5-beta:scripts/verify-install.sh:KEYS[12]`)
  5. `5F75437E11695F86D50C11BB1AFF9C4DCED6D666` — Ziggie (`lightningnetwork/lnd:scripts/verify-install.sh`)

### Verification Rules & Invariants

| Invariant | Description | Enforcement |
|:----------|:------------|:------------|
| **Strict Security Policy** | No insecure verification overrides permitted | Verified via static audit assertion and runtime tests |
| **Signature-Time Validity** | Validity evaluated at `sig.packets[0].created` | Passed to `openpgp.verify({ date: sigDate })` |
| **Quorum Threshold** | Required number of valid signatures must be met | Throws `SUPPLY_CHAIN_VERIFICATION_FAILED` if count < quorum |
| **Anti-Sybil Deduplication** | Duplicate signatures from same signer count only once | Set-based unique fingerprint counting |
| **Unauthorized Exclusion** | Cryptographically valid signatures from unknown signers do not count | Checked strictly against pinned `trustedSigners` array |
| **Tamper Detection** | Single-byte deviation on archive or executable fails closed | Corrupt archive deleted; tampered executable halts startup |
| **Startup Gate** | Pre-run hash verification for `bitcoind.exe`, `lnd.exe`, `lncli.exe` | Enforced before node spawn in `regtest-daemon.mjs` |

### Pinned Versions & Exact Hashes

| Binary | Component | Expected SHA-256 | Provenance Source |
|:-------|:----------|:-----------------|:------------------|
| `bitcoin-28.0-win64.zip` | Archive | `85282f4ec1bcb0cfe8db0f195e8e0f6fb77cfbe89242a81fff2bc2e9292f7acf` | Signed `SHA256SUMS` |
| `bitcoind.exe` | Binary | `43fd568770dc6060493949a222a0b556c2a417ebb8853d5c313ae3755107f935` | Derived from verified archive |
| `lnd-windows-amd64-v0.18.5-beta.zip` | Archive | `24b8b6ad91dd1487dfada1588e55de3d0b67af93e3b3cb1a2548c3fb56309b8e` | Signed manifest |
| `lnd.exe` | Binary | `18427850a024f58cde8d7b863d71a001bb243449d75d4c5ae32a618be52daed1` | Signed manifest |
| `lncli.exe` | Binary | `8f87436dbbc7d1e14c5b03e58f9f30a8ffe1cae7d40136a7765a1a5ae4cd6d7c` | Signed manifest |

---

## 26. LND MACAROON AUTHORITY MODEL

### Current Regtest Configuration

The Router holds a dedicated least-privilege macaroon baked at regtest bootstrap:

**Macaroon file**: `regtest-env/data/lnd-a/data/chain/bitcoin/regtest/router-least-privilege.macaroon`

**Baking command**:
```
lncli bakemacaroon info:read invoices:read invoices:write
```

### Authority Table

| RPC Operation | Required Permission | Granted? | Why Required |
|:--------------|:-------------------|:---------|:-------------|
| `GET /v1/getinfo` | `info:read` | ✅ Yes | P0 network safety guard: verifies `regtest` on startup |
| `POST /v2/invoices/hodl` | `invoices:write` | ✅ Yes | Create BOLT11 hold invoice |
| `GET /v1/invoice/{r_hash_str}` | `invoices:read` | ✅ Yes | Authoritative state lookup by payment hash |
| `POST /v2/invoices/settle` | `invoices:write` | ✅ Yes | Settle held invoice at preimage reveal |
| `POST /v2/invoices/cancel` | `invoices:write` | ✅ Yes | Cancel held invoice on timeout/refund |
| `POST /v1/transactions` | `onchain:write` | ❌ No | On-chain send — Router must not send BTC |
| `POST /v1/channels` | `channels:write` | ❌ No | Open channel — Router must not open channels |
| `DELETE /v1/channels/{...}` | `channels:write` | ❌ No | Close channel — Router must not close channels |
| `POST /v1/signmessage` | `message:write` | ❌ No | Signing — outside Router scope |
| Peer management | `peers:write` | ❌ No | Network admin — outside Router scope |
| Wallet management | `onchain:write` | ❌ No | Wallet control — Router must not control wallet |

### Stolen Macaroon Blast Radius

If the Router's least-privilege macaroon is stolen, an attacker can:

| Capability | Possible? | Notes |
|:-----------|:----------|:------|
| Read invoice list | ✅ Yes | Privacy risk but no asset theft |
| Create fake hold invoices | ✅ Yes | Spam risk only; no asset movement without paying them |
| Cancel open hold invoices | ✅ Yes | Could disrupt active swaps; see SEC-8 threat already analyzed in §22 |
| Settle invoices | ✅ Yes | Requires preimage; attacker without preimage cannot settle |
| Send on-chain BTC | ❌ No | `onchain:write` not granted |
| Open channels | ❌ No | `channels:write` not granted |
| Close channels | ❌ No | `channels:write` not granted |
| Drain wallet | ❌ No | No wallet or on-chain access |

**Verdict**: Blast radius of stolen macaroon is limited to invoice spam and potential active swap disruption. No BTC funds can be sent or wallet drained.

---

## 27. REGTEST VERSION-PIN POLICY

### Current Pin Status

The binary versions pinned in this repository are:

- Bitcoin Core `v28.0.0`
- LND `v0.18.5-beta`

### Policy

1. **These are regtest development compatibility pins only.** They are NOT automatically approved for mainnet production use.
2. **Version upgrades require explicit owner approval** and a fresh security review of changelogs for new attack surface.
3. **Mainnet enablement requires a fresh version/security review** of every component in the execution stack before any mainnet deployment.
- **No version auto-upgrade** will occur in CI or scripts unless explicitly committed and reviewed.
5. **Newer versions are not automatically preferred** unless an actual security vulnerability forces an upgrade.

### Mainnet Pre-Condition (Frozen)

No mainnet deployment may use these binary versions without:

1. A fresh security changelog review for both Bitcoin Core and LND.
2. Owner explicit re-approval of the pinned version for production.
3. Re-running the full security audit (Phases 2, 2.1, and any future phases) against the new binaries.

---

## 28. EVM HTLC SECURITY MODEL & 50-THREAT DELTA (PHASE 3)

### Core Security Invariants

- **EVM-SEC-1**: Each HTLC has a unique immutable identity derived deterministically via `keccak256(abi.encode(hashLock, amount, token, sender, claimAddress, refundAddress, timelock, chainid))`.
- **EVM-SEC-2**: The hashlock cannot be altered after creation.
- **EVM-SEC-3**: Claim recipient cannot silently change; tokens are unconditionally sent to `claimAddress`.
- **EVM-SEC-4**: Refund recipient cannot silently change; tokens are unconditionally sent to `refundAddress`.
- **EVM-SEC-5**: Amount cannot change after funding.
- **EVM-SEC-6**: Correct preimage is required for claim; contract enforces `sha256(preimage) == hashLock`.
- **EVM-SEC-7**: Incorrect preimage can never claim.
- **EVM-SEC-8**: Refund is impossible before timelock expiry (`block.timestamp >= timelock`).
- **EVM-SEC-9**: Claim and refund are strictly mutually exclusive (`LOCKED -> CLAIMED` or `LOCKED -> REFUNDED`).
- **EVM-SEC-10**: Claim cannot execute twice.
- **EVM-SEC-11**: Refund cannot execute twice.
- **EVM-SEC-12**: Terminal states prevent fund re-use.
- **EVM-SEC-13**: Events are evidence inputs, never the sole financial truth.
- **EVM-SEC-14**: Router verifies authoritative contract storage after receipt.
- **EVM-SEC-15**: Wrong chain or wrong contract fails closed (`EvmNetworkGuard.assertSafeLocalNetwork`).
- **EVM-SEC-16**: Contract and version identity are permanently bound to execution.
- **EVM-SEC-17**: Zero admin keys, zero owner, zero backdoor seizure powers.
- **EVM-SEC-18**: Zero upgrade mechanisms; immutable bytecode pinned by runtime SHA-256 hash.

### The 50 EVM HTLC Threat Vectors

1. **Wrong hashlock**: Operator locks funds with incorrect hashlock -> Client cannot claim -> Prevented by validating hashlock matches execution intent prior to contract submission.
2. **Wrong recipient**: Claim funds sent to unintended address -> Prevented by binding immutable `claimAddress` into deterministic `htlcId`.
3. **Wrong token**: Locking unauthorized or valueless tokens -> Prevented by verifying `tokenAddress` matches approved settlement asset.
4. **Wrong amount**: Under/overfunding HTLC -> Prevented by exact amount matching in `fund` parameter and contract storage verification.
5. **Wrong chain**: Interaction on unexpected network -> Prevented by `EvmNetworkGuard` refusing any chain ID other than approved devnet (31337).
6. **Wrong contract**: Interacting with malicious clone -> Prevented by pinning deployed address and runtime bytecode SHA-256 hash.
7. **Duplicate HTLC identifier**: Collision or replay -> Prevented by checking `htlcs[htlcId].status == EMPTY` on creation.
8. **Front-running**: Attacker sees preimage in mempool and front-runs claim -> Prevented by contract sending tokens unconditionally to `claimAddress` regardless of `msg.sender`.
9. **Replayed claim**: Submitting claim multiple times -> Prevented by transitioning to `CLAIMED` status before token transfer (Checks-Effects-Interactions).
10. **Replayed refund**: Submitting refund multiple times -> Prevented by transitioning to `REFUNDED` status before token transfer.
11. **Claim after refund**: Attempting claim after timelock expiry and refund -> Prevented by contract requiring `status == LOCKED`.
12. **Refund after claim**: Attempting refund after valid claim -> Prevented by contract requiring `status == LOCKED`.
13. **Premature refund**: Calling refund before timelock expiry -> Prevented by `require(block.timestamp >= htlc.timelock)`.
14. **Malicious preimage**: Submitting incorrect preimage -> Prevented by cryptographic `require(sha256(preimage) == htlc.hashLock)`.
15. **Malformed calldata**: Truncated or invalid ABI payload -> Prevented by Solidity calldata decoding checks and strict transaction simulation.
16. **Reentrancy**: Malicious token hijacking control flow -> Prevented by Checks-Effects-Interactions pattern (status changed before transfer).
17. **Token callback/reentrancy**: ERC-777 `tokensReceived` hooks -> Prevented by supporting only standard ERC-20 tokens with no callbacks.
18. **Fee-on-transfer tokens**: Received amount less than transferred -> Unsupported in Phase 3; standard mock token only.
19. **Non-standard ERC-20**: Missing bool returns -> Handled by `_safeTransfer` / `_safeTransferFrom` wrapper checking `data.length == 0 || abi.decode(data, (bool))`.
20. **Approval abuse**: Third party draining operator allowance -> Prevented by granting exact approvals per HTLC creation.
21. **Unlimited allowance**: Lingering infinite approvals -> Banned by policy; approvals match exact `amountUnits`.
22. **Coordinator compromise**: Attacker commandeers coordinator -> Contract is non-custodial; funds can only go to `claimAddress` or `refundAddress`.
23. **Relayer compromise**: Malicious relayer attempts to divert funds -> Contract enforces payout to hardcoded `claimAddress`.
24. **RPC lying/stale data**: Node returning outdated state -> Reconciled by authoritative contract storage queries and receipt confirmations.
25. **Transaction broadcast ambiguity**: Dropped RPC socket -> Handled by durable action records (`EVM_FUND_HTLC`); state inspected on-chain before re-attempting.
26. **Transaction dropped**: Tx dropped from mempool -> Monitored by timeout; reconciled from on-chain storage.
27. **Transaction replaced**: Gas speedup or cancellation -> Tracked by sender nonce and hashlock inspection.
28. **Chain reorg**: Shallow block reorganization -> Addressed by confirmation depth requirements before marking execution finalized.
29. **Receipt seen but not final**: Treating 0-conf as complete -> Core requires explicit confirmation threshold.
30. **Event/log mismatch**: False or spoofed log -> Storage state queried via `getHtlc` is the primary source of truth; logs are secondary.
31. **Contract bytecode mismatch**: Altered contract deployed at address -> Startup verifier asserts SHA-256 hash of deployed bytecode matches pinned constant.
32. **Wrong contract version**: Upgraded contract with altered semantics -> Execution binds immutable contract address and protocol version.
33. **Admin privilege compromise**: Backdoor keys stolen -> Zero admin functions or keys exist in `HtlcErc20.sol`.
34. **Upgradeability risk**: Implementation switched under active swaps -> Contract is non-upgradeable and deployed without proxies.
35. **Selfdestruct authority**: Contract destroyed by malicious caller -> Zero `selfdestruct` opcodes present.
36. **Timestamp manipulation**: Miner shifting block timestamps -> Bounded to seconds; timelocks configured in hours (12h/24h).
37. **Timelock boundary error**: Off-by-one second race -> Explicit comparison `block.timestamp >= timelock`.
38. **Integer overflow/underflow**: Arithmetic wrap -> Protected by Solidity 0.8.28 built-in checked arithmetic.
39. **Amount-decimal confusion**: Decimal mismatch between assets -> Standard integer base units enforced.
40. **Duplicate worker funding**: Concurrency race -> Protected by cross-process CAS action claim lock.
41. **Duplicate worker claim**: Concurrent claim dispatch -> Single action claim owner; on-chain replay protection.
42. **Duplicate worker refund**: Concurrent refund dispatch -> Single action claim owner; on-chain replay protection.
43. **Process crash during funding**: Crash after submit before receipt -> On reboot, checks contract storage using deterministic `htlcId`.
44. **Process crash during claim**: Crash after submit before evidence -> On reboot, checks contract storage confirming `CLAIMED`.
45. **Process crash during refund**: Crash after submit before evidence -> On reboot, checks contract storage confirming `REFUNDED`.
46. **DB write failure after tx**: Database failure after on-chain success -> Recovered from authoritative chain queries on restart.
47. **Client disappears**: Client abandons swap after EVM funding -> Operator refunds EVM tokens after 12h; cancels Lightning hold invoice.
48. **Router disappears**: Router halts after EVM funding -> Client claims directly on EVM; Lightning hold invoice expires safely.
49. **Operator disappears**: Operator fails to settle Lightning -> Client already received EVM tokens; Lightning hold invoice cancels on timeout.
50. **Contract dependency/license risk**: Upstream IP or license encumbrance -> Standalone minimal MIT-licensed implementation with explicit attribution in `THIRD_PARTY_NOTICES.md`.

### P0 SHA-256 Cryptographic Compatibility

In Bitcoin Lightning, hold invoices are keyed to:
$$H = \text{SHA-256}(S)$$

Solidity provides native `sha256(bytes)` which maps to the EVM SHA-256 precompile at address `0x02`.
`HtlcErc20.sol` explicitly computes:
```solidity
require(sha256(preimage) == htlc.hashLock, "INVALID_PREIMAGE");
```
This guarantees byte-for-byte cryptographic equivalence between the Lightning payment hash and the EVM hashlock.

### Preimage Revelation Order & Asymmetric Timelocks

To preserve atomicity and prevent unilateral fund loss:
1. **Client holds preimage $S$**.
2. **Lightning hold invoice funded first**: Satoshis locked in `ACCEPTED` state (Operator cannot claim without $S$).
3. **EVM HTLC funded second**: Operator locks EVM tokens with timelock $T_{\text{EVM}} = 12\text{ hours}$.
4. **Client claims EVM HTLC**: Client submits $S$ to EVM contract; tokens transfer to Client, revealing $S$ publicly on-chain.
5. **Operator settles Lightning invoice**: Operator extracts $S$ from EVM claim transaction/event and settles the Lightning invoice before $T_{\text{LN}} = 24\text{ hours}$.

**Timelock Invariant**:
$$T_{\text{EVM}} (12\text{h}) < T_{\text{LN}} (24\text{h})$$
If the client does not claim, the operator can safely refund EVM tokens at 12h, and cancel the Lightning invoice prior to its 24h expiration, ensuring zero funds are lost.

---

## 8. PUBLIC BASE L2 THREAT MODEL & OPERATIONAL RISKS (PHASE 4)

Moving from local devnet (Hardhat instant automining) to a public rollup (Base Sepolia Chain ID 84532 / future Base Mainnet Chain ID 8453) introduces distributed L2 operational and adversarial failure modes that must be handled fail-closed.

### 8.1 L2 Infrastructure & Network Threats

1. **Public RPC Lies / Staleness**: A public RPC node may return stale block numbers, outdated storage slot reads, or drop transactions silently.
   - *Mitigation*: Router never treats a single transient RPC read as final settlement authority. For mutating operations, state is verified via authoritative receipt status and storage reading with zero caching (`maxAge: 0`, `cacheTime: 0`).
2. **RPC Outage**: Network transport or provider rate limits render primary RPC unreachable.
   - *Mitigation*: Fails closed into `RECOVERY_REQUIRED` or `WAITING_FOR_CHAIN`. Durable action records prevent blind duplicate submissions upon reconnect.
3. **Base Sequencer Outage**: The OP Stack sequencer halts or enters maintenance, temporarily freezing transaction execution and block production.
   - *Mitigation*: Asymmetric timelock margin ($T_{\text{LN}} - T_{\text{EVM}} \ge 12\text{ hours}$) provides extensive buffer. If the sequencer halts while an EVM claim is in-flight, Router monitors LND CLTV safety deadline. If the deadline approaches buffer ($< 18\text{ blocks}$), Router halts new funding and escalates.
4. **Transaction Pending / Mempool Stalling**: Base gas spikes or network congestion leave transactions in the mempool without inclusion.
   - *Mitigation*: Transactions are tracked in the durable action journal. Router transitions to `WAITING_FOR_CHAIN` instead of blind retry. Gas escalator logic is deferred to Phase 4.1.
5. **Transaction Dropped**: Node evicts unmined transaction due to mempool pressure.
   - *Mitigation*: Nonce tracking and transaction receipt checks reconcile whether the transaction was actually dropped or mined on an alternate RPC.
6. **Transaction Replacement**: Replacing a pending transaction with higher gas could cause unexpected nonce jumps.
   - *Mitigation*: Autonomous replacement is disabled in Phase 4. All dispatches require single action ownership.
7. **Nonce Conflict**: Concurrent workers or stale nonce counters attempt to broadcast using the same nonce.
   - *Mitigation*: Durable action CAS ownership enforces that exactly one worker owns any financial dispatch key.
8. **Fee Volatility / EIP-1559 Spikes**: Base gas prices fluctuate rapidly due to L1 data availability (blobs/4844) or L2 execution surges.
   - *Mitigation*: Standard EIP-1559 transaction construction querying `estimateFeesPerGas` with bounded maximum fee caps.
9. **Confirmation / Reorg Behavior**: L2 soft-reorgs can occur if the sequencer reorganizes un-batched blocks prior to L1 submission.
   - *Mitigation*: Explicit confirmation depth policy (`FINAL_ENOUGH_FOR_PROTOCOL`) requiring $N \ge 1$ for testnet and stronger batch inclusion confirmation for mainnet.
10. **L2 Inclusion vs Stronger Finality**: Distinguishes between sequencer preconfirmation (instant inclusion) and Ethereum L1 batch finality (irreversible).
    - *Mitigation*: Lightning settlement gate demands confirmed on-chain evidence meeting or exceeding the chosen protocol finality threshold.

### 8.2 Token Identity & Contract Compatibility Threats

11. **Wrong Chain**: Attempting to transact against Ethereum Mainnet (1), Arbitrum (42161), or Base Mainnet (8453) in test mode.
    - *Mitigation*: `BaseNetworkGuard` strictly enforces `chainId === 84532` before every connection and mutation. Chain 8453 is explicitly rejected fail-closed.
12. **Wrong Token / Lookalike Contract**: Attacker or user passes a custom ERC-20 contract masquerading as USDC.
    - *Mitigation*: Token identity is pinned by exact checksummed contract address (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`), never by symbol or ticker string.
13. **Wrong USDC Variant**: Using an unsupported bridged token instead of canonical Native USDC.
    - *Mitigation*: Canonical native USDC address is pinned.
14. **USDbC Confusion**: Confounding legacy bridged "USD Base Coin" (`0xd9aAE...`) with canonical native Circle USDC (`0x83358...` on mainnet, `0x036Cb...` on testnet).
    - *Mitigation*: Hardcoded registry mapping `USDC_BASE` strictly to canonical native addresses.
15. **Token Proxy Upgrade**: Circle USDC utilizes a FiatTokenProxy (ERC-1967) where the implementation contract can be upgraded by Circle governance.
    - *Mitigation*: Our HTLC interacts with standard ERC-20 interfaces (`transfer`, `transferFrom`, `balanceOf`, `allowance`). The HTLC itself is non-upgradeable and immutable.
16. **Token Implementation Changes**: Upstream USDC updates could introduce new reverts or fee-on-transfer mechanics.
    - *Mitigation*: Exact test token compatibility tests verify zero fee-on-transfer, 6 decimals, and return boolean compliance.
17. **USDC Blacklist Behavior**: Circle maintains an on-chain blacklist role. If a sender or recipient is blacklisted, `transfer` / `transferFrom` reverts.
    - *Mitigation*: If client's `claimingAddress` is blacklisted by Circle, claim reverts; operator refunds tokens after timelock; Lightning invoice cancels safely.
18. **Paused Token Behavior**: Circle contract pause halts all token transfers.
    - *Mitigation*: Detected on funding attempt; fails gracefully before Lightning invoice is settled; Lightning invoice is canceled.
19. **Transfer Failure**: External token transfer returns false or reverts.
    - *Mitigation*: `HtlcErc20.sol` uses `_safeTransfer` and `_safeTransferFrom` which check return data and revert on non-success.
20. **Approval Failure**: `approve` call reverts or fails due to race condition.
    - *Mitigation*: Exact approval amount is queried before funding; allowance ambiguity is reconciled via `allowance()` queries.

### 8.3 Operational, Protocol, and Counterparty Threats

21. **Test Faucet Dependency**: Base Sepolia ETH and test USDC require faucet acquisition; faucet downtime or CAPTCHA blocks automation.
    - *Mitigation*: Disposable testnet wallet is decoupled from production keys; automated scripts detect zero balance and cleanly alert `TESTNET FUNDING REQUIRED`.
22. **Contract Deployment Ambiguity**: Network drop during `HtlcErc20` deployment leaves contract address uncertain.
    - *Mitigation*: Runtime bytecode verification (`assertContractBytecode`) must pass before backend permits operations.
23. **Public Mempool / Preconfirmation Behavior**: Mempool listeners observe claim transaction and extract preimage $S$.
    - *Mitigation*: Possessing $S$ does NOT authorize Lightning settlement. The Router requires confirmed on-chain contract state `CLAIMED` (Status 2) before settling Lightning.
24. **Malicious Client**: Client broadcasts invalid claim or attempts double-spending.
    - *Mitigation*: Contract enforces `Status.LOCKED` $\rightarrow$ `Status.CLAIMED` transition. Wrong preimage reverts. Front-runner cannot steal because payout recipient is immutable `claimAddress`.
25. **Malicious Operator**: Operator attempts premature refund or refuses settlement.
    - *Mitigation*: Contract enforces `timelock` expiry for refunds. If operator does not settle Lightning, client already received EVM tokens, and Lightning invoice automatically cancels on timeout.
26. **RPC Response Loss After Broadcast**: Outbound mutation sent, but HTTP connection resets before tx hash or receipt is returned.
    - *Mitigation*: Backend queries deterministic `htlcId` from contract storage to detect whether the HTLC was funded.
27. **Router Restart During Public Transaction**: Router process dies while transaction is pending.
    - *Mitigation*: Durable action journal entries recover on startup and reconcile state from consensus chain data.
28. **Client Disappears After EVM Funding**: Client goes offline and never submits claim.
    - *Mitigation*: EVM timelock expires at 12 hours. Operator refunds EVM tokens, then cancels the Lightning hold invoice (0 sats lost).
29. **Operator Disappears After Lightning HELD**: Router crashes before funding EVM HTLC.
    - *Mitigation*: Lightning hold invoice is never settled; client's payer payment cancels on invoice expiry.
30. **LND Expiry While Base Transaction Pending**: High L2 congestion delays funding transaction close to Lightning CLTV expiry.
    - *Mitigation*: Coordinator re-checks remaining Lightning CLTV blocks before broadcasting EVM funding and before settlement. If safety window is $< 18\text{ blocks}$, funding is aborted.

---

## 29. LIQUIDITY ACCOUNTING & DURABLE RESERVATION INVARIANTS (PHASE 7+)

### Core Invariants (LIQ-1 through LIQ-15)

* **LIQ-1 (Unit Separation)**: Satoshis are NEVER used to measure Base USDC inventory or HTLC funding amounts. Sats strictly measure Lightning invoice amounts, while USDC atomic units (6 decimals) strictly measure Base collateral amounts.
* **LIQ-2 (Currency-Safe Reservation)**: Operator Base USDC inventory is reserved using `expectedUsdcAmount` (atomic units), never `amountSats`.
* **LIQ-3 (Durable Reservation Ownership)**: Reservations are persisted durably in SQLite with unique reservation IDs before hold invoice creation or any outbound network call.
* **LIQ-4 (Strict Three-State Lifecycle)**: Every reservation transitions strictly through `RESERVED` -> `COMMITTED` (upon confirmed Base HTLC funding) or `RELEASED` (upon failure, expiry, or refund restoration).
* **LIQ-5 (Fail-Closed on Insufficient Inventory)**: If `availableOperatorBalance < expectedUsdcAmount`, the reservation request is rejected immediately, and the Lightning hold invoice is NEVER created.
* **LIQ-6 (Atomic Reservation CAS)**: Reservations execute inside SQLite `BEGIN IMMEDIATE` transactions to prevent concurrent workers from oversubscribing available inventory.
* **LIQ-7 (Definitive Failure Release)**: If hold invoice creation definitively fails (with verified confirmation that no remote invoice was created), the reservation is immediately and cleanly released back to available inventory.
* **LIQ-8 (Ambiguity-Safe Hold)**: If invoice creation or Base funding outcome is ambiguous or unverified, the reservation remains HELD in `RESERVED` status until reconciled; it is NEVER blindly released.
* **LIQ-9 (Committed on Funding)**: Successful on-chain Base HTLC funding commits the reservation to `COMMITTED` state, permanently tracking outbound inventory expenditure.
* **LIQ-10 (Crash Recovery Preservation)**: Node crash/restart reconstructs operator inventory balances and active reservations authoritatively from durable SQLite state.
* **LIQ-11 (No Double-Reservation)**: Restart during swap processing or duplicate idempotency requests return the existing reservation and never double-reserve operator funds.
* **LIQ-12 (Client Claim Spending)**: When a client claims the Base HTLC, the `COMMITTED` inventory is legitimately spent and is NEVER restored to available operator inventory.
* **LIQ-13 (Verified Refund Restoration)**: A verified on-chain Base refund restores operator inventory exactly once, with idempotent replay protection preventing double-crediting.
* **LIQ-14 (Unfunded Expiry Release)**: Swap expiration prior to Base HTLC funding safely releases the `RESERVED` inventory back to available balance.
* **LIQ-15 (Balance Conservation)**: At all times and across all operations, the conservation invariant holds strictly:
  $$\text{confirmedBalance} = \text{availableBalance} + \text{reservedBalance} + \text{committedBalance}$$

---

## 30. BASE USDC ON-CHAIN INVENTORY RECONCILIATION INVARIANTS (REC-1 THROUGH REC-20)

### On-Chain Reconciliation Security Invariants

* **REC-1 (Double-Counting Trap Elimination)**: Committed HTLC escrows ($C$) are debited from the operator wallet balance at the moment of onchain contract funding (`transferFrom`). Therefore, spendable headroom is $W_{\text{safe}} - R - P$, NEVER $W_{\text{safe}} - C - R - P$. Double-subtracting committed escrows from onchain wallet balance is an accounting defect and strictly prohibited.
* **REC-2 (Authoritative On-Chain Truth)**: `operator_inventory.confirmed_balance` and spendable headroom must be authoritatively anchored to observed Base on-chain USDC contract balance (`balanceOf`), never derived solely from unverified local ledger entries.
* **REC-3 (Fail-Closed Readiness States)**: Inventory readiness transitions deterministically through explicit states: `NOT_READY`, `RECONCILING`, `READY`, `DEFICIT`, `UNKNOWN`, `DEGRADED`. A router in any state other than `READY` must reject new swap obligations fail-closed.
* **REC-4 (Startup Reconciliation Gate)**: On process startup, Router initialization must block financial operations until a 5-phase on-chain reconciliation completes and transitions inventory to `READY`.
* **REC-5 (Preparation Gate Enforcement)**: `prepareSwap()` must verify inventory readiness is `READY` before generating a Lightning hold invoice or accepting counterparty commitments.
* **REC-6 (Chain & Token Integrity Verification)**: Reconciliation must strictly assert that the active RPC provider reports the configured Base chain ID (e.g., 84532 or 8453) and that the ERC-20 token contract matches the canonical native Circle USDC address.
* **REC-7 (Asymmetric Deposit Finality)**: Unfinalized inbound deposits cannot increase spendable headroom. Available wallet balance is bounded by $W_{\text{safe}} = \min(W_{\text{latest}}, W_{\text{finalized}})$.
* **REC-8 (Conservative Outflow & Reorg Handling)**: Any external withdrawal or chain reorganization that decreases $W_{\text{latest}}$ contracts spendable headroom immediately, without waiting for finalized block depth.
* **REC-9 (Active Reservation Single-Deduction)**: Active un-funded `RESERVED` obligations ($R$) are subtracted from spendable wallet balance exactly once.
* **REC-10 (Unresolved Funding Intent Deductions)**: Unresolved or in-flight funding intents ($P$) are treated conservatively as outstanding obligations and subtracted from spendable headroom exactly once until reconciled.
* **REC-11 (Committed Escrow Audit Tracking)**: Committed HTLC capital ($C$) is tracked for global auditability and balance reconciliation, but never double-deducted from spendable on-chain balance.
* **REC-12 (Verified Refund Restoration)**: An on-chain Base HTLC refund restores operator wallet capacity only upon verified onchain contract state/event confirmation, never by speculative local optimistic increments.
* **REC-13 (Client Claim Irreversibility)**: A client claim reveals the preimage and permanently transfers USDC to the counterparty; it never restores operator spendable inventory.
* **REC-14 (Durable Swap-HTLC Identity)**: The mapping between internal swap keys and on-chain `htlcId` is durably persisted in SQLite (`sovereign_swaps.htlc_id`) and rehydrated at startup; in-memory lookup maps are non-authoritative transient caches.
* **REC-15 (RPC Ambiguity as Non-Authorizing UNKNOWN)**: RPC timeouts, network disconnects, or malformed responses during balance observation transition inventory to `UNKNOWN` or `DEGRADED`, preventing new swap creation.
* **REC-16 (Idempotent Reconciliation)**: Repeated or concurrent executions of the reconciliation cycle produce deterministic state transitions and idempotent snapshot persistence.
* **REC-17 (Deficit Freezes New Obligations)**: When $W_{\text{safe}} < R + P$, the system enters `DEFICIT` state and refuses all new swap reservations until re-balanced.
* **REC-18 (Multi-Process Headroom Invariant)**: Total concurrent reservations across all worker processes cannot exceed chain-verified safe headroom.
* **REC-19 (Post-Broadcast Crash Safety)**: A crash occurring between transaction broadcast and local commit must reconcile on-chain contract state before retrying funding or releasing reservations.
* **REC-20 (Prohibition of Stale Local Authority)**: Stale SQLite snapshots exceeding the configured staleness threshold (`staleSnapshotToleranceMs`) cannot authorize new financial commitments without an updated onchain observation.


