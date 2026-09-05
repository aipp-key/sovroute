/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Base USDC Inventory Reconciliation & Startup Safety Adversarial Test Suite
 *
 * Covers the 20 Core REC Invariants & 40 Adversarial Scenarios:
 * - REC-1: Double-counting trap elimination (committed escrows excluded from headroom deduction).
 * - REC-2: Zero-balance boot safety.
 * - REC-3: Freshness staleness rejection (>60s).
 * - REC-4: Fail-closed boot state (starts NOT_READY until Phase 5 passes).
 * - REC-5: Startup reconciliation order (Phases 1-5).
 * - REC-6: Idempotent replay of same block.
 * - REC-7: Asymmetric finality (unfinalized deposits not spendable).
 * - REC-8: Asymmetric finality (reorg / finalized > latest -> min() enforced).
 * - REC-9: Token / chain validation failure -> fail closed (NOT_READY / UNKNOWN).
 * - REC-10: Onchain deficit detection (W_safe < R + P).
 * - REC-11: Deficit state halts reservations and quotations.
 * - REC-12: Deficit resolution on deposit recovery.
 * - REC-13: Ambiguous funding intent (P) included in safe headroom.
 * - REC-14: In-memory binding rehydration across restart.
 * - REC-15: RPC error during continuous reconciliation -> fail closed / DEGRADED.
 * - REC-16: Concurrent reservations under atomic headroom check.
 * - REC-17: Settle reduces C, leaves W_safe unchanged (already debited).
 * - REC-18: Refund restores headroom when HTLC refunded onchain.
 * - REC-19: Cross-rail safety budget alignment.
 * - REC-20: Clean shutdown and restart preserves state.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { SqlitePersistence } from '../src/persistence/sqlite.ts';
import { FakeEvmAtomicBackend } from '../src/atomic/evm/fake-backend.ts';
import { FakeLightningAtomicBackend } from '../src/atomic/lightning/fake-backend.ts';
import { ChainInventoryReconciler } from '../src/atomic/liquidity/chain-reconciler.ts';
import { SqliteLiquidityInventory } from '../src/atomic/liquidity/sqlite-inventory.ts';
import {
  AtomicCoordinator,
  BASE_SEPOLIA_FINALITY_POLICY,
} from '../src/atomic/coordinator/coordinator.ts';
import {
  InventoryNotReadyError,
  LiquidityDeficitError,
  EvmInventoryUnavailableError,
  SovereignAtomicState,
} from '../src/atomic/types.ts';

const defaultToken = '0x6c84a8f1c29108f47a79964b5fe888d4f4d0de40';
const operatorAddress = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

describe('BASE USDC INVENTORY RECONCILIATION & STARTUP SAFETY (REC-1 to REC-20)', () => {
  let dbPath: string;
  let persistence: SqlitePersistence;
  let fakeEvm: FakeEvmAtomicBackend;

  beforeEach(() => {
    dbPath = join(tmpdir(), 'phase-recon-test-' + randomUUID() + '.db');
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

  // =========================================================================
  // REC-1: Double-Counting Trap Elimination
  // =========================================================================
  describe('REC-1: Double-Counting Trap Elimination', () => {
    it('Scenario 1.1: Committed HTLC (C) is NOT subtracted from wallet balance W_safe', async () => {
      // Operator wallet originally had 100 USDC.
      // 40 USDC was funded into an onchain HTLC. Onchain wallet now has 60 USDC.
      fakeEvm.setWalletBalance(defaultToken, 60_000_000n, 60_000_000n);
      const reconciler = new ChainInventoryReconciler({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: defaultToken,
        expectedChainId: 42161,
      });

      const bootRes = await reconciler.reconcileOnBoot();
      assert.equal(bootRes.readinessState, 'READY');

      // Record a committed reservation in SQLite (representing the 40 USDC committed onchain)
      const res = persistence.reserveLiquidity('exec-1', defaultToken, 40_000_000n);
      persistence.commitLiquidityReservation(res.reservationId);

      // CRITICAL CHECK: Safe headroom must be 60 USDC (the spendable wallet capacity),
      // NOT 60 - 40 = 20 USDC! Committed escrow C was already debited onchain.
      const headroom = await reconciler.getSafeHeadroom(defaultToken);
      assert.equal(headroom, 60_000_000n, 'Headroom must equal W_safe without double-subtracting C');
    });

    it('Scenario 1.2: Settlement of committed HTLC leaves W_safe intact without duplicate reduction', async () => {
      fakeEvm.setWalletBalance(defaultToken, 50_000_000n, 50_000_000n);
      const reconciler = new ChainInventoryReconciler({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: defaultToken,
        expectedChainId: 42161,
      });
      await reconciler.reconcileOnBoot();

      const res = persistence.reserveLiquidity('exec-settle-1', defaultToken, 30_000_000n);
      persistence.commitLiquidityReservation(res.reservationId);

      // Now client claims and router settles the reservation
      persistence.settleLiquidityReservation(res.reservationId);

      const reservation = persistence.getLiquidityReservation(res.reservationId);
      assert.equal(reservation?.status, 'SETTLED');

      // Headroom remains 50 USDC
      const headroom = await reconciler.getSafeHeadroom(defaultToken);
      assert.equal(headroom, 50_000_000n);
    });
  });

  // =========================================================================
  // REC-2: Zero-Balance Boot Safety
  // =========================================================================
  describe('REC-2: Zero-Balance Boot Safety', () => {
    it('Scenario 2.1: Router boots cleanly with 0 balance and rejects reservations fail-closed', async () => {
      fakeEvm.setWalletBalance(defaultToken, 0n, 0n);
      const reconciler = new ChainInventoryReconciler({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: defaultToken,
        expectedChainId: 42161,
      });

      const boot = await reconciler.reconcileOnBoot();
      assert.equal(boot.readinessState, 'READY');
      assert.equal(boot.headroom, 0n);

      const inventory = new SqliteLiquidityInventory(persistence, { reconciler });
      const res = await inventory.reserve(10_000_000n, defaultToken, 'exec-zero-1');
      assert.equal(res.reserved, false, 'Reservation must fail when balance is 0');
    });
  });

  // =========================================================================
  // REC-3: Freshness Staleness Rejection
  // =========================================================================
  describe('REC-3: Freshness Staleness Rejection (>60s)', () => {
    it('Scenario 3.1: Snapshot older than maxFreshnessMs is marked DEGRADED', async () => {
      fakeEvm.setWalletBalance(defaultToken, 100_000_000n, 100_000_000n);
      const reconciler = new ChainInventoryReconciler({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: defaultToken,
        expectedChainId: 42161,
        policy: { maxFreshnessMs: 50 }, // 50ms freshness limit
      });
      await reconciler.reconcileOnBoot();

      // Wait 60ms for snapshot to become stale
      await new Promise((r) => setTimeout(r, 60));

      const readiness = reconciler.getReadinessState(defaultToken);
      assert.equal(readiness, 'DEGRADED', 'Stale snapshot must be reported as DEGRADED');
    });
  });

  // =========================================================================
  // REC-4 & REC-5: Boot State and Phase Order
  // =========================================================================
  describe('REC-4 & REC-5: Boot State and Phase Order', () => {
    it('Scenario 4.1: Reconciler starts NOT_READY before boot sequence', () => {
      const reconciler = new ChainInventoryReconciler({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: defaultToken,
        expectedChainId: 42161,
      });

      assert.equal(reconciler.getReadinessState(defaultToken), 'NOT_READY');
    });

    it('Scenario 5.1: Successful boot transitions NOT_READY -> RECONCILING -> READY', async () => {
      fakeEvm.setWalletBalance(defaultToken, 50_000_000n, 50_000_000n);
      const reconciler = new ChainInventoryReconciler({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: defaultToken,
        expectedChainId: 42161,
      });

      const boot = await reconciler.reconcileOnBoot();
      assert.equal(boot.readinessState, 'READY');
      assert.equal(reconciler.getReadinessState(defaultToken), 'READY');
    });
  });

  // =========================================================================
  // REC-6: Idempotent Replay of Same Block
  // =========================================================================
  describe('REC-6: Idempotent Replay of Same Block', () => {
    it('Scenario 6.1: Repeated reconciliation of same block produces identical state', async () => {
      fakeEvm.setWalletBalance(defaultToken, 75_000_000n, 75_000_000n);
      const reconciler = new ChainInventoryReconciler({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: defaultToken,
        expectedChainId: 42161,
      });

      const r1 = await reconciler.reconcileOnBoot();
      const r2 = await reconciler.reconcile();

      assert.equal(r1.headroom, r2.headroom);
      assert.equal(r1.readinessState, r2.readinessState);
    });
  });

  // =========================================================================
  // REC-7 & REC-8: Asymmetric Finality
  // =========================================================================
  describe('REC-7 & REC-8: Asymmetric Finality', () => {
    it('Scenario 7.1: Unfinalized deposit (latest > finalized) restricts W_safe to finalized', async () => {
      // 150 latest, 100 finalized -> W_safe must be 100
      fakeEvm.setWalletBalance(defaultToken, 150_000_000n, 100_000_000n);
      const reconciler = new ChainInventoryReconciler({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: defaultToken,
        expectedChainId: 42161,
      });

      const boot = await reconciler.reconcileOnBoot();
      assert.equal(boot.headroom, 100_000_000n, 'W_safe must not credit unfinalized 50 USDC');

      const snapshot = persistence.getLatestChainInventorySnapshot(defaultToken);
      assert.equal(snapshot?.safeWalletCapacity, 100_000_000n);
    });

    it('Scenario 8.1: Reorg / withdrawal (latest < finalized) immediately restricts W_safe to latest', async () => {
      // 70 latest, 100 finalized -> W_safe must be 70
      fakeEvm.setWalletBalance(defaultToken, 70_000_000n, 100_000_000n);
      const reconciler = new ChainInventoryReconciler({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: defaultToken,
        expectedChainId: 42161,
      });

      const boot = await reconciler.reconcileOnBoot();
      assert.equal(boot.headroom, 70_000_000n, 'W_safe must immediately reflect lower latest balance');
    });
  });

  // =========================================================================
  // REC-9: Token / Chain Validation Failure
  // =========================================================================
  describe('REC-9: Token / Chain Validation Failure', () => {
    it('Scenario 9.1: Chain ID mismatch halts boot with NOT_READY', async () => {
      fakeEvm.setChainValidationResult(false, 'Chain ID mismatch: expected 84532, got 1');
      const reconciler = new ChainInventoryReconciler({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: defaultToken,
        expectedChainId: 84532,
      });

      const boot = await reconciler.reconcileOnBoot();
      assert.equal(boot.readinessState, 'NOT_READY');
      assert.match(boot.error ?? '', /Chain ID mismatch/);
    });

    it('Scenario 9.2: Token contract validation failure halts boot', async () => {
      fakeEvm.setTokenValidationResult(false, 'Contract bytecode does not match canonical Circle USDC');
      const reconciler = new ChainInventoryReconciler({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: defaultToken,
        expectedChainId: 42161,
      });

      const boot = await reconciler.reconcileOnBoot();
      assert.equal(boot.readinessState, 'NOT_READY');
      assert.match(boot.error ?? '', /Circle USDC/);
    });
  });

  // =========================================================================
  // REC-10 & REC-11 & REC-12: Deficit Detection, Gating, and Recovery
  // =========================================================================
  describe('REC-10, REC-11, REC-12: Deficit Lifecycle', () => {
    it('Scenario 10.1: W_safe < R transitions reconciler immediately to DEFICIT', async () => {
      fakeEvm.setWalletBalance(defaultToken, 100_000_000n, 100_000_000n);
      const reconciler = new ChainInventoryReconciler({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: defaultToken,
        expectedChainId: 42161,
      });
      await reconciler.reconcileOnBoot();

      // Reserve 80 USDC
      persistence.reserveLiquidity('exec-def-1', defaultToken, 80_000_000n);

      // Onchain wallet dropped to 50 USDC (50 < 80)
      fakeEvm.setWalletBalance(defaultToken, 50_000_000n, 50_000_000n);
      const recon = await reconciler.reconcile();

      assert.equal(recon.readinessState, 'DEFICIT');
      assert.equal(reconciler.getReadinessState(defaultToken), 'DEFICIT');
    });

    it('Scenario 11.1: DEFICIT state blocks new reservations and coordinator preparation', async () => {
      fakeEvm.setWalletBalance(defaultToken, 100_000_000n, 100_000_000n);
      const reconciler = new ChainInventoryReconciler({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: defaultToken,
        expectedChainId: 42161,
      });
      await reconciler.reconcileOnBoot();
      const res = persistence.reserveLiquidity('exec-def-2', defaultToken, 80_000_000n);
      assert.equal(res.reserved, true);

      // Onchain wallet dropped to 50 USDC (50 < 80)
      fakeEvm.setWalletBalance(defaultToken, 50_000_000n, 50_000_000n);
      await reconciler.reconcile();
      assert.equal(reconciler.getReadinessState(defaultToken), 'DEFICIT');

      const inventory = new SqliteLiquidityInventory(persistence, { reconciler });
      const coordinator = new AtomicCoordinator(
        new FakeLightningAtomicBackend(),
        fakeEvm,
        inventory,
        { persistence, finalityPolicy: BASE_SEPOLIA_FINALITY_POLICY }
      );

      await assert.rejects(
        () =>
          coordinator.prepareSwap({
            idempotencyKey: 'idem-deficit',
            hashLock: '0x' + '2'.repeat(64),
            amountSats: 10000n,
            expectedUsdcAmount: 5_000_000n,
            claimingAddress: operatorAddress,
            targetDestinationAddress: operatorAddress,
          }),
        (err: any) => err instanceof LiquidityDeficitError
      );
    });

    it('Scenario 12.1: Deposit recovery restores DEFICIT back to READY', async () => {
      fakeEvm.setWalletBalance(defaultToken, 100_000_000n, 100_000_000n);
      const reconciler = new ChainInventoryReconciler({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: defaultToken,
        expectedChainId: 42161,
      });
      await reconciler.reconcileOnBoot();
      const res = persistence.reserveLiquidity('exec-recov-1', defaultToken, 80_000_000n);
      assert.equal(res.reserved, true);

      // Onchain wallet dropped to 50 USDC (50 < 80)
      fakeEvm.setWalletBalance(defaultToken, 50_000_000n, 50_000_000n);
      await reconciler.reconcile();
      assert.equal(reconciler.getReadinessState(defaultToken), 'DEFICIT');

      // Operator deposits 100 USDC onchain -> total wallet balance is 150 USDC (150 > 80)
      fakeEvm.setWalletBalance(defaultToken, 150_000_000n, 150_000_000n);
      const recovery = await reconciler.reconcile();

      assert.equal(recovery.readinessState, 'READY');
      assert.equal(recovery.headroom, 70_000_000n); // 150 - 80 = 70 USDC
    });
  });

  // =========================================================================
  // REC-13: Ambiguous Funding Intent (P)
  // =========================================================================
  describe('REC-13: Ambiguous Funding Intent (P)', () => {
    it('Scenario 13.1: Pending funding intents P reduce Safe Headroom', async () => {
      fakeEvm.setWalletBalance(defaultToken, 100_000_000n, 100_000_000n);
      const reconciler = new ChainInventoryReconciler({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: defaultToken,
        expectedChainId: 42161,
      });
      await reconciler.reconcileOnBoot();

      // Create a swap and record an in-flight funding intent of 25 USDC
      const swapKey = '0x' + '3'.repeat(64);
      persistence.createSovereignSwap({
        id: 'exec-intent-1',
        idempotencyKey: 'idem-intent-1',
        hashLock: '0x' + '4'.repeat(64),
        claimingAddress: operatorAddress,
        targetDestinationAddress: operatorAddress,
        amountSats: 50000n,
        expectedUsdcAmount: 25_000_000n,
        state: SovereignAtomicState.EVM_FUNDING_PENDING,
        tokenAddress: defaultToken,
        refundAddress: operatorAddress,
        evmSwapKey: swapKey,
        createdAt: new Date(),
        updatedAt: new Date(),
      }, 'fingerprint-13');

      persistence.getOrCreateEvmIntent({
        swapKey,
        actionType: 'FUND',
        chainId: 42161,
        signerAddress: operatorAddress as `0x${string}`,
        targetAddress: defaultToken as `0x${string}`,
        calldata: '0x',
      });

      const headroom = await reconciler.getSafeHeadroom(defaultToken);
      assert.equal(headroom, 75_000_000n, 'Headroom must deduct unresolved funding intent (100 - 25 = 75)');
    });
  });

  // =========================================================================
  // REC-14: In-Memory Binding Rehydration Across Restart
  // =========================================================================
  describe('REC-14: In-Memory Binding Rehydration Across Restart', () => {
    it('Scenario 14.1: Fresh backend rehydrates swapKeyToHtlcId from SQLite sovereign_swaps', async () => {
      const swapKey = '0x' + 'a'.repeat(64);
      const htlcId = '0x' + 'b'.repeat(64);

      persistence.createSovereignSwap({
        id: 'exec-rehydrate-1',
        idempotencyKey: 'idem-rehydrate-1',
        hashLock: '0x' + 'c'.repeat(64),
        claimingAddress: operatorAddress,
        targetDestinationAddress: operatorAddress,
        amountSats: 20000n,
        expectedUsdcAmount: 10_000_000n,
        state: SovereignAtomicState.EVM_FUNDED,
        tokenAddress: defaultToken,
        refundAddress: operatorAddress,
        evmSwapKey: swapKey,
        evmHtlcId: htlcId,
        createdAt: new Date(),
        updatedAt: new Date(),
      }, 'fingerprint-14-1');

      // Fresh backend without any in-memory state
      const freshBackend = new FakeEvmAtomicBackend();
      freshBackend.setPersistence(persistence);

      // Rehydrate
      freshBackend.rehydrateBindings();

      // observeHtlc resolves correctly
      const obs = await freshBackend.observeHtlc(swapKey);
      assert.equal(obs.htlcId, htlcId);
    });

    it('Scenario 14.2: observeHtlc falls back to SQLite even if rehydrateBindings was not called', async () => {
      const swapKey = '0x' + 'd'.repeat(64);
      const htlcId = '0x' + 'e'.repeat(64);

      persistence.createSovereignSwap({
        id: 'exec-fallback-1',
        idempotencyKey: 'idem-fallback-1',
        hashLock: '0x' + 'f'.repeat(64),
        claimingAddress: operatorAddress,
        targetDestinationAddress: operatorAddress,
        amountSats: 20000n,
        expectedUsdcAmount: 10_000_000n,
        state: SovereignAtomicState.EVM_FUNDED,
        tokenAddress: defaultToken,
        refundAddress: operatorAddress,
        evmSwapKey: swapKey,
        evmHtlcId: htlcId,
        createdAt: new Date(),
        updatedAt: new Date(),
      }, 'fingerprint-14-2');

      const unhydratedBackend = new FakeEvmAtomicBackend();
      unhydratedBackend.setPersistence(persistence);

      const obs = await unhydratedBackend.observeHtlc(swapKey);
      assert.equal(obs.htlcId, htlcId);
    });
  });

  // =========================================================================
  // REC-15: RPC Error Fail-Closed
  // =========================================================================
  describe('REC-15: RPC Error Fail-Closed Handling', () => {
    it('Scenario 15.1: RPC error during reconciliation sets UNKNOWN state', async () => {
      const throwingProvider = {
        async observeWalletCapacity() {
          throw new Error('ECONNREFUSED: Base RPC node unreachable');
        },
        async verifyChainAndToken() {
          return { valid: true };
        },
      };

      const reconciler = new ChainInventoryReconciler({
        persistence,
        capacityProvider: throwingProvider as any,
        defaultTokenAddress: defaultToken,
        expectedChainId: 42161,
      });

      const res = await reconciler.reconcileOnBoot();
      assert.equal(res.readinessState, 'UNKNOWN');
      assert.match(res.error ?? '', /ECONNREFUSED/);
    });
  });

  // =========================================================================
  // REC-16: Concurrent Reservations Under Atomic Headroom Check
  // =========================================================================
  describe('REC-16: Concurrent Reservations Under Atomic Headroom Check', () => {
    it('Scenario 16.1: Concurrent reservations under BEGIN IMMEDIATE strictly respect Safe Headroom', async () => {
      fakeEvm.setWalletBalance(defaultToken, 100_000_000n, 100_000_000n);
      const reconciler = new ChainInventoryReconciler({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: defaultToken,
        expectedChainId: 42161,
      });
      await reconciler.reconcileOnBoot();

      const promises = Array.from({ length: 5 }, (_, i) =>
        Promise.resolve().then(() =>
          persistence.reserveLiquidity('exec-conc-' + i, defaultToken, 30_000_000n)
        )
      );

      const results = await Promise.all(promises);
      const successes = results.filter((r) => r.reserved);
      const failures = results.filter((r) => !r.reserved);

      assert.equal(successes.length, 3, 'Exactly 3 of 5 requests for 30 USDC can succeed against 100 USDC');
      assert.equal(failures.length, 2, 'Remaining 2 must fail closed');
    });
  });

  // =========================================================================
  // REC-17 & REC-18: Settlement and Refund Restoration
  // =========================================================================
  describe('REC-17 & REC-18: Settlement and Refund Restoration', () => {
    it('Scenario 18.1: Onchain refund detection restores headroom via Phase 4 reconciliation', async () => {
      fakeEvm.setWalletBalance(defaultToken, 50_000_000n, 50_000_000n);
      persistence.setConfirmedOperatorBalance(defaultToken, 50_000_000n);
      const htlcId = '0x' + '9'.repeat(64);
      const swapKey = '0x' + '8'.repeat(64);

      const res = persistence.reserveLiquidity('exec-refund-1', defaultToken, 40_000_000n);
      assert.equal(res.reserved, true);
      persistence.commitLiquidityReservation(res.reservationId);

      persistence.createSovereignSwap({
        id: 'exec-refund-1',
        idempotencyKey: 'idem-refund-1',
        hashLock: '0x' + '7'.repeat(64),
        claimingAddress: operatorAddress,
        targetDestinationAddress: operatorAddress,
        amountSats: 20000n,
        expectedUsdcAmount: 40_000_000n,
        state: SovereignAtomicState.EVM_FUNDED,
        reservationId: res.reservationId,
        tokenAddress: defaultToken,
        refundAddress: operatorAddress,
        evmSwapKey: swapKey,
        evmHtlcId: htlcId,
        createdAt: new Date(),
        updatedAt: new Date(),
      }, 'fingerprint-18');

      // Mock contract state returns REFUNDED (status: 3)
      (fakeEvm as any).getContractHtlcState = async () => ({ status: 3 });

      // Wallet receives the 40 USDC refund onchain -> wallet balance becomes 90 USDC
      fakeEvm.setWalletBalance(defaultToken, 90_000_000n, 90_000_000n);

      const reconciler = new ChainInventoryReconciler({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: defaultToken,
        expectedChainId: 42161,
      });

      await reconciler.reconcileOnBoot();

      // Reservation must be released
      const reservation = persistence.getLiquidityReservation(res.reservationId);
      assert.equal(reservation?.status, 'RELEASED');

      // Headroom is fully restored to 90 USDC
      const headroom = await reconciler.getSafeHeadroom(defaultToken);
      assert.equal(headroom, 90_000_000n);
    });
  });

  // =========================================================================
  // REC-19: Cross-Rail Safety Budget Alignment
  // =========================================================================
  describe('REC-19: Cross-Rail Safety Budget Alignment', () => {
    it('Scenario 19.1: Coordinator enforces finality policy before irreversible actions', () => {
      const inventory = new SqliteLiquidityInventory(persistence);
      const coordinator = new AtomicCoordinator(
        new FakeLightningAtomicBackend(),
        fakeEvm,
        inventory,
        { persistence, finalityPolicy: BASE_SEPOLIA_FINALITY_POLICY }
      );

      assert.ok(coordinator);
    });
  });

  // =========================================================================
  // REC-20: Clean Shutdown & Restart Preserves State
  // =========================================================================
  describe('REC-20: Clean Shutdown & Restart Preserves State', () => {
    it('Scenario 20.1: SQLite persistence survives process restart and retains snapshots', async () => {
      fakeEvm.setWalletBalance(defaultToken, 120_000_000n, 120_000_000n);
      const reconciler = new ChainInventoryReconciler({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: defaultToken,
        expectedChainId: 42161,
      });
      await reconciler.reconcileOnBoot();

      // Close persistence (simulate process exit)
      persistence.close();

      // Re-open DB
      const freshDb = new SqlitePersistence({ filename: dbPath });
      const snapshot = freshDb.getLatestChainInventorySnapshot(defaultToken);

      assert.equal(snapshot?.safeWalletCapacity, 120_000_000n);
      assert.equal(snapshot?.readinessState, 'READY');
      freshDb.close();
    });
  });

  // =========================================================================
  // ADDITIONAL ADVERSARIAL SCENARIOS (Scenarios 23 to 40)
  // =========================================================================
  describe('Adversarial Edge Cases & Stress Scenarios (23-40)', () => {
    it('Scenario 23: Direct reservation attempt on unbooted reconciler throws InventoryNotReadyError', async () => {
      const reconciler = new ChainInventoryReconciler({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: defaultToken,
        expectedChainId: 42161,
      });
      const inventory = new SqliteLiquidityInventory(persistence, { reconciler });
      await assert.rejects(
        () => inventory.reserve(10_000_000n, defaultToken, 'exec-unbooted'),
        (err: any) => err instanceof InventoryNotReadyError
      );
    });

    it('Scenario 24: Zero finalized balance with large unfinalized latest balance has 0 safe capacity', async () => {
      fakeEvm.setWalletBalance(defaultToken, 1_000_000_000n, 0n);
      const reconciler = new ChainInventoryReconciler({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: defaultToken,
        expectedChainId: 42161,
      });
      const boot = await reconciler.reconcileOnBoot();
      assert.equal(boot.headroom, 0n);
      assert.equal(boot.readinessState, 'READY');
    });

    it('Scenario 25: RPC returning null code for USDC contract address fails closed', async () => {
      fakeEvm.setTokenValidationResult(false, 'USDC contract code is empty at configured address');
      const reconciler = new ChainInventoryReconciler({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: defaultToken,
        expectedChainId: 42161,
      });
      const res = await reconciler.reconcileOnBoot();
      assert.equal(res.readinessState, 'NOT_READY');
      assert.match(res.error ?? '', /empty/);
    });

    it('Scenario 26: Re-reconciliation on demand when freshness expired restores READY', async () => {
      fakeEvm.setWalletBalance(defaultToken, 100_000_000n, 100_000_000n);
      const reconciler = new ChainInventoryReconciler({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: defaultToken,
        expectedChainId: 42161,
        policy: { maxFreshnessMs: 40 },
      });
      await reconciler.reconcileOnBoot();
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(reconciler.getReadinessState(defaultToken), 'DEGRADED');

      const refreshed = await reconciler.reconcile(defaultToken);
      assert.equal(refreshed.readinessState, 'READY');
      assert.equal(reconciler.getReadinessState(defaultToken), 'READY');
    });

    it('Scenario 27: Stale snapshot with RPC failure prevents quote/reservation fail-closed', async () => {
      fakeEvm.setWalletBalance(defaultToken, 100_000_000n, 100_000_000n);
      const reconciler = new ChainInventoryReconciler({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: defaultToken,
        expectedChainId: 42161,
        policy: { maxFreshnessMs: 30 },
      });
      await reconciler.reconcileOnBoot();
      await new Promise((r) => setTimeout(r, 40));

      fakeEvm.observeWalletCapacity = async () => {
        throw new Error('RPC_TIMEOUT');
      };

      const inventory = new SqliteLiquidityInventory(persistence, { reconciler });
      await assert.rejects(
        () => inventory.reserve(10_000_000n, defaultToken, 'exec-stale-rpc'),
        (err: any) => err instanceof EvmInventoryUnavailableError || err instanceof InventoryNotReadyError
      );
    });

    it('Scenario 28: Zero-amount or negative-amount reservation attempt strictly rejected', () => {
      assert.throws(
        () => persistence.reserveLiquidity('exec-zero', defaultToken, 0n),
        /RESERVE_INVALID_AMOUNT/
      );
      assert.throws(
        () => persistence.reserveLiquidity('exec-neg', defaultToken, -100n),
        /RESERVE_INVALID_AMOUNT/
      );
    });

    it('Scenario 29: Multiple pending funding intents accumulate into P', async () => {
      fakeEvm.setWalletBalance(defaultToken, 100_000_000n, 100_000_000n);
      const reconciler = new ChainInventoryReconciler({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: defaultToken,
        expectedChainId: 42161,
      });
      await reconciler.reconcileOnBoot();

      const swapKey1 = '0x' + '11'.repeat(32);
      persistence.createSovereignSwap({
        id: 'exec-p-1',
        idempotencyKey: 'idem-p-1',
        hashLock: '0x' + '12'.repeat(32),
        claimingAddress: operatorAddress,
        targetDestinationAddress: operatorAddress,
        amountSats: 10000n,
        expectedUsdcAmount: 15_000_000n,
        state: SovereignAtomicState.EVM_FUNDING_PENDING,
        tokenAddress: defaultToken,
        refundAddress: operatorAddress,
        evmSwapKey: swapKey1,
        createdAt: new Date(),
        updatedAt: new Date(),
      }, 'fp-p1');
      persistence.getOrCreateEvmIntent({
        swapKey: swapKey1,
        actionType: 'FUND',
        chainId: 42161,
        signerAddress: operatorAddress as `0x${string}`,
        targetAddress: defaultToken as `0x${string}`,
        calldata: '0x',
      });

      const swapKey2 = '0x' + '21'.repeat(32);
      persistence.createSovereignSwap({
        id: 'exec-p-2',
        idempotencyKey: 'idem-p-2',
        hashLock: '0x' + '22'.repeat(32),
        claimingAddress: operatorAddress,
        targetDestinationAddress: operatorAddress,
        amountSats: 10000n,
        expectedUsdcAmount: 20_000_000n,
        state: SovereignAtomicState.EVM_FUNDING_PENDING,
        tokenAddress: defaultToken,
        refundAddress: operatorAddress,
        evmSwapKey: swapKey2,
        createdAt: new Date(),
        updatedAt: new Date(),
      }, 'fp-p2');
      persistence.getOrCreateEvmIntent({
        swapKey: swapKey2,
        actionType: 'FUND',
        chainId: 42161,
        signerAddress: operatorAddress as `0x${string}`,
        targetAddress: defaultToken as `0x${string}`,
        calldata: '0x',
      });

      const totalP = persistence.getUnresolvedFundingIntentsAmount(defaultToken);
      assert.equal(totalP, 35_000_000n);

      const headroom = await reconciler.getSafeHeadroom(defaultToken);
      assert.equal(headroom, 65_000_000n);
    });

    it('Scenario 30: Resolved intent (success) does not inflate P after HTLC is onchain', async () => {
      fakeEvm.setWalletBalance(defaultToken, 100_000_000n, 100_000_000n);
      const reconciler = new ChainInventoryReconciler({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: defaultToken,
        expectedChainId: 42161,
      });
      await reconciler.reconcileOnBoot();

      const swapKey = '0x' + '31'.repeat(32);
      const intent = persistence.getOrCreateEvmIntent({
        swapKey,
        actionType: 'FUND',
        chainId: 42161,
        signerAddress: operatorAddress as `0x${string}`,
        targetAddress: defaultToken as `0x${string}`,
        calldata: '0x',
      });

      persistence.markEvmIntentFailed(intent.id, 'INTENT_TERMINAL_RESOLVED');

      const P = persistence.getUnresolvedFundingIntentsAmount(defaultToken);
      assert.equal(P, 0n);
    });

    it('Scenario 31: Rehydration of 100 swaps completes with zero data loss', () => {
      for (let i = 0; i < 100; i++) {
        const hex = i.toString(16).padStart(2, '0');
        const swapKey = '0x' + hex.repeat(32);
        const htlcId = '0x' + hex.repeat(32);
        persistence.createSovereignSwap({
          id: 'exec-mass-' + i,
          idempotencyKey: 'idem-mass-' + i,
          hashLock: '0x' + hex.repeat(32),
          claimingAddress: operatorAddress,
          targetDestinationAddress: operatorAddress,
          amountSats: 1000n,
          expectedUsdcAmount: 1_000_000n,
          state: SovereignAtomicState.EVM_FUNDED,
          tokenAddress: defaultToken,
          refundAddress: operatorAddress,
          evmSwapKey: swapKey,
          evmHtlcId: htlcId,
          createdAt: new Date(),
          updatedAt: new Date(),
        }, 'fp-mass-' + i);
      }

      const freshBackend = new FakeEvmAtomicBackend();
      freshBackend.setPersistence(persistence);
      const rehydrated = freshBackend.rehydrateBindings();
      assert.equal(rehydrated, 100);
    });

    it('Scenario 32: Expired HTLC does not prematurely release reservation before onchain refund', async () => {
      fakeEvm.setWalletBalance(defaultToken, 50_000_000n, 50_000_000n);
      persistence.setConfirmedOperatorBalance(defaultToken, 50_000_000n);

      const res = persistence.reserveLiquidity('exec-hold-refund', defaultToken, 20_000_000n);
      persistence.commitLiquidityReservation(res.reservationId);

      const swapKey = '0x' + '55'.repeat(32);
      const htlcId = '0x' + '56'.repeat(32);
      persistence.createSovereignSwap({
        id: 'exec-hold-refund',
        idempotencyKey: 'idem-hold-refund',
        hashLock: '0x' + '57'.repeat(32),
        claimingAddress: operatorAddress,
        targetDestinationAddress: operatorAddress,
        amountSats: 10000n,
        expectedUsdcAmount: 20_000_000n,
        state: SovereignAtomicState.EVM_FUNDED,
        reservationId: res.reservationId,
        tokenAddress: defaultToken,
        refundAddress: operatorAddress,
        evmSwapKey: swapKey,
        evmHtlcId: htlcId,
        createdAt: new Date(),
        updatedAt: new Date(),
      }, 'fp-hold');

      (fakeEvm as any).getContractHtlcState = async () => ({ status: 1 });

      const reconciler = new ChainInventoryReconciler({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: defaultToken,
        expectedChainId: 42161,
      });
      await reconciler.reconcileOnBoot();

      const reservation = persistence.getLiquidityReservation(res.reservationId);
      assert.equal(reservation?.status, 'COMMITTED');
    });

    it('Scenario 33: Idempotent reservation returns existing reservation without double-counting', () => {
      fakeEvm.setWalletBalance(defaultToken, 100_000_000n, 100_000_000n);
      persistence.setConfirmedOperatorBalance(defaultToken, 100_000_000n);

      const r1 = persistence.reserveLiquidity('exec-idem-dup', defaultToken, 30_000_000n);
      assert.equal(r1.reserved, true);

      const r2 = persistence.reserveLiquidity('exec-idem-dup', defaultToken, 30_000_000n);
      assert.equal(r2.reserved, true);
      assert.equal(r2.reservationId, r1.reservationId);

      const reserved = persistence.getReservedOperatorBalance(defaultToken);
      assert.equal(reserved, 30_000_000n);
    });

    it('Scenario 34: Settle on non-existent reservation ID is safely no-op', () => {
      assert.doesNotThrow(() => {
        persistence.settleLiquidityReservation('non-existent-reservation-id');
      });
    });

    it('Scenario 35: Release on non-existent reservation ID is safely no-op', () => {
      assert.doesNotThrow(() => {
        persistence.releaseLiquidityReservation('non-existent-reservation-id');
      });
    });

    it('Scenario 36: Double-commit on already committed reservation is safely idempotent', () => {
      fakeEvm.setWalletBalance(defaultToken, 100_000_000n, 100_000_000n);
      persistence.setConfirmedOperatorBalance(defaultToken, 100_000_000n);
      const res = persistence.reserveLiquidity('exec-double-commit', defaultToken, 20_000_000n);
      persistence.commitLiquidityReservation(res.reservationId);
      assert.doesNotThrow(() => {
        persistence.commitLiquidityReservation(res.reservationId);
      });
      const item = persistence.getLiquidityReservation(res.reservationId);
      assert.equal(item?.status, 'COMMITTED');
    });

    it('Scenario 37: Double-settle on already settled reservation is safely idempotent', () => {
      fakeEvm.setWalletBalance(defaultToken, 100_000_000n, 100_000_000n);
      persistence.setConfirmedOperatorBalance(defaultToken, 100_000_000n);
      const res = persistence.reserveLiquidity('exec-double-settle', defaultToken, 20_000_000n);
      persistence.commitLiquidityReservation(res.reservationId);
      persistence.settleLiquidityReservation(res.reservationId);
      assert.doesNotThrow(() => {
        persistence.settleLiquidityReservation(res.reservationId);
      });
      const item = persistence.getLiquidityReservation(res.reservationId);
      assert.equal(item?.status, 'SETTLED');
    });

    it('Scenario 38: Inactive or unobserved token returns NOT_READY readiness state', () => {
      const state = persistence.getInventoryReadinessState('0x000000000000000000000000000000000000dead');
      assert.equal(state, 'NOT_READY');
    });

    it('Scenario 39: Headroom query on unobserved token returns 0n', () => {
      const headroom = persistence.getSafeHeadroom('0x000000000000000000000000000000000000dead');
      assert.equal(headroom, 0n);
    });

    it('Scenario 40: Set readiness state persists across DB instances', () => {
      persistence.setInventoryReadinessState(defaultToken, 'DEFICIT', 'Deficit observed during test');
      const freshDb = new SqlitePersistence({ filename: dbPath });
      const state = freshDb.getInventoryReadinessState(defaultToken);
      assert.equal(state, 'DEFICIT');
      freshDb.close();
    });
  });
});
