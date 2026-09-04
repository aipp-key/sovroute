# UNIVERSAL AGENT ASSET ROUTER
## PHASE 2C: LND ARCHITECTURE & SECURITY SPECIFICATION (FROZEN SPECIFICATION)

---

### 1. EXECUTIVE SUMMARY & DESIGN PHILOSOPHY

This document establishes the frozen architectural specification for integrating the Lightning Network Daemon (LND) into the Universal Agent Asset Router infrastructure.

The core engineering principle governing this design is:
> **Security, recovery, failure handling, key custody, blast-radius control, durable state, idempotency, restart recovery, adversarial testing, and future-proof interfaces must be designed before implementation.**

This architecture strictly enforces:
- **Zero mutation** of the frozen Router V1 Core (`357c5ab85344a2fa5602a5e376efc7ea80685498`).
- **Strict isolation** from AIPP and all existing host services.
- **Zero public exposure** of Bitcoin Core RPC, ZMQ, or LND administration interfaces.
- **Mode A Outbound-Only Networking**: TCP port 9735 remains UNPUBLISHED in Docker Compose and CLOSED on the host firewall.
- **Router Least Privilege**: By default, `ROUTER OUTBOUND LIGHTNING PAYMENT PERMISSION = DENIED`. The Router receives only a tightly scoped, receive-only macaroon minted under a dedicated root key ID.
- **Dedicated Macaroon Root Key ID**: Enables selective, instant revocation of Router credentials without rotating administrative credentials.
- **Defense in Depth**: Non-root container UID `2102:2102`, capability dropping (`ALL`), read-only root filesystem (`ReadonlyRootfs=true`), no-new-privileges, private dual-homed Docker bridge networks, and bounded resource limits.

---

### 2. SYSTEM TOPOLOGY & NETWORK ARCHITECTURE

```
+--------------------------------------------------------------------------------------------------+
| HOST: aliasdesk-server (Ubuntu 24.04 LTS, 16 vCPU, 32GB RAM, UFW Active)                         |
|                                                                                                  |
|  [FIREWALL: 8333 CLOSED, 8332 CLOSED, 9735 CLOSED, 10009 CLOSED, 8080 CLOSED]                    |
|                                                                                                  |
|  +-------------------------------+         +--------------------------------------------------+  |
|  | DOCKER BRIDGE NETWORK         |         | DOCKER BRIDGE NETWORK                            |  |
|  | sovereign_chain_net           |         | sovereign_router_net                             |  |
|  | (10.240.10.0/24)              |         | (10.240.20.0/24)                                 |  |
|  |                               |         |                                                  |  |
|  |  +-------------------------+  |         |  +-------------------------+                     |  |
|  |  | sovereign-bitcoind      |  |         |  | sovereign-router        |                     |  |
|  |  | IP: 10.240.10.2         |  |         |  | IP: 10.240.20.3         |                     |  |
|  |  | UID: 2101 (bitcoind)    |  |         |  | UID: 2100 (router)      |                     |  |
|  |  | ReadOnly Rootfs: true   |  |         |  | V1 Core Frozen Commit   |                     |  |
|  |  | RPC: 10.240.10.2:8332*  |  |         |  | (NO access to chain_net)|                     |  |
|  |  | ZMQ: 10.240.10.2:28332* |  |         |  +------------+------------+                     |  |
|  |  |      10.240.10.2:28333* |  |         |               |                                  |  |
|  |  +------------+------------+  |         |               | gRPC: 10009                      |  |
|  |               ^               |         |               | (Receive-Only Macaroon + TLS)    |  |
|  |               | RPC / ZMQ     |         |               v                                  |  |
|  |               | (Auth Secret) |         |  +-------------------------+                     |  |
|  |  +------------+------------+  |         |  | sovereign-lnd           |                     |  |
|  |  | sovereign-lnd           +--+---------+->| IP: 10.240.20.2         |                     |  |
|  |  | IP: 10.240.10.3         |  (Dual-Homed) | UID: 2102 (lnd)         |                     |  |
|  |  | UID: 2102 (lnd)         |               | ReadOnly Rootfs: true   |                     |  |
|  |  +------------+------------+               +-------------------------+                     |  |
|  +---------------|----------------------------------------------------------------------------+  |
|                  | Outbound Lightning P2P (TCP 9735)                                             |
+------------------|-------------------------------------------------------------------------------+
                   v
        INTERNET (Outbound to Lightning Peers / LSPs)
        [Inbound 9735 is BLOCKED / NOT FORWARDED]

*Note: Bitcoin Core RPC/ZMQ reachability over sovereign_chain_net is a FUTURE Phase 2G configuration
change. Bitcoin Core currently runs in localhost-only offline/IBD mode.
```

---

### 3. LND VERSION PINNING & SUPPLY-CHAIN VERIFICATION

- **Pinned LND Version**: `v0.21.3-beta`
- **Release Date**: September 2, 2026
- **Release Reference / URL**: `https://github.com/lightningnetwork/lnd/releases/tag/v0.21.3-beta` (Marked as Latest official production release by Lightning Labs).
- **Release Status**: Non-RC, fully supported production release.
- **Historical Rejected Versions**:
  - `v0.18.5-beta` (Rejected: Obsolete for new September 2026 production architecture).
  - `v0.21.2-beta` (Superceded by official Latest release `v0.21.3-beta`).
- **Compatibility & Database Migrations**:
  - Fully compatible with Bitcoin Core 31.x / 30.x / 28.x via RPC + ZMQ.
  - Native support for onion messaging, production-ready simple taproot channels, and SQL data store backend migrations.
- **Supply-Chain Verification Protocol Prior to Phase 2E Installation**:
  1. **Signed Release Manifest Verification**:
     - Download `manifest-v0.21.3-beta.txt` and `manifest-v0.21.3-beta.txt.sig`.
     - Verify signature using Lightning Labs developer release signing GPG keys.
  2. **Official Script Verification**:
     - Execute LND's official `/verify-install.sh` verification routine.
  3. **Official Docker Digest Retrieval (No Invented Digests)**:
     - An immutable sha256 digest must **never be invented**.
     - The true immutable sha256 digest must be retrieved and recorded from the certified official image repository (`lightninglabs/lnd:v0.21.3-beta`) at deploy time during Phase 2E after cryptographic verification.
- **Upgrade/Downgrade Policy**:
  - Upgrades require explicit owner authorization, pre-upgrade backup of `channel.backup` (SCB), and clean container shutdown (`lncli stop`).
  - Downgrades are **strictly prohibited** once database schema migrations have run.

---

### 4. BITCOIN CORE <-> LND BACKEND ARCHITECTURE

#### 4.1 Interface Architecture (Future Phase 2G Configuration)
LND requires private chain backend connectivity to Bitcoin Core via:
1. **Bitcoin RPC** (`bitcoind.rpchost=10.240.10.2:8332`):
   - Block retrieval, raw transaction broadcast, UTXO verification, fee estimation.
2. **Bitcoin ZMQ** (`zmqpubrawblock`, `zmqpubrawtx`):
   - `bitcoind.zmqpubrawblock=tcp://10.240.10.2:28332`
   - `bitcoind.zmqpubrawtx=tcp://10.240.10.2:28333`
   - Real-time block and transaction notifications for immediate breach detection.

#### 4.2 RPC Authentication Design
- **Server-Side (Bitcoin Core)**: Configured in `bitcoin.conf` using `rpcauth`:
  ```ini
  rpcauth=sovereign-lnd:<salt>$<hash>
  ```
  *(Note: `rpcauth` is strictly server-side and must never be placed in client `lnd.conf`).*
- **Client-Side (LND)**:
  ```ini
  bitcoind.rpcuser=sovereign-lnd
  bitcoind.rpcpass=<random_32_character_secret>
  ```
- **Credential Storage**: The plaintext RPC password is provided to LND via a dedicated secret file `/var/lib/lnd/secrets/bitcoind_rpc_password` (permissions `0400`, owned by `2102:2102`).
  - Never committed to Git.
  - Never embedded in Docker Compose environment variables.
  - Never printed to logs.
  - Never shared with the Router.
- **Alternative (Cookie Authentication)**: Evaluated as mounting `/srv/sovereign-router/bitcoin/data/.cookie` read-only into LND. If chosen in Phase 2G, automated synchronization ensures cookie rotation on bitcoind restart does not disrupt LND.

#### 4.3 Network Boundary & Separation
- Current Bitcoin Core runtime remains localhost-bound (`rpcbind=127.0.0.1`, `rpcallowip=127.0.0.1`).
- Binding RPC/ZMQ to `10.240.10.2` on `sovereign_chain_net` is explicitly deferred to **Phase 2G**.
- Router container has **zero routes** to `sovereign_chain_net`.

---

### 5. DOCKER NETWORK SEGMENTATION & DUAL-HOMING ANALYSIS

1. **`sovereign_chain_net`** (`10.240.10.0/24`):
   - Members: `sovereign-bitcoind` (`10.240.10.2`), `sovereign-lnd` (`10.240.10.3`).
   - Private chain traffic: TCP 8332, 28332, 28333.
   - Closed to all other containers.
2. **`sovereign_router_net`** (`10.240.20.0/24`):
   - Members: `sovereign-lnd` (`10.240.20.2`), `sovereign-router` (`10.240.20.3`).
   - Private application traffic: TCP 10009 (gRPC TLS + Macaroon).
   - Closed to Bitcoin Core.

**Dual-Homing Mitigation**: `sovereign-lnd` is the controlled bridge. Router cannot pivot across LND because:
- IP forwarding is disabled in kernel (`net.ipv4.ip_forward = 0`).
- LND runs as non-root `2102:2102` with `CapDrop: ALL` and `ReadonlyRootfs: true`.
- Router holds only receive-only macaroon; cannot execute administrative or system commands.

---

### 6. PUBLIC NETWORKING POLICY: MODE A (OUTBOUND ONLY)

- **Policy Decision**: **Mode A (Outbound-Only LND)** is approved.
- **Port 9735**: **NOT published** in Docker Compose, **NOT opened** in UFW firewall.
- **Rationale**: The Router acts as an asset coordinator/settlement client. Outbound connections to established peers and Liquidity Service Providers (LSPs) enable full payment reception and routing without exposing a public listening daemon to internet scanning, DDoS, or wire protocol zero-days.
- Inbound port 9735 remains closed unless a separate, future owner-authorized phase requires public routing node capability.

---

### 7. WALLET, KEY CUSTODY & MACAROON ROOT KEY ARCHITECTURE

#### 7.1 Secret Classification & Custody Principles

- **Aezeed Custody Principle**:
  > **The 24-word aezeed recovery mnemonic must never be stored in plaintext on production server storage, logs, Git, environment variables, or documentation.**
- The encrypted wallet's internal durable key state (`wallet.db`) is separate from the owner's offline recovery mnemonic. The master recovery mnemonic is held strictly offline in cold custody.

| Tier | Classification | Item | Location | Protection |
|---|---|---|---|---|
| **Tier 0** | Catastrophic Secret | 24-word Aezeed Mnemonic | **Offline Physical Vault Only** | Never in plaintext on server storage, git, or logs |
| **Tier 0** | Encryption Key | Wallet Password | `/secrets/wallet_password` (0400) | Layer 3 Offline Vault backup |
| **Tier 1** | Operator Admin Token | `admin.macaroon` | `/data/.../admin.macaroon` (0400) | Root key ID 0; operator emergency only |
| **Tier 2** | Dedicated App Token | `router.macaroon` | Mounted into Router (0400) | **Dedicated Root Key ID 100**; receive-only |
| **Tier 3** | Transport Security | `tls.key`, `tls.cert` | `/secrets/` (0400 / 0644) | Regenerable on startup |
| **Tier 4** | Durable State | `channel.db`, `channel.backup` | `/data/`, `/backups/` | Encrypted at rest |

#### 7.2 Macaroon Root Key Model & Selective Revocation
- **Accurate Root Key Architecture**:
  - Default LND macaroon root keys are **NOT derived from the aezeed**. They are randomly generated by LND and stored in the encrypted database (`macaroon.db`).
  - `macaroon.db` is active authentication/root-key state, **NOT an independent disaster-recovery backup**. Loss or corruption of `macaroon.db` requires controlled recreation of root keys and re-issuance of credentials.
  - The admin macaroon is **NOT recoverable from aezeed**.
- **Dedicated Root Key ID Design**:
  - Administrative credentials use default Root Key ID `0`.
  - The Router macaroon is baked using a **dedicated Root Key ID** (e.g. ID `100`):
    ```bash
    lncli bakemacaroon \
      --root_key_id 100 \
      uri:/lnrpc.Lightning/GetInfo \
      uri:/lnrpc.Lightning/AddInvoice \
      uri:/lnrpc.Lightning/LookupInvoice \
      uri:/lnrpc.Lightning/SubscribeInvoices \
      uri:/lnrpc.Lightning/DecodePayReq \
      --save_to=/var/lib/lnd/data/router.macaroon
    ```
- **Instant Selective Revocation**:
  - If the Router is compromised, the operator executes:
    ```bash
    lncli deletemacaroonid 100
    ```
  - Result: All Router tokens minted under Root Key ID 100 are invalidated **instantly**, without revoking admin macaroons, without restarting LND, and without disturbing node operations.

#### 7.3 Stateless Initialization
- LND's `--stateless_init` configuration is evaluated for production: default admin macaroons are streamed to the operator during wallet unlock rather than left permanently on disk if unattended recovery is not required.

---

### 8. ROUTER LEAST PRIVILEGE & PAYMENT AUTHORITY POLICY

#### 8.1 Default Phase 2C Posture: Outbound Payment Denied
- **DEFAULT**: `ROUTER OUTBOUND LIGHTNING PAYMENT PERMISSION = DENIED`.
- Standard LND macaroons do NOT enforce amount ceilings, velocity caps, or destination allowlists. Granting `SendPaymentV2` to a compromised Router would allow draining all channel balances.

#### 8.2 Receive-Only Operation (Phase 2C Approved Scope)
The Router macaroon receives strictly these 5 endpoints:
1. `uri:/lnrpc.Lightning/GetInfo` (LND health and chain sync verification)
2. `uri:/lnrpc.Lightning/AddInvoice` (Generate receiving invoice)
3. `uri:/lnrpc.Lightning/LookupInvoice` (Poll invoice settlement)
4. `uri:/lnrpc.Lightning/SubscribeInvoices` (Real-time invoice settlement stream)
5. `uri:/lnrpc.Lightning/DecodePayReq` (Decode invoice parameters)

#### 8.3 Future Outbound Payment Policy Boundary Specification
If future Router V1 requirements demand automated outbound Lightning payments, authority will NOT be granted directly to the Router container. Instead, an isolated **Payment Policy Service** boundary must be deployed between Router and LND to enforce:
1. **Per-Transaction Limit**: Hard cap on any single payment (e.g. max 100,000 sats).
2. **Cumulative Velocity Budget**: Hourly and daily spend ceilings enforced outside the Router.
3. **Fee Ceiling**: Max fee allowance (e.g. max 1% or 100 sats).
4. **Durable Idempotency**: Strict deduplication via payment hash before forwarding to LND.
5. **Payment State Machine**: Enforcing terminal `SETTLED`, `FAILED`, or `UNKNOWN` resolution.
6. **Emergency Revoke Switch**: Operator hardware/API kill switch.

---

### 9. TLS CONFIGURATION

- **Generation**: Self-signed ECDSA (P-256) generated by LND.
- **Subject Alternative Names (SANs)**: `sovereign-lnd`, `10.240.20.2`, `localhost`, `127.0.0.1`.
- **Router Pinning**: Router mounts `tls.cert` read-only and strictly verifies certificate authenticity against LND's SAN.
- **Security Rule**: Insecure TLS skipping (`--insecure` or `InsecureSkipVerify: true`) is **strictly forbidden**.
- **Cipher Negotiation**: Uses standard secure TLS negotiation supported by Go crypto without assuming automatic "TLS 1.3 only" transport.

---

### 10. HOST FILESYSTEM LAYOUT & PERMISSIONS

All LND state is anchored under `/srv/sovereign-router/lightning/` and mounted to non-root path `/var/lib/lnd/`:

```
/srv/sovereign-router/lightning/
├── config/                  # Owner: 2102:2102, Mode: 0750
│   └── lnd.conf             # Mode: 0640 (Mounted to /var/lib/lnd/config/lnd.conf:ro)
├── data/                    # Owner: 2102:2102, Mode: 0700
│   ├── chain/bitcoin/mainnet/
│   │   ├── wallet.db        # LND Wallet DB (Mode: 0600)
│   │   ├── channel.db       # Channel state DB (Mode: 0600)
│   │   └── macaroon.db      # Encrypted macaroon DB (Mode: 0600)
│   └── router.macaroon      # Root Key ID 100 Token (Mode: 0400)
├── secrets/                 # Owner: 2102:2102, Mode: 0700
│   ├── tls.cert             # Public TLS Certificate (Mode: 0644)
│   ├── tls.key              # Private TLS Key (Mode: 0400)
│   ├── wallet_password      # Optional unlock file (Mode: 0400)
│   └── bitcoind_rpc_password# Bitcoin RPC password (Mode: 0400)
└── backups/                 # Owner: 2102:2102, Mode: 0700
    └── channel.backup       # Static Channel Backup (SCB) (Mode: 0600)
```

---

### 11. CONTAINER HARDENING SPECIFICATION

```yaml
services:
  sovereign-lnd:
    container_name: sovereign-lnd
    image: lightninglabs/lnd:v0.21.3-beta@sha256:<certified_digest_at_deploy>
    restart: unless-stopped
    user: "2102:2102"
    read_only: true
    networks:
      sovereign_chain_net:
        ipv4_address: 10.240.10.3
      sovereign_router_net:
        ipv4_address: 10.240.20.2
    volumes:
      - /srv/sovereign-router/lightning/config:/var/lib/lnd/config:ro
      - /srv/sovereign-router/lightning/data:/var/lib/lnd/data:rw
      - /srv/sovereign-router/lightning/secrets:/var/lib/lnd/secrets:ro
      - /srv/sovereign-router/lightning/backups:/var/lib/lnd/backups:rw
    tmpfs:
      - /tmp:rw,noexec,nosuid,size=64m
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    deploy:
      resources:
        limits:
          cpus: "2.0"
          memory: 2048M
        reservations:
          cpus: "0.5"
          memory: 512M
    logging:
      driver: "json-file"
      options:
        max-size: "20m"
        max-file: "3"
```

---

### 12. RESOURCE BUDGET & IMPACT

- **Host Specs**: 16 vCPU, 32 GB RAM, 301 GB SSD (200+ GB free).
- **Bitcoin Core Budget**: 4.0 vCPU, 4096 MiB RAM (`dbcache=2048`).
- **LND Budget**: 2.0 vCPU, 2048 MiB RAM.
- **Combined Sovereign Footprint**: Max 6.0 vCPU (37.5%), 6144 MiB RAM (18.7%).
- **AIPP Isolation**: Zero resource contention; >24 GB host RAM remains available.

---

### 13. OBSERVABILITY & READINESS SIGNALS

- **Logging Policy**: `debuglevel=info` in `lnd.conf`. No secret logging. Bounded JSON files (`max-size: 20m`, `max-file: 3`).
- **Health Signal**:
  ```bash
  lncli --rpcserver=localhost:10009 --macaroonpath=/var/lib/lnd/data/router.macaroon --tlscertpath=/var/lib/lnd/secrets/tls.cert getinfo
  ```
- **Readiness Gate for Router**:
  1. `synced_to_chain == true`
  2. `synced_to_graph == true`
  3. `block_height` matches Bitcoin Core tip
  4. Wallet state: `unlocked`

---
*End of LND Architecture Specification.*
