/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Cross-Process Base Inventory Reconciliation & Safe Headroom Safety Suite
 *
 * Requirements (Step 19):
 * 1. Independent SqlitePersistence connections to the SAME SQLite file across separate OS processes.
 * 2. 100 USDC safe pool (W_safe = 100,000,000 units).
 * 3. Five separate child processes requesting 30 USDC concurrently:
 *    - Exactly 3 succeed, 2 fail closed.
 *    - Total reserved = 90 USDC, remaining safe headroom = 10 USDC.
 *    - Zero oversubscription, zero corruption, zero duplicate reservations.
 * 4. Simulate wallet drop to 70 USDC onchain -> Reconciler / Snapshot marks DEFICIT.
 * 5. New reservation requests from child processes fail closed immediately with LIQUIDITY_DEFICIT.
 * 6. Verify DB consistency across all PIDs and from fresh parent process.
 * 7. Actual OS child processes verified via distinct PIDs (NO Promise.all shortcuts).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { SqlitePersistence } from '../src/persistence/sqlite.ts';
import { type ReconciliationWorkerInitMessage } from './helpers/inventory-reconciliation-worker.ts';

interface WorkerResult {
  pid: number;
  executionId: string;
  success: boolean;
  reservationId: string | null;
  error: string | null;
  invoiceCreated: boolean;
}

const defaultToken = '0x6c84a8f1c29108f47a79964b5fe888d4f4d0de40';
const workerScriptPath = join(import.meta.dirname, 'helpers', 'inventory-reconciliation-worker.ts');

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

describe('BASE INVENTORY RECONCILIATION — CROSS-PROCESS HEADROOM SAFETY', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), 'phase-inv-crossproc-' + randomUUID() + '.db');
  });

  afterEach(() => {
    try {
      if (existsSync(dbPath)) rmSync(dbPath, { force: true });
    } catch {}
  });

  it('1. Five separate child processes: 5 x 30 USDC over 100 USDC safe pool -> exactly 3 succeed, 2 fail closed', async () => {
    // 1. Seed DB with Chain Inventory Snapshot: 100 USDC safe capacity, state READY
    const seedPersistence = new SqlitePersistence({ filename: dbPath });
    const initialPool = 100_000_000n; // 100 USDC (6 decimals)
    seedPersistence.recordChainInventorySnapshot({
      tokenAddress: defaultToken,
      chainId: 84532,
      operatorAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      walletBalanceLatest: initialPool,
      walletBalanceFinalized: initialPool,
      safeWalletCapacity: initialPool,
      latestBlockNumber: 5000,
      finalizedBlockNumber: 4998,
      readinessState: 'READY',
      observedAt: new Date(),
      updatedAt: new Date(),
    });
    seedPersistence.setConfirmedOperatorBalance(defaultToken, initialPool);
    seedPersistence.close();

    const requestUnits = 30_000_000n; // 30 USDC
    const count = 5;
    const configs: ReconciliationWorkerInitMessage[] = Array.from({ length: count }, (_, i) => ({
      type: 'INIT',
      dbPath,
      tokenAddress: defaultToken,
      executionId: 'exec_proc_5_' + i + '_' + randomUUID(),
      amountUnits: requestUnits.toString(),
      mode: 'direct',
    }));

    const results = await runChildWorkers(configs);

    assert.equal(results.length, 5, 'All 5 workers must return results');
    const pids = new Set(results.map((r) => r.pid));
    assert.equal(pids.size, 5, 'Must be 5 distinct OS child process PIDs');

    const successes = results.filter((r) => r.success);
    const failures = results.filter((r) => !r.success);

    assert.equal(successes.length, 3, 'Exactly 3 reservations must succeed (3 x 30 = 90 USDC <= 100 USDC)');
    assert.equal(failures.length, 2, 'Exactly 2 reservations must fail closed');

    // Fresh parent verification
    const freshDb = new SqlitePersistence({ filename: dbPath });
    const headroom = freshDb.getSafeHeadroom(defaultToken);
    assert.equal(headroom, 10_000_000n, 'Remaining safe headroom must be exactly 10 USDC');

    const state = freshDb.getInventoryReadinessState(defaultToken);
    assert.equal(state, 'READY', 'Readiness state remains READY while headroom >= 0');
    freshDb.close();
  });

  it('2. Onchain wallet drop below obligations induces DEFICIT and halts subsequent child reservations', async () => {
    // 1. Seed DB with 100 USDC safe pool
    const seedPersistence = new SqlitePersistence({ filename: dbPath });
    const initialPool = 100_000_000n;
    seedPersistence.recordChainInventorySnapshot({
      tokenAddress: defaultToken,
      chainId: 84532,
      operatorAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      walletBalanceLatest: initialPool,
      walletBalanceFinalized: initialPool,
      safeWalletCapacity: initialPool,
      latestBlockNumber: 5000,
      finalizedBlockNumber: 4998,
      readinessState: 'READY',
      observedAt: new Date(),
      updatedAt: new Date(),
    });
    seedPersistence.setConfirmedOperatorBalance(defaultToken, initialPool);

    // Make 3 reservations of 30 USDC (total 90 USDC reserved)
    seedPersistence.reserveLiquidity('exec-hold-1', defaultToken, 30_000_000n);
    seedPersistence.reserveLiquidity('exec-hold-2', defaultToken, 30_000_000n);
    seedPersistence.reserveLiquidity('exec-hold-3', defaultToken, 30_000_000n);

    // 2. Simulate onchain drop: wallet dropped to 70 USDC (less than 90 USDC obligations)
    seedPersistence.recordChainInventorySnapshot({
      tokenAddress: defaultToken,
      chainId: 84532,
      operatorAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      walletBalanceLatest: 70_000_000n,
      walletBalanceFinalized: 70_000_000n,
      safeWalletCapacity: 70_000_000n,
      latestBlockNumber: 5010,
      finalizedBlockNumber: 5008,
      readinessState: 'DEFICIT',
      observedAt: new Date(),
      updatedAt: new Date(),
    });
    seedPersistence.close();

    // 3. Launch 2 child processes attempting to reserve 1 USDC
    const configs: ReconciliationWorkerInitMessage[] = [
      {
        type: 'INIT',
        dbPath,
        tokenAddress: defaultToken,
        executionId: 'exec_deficit_1_' + randomUUID(),
        amountUnits: '1000000',
        mode: 'direct',
      },
      {
        type: 'INIT',
        dbPath,
        tokenAddress: defaultToken,
        executionId: 'exec_deficit_2_' + randomUUID(),
        amountUnits: '1000000',
        mode: 'direct',
      },
    ];

    const results = await runChildWorkers(configs);
    assert.equal(results.length, 2);
    assert.equal(results[0].success, false, 'Child worker 1 must fail in DEFICIT state');
    assert.equal(results[1].success, false, 'Child worker 2 must fail in DEFICIT state');
    assert.match(results[0].error ?? '', /DEFICIT|INSUFFICIENT/);
    assert.match(results[1].error ?? '', /DEFICIT|INSUFFICIENT/);

    // Fresh parent check
    const freshDb = new SqlitePersistence({ filename: dbPath });
    const headroom = freshDb.getSafeHeadroom(defaultToken);
    assert.equal(headroom < 0n, true, 'Headroom is negative under deficit (70 - 90 = -20)');
    freshDb.close();
  });
});
