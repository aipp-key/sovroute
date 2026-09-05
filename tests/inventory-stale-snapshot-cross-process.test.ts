/**
 * UNIVERSAL AGENT ASSET ROUTER — SOVROUTE ARCHITECTURE V4
 * Cross-Process Stale Snapshot & Transactional Freshness Certification
 *
 * Requirements:
 * 1. Seed DB with an expired chain snapshot (freshUntil in the past).
 * 2. Fork 5 separate child OS processes attempting reservations concurrently.
 * 3. Verify ALL 5 child processes fail closed (0 succeed).
 * 4. Verify snapshot is marked DEGRADED inside BEGIN IMMEDIATE in SQLite.
 * 5. Verify zero reservations created.
 * 6. Refresh snapshot to READY with valid freshUntil (+60s).
 * 7. Fork 5 child processes again (30 USDC each over 100 USDC safe capacity):
 *    - Exactly 3 succeed, 2 fail closed.
 *    - Remaining safe headroom = 10 USDC.
 * 8. Genuinely distinct OS PIDs verified across all workers.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { SqlitePersistence } from '../src/persistence/sqlite.ts';
import { OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS } from '../src/atomic/evm/base-guard.ts';
import type { ReconciliationWorkerInitMessage } from './helpers/inventory-reconciliation-worker.ts';

const canonicalUsdc = OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS.toLowerCase();
const operatorAddress = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const workerScriptPath = join(import.meta.dirname, 'helpers', 'inventory-reconciliation-worker.ts');

interface WorkerResult {
  pid: number;
  executionId: string;
  success: boolean;
  reservationId: string | null;
  error: string | null;
  invoiceCreated: boolean;
}

function runChildWorkers(configs: ReconciliationWorkerInitMessage[]): Promise<WorkerResult[]> {
  return new Promise((resolve, reject) => {
    const results: WorkerResult[] = [];
    const children: any[] = [];
    let readyCount = 0;
    let exitCount = 0;

    for (const cfg of configs) {
      const child = fork(workerScriptPath, [], {
        execArgv: ['--experimental-strip-types'],
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      });

      children.push(child);

      child.on('message', (msg: any) => {
        if (msg.type === 'READY') {
          readyCount++;
          if (readyCount === configs.length) {
            for (const c of children) {
              c.send({ type: 'START' });
            }
          }
        } else if (msg.type === 'RESULT') {
          results.push(msg as WorkerResult);
        }
      });

      child.on('exit', () => {
        exitCount++;
        if (exitCount === configs.length) {
          resolve(results);
        }
      });

      child.on('error', (err: any) => {
        reject(new Error('Child process failed: ' + (err?.message || 'unknown')));
      });

      child.send(cfg);
    }
  });
}

describe('BASE INVENTORY RECONCILIATION — STALE SNAPSHOT CROSS-PROCESS SAFETY', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), 'phase-stale-crossproc-' + randomUUID() + '.db');
  });

  afterEach(() => {
    try {
      if (existsSync(dbPath)) rmSync(dbPath, { force: true });
    } catch {}
  });

  it('1. Five child OS processes fail closed when snapshot freshUntil is expired, then succeed upon refresh', async () => {
    const poolCapacity = 100_000_000n; // 100 USDC
    const pastDate = new Date(Date.now() - 30_000); // 30 seconds in the past

    // Seed operator inventory and STALE snapshot
    const seedPersistence = new SqlitePersistence({ filename: dbPath });
    seedPersistence.setConfirmedOperatorBalance(canonicalUsdc, poolCapacity);
    seedPersistence.recordChainInventorySnapshot({
      tokenAddress: canonicalUsdc,
      chainId: 84532,
      operatorAddress,
      walletBalanceLatest: poolCapacity,
      walletBalanceFinalized: poolCapacity,
      safeWalletCapacity: poolCapacity,
      latestBlockNumber: 5000,
      finalizedBlockNumber: 4998,
      readinessState: 'READY', // Claimed ready but expired freshUntil!
      observedAt: pastDate,
      freshUntil: pastDate,
      updatedAt: pastDate,
    });
    seedPersistence.close();

    // 1. Launch 5 child processes attempting 20 USDC each
    const requestAmount = (20_000_000n).toString();
    const staleConfigs: ReconciliationWorkerInitMessage[] = Array.from({ length: 5 }, (_, i) => ({
      type: 'INIT',
      dbPath,
      tokenAddress: canonicalUsdc,
      executionId: 'stale_exec_' + i + '_' + randomUUID(),
      amountUnits: requestAmount,
      mode: 'reconciled',
    }));

    const staleResults = await runChildWorkers(staleConfigs);

    // Verify distinct OS PIDs
    const stalePids = new Set(staleResults.map((r) => r.pid));
    assert.strictEqual(stalePids.size, 5, 'All 5 workers must have distinct OS PIDs');

    // ALL 5 MUST FAIL CLOSED
    const staleSuccesses = staleResults.filter((r) => r.success);
    const staleFailures = staleResults.filter((r) => !r.success);
    assert.strictEqual(staleSuccesses.length, 0, 'Zero reservations should succeed with stale snapshot');
    assert.strictEqual(staleFailures.length, 5, 'All 5 child processes must fail closed');

    for (const res of staleFailures) {
      assert.match(res.error ?? '', /stale|DEGRADED|EvmInventoryUnavailableError/i);
    }

    // Verify SQLite state: snapshot marked DEGRADED, zero reserved
    const verifyPersistence1 = new SqlitePersistence({ filename: dbPath });
    const snapshotAfterStale = verifyPersistence1.getLatestChainInventorySnapshot(canonicalUsdc);
    assert.ok(snapshotAfterStale);
    assert.strictEqual(snapshotAfterStale.readinessState, 'DEGRADED');

    const stateAfterStale = verifyPersistence1.getInventoryReadinessState(canonicalUsdc);
    assert.strictEqual(stateAfterStale, 'DEGRADED');

    // 2. Refresh snapshot to READY with valid future freshUntil (+60s)
    const futureDate = new Date(Date.now() + 60_000);
    verifyPersistence1.recordChainInventorySnapshot({
      tokenAddress: canonicalUsdc,
      chainId: 84532,
      operatorAddress,
      walletBalanceLatest: poolCapacity,
      walletBalanceFinalized: poolCapacity,
      safeWalletCapacity: poolCapacity,
      latestBlockNumber: 5001,
      finalizedBlockNumber: 4999,
      readinessState: 'READY',
      observedAt: new Date(),
      freshUntil: futureDate,
      updatedAt: new Date(),
    });
    verifyPersistence1.close();

    // 3. Launch 5 child processes requesting 30 USDC each over 100 USDC pool
    const freshRequestAmount = (30_000_000n).toString();
    const freshConfigs: ReconciliationWorkerInitMessage[] = Array.from({ length: 5 }, (_, i) => ({
      type: 'INIT',
      dbPath,
      tokenAddress: canonicalUsdc,
      executionId: 'fresh_exec_' + i + '_' + randomUUID(),
      amountUnits: freshRequestAmount,
      mode: 'reconciled',
    }));

    const freshResults = await runChildWorkers(freshConfigs);

    const freshPids = new Set(freshResults.map((r) => r.pid));
    assert.strictEqual(freshPids.size, 5, 'All 5 workers must have distinct OS PIDs');

    const freshSuccesses = freshResults.filter((r) => r.success);
    const freshFailures = freshResults.filter((r) => !r.success);

    // Exactly 3 succeed (3 * 30 = 90 <= 100), exactly 2 fail (90 + 30 = 120 > 100)
    assert.strictEqual(freshSuccesses.length, 3, 'Exactly 3 reservations must succeed');
    assert.strictEqual(freshFailures.length, 2, 'Exactly 2 reservations must fail closed');

    // Verify DB consistency
    const verifyPersistence2 = new SqlitePersistence({ filename: dbPath });
    const headroom = verifyPersistence2.getSafeHeadroom(canonicalUsdc);
    assert.strictEqual(headroom, 10_000_000n, 'Remaining headroom must be exactly 10 USDC');

    const reservations = verifyPersistence2.listLiquidityReservations(canonicalUsdc);
    const activeReserved = reservations
      .filter((r) => r.status === 'RESERVED')
      .reduce((acc, r) => acc + r.amountUnits, 0n);
    assert.strictEqual(activeReserved, 90_000_000n, 'Total reserved must be 90 USDC');
    verifyPersistence2.close();
  });
});
