# UNIVERSAL AGENT ASSET ROUTER
## PHASE 2C: LND IMPLEMENTATION GATES SPECIFICATION (FROZEN SPECIFICATION)

---

### 1. OVERVIEW & GATE METHODOLOGY

All subsequent engineering activity is organized into strict, sequential, owner-approved implementation gates.

Each gate requires:
- **Explicit Owner Approval** before execution.
- **Strict Verifiable Preconditions**.
- **Defined, Isolated Actions**.
- **Zero Production Mutation** outside the gate's scope.
- **Objective Exit Criteria**.

---

### 2. IMPLEMENTATION GATE PROGRESSION

```
[Phase 2C: Architecture Preflight] (FROZEN DESIGN SPECIFICATION)
        |
        v [Owner Approval Gate]
[Phase 2D: Bitcoin Core IBD Completion Gate]
        |
        v [Owner Approval Gate]
[Phase 2E: LND Base Installation - Zero Wallet]
        |
        v [Owner Approval Gate]
[Phase 2F: LND Wallet Initialization & Physical Seed Custody]
        |
        v [Owner Approval Gate]
[Phase 2G: Bitcoin Core <-> LND Backend Integration]
        |
        v [Owner Approval Gate]
[Phase 2H: LND Zero-Fund Reliability Burn-In]
        |
        v [Owner Approval Gate]
[Phase 2I: Router <-> LND Restricted API Integration]
        |
        v [Owner Approval Gate]
[Phase 2J: Tiny Real-BTC Canary Verification]
```

---

### 3. GATE DEFINITIONS & APPROVAL REQUIREMENTS

#### GATE 2D: Bitcoin Core IBD Completion Gate
- **Precondition**: Bitcoin Core 31.1 running outbound-only, healthy, advancing.
- **Objective**: Certify Initial Block Download is 100% complete before introducing LND.
- **Actions**: Read-only verification of block height, chain tip, verification progress.
- **Approval Required**: Owner certifies Bitcoin Core readiness.

#### GATE 2E: LND Base Installation — Zero Wallet
- **Precondition**: Phase 2D certified.
- **Objective**:
  - Verify official release `v0.21.3-beta` via signed manifest (`manifest-v0.21.3-beta.txt.sig`) using Lightning Labs developer GPG release keys.
  - Execute official `/verify-install.sh` verification routine.
  - Retrieve and record the certified official Docker image sha256 digest at deploy time (no invented digests).
  - Create directory structure under `/srv/sovereign-router/lightning/` with UID `2102:2102`.
  - Deploy hardened Compose definition with `read_only: true`, `cap_drop: ALL`.
- **Hard Guard**: DO NOT create wallet. DO NOT start wallet daemon.
- **Approval Required**: Owner approves filesystem & compose deployment.

#### GATE 2F: LND Wallet Initialization & Physical Seed Custody
- **Precondition**: Phase 2E verified.
- **Objective**: Interactive wallet generation via `lncli create`.
- **Hard Guard**:
  - The 24-word aezeed recovery mnemonic must never be stored in plaintext on production server storage, logs, Git, environment variables, or documentation.
  - Mnemonic recorded onto physical offline cold storage.
  - Test seed reconstruction executed offline.
- **Approval Required**: Owner confirms physical possession of 24-word seed.

#### GATE 2G: Bitcoin Core ↔ LND Backend Integration
- **Precondition**: Phase 2F complete.
- **Objective**:
  - Update Bitcoin Core configuration to enable RPC and ZMQ over `sovereign_chain_net` (`10.240.10.2`).
  - Configure `rpcauth` on bitcoind and secret password file on LND.
  - Start LND and verify `synced_to_chain=true`.
- **Hard Guard**: Zero channels open. Zero BTC funded. Port 9735 remains closed.
- **Approval Required**: Owner approves chain backend integration.

#### GATE 2H: LND Zero-Fund Reliability Burn-In
- **Precondition**: Phase 2G complete.
- **Objective**: 24-hour zero-fund burn-in test. Verify memory, CPU, AIPP isolation, restart stability.
- **Hard Guard**: Zero funds on node.
- **Approval Required**: Owner reviews 24h burn-in telemetry.

#### GATE 2I: Router ↔ LND Restricted API Integration
- **Precondition**: Phase 2H passed.
- **Objective**:
  - Mint receive-only `router.macaroon` under dedicated Root Key ID `100`.
  - Mount TLS cert and restricted macaroon into Router service.
  - Verify health check, invoice creation, invoice lookup over Docker internal network.
- **Hard Guard**: Test invoices only. Outbound payment permission DENIED. Zero real fund movement.
- **Approval Required**: Owner approves API linkage.

#### GATE 2J: Tiny Real-BTC Canary Verification
- **Precondition**: Phase 2I passed.
- **Objective**: Execute tiny test transaction to certify end-to-end integration.
- **Funding Amount Policy**: **UNDECIDED — OWNER APPROVAL REQUIRED**. The exact amount will be determined based on channel minimums, reserves, and routing fees at the time of execution. No amount is pre-authorized.
- **Hard Guard**: Hard maximum funding limit strictly enforced.
- **Approval Required**: Owner explicitly authorizes the exact satoshi funding amount.

---
*End of Implementation Gates Specification.*
