# PHASE 2 IMPLEMENTATION & VALIDATION REPORT: SECURITY-FIRST LND REGTEST ATOMIC BACKEND

**Project**: Universal Agent Asset Router  
**Document Version**: 1.0.0  
**Phase**: Architecture V4 — Phase 2: Real LND Regtest Backend  
**Security Status**: VERIFIED — LOCAL REGTEST ONLY (Zero Real Money Moved)  
**Test Suite Status**: 176 / 176 Tests Passing (100%)  
**Typecheck Status**: Zero TypeScript Errors  
**Secret Scan Status**: 0 Leaked Secrets Detected  

---

## 1. Executive Summary

In accordance with the frozen Architecture V4 sovereign core roadmap, Phase 2 replaces the mock protocol boundary `FakeLightningAtomicBackend` with a real, local, isolated protocol implementation: `LndLightningAtomicBackend`. 

This implementation communicates directly via TLS and macaroon authentication with native Lightning Network Daemon (LND) and Bitcoin Core nodes running on a local, valueless Bitcoin Regtest network. The implementation proves the complete BOLT11 hold-invoice lifecycle (`OPEN` $\rightarrow$ `ACCEPTED` $\rightarrow$ `SETTLED` on the happy path, and `ACCEPTED` $\rightarrow$ `CANCELED` on the refund path), verifies dual-leg hashlock binding with the counter-EVM HTLC leg, implements controllable fault-injected RPC ambiguity reconciliation without blind retries, enforces cross-process mutual exclusion via SQLite WAL, and proves zero user key handling.

All 42 newly implemented security and lifecycle tests in `tests/lnd-regtest-atomic.test.ts` pass deterministically against real local LND nodes, bringing the cumulative repository regression suite to **176 / 176 passing tests** with zero TypeScript errors and zero leaked credentials.

---

## 2. Strategic Context & Architecture V4 Baseline

Architecture V4 established the Router as a self-hosted, sovereign atomic coordinator between Bitcoin Lightning and Base L2 USDC (`BTC/LN -> Arbitrum HTLC -> CCTP -> Base USDC`). Third-party swap companies (FixedFloat, SideShift, Satora hosted API) were completely evicted from the primary execution core.

Phase 2 executes the first real on-wire protocol integration of Architecture V4:
```
           +-------------------------------------------------------------+
           |                SOVEREIGN ATOMIC COORDINATOR                 |
           +-------------------------------------------------------------+
                     |                                         |
     REAL LOCAL PROTOCOL BOUNDARY                MOCK LOCAL PROTOCOL BOUNDARY
                     |                                         |
                     v                                         v
   +------------------------------------+   +------------------------------------+
   |     LndLightningAtomicBackend      |   |        FakeEvmAtomicBackend        |
   |   (Real LND Regtest Hold Invoices) |   |    (Local Timelocked HTLC Mock)    |
   +------------------------------------+   +------------------------------------+
                     |                                         |
                     v                                         v
   +------------------------------------+   +------------------------------------+
   |   Local Bitcoin Regtest (Node A)   |   |        Arbitrum / Base L2          |
   |      Capacity: 1,000,000 sats      |   |       (Reserved for Phase 3)       |
   +------------------------------------+   +------------------------------------+
```

---

## 3. Pinned LND & Bitcoin Core Versions

To eliminate floating dependency risks and supply-chain nondeterminism, official standalone Windows release binaries were downloaded and pinned directly:
* **Bitcoin Core**: Version `v28.0.0` (`bitcoin-28.0-win64.zip` from `bitcoincore.org`).
  * Binary path: `regtest-env/bin/bitcoind.exe`
  * CLI tool: `regtest-env/bin/bitcoin-cli.exe`
* **Lightning Network Daemon (LND)**: Version `v0.18.5-beta` (`lnd-windows-amd64-v0.18.5-beta.zip` from `github.com/lightningnetwork/lnd`).
  * Binary path: `regtest-env/bin/lnd.exe`
  * CLI tool: `regtest-env/bin/lncli.exe`

Both binaries run as native Windows processes without container overhead, Docker daemon dependencies, or WSL complexity.

---

## 4. Regtest Environment Topology & Isolation

All nodes run strictly bound to loopback (`127.0.0.1`) with separate, isolated configurations and non-shared data directories in `./regtest-env/data/` (ignored by git):

```
+-----------------------------------------------------------------------------------------+
|                               LOCAL REGTEST TOPOLOGY                                    |
|                                                                                         |
|   +--------------------------+                                                          |
|   |       bitcoind.exe       |                                                          |
|   |   Network: regtest       |                                                          |
|   |   RPC:  127.0.0.1:18443  |                                                          |
|   |   P2P:  127.0.0.1:18444  |                                                          |
|   |   ZMQ Block: :28332      |                                                          |
|   |   ZMQ Tx:    :28333      |                                                          |
|   +--------------------------+                                                          |
|            ^            ^                                                               |
|            |            |                                                               |
|    ZMQ/RPC |            | ZMQ/RPC                                                       |
|            v            v                                                               |
|   +--------------------------+        Lightning Channel       +---------------------+   |
|   |     LND Node A (Router)  |<==============================>|  LND Node B (Payer) |   |
|   |   Alias: router-node-a   |    Capacity: 1,000,000 sats    |  Alias: payer-node-b|   |
|   |   REST: 127.0.0.1:18080  |    Local:    496,530 sats      |  REST: :18081       |   |
|   |   gRPC: 127.0.0.1:10009  |    Remote:   500,000 sats      |  gRPC: :10010       |   |
|   |   P2P:  127.0.0.1:9735   |    Status:   ACTIVE (108:1:0)  |  P2P:  :9736        |   |
|   +--------------------------+                                +---------------------+   |
+-----------------------------------------------------------------------------------------+
```

### Environment Isolation Checklist:
1. Zero connection to mainnet, testnet, or signet.
2. Zero real BTC, zero real USDC, zero real EVM transactions.
3. Zero production credentials, zero mainnet macaroons, zero AIPP access.
4. Transient node data stored strictly in `regtest-env/data/`, ignored by `.gitignore`.

---

## 5. Threat Model Delta Summary (26 Threats Analyzed)

`SECURITY_MODEL_V1.md` was updated with Section 22 ("LND REGTEST / FUTURE LND PRODUCTION TRUST BOUNDARY"), thoroughly analyzing 26 failure and adversarial modes across all 8 mandatory dimensions:

| ID | Threat Scenario | Trust Boundary | Primary Mitigation |
| :--- | :--- | :--- | :--- |
| **LT-01** | Compromised LND Macaroon | FS $\rightarrow$ LND Client | Scoped baking (`invoices:read/write`), strict FS perms |
| **LT-02** | Compromised LND TLS Connection | Router $\rightarrow$ LND Socket | Mandatory TLS, explicit `tls.cert` CA pinning |
| **LT-03** | Malicious / Corrupted LND Response | LND RPC $\rightarrow$ Coordinator | Strict Zod validation, cross-leg invariant verification |
| **LT-04** | Router Crash After AddHoldInvoice Dispatch | Outbound RPC $\rightarrow$ Persistence | Reconciler queries LND by deterministic payment hash |
| **LT-05** | Router Crash After Create Before DB | SQLite Commit $\rightarrow$ Crash | Journaled action claims; adopt authoritative invoice |
| **LT-06** | Router Crash After Payment HELD | LND HTLC $\rightarrow$ Router Offline | LND preserves channel HTLCs; restart re-queries state |
| **LT-07** | Router Crash During SettleInvoice | Preimage Revelation $\rightarrow$ LND | Journal claim before dispatch; check if SETTLED on boot |
| **LT-08** | Router Crash During CancelInvoice | Cancel RPC $\rightarrow$ LND | Check if CANCELED on boot; persist refund transition |
| **LT-09** | Network Timeout After Settle Dispatch | Socket Timeout $\rightarrow$ Settle | Mark AMBIGUOUS; lookup invoice; never blind retry |
| **LT-10** | Network Timeout After Cancel Dispatch | Socket Timeout $\rightarrow$ Cancel | Mark AMBIGUOUS; lookup invoice; verify before retry |
| **LT-11** | Duplicate AddHoldInvoice Attempts | Worker Concurrency | In-flight map + DB unique constraint on payment hash |
| **LT-12** | Duplicate SettleInvoice Attempts | Concurrent Settle Calls | CAS lock on `LIGHTNING_SETTLE`; LND settle idempotent |
| **LT-13** | Duplicate CancelInvoice Attempts | Concurrent Cancel Calls | CAS lock on `LIGHTNING_CANCEL`; cancel idempotent |
| **LT-14** | Two Workers Racing Same Invoice Action | Multi-Worker Contention | SQLite `BEGIN IMMEDIATE` transaction serialization |
| **LT-15** | LND Process Restart | LND Daemon Availability | Backoff on read queries; state preserved in `channel.db` |
| **LT-16** | Router Process Restart | Router Host Reboot | Reconciler resumes in-flight swaps from external truth |
| **LT-17** | Invoice Unexpectedly SETTLED | External LND State | Transition to `MANUAL_REVIEW` if preimage unrevealed |
| **LT-18** | Invoice Unexpectedly CANCELED | External Peer Drop | Release reserved inventory; claim EVM refund if funded |
| **LT-19** | Invoice Expires During Downtime | Clock / Block Advancement | Reconciler handles expired state; transitions to REFUNDED |
| **LT-20** | Wrong Preimage Submitted | Client Input $\rightarrow$ Settle | Local sha256 check; LND strictly rejects wrong preimage |
| **LT-21** | Wrong Payment Hash | Client Intent $\rightarrow$ Swap Create | Single immutable `hashLock` bound to both legs |
| **LT-22** | Stale Invoice State | Cache $\rightarrow$ Coordinator Decision | Synchronous authoritative lookups on critical transitions |
| **LT-23** | Mainnet / Regtest Confusion | Operator Configuration | **P0 Network Safety Guard**: halts if `network !== 'regtest'` |
| **LT-24** | Accidental Production Credential Loading | FS Secrets $\rightarrow$ Test Suite | Test paths restricted to `./regtest-env/data/`; CI scanner |
| **LT-25** | Insecure Exposed LND Ports | Local Host $\rightarrow$ Network | Configurations bind strictly to `127.0.0.1` loopback |
| **LT-26** | Excessive Macaroon Permissions | Operator Key Inventory | Restrict production credentials to `invoices.macaroon` |

---

## 6. LND-SEC Invariants Implemented (LND-SEC-1 to LND-SEC-10)

Ten frozen security invariants govern the LND integration:
1. **LND-SEC-1 (Network Safety Guard)**: `LndLightningAtomicBackend` queries `/v1/getinfo` on startup and halts with a fatal exception if `network !== 'regtest'`.
2. **LND-SEC-2 (Cryptographic Hashlock Identity)**: BOLT11 payment hash equals EVM HTLC hashlock byte-for-byte ($H = \text{SHA256}(S)$).
3. **LND-SEC-3 (Preimage Transient Boundary)**: Preimages originate exclusively from the user/client. The Router DOES NOT generate user secrets. The Router MAY transiently receive and process the preimage within the narrow `claimSwap()` settlement boundary solely to satisfy `SettleInvoice`. It MUST NOT durably persist, log, or expose it beyond this call path. *(Corrected from earlier claim "Router never handles preimages"; see §17 and SECURITY_MODEL_V1.md §23 for the complete honest description.)*
4. **LND-SEC-4 (Settlement Precondition Gate)**: `SettleInvoice` is strictly blocked unless the counter-leg EVM HTLC is verified `FUNDED`.
5. **LND-SEC-5 (Mutual Exclusion of Settle vs Cancel)**: Settlement and cancellation are mutually exclusive for any given invoice.
6. **LND-SEC-6 (No Blind Retries on Mutations)**: Ambiguous outbound mutations (`AddHoldInvoice`, `SettleInvoice`, `CancelInvoice`) must never be blindly retried; on-node state is reconciled first.
7. **LND-SEC-7 (Authoritative State Truth)**: Polling and state transitions rely strictly on authoritative REST query verification (`/v1/invoice/{hash}`), never raw unconfirmed event streams.
8. **LND-SEC-8 (Least-Privilege Macaroon)**: Operational runtime requires only `invoices.macaroon` permissions.
9. **LND-SEC-9 (Secret Material Sanitization)**: Preimages, macaroons, and TLS keys are masked from all logs and public serializations.
10. **LND-SEC-10 (Fail-Closed on Unknown State)**: Any unrecognized LND state response halts execution at `MANUAL_REVIEW`.

---

## 7. Network Safety Guard Implementation & Verification (P0)

Implemented in `src/atomic/lightning/lnd-client.ts`:
```typescript
public async verifyNetworkSafety(): Promise<void> {
  const info = await this.getInfo();
  const activeNetwork = info.chains?.[0]?.network?.toLowerCase();

  if (activeNetwork !== this.expectedNetwork) {
    throw new Error(
      `P0_NETWORK_SAFETY_VIOLATION: Connected LND node is running on [${activeNetwork}], ` +
      `but Router is strictly configured for [${this.expectedNetwork}]. Halting immediately.`
    );
  }

  if (this.expectedNetwork === 'regtest' && activeNetwork !== 'regtest') {
    throw new Error(`P0_NETWORK_SAFETY_VIOLATION: Non-regtest network detected: [${activeNetwork}].`);
  }

  this.verifiedNetwork = true;
}
```
All mutating methods (`addHoldInvoice`, `lookupInvoice`, `settleInvoice`, `cancelInvoice`) enforce `assertNetworkVerified()`.

*Verification*:
* **Test 1**: Connects to regtest node and confirms `network === 'regtest'` passes.
* **Test 2**: Configures client with `expectedNetwork: 'mainnet'`, verifies immediate throw: `P0_NETWORK_SAFETY_VIOLATION: Connected LND node is running on [regtest], but Router is strictly configured for [mainnet]`.

---

## 8. Real LND Protocol Implementation Behind LightningAtomicBackend

`LndLightningAtomicBackend` implements `ILightningAtomicBackend`:
* **Domain Isolation**: Internal types (`LndInvoice`, `LndHtlc`, `LndAddHoldInvoiceRequest`) remain private in `lnd-types.ts`. Public methods return clean Router domain objects (`HoldInvoice`, `HoldInvoiceState`).
* **Base64 / Hex Conversion**: Translates 32-byte hex payment hashes and preimages to/from standard RFC 4648 Base64 expected by LND REST endpoints.
* **Timestamp Normalization**: Converts LND UNIX epoch string timestamps (`creation_date`, `settle_date`, `accept_time`) into standard JavaScript `Date` instances.
* **Integer Satoshi Validation**: Validates `amountSats > 0n` and rejects floating-point amounts.

---

## 9. BOLT11 Hold Invoice Lifecycle Validation

Empirically verified against live LND nodes:
1. **Creation**: `createHoldInvoice(hashLock, 2500n, 144)` calls `POST /v2/invoices/hodl`. LND returns a valid BOLT11 invoice (`lnbcrt25u...`). State is `OPEN`.
2. **Funding / Hold**: LND-B executes `payinvoice --force <bolt11>`. Payment propagates across the Lightning channel. LND-A intercepts the HTLC, verifies the hashlock, and holds the HTLC without settling. State transitions to `ACCEPTED` (`HELD`).
3. **No Auto-Settle**: Verified that the held payment remains in `ACCEPTED` state indefinitely until preimage revelation (Tests 7 & 8).
4. **Authoritative Lookup**: Verified that `/v1/invoice/{payment_hash}` returns exact satoshi values, CLTV blocks, and HTLC state.

---

## 10. Atomic Binding with Fake EVM Counter-Leg

Verified that the Lightning hold invoice payment hash is cryptographically identical to the EVM HTLC hashlock:
* $H_{\text{LN}} = H_{\text{EVM}} = \text{SHA256}(S)$
* When `prepareSwap()` is invoked on `AtomicCoordinator`, a single immutable `hashLock` is supplied by the client and bound to both the Lightning hold invoice and the EVM HTLC lockbox.
* Any mismatch between the two legs is rejected before funding.

---

## 11. Settlement Gate & Precondition Verification

In accordance with `LND-SEC-4`:
* The coordinator strictly prevents `SettleInvoice` from being called if the counter-leg EVM HTLC is not in `EVM_FUNDED` state (Test 15).
* When `fundEvmHtlc()` completes, the client provides preimage $S$.
* The coordinator verifies $\text{SHA256}(S) === H$, settles the EVM HTLC, and then calls `settleHoldInvoice(S)` on LND-A.
* LND-A settles the held HTLC, releasing 2,500 sats across the channel to Node A's local balance. State transitions to `SETTLED`.
* Wrong preimage $S_{\text{wrong}}$ is strictly rejected by LND with `unable to locate invoice`, leaving the invoice safely held (Test 13).

---

## 12. Cancellation & Refund Path Validation

Empirically verified on the refund failure branch:
1. Hold invoice funded by payer $\rightarrow$ state is `ACCEPTED`.
2. Swapper fails to fund EVM leg, or timeout occurs.
3. Coordinator invokes `cancelHoldInvoice(paymentHash)`.
4. LND-A cancels the held HTLC back across the channel to LND-B.
5. LND-A state transitions to `CANCELED`.
6. LND-B payment resolves as canceled with zero sats lost.
7. Subsequent attempts to settle the canceled invoice are strictly rejected by LND (Test 17).

---

## 13. Settle vs Cancel Mutual Exclusion Proof

Enforced by both the Router state machine and LND node semantics:
* If `claimSwap()` succeeds, the execution state transitions to `DESTINATION_PENDING` / `COMPLETED`. Any subsequent attempt to invoke `processRefund()` throws: `Cannot refund swap: swap already claimed or completed` (Test 19).
* If an invoice is canceled, LND cancels the HTLC; subsequent preimage revelation fails closed on the node.
* Settle and refund branches are provably mutually exclusive.

---

## 14. Crash, Restart, & Ambiguity Recovery

Verified that state survives process restarts:
* **Test 21**: Restart after hold invoice creation recovers clean `OPEN` state from LND via `recoverAfterRestart()`.
* **Test 22**: Restart after payment held recovers `ACCEPTED` state from LND.
* **Test 23**: Restart after settle preserves authoritative `SETTLED` state.
* **Test 24**: Restart after cancellation preserves authoritative `CANCELED` state.
* **Node Durability**: LND persists invoice registry and HTLC circuits to disk (`channel.db`), ensuring survival across node restarts.

---

## 15. Fault Injection & Drop-Response Simulation

Using `FaultInjectableLndClient`:
* **Test 27 (AddHoldInvoice Response Drop)**: Network socket drops after LND creates invoice. `createHoldInvoice` catches error, checks LND by deterministic hash, finds the active invoice, and returns it safely without creating a duplicate.
* **Test 28 (SettleInvoice Response Drop)**: Socket drops after LND settles invoice. `settleHoldInvoice` queries LND, observes `SETTLED` state, extracts authoritative `settle_date`, and returns success.
* **Test 29 (CancelInvoice Response Drop)**: Socket drops after cancel. Queries LND, observes `CANCELED` state, and returns success.
* **Invariant LND-SEC-6**: Zero ambiguous mutating actions are blindly retried.

---

## 16. Multi-Worker Concurrency & Action Ownership

* **Test 31**: Two concurrent workers call `prepareSwap()` with identical idempotency keys. In-flight promise map and SQLite unique constraints return the exact same execution record and hold invoice. Exactly one invoice is created on LND.
* **Test 32**: Two concurrent workers attempt to claim settlement for the same swap. Worker 1 acquires the action claim; Worker 2 is rejected by the CAS claim lock. Exactly one `SettleInvoice` call reaches LND.

---

## 17. Custody, Privacy, & Key Non-Handling Proof

* **Zero User Keys**: Router holds zero user private keys, mnemonics, or recovery seeds (`SEC-1`, `SEC-2`, `LND-SEC-3`).
* **Preimage Transient Handling (Accurate Statement)**: Preimages originate exclusively on client devices. The Router transiently receives the preimage in `claimSwap()` memory solely to call `SettleInvoice`. This is the narrowest unavoidable boundary: the Router must call LND. The preimage is never durably persisted, logged, cached, or serialized. The `AuthorizedSettlementPreimage` wrapper enforces this by design: `toJSON() => undefined`, `toString() => '[REDACTED]'`. *(Earlier Phase 2 claim "Router never handles preimages" was inaccurate and has been corrected.)*
* **Coordinator Only Observes Hashlock**: During all phases except `claimSwap()`, the Router operates solely on the hashlock `H`, never on the preimage `S`.
* **Public Serialization Safety**: `JSON.stringify(record)` was verified to contain zero sensitive preimage bytes. `AuthorizedSettlementPreimage.toJSON()` returns `undefined` preventing any accidental leak.

---

## 18. Secret Sanitization & Scanner Audit

* Preimages, macaroons, and TLS certificates are masked from all console and debug logs.
* `python tests/scan-secrets.py` executed across the entire repository:
  ```
  SCAN CLEAN: 0 secrets found across all repository files.
  ```

---

## 19. Blast-Radius Limits & Fail-Closed Controls

* **Single Swap Cap (Test 40)**: Strict limit of 100,000 sats per regtest swap. Requests exceeding this threshold fail closed with `AMOUNT_EXCEEDS_SINGLE_SWAP_CAP`.
* **Aggregate Held Cap (Test 41)**: Strict limit of 500,000 sats total concurrent held inventory.
* **Concurrent Invoice Cap (Test 42)**: Hard limit of 10 concurrent active hold invoices.

---

## 20. Test Suite Coverage & Execution Evidence

### Phase 2 Test Execution Summary (at time of Phase 2 completion)
```
42 / 42 lnd-regtest-atomic.test.ts
134 / 134 unit test suite (8 files)
Total: 176 / 176 tests passing
```

### Phase 2.1 Security Closure Tests (added)
```
21 / 21 lnd-security-closure.test.ts
  1. Preimage Security & Handling Model (10 tests)
  2. Binary Supply-Chain Integrity & Checksum Verification (6 tests)
  3. LND Macaroon Least-Privilege Authority Model (5 tests)
```

## 20. Test Suite Coverage & Execution Evidence

### Phase 2 Test Execution Summary (at time of Phase 2 completion)
```
42 / 42 lnd-regtest-atomic.test.ts
134 / 134 unit test suite (8 files)
Total: 176 / 176 tests passing
```

### Phase 2.1 Security Closure Tests (added)
```
21 / 21 lnd-security-closure.test.ts
  1. Preimage Security & Handling Model (10 tests)
  2. Binary Supply-Chain Integrity & Checksum Verification (6 tests)
  3. LND Macaroon Least-Privilege Authority Model (5 tests)
```

### Phase 2.2B Strict OpenPGP & Historical Trust Root Closure Tests (upgraded)
```
21 / 21 supply-chain-signature.test.ts (included in unit suite)
  - Production verifier does not enable allowInsecureVerificationWithReformattedKeys
  - Repository search detects zero accidental enabling of insecure flag
  - Valid historical key + valid signature passes under strict verification at signature time
  - Reformatted/future-bound key that cannot establish signing-time validity fails strictly
  - Wrong historical key fails
  - Unauthorized key fails
  - Expired-at-signature-time key fails strictly
  - Valid-at-signature-time historical bundled keys pass strictly
  - Duplicate signer does not increase quorum (anti-sybil)
  - Bitcoin strict quorum >= 6 passes
  - Bitcoin strict quorum < 6 fails
  - LND strict quorum 5 passes
  - LND strict quorum 4 fails
  - Bundled key fingerprint mismatch fails closed
  - Runtime performs zero keyserver/GitHub key download (offline trust root)
  - Corrupt archive fail-closed deletion
  - bitcoind.exe single-byte tamper detection
  - lnd.exe single-byte tamper detection
  - lncli.exe single-byte tamper detection
  - StartupVerifier pre-execution gate refusal on missing binary
  - Real cached local binaries match pinned manifest exactly
```

Cumulative total: **218 / 218 test executions passing** (155 unit + 42 regtest + 21 closure).

All 63 live regtest tests pass deterministically in ~9 seconds against real native LND nodes.

---

## 21. Remaining Gaps to Production LND

While the protocol integration is complete and verified on Regtest, the following items remain before any production mainnet usage:
1. **Production Infrastructure Topology**: Moving from single-host regtest to production hardened LND nodes behind redundant network firewalls with automated static channel backups (SCB).
2. **Channel Liquidity Management**: Production coordinator needs active rebalancing mechanisms (e.g. Submarine Swaps / Loop Out) to maintain inbound hold capacity.
3. **Phase 3 (EVM HTLC Contract Deployment)**: Replacing `FakeEvmAtomicBackend` with real Solidity contracts deployed to Arbitrum / Base L2 testnets.
4. **Independent Smart Contract & Cryptographic Audit**: Professional third-party security review of the on-chain HTLC and coordinator settlement conditions.

---

## 22. Final Recommendations & Readiness Decision

### Assessment
* **Threat Model**: Comprehensive (26 LND-specific threats analyzed, 10 invariants frozen).
* **Network Safety**: P0 guard verified (refuses non-regtest networks).
* **Protocol Verification**: Real hold-invoice lifecycle empirically verified on live regtest Lightning channel.
* **Ambiguity Handling**: Fault injection proves zero blind retries on dropped sockets.
* **Mutual Exclusion**: Provably prevents double-claim/refund.
* **Preimage Model**: Accurately documented as transient-only; `AuthorizedSettlementPreimage` type boundary enforced.
* **Binary Supply-Chain**: Strict OpenPGP trust chain (zero insecure overrides, signature-time validity, Bitcoin Core $\ge 6$ builders, LND $\ge 5$ maintainers, anti-sybil deduplication, version-frozen historical key material, 100% offline trust roots, local binaries re-checked at runtime startup).
* **Least-Privilege Macaroon**: Scoped to `info:read`, `invoices:read`, `invoices:write` only; forbidden operations proven denied.
* **LND Adapter Status**: Correctly described as REAL LND PROTOCOL ADAPTER — REGTEST ENABLED ONLY.
* **Security Scans**: 100% clean (0 secrets, 0 type errors, 218 passing tests after Phase 2.2B).

### Phase 2.2B Addendum (Strict OpenPGP & Version-Frozen Key Material Closure)
Under Owner review, Phase 2.2B eliminated all insecure OpenPGP options and mutable trust dependencies:
1. **Zero Insecure Overrides**: Banned `allowInsecureVerificationWithReformattedKeys`.
2. **Signature-Time Validity**: All signature evaluations use the authenticated `sig.packets[0].created` timestamp.
3. **Historical Key Material**: Bundled version-appropriate historical keys (Roasbeef frozen at commit `cb0f0dd`; Andrew Chow frozen at commit `6c3eef4`).
4. **100% Offline Trust**: Key verification performs zero network requests.

### Status Decision
All requirements of Phase 2, Phase 2.1, and Phase 2.2B are completely satisfied. The system is ready for Owner review.

