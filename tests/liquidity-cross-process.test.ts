/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Cross-Process Liquidity Accounting & Durable Reservation Safety Suite
 *
 * Requirements:
 * 1. Independent SqlitePersistence connections to the SAME SQLite file across separate OS processes.
 * 2. Seed exactly 100,000,000 USDC atomic units (100 USDC).
 * 3. Two separate child processes requesting 60 USDC each:
 *    - Exactly one succeeds, one fails.
 *    - Total reserved <= confirmed, available >= 0.
 *    - Failed process creates NO Lightning invoice and NO economic side effect.
 * 4. Five separate child processes requesting 30 USDC each:
 *    - Exactly 3 succeed, 2 fail.
 *    - Total reserved = 90 USDC, available = 10 USDC.
 *    - Zero oversubscription, zero corruption, zero duplicate reservations.
 * 5. Re-open DB from fresh parent process to independently verify persisted totals.
 * 6. Validate transactional exclusion and non-negative balances.
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
import { type WorkerInitMessage } from './helpers/liquidity-reservation-worker.ts';

interface WorkerResult {
  pid: number;
  executionId: string;
  success: boolean;
  reservationId: string | null;
  error: string | null;
  invoiceCreated: boolean;
}

const defaultToken = '0x6c84a8f1c29108f47a79964b5fe888d4f4d0de40';
const workerScriptPath = join(import.meta.dirname, 'helpers', 'liquidity-reservation-worker.ts');

function runChildWorkers(configs: WorkerInitMessage[]): Promise<WorkerResult[]> {
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
          // When all child processes have opened their independent SQLite connections, release them simultaneously
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

      child.on('error', (err) => {
        reject(new Error(`Child process failed: ${err.message}`));
      });

      // Send INIT to child
      child.send(cfg);
    }
  });
}

describe('LIQUIDITY ACCOUNTING — CROSS-PROCESS DURABLE RESERVATION SAFETY', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `phase-liq-crossproc-${randomUUID()}.db`);
  });

  afterEach(() => {
    try {
      if (existsSync(dbPath)) rmSync(dbPath, { force: true });
    } catch {}
  });

  // =========================================================================
  // Test 1: Two Separate Processes (60 USDC + 60 USDC over 100 USDC Pool)
  // =========================================================================
  it('1. Two separate child processes: 60+60 over 100 pool -> exactly 1 succeeds, 1 fails with zero invoice', async () => {
    // 1. Seed DB in parent with exactly 100,000,000 USDC atomic units (100 USDC)
    const seedPersistence = new SqlitePersistence({ filename: dbPath });
    const initialPool = 100_000_000n; // 100 USDC (6 decimals)
    seedPersistence.setConfirmedOperatorBalance(defaultToken, initialPool);
    seedPersistence.close();

    const executionIdA = `exec_proc_A_${randomUUID()}`;
    const executionIdB = `exec_proc_B_${randomUUID()}`;
    const requestUnits = 60_000_000n; // 60 USDC

    // 2. Launch 2 genuinely separate OS child processes with independent SQLite connections
    const configs: WorkerInitMessage[] = [
      {
        type: 'INIT',
        dbPath,
        tokenAddress: defaultToken,
        executionId: executionIdA,
        amountUnits: requestUnits.toString(),
        amountSats: '100000',
        hashLock: '0x' + 'a'.repeat(64),
        mode: 'coordinator',
      },
      {
        type: 'INIT',
        dbPath,
        tokenAddress: defaultToken,
        executionId: executionIdB,
        amountUnits: requestUnits.toString(),
        amountSats: '100000',
        hashLock: '0x' + 'b'.repeat(64),
        mode: 'coordinator',
      },
    ];

    const results = await runChildWorkers(configs);

    // Verify genuinely separate processes were used
    assert.strictEqual(results.length, 2);
    assert.notStrictEqual(results[0].pid, process.pid, 'Process A must be a child process');
    assert.notStrictEqual(results[1].pid, process.pid, 'Process B must be a child process');
    assert.notStrictEqual(results[0].pid, results[1].pid, 'Processes A and B must have distinct OS PIDs');

    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    // Invariant: Exactly one succeeds, exactly one fails
    assert.strictEqual(successful.length, 1, 'Exactly one 60 USDC reservation may succeed from 100 USDC pool');
    assert.strictEqual(failed.length, 1, 'Exactly one 60 USDC reservation must fail due to insufficient liquidity');

    // Invariant: Failed process creates NO Lightning hold invoice and NO side effect
    assert.strictEqual(failed[0].invoiceCreated, false, 'Failed process must NEVER create a Lightning hold invoice');
    assert.strictEqual(failed[0].reservationId, null, 'Failed process must have null reservationId');
    assert.ok(
      failed[0].error?.toLowerCase().includes('insufficient') ||
        failed[0].error?.includes('INSUFFICIENT_OPERATOR_INVENTORY'),
      `Failed process error must reflect insufficient inventory: ${failed[0].error}`
    );

    // Invariant: Successful process creates hold invoice and receives reservationId
    assert.strictEqual(successful[0].invoiceCreated, true, 'Successful process must create hold invoice');
    assert.ok(successful[0].reservationId, 'Successful process must receive durable reservationId');

    // 3. Re-open DB from fresh parent process to independently verify persisted totals
    const freshPersistence = new SqlitePersistence({ filename: dbPath });
    const confirmed = freshPersistence.getConfirmedOperatorBalance(defaultToken);
    const reserved = freshPersistence.getReservedOperatorBalance(defaultToken);
    const committed = freshPersistence.getCommittedOperatorBalance(defaultToken);
    const available = freshPersistence.getAvailableOperatorBalance(defaultToken);

    assert.strictEqual(confirmed, 100_000_000n, 'Confirmed balance must remain 100 USDC');
    assert.strictEqual(reserved, 60_000_000n, 'Reserved balance must be exactly 60 USDC');
    assert.strictEqual(committed, 0n, 'Committed balance must be 0');
    assert.strictEqual(available, 40_000_000n, 'Available balance must be exactly 40 USDC');
    assert.ok(available >= 0n, 'Available balance must never become negative');
    assert.ok(reserved <= confirmed, 'Total reserved must never exceed confirmed balance');

    // Verify exactly one durable reservation exists in SQLite
    const reservations = freshPersistence.listLiquidityReservations(defaultToken);
    assert.strictEqual(reservations.length, 1, 'Exactly one durable reservation row must exist in SQLite');
    assert.strictEqual(reservations[0].executionId, successful[0].executionId);
    assert.strictEqual(reservations[0].amountUnits, 60_000_000n);
    assert.strictEqual(reservations[0].status, 'RESERVED');

    freshPersistence.close();
  });

  // =========================================================================
  // Test 2: Five-Process Contention Storm (30 USDC x 5 over 100 USDC Pool)
  // =========================================================================
  it('2. Five-process contention storm: 30x5 over 100 pool -> exactly 3 succeed, 2 fail, 0 oversubscription', async () => {
    // 1. Seed fresh DB with 100,000,000 USDC atomic units (100 USDC)
    const seedPersistence = new SqlitePersistence({ filename: dbPath });
    const initialPool = 100_000_000n;
    seedPersistence.setConfirmedOperatorBalance(defaultToken, initialPool);
    seedPersistence.close();

    const requestUnits = 30_000_000n; // 30 USDC each
    const numProcesses = 5;
    const configs: WorkerInitMessage[] = [];

    for (let i = 0; i < numProcesses; i++) {
      configs.push({
        type: 'INIT',
        dbPath,
        tokenAddress: defaultToken,
        executionId: `exec_storm_${i}_${randomUUID()}`,
        amountUnits: requestUnits.toString(),
        mode: 'direct',
      });
    }

    // 2. Launch 5 separate child processes racing at the synchronization barrier
    const results = await runChildWorkers(configs);

    // Verify 5 distinct OS PIDs
    assert.strictEqual(results.length, 5);
    const pids = new Set(results.map((r) => r.pid));
    assert.strictEqual(pids.size, 5, 'All 5 workers must run as distinct OS processes');
    for (const pid of pids) {
      assert.notStrictEqual(pid, process.pid, 'Worker PID must differ from parent PID');
    }

    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    // Mathematical invariant: 30 * 3 = 90 <= 100. 4th would require 120 > 100.
    assert.strictEqual(successful.length, 3, 'Exactly 3 reservations of 30 USDC may succeed from 100 USDC');
    assert.strictEqual(failed.length, 2, 'Exactly 2 reservations must fail due to exhausted available liquidity');

    // 3. Re-open DB from fresh parent process and verify persisted invariants
    const freshPersistence = new SqlitePersistence({ filename: dbPath });
    const confirmed = freshPersistence.getConfirmedOperatorBalance(defaultToken);
    const reserved = freshPersistence.getReservedOperatorBalance(defaultToken);
    const committed = freshPersistence.getCommittedOperatorBalance(defaultToken);
    const available = freshPersistence.getAvailableOperatorBalance(defaultToken);

    assert.strictEqual(confirmed, 100_000_000n, 'Confirmed balance must remain 100 USDC');
    assert.strictEqual(reserved, 90_000_000n, 'Durable reserved balance must be exactly 90 USDC (3 * 30)');
    assert.strictEqual(committed, 0n, 'Committed balance must be 0');
    assert.strictEqual(available, 10_000_000n, 'Available balance must be exactly 10 USDC (100 - 90)');
    assert.strictEqual(
      confirmed,
      available + reserved + committed,
      'Conservation invariant confirmed = available + reserved + committed must hold strictly'
    );

    // Verify database integrity
    const integrityRow = (freshPersistence as any).db.prepare('PRAGMA integrity_check;').get() as {
      integrity_check: string;
    };
    assert.strictEqual(integrityRow.integrity_check, 'ok', 'SQLite database integrity must be ok');

    // Verify exactly 3 durable reservations exist, matching the successful processes
    const reservations = freshPersistence.listLiquidityReservations(defaultToken);
    assert.strictEqual(reservations.length, 3, 'Exactly 3 reservation rows must exist in SQLite');
    const successfulExecIds = new Set(successful.map((s) => s.executionId));
    for (const r of reservations) {
      assert.ok(successfulExecIds.has(r.executionId), 'Reservation must belong to a successful execution ID');
      assert.strictEqual(r.amountUnits, 30_000_000n);
      assert.strictEqual(r.status, 'RESERVED');
    }

    freshPersistence.close();
  });

  // =========================================================================
  // Test 3: Idempotency Across Separate Processes
  // =========================================================================
  it('3. Cross-process duplicate executionId returns existing reservation with zero double-deduction', async () => {
    const seedPersistence = new SqlitePersistence({ filename: dbPath });
    seedPersistence.setConfirmedOperatorBalance(defaultToken, 100_000_000n);
    seedPersistence.close();

    const sharedExecutionId = `shared_exec_${randomUUID()}`;
    const requestUnits = 50_000_000n; // 50 USDC

    // Two processes with the SAME executionId
    const configs: WorkerInitMessage[] = [
      {
        type: 'INIT',
        dbPath,
        tokenAddress: defaultToken,
        executionId: sharedExecutionId,
        amountUnits: requestUnits.toString(),
        mode: 'direct',
      },
      {
        type: 'INIT',
        dbPath,
        tokenAddress: defaultToken,
        executionId: sharedExecutionId,
        amountUnits: requestUnits.toString(),
        mode: 'direct',
      },
    ];

    const results = await runChildWorkers(configs);

    // Both should report success because idempotency returns the existing reservation
    assert.strictEqual(results.length, 2);
    assert.strictEqual(results[0].success, true);
    assert.strictEqual(results[1].success, true);
    // Both must return the identical reservationId
    assert.strictEqual(results[0].reservationId, results[1].reservationId);

    // Re-open DB: balance deducted only ONCE
    const freshPersistence = new SqlitePersistence({ filename: dbPath });
    const reserved = freshPersistence.getReservedOperatorBalance(defaultToken);
    const available = freshPersistence.getAvailableOperatorBalance(defaultToken);

    assert.strictEqual(reserved, 50_000_000n, 'Duplicate executionId must NOT double-reserve liquidity');
    assert.strictEqual(available, 50_000_000n, 'Available balance must remain 50 USDC');

    freshPersistence.close();
  });

  // =========================================================================
  // Test 4: Transactional Exclusion vs Non-Atomic Read-Then-Write Proof
  // =========================================================================
  it('4. Transactional exclusion verification: reservation strictly fails if available balance is insufficient, zero negative balance', async () => {
    // Seed exactly 10 USDC (10,000,000 units)
    const seedPersistence = new SqlitePersistence({ filename: dbPath });
    seedPersistence.setConfirmedOperatorBalance(defaultToken, 10_000_000n);
    seedPersistence.close();

    // Launch 4 child processes each requesting 6 USDC (6,000,000 units)
    // Non-atomic read-then-write would allow multiple to see 10 USDC available and oversubscribe to 24 USDC.
    // BEGIN IMMEDIATE serializes them: exactly 1 succeeds (6 USDC reserved, 4 USDC available),
    // remaining 3 fail with insufficient liquidity.
    const configs: WorkerInitMessage[] = Array.from({ length: 4 }, (_, i) => ({
      type: 'INIT',
      dbPath,
      tokenAddress: defaultToken,
      executionId: `exec_excl_${i}_${randomUUID()}`,
      amountUnits: '6000000',
      mode: 'direct',
    }));

    const results = await runChildWorkers(configs);
    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    assert.strictEqual(successful.length, 1, 'Exactly 1 of 4 concurrent 6 USDC requests can succeed from 10 USDC pool');
    assert.strictEqual(failed.length, 3, 'Exactly 3 must fail due to insufficient liquidity');

    const freshPersistence = new SqlitePersistence({ filename: dbPath });
    const reserved = freshPersistence.getReservedOperatorBalance(defaultToken);
    const available = freshPersistence.getAvailableOperatorBalance(defaultToken);

    assert.strictEqual(reserved, 6_000_000n);
    assert.strictEqual(available, 4_000_000n);
    assert.ok(available >= 0n, 'Available balance must never become negative');
    freshPersistence.close();
  });
});

