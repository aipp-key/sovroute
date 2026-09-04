# UNIVERSAL AGENT ASSET ROUTER — V4 SOVEREIGN CORE
## Disaster Recovery & Operations Runbook (Phase 7)

This runbook establishes strict, fail-closed operational procedures for deploying, operating, recovering, and maintaining the V4 Sovereign Core engine.

---

### Core Operational Principles
1. **Never Guess Economic State**: Never speculate on the outcome of an in-flight or ambiguous payment.
2. **Authoritative Rails Win**: The state on the physical blockchain (Base Sepolia) and LND channel state are the sole sources of truth.
3. **Never Manually Edit Economic DB Rows**: Database rows contain cryptographically hashed state transition audit trails. Manual SQL mutations can trigger `IMMUTABLE_FINGERPRINT_MISMATCH`.
4. **Preserve Evidence**: Always backup database and log files before performing any recovery operations.
5. **Fail-Closed Default**: If connectivity or consensus integrity cannot be proven, halt progress into `RECOVERY_REQUIRED`.

---

### Scenario A: Service Will Not Start
**Symptoms**: Process terminates immediately on launch with non-zero exit code.
**Diagnostic Steps**:
1. Check process stdout/stderr for `PRODUCTION_CONFIG_ERROR` or `CRITICAL_MAINNET_FORBIDDEN`.
2. Verify environment configuration:
   - Chain ID must be `84532` (Base Sepolia). If set to `8453` or `1`, engine halts fail-closed.
   - USDC token address must be `0x036CbD53842c5426634e7929541eC2318f3dCF7e`.
   - Ensure `allowMainnet` is NOT set to true.
   - Ensure `databasePath` is writable and not `:memory:` in production profile.
3. Verify LND TLS certificate and macaroon paths exist and have valid permissions.

---

### Scenario B: LND Unavailable
**Symptoms**: Coordinator logs `LND_RPC_TIMEOUT` or connection refused; health report marks `lightningRail: DOWN` and status `DEGRADED`.
**Procedure**:
1. Service automatically degrades and pauses Lightning settlement/cancellation calls.
2. Existing swaps with confirmed EVM claims retain on-chain claim evidence safely in SQLite.
3. Do NOT refund Base: once client claims on Base, preimage is on-chain and cannot be revoked.
4. Restore LND connectivity. The coordinator's `reconcileAll()` will automatically resume pending invoice settlements.

---

### Scenario C: Base RPC Unavailable
**Symptoms**: Base transaction submissions time out; health report marks `evmRail: DOWN` and status `DEGRADED`.
**Procedure**:
1. Base transaction manager pauses outbound broadcasts without consuming nonces.
2. In-flight transactions mined on-chain will be discovered via `getTransactionReceipt` once RPC resumes.
3. If primary RPC fails, point `EVM_RPC_URL` to a verified failover Base Sepolia RPC endpoint and restart.

---

### Scenario D: Both Rails Unavailable Simultaneously
**Symptoms**: Health report status `DEGRADED` or `UNHEALTHY`; `reconcileSwap` logs `LND and EVM RPCs both unavailable`.
**Procedure**:
1. Coordinator automatically flags in-flight swaps with `recoveryRequired = true` and `failureReason = 'RECONCILIATION_RPC_UNAVAILABLE'`.
2. Engine strictly halts without guessing to prevent split-brain double settlement or premature refund.
3. Restore infrastructure connectivity. Once both rails are reachable, run `reconcileAll()` or trigger coordinator restart.

---

### Scenario E: Database Locked (SQLite Busy Contention)
**Symptoms**: SQLite errors containing `SQLITE_BUSY` or database lock contention.
**Procedure**:
1. Check for stale processes holding file locks (`Get-Process node`).
2. Ensure only one coordinator process instance has write access per database file (or that workers share action leases).
3. Verify WAL mode is active (`PRAGMA journal_mode;` returns `wal`).
4. Never delete `.wal` or `.shm` files while any process is open.

---

### Scenario F: Database Corrupted
**Symptoms**: `PRAGMA integrity_check` returns errors; engine fails to start with database corrupted error.
**Procedure**:
1. **DO NOT DELETE THE DATABASE**.
2. Immediately make a cold file copy of the corrupted `.db`, `.wal`, and `.shm` files to an isolated directory.
3. If a valid backup exists, follow **Scenario G** to restore.
4. After restore, boot coordinator. Coordinator will re-read external rails (LND invoice state and Base contract storage) and synchronize local state with authoritative on-chain reality.

---

### Scenario G: Backup & Restore Procedure
**Creating an Online Consistent Backup**:
```typescript
import { BackupService } from './src/persistence/backup.ts';
BackupService.createBackup(db, '/backups/router-backup-2026-09-04.db');
```
**Restoring a Backup (Isolated Staging Procedure)**:
1. Stop running router process (`SIGTERM`).
2. Run restore command to a **new, isolated target path** (in-place overwriting of existing/active DBs is prohibited fail-closed):
```typescript
BackupService.restoreBackup(
  '/backups/router-backup-2026-09-04.db',
  '/var/data/router-restored.db'
);
```
3. Archive old database files and activate the restored database:
```bash
mv /var/data/router.db /var/data/router-corrupt-archive.db
mv /var/data/router-restored.db /var/data/router.db
```
4. Restart router. The coordinator executes `reconcileAll()` upon boot to align with live blockchain receipts.

---

### Scenario H: Resolving `RECOVERY_REQUIRED` Swaps
**Symptoms**: Health report marks status `RECOVERY_REQUIRED`; swap rows have `recovery_required = 1`.
**Procedure**:
1. Query swap details:
   `SELECT id, state, failure_reason, evm_tx_hash FROM sovereign_swaps WHERE recovery_required = 1;`
2. Query transition audit log:
   `SELECT * FROM sovereign_swap_transitions WHERE execution_id = '<swap_id>' ORDER BY created_at ASC;`
3. Inspect external rail reality:
   - Check LND invoice state (`lncli lookupinvoice <hash>`).
   - Check Base contract state (`observeHtlc(swapKey)` on Base Sepolia).
4. Run coordinator reconciliation:
   `coordinator.reconcileSwap('<swap_id>')`.
   The coordinator will authoritatively converge the record to `COMPLETED` or `REFUNDED` based on verified rail receipts.

---

### Scenario I: Process Crashed During External Transaction
**Symptoms**: Machine rebooted or process died while transaction was broadcast to Base or LND.
**Procedure**:
1. Start coordinator normally.
2. Startup recovery inspects SQLite:
   - For Base transactions in `PREPARED` or `BROADCAST`, `BaseTransactionManager.recoverOnStartup()` discovers if the transaction was already mined on-chain using the deterministic nonce and receipt checks.
   - For Lightning settlements in `LIGHTNING_SETTLEMENT_PENDING`, `reconcileSwap()` queries `getInvoiceState`. If `SETTLED`, it marks `COMPLETED`. If `ACCEPTED`, it safely retries settlement.

---

### Scenario J: Unknown Transaction Status (Mempool Drop / Reorg)
**Symptoms**: Transaction hash submitted but receipt is not found after timeout.
**Procedure**:
1. Transaction manager automatically replaces underpriced pending transactions via EIP-1559 10% fee bumps up to configured `maxReplacements`.
2. If receipt disappears due to reorg before required finality (2 confirmations), the coordinator pauses and waits for canonical block mining.
3. No action is ever settled on Lightning until Base claim receipt reaches 2 confirmations.

---

### Scenario K: Software Rollback Procedure
**Procedure**:
1. Stop running router process.
2. Take a cold backup of current database: `BackupService.createBackup(db, '/backups/pre-rollback.db')`.
3. Check out the previous frozen Git SHA (e.g., `git checkout <previous_frozen_sha>`).
4. Verify database schema compatibility. If schema is incompatible, restore previous backup corresponding to that release.
5. Start router. Coordinator will reconcile live swaps against authoritative rails.

---

### Scenario L: Suspected Secret Compromise
**Symptoms**: Operator wallet private key or LND credentials potentially exposed.
**Procedure**:
1. Immediately stop the router process.
2. Revoke LND macaroon (`lncli bakemacaroon` with new root key or revoke existing).
3. Transfer remaining operator collateral from the compromised EVM operational address to a secure cold address.
4. Update configuration with new operational credentials.
5. Re-run secret scanner: `python tests/scan-secrets.py` to confirm zero credentials in codebase or logs.
