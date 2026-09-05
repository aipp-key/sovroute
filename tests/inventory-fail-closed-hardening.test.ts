/**
 * UNIVERSAL AGENT ASSET ROUTER — SOVROUTE ARCHITECTURE V4
 * Phase 7: Base USDC Inventory Reconciliation Fail-Closed Hardening
 * Targeted Adversarial Verification Suite for Review Findings FF-1 through FF-10
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { SqlitePersistence } from '../src/persistence/sqlite.ts';
import { FakeEvmAtomicBackend } from '../src/atomic/evm/fake-backend.ts';
import { ChainInventoryReconciler } from '../src/atomic/liquidity/chain-reconciler.ts';
import { SqliteLiquidityInventory } from '../src/atomic/liquidity/sqlite-inventory.ts';
import {
  bootstrapProductionRouter,
  MissingInventoryError,
} from '../src/bootstrap.ts';
import {
  OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS,
  BASE_SEPOLIA_CHAIN_ID,
} from '../src/atomic/evm/base-guard.ts';
import {
  InventoryNotReadyError,
  EvmInventoryUnavailableError,
  BASE_SEPOLIA_TEST_POLICY,
  DEFAULT_INVENTORY_RECONCILIATION_POLICY,
  type IReconciledLiquidityInventory,
  type ILiquidityInventory,
} from '../src/atomic/types.ts';

const canonicalUsdc = OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS.toLowerCase();
const operatorAddress = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

describe('BASE INVENTORY RECONCILIATION — FAIL-CLOSED HARDENING (FF-1 through FF-10)', () => {
  let dbPath: string;
  let persistence: SqlitePersistence;
  let fakeEvm: FakeEvmAtomicBackend;

  beforeEach(() => {
    dbPath = join(tmpdir(), 'phase-failclosed-' + randomUUID() + '.db');
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
  // FF-1: Typed Reconcile-on-Boot Contract & Bootstrap Persistence Matching
  // =========================================================================
  describe('FF-1: Typed Reconcile-on-Boot Contract & Bootstrap Persistence Matching', () => {
    function getValidBootstrapConfig(databasePath: string): any {
      return {
        environment: 'production',
        databasePath,
        lightning: {
          network: 'regtest',
          host: '127.0.0.1',
          port: 18080,
          tlsCertHex: '0011223344',
          macaroonHex: 'aabbccddee',
        },
        evm: {
          chainId: BASE_SEPOLIA_CHAIN_ID,
          rpcUrl: 'https://sepolia.base.org',
          htlcAddress: '0x1111111111111111111111111111111111111111',
          usdcAddress: OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS,
          finalityPolicy: {
            policyTag: 'BASE_SEPOLIA_TEST_POLICY',
            requiredConfirmations: 2,
          },
          reconciliationPolicy: BASE_SEPOLIA_TEST_POLICY,
          operationalPrivateKey: '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        },
        safety: {
          allowMainnet: false,
          unsafeDirectExecutionForTests: false,
          minRemainingBtcBlocks: 140,
          maxReconciliationRetries: 5,
          leaseMs: 30000,
        },
      };
    }

    it('1.1: Plain ILiquidityInventory lacking reconcileOnBoot is rejected fail-closed at bootstrap', async () => {
      const plainInventory: ILiquidityInventory = {
        reserve: async () => ({ reservationId: 'r1', reserved: true }),
        release: async () => {},
        commit: async () => {},
        getAvailableBalance: async () => 100_000_000n,
      };

      const mockConfig = getValidBootstrapConfig(dbPath);
      mockConfig.environment = 'test';

      await assert.rejects(
        () => bootstrapProductionRouter(mockConfig, { _testOverrides: { inventory: plainInventory as any } }),
        (err: any) => err instanceof MissingInventoryError && err.message.includes('IReconciledLiquidityInventory')
      );
    });

    it('1.2: Reconciled inventory returning non-READY state aborts bootstrap fail-closed', async () => {
      const failingInventory: IReconciledLiquidityInventory = {
        reserve: async () => ({ reservationId: 'r1', reserved: true }),
        release: async () => {},
        commit: async () => {},
        getAvailableBalance: async () => 0n,
        getReadinessState: async () => 'DEFICIT',
        getSafeHeadroom: async () => 0n,
        reconcile: async () => ({ readinessState: 'DEFICIT', headroom: 0n }),
        reconcileOnBoot: async () => ({ readinessState: 'DEFICIT', headroom: 0n, error: 'INSUFFICIENT_FUNDS' }),
      };

      const mockConfig = getValidBootstrapConfig(dbPath);
      mockConfig.environment = 'test';

      await assert.rejects(
        () => bootstrapProductionRouter(mockConfig, { _testOverrides: { inventory: failingInventory } }),
        /INVENTORY_BOOT_RECONCILIATION_FAILED: Inventory readiness state is DEFICIT/
      );
    });

    it('1.3: SqliteLiquidityInventory bound to mismatched persistence instance is rejected fail-closed', async () => {
      const otherDbPath = join(tmpdir(), 'other-db-' + randomUUID() + '.db');
      const otherPersistence = new SqlitePersistence({ filename: otherDbPath });

      try {
        const reconciler = ChainInventoryReconciler.createForTesting({
          persistence: otherPersistence,
          capacityProvider: fakeEvm,
          defaultTokenAddress: canonicalUsdc,
        });
        const mismatchedInventory = new SqliteLiquidityInventory(otherPersistence, { reconciler });

        const mockConfig = getValidBootstrapConfig(dbPath);
        mockConfig.environment = 'test';

        await assert.rejects(
          () => bootstrapProductionRouter(mockConfig, { _testOverrides: { inventory: mismatchedInventory } }),
          /INVENTORY_PERSISTENCE_MISMATCH/
        );
      } finally {
        otherPersistence.close();
        if (existsSync(otherDbPath)) rmSync(otherDbPath, { force: true });
      }
    });
  });

  // =========================================================================
  // FF-2: Finality Observation Failure Fail-Closed Semantics
  // =========================================================================
  describe('FF-2: Finality Observation Failure Fail-Closed Semantics', () => {
    it('2.1: observeWalletCapacity throws FINALITY_OBSERVATION_FAILED when both finalized tag and historical block read fail', async () => {
      const mockCapacityProvider = {
        observeWalletCapacity: async () => {
          throw new Error('FINALITY_OBSERVATION_FAILED: Failed to read finalized balance from RPC');
        },
        verifyChainAndToken: async () => ({ valid: true }),
      };

      const reconciler = ChainInventoryReconciler.createForTesting({
        persistence,
        capacityProvider: mockCapacityProvider as any,
        defaultTokenAddress: canonicalUsdc,
      });

      const res = await reconciler.reconcileOnBoot();
      assert.strictEqual(res.readinessState, 'UNKNOWN');
      assert.strictEqual(res.headroom, 0n);
      assert.match(res.error ?? '', /FINALITY_OBSERVATION_FAILED/);
    });
  });

  // =========================================================================
  // FF-3: Active Swap Reconciliation Error Propagation
  // =========================================================================
  describe('FF-3: Active Swap Reconciliation Error Propagation', () => {
    it('3.1: RPC error while checking active swap HTLC status aborts boot fail-closed (no swallowing)', async () => {
      persistence.createSovereignSwap(
        {
          id: 'swap-err-1',
          idempotencyKey: 'idem-err-1',
          hashLock: '0x' + 'aa'.repeat(32),
          claimingAddress: operatorAddress,
          targetDestinationAddress: operatorAddress,
          amountSats: 10000n,
          expectedUsdcAmount: 10_000_000n,
          state: 'EVM_FUNDED',
          reservationId: 'res-err-1',
          tokenAddress: canonicalUsdc,
          refundAddress: operatorAddress,
          evmSwapKey: '0x' + 'bb'.repeat(32),
          evmHtlcId: '0x' + 'cc'.repeat(32),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        'fp-err-1'
      );

      const brokenProvider = {
        observeWalletCapacity: async () => ({
          tokenAddress: canonicalUsdc,
          chainId: 84532,
          operatorAddress,
          walletBalanceLatest: 100_000_000n,
          walletBalanceFinalized: 100_000_000n,
          safeWalletCapacity: 100_000_000n,
          latestBlockNumber: 100,
          finalizedBlockNumber: 98,
          observedAt: new Date(),
        }),
        verifyChainAndToken: async () => ({ valid: true }),
        getContractHtlcState: async () => {
          throw new Error('RPC_NODE_CONNECTION_RESET');
        },
      };

      const reconciler = ChainInventoryReconciler.createForTesting({
        persistence,
        capacityProvider: brokenProvider as any,
        defaultTokenAddress: canonicalUsdc,
      });

      const bootResult = await reconciler.reconcileOnBoot();
      assert.strictEqual(bootResult.readinessState, 'UNKNOWN', 'Must fail closed to UNKNOWN, never READY');
      assert.match(bootResult.error ?? '', /ACTIVE_SWAP_RECONCILIATION_FAILED/);
    });
  });

  // =========================================================================
  // FF-4: Corrupted Query in getUnresolvedFundingIntentsAmount
  // =========================================================================
  describe('FF-4: Corrupted Query in getUnresolvedFundingIntentsAmount', () => {
    it('4.1: Internal query error during intent amount calculation throws EvmInventoryUnavailableError in reserveLiquidity', () => {
      persistence.recordChainInventorySnapshot({
        tokenAddress: canonicalUsdc,
        chainId: 84532,
        operatorAddress,
        walletBalanceLatest: 100_000_000n,
        walletBalanceFinalized: 100_000_000n,
        safeWalletCapacity: 100_000_000n,
        latestBlockNumber: 100,
        finalizedBlockNumber: 98,
        readinessState: 'READY',
        observedAt: new Date(),
        freshUntil: new Date(Date.now() + 60_000),
        updatedAt: new Date(),
      });

      (persistence as any).db.exec('DROP TABLE evm_transaction_intents');

      assert.throws(
        () => persistence.reserveLiquidity('exec-corrupt-1', canonicalUsdc, 10_000_000n),
        (err: any) => err instanceof EvmInventoryUnavailableError && err.message.includes('unresolved funding liabilities')
      );

      const headroom = persistence.getSafeHeadroom(canonicalUsdc);
      assert.strictEqual(headroom, 0n);
    });
  });

  // =========================================================================
  // FF-5: Absence of Chain Snapshot Rejects Reservation Unless Legacy Fallback Explicitly Enabled
  // =========================================================================
  describe('FF-5: Absence of Chain Snapshot Rejects Reservation', () => {
    it('5.1: Direct reserveLiquidity with confirmed balance but NO chain snapshot throws InventoryNotReadyError by default', () => {
      persistence.setConfirmedOperatorBalance(canonicalUsdc, 500_000_000n);

      assert.throws(
        () => persistence.reserveLiquidity('exec-no-snapshot', canonicalUsdc, 10_000_000n),
        (err: any) => err instanceof InventoryNotReadyError && err.message.includes('NO_CHAIN_INVENTORY_SNAPSHOT')
      );
    });

    it('5.2: Legacy fallback succeeds ONLY when enableLegacyFallbackForTesting() is explicitly enabled', () => {
      persistence.setConfirmedOperatorBalance(canonicalUsdc, 500_000_000n);
      persistence.enableLegacyFallbackForTesting();

      const res = persistence.reserveLiquidity('exec-legacy-ok', canonicalUsdc, 10_000_000n);
      assert.strictEqual(res.reserved, true);
    });
  });

  // =========================================================================
  // FF-6: Snapshot Freshness Verification Inside BEGIN IMMEDIATE
  // =========================================================================
  describe('FF-6: Snapshot Freshness Verification Inside BEGIN IMMEDIATE', () => {
    it('6.1: Snapshot past freshUntil is marked DEGRADED in SQLite under BEGIN IMMEDIATE and throws EvmInventoryUnavailableError', () => {
      const expiredTime = new Date(Date.now() - 5000);
      persistence.recordChainInventorySnapshot({
        tokenAddress: canonicalUsdc,
        chainId: 84532,
        operatorAddress,
        walletBalanceLatest: 100_000_000n,
        walletBalanceFinalized: 100_000_000n,
        safeWalletCapacity: 100_000_000n,
        latestBlockNumber: 100,
        finalizedBlockNumber: 98,
        readinessState: 'READY',
        observedAt: new Date(Date.now() - 65_000),
        freshUntil: expiredTime,
        updatedAt: new Date(Date.now() - 65_000),
      });

      assert.throws(
        () => persistence.reserveLiquidity('exec-stale-begimm', canonicalUsdc, 10_000_000n),
        (err: any) => err instanceof EvmInventoryUnavailableError && err.message.includes('STALE_SNAPSHOT')
      );

      const updated = persistence.getLatestChainInventorySnapshot(canonicalUsdc);
      assert.strictEqual(updated?.readinessState, 'DEGRADED');
    });
  });

  // =========================================================================
  // FF-7: Phase 3.5 Funding Intent Active Startup Reconciliation
  // =========================================================================
  describe('FF-7: Phase 3.5 Funding Intent Active Startup Reconciliation', () => {
    it('7.1: Boot reconciliation reconciles mined FUND intent: commits reservation', async () => {
      fakeEvm.setWalletBalance(canonicalUsdc, 100_000_000n, 100_000_000n);
      const reconciler = ChainInventoryReconciler.createForTesting({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: canonicalUsdc,
      });

      await reconciler.reconcileOnBoot();

      const res = persistence.reserveLiquidity('exec-fund-mined', canonicalUsdc, 25_000_000n);
      assert.strictEqual(res.reserved, true);
      const swapKey = '0x' + '44'.repeat(32);
      const htlcId = '0x' + '45'.repeat(32);

      persistence.createSovereignSwap(
        {
          id: 'exec-fund-mined',
          idempotencyKey: 'idem-fund-mined',
          hashLock: '0x' + '46'.repeat(32),
          claimingAddress: operatorAddress,
          targetDestinationAddress: operatorAddress,
          amountSats: 10000n,
          expectedUsdcAmount: 25_000_000n,
          state: 'EVM_FUNDED',
          reservationId: res.reservationId,
          tokenAddress: canonicalUsdc,
          refundAddress: operatorAddress,
          evmSwapKey: swapKey,
          evmHtlcId: htlcId,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        'fp-fund-mined'
      );

      persistence.getOrCreateEvmIntent({
        swapKey,
        actionType: 'FUND',
        chainId: 84532,
        signerAddress: operatorAddress as `0x${string}`,
        targetAddress: canonicalUsdc as `0x${string}`,
        calldata: '0x',
      });

      (fakeEvm as any).getContractHtlcState = async (id: string) => {
        if (id === htlcId) return { status: 1, amount: 25_000_000n };
        return null;
      };

      await reconciler.reconcileOnBoot();

      const reservation = persistence.getLiquidityReservation(res.reservationId);
      assert.strictEqual(reservation?.status, 'COMMITTED');
    });
  });

  // =========================================================================
  // FF-8: Canonical Base Sepolia USDC Contract Identity Verification
  // =========================================================================
  describe('FF-8: Canonical Base Sepolia USDC Contract Identity Verification', () => {
    it('8.1: verifyChainAndToken rejects arbitrary or counterfeit token address fail-closed', async () => {
      const counterfeitToken = '0x1111111111111111111111111111111111111111';

      const result = await fakeEvm.verifyChainAndToken(BASE_SEPOLIA_CHAIN_ID, counterfeitToken);
      assert.strictEqual(result.valid, false);
      assert.match(result.reason ?? '', /TOKEN_CONTRACT_MISMATCH/);

      const reconciler = ChainInventoryReconciler.createForTesting({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: counterfeitToken,
      });

      const bootResult = await reconciler.reconcileOnBoot();
      assert.strictEqual(bootResult.readinessState, 'NOT_READY');
      assert.match(bootResult.error ?? '', /TOKEN_CONTRACT_MISMATCH/);
    });

    it('8.2: verifyChainAndToken accepts canonical Base Sepolia USDC', async () => {
      const result = await fakeEvm.verifyChainAndToken(BASE_SEPOLIA_CHAIN_ID, canonicalUsdc);
      assert.strictEqual(result.valid, true);
    });
  });

  // =========================================================================
  // FF-9: Base Sepolia Chain ID 84532 Default
  // =========================================================================
  describe('FF-9: Base Sepolia Chain ID 84532 Default', () => {
    it('9.1: FakeEvmAtomicBackend defaults to chainId 84532 (Base Sepolia)', () => {
      const backend = new FakeEvmAtomicBackend();
      assert.strictEqual(backend.chainId, 84532);
      assert.strictEqual(backend.chainId, BASE_SEPOLIA_CHAIN_ID);
    });

    it('9.2: verifyChainAndToken fails closed when expected chainId differs from 84532', async () => {
      const wrongChainId = 42161;
      const result = await fakeEvm.verifyChainAndToken(wrongChainId, canonicalUsdc);
      assert.strictEqual(result.valid, false);
      assert.match(result.reason ?? '', /WRONG_CHAIN_ID/);
    });
  });

  // =========================================================================
  // FF-10: Policy vs Invariant Boundary
  // =========================================================================
  describe('FF-10: Policy vs Invariant Boundary', () => {
    it('10.1: Policy configuration is distinct from invariant logic and uses BASE_SEPOLIA_TEST_POLICY', () => {
      assert.strictEqual(BASE_SEPOLIA_TEST_POLICY.maxFreshnessMs, 60_000);
      assert.strictEqual(BASE_SEPOLIA_TEST_POLICY.requiredConfirmations, 2);
      assert.strictEqual(BASE_SEPOLIA_TEST_POLICY.failClosedOnDeficit, true);
      assert.deepStrictEqual(DEFAULT_INVENTORY_RECONCILIATION_POLICY, BASE_SEPOLIA_TEST_POLICY);
    });

    it('10.2: Custom policy overrides are cleanly respected by reconciler', () => {
      const reconciler = ChainInventoryReconciler.createForTesting({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: canonicalUsdc,
        policy: {
          maxFreshnessMs: 30_000,
          requiredConfirmations: 5,
        },
      });

      const policy = reconciler.getPolicy();
      assert.strictEqual(policy.maxFreshnessMs, 30_000);
      assert.strictEqual(policy.requiredConfirmations, 5);
      assert.strictEqual(policy.failClosedOnDeficit, true);
    });
  });
});
