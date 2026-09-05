/**
 * UNIVERSAL AGENT ASSET ROUTER — SOVROUTE ARCHITECTURE V4
 * Phase 7: Step 10 — Cross-Rail Multi-Process Economic Reservation Retention Test
 *
 * Verifies with true OS child processes (distinct PIDs) that:
 * 1. Safe wallet capacity = 100 USDC.
 * 2. Swap A has 60 USDC RESERVED and Lightning is ACCEPTED.
 * 3. Base FUND for Swap A definitively REVERTS.
 * 4. Swap A reservation remains 60 USDC locked (RESERVED) and transitions to RECOVERY_REQUIRED.
 * 5. Two concurrent child processes (distinct OS PIDs) each request 50 USDC.
 * 6. Neither 50 USDC reservation succeeds (only 40 USDC headroom available).
 * 7. Conclusive recovery: Lightning hold invoice canceled, no Base HTLC exists,
 *    terminal state committed -> reservation released.
 * 8. A subsequent child process requesting 50 USDC now succeeds.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { SqlitePersistence } from '../src/persistence/sqlite.ts';
import { FakeEvmAtomicBackend } from '../src/atomic/evm/fake-backend.ts';
import { ChainInventoryReconciler } from '../src/atomic/liquidity/chain-reconciler.ts';
import { SqliteLiquidityInventory } from '../src/atomic/liquidity/sqlite-inventory.ts';
import { AtomicCoordinator } from '../src/atomic/coordinator/coordinator.ts';
import { FakeLightningAtomicBackend } from '../src/atomic/lightning/fake-backend.ts';
import { OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS } from '../src/atomic/evm/base-guard.ts';
import { BASE_SEPOLIA_TEST_POLICY, SovereignAtomicState } from '../src/atomic/types.ts';
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

describe('STEP 10 — CROSS-PROCESS ECONOMIC RESERVATION RETENTION', () => {
  let dbPath: string;
  let persistence: SqlitePersistence;
  let fakeEvm: FakeEvmAtomicBackend;

  beforeEach(() => {
    dbPath = join(tmpdir(), 'phase-retention-crossproc-' + randomUUID() + '.db');
    persistence = new SqlitePersistence({ filename: dbPath });
    fakeEvm = new FakeEvmAtomicBackend();
    fakeEvm.setPersistence(persistence);
  });

  afterEach(() => {
    try {
      persistence.close();
      if (existsSync(dbPath)) rmSync(dbPath, { force: true });
    } catch {}
  });

  it('True OS multi-process economic retention across Base funding failure & Lightning settlement lifecycle', async () => {
    // 1. Initial State: 100 USDC Safe Wallet Capacity
    const safeCapacity = 100_000_000n; // 100 USDC
    fakeEvm.setWalletBalance(canonicalUsdc, safeCapacity, safeCapacity);

    persistence.recordChainInventorySnapshot({
      tokenAddress: canonicalUsdc,
      chainId: 84532,
      operatorAddress,
      walletBalanceLatest: safeCapacity,
      walletBalanceFinalized: safeCapacity,
      safeWalletCapacity: safeCapacity,
      latestBlockNumber: 100,
      finalizedBlockNumber: 98,
      readinessState: 'READY',
      observedAt: new Date(),
      freshUntil: new Date(Date.now() + 120_000),
      updatedAt: new Date(),
    });

    // 2. Swap A reserves 60 USDC
    const swapAAmount = 60_000_000n; // 60 USDC
    const resA = persistence.reserveLiquidity('exec-swap-A', canonicalUsdc, swapAAmount);
    assert.strictEqual(resA.reserved, true, 'Swap A reservation must succeed');

    const lightning = new FakeLightningAtomicBackend();
    const heldInvoice = await lightning.createHoldInvoice('0x' + '11'.repeat(32), 20000n, 144);
    lightning.simulatePayerHold(heldInvoice.paymentHash);

    const swapKeyA = '0x' + 'aa'.repeat(32);
    persistence.createSovereignSwap(
      {
        id: 'exec-swap-A',
        idempotencyKey: 'idem-swap-A',
        hashLock: '0x' + '11'.repeat(32),
        claimingAddress: operatorAddress,
        targetDestinationAddress: operatorAddress,
        amountSats: 20000n,
        expectedUsdcAmount: swapAAmount,
        state: 'LIGHTNING_HELD', // Active Lightning obligation
        reservationId: resA.reservationId,
        reservedAmountUnits: swapAAmount,
        reservationStatus: 'RESERVED',
        holdInvoice: heldInvoice,
        tokenAddress: canonicalUsdc,
        refundAddress: operatorAddress,
        evmSwapKey: swapKeyA,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      'fp-swap-A'
    );

    const fundIntent = persistence.getOrCreateEvmIntent({
      swapKey: swapKeyA,
      actionType: 'FUND',
      chainId: 84532,
      signerAddress: operatorAddress as `0x${string}`,
      targetAddress: canonicalUsdc as `0x${string}`,
      calldata: '0x',
    });
    persistence.markEvmSimulationReverted(fundIntent.id, 'definitive pre-broadcast revert');

    // 3. Chain Inventory Reconciler runs boot reconciliation
    const reconciler = ChainInventoryReconciler.createForTesting({
      persistence,
      capacityProvider: fakeEvm,
      defaultTokenAddress: canonicalUsdc,
      policy: BASE_SEPOLIA_TEST_POLICY,
    });

    const bootResult = await reconciler.reconcileOnBoot();
    assert.strictEqual(bootResult.readinessState, 'UNKNOWN');
    assert.strictEqual(bootResult.headroom, 0n, 'Recovery-required inventory must not authorize headroom');

    // Invariant check: Swap A must be in RECOVERY_REQUIRED and reservation must remain locked (RESERVED)
    const swapAAfterBoot = persistence.getSovereignSwap('exec-swap-A');
    assert.strictEqual(swapAAfterBoot?.state, 'RECOVERY_REQUIRED');
    const resAAfterBoot = persistence.getLiquidityReservation(resA.reservationId);
    assert.strictEqual(resAAfterBoot?.status, 'RESERVED', 'Swap A reservation MUST remain locked in RESERVED');

    // 4. Launch TWO separate OS child processes each requesting 50 USDC
    const requestUnits = '50000000'; // 50 USDC
    const childConfigs: ReconciliationWorkerInitMessage[] = [
      {
        type: 'INIT',
        dbPath,
        tokenAddress: canonicalUsdc,
        executionId: 'child-proc-1-' + randomUUID(),
        amountUnits: requestUnits,
        mode: 'reconciled',
      },
      {
        type: 'INIT',
        dbPath,
        tokenAddress: canonicalUsdc,
        executionId: 'child-proc-2-' + randomUUID(),
        amountUnits: requestUnits,
        mode: 'reconciled',
      },
    ];

    const results = await runChildWorkers(childConfigs);
    assert.strictEqual(results.length, 2, 'Must receive results from both child workers');

    // Verify distinct OS PIDs
    const pids = new Set(results.map((r) => r.pid));
    assert.strictEqual(pids.size, 2, 'Workers must run in two separate OS processes with distinct PIDs');
    for (const pid of pids) {
      assert.notStrictEqual(pid, process.pid, 'Worker PID must differ from test parent runner PID');
    }

    // Mathematical Invariant: Neither 50 USDC reservation may succeed because remaining headroom is only 40 USDC
    const successes = results.filter((r) => r.success);
    const failures = results.filter((r) => !r.success);

    assert.strictEqual(successes.length, 0, 'Zero 50 USDC requests may succeed (only 40 USDC headroom available)');
    assert.strictEqual(failures.length, 2, 'Both 50 USDC requests must fail closed');

    // Verify database remains consistent
    const currentHeadroom = persistence.getSafeHeadroom(canonicalUsdc);
    assert.strictEqual(currentHeadroom, 0n, 'UNKNOWN readiness must authorize zero headroom');

    // 5. Conclusive recovery goes through the real coordinator: authoritative
    // Lightning CANCELED plus successful EVM observation proving no HTLC.
    await lightning.cancelHoldInvoice(heldInvoice.paymentHash);
    const coordinator = new AtomicCoordinator(
      lightning,
      fakeEvm,
      new SqliteLiquidityInventory(persistence),
      { persistence, finalityPolicy: fakeEvm.finalityPolicy }
    );
    const recovered = await coordinator.reconcileSwap('exec-swap-A');
    assert.strictEqual(recovered.state, SovereignAtomicState.INVOICE_CANCELED);
    assert.strictEqual(recovered.recoveryRequired, false);
    await coordinator.reconcileSwap('exec-swap-A');

    const resAReleased = persistence.getLiquidityReservation(resA.reservationId);
    assert.strictEqual(resAReleased?.status, 'RELEASED', 'Swap A reservation must now be RELEASED');
    assert.strictEqual(persistence.getSovereignSwap('exec-swap-A')?.reservationStatus, 'RELEASED');

    // Reconcile inventory after recovery has removed the cross-rail obligation.
    const readyAfterRecovery = await reconciler.reconcileOnBoot();
    assert.strictEqual(readyAfterRecovery.readinessState, 'READY');
    const headAfterRelease = persistence.getSafeHeadroom(canonicalUsdc);
    assert.strictEqual(headAfterRelease, 100_000_000n, 'Headroom must restore to full 100 USDC');

    // 6. Now launch child process 3 requesting 50 USDC: MUST SUCCEED
    const childConfigsPostRelease: ReconciliationWorkerInitMessage[] = [
      {
        type: 'INIT',
        dbPath,
        tokenAddress: canonicalUsdc,
        executionId: 'child-proc-3-' + randomUUID(),
        amountUnits: requestUnits,
        mode: 'reconciled',
      },
    ];

    const postResults = await runChildWorkers(childConfigsPostRelease);
    assert.strictEqual(postResults.length, 1);
    assert.strictEqual(postResults[0].success, true, 'Child process 3 reservation for 50 USDC must succeed');
    assert.ok(postResults[0].reservationId, 'Must have valid reservation ID');
    assert.notStrictEqual(postResults[0].pid, process.pid);

    // Final database consistency check: 50 USDC reserved, 50 USDC headroom remaining
    const finalHeadroom = persistence.getSafeHeadroom(canonicalUsdc);
    assert.strictEqual(finalHeadroom, 50_000_000n, 'Final headroom must be exactly 50 USDC');
  });
});
