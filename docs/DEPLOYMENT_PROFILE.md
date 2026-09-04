# UNIVERSAL AGENT ASSET ROUTER — V4 SOVEREIGN CORE
## Production Deployment Profile (Phase 7)

This document specifies the operational runtime contract, environment schema, persistent storage requirements, and security boundaries for deploying the V4 Sovereign Core engine.

---

### 1. Runtime Environment Contract
- **Node.js**: Node.js 24 LTS. Certified V1 Core runtime: `v24.12.0` (strictly `>= 24.12.0` for native `node:sqlite` and ESM module support).
- **TypeScript**: Pinned to repository devDependencies (`7.0.2`).
- **Operating System**: Linux (Ubuntu 22.04 / 24.04 LTS, Debian 12) or Windows Server (for developer/parity).
- **Process Manager**: Systemd or minimal container supervisor respecting `SIGTERM` / `SIGINT`.

---

### 2. Supported Production Bootstrap vs Low-Level Library Constructors

The router enforces a strict architectural boundary between low-level library constructors and the supported production bootstrap:

#### A. Supported Production Entrypoint
- **Module**: [`src/bootstrap.ts`](file:///C:/Users/faruk/Desktop/universal-agent-asset-router/src/bootstrap.ts) / [`src/index.ts`](file:///C:/Users/faruk/Desktop/universal-agent-asset-router/src/index.ts)
- **Function**: `bootstrapProductionRouter(config: RouterProductionConfig, options?: ProductionBootstrapOptions)`
- **Order of Execution**:
  1. `ProductionConfigValidator.validate(config)` executes FIRST, rejecting invalid or mainnet configs before any resource allocation.
  2. Rejects mock or fake economic backends fail-closed (`MockBackendForbiddenError`).
  3. Validates supply-chain trusted binary set (on regtest).
  4. Initializes SQLite persistence with `PRAGMA integrity_check`.
  5. Initializes real LND client with `verifyNetworkSafety()` gate.
  6. Initializes Base Sepolia backend with `BaseNetworkGuard` (rejecting chain ID != 84532 or fake USDC).
  7. Wires `HealthService` and `AtomicCoordinator`.

#### B. Low-Level Library Constructors
- Constructors such as `new AtomicCoordinator(...)`, `new BaseSepoliaAtomicBackend(...)`, and `new SqlitePersistence(...)` exist as internal building blocks for unit testing and modular composition.
- **OPERATIONAL MANDATE**: Production deployments MUST NEVER instantiate low-level constructors directly. All production launchers, service wrappers, and runners MUST initialize via `bootstrapProductionRouter`.

---

### 3. Required Filesystem Layout & Storage
- `/var/lib/asset-router/data/`: Persistent storage volume for SQLite database (`router.db`, `router.db-wal`, `router.db-shm`). Must reside on local, POSIX-compliant durable storage (avoid network NFS mounts due to SQLite file locking constraints).
- `/var/lib/asset-router/backups/`: Dedicated volume for automated consistent SQLite backups (`*.db`, `*.meta.json`).
- `/etc/asset-router/certs/`: Read-only directory containing LND TLS certificate (`tls.cert`).
- `/etc/asset-router/macaroons/`: Read-only directory containing LND restricted macaroon (`router.macaroon`).

---

### 4. Least-Privilege Authority Model

#### A. LND Least-Privilege Macaroon Permissions
The router strictly requires only the following minimal permissions:
- `invoices:read`
- `invoices:write`
- `info:read`

##### Exact LND RPC to Permission Mapping
| Router Operation | LND REST / gRPC RPC | Required LND Permission | Operational Justification |
| :--- | :--- | :--- | :--- |
| **Verify Network Safety** | `GET /v1/getinfo` | `info:read` | Queries node consensus network (`regtest` check) |
| **Authoritative Block Height** | `GET /v1/getinfo` | `info:read` | Obtains current Bitcoin block height for 140-block time gate |
| **Create Hold Invoice** | `POST /v2/invoices/hodl` | `invoices:write` | Registers HODL invoice bound to swap hashlock |
| **Lookup Invoice Status** | `GET /v1/invoice/{hash}` | `invoices:read` | Inspects state (OPEN, ACCEPTED, SETTLED, CANCELED) |
| **Settle Hold Invoice** | `POST /v2/invoices/settle` | `invoices:write` | Releases held HTLC sats upon verified on-chain claim |
| **Cancel Hold Invoice** | `POST /v2/invoices/cancel` | `invoices:write` | Cancels invoice and unlocks payer sats upon refund |

##### Forbidden Permissions
The macaroon must **NEVER** possess:
- `onchain:write` (sending on-chain BTC forbidden)
- `channels:write` (opening/closing channels forbidden)
- `admin:all` (full root administration forbidden)

##### Macaroon Generation Command
Operators can bake the exact scoped macaroon via `lncli`:
```bash
lncli bakemacaroon --save_to=/etc/asset-router/macaroons/router.macaroon info:read invoices:read invoices:write
```

#### B. EVM Operational Wallet Permissions
- Holds only minimal gas (ETH) and collateral (test USDC on Base Sepolia) required for active HTLC funding.
- Operates under strict EIP-1559 fee caps and replacement attempt bounds (max 5 replacements).
- Owns zero client private keys; clients sign their own claim transactions on-chain.

#### C. Filesystem Permissions (POSIX)
- `router.db`: `600` (read/write only by service user).
- `tls.cert`: `644` (read-only).
- `router.macaroon`: `600` (read-only by service user).
- Service runs as non-root dedicated user (`assetrouter:assetrouter`).

---

### 5. Health & Observability Semantics
- **Integration**: `HealthService` is a programmatic operational evaluator wired into `bootstrapProductionRouter`.
- **Zero HTTP Port**: The core does NOT run an unauthenticated HTTP server daemon, preventing network attack surface.
- **Evaluator API**: `healthService.evaluateHealth()` returns a structured `HealthReport`.
- **Rail Health Probes**:
  - `Base Sepolia RPC probe`: Real read-only RPC probe issuing `getChainId()` (verifying exact chain ID `84532`) and `getBlockNumber()`. Zero write transactions, zero signing, zero balance movements.
  - `Lightning LND probe`: Read-only probe issuing `getInfo` over authenticated REST client to verify node synchronization and responsiveness.
- **Status Meanings & Gating**:
  - `HEALTHY`: All rails up, database clean, zero swaps requiring recovery. New swaps accepted.
  - `DEGRADED`: Transient rail latency or RPC drop. Existing swaps reconcile; new swaps may proceed if target rail recovers.
  - `RECOVERY_REQUIRED`: At least one swap failed ambiguous execution and requires operator review. Affected swap is isolated; healthy swaps continue.
  - `UNHEALTHY`: Database integrity check failed. System halts all operations immediately fail-closed.

---

### 6. Configuration Environment Variables Schema

| Variable | Description | Required | Example / Allowed Values |
| :--- | :--- | :---: | :--- |
| `ROUTER_ENV` | Runtime environment profile | Yes | `production`, `development`, `test` |
| `DATABASE_PATH` | Path to durable SQLite DB file | Yes | `/var/lib/asset-router/data/router.db` |
| `LIGHTNING_NETWORK` | Lightning consensus network | Yes | Strictly `regtest` in V1 Core |
| `LND_HOST` | Hostname or IP of LND node | Yes | `127.0.0.1` |
| `LND_PORT` | REST/gRPC port of LND | Yes | `18080` |
| `LND_TLS_PATH` | Path to TLS certificate | Yes | `/etc/asset-router/certs/tls.cert` |
| `LND_MACAROON_PATH`| Path to restricted macaroon | Yes | `/etc/asset-router/macaroons/router.macaroon` |
| `EVM_CHAIN_ID` | Consensus chain identifier | Yes | Strictly `84532` (Base Sepolia) |
| `EVM_RPC_URL` | Base Sepolia JSON-RPC endpoint| Yes | `https://sepolia.base.org` |
| `EVM_HTLC_ADDRESS` | Deployed Base Sepolia HTLC | Yes | Checksummed contract address |
| `EVM_USDC_ADDRESS` | Canonical Circle test USDC | Yes | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| `EVM_PRIVATE_KEY` | Operator execution private key| Yes | 32-byte hex string (`0x...`) |
| `MIN_BTC_BLOCKS` | Fast-block Poisson safety buffer | No | Default `140` (min: 140) |
| `MAX_RETRIES` | Max reconciliation retry count | No | Default `5` (range: 1-20) |
| `LEASE_MS` | Action lease duration | No | Default `30000` (5,000 - 300,000) |

---

### 7. Process Lifecycle & Shutdown
- Upon receiving `SIGTERM` or `SIGINT`, the process manager stops accepting new swap intents, allows in-flight RPC queries to complete within a bounded 10-second grace period, releases action leases, and shuts down SQLite safely.
- Upon startup, the coordinator automatically inspects non-terminal swaps and initiates reconciliation via `reconcileAll()`.
