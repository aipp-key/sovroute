# Universal Agent Asset Router
**Sovereign Agent-Native Asset Execution Infrastructure**  
*Architecture V4 — Sovereign Atomic Core*

---

## Overview

The **Universal Agent Asset Router** is a sovereign, deterministic, non-custodial asset execution engine designed specifically for autonomous AI agents and automated software systems. 

Rather than relying on third-party custodial web services, centralized bridges, or hosted swap aggregators, the Router owns its **primary execution rail** using cryptographically atomic protocols.

### Primary Route

$$\mathbf{BTC\ (Lightning\ Network)\ \longrightarrow\ Canonical\ USDC\ (Base\ L2)}$$

The initial product solves this route through:
1. **Lightning Hold Invoices**: Payer locks satoshis off-chain to a 32-byte hashlock $H$.
2. **Arbitrum One HTLC**: Coordinator locks counterparty `tBTC` collateral on EVM using the identical hashlock $H$.
3. **Atomic Claim & Settlement**: The agent/client reveals the secret preimage $S$ to claim `tBTC` on EVM, instantly enabling the coordinator to settle the satoshis on Lightning.
4. **Canonical Base Delivery**: `tBTC` is converted to USDC on Arbitrum and bridged directly to canonical Base USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) via Circle CCTP.

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
- Node.js v22+ (v24 LTS recommended)
- Python 3.10+ (for secret scanning)

### 1. Run Tests (100% Offline)
```bash
npm test
```
*Executes all 134 automated tests including 38 sovereign atomic core security tests.*

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
