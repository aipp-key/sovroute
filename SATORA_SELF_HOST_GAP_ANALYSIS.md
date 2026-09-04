# SATORA OPEN-SOURCE SELF-HOST GAP ANALYSIS
**Universal Agent Asset Router**  
**Phase**: Architecture Feasibility & Source Code Audit  
**Date**: 2026-09-03  
**Mode**: Read-Only Source Audit & Gap Analysis  
**Status**: Completed — Zero Code Mutated — Zero Financial State Generated  

---

## 1. EXECUTIVE VERDICT

**B. CONDITIONAL GO — CORE IS OPEN, BUT ONE OR MORE CLEAR COMPONENTS MUST BE BUILT BY US**

The cryptographic primitives, smart contract infrastructure, and client SDKs of the Satora protocol (formerly LendaSwap) are **100% open-source under the permissive MIT license**. The on-chain contracts (`HTLCErc20.sol`, `HTLCCoordinator.sol`, `CCTPBridgeAdapter.sol`) are immutable, non-custodial, and production-deployed on Arbitrum, Polygon, and Ethereum.

However, **the entire server-side coordinator backend (`api.satora.io`) is CLOSED-SOURCE and PROPRIETARY**:
1. **Missing Backend Coordinator**: Satora does not publish the daemon that manages LND hold invoices, monitors payments, executes HTLC funding on Arbitrum, relays gasless claims, or interfaces with market makers.
2. **Incompatible with phoenixd**: Phoenixd cannot create or settle HOLD invoices with external preimages. Self-hosting requires running an LND or Core Lightning node.
3. **Inventory & Capital Requirement**: Satora does not magically source counterparty liquidity on-chain. The coordinator must front `tBTC` on Arbitrum to lock into the HTLC *before* the user's Lightning payment is settled. Operating a self-hosted instance requires maintaining floating inventory (~$1,000–$5,000 min) and active Lightning channel liquidity.

**Self-Host Completeness Score: 50% – 55%**.  
We have the smart contracts and client protocols, but we would have to write our own coordinator daemon and operate an LND node.

---

## 2. REPOSITORY INVENTORY

An exhaustive audit of the `https://github.com/satoraHQ` organization revealed **28 total repositories**:

| Repository | Primary Language | License | Status / Purpose |
| :--- | :--- | :--- | :--- |
| **`lendaswap-contracts`** | Solidity | **MIT** | Core EVM HTLC contracts (`HTLCErc20`, `HTLCCoordinator`, `CCTPBridgeAdapter`). |
| **`satora-sdk`** / `lendaswap-sdk` | Rust / TS | **MIT** | Client SDK monorepo (`@satora/swap`, Rust HTTP client). |
| **`lendaswap-frontend`** | TypeScript | **MIT** | Official Next.js web application for swaps. |
| **`doomsday`** | Rust | Open (Unlicensed)| Offline CLI recovery tool for emergency refund/claim without server. |
| **`regtest-devenv`** | Docker / Just | Open (Unlicensed)| Docker environment running `bitcoind`, `lnd`, `cln`, `electrs`, `nbxplorer`. |
| **`tonic_lnd`** | Rust | Open (Unlicensed)| Asynchronous gRPC client library for LND. |
| **`boltz-client`** | Go | **MIT** | Client utility for Boltz submarine swap protocol. |
| **`usdc-arbitrum-to-bitcoin-onchain-sample`** | TypeScript | Open (Unlicensed)| CLI proof-of-concept demonstrating gasless Arbitrum USDC $\leftrightarrow$ on-chain BTC. |
| **`arkade-lightning-2of2-escrow`** | Python / Rust | Open (Unlicensed)| Escrow protocol experiments on Arkade. |
| **`btcpayserver-satora-plugin`** | C# | **MIT** | Integration plugin for BTCPay Server. |
| *(Remaining 18 Repos)* | Various | Various | Arkade SDKs, Alby Hub fork, whitepapers, landing pages. |

> [!IMPORTANT]
> **CRITICAL GAP**: There is **no repository** for `lendaswap-backend`, `satora-coordinator`, or the swap settlement daemon. The server running `api.satora.io` is private.

---

## 3. LICENSE MATRIX

| Component | License | Commercial Use | Modification | Distribution | Copyleft / Disclosure |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `lendaswap-contracts` | **MIT** | Allowed | Allowed | Allowed | None (Attribution only) |
| `satora-sdk` (`@satora/swap`)| **MIT** | Allowed | Allowed | Allowed | None (Attribution only) |
| `lendaswap-frontend` | **MIT** | Allowed | Allowed | Allowed | None (Attribution only) |
| OpenZeppelin Contracts | **MIT** | Allowed | Allowed | Allowed | None |
| Uniswap Permit2 | **MIT / GPL-2.0** | Allowed | Allowed | Allowed | Isolated interface |

**License Assessment**: Favorable. The reusable core (contracts and SDK) carries no copyleft restrictions and permits private commercial deployment.

---

## 4. PUBLIC VS. MISSING COMPONENT MATRIX

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      SATORA EXECUTION ARCHITECTURE                      │
├────────────────────────────────────┬────────────────────────────────────┤
│       OPEN SOURCE (PUBLIC)         │      MISSING (PROPRIETARY HOSTED)  │
├────────────────────────────────────┼────────────────────────────────────┤
│ [x] HTLCErc20.sol (EVM HTLC)       │ [!] Coordinator Settlement Daemon  │
│ [x] HTLCCoordinator.sol (Call DEX) │ [!] LND Hold-Invoice Controller    │
│ [x] CCTPBridgeAdapter.sol (Circle) │ [!] Gasless Relayer Server         │
│ [x] EIP-712 Signature Structs      │ [!] Live Liquidity & Spread Engine │
│ [x] Client SDK (@satora/swap)      │ [!] Inventory Hot Wallet Manager   │
│ [x] Doomsday Recovery Scripts      │ [!] CCTP Attestation Fetcher/Relay │
│ [x] 1inch Calldata Schema          │ [!] Automated Failure Reconciler   │
└────────────────────────────────────┴────────────────────────────────────┘
```

---

## 5. THE HOSTED BACKEND GAP

The hosted backend at `api.satora.io` (OpenAPI v0.3.13) performs five critical functions not present in public repos:
1. **Lightning Hold-Invoice Lifecycle**: Calls LND `invoicesrpc.AddHoldInvoice` with the client's `hash_lock`, listens for the `ACCEPTED` state, triggers EVM funding, and calls `invoicesrpc.SettleInvoice` once the preimage is revealed.
2. **EVM Transaction Dispatcher**: Submits `HTLCErc20.create` on Arbitrum, committing server-owned `tBTC` collateral to match the user's payment.
3. **Gasless Relayer**: Receives `POST /swap/{id}/claim-gasless`, validates the EIP-712 signature against the coordinator domain, and broadcasts `coordinator.redeemAndExecute` to Arbitrum paying gas.
4. **1inch DEX Quoting & Calldata Fetching**: Interacts with 1inch aggregation APIs using server API keys to construct DEX calldata.
5. **Inventory Balancing**: Converts settled BTC on Lightning into `tBTC`/USDC on Arbitrum to replenish liquidity.

---

## 6. LIGHTNING IMPLEMENTATION

* **Mechanism**: BOLT11 **Hold Invoices** (Hodl Invoices).
* **How it Works**:
  1. Invoice is created with `hash_lock = sha256(secret)`. The client keeps `secret`.
  2. When the user pays, satoshis are locked in Lightning HTLCs across channels. Payment is held in status `ACCEPTED`.
  3. Satora detects the hold, funds the Arbitrum contract, waits for the user to reveal `secret` on EVM, and uses `secret` to settle the Lightning invoice.
  4. If the swap fails or times out, Satora cancels the invoice, immediately returning satoshis to the user's wallet.
* **Server Backend Used**: **LND** (via `invoicesrpc` and `tonic_lnd`).

---

## 7. PHOENIXD COMPATIBILITY

> [!CAUTION]
> **PHOENIXD IS NOT SUFFICIENT FOR SATORA-LIKE LIGHTNING HTLC SIDE**

* **Reason**: `phoenixd` only exposes standard payment endpoints (`POST /createinvoice`, `POST /payinvoice`).
  * It does not allow specifying an external `payment_hash`.
  * It cannot hold an incoming payment in an unsettled state.
  * It automatically settles incoming HTLCs immediately.
  * It cannot settle or cancel an invoice using an externally supplied preimage.
* **Smallest Reasonable Alternative**:
  * **LND** (`v0.18+` / `v0.19+`) running with pruned `bitcoind` or Neutrino.
  * **Core Lightning (CLN)** with the `holdinvoice` plugin.

---

## 8. EVM HTLC CONTRACTS AUDIT

* **`HTLCErc20.sol`**:
  * Storage: Minimalistic — stores only `mapping(SwapKey => bool) public completed`.
  * Key: `keccak256(abi.encode(preimageHash, amount, token, sender, claimAddress, refundAddress, timelock))`.
  * Security: Immutables only, non-reentrant via EIP-1153 transient storage (`tload`/`tstore`).
  * Governance: **No admin keys, no proxy, no owner, no upgradeability, no pause button**.
* **`HTLCCoordinator.sol`**:
  * Composes `redeemAndExecute`: claims tokens from `HTLCErc20` using EIP-712 signature, executes arbitrary DEX calldata, and sweeps output to destination.
  * Security: Restricted targets protect against arbitrary calls draining coordinator or Permit2 approvals.
* **Deployment Risk**: **Zero centralized custody risk**. Deploying these contracts creates an immutable, trustless escrow mechanism.

---

## 9. GASLESS CLAIM & RELAYER MODEL

* **EIP-712 Struct Signed by User**:
  ```solidity
  Redeem(
      bytes32 preimage,
      uint256 amount,
      address token,
      address sender,
      uint256 timelock,
      address caller,
      address destination,
      address sweepToken,
      uint256 minAmountOut,
      bytes32 callsHash
  )
  ```
* **Front-Running & Replay Protection**:
  * `caller` is pinned to `address(coordinator)`.
  * `destination` is pinned to the user's recipient address.
  * `callsHash` binds the exact DEX swap calldata.
  * An attacker or relayer cannot divert output tokens. The smart contract strictly sweeps output tokens to `destination`.

---

## 10. DEX & CCTP BASE DELIVERY PATH

```
Lightning BTC (Hold Invoice)
     ↓ (Client pays satoshis into hold)
Arbitrum HTLCErc20
     ↓ (Server locks tBTC)
Arbitrum HTLCCoordinator
     ↓ (redeemAndExecute via 1inch DEX swap)
Arbitrum Canonical USDC (0xaf88...5831)
     ↓ (CCTPBridgeAdapter.bridgeBalance calls TokenMessenger.depositForBurn)
Circle CCTP V2 (Domain 6: Base)
     ↓ (Circle attestation & Iris relayer mint)
Base Canonical USDC (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)
```
* **Gas on Base**: Handled gaslessly by Circle's Forwarding Service / Iris relayer.

---

## 11. LIQUIDITY & CAPITAL MODEL

> [!WARNING]
> **THE CRITICAL OPERATIONAL CONSTRAINT: OPERATOR INVENTORY**

1. **Who provides the other side?** The coordinator operator.
2. **Funding Pre-requisite**: When an agent sends 10,000 sats over Lightning, the coordinator must lock `0.0001 tBTC` on Arbitrum **from its own funds**.
3. **Asymmetric Settlement**: The coordinator does not get paid the Lightning BTC until the user completes the claim on Arbitrum.
4. **Capital Required for Self-Hosting**:
   * Minimum floating inventory on Arbitrum: `~$1,000 – $5,000` in `tBTC`/ETH.
   * Lightning Node inbound channel capacity: `~$1,000 – $5,000` in active routed channels.
5. **Rebalancing Overhead**: The operator must routinely swap accumulated Lightning BTC back into Arbitrum `tBTC`.

---

## 12. CLIENT-SIDE SIGNING & ZERO-KEY COMPLIANCE

* **Router Invariant**: *Router must not store user private keys or seed phrases.*
* **Can Satora rail comply?** **YES**.
  * The user or autonomous AI agent generates their own 32-byte secret and holds their own EVM private key.
  * The agent sends only `hash_lock` and `claiming_address` to the Router.
  * The Router acts purely as coordinator/relayer.
  * When the HTLC is ready, the agent signs the EIP-712 payload locally and submits it to the Router.
  * **The Router never holds the user's private key.**

---

## 13. ROUTER REUSE MAP

| Required Self-Hosted Rail Component | Universal Router Status | Gap to Close |
| :--- | :--- | :--- |
| Execution Graph & AssetNode | **ALREADY_HAVE** | None. |
| SQLite Persistence & Journal | **ALREADY_HAVE** | None. |
| Concurrency & Dispatch Claims | **ALREADY_HAVE** | None. |
| Base RPC Settlement Verifier | **ALREADY_HAVE** | None. |
| HTLC State Machine | **PARTIAL_REUSE** | Add `SERVER_FUNDED`, `CLAIMING` states. |
| LND Hold-Invoice Controller | **EXTERNAL_INFRA_REQUIRED** | Deploy LND daemon + gRPC client. |
| Arbitrum HTLC Funder / Relayer | **NEED_NEW** | Build transaction manager with Viem/Ethers. |
| Liquidity & Inventory Manager | **NEED_NEW** | Build capital balancing module. |

---

## 14. MINIMAL SELF-HOSTED ARCHITECTURE

```
┌─────────────────────────────────────────────────────────────┐
│                       CLIENT / AGENT                        │
│   • Generates Secret & Preimage                             │
│   • Signs EIP-712 Redeem Digest                             │
└──────────────────────────────┬──────────────────────────────┘
                               │ HTTP
                               ▼
┌─────────────────────────────────────────────────────────────┐
│             ROUTER ATOMIC COORDINATOR DAEMON                │
│   • Router Core (Graph, SQLite, Idempotency)                │
│   • LND InvoicesRPC Manager (Hold Invoices)                 │
│   • Arbitrum Contract Funder & Gasless Relayer              │
│   • 1inch Quote & DEX Calldata Client                       │
└──────────────┬───────────────────────────────┬──────────────┘
               │ gRPC                          │ RPC
               ▼                               ▼
       ┌───────────────┐               ┌───────────────┐
       │   LND NODE    │               │  ARBITRUM L2  │
       │ (Hold Invoices│               │(HTLCErc20.sol │
       │  & Channels)  │               │ Coordinator)  │
       └───────────────┘               └───────┬───────┘
                                               │ CCTP
                                               ▼
                                       ┌───────────────┐
                                       │    BASE L2    │
                                       │ (Canonical    │
                                       │  Circle USDC) │
                                       └───────────────┘
```

---

## 15. INFRASTRUCTURE & OPERATIONAL BURDEN

To self-host this rail, a solo developer must operate:
1. **LND Node**: Requires continuous uptime, public routing channels, channel backups, and rebalancing.
2. **Arbitrum RPC / Hot Wallet**: Requires maintaining ETH for gas and `tBTC` inventory.
3. **Coordinator Worker**: Continuous background daemon.
4. **Maintenance Assessment**: **NOT "SET AND FORGET"**. Requires active monitoring of Lightning liquidity and L2 hot-wallet balances.

---

## 16. SECURITY & BLAST RADIUS

* **Operator Key Compromise**:
  * Attacker compromises coordinator key: **Operator's hot inventory (`tBTC` and Lightning channel funds) is stolen**.
  * Can attacker steal user funds in flight? **NO**. In-flight funds are protected by the user's secret hashlock.
* **Client Key Compromise**: Isolated to client's individual swap.

---

## 17. FAILURE & RECOVERY MODEL

| Failure Scenario | Recovery Path | Funds Protected? | Trustless? |
| :--- | :--- | :--- | :--- |
| **Payer aborts before funding** | Invoice expires naturally. | Yes (0 satoshis spent) | Yes |
| **Coordinator fails to fund HTLC** | Lightning hold invoice expires and cancels. Satoshis return to user. | Yes | Yes |
| **Coordinator funds, user vanishes** | After timelock (e.g. 24h), coordinator reclaims `tBTC` via `refundTo`. | Yes | Yes |
| **Coordinator disappears permanently** | User runs `doomsday` or calls contract directly with secret. | Yes | Yes |
| **CCTP mint delays on Base** | User or any relayer can manually call `receiveMessage` on Base. | Yes | Yes |

---

## 18. SELF-HOST COMPLETENESS SCORE

**QUALITATIVE BAND: 50% – 69% (Estimated ~55%)**
* **Available (55%)**: Production-verified smart contracts (`HTLCErc20`, `HTLCCoordinator`, `CCTPBridgeAdapter`), client SDK, EIP-712 cryptographic specifications, OpenAPI schemas.
* **Missing (45%)**: Coordinator daemon, LND hold-invoice integration, relayer service, liquidity/inventory engine.

---

## 19. BUILD ESTIMATE

For 1 experienced developer with AI coding tools:
* **Phase A: LND Hold Invoice & Local Regtest Simulation**: 1.5 weeks.
* **Phase B: Arbitrum HTLC Funder & Gasless Relayer Service**: 2 weeks.
* **Phase C: 1inch DEX & Circle CCTP Integration**: 1 week.
* **Phase D: Router Integration as `ATOMIC_EDGE`**: 1 week.
* **Total Estimate**: **5.5 – 6 weeks**.
* **Highest Uncertainty**: Managing LND inbound channel liquidity and automated rebalancing.

---

## 20. BUY VS. BUILD VS. HYBRID

| Dimension | Option A: Hosted Satora Edge | Option B: Full Self-Hosted Rail | Option C: FixedFloat Primary (Current) |
| :--- | :--- | :--- | :--- |
| **Setup Time** | ~1 week (Build client adapter) | ~6 weeks (Build full coordinator) | **0 weeks (100% complete)** |
| **Trust Model** | Trust-minimized (Atomic HTLC) | 100% Sovereign (Atomic HTLC) | Centralized exchange |
| **Capital Required** | **$0** (Satora provides liquidity) | **$2,000–$5,000** in inventory | **$0** |
| **Node Overhead** | None | **LND + Arbitrum hot wallet** | None |
| **Agent Key Burden** | EVM key for EIP-712 | EVM key for EIP-712 | **None (Zero keys)** |
| **Maintenance** | Low | **High (Channel management)** | Zero |

---

## 21. SATORA-DISAPPEARS-TOMORROW ANALYSIS

If `satora.io` and `api.satora.io` shut down permanently:
* **A. Recover existing user swaps?**: **YES**. Smart contracts on Arbitrum are immutable; users can claim or refund trustlessly.
* **B. Create new swaps?**: **NO**. Requires our own coordinator and liquidity.
* **C. Generate quotes?**: **NO**.
* **D. Source counterparty liquidity?**: **NO**.
* **E. Operate Lightning atomic side?**: **NO**.
* **F. Deliver canonical USDC/Base?**: **NO**.

---

## 22. FINAL RECOMMENDATION

1. **Phase 3A PoC (Immediate)**:
   * **Do NOT self-host Satora now**.
   * Wait for FixedFloat `BTCLN.recv` maintenance to clear. FixedFloat is already 100% built, tested (96 tests pass), requires zero capital, and operates with zero private keys.
2. **Phase 4 (Decentralized Atomic Edge)**:
   * Do NOT build the full self-hosted coordinator daemon immediately.
   * Instead, write an `IExecutionEdge` adapter that interfaces with **hosted Satora (`api.satora.io`)** as a non-custodial `ATOMIC_EDGE`. This gives us non-custodial atomic swaps and 356-sat minimums without the burden of running an LND routing node or holding inventory.
3. **Phase 5 (Full Sovereign Rail)**:
   * If volume justifies it and capital is allocated, fork the MIT smart contracts and build the private coordinator daemon described in Section 14.

---

## 23. EVIDENCE & SOURCES

* **Satora Contracts Repository**: `https://github.com/satoraHQ/lendaswap-contracts` (Branch `main`, MIT License)
* **`CCTPBridgeAdapter.sol`**: Lines 16–26, Circle V2 Forwarding integration.
* **`HTLCCoordinator.sol`**: Lines 17–30, EIP-712 gasless `redeemAndExecute`.
* **`regtest-devenv`**: `compose.yaml` (LND v0.19.3-beta, CLN v25.09.3).
* **Satora Client SDK**: `https://github.com/satoraHQ/satora-sdk` (MIT License).
* **Satora Live API**: `https://api.satora.io/api-docs/openapi.json` (OpenAPI 3.1.0).
