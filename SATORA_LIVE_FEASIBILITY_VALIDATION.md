# SATORA LIVE FEASIBILITY VALIDATION
**Universal Agent Asset Router**  
**Phase**: Satora Live Feasibility Validation  
**Date**: 2026-09-03  
**Mode**: Read-Only Research + Live API Quote Validation  
**Status**: Completed — Zero Money Moved — Zero Code Mutated  

---

## 1. EXECUTIVE VERDICT

**B. CONDITIONAL PASS — ROUTE IS LIVE BUT ONE CLEARLY DEFINED TECHNICAL / AUTH / RECOVERY ISSUE MUST BE RESOLVED BEFORE INTEGRATION**

Live API probing of Satora (`https://api.satora.io`) confirms that Satora **is currently operational and actively quoting Lightning BTC $\rightarrow$ canonical Base USDC** (with a live minimum of 356 satoshis / ~$0.28 USD).

However, Satora is fundamentally **NOT a drop-in replacement for a PASSIVE_DEPOSIT provider edge**:
1. **Active Execution Requirement**: Satora does not execute as a passive deposit. It uses an on-chain Hash Time-Locked Contract (HTLC) and a Lightning Hold Invoice. 
2. **Client Private Key & EIP-712 Signing**: To complete the swap, the agent/client **must hold an EVM private key** and construct an **EIP-712 typed signature** over the `Redeem` struct to execute `/swap/{id}/claim-gasless`.
3. **Indirect Route (CCTP Multi-Hop)**: Satora does not have native HTLC smart contracts on Base. The swap executes on **Arbitrum (42161)** into Arbitrum USDC, and is forwarded to Base via **Circle CCTP** (Cross-Chain Transfer Protocol).

Therefore, while Satora is a viable, high-quality trust-minimized protocol edge for future architecture, it **cannot serve as an immediate zero-key passive-deposit replacement for FixedFloat in Phase 3A** without building an active signing and preimage management module.

---

## 2. OFFICIAL TECHNICAL MODEL

* **Platform Identity**: Satora (formerly **LendaSwap** / **Lendasat**, developed by `satoraHQ`).
* **Protocol Type**: Non-custodial, trust-minimized atomic swap protocol.
* **Core Architecture**:
  * **Source**: Lightning Network (via BOLT11 **Hold Invoices**).
  * **Intermediate Pivot**: On-chain EVM HTLCs on Hub chains using `tBTC` or `WBTC`.
  * **Contracts**:
    * `HTLCErc20`: Holds BTC-pegged tokens on EVM until preimage reveal or refund locktime.
    * `HTLCCoordinator`: Handles `redeemAndExecute` and 1inch DEX aggregation.
* **Live Service**: Verified running OpenAPI 3.1.0 backend (`https://api.satora.io`, version `0.3.13`).

---

## 3. ASSET & NETWORK MAPPING

Live query against `GET /evm-tokens/chains` and `GET /chain-config`:
* **Officially Supported EVM Hub Chains**:
  * `1`: Ethereum Mainnet (`tBTC`)
  * `137`: Polygon (`WBTC`)
  * `42161`: Arbitrum One (`tBTC`)
* **Base Status**:
  * Requesting `target_chain=Base` or `8453` directly returns `400 Bad Request: unknown variant Base, expected one of Arkade, Lightning, Bitcoin, 137, 1, 42161`.
  * Base is supported exclusively via **Circle CCTP Forwarding**:  
    `target_chain=42161` (Arbitrum) + `target_token=0xaf88d065e77c8cC2239327C5EDb3A432268e5831` (Arbitrum USDC) + `bridge_target_chain=Base`.

---

## 4. CANONICAL BASE USDC VERIFICATION

* **Contract Verified**: **YES**.
* When `bridge_target_chain=Base` is specified, the Arbitrum USDC acquired through 1inch is forwarded via Circle CCTP. Circle burns on Arbitrum and mints canonical native USDC on Base at:
  $$\mathbf{0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913}$$
* The final token delivered to the user is **canonical Circle USDC**, not a wrapped, bridged, or synthetic variant.

---

## 5. ACCOUNT / AUTHENTICATION MODEL

* **No User Accounts**: No email, username, or password registration.
* **No API Keys**: Public endpoints require no bearer tokens or HMAC API keys.
* **Required Header**: `x-satora-server-version: 0.3.13`.
* **Cryptographic Identity**:
  * The client must provide a `claiming_address` (EVM hex address) and a `user_id` (derived from HD key for recovery).
  * The client **must hold the private key** to `claiming_address` to sign the claim.

---

## 6. PROGRAMMATIC API / SDK

* **API Endpoints**:
  * Discovery: `GET /tokens`, `GET /chain-config`, `GET /evm-tokens/chains`
  * Quoting: `GET /quote`
  * Creation: `POST /swap/lightning/evm`
  * Status: `GET /swap/{id}`
  * Claim: `GET /swap/{id}/redeem-and-swap-calldata`, `POST /swap/{id}/claim-gasless`
  * Refund: `POST /swap/{id}/collab-refund-evm`
* **SDK Availability**:
  * Official package: `@satora/swap` (formerly `@lendasat/lendaswap-sdk-pure`).
  * Pure TypeScript, compatible with Node.js and browser environments.

---

## 7. LIVE LIGHTNING ROUTE EVIDENCE

Probing `https://api.satora.io/status`:
```json
{
  "healthy": true,
  "swaps_paused": false,
  "services": {
    "arkade": {"healthy": true},
    "bitcoin": {"healthy": true, "block_height": 965302},
    "polygon": {"healthy": true, "block_height": 93152393},
    "ethereum": {"healthy": true, "block_height": 25896375},
    "arbitrum": {"healthy": true, "block_height": 501300232},
    "lightning": {"healthy": true}
  }
}
```
* **Lightning Service**: **HEALTHY / OPERATIONAL**.
* Unlike FixedFloat, Satora's Lightning receiving nodes are currently online and accepting swap quotes.

---

## 8. LIVE QUOTE, MINIMUM & FEE EVIDENCE

Live authenticated quote queries executed on 2026-09-03 via:  
`GET /quote?source_chain=Lightning&source_token=btc&target_chain=42161&target_token=0xaf88d065e77c8cC2239327C5EDb3A432268e5831&bridge_target_chain=Base`:

| Amount Input | Exchange Rate | Protocol Fee | CCTP Bridge Fee | Net Target Output | Classification |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **356 sats** (Live Min) | $77,591.01 | 2 sats (0.5%) | 0.055942 USDC | **0.220194 USDC** | LIVE_QUOTE |
| **10,000 sats** | $77,591.01 | 50 sats (0.5%) | 0.055942 USDC | **7.658156 USDC** | LIVE_QUOTE |
| **50,000 sats** | $77,597.84 | 250 sats (0.5%)| 0.061156 USDC | **38.537562 USDC**| LIVE_QUOTE |
| **100,000 sats** | $77,598.57 | 500 sats (0.5%)| 0.067674 USDC | **77.136692 USDC**| LIVE_QUOTE |

* **Live Minimum**: **356 satoshis** (~$0.28 USD).
* **Live Maximum**: **2,000,000 satoshis** (0.02 BTC / ~$1,550 USD).
* **Estimated Settlement Time**: ~15–25 minutes (due to Arbitrum L2 finality and Circle CCTP attestation).

---

## 9. BOLTZ DEPENDENCY ANALYSIS

* **Architecture**: Satora operates its own coordinator nodes and backend service.
* **Public Boltz Dependency**: Satora **does not depend on the public Boltz API** (`boltz.exchange`).
* **Protocol Lineage**: Satora uses the submarine swap / hold invoice concept with custom EVM smart contracts (`HTLCErc20`), independent liquidity pools, and proprietary coordinator infrastructure.

---

## 10. TRUST, CUSTODY & ATOMICITY

1. **Custody**: Completely non-custodial. Neither Satora nor the Router ever has uncollateralized custody.
2. **Hold Invoice Flow**:
   * Payer pays Lightning hold invoice $\rightarrow$ Payment is frozen, not settled.
   * Server locks `tBTC` in Arbitrum `HTLCErc20` contract with the same `hash_lock`.
   * Client claims `tBTC` by revealing `secret` $\rightarrow$ Server captures `secret` to settle the Lightning hold invoice.
3. **Atomicity**: Guaranteed mathematically. If server fails to fund HTLC, the hold invoice expires and satoshis are returned to payer. If client never claims, hold invoice cancels. Server cannot take BTC without revealing preimage on-chain.

---

## 11. GAS & CLAIM MODEL

* **Gasless Relay**: Satora provides `POST /swap/{id}/claim-gasless`. The server pays Arbitrum gas for `coordinator.redeemAndExecute`. The user does not need Arbitrum ETH.
* **Destination Wallet**: Does not need Base ETH. CCTP mints USDC directly.
* **Signature Prerequisite**: Although gas is relayed, the user **must sign an EIP-712 typed message**:
  ```text
  Redeem(bytes32 preimage, uint256 amount, address token, address sender, uint256 timelock, address caller, address destination, address sweepToken, uint256 minAmountOut, bytes32 callsHash)
  ```
* This requires an active private key inside the agent.

---

## 12. RECOVERY MODEL

* **Unfunded / Expired**: If the client never pays or the server fails to fund, the hold invoice cancels cleanly. Zero funds lost.
* **Server Funded, Client Crashed**: The `tBTC` sits in the Arbitrum HTLC. If the client recovers the `secret` and EVM private key, it can submit `claim-gasless` anytime before the timelock expires.
* **Timelock Expiry**: If the client never claims, the server refunds the `tBTC` after the timelock expires (`ClientFundedServerRefunded`), and the Lightning hold invoice cancels.

---

## 13. AMBIGUOUS CREATE & IDEMPOTENCY

* Satora enforces deterministic idempotency via `hash_lock`:
  `409 Conflict: a swap with this hash_lock exists already`.
* Because `hash_lock = sha256(secret)` is client-generated, an accidental duplicate POST returns 409 and never creates a duplicate swap.
* Swaps can be recovered via `GET /swap/{id}` or `POST /swap/recover`.

---

## 14. ARCHITECTURE V3 EDGE CLASSIFICATION

If integrated into the Universal Agent Asset Router:
* **`edgeClass`**: `EdgeClass.ATOMIC_EDGE` / `PROTOCOL_EDGE`
* **`executionClass`**: `ExecutionClass.ACTIVE_EXECUTION`
* **Router Capabilities**:
  * `discover`: SUPPORTED
  * `quote`: SUPPORTED
  * `prepare`: SUPPORTED (Preimage generation + hold invoice creation)
  * `execute`: SUPPORTED (EIP-712 signing + gasless claim submission)
  * `verify`: SUPPORTED (Circle CCTP Base RPC verification)
  * `recover`: SUPPORTED (Hold invoice expiration / collaborative refund)

---

## 15. COMPARISON: SATORA VS. FIXEDFLOAT

| Property | FixedFloat | Satora |
| :--- | :--- | :--- |
| **Current Live Status** | Inbound `BTCLN` in maintenance (`recv: 0`) | **LIVE & HEALTHY** (`Lightning` available) |
| **Base Delivery** | **Direct native Base L2** | **Indirect (Arbitrum $\rightarrow$ Circle CCTP)** |
| **Minimum Sats** | ~1,448 sats (~$1.12 USD) | **356 sats** (~$0.28 USD) |
| **Protocol Type** | Centralized / Custodial Exchange | **Non-Custodial / Atomic HTLC** |
| **Execution Class** | **PASSIVE_DEPOSIT** | **ACTIVE_EXECUTION** |
| **Agent Key Requirement** | **NONE** (Zero keys, non-custodial) | **EVM Private Key required for EIP-712** |
| **Settlement Time** | ~1–3 minutes | ~15–25 minutes |
| **Router Readiness** | **100% Implemented & Tested (96 tests)** | **0% Implemented (Requires new active edge)** |

---

## 16. REMAINING RISKS

1. **Agent Custody / Signing Boundary**: Integrating Satora requires the Router to hold or access an EVM private key to sign EIP-712 claim digests. This violates the zero-key non-custodial assumption frozen for Phase 3A.
2. **Bridge Finality Latency**: CCTP transfer introduces a 15–20 minute wait for cross-chain attestation between Arbitrum and Base.
3. **Complexity & Scope**: Requires writing a new `SatoraAdapter`, state machine handling for `ServerFunded` and `ClientRedeemed`, preimage generation/storage, and EIP-712 signing utilities.

---

## 17. FINAL RECOMMENDATION

1. **Short-Term (Phase 3A PoC)**:
   * **Wait for FixedFloat Lightning receiving maintenance to clear**.
   * FixedFloat is already 100% integrated, durably arbitrated, verified with 96 tests, and requires **zero private keys or signing** from the Router.
2. **Medium-Term (Architecture V3.1 Extension)**:
   * Satora is the **strongest candidate for a decentralized, trust-minimized `ATOMIC_EDGE`** to replace or complement centralized providers.
   * Plan Satora implementation as a dedicated phase after Phase 3 PoC is validated.

---

## 18. SOURCES & EVIDENCE

* Satora Live Health: `https://api.satora.io/health` (HTTP 200 OK)
* Satora Live Status: `https://api.satora.io/status` (HTTP 200 OK, `lightning.healthy: true`)
* Satora Live Chains: `https://api.satora.io/evm-tokens/chains` (Chains 1, 137, 42161)
* Satora Live Quoting: `https://api.satora.io/quote` (Tested 356 to 100,000 sats, HTTP 200 OK)
* Satora OpenAPI 3.1.0 Specification: `https://api.satora.io/api-docs/openapi.json`
* Circle CCTP Base Contract: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
