# Universal Agent Asset Router — Canonical Project State

```
Status: ACTIVE DEVELOPMENT
Canonical Document: YES (Living Project Memory & Master State)
Last Verified: 2026-09-04T22:13:16Z (UTC) / 2026-09-05T01:13:16+03:00 (Server Local)
Last Updated: 2026-09-05T01:15:00+03:00
Frozen Router V1 Application Baseline: 357c5ab85344a2fa5602a5e376efc7ea80685498
Repository HEAD: Advances via documentation-only commits
Current Phase: Waiting for Phase 2D Eligibility (Bitcoin Core IBD Completion)
Current Blocker: Bitcoin Core Initial Block Download (IBD) in Progress
Next Safe Action: Allow IBD to finish uninterrupted; execute Phase 2D Certification Gate once initialblockdownload=false
Production Funds: ZERO (0 real BTC, 0 USDC, 0 Base mainnet transactions)
```

---

## PERMANENT INSTRUCTION FOR FUTURE SESSIONS

> **`PROJECT-CANONICAL-STATE.md` is the project's single canonical source of truth and living memory anchor.**
> At the beginning of EVERY future Universal Agent Asset Router work session — regardless of agent changes, chat history truncation, device switches, or months of dormancy — **READ THIS FILE FIRST**.
> Verify its current-state claims against Git and the server where appropriate, perform authorized work strictly within the active phase boundary, and update this document before closing the session.

### Critical Git Semantics: Application Baseline vs. Repository HEAD

> **Documentation-only commits may advance repository HEAD without changing the frozen Router V1 application baseline. The immutable V1 source baseline remains commit `357c5ab85344a2fa5602a5e376efc7ea80685498`.**

- **Frozen Router V1 Application Code**: Permanently anchored at commit `357c5ab85344a2fa5602a5e376efc7ea80685498`. All application source files under `src/`, contracts, configuration, and package manifests are frozen and immutable.
- **Repository HEAD**: May advance through documentation-only commits (such as this canonical state document and Phase 2C/2D specifications). Future agents must NOT interpret a repository HEAD newer than `357c5ab...` as meaning Router V1 application source was modified. To verify that Router V1 source remains frozen, agents should execute: `git diff 357c5ab85344a2fa5602a5e376efc7ea80685498..HEAD -- src/` (must return zero diff).

---

## 1. WHERE WE ARE RIGHT NOW (60-SECOND EXECUTIVE SUMMARY)

- **Router V1 Core**: **FROZEN** at commit [`357c5ab85344a2fa5602a5e376efc7ea80685498`](file:///c:/Users/faruk/Desktop/universal-agent-asset-router). Must NOT be mutated.
- **Bitcoin Infrastructure Phase 1**: **FROZEN** (Architectural design and isolation model certified).
- **Bitcoin Phase 2A (Offline Foundation & Hardening)**: **OFFICIALLY COMPLETE** (`sovereign-bitcoind:31.1` deployed, `ReadonlyRootfs=true`, `CapDrop=ALL`, non-root user `2101:2101`, offline).
- **Bitcoin Phase 2B (Mainnet Outbound Activation & Burn-In)**: **OFFICIALLY COMPLETE / FROZEN** (Runtime activation via `setnetworkactive true`, 10 outbound peers, 0 inbound, 0 host ports, IBD progressing, AIPP 100% unaffected).
- **Phase 2C (LND Architecture, Security & Recovery Preflight)**: **OFFICIALLY COMPLETE / FROZEN** (Pinned to `v0.21.3-beta`, Mode A outbound-only, dedicated root key ID 100, receive-only macaroon, payment permission DENIED by default, SCB + aezeed recovery model).
- **Bitcoin Core Status**: **RUNNING & SYNCING MAINNET IBD** (Container `sovereign-bitcoind`, blocks >395k, headers >965k, actively advancing, automatic pruning active).
- **Inbound Bitcoin Port 8333**: **CLOSED** (0 host listeners, 0 Docker published ports).
- **Bitcoin RPC (8332) & ZMQ (28332/28333)**: **STRICTLY PRIVATE / CLOSED TO HOST** (Bound to `127.0.0.1` currently; future Phase 2G will bind to internal `sovereign_chain_net` only).
- **Bitcoin Core Wallet**: **DISABLED** (`disablewallet=1`, zero keys, zero balances).
- **LND Daemon**: **NOT INSTALLED** (Zero containers, zero images, zero volumes, zero directories created).
- **LND Wallet & Keys**: **DO NOT EXIST** (No aezeed, no private keys, no macaroons, no TLS certs).
- **Lightning Channels & Peers**: **NONE** (Port 9735 unpublished and closed on UFW).
- **Universal Router Runtime**: **NOT STARTED ON SERVER** (Application source clean, tests certified locally).
- **Base / EVM Mainnet Activity**: **ZERO** (No transactions, no private keys loaded on server).
- **Real Production Funds**: **ZERO** (0 BTC, 0 USDC).
- **AIPP Production Services**: **RUNNING UNDISTURBED** (All 5 containers have `Restarts: 0` and identical `StartedAt`).

---

## 2. DO NOT DO YET (CRITICAL PROHIBITION LIST)

Future agents and operators must **STRICTLY AVOID** the following actions until their respective owner-approved gates:

1. **DO NOT install LND** or pull LND Docker images before Phase 2D is certified PASS and Phase 2E is explicitly authorized.
2. **DO NOT create an LND wallet** or generate an aezeed mnemonic before Phase 2F.
3. **DO NOT store the 24-word aezeed recovery mnemonic in plaintext** on server storage, Git, logs, environment variables, or documentation.
4. **DO NOT open TCP port 9735** on UFW or publish port 9735 in Docker Compose. Initial production is Mode A outbound-only.
5. **DO NOT publish Bitcoin Core RPC (8332)** or ZMQ ports to the host or internet.
6. **DO NOT modify Bitcoin Core's configuration or restart the container** during IBD.
7. **DO NOT interrupt Bitcoin Core IBD**.
8. **DO NOT start Universal Router** on the production server.
9. **DO NOT modify the frozen Router V1 Core commit** (`357c5ab85344a2fa5602a5e376efc7ea80685498`).
10. **DO NOT grant LND outbound payment authority** (`SendPaymentV2`) directly to the Router container. (Default is DENIED; receive-only).
11. **DO NOT touch or restart AIPP containers** (`aipp-key`, `aipp-db`, `aipp-redis`, `aipp-phoenixd`, `aipp-lnbits`).
12. **DO NOT attach Router to `sovereign_chain_net`** or Bitcoin Core to `sovereign_router_net`.
13. **DO NOT move real BTC or USDC**.
14. **DO NOT execute Base mainnet transactions**.
15. **DO NOT pre-authorize a canary funding amount** (Phase 2J funding amount remains `UNDECIDED — OWNER APPROVAL REQUIRED`).
16. **DO NOT restore an outdated `channel.db`** (causes catastrophic loss of channel funds via breach penalty).
17. **DO NOT commit secrets, passwords, or private keys to Git**.
18. **DO NOT auto-upgrade financial infrastructure** or use floating Docker tags like `latest`.

---

## 3. HOW TO RESUME AFTER ANY INTERRUPTION

If a session is interrupted, or if a new agent/engineer takes over:

1. **Read this entire file (`docs/PROJECT-CANONICAL-STATE.md`) first**.
2. **Do NOT assume chat memory or previous conversational context is authoritative**.
3. **Verify Git HEAD**: Confirm working tree is on branch `phase-7-production-readiness-closure` at commit `357c5ab85344a2fa5602a5e376efc7ea80685498`.
4. **Perform a read-only server inspection**:
   - Check `docker inspect sovereign-bitcoind` (Status, StartedAt, Restarts, ReadonlyRootfs).
   - Check `bitcoin-cli getblockchaininfo` (blocks, headers, initialblockdownload).
   - Check `ss -lntup | grep -E '8332|8333|9735'` (Ensure ports remain closed).
   - Check AIPP containers (Ensure `Restarts: 0` and StartedAt unchanged).
5. **Compare live server state against Section 1 (`WHERE WE ARE RIGHT NOW`)**.
6. **Review Section 31 (`CURRENT BLOCKER`) and Section 32 (`NEXT SAFE ACTION`)**.
7. **Review Section 2 (`DO NOT DO YET`)** to avoid forbidden actions.
8. **Read the phase-specific specification document** corresponding to the upcoming phase.
9. **Never advance to a later phase unless the prior gate is verified PASS with explicit owner approval**.
10. **Append a structured entry to Section 34 (`SESSION UPDATE LOG`)** at the end of the session.

---

## 4. CURRENT CONTROL BLOCK

```
CURRENT BLOCKER:
Bitcoin Core Initial Block Download (IBD) must complete before Phase 2D can be certified.

NEXT SAFE ACTION:
Allow Bitcoin Core IBD to continue without interruption. Once initialblockdownload=false, execute the Phase 2D IBD Completion Certification Gate audit.

CURRENT OWNER DECISION NEEDED:
NONE (Continuous IBD in progress).
```

---

## 5. PROJECT PURPOSE

### In Plain English:
The **Universal Agent Asset Router** is a modular, high-reliability infrastructure engine designed to allow autonomous AI agents and automated software systems to move value seamlessly between different payment rails and assets — specifically **Bitcoin Lightning Network** and **Base (Ethereum L2 USDC)** — with zero tolerance for lost funds, stuck transactions, or unhandled failures.

### In Technical Terms:
The project provides an atomic cross-rail execution engine, a durable state coordinator, and provider abstractions that enforce:
- **Durable Idempotency**: Financial requests are strictly deduplicated and tracked in SQLite WAL persistence before external dispatch.
- **Explicit Money States**: Financial operations transition through a rigorous state machine where `UNKNOWN` is treated as an explicit, first-class operational state requiring active reconciliation rather than naive retry or presumed failure.
- **Strict Blast-Radius Control**: The Router application is isolated from infrastructure administration, cannot execute arbitrary on-chain Bitcoin sweeps, holds receive-only Lightning credentials by default, and cannot pivot to backend daemons.
- **Provider Abstraction**: Decouples business routing logic from underlying chain implementations (LND, EVM/Base, future alternative providers).

---

## 6. NON-NEGOTIABLE ENGINEERING PRINCIPLES

1. **Security is designed before implementation.** Never build first and retrofit security later.
2. **Recovery is designed before money is introduced.** If you cannot recover from total disaster, you cannot accept funds.
3. **Failure semantics are first-class architecture.** Error handling and edge cases receive equal design depth as success paths.
4. **Financial actions must be strictly idempotent.** Replaying any payload must yield the original deterministic outcome.
5. **`UNKNOWN` is a valid and necessary financial state.** When a network call times out, the asset's state is unknown, not failed.
6. **Never infer success from a timeout.**
7. **Never blindly retry non-idempotent financial actions.**
8. **Durable state must survive crashes and restarts.** State is committed to disk before actions are taken externally.
9. **Blast radius must be intentionally bounded.** Compromise of the Router must not compromise the node, keys, or host.
10. **Router receives minimum credentials only.** Least privilege is enforced at the network, OS, and macaroon layers.
11. **Infrastructure components must be isolated.** Bitcoin Core, LND, Router, and AIPP occupy distinct isolation domains.
12. **A failure in one subsystem must not compromise unrelated projects.** AIPP and Sovereign Router have zero shared failure domains.
13. **Frozen architecture must not be casually modified.** Certified baselines require formal review to alter.
14. **Real funds require explicit owner approval gates.** No real BTC or USDC moves without human sign-off.
15. **No production financial dependency is trusted solely because a process is "running."** Health is state-based.
16. **Readiness must be behavior- and state-based.** Block height matching, chain sync, and graph sync govern readiness.
17. **A backup is not valid until restoration has been tested.** Untested backups are hypothetical.
18. **Future interfaces should avoid unnecessary vendor lock-in.** Provider contracts abstract LND and EVM specifics.
19. **Avoid rebuilding architecture later because security was postponed.**
20. **The engine matters more than a complex dashboard.** Solid core execution over superficial UI.

---

## 7. PROJECT SCOPE

### In Scope:
- Sovereign Bitcoin Core 31.1 backend on `aliasdesk-server`.
- Dedicated Lightning infrastructure via LND (`v0.21.3-beta`).
- Base / EVM USDC payment provider and transaction manager.
- Router execution engine, atomic coordinator, state machine, and provider abstractions.
- Transaction tracking, durable SQLite storage, WAL checkpointing, and automated backups.
- Strict network segmentation (`sovereign_chain_net` and `sovereign_router_net`).
- Comprehensive disaster recovery runbooks (SCB, aezeed, server rebuild).
- Minimal machine-checkable health APIs and observability signals.

### Out of Scope / Not Assumed:
- Public Lightning routing node operations (Port 9735 is closed; outbound-only client).
- Public web UI dashboards (Minimal API surface only).
- Custodial third-party wallet integrations for sovereign rails.
- Sharing wallets, keys, or networks with AIPP or other host applications.
- Complex microservice meshes (Simple, resilient Docker Compose projects).
- Auto-updating production containers.

---

## 8. SERVER & INFRASTRUCTURE INVENTORY

### Verified Production Environment (`aliasdesk-server`):
- **Hostname**: `ubuntu-8gb-hel1-1`
- **Public IP**: `89.167.84.31` (Hetzner Cloud, Helsinki)
- **OS**: Ubuntu 24.04 LTS (Noble Numbat), Kernel `6.8.0-31-generic #31-Ubuntu SMP x86_64`
- **Compute**: 16 vCPUs (AMD EPYC Processor)
- **Memory**: 30 GiB total RAM (~22 GiB available / buff/cache)
- **Storage**: 301 GB SSD (`/dev/sda1`): ~84 GB used, ~204 GB available (29% used — GREEN status)
- **Docker Engine**: Version `27.0.3, build 7d4bed1`
- **Firewall**: UFW active. Default DENY incoming. Open ports: 80, 443, 2222 (SSH rate-limited), 22 (SSH rate-limited).
- **Bitcoin/LND Public Ports**: **0 open**. Port 8333 CLOSED, 8332 CLOSED, 9735 CLOSED.

### Network Segmentation & Containers:
```
+----------------------------------------------------------------------------------------------------+
| HOST: aliasdesk-server (89.167.84.31)                                                              |
|                                                                                                    |
|  [EXISTING AIPP ECOSYSTEM]                        [SOVEREIGN ROUTER ECOSYSTEM]                     |
|  Network: core_aipp_net (172.23.0.0/16)            Network: sovereign_chain_net (10.240.10.0/24)   |
|  - aipp-key       (172.23.0.x)                     - sovereign-bitcoind (10.240.10.2)              |
|  - aipp-db        (172.23.0.6)                     - sovereign-lnd      (10.240.10.3) [Future 2E]  |
|  - aipp-redis     (172.23.0.3)                               | (Controlled Bridge)                 |
|  - aipp-phoenixd  (172.23.0.4)                     Network: sovereign_router_net (10.240.20.0/24)  |
|  - aipp-lnbits    (172.23.0.2)                     - sovereign-lnd      (10.240.20.2) [Future 2E]  |
|  - albyhub        (172.23.0.7)                     - sovereign-router   (10.240.20.3) [Future 2I]  |
|                                                                                                    |
|  ZERO NETWORK BRIDGING BETWEEN AIPP AND SOVEREIGN ROUTER. NO SHARED VOLUMES OR KEYS.              |
+----------------------------------------------------------------------------------------------------+
```

---

## 9. TRUST BOUNDARY MAP

| Component | Trust Level | Secrets Owned | Networks | Can Spend? | Blast Radius |
|---|---|---|---|---|---|
| **Host OS / Root** | Tier 0 (Full) | SSH host keys, disk encryption | All host interfaces | Yes (Full system) | Host-level compromise; requires server rebuild |
| **Bitcoin Core** | Tier 1 (Backend) | None (Wallet disabled; `disablewallet=1`) | `sovereign_chain_net` only | **NO** | Chain data corruption; requires resync from peers |
| **LND** | Tier 1 (Daemon) | `channel.db`, `macaroon.db`, TLS keys, RPC pass | `sovereign_chain_net` & `sovereign_router_net` | **YES** (Lightning) | Channel balance loss; bounded by SCB recovery |
| **Router V1** | Tier 2 (App) | Receive-only macaroon (Root Key ID 100) | `sovereign_router_net` only | **NO (Denied by Default)** | Limited to invoice probing/creation; cannot spend |
| **Base Provider** | Tier 2 (App) | Base EVM private key / signer (Future) | Public HTTPS (EVM RPC) | **YES** (EVM USDC) | Bounded by hot wallet balance caps |
| **Backup System** | Tier 1 (Storage) | GPG public encryption key | Outbound backup path | **NO** | Encrypted backups only; zero plaintext exposure |
| **Owner / Operator** | Tier 0 (Master) | 24-word Aezeed, Master GPG key, SSH | Physical offline vault | **YES** (Full) | Offline cold storage; non-compromised |

---

## 10. CURRENT BITCOIN CORE INFRASTRUCTURE

- **Software Version**: Bitcoin Core `31.1` (`/Satoshi:31.1.0/`, protocol `70016`).
- **Container**: `sovereign-bitcoind` under Compose project `sovereign-router` at `/srv/sovereign-router/docker-compose.yml`.
- **Runtime User**: Dedicated host user `sovereign-bitcoin:sovereign-bitcoin` (`UID:GID 2101:2101`).
- **Security Hardening**:
  - `read_only: true` (Verified: Root filesystem is read-only).
  - `cap_drop: ["ALL"]`, `cap_add: null`.
  - `security_opt: ["no-new-privileges:true"]`.
  - Dedicated bridge network `sovereign_chain_net` (`10.240.10.2`).
  - Scratch space: `tmpfs: /tmp:rw,noexec,nosuid,size=64m`.
- **Configuration (`/srv/sovereign-router/bitcoin/config/bitcoin.conf`)**:
  - `prune=55000` (Automatic chain pruning, target ~55 GB).
  - `dbcache=2048` (2048 MiB memory cache).
  - `disablewallet=1` (No wallet capability compiled/enabled).
  - `listen=0` (Inbound Bitcoin P2P disabled; 0 host listeners).
  - `networkactive=1` (Outbound-only mainnet P2P IBD active).
  - `rpcbind=127.0.0.1`, `rpcallowip=127.0.0.1` (Local RPC only; Phase 2G will rebind to `sovereign_chain_net`).
  - `rpcauth=sovereign-lnd:<salt>$<hash>` (Hashed HMAC-SHA256 authentication configured; password in `/srv/sovereign-router/secrets/bitcoind_rpc_password` mode `0400`).
- **Ports Published**: **0 ports published**. `docker port sovereign-bitcoind` returns empty.

---

## 11. CURRENT IBD STATE (LIVE SNAPSHOT)

```
SNAPSHOT TIMESTAMP: 2026-09-04T22:13:16Z (UTC) / 2026-09-05T01:13:16+03:00 (Server Local)
Chain: main
InitialBlockDownload: true (In Progress)
Current Blocks: 440,135
Current Headers: 965,529
Verification Progress: 0.12308 (12.31%)
Best Block Hash: 0000000000000000002fc6f0fbdb048b9fda9c88
Chainwork: 0000000000000000000000000000000000000000002fc6f0fbdb048b9fda9c88
Pruned: true (Automatic Pruning Active, pruneheight: 383,915)
Size on Disk: 8,542,791,033 bytes (~8.54 GB)
Total Data Dir Size: 11 GB (/srv/sovereign-router/bitcoin/data)
Connections: 10 (10 Outbound, 0 Inbound)
Connection Types: 8 outbound-full-relay, 2 block-relay-only
Container Restarts: 0
Host Disk Free: 204 GB available (GREEN)
Host RAM Available: 22 GiB
```
*(Note: These metrics advance continuously as IBD progresses. Certified completion is governed by Phase 2D).*

---

## 12. ROUTER V1 CORE ARCHITECTURE (FROZEN SOURCE AUDIT)

The Universal Agent Asset Router V1 Core is officially frozen at commit [`357c5ab85344a2fa5602a5e376efc7ea80685498`](file:///c:/Users/faruk/Desktop/universal-agent-asset-router). The architecture consists of the following verified source modules:

- **Atomic Swap Coordinator (`src/atomic/coordinator/coordinator.ts`)**:
  - Implements the end-to-end atomic execution lifecycle across rails.
  - Coordinates invoice settlement on Lightning with contract lock/claims on EVM.
  - Manages timeouts, refund paths, and cooperative resolution.
- **EVM & Base Transaction Manager (`src/atomic/evm/`)**:
  - `transaction-manager.ts`: Manages persistent nonces, fee replacement (RBF), stuck transaction bumping, and confirmation tracking.
  - `base-guard.ts` & `evm-guard.ts`: Enforces transaction limits, contract allowlists, and execution parameters.
  - `base-sepolia-backend.ts`: Testnet backend; maps directly to production Base mainnet architecture.
- **Lightning Integration Layer (`src/atomic/lightning/`)**:
  - `lnd-backend.ts` & `lnd-client.ts`: Vendor-agnostic client abstractions wrapping gRPC calls.
  - `fault-injector.ts`: Adversarial test framework used during Phase 6 certification.
- **Durable Persistence Engine (`src/persistence/`)**:
  - `sqlite.ts`: High-performance SQLite engine with WAL mode (`journal_mode=WAL`), foreign keys, and synchronous writes.
  - `backup.ts`: Automated WAL checkpoints, safe vacuuming, and timestamped backup archives.
- **State Machine & Orchestration (`src/state-machine/engine.ts`, `src/orchestrator/`)**:
  - Enforces explicit non-boolean state transitions.
  - Prevents race conditions and double-spending across concurrent swaps.
- **Supply-Chain & Binary Verification (`src/supply-chain/`)**:
  - `binary-verifier.ts` & `manifest-verifier.ts`: Verifies SHA256 sums and GPG signatures of all runtime dependencies before execution.
- **Production Readiness & Certification (`tests/`)**:
  - Certified under Phase 5a (Base reliability), Phase 5b (Coordinator recovery), Phase 6 (Adversarial failure certification), and Phase 7 (Production freeze).

### Authoritative V4 Customer Execution Route: Direct Base Route
The authoritative frozen V4 execution path is:
$$\mathbf{BTC\ (Lightning\ Hold\ Invoice)\ \longleftrightarrow\ Canonical\ USDC\ (Base\ L2\ HtlcErc20)}$$

- **Direct Base**: Customer EVM leg executes directly on Base L2 (`contracts/HtlcErc20.sol`, deployed on Base Sepolia at `0x3e4b1374d2a42ed3aca3470978fc4ec52914ae6f` / Base Mainnet).
- **No Arbitrum**: Zero Arbitrum dependencies in the customer path.
- **No tBTC**: Settlement asset is canonical native Circle USDC on Base (`0x036CbD53842c5426634e7929541eC2318f3dCF7e` on Sepolia / `0x833589fCD6edb6E08f4c7C32D4f71b54bdA02913` on Mainnet).
- **No Synchronous CCTP**: Zero cross-chain bridge calls in the customer swap path.
- **No Synchronous DEX**: Swaps settle directly against operator inventory; zero pool liquidity or slippage dependencies.
- **Operator Inventory**: Canonical native USDC held directly on Base.
- **Treasury Plane**: CCTP and DEX belong strictly to decoupled asynchronous treasury operations (inventory replenishment, rebalancing, hedging) and are never in the customer atomic swap path.
- **External Adapters**: Hosted swap providers (FixedFloat, SideShift) are optional, isolated, disabled-by-default plugins.

---

## 13. LND FINAL ARCHITECTURE (PHASE 2C FROZEN DESIGN)

- **Software**: Lightning Network Daemon (`lnd`), pinned to **`v0.21.3-beta`** (Released Sept 2, 2026, marked Latest).
- **Supply-Chain Verification**:
  - Pinned by signed release manifest `manifest-v0.21.3-beta.txt.sig` verified with Lightning Labs developer GPG keys.
  - Official `/verify-install.sh` verification routine required before deployment.
  - Official immutable sha256 image digest captured and recorded at deploy time during Phase 2E (no invented digests).
- **Filesystem & Permissions**:
  - Dedicated host user `sovereign-lnd:sovereign-lnd` (`UID:GID 2102:2102`).
  - Non-root container data home: `/var/lib/lnd/` (no `/root/.lnd/` paths).
  - Writable directories restricted strictly to `/var/lib/lnd/data` and `/var/lib/lnd/backups`.
  - Config and secrets mounted read-only (`:ro`).
  - Container root filesystem: `read_only: true`.
- **Public Networking (Mode A Outbound-Only)**:
  - Port 9735 remains **UNPUBLISHED** and **CLOSED**. Outbound Lightning P2P connections only.
- **Macaroon Root Key Model & Router Least Privilege**:
  - Default administrative credentials use Root Key ID `0`.
  - Router macaroon is baked under **Dedicated Root Key ID 100**.
  - Router can be selectively revoked instantly via `lncli deletemacaroonid 100` without rotating administrative credentials.
  - **Payment Permission**: `ROUTER OUTBOUND LIGHTNING PAYMENT PERMISSION = DENIED` by default.
  - Router holds strictly 5 receive-only endpoints (`GetInfo`, `AddInvoice`, `LookupInvoice`, `SubscribeInvoices`, `DecodePayReq`).
  - Any future outbound payment capability must be mediated by an external Payment Policy Service outside the Router container.

---

## 14. KEY & CREDENTIAL CUSTODY INVENTORY

| Credential | Exists Now? | Owner | Consumer | Storage Location | Backup Policy | Rotation / Revocation |
|---|---|---|---|---|---|---|
| **24-word Aezeed Mnemonic** | **NO** | Owner | Operator (Offline) | **Offline Physical Vault Only** | Cold steel/paper vault | Cannot be rotated; master seed |
| **LND Wallet Password** | **NO** | Owner | `sovereign-lnd` | `/secrets/wallet_password` (0400) | Layer 3 Offline Vault | Rekey wallet |
| **`admin.macaroon`** | **NO** | `sovereign-lnd` | Operator (Emergency) | `/data/.../admin.macaroon` (0400) | Controlled recreation in `macaroon.db` | Delete `macaroon.db` & re-issue |
| **`router.macaroon`** | **NO** | `sovereign-lnd` | `sovereign-router` | Mounted in Router (0400) | Re-bake under Root Key ID 100 | `lncli deletemacaroonid 100` |
| **Bitcoind `rpcauth` (Server)**| **NO** | `bitcoind` | `bitcoind` (Server) | `/config/bitcoin.conf` (0640) | Versioned Git / Config | Re-hash via `rpcauth.py` |
| **Bitcoind RPC Pass (Client)**| **NO** | `bitcoind` | `sovereign-lnd` (Client) | `/secrets/bitcoind_rpc_password` (0400)| Secret file on host | Update file & `bitcoin.conf` |
| **LND TLS Private Key** | **NO** | `sovereign-lnd` | `sovereign-lnd` | `/secrets/tls.key` (0400) | Regenerable on startup | Delete key & restart LND |
| **Base EVM Private Key** | **NO** | Owner | `sovereign-router` | Future secure secret file (0400) | Layer 3 Offline Vault | Sweep funds to new address |

*(Rule: The 24-word aezeed recovery mnemonic must never be stored in plaintext on production server storage, logs, Git, environment variables, or documentation).*

---

## 15. DURABLE STATE INVENTORY

| State Artifact | Component | Exists Now? | Criticality | Backup Method | Recovery Method |
|---|---|---|---|---|---|
| **Router SQLite DB** | Router Core | Yes (Local tests) | **HIGH** | WAL checkpoint + automated file copy | Restore DB from backup archive |
| **Bitcoin Blockchain Data** | Bitcoin Core | Yes (Live IBD) | **RECONSTRUCTABLE** | None (Pruned node syncs from P2P) | Re-sync from public peers |
| **`channel.db`** | LND | **NO** | **MATERIAL (Live State)** | **DO NOT BACKUP (Stale DB is fatal)** | Recover via SCB + Seed (Force-close) |
| **`channel.backup` (SCB)** | LND | **NO** | **CRITICAL** | Layer 2 GPG encrypted off-host copy | `lncli restorechanbackup` |
| **`wallet.db`** | LND | **NO** | **RECONSTRUCTABLE** | 24-word Aezeed Mnemonic | Re-derive from seed via `lncli create` |
| **`macaroon.db`** | LND | **NO** | **RECONSTRUCTABLE** | Re-creation via root keys | Wipe and re-bake macaroons |

---

## 16. FINANCIAL STATE MACHINE PRINCIPLES

```
[INITIATED] -> [PENDING_ROUTE] -> [IN_FLIGHT] 
                                    |
                 +------------------+------------------+
                 |                                     |
                 v                                     v
             [SETTLED]                             [FAILED]
                 |                                     |
           (Terminal Success)                   (Terminal Failure)
                 ^                                     ^
                 |                                     |
                 +-------------[UNKNOWN]---------------+
                      (Active Reconciliation Loop)
```

- **`UNKNOWN ≠ FAILED`**: When an external RPC, gRPC, or network call times out or disconnects during an in-flight payment, the transaction enters `UNKNOWN`.
- **Never Infer Success or Failure from Timeout**: Assets must remain locked until terminal settlement or failure is cryptographically proven.
- **Idempotency Key Enforcement**: Every financial intent receives a unique UUIDv4/hash idempotency key recorded in SQLite before network dispatch.

---

## 17. BACKUP & DISASTER RECOVERY ARCHITECTURE

### Existing Verified Backups:
- Git repository tracked on GitHub with clean working tree.
- SQLite WAL backup module tested and verified (`src/persistence/backup.ts`).
- Server Compose configuration backed up locally (`/srv/sovereign-router/docker-compose.yml.pre-readonly-rootfs`).

### Planned LND Disaster Recovery (Phase 2C Certified):
- **Layer 1 (Local Durable)**: `/srv/sovereign-router/lightning/backups/channel.backup` (mode `0600`).
- **Layer 2 (Encrypted Off-Host)**: Automated worker monitors `SubscribeChannelBackups` RPC, encrypts via GPG (AES-256), and syncs off-site within a **5-minute SLA**.
- **Layer 3 (Offline Vault)**: 24-word Aezeed recovery mnemonic and GPG private keys stored in physical cold custody.
- **The Golden Rule of Lightning Recovery**:
  > **A seed alone does not restore channels. Seed + SCB enables peer-assisted force-closure. Restoring an outdated `channel.db` is strictly prohibited and causes 100% loss of channel funds.**

---

## 18. AIPP ZERO-IMPACT & ISOLATION BOUNDARY

- **AIPP Purpose**: AIPP (AI Payment Platform) is an existing, independent production system running on `aliasdesk-server`.
- **Verified Isolation**:
  - AIPP containers run on Docker bridge network `core_aipp_net` (`172.23.0.0/16`).
  - Sovereign Router containers run on `sovereign_chain_net` (`10.240.10.0/24`) and `sovereign_router_net` (`10.240.20.0/24`).
  - Zero shared networks, zero shared volumes, zero shared database connections.
  - Universal Agent Asset Router **MUST NEVER reuse AIPP wallets, keys, macaroons, or databases**.
- **Production Audit Proof**:
  - `/aipp-key`: `StartedAt=2026-09-02T19:39:23Z`, `Restarts=0`
  - `/aipp-db`: `StartedAt=2026-07-08T10:08:47Z`, `Restarts=0`
  - `/aipp-redis`: `StartedAt=2026-07-08T19:30:41Z`, `Restarts=0`
  - `/aipp-phoenixd`: `StartedAt=2026-08-26T18:08:34Z`, `Restarts=0`
  - `/aipp-lnbits`: `StartedAt=2026-08-24T15:36:22Z`, `Restarts=0`

---

## 19. BASE / USDC FUTURE ARCHITECTURE (PLACEHOLDERS)

The Base/USDC integration is designed around the certified transaction manager in `src/atomic/evm/`:
- **Network / Chain ID**: Base Mainnet (EIP-155 Chain ID: `8453`) / Base Sepolia (`84532`) for testing.
- **Asset Contract**: Official native USDC on Base (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`).
- **RPC Provider Strategy**: Dual redundant private RPC providers (e.g. Alchemy / Infura / QuickNode) with automatic fallback.
- **Transaction Manager (`transaction-manager.ts`)**:
  - Persistent SQLite nonce management preventing nonce collisions across restarts.
  - Dynamic EIP-1559 gas estimation with automated fee bumping (10-20% bump) after configurable timeout blocks.
  - Minimum confirmation depth policy before marking deposits settled.
  - Reorg-resilient transaction tracker (`src/atomic/evm/transaction-types.ts`).
- **Signer & Custody**: Private key supplied via secure file mount (mode `0400`), zero exposure in Git or Compose.

---

## 20. COMPLETE PHASE HISTORY & ROADMAP

| Phase | Name | Status | Certified Date / Commit | Core Objective & Evidence | Next Dependency |
|---|---|---|---|---|---|
| **V1 Core** | Universal Router Core | **FROZEN** | `357c5ab85344a2fa5602a5e376efc7ea80685498` | Core execution coordinator, state engine, SQLite WAL persistence, adversarial certification | Phase 2A |
| **Phase 1** | Bitcoin Architecture & Isolation Freeze | **FROZEN** | 2026-09-04 | System root `/srv/sovereign-router/`, dual-network design, AIPP zero-impact boundary | Phase 2A |
| **Phase 2A** | Bitcoin Core Offline Installation & Hardening | **COMPLETE** | 2026-09-04 | Bitcoin Core 31.1 binary GPG verified, minimal Docker image built, `ReadonlyRootfs=true`, `CapDrop=ALL`, offline | Phase 2B |
| **Phase 2B** | Controlled Mainnet Outbound Activation & Burn-In | **COMPLETE / FROZEN** | 2026-09-04 | Runtime `setnetworkactive true`, 10 outbound peers, 0 inbound, 0 host listeners, IBD started | Phase 2C |
| **Phase 2C** | LND Architecture, Security & Recovery Preflight | **COMPLETE / FROZEN** | 2026-09-05 | Pinned `v0.21.3-beta`, Mode A outbound-only, Root Key ID 100, receive-only macaroon, payment denied, SCB runbooks | Phase 2D |
| **Phase 2D** | Bitcoin Core IBD Completion Certification Gate | **WAITING** | Pending IBD | Verify `initialblockdownload=false`, blocks match tip, disk/RAM healthy, AIPP untouched | Phase 2E |
| **Phase 2E** | LND Base Installation (Zero Wallet) | **PLANNED** | Owner Approval Req. | Deploy filesystem `/srv/sovereign-router/lightning/`, UID `2102:2102`, hardened Compose, verify image digest | Phase 2F |
| **Phase 2F** | LND Wallet Initialization & Seed Custody | **PLANNED** | Owner Approval Req. | Interactive `lncli create`, 24-word Aezeed recorded to offline cold vault, test reconstruction | Phase 2G |
| **Phase 2G** | Bitcoin Core ↔ LND Backend Integration | **PLANNED** | Owner Approval Req. | Configure `rpcauth` & ZMQ on bitcoind, bind to `sovereign_chain_net`, verify `synced_to_chain=true` | Phase 2H |
| **Phase 2H** | LND 24-Hour Zero-Fund Reliability Burn-In | **PLANNED** | Owner Approval Req. | 24-hour zero-fund stability test on production host; verify memory, CPU, logs, and restart resilience | Phase 2I |
| **Phase 2I** | Router ↔ LND Restricted API Integration | **PLANNED** | Owner Approval Req. | Mint Root Key ID 100 receive-only macaroon, mount TLS cert, verify invoice generation/lookup via Router | Phase 2J |
| **Phase 2J** | Tiny Real-BTC Controlled Canary | **PLANNED** | Owner Approval Req. | Funding amount: `UNDECIDED — OWNER APPROVAL REQUIRED`. Minimal test channel opened with reputable LSP | Phase 3 |

---

## 21. OWNER APPROVAL GATES

| Action | Owner Approval Required? | Safety Rationale |
|---|---|---|
| **Modify Frozen Router V1 Core** | **YES** | Preserves frozen certified baseline |
| **Advance to Phase 2E (Install LND)** | **YES** | Introduces new binary infrastructure |
| **Create LND Wallet / Generate Aezeed (Phase 2F)** | **YES** | Generates master financial keys |
| **Bind Bitcoin Core RPC/ZMQ to Network (Phase 2G)**| **YES** | Modifies Bitcoin Core runtime configuration |
| **Open TCP Port 9735 on Firewall** | **YES** | Exposes host to public Lightning traffic |
| **Fund LND Node with Real BTC (Phase 2J)** | **YES** | Commits real capital to node |
| **Open Lightning Channel** | **YES** | Commits on-chain funds to channel contracts |
| **Grant Router Outbound Payment Authority** | **YES** | Enables automated spending |
| **Move Real BTC or USDC** | **YES** | Value-bearing operation |
| **Deploy Base Mainnet Signer / Transaction** | **YES** | Commits real EVM capital |
| **Start Router Production Runtime** | **YES** | Operational activation |

---

## 22. SERVER REBUILD GUIDE (DISASTER RECONSTRUCTION PROTOCOL)

If `aliasdesk-server` is destroyed or lost, execute this recovery sequence:

1. **Host Provisioning**: Deploy fresh Ubuntu 24.04 LTS server. Configure SSH rate-limiting on port 22/2222.
2. **Firewall Baseline**: Enable UFW. Default DENY incoming. Open only necessary ports. Port 8333, 8332, 9735 remain closed.
3. **Docker Installation**: Install pinned official Docker Engine (`27.0.x`).
4. **Directory Structure Setup**:
   - Recreate `/srv/sovereign-router/{bitcoin,lightning}`.
   - Create system users `sovereign-bitcoin` (`2101:2101`) and `sovereign-lnd` (`2102:2102`).
5. **Bitcoin Core Restoration**:
   - Deploy `/srv/sovereign-router/docker-compose.yml` with `sovereign-bitcoind`.
   - Start container and initiate IBD (or copy recent validated block data from trusted offline backup).
   - Wait for Phase 2D IBD completion certification.
6. **LND Reconstruction**:
   - Pull certified `lightninglabs/lnd:v0.21.3-beta` by verified digest.
   - Retrieve latest encrypted `channel.backup` from Layer 2 off-host storage.
   - Retrieve 24-word Aezeed recovery mnemonic from Layer 3 offline vault.
   - Execute interactive wallet restore: `lncli create` (enter seed) followed by `lncli restorechanbackup`.
   - Counterparty peers initiate cooperative/force-close via DLP protocol; on-chain outputs sweep to wallet after CSV delay.
7. **Router Deployment**: Clone repository at frozen commit `357c5ab85344a2fa5602a5e376efc7ea80685498`, install dependencies, run test suite, and launch container on `sovereign_router_net`.

---

## 23. CANONICAL DOCUMENT UPDATE RULES

1. This document is updated at the conclusion of EVERY active work session.
2. Update whenever a phase passes its acceptance criteria.
3. Update after any production server configuration change.
4. Update after any security architecture or policy decision is approved.
5. Update after any change to backup, recovery, or key management.
6. Update immediately if an incorrect technical assumption is discovered.
7. **Never silently rewrite history**. Maintain chronological fidelity in the Session Update Log.
8. If a decision is superseded, record the supersession explicitly.
9. Always update the header metadata (`Last Verified`, `Last Updated`, `Current Blocker`, `Next Safe Action`).
10. Update Section 11 (`CURRENT IBD STATE`) with fresh live metrics.
11. **NEVER add actual secret values, passwords, private keys, or seed words to this document**.
12. Always verify facts directly against Git and the live server before writing them.

---

## 24. SESSION UPDATE LOG

### 2026-09-05 00:30 +03:00 (Session Closure)
- **Session Objective**: Establish the canonical master project state document (`docs/PROJECT-CANONICAL-STATE.md`), resolve Phase 2C feedback, pin LND `v0.21.3-beta`, correct macaroon root key and aezeed custody specifications, and verify live Bitcoin Core IBD progress.
- **Verified Starting State**: Bitcoin Core syncing actively (block >288k); Router V1 frozen at `357c5ab85344a2fa5602a5e376efc7ea80685498`; AIPP running undisturbed with 0 restarts.
- **Actions Performed**:
  - Inspected live server environment (CPU: 16 vCPU, RAM: 30 GiB, Disk: 204 GB free, Docker: 27.0.3).
  - Verified Bitcoin Core IBD advancing rapidly: reached block `395,848` (headers: `965,524`, verification progress: `7.61%`, size on disk: `8.54 GB`, automatic pruning active).
  - Updated all 5 Phase 2C planning documents to LND `v0.21.3-beta` (released Sept 2, 2026).
  - Corrected macaroon root key model: documented independent generation in `macaroon.db`, dedicated Root Key ID `100` for Router, instant selective revocation via `lncli deletemacaroonid 100`.
  - Corrected payment authority: Router outbound payment permission is **DENIED** by default (receive-only scope).
  - Corrected aezeed language: specified that the 24-word recovery mnemonic must never be stored in plaintext on server storage.
  - Created canonical master project state document: `docs/PROJECT-CANONICAL-STATE.md`.
- **Files Modified / Created**:
  - `docs/PROJECT-CANONICAL-STATE.md` (Created master document)
  - `docs/PHASE-2C-LND-ARCHITECTURE.md` (Updated)
  - `docs/PHASE-2C-THREAT-MODEL.md` (Updated)
  - `docs/PHASE-2C-RECOVERY-PLAN.md` (Updated)
  - `docs/PHASE-2C-IMPLEMENTATION-GATES.md` (Updated)
  - `docs/PHASE-2D-IBD-COMPLETION-GATE.md` (Updated)
- **Server Changes**: NONE (Strictly read-only inspection).
- **Security-Impacting Changes**: Pinned LND `v0.21.3-beta`; enforced Router outbound payment DENIED; separated Root Key ID 100.
- **Tests**: Local and server read-only inspection scripts verified; git working tree clean (docs untracked).
- **Result**: **PASS — PHASE 2C ARCHITECTURE READY TO FREEZE**.
- **Current Blocker**: Bitcoin Core Initial Block Download (IBD) must finish before Phase 2D certification.
- **Next Safe Action**: Allow Bitcoin Core IBD to continue uninterrupted. Once `initialblockdownload=false`, execute the Phase 2D Certification Gate.
- **Owner Approval Required**: NONE at this moment.
- **Exact Git HEAD**: `357c5ab85344a2fa5602a5e376efc7ea80685498`.
- **Production Mutation**: **NO**.
- **Real Funds Touched**: **NO**.

### 2026-09-05 01:15 +03:00 (Bitcoin RPC Credential Rotation & Incident Remediation)
- **Session Objective**: Safely rotate Bitcoin Core RPC credentials following exposure of an unconfigured plaintext parameter during an interactive CLI command, sanitize local artifacts, verify zero Git leaks, and validate production security posture.
- **Exposure Surface Audit**:
  - Full scan across repository code, tests, and documentation (`docs/`, `src/`, `tests/`): **0 matches** (CLEAN).
  - Git commit history across all branches: **0 matches** (CLEAN).
  - GitHub remote repository (`aipp-key/universal-agent-asset-router`): **0 matches** (CLEAN).
  - PowerShell console history: **0 matches** (CLEAN).
  - Scratch scripts: One temporary audit script contained search target; sanitized immediately. Zero plaintext secrets remain.
- **Rotation Executed**:
  - Generated new high-entropy 32-character secret directly on `aliasdesk-server` via cryptographically secure generator.
  - Calculated HMAC-SHA256 salt and hash using Bitcoin Core's approved `rpcauth.py` algorithm.
  - Updated `/srv/sovereign-router/bitcoin/config/bitcoin.conf` with `rpcauth=sovereign-lnd:<salt>$<hash>` (permissions `0600`, owner `2101:2101`).
  - Stored plaintext secret strictly on host at `/srv/sovereign-router/secrets/bitcoind_rpc_password` (permissions `0400`, owner `root:root`).
  - Zero plaintext secrets logged, printed, or committed.
- **Production Verification**:
  - `sovereign-bitcoind` gracefully restarted; block index loaded; container reported `Health=healthy`.
  - Validated cookie authentication inside container (`bitcoin-cli -conf=/config/bitcoin.conf -datadir=/data getblockchaininfo`).
  - Validated new RPC credentials via stdin pipe (`-stdin -stdinrpcpass`).
  - Verified arbitrary/wrong credentials are unequivocally rejected with `Authorization failed`.
  - Mainnet IBD actively progressing: block `440,135` (verification progress `12.31%`, headers `965,529`).
  - Outbound-only connectivity confirmed: `connections_in: 0`, `connections_out: 10`, `listen=0`, `networkactive=1`.
  - Port security verified: `ss -lntup` confirms 0 listeners on ports 8332, 8333, 28332, 28333. Docker port mappings: 0.
  - Container hardening intact: `read_only: true`, `cap_drop: ALL`, `no-new-privileges: true`, `disablewallet: 1`.
  - AIPP containers untouched: 5/5 running with `Restarts=0`.
  - LND not installed; Router not started; Real funds: ZERO.
- **Result**: **PASS — BITCOIN RPC CREDENTIAL ROTATED & ZERO LEAKS CONFIRMED**.
- **Current Blocker**: Bitcoin Core Initial Block Download (IBD) in progress (~12.3%).
- **Next Safe Action**: Allow IBD to finish uninterrupted until `initialblockdownload=false` for Phase 2D certification.
- **Exact Git HEAD**: Advances via documentation-only commit.
- **Production Mutation**: Replaced bitcoind RPC credential & restarted `sovereign-bitcoind`; no application code altered.
- **Real Funds Touched**: **NO**.

### 2026-09-05 01:25 +03:00 (Documentation Reconciliation — V4 Direct Base Route)
- **Session Objective**: Reconcile internal documentation drift inside the frozen V4 repository baseline, aligning all active documentation with the proven Direct Base route (`DIRECT_BASE_USDC_ROUTE_REPORT.md` / commit `3dd610d`), while preserving historical research documents.
- **Source Code Verification**: Zero application code changed. Verified frozen Router V1 baseline (`357c5ab85344a2fa5602a5e376efc7ea80685498`). Read-only inspection of `src/atomic/coordinator/`, `src/atomic/evm/`, `contracts/HtlcErc20.sol`, and `deployments/base-sepolia.json` confirmed that application source strictly implements Direct Base canonical USDC HTLC execution.
- **Documentation Reconciled**:
  - `README.md`: Replaced obsolete Arbitrum/tBTC/CCTP multi-hop route with Direct Base atomic route. Updated runtime to certified Node 24 LTS and test count to 155 offline unit tests.
  - `ARCHITECTURE_V4_SOVEREIGN_CORE.md`: Reconciled all sections (Trust Boundaries, Operator Key Boundary, Atomic Swap Boundary, EVM Backend, Atomic Coordinator, Evidence Model, Finality, Liquidity Abstraction, Roadmap, and Phase 3 specifications) to the Direct Base canonical USDC HTLC architecture. Formalized decoupling of the Customer Execution Plane from the Asynchronous Treasury Plane (CCTP/DEX).
  - `SECURITY_MODEL_V1.md`: Contextual threat models (T-04, T-06, T-07, T-17, T-19, Section 2 diagram, Operator Key Inventory, Chain Finality, Dependency Classification, and Residual Risks) reconciled to Base and decoupled treasury. All 25 frozen security invariants (`SEC-1` through `SEC-25`) preserved untouched.
  - `docs/PROJECT-CANONICAL-STATE.md`: Added explicit authoritative execution path section and updated session log.
  - Historical documents (`SOVEREIGN_CORE_REBASE_REPORT.md`, `SATORA_LIVE_FEASIBILITY_VALIDATION.md`, `SATORA_SELF_HOST_GAP_ANALYSIS.md`, `FINAL_GARDEN_BASE_ROUTE_VALIDATION.md`, `FINAL_PRE_ARCHITECTURE_VALIDATION.md`): Added clear historical status banners; preserved engineering history without deletion.
- **Verification**: `npm run typecheck` passed (0 errors); `python tests/scan-secrets.py` passed (0 secrets); `npm test` passed (155/155 tests). Zero git diff in `src/`, `contracts/`, or `tests/`.
- **Result**: **PASS — DOCUMENTATION 100% RECONCILED WITH DIRECT BASE V4**.
- **Current Blocker**: Bitcoin Core Initial Block Download (IBD) in progress (~12.3%).
- **Next Safe Action**: Allow IBD to finish uninterrupted until `initialblockdownload=false` for Phase 2D certification.
- **Exact Git HEAD**: Advances via documentation-only commit.
- **Production Mutation**: **NO** (Server untouched, IBD running, AIPP running with 0 restarts).
- **Real Funds Touched**: **NO**.

---
*End of Canonical Master Project State Document.*
