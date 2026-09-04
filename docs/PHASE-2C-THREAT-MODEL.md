# UNIVERSAL AGENT ASSET ROUTER
## PHASE 2C: LND THREAT MODEL & RISK ANALYSIS (FROZEN SPECIFICATION)

---

### 1. OVERVIEW & METHODOLOGY

This document provides a formal STRIDE and blast-radius threat model for the Lightning Network Daemon (LND `v0.21.3-beta`) component within the Sovereign Router infrastructure.

Residual risks are classified realistically as:
- **NEGLIGIBLE**
- **LOW**
- **CONDITIONAL**
- **MATERIAL**
- **CATASTROPHIC**

---

### 2. THREAT MATRIX

| ID | Threat Scenario | Actor | Vector | Likelihood | Impact | Prevention Controls | Detection | Recovery Action | Residual Risk |
|---|---|---|---|---|---|---|---|---|---|
| **T01** | Port 9735 Public Exploit / Wire Zero-Day | External Attacker | Public TCP connection to LND wire protocol | Very Low | Critical | **Mode A Outbound-Only**: Port 9735 closed on UFW and unpublished in Docker | UFW reject logs, `ss -lntup` monitoring | N/A (Port is closed) | **NEGLIGIBLE** |
| **T02** | Bitcoin RPC Brute Force / Hijack | External Attacker / Rogue Container | TCP 8332 connection attempt | Very Low | Critical | RPC bound strictly to `sovereign_chain_net` (`10.240.10.2`). 0 host ports published. `rpcauth` HMAC enabled | Bitcoind RPC logs, Docker netflow | Rotate RPC credentials, isolate container | **NEGLIGIBLE** |
| **T03** | Router Compromise -> LND Admin Escalation | Malicious Actor in Router | Injected code uses LND gRPC | Low | High | **Macaroon Least Privilege & Root Key ID 100**: Router holds only receive-only macaroon. Cannot close channels, cannot sweep on-chain, cannot access wallet/seed | LND audit log of invalid RPC attempts | Revoke Root Key ID 100 via `lncli deletemacaroonid 100` | **LOW** |
| **T04** | Router Compromise -> Wallet Drain via Payments | Malicious Actor in Router | High-frequency payment attempts | Low | Critical | **Payment Denied by Default**: Outbound payment permission NOT granted to Router. Requires external Payment Policy Service boundary | Router request logs | Invalidate Router macaroon | **NEGLIGIBLE** (Permission Denied) |
| **T05** | Router Compromise -> Bitcoin Core Attack | Malicious Actor in Router | Router attempts to scan/exploit bitcoind | Very Low | Critical | **Docker Network Segmentation**: Router is on `sovereign_router_net`; has NO route to `sovereign_chain_net` or bitcoind IP | iptables bridge logs | Destroy compromised Router container | **NEGLIGIBLE** |
| **T06** | Compromised LND Container -> Host Escape | Attacker exploiting LND binary vulnerability | Kernel exploit / escape | Low | Critical | `CapDrop: ["ALL"]`, `ReadonlyRootfs: true`, `no-new-privileges: true`, non-root user `2102:2102`, no socket mounts | Host auditd, container exit events | Host incident response, rebuild host | **LOW** |
| **T07** | Aezeed Mnemonic Exfiltration from Server | Attacker with read-only host access | File scraping | Very Low | Catastrophic | **Mnemonic never on server storage**: The 24-word aezeed recovery mnemonic must never be stored in plaintext on production server storage, logs, Git, environment variables, or documentation | File integrity monitoring | Immediate channel cooperative close, sweep on-chain funds to cold storage | **NEGLIGIBLE** (Mnemonic not on host) |
| **T08** | Channel Database Corruption / State Invalidation | Power loss / bad disk write / operator restoring old DB | Invalidation of commitment transaction | Low | Catastrophic | **Never restore old `channel.db`**. Use Static Channel Backups (`channel.backup`) only. Bbolt WAL sync | LND startup verification failure | SCB force-close recovery protocol | **CONDITIONAL** (Dependent on peer response) |
| **T09** | Remote Peer Fraud / Old State Broadcast | Malicious routing channel partner | Peer broadcasts outdated commitment tx | Medium | High | LND internal breach arbiter active 24/7; Bitcoin Core synced to tip; Anchor outputs enabled | LND channel monitor alerts | Automatic breach remedy sweeps 100% of peer balance | **LOW** |
| **T10** | Supply-Chain Compromise (Malicious Image) | Compromised upstream registry / tag | Trojaned LND container | Low | Critical | Pinned release `v0.21.3-beta`, GPG signed manifest verification, official `/verify-install.sh`, official Docker digest pinning at deploy | Pre-deployment image verification | Rollback to certified clean digest | **LOW** |
| **T11** | Operator Secret Leakage in Logs / Git | Human error / misconfigured logging | Accidental echo of passwords/macaroons | Medium | Medium | Automated git pre-commit hooks, `.gitignore` exclusions, strict LND logging policy, JSON logs bounded | Repo scanning, secret linter | Revoke macaroon Root Key ID, rotate passwords | **LOW** |
| **T12** | Host-Level AIPP Interference | AIPP container rogue access | Cross-project network probing | Very Low | High | Strict network segregation (`core_aipp_net` vs `sovereign_*`). Separate subnets, 0 shared volumes | Docker network inspect audits | Re-verify network boundaries | **NEGLIGIBLE** |

---

### 3. COMPROMISE CONTAINMENT & BLAST-RADIUS BOUNDARIES

```
+-------------------------------------------------------------------------------+
| BLAST RADIUS BOUNDARY: sovereign-router COMPROMISE                            |
|                                                                               |
|  [Compromised sovereign-router]                                               |
|      |                                                                        |
|      +---X CANNOT reach Bitcoin Core (isolated on sovereign_router_net)       |
|      +---X CANNOT execute on-chain transactions (no onchain permission)       |
|      +---X CANNOT close or open channels (no channel write permission)        |
|      +---X CANNOT execute outbound payments (permission DENIED by default)    |
|      +---X CANNOT extract recovery mnemonic (mnemonic is offline)             |
|      +---X CANNOT extract admin macaroon (not mounted; separate root key ID)  |
|      +---> CAN ONLY create invoices or query existing invoices                |
+-------------------------------------------------------------------------------+

+-------------------------------------------------------------------------------+
| BLAST RADIUS BOUNDARY: sovereign-lnd COMPROMISE                               |
|                                                                               |
|  [Compromised sovereign-lnd]                                                  |
|      |                                                                        |
|      +---X CANNOT escape container (ReadonlyRootfs, CapDrop ALL, non-root)     |
|      +---X CANNOT steal recovery mnemonic (mnemonic is offline)               |
|      +---X CANNOT modify Bitcoin Core blocks/txs (bitcoind is read-only RPC)  |
|      +---X CANNOT access AIPP services or databases (network isolated)        |
|      +---> CAN corrupt local channel.db -> triggers SCB DLP recovery          |
+-------------------------------------------------------------------------------+
```

---
*End of LND Threat Model.*
