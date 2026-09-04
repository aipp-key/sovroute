# UNIVERSAL AGENT ASSET ROUTER
## PHASE 2C: LND DISASTER RECOVERY & RESILIENCE RUNBOOK (FROZEN SPECIFICATION)

---

### 1. PRINCIPLES OF LIGHTNING DISASTER RECOVERY & RESIDUAL RISK

Unlike base-layer Bitcoin where a 24-word seed fully restores all funds at any future time:
> **A Lightning Network seed ALONE cannot restore open channel funds without Static Channel Backups (SCB). Restoring an outdated `channel.db` database will cause irrevocable loss of channel funds due to counterparty breach remedy transactions.**

#### Critical Recovery Realities & Risk Classification:
- **Seed Alone**: Restores deterministic wallet on-chain keys only. Channels are invisible and unrecoverable from seed alone.
- **Seed + SCB (`channel.backup`)**: Enables channel fund recovery via Data Loss Protection (DLP) protocol by requesting peers to force-close channels.
- **SCB Limitations**: SCB does **NOT** restore channels as live channels. All channels are closed to on-chain UTXOs.
- **Residual Fund Risk**:
  - *On-Chain Funds*: **LOW** risk (fully protected by 24-word Aezeed).
  - *Channel Funds under SCB*: **CONDITIONAL / MATERIAL** risk:
    - Subject to peer responsiveness and cooperative DLP compliance.
    - Subject to on-chain commitment transaction mining fees.
    - In-flight HTLCs unresolved at the time of failure may be contested or timed out.
  - *Restoring Stale `channel.db`*: **CATASTROPHIC** risk (100% loss of balance to peer penalty).

#### Recovery Mnemonic vs Internal Key State:
> **The 24-word aezeed recovery mnemonic must never be stored in plaintext on production server storage, logs, Git, environment variables, or documentation.** The encrypted wallet's internal durable key state (`wallet.db`) on disk is separate from the owner's offline recovery mnemonic.

---

### 2. DURABLE STATE ARTIFACT CLASSIFICATION

| Artifact | Classification | Recovery Source | Residual Risk on Loss | Action on Loss |
|---|---|---|---|---|
| **24-word Aezeed Mnemonic** | Non-Reconstructable | Physical Offline Vault | **CATASTROPHIC** | On-chain & channel funds permanently lost |
| **`channel.db`** | Live Ephemeral State | Dynamic consensus | **MATERIAL** (Do NOT backup) | Recover via SCB + Seed (Force-close) |
| **`channel.backup` (SCB)** | Critical Reconstructable | Auto-generated on channel event | **MATERIAL** (if channels exist) | Peers cannot be requested to force-close |
| **`wallet.db`** | Reconstructable | 24-word Aezeed Mnemonic | **LOW** | Re-derive from seed via `lncli create` |
| **`admin.macaroon`** | Active Auth State | Stored in `macaroon.db` | **LOW** | Controlled recreation of root keys & re-issuance |
| **`router.macaroon`** | Delegated Token | Minted under Root Key ID 100 | **LOW** | Re-bake under Root Key ID 100 |
| **`tls.cert` / `tls.key`** | Regenerable | Re-generated on startup | **NEGLIGIBLE** | Re-generate, distribute cert to Router |
| **`lnd.conf`** | Static Configuration | Git / Sovereign Config | **NEGLIGIBLE** | Re-deploy from versioned repository |

*(Note: `macaroon.db` is active authentication/root-key state, NOT an independent disaster-recovery backup. Loss or rotation requires controlled recreation of root keys and re-issuance of credentials after secure wallet recovery. The admin macaroon is NOT recoverable from aezeed).*

---

### 3. STATIC CHANNEL BACKUP (SCB) LIFECYCLE & OFF-HOST WORKER

#### 3.1 SCB Generation & Event Hook
- LND updates `/srv/sovereign-router/lightning/backups/channel.backup` automatically upon channel open, channel close, and state changes.
- **RPC Verification**: `SubscribeChannelBackups` is verified available in LND `v0.21.3-beta`.
- **Encryption**: SCB is encrypted using a key derived from the node's seed.

#### 3.2 3-Layer Backup Architecture
- **Layer 1 (Local Durable State)**:
  - File: `/srv/sovereign-router/lightning/backups/channel.backup` (mode `0600`, owned by `2102:2102`).
- **Layer 2 (Encrypted Off-Host Backup)**:
  - Automated backup worker monitors `SubscribeChannelBackups`.
  - Encrypts `channel.backup` with GPG (AES-256) using an off-host public key.
  - Synchronizes to dedicated off-site backup storage within a **5-minute SLA**.
  - Plaintext SCB bytes are **never logged**.
- **Layer 3 (Offline Vault)**:
  - 24-word Aezeed recovery mnemonic and GPG private decryption key stored in physical cold storage.

#### 3.3 Backup Verification & Restore Drills
- Automated weekly validation using:
  ```bash
  lncli verifychanbackup --multi_file=/var/lib/lnd/backups/channel.backup
  ```
- Mandatory non-production disaster recovery drill required prior to committing meaningful capital.

---

### 4. DISASTER RECOVERY RUNBOOKS (SCENARIOS A - J)

#### Scenario A: LND Container Destroyed (Host & Disk Intact)
- **Blast Radius**: Temporary Lightning service interruption. Zero fund risk.
- **Action**:
  ```bash
  docker compose -p sovereign-router up -d sovereign-lnd
  ```
- **Verification**: `docker inspect sovereign-lnd`, verify `channel.db` re-opened, channels active.

#### Scenario B: LND Data Volume Corrupted / Disk Error
- **Blast Radius**: Live channel database unrecoverable. Channels must be closed.
- **Risk Level**: **CONDITIONAL / MATERIAL** (Funds returned on-chain minus closing fees).
- **Procedure**:
  1. Stop LND: `docker compose -p sovereign-router stop sovereign-lnd`.
  2. Initialize clean data directory `/srv/sovereign-router/lightning/data/`.
  3. Start LND container with clean volume.
  4. Restore on-chain wallet from offline 24-word Aezeed: `lncli create`.
  5. Restore channels via latest SCB:
     ```bash
     lncli restorechanbackup --multi_file=/var/lib/lnd/backups/channel.backup
     ```
  6. LND contacts peers via DLP to force-close channels.
  7. On-chain outputs sweep to wallet after CSV delay (144–2016 blocks).

#### Scenario C: Entire Server Lost
- **Blast Radius**: Complete host destruction.
- **Risk Level**: **CONDITIONAL / MATERIAL**.
- **Procedure**:
  1. Provision replacement server running hardened Ubuntu LTS.
  2. Install and fully synchronize Bitcoin Core (Phase 2D certified).
  3. Deploy Sovereign Router container configuration.
  4. Fetch latest encrypted `channel.backup` from Layer 2 off-host storage.
  5. Fetch 24-word Aezeed mnemonic from Layer 3 offline vault.
  6. Execute `lncli create` with seed, then `lncli restorechanbackup`.
  7. Sweep recovered on-chain funds to cold storage.

#### Scenario D: Wallet Seed Retained, but Channel DB Lost
- **Blast Radius & Procedure**: Identical to Scenario B. **NEVER attempt to rebuild or salvage an inconsistent `channel.db` manually**.

#### Scenario E: Static Channel Backup Retained, but Seed Lost
- **Blast Radius**: **CATASTROPHIC (Complete Fund Loss)**. SCB is encrypted with a key derived from the seed. Without the seed, SCB is cryptographically unrecoverable.
- **Mitigation**: Prevention only. Physical seed custody in cold vault.

#### Scenario F: Router Macaroon Compromised
- **Blast Radius**: Attacker can inspect invoices or generate bogus invoices. (Cannot spend funds due to receive-only permission).
- **Action**:
  ```bash
  lncli deletemacaroonid 100
  ```
  Root Key ID 100 is instantly deleted; compromised token invalidated immediately without rotating admin credentials.

#### Scenario G: TLS Private Key Compromised
- **Blast Radius**: Potential MITM on internal Docker bridge.
- **Action**: Delete `tls.key` and `tls.cert` from `/secrets/`. Restart LND. Distribute new `tls.cert` to Router.

#### Scenario H: Sovereign Router Compromised
- **Blast Radius**: Zero direct fund drain risk (payment permission denied).
- **Containment**: Stop Router container. Invalidate Root Key ID 100. Audit invoice database.

#### Scenario I: Bitcoin Core Corrupted / Rebuilding
- **Blast Radius**: Temporary Lightning downtime during chain resync.
- **Action**: Stop LND to prevent desynchronization. Complete bitcoind IBD. Restart LND.

#### Scenario J: Unexpected Power Loss During In-Flight HTLC
- **Blast Radius**: HTLC in transition.
- **Action**: Bbolt WAL ensures database consistency. On reboot, LND renegotiates state with channel peers. Expired HTLCs resolve on-chain via breach arbiter.

---
*End of LND Recovery Plan.*
