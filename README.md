# SovRoute
**Sovereign Agent-Native Asset Execution Infrastructure**  
*Architecture V4 — Sovereign Atomic Core*  
**Website**: [https://sovroute.com](https://sovroute.com)

---

## Overview

**SovRoute** (formerly developed under the *Universal Agent Asset Router* project name) is a sovereign, deterministic, non-custodial asset execution engine designed specifically for autonomous AI agents and automated software systems. 

Rather than relying on third-party custodial web services, centralized bridges, or hosted swap aggregators, SovRoute owns its **primary execution rail** using cryptographically atomic protocols.

### Primary Route

$$\mathbf{BTC\ (Lightning\ Network)\ \longleftrightarrow\ Canonical\ USDC\ (Base\ L2)}$$

The initial product solves this route through a direct cross-rail atomic swap:
1. **Client Hashlock Creation**: Client/agent generates secret preimage $S$ and computes hashlock $H = \text{SHA-256}(S)$. Only $H$ is shared with the Router.
2. **Lightning Hold Invoice**: Router creates a BOLT11 hold invoice using hashlock $H$. The client locks satoshis off-chain on Lightning (`ACCEPTED` hold state).
3. **Base Inventory Reservation**: Router reserves canonical native Circle USDC inventory directly on Base L2.
4. **Direct Base HTLC Funding**: Router locks canonical Base USDC into the immutable `HtlcErc20` contract directly on Base using the identical hashlock $H$ (`EVM_FUNDED`).
5. **Atomic Claim & Preimage Revelation**: Client reveals secret preimage $S$ directly on Base to claim canonical USDC to their destination address (`CLAIMED`).
6. **Atomic Lightning Settlement**: The confirmed on-chain claim reveals preimage $S$, enabling the Router to settle the held satoshis on Lightning (`SETTLED`).
7. **Safe Timelock Refund**: If the client does not claim before the Base timelock expires, the Router reclaims its USDC via on-chain refund and safely cancels the held Lightning invoice (0 satoshis lost, 0 funds stuck).

**Key Architectural Properties:**
- **Direct Base**: The atomic EVM customer leg executes directly on Base L2 (`contracts/HtlcErc20.sol`).
- **Zero Arbitrum / Zero tBTC**: Customer settlement token is canonical native Circle USDC directly on Base.
- **Zero CCTP in Customer Critical Path**: No cross-chain bridge dependencies during a swap. (CCTP is strictly decoupled for asynchronous background treasury replenishment only).
- **Zero DEX in Customer Critical Path**: Operator quotes fixed rates against native Base USDC inventory; zero slippage or sandwich attack risks.
- **Isolated External Fallbacks**: Hosted swap providers (FixedFloat, SideShift) are optional, disabled-by-default secondary plugins.

---

## Core Security Invariants

The engine strictly enforces 25 frozen security invariants (`SECURITY_MODEL_V1.md`):

* **SEC-1 & SEC-2 (Strict Non-Custodial)**: The Router **never** stores, sees, or handles user private keys, mnemonics, or seed phrases.
* **SEC-5 & SEC-14 (Durable Action Ownership)**: Exactly one worker process can claim outbound side effects via SQLite CAS locks.
* **SEC-6 (No Blind Retries)**: Ambiguous outbound financial side effects are never automatically retried.
* **SEC-9 (No False Failures)**: Transitions to ordinary `FAILED` are strictly prohibited once source funds are held or moved.
* **SEC-10 (Mutual Exclusion)**: Claim and refund paths are cryptographically and programmatically mutually exclusive.
* **SEC-15 & SEC-16 (Zero Hosted Vendor Requirement)**: The core engine, build, and test suite run 100% offline without any hosted swap provider credentials (`FIXEDFLOAT_API_KEY`, `SATORA_API_KEY`, etc.).
* **SEC-21 (Consensus Timelocks)**: Timelock verification relies strictly on authoritative on-chain block timestamps.

---

## Architecture & Project Structure

```
src/
├── domain/                  # Core immutable types, interfaces, errors
├── state-machine/           # Sovereign atomic state machine engine
├── persistence/             # SQLite storage, WAL, durable claims, journals
├── routing/                 # Sovereign planner (Lightning -> Base USDC)
├── evidence/                # Independent cryptographic and RPC verifiers
│
├── atomic/                  # SOVEREIGN ATOMIC EXECUTION CORE
│   ├── coordinator/         # AtomicCoordinator (manages dual-leg swap lifecycle)
│   ├── lightning/           # ILightningAtomicBackend & Fake/LND implementations
│   ├── evm/                 # IEvmAtomicBackend & Contract callers
│   ├── liquidity/           # Operator inventory reservation abstraction
│   └── recovery/            # Crash reconciler and timeout sweepers
│
└── adapters/                # OPTIONAL PLUGINS (ISOLATED)
    └── external/            # Third-party vendor fallbacks (FixedFloat, etc.)
```

---

## Quickstart & Verification

### Prerequisites
- Node.js 24 LTS (v24.12.0 certified)
- Python 3.10+ (for secret scanning)

### 1. Run Tests (100% Offline)
```bash
npm test
```
*Executes all 245 automated unit tests across 45 suites, including 38 sovereign atomic core security tests, 21 liquidity accounting safety tests, 40 Base USDC inventory reconciliation safety tests, 16 fail-closed hardening tests (FF-1 through FF-10), 6 production bootstrap safety tests, and multiple OS-level cross-process concurrency and transactional freshness certification tests.*

### 2. Run TypeScript Typecheck
```bash
npm run typecheck
```

### 3. Verify Secret Sanitization
```bash
python tests/scan-secrets.py
```

### 4. Run Sovereign Atomic Core Demo
```bash
npm run quote:demo
```

---

## Optional External Adapters

Centralized providers (e.g. FixedFloat, SideShift) have been isolated into `src/adapters/external/`.
* They are **disabled by default**.
* The core build, test suite, and execution graph do not require them.
* They serve purely as secondary fallback plugins for optional multi-asset extensions.

---

## Documentation

* [`SECURITY_MODEL_V1.md`](SECURITY_MODEL_V1.md): Comprehensive 30-threat model and 25 frozen security invariants.
* [`ARCHITECTURE_V4_SOVEREIGN_CORE.md`](ARCHITECTURE_V4_SOVEREIGN_CORE.md): Full 33-section Architecture V4 specification.
* [`SOVEREIGN_CORE_REBASE_REPORT.md`](SOVEREIGN_CORE_REBASE_REPORT.md): Summary of architectural rebase and verification results.
* **Base Sepolia Contract**: [`0x3e4b1374d2a42ed3aca3470978fc4ec52914ae6f`](https://sepolia.basescan.org/address/0x3e4b1374d2a42ed3aca3470978fc4ec52914ae6f)

---

## License

This project is free, open-source software released under the [MIT License](LICENSE).

