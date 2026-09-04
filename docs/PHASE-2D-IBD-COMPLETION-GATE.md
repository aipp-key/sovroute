# UNIVERSAL AGENT ASSET ROUTER
## PHASE 2D: BITCOIN CORE IBD COMPLETION GATE SPECIFICATION (FROZEN SPECIFICATION)

---

### 1. PURPOSE & PRECONDITION

This specification defines the objective, verifiable criteria required to certify that Bitcoin Core Initial Block Download (IBD) is complete before any LND deployment may commence.

LND requires a fully synchronized chain backend to verify UTXO states, monitor channel funding, and detect breach attempts.

---

### 2. OBJECTIVE PASS CRITERIA (CHECKLIST)

A formal PASS for Phase 2D requires 100% adherence to the following:

1. **Chain Identification**: `chain == "main"`
2. **IBD Completion**: `initialblockdownload == false`
3. **Tip Alignment**:
   - `blocks` is within 2 blocks of `headers`
   - `headers` matches current public mainnet block height
4. **Verification Progress**: `verificationprogress >= 0.9999`
5. **Prune Health**:
   - `pruned == true`
   - `size_on_disk` within approved prune target (`prune_target_size: 57671680000`)
6. **Network Safety Guard**:
   - `listen == 0`
   - `inbound peers == 0`
   - `outbound peers >= 8`
7. **Port Privacy**:
   - Port 8333 has **0 host listeners** (`ss -lntup | grep 8333` is empty)
   - Port 8332 (RPC) has **0 host listeners**
   - Docker publishes **0 ports** (`docker port sovereign-bitcoind` is empty)
8. **Host Resources**:
   - Available host disk space > 180 GB (GREEN threshold)
   - Host load average within safe baseline (< 2.0)
   - Host RAM available > 20 GB
9. **AIPP Zero-Impact Proof**:
   - `aipp-key`, `aipp-db`, `aipp-redis`, `aipp-phoenixd`, `aipp-lnbits` have **identical StartedAt** and **0 restarts** (verified via read-only inspection; AIPP was never mutated or restarted).

---

### 3. AUTOMATED VERIFICATION SCRIPT

```bash
#!/bin/bash
set -euo pipefail

echo "=== PHASE 2D IBD COMPLETION AUDIT ==="

echo "--- 1. Blockchain State ---"
docker exec sovereign-bitcoind bitcoin-cli -conf=/config/bitcoin.conf -datadir=/data getblockchaininfo | jq '{
  chain: .chain,
  blocks: .blocks,
  headers: .headers,
  ibd: .initialblockdownload,
  verification_progress: .verificationprogress,
  size_on_disk: .size_on_disk,
  pruned: .pruned
}'

echo "--- 2. Network & Peer State ---"
docker exec sovereign-bitcoind bitcoin-cli -conf=/config/bitcoin.conf -datadir=/data getnetworkinfo | jq '{
  version: .version,
  networkactive: .networkactive,
  connections: .connections,
  connections_in: .connections_in,
  connections_out: .connections_out
}'

echo "--- 3. Port Privacy ---"
docker port sovereign-bitcoind || echo "PASS: No docker port mappings"
ss -lntup | grep -E '8332|8333|28332|28333' || echo "PASS: No Bitcoin host listeners"

echo "--- 4. Host Resources ---"
df -h /
free -h

echo "--- 5. AIPP Invariance (Read-Only Inspection) ---"
docker inspect --format '{{.Name}}: StartedAt={{.State.StartedAt}} Restarts={{.RestartCount}}' aipp-key aipp-db aipp-redis aipp-phoenixd aipp-lnbits
```

---
*End of Phase 2D IBD Completion Gate Specification.*
