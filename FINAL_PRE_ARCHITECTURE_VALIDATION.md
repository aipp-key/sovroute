# FINAL PRE-ARCHITECTURE VALIDATION REPORT
**Universal Agent Asset Router — Phase: Read-Only Validation Only**  
**Date**: 2026-09-03  
**Status**: READ-ONLY EVIDENCE AUDIT COMPLETE  

---

## 1. EXECUTIVE VERDICT

**VERDICT: DO NOT FREEZE ARCHITECTURE V3 — MATERIAL ARCHITECTURE RISKS IDENTIFIED.**

Before freezing Architecture V3, empirical validation was conducted against live Garden Finance APIs, ACINQ phoenixd source code, and local environment state. Two decisive findings emerged:

1. **Garden Finance Route Invalidation**: While Garden Finance's catalog contains canonical Circle Base USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`), the live production policy endpoint (`GET https://api.garden.finance/v2/policy`) explicitly lists `'base:usdc <-> bitcoin:btc'` in its **`blacklist_pairs`**. Furthermore, live solver liquidity for `base:usdc` is **0**, and quote queries return `400: No order pair found`. Garden currently only routes `bitcoin:btc` to wrapped Bitcoin assets (`base:cbbtc`, `arbitrum:wbtc`, `ethereum:wbtc`). A direct native BTC $\rightarrow$ Base USDC swap via Garden is **currently impossible**.
2. **phoenixd Operational Constraints**: Official ACINQ phoenixd source code confirms that `POST /sendtoaddress` is strictly a mutating, fund-moving splice-out operation requiring full-access credentials. **No native quote, dry-run, or fee simulation endpoint exists.** Splicing requires synchronous cooperation from ACINQ's LSP peer.
3. **Local AIPP phoenixd State**: The local instance is stopped (last run Aug 8, 2026), port 9740 is closed, and the SQLite database shows **0 open channels**. Per the zero-touch production mandate, the daemon was not restarted.

---

## 2. GARDEN FINANCE VALIDATION (BTC $\rightarrow$ CANONICAL USDC / BASE)

### 2.1 Official Documentation & OpenAPI Specification
* **API Specification**: Retrieved live OpenAPI 3.0 specification from `https://docs.garden.finance/docs/api-reference/openapi.json`.
* **Endpoints Analyzed**:
  * `GET /v2/assets`: Asset catalog and on-chain contract addresses.
  * `GET /v2/policy`: Route policy, isolation groups, and blacklists.
  * `GET /v2/liquidity`: Solver balances per asset.
  * `GET /v2/quote`: Price and order quotation.

### 2.2 Canonical Base USDC Verification
* **Expected Circle Base USDC Address**: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.
* **Garden Returned Asset Metadata (`GET /v2/assets`)**:
  ```json
  {
    "id": "base:usdc",
    "name": "USD Coin:USDC",
    "chain": "evm:8453",
    "token": {
      "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "schema": "evm:erc20"
    },
    "htlc": {
      "address": "0x227A436e93AAEf856ed406713F2bc3D110A7b797",
      "schema": "evm:htlc_erc20"
    },
    "decimals": 6,
    "min_amount": "10000000",
    "max_amount": "1000000000000",
    "is_active": true
  }
  ```
* **Verification Match**: **EXACT 100% MATCH**. Garden defines Base USDC using Circle's canonical contract.

### 2.3 Live Route Availability & Policy Failure
* **Live Query**: `GET /v2/policy`
  * Default policy: `open`
  * `blacklist_pairs`: **279 pairs blacklisted**, including:
    $$\mathbf{'base:usdc <-> bitcoin:btc' \in blacklist\_pairs}$$
  * In fact, **ALL** stablecoin pairs against `bitcoin:btc` are currently blacklisted (`base:usdc`, `ethereum:usdc`, `solana:usdc`, `hypercore:usdc`, `tempo:usdce`, `ethereum:usdt`, `robinhood:usdg`).
  * Only wrapped Bitcoin pairs are unblacklisted (`base:cbbtc`, `arbitrum:wbtc`, `ethereum:cbbtc`, `ethereum:wbtc`, `solana:cbbtc`, `starknet:strkbtc`).
* **Live Quote Test**:
  * Request: `GET /v2/quote?from=bitcoin:btc&to=base:usdc&from_amount=1000000&indicative=true`
  * Response: `HTTP 400 {"status":"Error","error":"No order pair found : bitcoin:primary::base:0x227a436e93aaef856ed406713f2bc3d110a7b797"}`
* **Solver Liquidity**:
  * Query: `GET /v2/liquidity?from=bitcoin:btc&to=base:usdc`
  * Active solver (`maestro-solver`): `asset: "base:usdc"`, `balance: "0"`, `virtual_balance: "0"`.

### 2.4 Answers to Required Validation Questions
1. **Is native BTC accepted as source?** Yes (`bitcoin:btc` exists in `/assets`).
2. **Is Base supported as destination?** Yes (`evm:8453`).
3. **Is USDC supported on Base?** Yes (`base:usdc`).
4. **What exact token address does Garden identify?** `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.
5. **Does it match canonical Circle Base USDC?** Yes, exact match.
6. **Can BTC $\rightarrow$ USDC/Base currently receive a valid quote?** **NO**. Route is blacklisted in `/policy` and returns `400: No order pair found`.
7. **Current minimum input**: For `bitcoin:btc`, catalog specifies `min_amount: 10000` (10,000 sats / 0.0001 BTC); for Base USDC, catalog specifies `min_amount: 10000000` (10 USDC). However, quote generation fails.
8. **Current maximum input**: Catalog specifies `max_amount: 500000000` (5 BTC).
9. **Estimated output for non-executed amounts**: Cannot be calculated because quotes are blocked by route policy.
10. **Fees / Spread**: Protocol fee endpoint `GET /v2/fees` is exposed, but quotes cannot be obtained.
11. **Quote expiry**: Garden quotes typically expire in 3 to 10 minutes.
12. **Expected settlement time**: 10 to 30 minutes (requires 1 Bitcoin block confirmation for source HTLC deposit, plus Base HTLC settlement).
13. **Refund mechanism**: On-chain P2WSH/Taproot HTLC timelock refund transaction. If the swap fails, the user broadcasts a refund transaction after the locktime (minimum 12 Bitcoin blocks ~ 2 hours) expires.
14. **Atomicity boundary**: Cryptographic HTLC hashlock (`SHA256(preimage)`). User only reveals `preimage` when redeeming funds on Base. If solver never locks funds on Base, user never reveals preimage, and refunds BTC after timelock.
15. **Exact point at which user funds can move**: When the user signs and broadcasts the Bitcoin transaction funding the HTLC deposit script address.
16. **Failure scenarios**:
    * *Quote expires*: Unfunded order terminates; 0 funds move.
    * *BTC never deposited*: Order terminates; 0 funds move.
    * *BTC deposited but solver disappears*: User waits for 12-block timelock and executes an on-chain refund transaction. Funds are locked for ~2 hours plus confirmation time.
    * *Destination execution fails*: User does not reveal preimage; user executes on-chain refund on Bitcoin after timelock.
    * *Garden API disappears after BTC locked*: Non-custodial HTLC parameters exist on-chain. As long as the user retains the secret preimage and HTLC redeemscript, they can interact directly with the Bitcoin and Base blockchains without the API.
17. **Trust Classification**: **NON-CUSTODIAL HTLC ATOMIC SWAP (SOLVER-MEDIATED)**. Neither Garden nor the solver has custody of user assets. However, **liveness and route availability are 100% dependent on solvers**. When solvers blacklist the pair, the route ceases to function.

---

## 3. AIPP PHOENIXD PRODUCTION READ-ONLY AUDIT

### 3.1 Daemon & Configuration Identification
* **Process State**: **STOPPED / NOT RUNNING**.
  * No Windows process `*phoenix*` exists.
  * Port `9740` is closed (connection refused).
  * WSL2 (`Ubuntu`) is in state `Stopped`.
  * Last log entry in `phoenix.log`: `Sat Aug 8 20:02:28 2026`.
* **Configuration Location**: `C:\Users\faruk\Desktop\phoenixd_data\phoenix.conf`
* **Network**: **Bitcoin Mainnet** (database file: `phoenix.mainnet.03639a.db`).
* **Node Identifier Prefix**: `03639a...`
* **Limited-Access Credential**:
  * Inspected `phoenix.conf` (sanitized):
    ```
    http-password=[REDACTED]
    http-password-limited-access=[REDACTED]
    webhook-secret=[REDACTED]
    ```
  * `http-password-limited-access` is **CONFIGURED**.
  * Per directive: Credentials were not printed, copied to `.env`, or exposed.
  * Because the daemon is stopped and the safety rules strictly prohibit restarting production containers/processes, **no live HTTP calls were made**.

### 3.2 Authoritative Source Code Audit (`ACINQ/phoenixd:src/commonMain/kotlin/fr/acinq/phoenixd/Api.kt`)
By inspecting the Kotlin source code of phoenixd's API module, exact capability boundaries were proven:

1. **Authentication Scopes**:
   * **`limited-access` permitted**:
     * `GET /getinfo`
     * `GET /getbalance`
     * `GET /estimateliquidityfees`
     * `GET /listchannels`
     * `POST /createinvoice`
     * `POST /createoffer`
     * `GET /payments/incoming`
     * `GET /payments/outgoing`
   * **`full-access` REQUIRED (Strictly blocks limited-access)**:
     * `POST /payinvoice`
     * `POST /sendtoaddress`
     * `POST /closechannel`
     * `POST /bumpfee`
2. **On-Chain Send Mechanics (`POST /sendtoaddress`)**:
   ```kotlin
   post("sendtoaddress") {
       val res = kotlin.runCatching {
           val formParameters = call.receiveParameters()
           val amount = formParameters.getLong("amountSat").sat
           val scriptPubKey = formParameters.getAddressAndConvertToScript("address")
           val feerate = FeeratePerKw(FeeratePerByte(formParameters.getLong("feerateSatByte").sat))
           peer.spliceOut(amount, scriptPubKey, feerate)
       }
   ```
   * **Implementation**: Calls `peer.spliceOut(amount, scriptPubKey, feerate)`.
   * **Fund-Moving Status**: **STRICTLY FUND-MOVING**. Broadcasts an on-chain transaction immediately.
   * **Dry-Run / Quote Endpoint**: **DOES NOT EXIST**. There is no preview or simulation endpoint for `sendtoaddress`. `GET /estimateliquidityfees` only estimates inbound Lightning channel lease fees.

### 3.3 State Analysis from Read-Only SQLite (`phoenix.mainnet.03639a.db`)
Read-only query via SQLite URI `file:...mode=ro`:
* `local_channels` count: **0**
* `on_chain_txs` count: **0**
* `payments_incoming` count: **75**
* `payments_outgoing` count: **35**
* **Conclusion**: The node currently has **0 active channels**. It cannot send or receive payments without channel opening/splicing.

### 3.4 ACINQ Infrastructure Dependency Classification

| Dependency | Classification | Architectural Impact |
| :--- | :--- | :--- |
| **Routing** | `AVAILABILITY DEPENDENCY` | All multi-hop payments route through ACINQ's node. |
| **Channel Peer** | `AVAILABILITY & INTERACTIVE DEPENDENCY` | All channels are exclusively peered with ACINQ. |
| **Liquidity Ads** | `COST & AVAILABILITY DEPENDENCY` | Inbound liquidity leased from ACINQ; dynamic lease fees apply. |
| **Splice Cooperation** | `SAFETY & AVAILABILITY DEPENDENCY` | Splice-out requires interactive dual-funding signing from ACINQ. If ACINQ is offline, splice-out is impossible. |
| **Chain Access** | `PRIVACY & AVAILABILITY DEPENDENCY` | Default configuration relies on ACINQ Electrum servers for chain data. |
| **Force-Close Recovery** | `NONE / LOCAL` | Unilateral force-close does not require ACINQ cooperation, providing eventual self-custodial recovery after timelock. |

---

## 4. EXTERNAL BITCOIN FEE ESTIMATE (ESTIMATED_EXTERNAL)

*All estimates below are marked **`ESTIMATED_EXTERNAL`** based on public mempool.space data. They are NOT phoenixd quotes.*

### 4.1 Current Mempool Conditions (Source: mempool.space)
* Fastest Fee: `3 sat/vB`
* Half-Hour Fee: `3 sat/vB`
* Hour / Minimum Fee: `1 sat/vB`

### 4.2 Splice-Out Cost Model
A splice-out transaction spends a channel 2-of-2 multisig UTXO, creates a new channel funding output, and creates the on-chain destination output. Estimated size: **~200 vbytes**.

$$\text{Estimated Mining Fee} = 200 \text{ vB} \times \text{feerateSatByte}$$

| Input Amount | Mining Fee @ 1 sat/vB (200 sats) | Mining Fee @ 3 sat/vB (600 sats) | Congestion @ 30 sat/vB (6,000 sats) |
| :--- | :--- | :--- | :--- |
| **1,000 sats** (~$0.77) | 20.0% fee | 60.0% fee (**Non-viable**) | 600% fee (**Fatal**) |
| **10,000 sats** (~$7.75) | 2.0% fee | 6.0% fee | 60.0% fee |
| **100,000 sats** (~$77.50)| 0.2% fee | 0.6% fee | 6.0% fee |
| **1,000,000 sats** (~$775) | 0.02% fee | 0.06% fee | 0.6% fee |

> [!WARNING]
> **ESTIMATED_EXTERNAL Finding**: For micro-transactions (<10,000 sats), Bitcoin L1 on-chain splice fees render on-chain routing economically non-viable whenever fee rates rise above 2–3 sat/vB. Furthermore, Garden requires a *second* on-chain transaction to fund the HTLC script if not sent directly via splice-out.

---

## 5. PROPOSED EXECUTION GRAPH VS. FIXEDFLOAT FALLBACK

```mermaid
graph TD
    subgraph Proposed Trust-Minimized Graph (Blocked)
        A1[Agent Intent: Lightning BTC] --> B1[phoenixd Node]
        B1 -->|Splice-Out: 200 vB on-chain| C1[Native Bitcoin UTXO]
        C1 -.->|BLOCKED: Blacklisted in Policy| D1[Garden Finance HTLC]
        D1 -.->|HTLC Redeem| E1[Canonical Base USDC]
    end

    subgraph Centralized Passive-Deposit Fallback (Operational)
        A2[Agent Intent: Lightning BTC] --> B2[FixedFloat V2 Adapter]
        B2 -->|Single BOLT11 Invoice Payment| C2[FixedFloat Solver]
        C2 -->|Direct Base Transfer| D2[Canonical Base USDC]
    end
```

### Detailed Comparison Table

| Evaluation Criterion | Proposed Garden Route (Architecture V3) | FixedFloat Fallback (Phase 2 Baseline) |
| :--- | :--- | :--- |
| **Live Route Availability** | **BROKEN / BLACKLISTED** (`base:usdc <-> bitcoin:btc`) | **ACTIVE** (subject to temporary node maintenance) |
| **Trust Model** | Trust-minimized HTLC atomic swap | Trusted passive-deposit swap |
| **Counterparty Theft Risk** | Cryptographically zero (HTLC timelock) | Limited to in-flight deposit window |
| **Atomicity** | P2P cryptographic atomicity via secret preimage | State-machine reconciliation & audit |
| **On-Chain Transactions** | 2 on-chain Bitcoin txs + 1 Base contract call | **0 Bitcoin on-chain txs** (pure Lightning) + 1 Base tx |
| **Execution Latency** | 20–60 minutes (Bitcoin block confirmations) | 1–5 minutes (instant Lightning detection) |
| **Fee Structure** | Splice fee (~200–600 sats) + Garden spread (~0.5%) + Base gas | Flat 0.5% floating fee |
| **Micro-Transaction Viability**| Infeasible for amounts <$10 USD due to L1 mining fees | **Viable at 1,443 satoshis (~$1.12 USD)** |
| **Private Key / Signer Burden**| Requires local Base private key to execute `redeem()` | **Zero client keys required** (Base address only) |
| **Autonomous Agent Fit** | High complexity: requires managing Bitcoin & Base signers | Clean REST interface; passive payment |

---

## 6. ARCHITECTURE V3 EDGE CLASSIFICATION REVIEW

The proposed 4 edge classes remain conceptually sound, but empirical validation provides critical refinements:

1. **`SELF_CUSTODY_EDGE`** (e.g. phoenixd splice-out, local Base wallet):
   * *Correction*: Must explicitly flag `requiresFullAccess: true` and `supportsDryRun: false`. Splicing is an interactive protocol requiring peer availability, not a simple local wallet broadcast.
2. **`ATOMIC_EDGE`** (e.g. Garden, Boltz HTLC):
   * *Correction*: Must separate **protocol correctness** from **solver route policy**. Even when an HTLC contract is cryptographically sound, solver orderbook depth and route blacklists determine operational viability.
3. **`PROTOCOL_EDGE`** (e.g. Chainflip, Uniswap, Aerodrome):
   * *Correction*: Requires multi-hop orchestration (e.g. BTC $\rightarrow$ cbBTC via HTLC, then cbBTC $\rightarrow$ USDC via DEX).
4. **`TRUSTED_PROVIDER_EDGE`** (e.g. FixedFloat, SideShift):
   * *Status*: Remains the only viable direct route for Lightning BTC $\rightarrow$ Base USDC under current market infrastructure.

---

## 7. CAPABILITY MODEL REVIEW
$$\text{DISCOVER} \longrightarrow \text{QUOTE} \longrightarrow \text{PREPARE} \longrightarrow \text{EXECUTE} \longrightarrow \text{VERIFY} \longrightarrow \text{RECOVER}$$

### Critical Invariant Confirmed:
> **Support for one capability MUST NOT imply support for another.**

* **phoenixd Capability Audit**:
  * `DISCOVER`: Supported (`GET /getinfo`, `GET /listchannels`).
  * `QUOTE`: **UNSUPPORTED**. (No fee simulation or quote endpoint for splice-out).
  * `PREPARE`: **UNSUPPORTED**. (No draft transaction creation).
  * `EXECUTE`: Supported, **STRICTLY FUND-MOVING** (`POST /sendtoaddress`).
  * `VERIFY`: Supported via on-chain transaction hash.
  * `RECOVER`: Protocol-dependent (force-close fallback).
* **Garden Capability Audit**:
  * `DISCOVER`: Supported (`GET /assets`, `GET /policy`).
  * `QUOTE`: **BLOCKED** for Base USDC (`400: No order pair found`).
  * `PREPARE`: Supported via `POST /orders` (when pair is active).
  * `EXECUTE`: Supported via Bitcoin HTLC funding.
  * `VERIFY`: Supported via Base contract event monitoring.
  * `RECOVER`: Cryptographic on-chain refund after timelock.

---

## 8. SAFETY INVARIANTS DISCOVERED

1. **`PREVENT_BLIND_EXECUTE`**: An `EXECUTE` endpoint (`/sendtoaddress`) must **never** be invoked to infer network fees or validate addresses when `QUOTE` is missing.
2. **`POLICY_PRECHECK_MANDATE`**: Before quoting or presenting routes to an agent, the router must query `GET /policy` to ensure the pair is not in `blacklist_pairs`.
3. **`MICRO_TRANSACTION_L1_GUARD`**: The router must enforce a dynamic minimum based on current mempool fee rates. If mining fees exceed 5% of input value, on-chain routes must be disqualified.
4. **`DUAL_SIGNER_BURDEN`**: HTLC atomic routes require the router/agent to maintain an active EVM private key on Base to submit the `redeem()` transaction. This increases agent attack surface compared to passive deposit routes.

---

## 9. REMAINING UNKNOWNS

1. **Garden Policy Roadmap**: When will Garden Finance solvers remove `base:usdc <-> bitcoin:btc` from `blacklist_pairs` and allocate liquidity?
2. **Multi-Hop Feasibility**: Would a two-leg route (`BTC` $\rightarrow$ `base:cbbtc` via Garden $\rightarrow$ `USDC` via Aerodrome/Uniswap) be acceptable to the owner, despite requiring Base gas and DEX slippage?
3. **Alternative Atomic Backends**: Should Boltz Exchange (Submarine Swaps: Lightning $\rightarrow$ Rootstock/Liquid/Base) or Chainflip be evaluated as alternative trust-minimized engines?

---

## 10. EXACT RECOMMENDATION

**RECOMMENDATION: C. DO NOT FREEZE — MATERIAL ARCHITECTURE RISK REMAINS**

### Rationale:
Architecture V3 cannot be frozen around Garden Finance because the primary route (`native BTC -> USDC on Base`) is **blacklisted by Garden's live production policy** and has **zero solver liquidity**. Furthermore, phoenixd's lack of a quote endpoint and high on-chain fee overhead for small amounts make it unsuitable as a primary micro-transaction rail.

### Recommended Next Step:
Retain FixedFloat as the operational `PASSIVE_DEPOSIT` adapter for micro-transactions ($1.16 USD / 1,493 sats) once maintenance clears, while researching whether an alternative trust-minimized backend (such as Boltz or a multi-hop cbBTC swap) can satisfy the agent routing requirements.

---
*Report generated strictly using read-only public evidence and non-destructive inspection.*
