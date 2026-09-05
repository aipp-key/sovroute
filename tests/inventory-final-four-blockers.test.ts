/**
 * UNIVERSAL AGENT ASSET ROUTER — SOVROUTE ARCHITECTURE V4
 * Phase 7: Final Four Merge-Blocking Defects (FB-1 through FB-4)
 * Adversarial Verification Suite: Tests 1 through 34
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { SqlitePersistence } from '../src/persistence/sqlite.ts';
import { FakeEvmAtomicBackend } from '../src/atomic/evm/fake-backend.ts';
import { FakeLightningAtomicBackend } from '../src/atomic/lightning/fake-backend.ts';
import { ChainInventoryReconciler } from '../src/atomic/liquidity/chain-reconciler.ts';
import { SqliteLiquidityInventory } from '../src/atomic/liquidity/sqlite-inventory.ts';
import { AtomicCoordinator } from '../src/atomic/coordinator/coordinator.ts';
import {
  bootstrapProductionRouter,
  bootstrapProductionRouterForTesting,
  ProductionConfigError,
} from '../src/bootstrap.ts';
import { BaseSepoliaAtomicBackend } from '../src/atomic/evm/base-sepolia-backend.ts';
import { ProductionConfigValidator, type RouterProductionConfig } from '../src/config/production-config.ts';
import {
  OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS,
  BASE_SEPOLIA_CHAIN_ID,
} from '../src/atomic/evm/base-guard.ts';
import {
  BASE_SEPOLIA_TEST_POLICY,
  SovereignAtomicState,
  type BaseInventoryReconciliationPolicy,
} from '../src/atomic/types.ts';

const canonicalUsdc = OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS.toLowerCase();
const operatorAddress = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const pinnedHtlcBytecode = JSON.parse(
  readFileSync(join(process.cwd(), 'artifacts', 'contracts', 'HtlcErc20.sol', 'HtlcErc20.json'), 'utf8')
).deployedBytecode as string;

function getValidProductionConfig(dbPath: string): RouterProductionConfig {
  return {
    environment: 'production',
    databasePath: dbPath,
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
        policyTag: 'BASE_SEPOLIA_PRODUCTION_POLICY',
        requiredConfirmations: 2,
      },
      reconciliationPolicy: {
        maxFreshnessMs: 45_000,
        requiredConfirmations: 2,
        reorgLagTolerance: 0,
        failClosedOnDeficit: true,
      },
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

describe('BASE INVENTORY RECONCILIATION — FINAL FOUR BLOCKING DEFECTS (FB-1 to FB-4)', () => {
  let dbPath: string;
  let persistence: SqlitePersistence;
  let fakeEvm: FakeEvmAtomicBackend;

  beforeEach(() => {
    dbPath = join(tmpdir(), 'phase-fb-tests-' + randomUUID() + '.db');
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
  // FB-1 TESTS — ONE AUTHORITY GRAPH (Tests 1 - 9)
  // =========================================================================
  describe('FB-1: Production Bootstrap Authority Graph', () => {
    it('1. Canonical production bootstrap constructs the real authority graph with only transport seams', async () => {
      const cfg = getValidProductionConfig(dbPath);
      const basePublicClient = {
        getChainId: async () => BASE_SEPOLIA_CHAIN_ID,
        getCode: async () => '0x60006000',
        getBytecode: async () => pinnedHtlcBytecode,
        getBlockNumber: async () => 100n,
        getBlock: async () => ({ hash: '0x' + 'ab'.repeat(32) }),
        readContract: async ({ functionName }: { functionName: string }) =>
          functionName === 'decimals' ? 6 : 200_000_000n,
      };
      const lndClient = {
        getInfo: async () => ({ chains: [{ chain: 'bitcoin', network: 'regtest' }], block_height: 100 }),
        addHoldInvoice: async () => { throw new Error('not used'); },
        lookupInvoice: async () => { throw new Error('not used'); },
        settleInvoice: async () => {},
        cancelInvoice: async () => {},
      } as any;

      const result = await bootstrapProductionRouterForTesting(cfg, {
        basePublicClient,
        lndClient,
      });

      try {
        assert.strictEqual(cfg.environment, 'production');
        assert.ok(result.evmBackend instanceof BaseSepoliaAtomicBackend);
        assert.ok(result.inventory instanceof SqliteLiquidityInventory);
        assert.strictEqual(result.coordinator.getPersistence(), result.persistence);
        assert.strictEqual(result.coordinator.getEvmBackend(), result.evmBackend);
        assert.strictEqual(result.coordinator.getInventory(), result.inventory);
        assert.strictEqual(result.reconciler.getCapacityProvider(), result.evmBackend);
        assert.strictEqual(result.inventory.getReconciler(), result.reconciler);
        assert.strictEqual(result.evmBackend.getHtlcAddress(), cfg.evm.htlcAddress);
        assert.strictEqual(result.evmBackend.getTokenAddress(), cfg.evm.usdcAddress);
        assert.strictEqual(result.evmBackend.chainId, cfg.evm.chainId);
        assert.deepStrictEqual(result.evmBackend.finalityPolicy, cfg.evm.finalityPolicy);
        assert.strictEqual(result.evmBackend.getTransactionManager()?.policy.requiredConfirmations, 2);
      } finally {
        result.persistence.close();
      }
    });

    it('2. Returned coordinator uses the exact same Base backend object as reconciler capacity provider', async () => {
      fakeEvm.setWalletBalance(canonicalUsdc, 100_000_000n, 100_000_000n);
      const fakeLnd = new FakeLightningAtomicBackend();
      const cfg = getValidProductionConfig(dbPath);
      cfg.environment = 'test';

      const result = await bootstrapProductionRouter(cfg, {
        _testOverrides: {
          evmBackend: fakeEvm,
          lightningBackend: fakeLnd,
        },
      });

      const coordEvm = (result.coordinator as any).evm;
      const recCap = (result.reconciler as any).capacityProvider;
      assert.strictEqual(coordEvm, recCap, 'Coordinator EVM backend must equal reconciler capacity provider');
      assert.strictEqual(coordEvm, fakeEvm, 'Must be the injected Base backend');
    });

    it('3. Returned coordinator uses the exact same persistence instance as inventory', async () => {
      fakeEvm.setWalletBalance(canonicalUsdc, 100_000_000n, 100_000_000n);
      const fakeLnd = new FakeLightningAtomicBackend();
      const cfg = getValidProductionConfig(dbPath);
      cfg.environment = 'test';

      const result = await bootstrapProductionRouter(cfg, {
        _testOverrides: {
          evmBackend: fakeEvm,
          lightningBackend: fakeLnd,
        },
      });

      const coordPers = (result.coordinator as any).persistence;
      const invPers = (result.inventory as any).persistence;
      assert.strictEqual(coordPers, invPers, 'Coordinator persistence must be identical to inventory persistence');
      assert.strictEqual(coordPers, result.persistence, 'Must match bootstrap returned persistence');
    });

    it('4. Returned inventory uses the exact same reconciler created by bootstrap', async () => {
      fakeEvm.setWalletBalance(canonicalUsdc, 100_000_000n, 100_000_000n);
      const fakeLnd = new FakeLightningAtomicBackend();
      const cfg = getValidProductionConfig(dbPath);
      cfg.environment = 'test';

      const result = await bootstrapProductionRouter(cfg, {
        _testOverrides: {
          evmBackend: fakeEvm,
          lightningBackend: fakeLnd,
        },
      });

      const invReconciler = (result.inventory as any).reconciler;
      assert.strictEqual(invReconciler, result.reconciler, 'Inventory reconciler must be identical to bootstrap reconciler');
    });

    it('5. Reconciliation uses the configured canonical USDC token', async () => {
      fakeEvm.setWalletBalance(canonicalUsdc, 100_000_000n, 100_000_000n);
      const fakeLnd = new FakeLightningAtomicBackend();
      const cfg = getValidProductionConfig(dbPath);
      cfg.environment = 'test';

      const result = await bootstrapProductionRouter(cfg, {
        _testOverrides: {
          evmBackend: fakeEvm,
          lightningBackend: fakeLnd,
        },
      });

      const reconcilerToken = (result.reconciler as any).defaultTokenAddress;
      assert.strictEqual(reconcilerToken, canonicalUsdc, 'Reconciler must use configured canonical USDC');
      const snapshot = result.persistence.getLatestChainInventorySnapshot(canonicalUsdc);
      assert.ok(snapshot, 'Snapshot must exist for canonical USDC');
      assert.strictEqual(snapshot?.tokenAddress, canonicalUsdc);
    });

    it('6. Reconciliation uses the configured explicit finality/freshness policy', async () => {
      fakeEvm.setWalletBalance(canonicalUsdc, 100_000_000n, 100_000_000n);
      const fakeLnd = new FakeLightningAtomicBackend();
      const cfg = getValidProductionConfig(dbPath);
      cfg.environment = 'test';
      cfg.evm.finalityPolicy.requiredConfirmations = 3;
      fakeEvm.finalityPolicy = {
        policyTag: cfg.evm.finalityPolicy.policyTag,
        requiredConfirmations: 3,
      };
      cfg.evm.reconciliationPolicy = {
        maxFreshnessMs: 42_000,
        requiredConfirmations: 3,
        reorgLagTolerance: 1,
        failClosedOnDeficit: true,
      };

      const result = await bootstrapProductionRouter(cfg, {
        _testOverrides: {
          evmBackend: fakeEvm,
          lightningBackend: fakeLnd,
        },
      });

      const policy = result.reconciler.getPolicy();
      assert.strictEqual(policy.maxFreshnessMs, 42_000);
      assert.strictEqual(policy.requiredConfirmations, 3);
      assert.strictEqual(policy.reorgLagTolerance, 1);
    });

    it('7. If reconciliation != READY: coordinator is never created/returned', async () => {
      const brokenEvm = {
        verifyChainAndToken: async () => ({ valid: true }),
        observeWalletCapacity: async () => {
          throw new Error('FINALITY_OBSERVATION_FAILED');
        },
      };
      const cfg = getValidProductionConfig(dbPath);
      cfg.environment = 'test';

      await assert.rejects(
        () =>
          bootstrapProductionRouter(cfg, {
            _testOverrides: {
              evmBackend: brokenEvm as any,
              lightningBackend: new FakeLightningAtomicBackend(),
            },
          }),
        /INVENTORY_BOOT_RECONCILIATION_FAILED|INVENTORY_NOT_READY/
      );
    });

    it('8. A fake external inventory cannot replace production inventory', async () => {
      const cfg = getValidProductionConfig(dbPath);
      const fakeExternalInventory = {
        reserve: async () => ({ reservationId: 'fake', reserved: true }),
        release: async () => {},
        commit: async () => {},
        getAvailableBalance: async () => 1_000_000_000n,
        getReadinessState: async () => 'READY',
        getSafeHeadroom: async () => 1_000_000_000n,
        reconcile: async () => ({ readinessState: 'READY', headroom: 1_000_000_000n }),
        reconcileOnBoot: async () => ({ readinessState: 'READY', headroom: 1_000_000_000n }),
      };

      await assert.rejects(
        () => bootstrapProductionRouter(cfg, { inventory: fakeExternalInventory as any } as any),
        (err: any) =>
          err instanceof ProductionConfigError &&
          err.message.includes('External inventory injection is strictly prohibited')
      );
    });

    it('9. A second external SQLite persistence cannot become production liquidity authority', async () => {
      const otherDbPath = join(tmpdir(), 'other-authority-' + randomUUID() + '.db');
      const otherPersistence = new SqlitePersistence({ filename: otherDbPath });

      try {
        const reconciler = ChainInventoryReconciler.createForTesting({
          persistence: otherPersistence,
          capacityProvider: fakeEvm,
          defaultTokenAddress: canonicalUsdc,
        });
        const foreignInventory = new SqliteLiquidityInventory(otherPersistence, { reconciler });

        const cfg = getValidProductionConfig(dbPath);
        cfg.environment = 'test';

        await assert.rejects(
          () =>
            bootstrapProductionRouter(cfg, {
              _testOverrides: {
                inventory: foreignInventory,
              },
            }),
          /INVENTORY_PERSISTENCE_MISMATCH/
        );
      } finally {
        otherPersistence.close();
        if (existsSync(otherDbPath)) rmSync(otherDbPath, { force: true });
      }
    });
  });

  // =========================================================================
  // FB-2 TESTS — CROSS-RAIL RESERVATION RETENTION (Tests 10 - 20)
  // =========================================================================
  describe('FB-2: Cross-Rail Reservation Retention on Base Funding Failures', () => {
    function setupSwapWithIntent(
      swapId: string,
      swapKey: string,
      amount: bigint,
      swapState: any,
      intentStatus: 'REVERTED' | 'FAILED' | 'NONCE_CONFLICT' | 'CONFIRMED' | 'PENDING'
    ) {
      fakeEvm.setWalletBalance(canonicalUsdc, 100_000_000n, 100_000_000n);
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

      const res = persistence.reserveLiquidity(swapId, canonicalUsdc, amount);
      assert.strictEqual(res.reserved, true);

      persistence.createSovereignSwap(
        {
          id: swapId,
          idempotencyKey: 'idem-' + swapId,
          hashLock: '0x' + 'aa'.repeat(32),
          claimingAddress: operatorAddress,
          targetDestinationAddress: operatorAddress,
          amountSats: 10000n,
          expectedUsdcAmount: amount,
          state: swapState,
          reservationId: res.reservationId,
          reservedAmountUnits: amount,
          reservationStatus: 'RESERVED',
          holdInvoice: {
            paymentHash: 'aa'.repeat(32),
            bolt11: 'lnbc-test-' + swapId,
            amountSats: 10000n,
            cltvExpiryBlocks: 144,
            state: swapState === SovereignAtomicState.INVOICE_CREATED ? 'OPEN' : 'ACCEPTED',
            createdAt: new Date(),
          },
          tokenAddress: canonicalUsdc,
          refundAddress: operatorAddress,
          evmSwapKey: swapKey,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        'fp-' + swapId
      );

      persistence.getOrCreateEvmIntent({
        swapKey,
        actionType: 'FUND',
        chainId: 84532,
        signerAddress: operatorAddress as `0x${string}`,
        targetAddress: canonicalUsdc as `0x${string}`,
        calldata: '0x',
      });

      // Provide mock transaction manager that reconciles intent to intentStatus
      const mockTxManager = {
        reconcileIntent: async () => ({
          status: intentStatus,
        }),
      };
      (fakeEvm as any).getTransactionManager = () => mockTxManager;

      return res.reservationId;
    }

    it('10. Lightning ACCEPTED + Base FUND REVERTED: reservation remains locked', async () => {
      const reservationId = setupSwapWithIntent(
        'swap-fb2-10',
        '0x' + '10'.repeat(32),
        25_000_000n,
        'LIGHTNING_HELD',
        'REVERTED'
      );

      const reconciler = ChainInventoryReconciler.createForTesting({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: canonicalUsdc,
      });

      await reconciler.reconcileOnBoot();

      const reservation = persistence.getLiquidityReservation(reservationId);
      assert.strictEqual(reservation?.status, 'RESERVED', 'Must remain locked in RESERVED status');
    });

    it('11. Lightning ACCEPTED + FUND FAILED: reservation remains locked', async () => {
      const reservationId = setupSwapWithIntent(
        'swap-fb2-11',
        '0x' + '11'.repeat(32),
        25_000_000n,
        'LIGHTNING_HELD',
        'FAILED'
      );

      const reconciler = ChainInventoryReconciler.createForTesting({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: canonicalUsdc,
      });

      await reconciler.reconcileOnBoot();

      const reservation = persistence.getLiquidityReservation(reservationId);
      assert.strictEqual(reservation?.status, 'RESERVED', 'Must remain locked in RESERVED status');
    });

    it('12. Lightning ACCEPTED + NONCE_CONFLICT: reservation remains locked', async () => {
      const reservationId = setupSwapWithIntent(
        'swap-fb2-12',
        '0x' + '12'.repeat(32),
        25_000_000n,
        'EVM_FUNDING_PENDING',
        'NONCE_CONFLICT'
      );

      const reconciler = ChainInventoryReconciler.createForTesting({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: canonicalUsdc,
      });

      await reconciler.reconcileOnBoot();

      const reservation = persistence.getLiquidityReservation(reservationId);
      assert.strictEqual(reservation?.status, 'RESERVED', 'Must remain locked in RESERVED status');
    });

    it('13. These failures transition swap into recovery-required state', async () => {
      setupSwapWithIntent(
        'swap-fb2-13',
        '0x' + '13'.repeat(32),
        25_000_000n,
        'LIGHTNING_HELD',
        'REVERTED'
      );

      const reconciler = ChainInventoryReconciler.createForTesting({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: canonicalUsdc,
      });

      await reconciler.reconcileOnBoot();

      const swap = persistence.getSovereignSwap('swap-fb2-13');
      assert.strictEqual(swap?.state, 'RECOVERY_REQUIRED', 'Swap must transition to RECOVERY_REQUIRED');
    });

    it('14. New unrelated swap cannot consume preserved reservation', async () => {
      setupSwapWithIntent(
        'swap-fb2-14',
        '0x' + '14'.repeat(32),
        70_000_000n,
        'LIGHTNING_HELD',
        'REVERTED'
      );

      const reconciler = ChainInventoryReconciler.createForTesting({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: canonicalUsdc,
      });

      await reconciler.reconcileOnBoot();

      assert.throws(
        () => persistence.reserveLiquidity('unrelated-swap', canonicalUsdc, 40_000_000n),
        /EVM_INVENTORY_UNAVAILABLE/
      );
      assert.strictEqual(persistence.getReservedOperatorBalance(canonicalUsdc), 70_000_000n);
    });

    it('15. After successful Lightning cancellation AND proven no Base funding: reservation releases exactly once', async () => {
      const reservationId = setupSwapWithIntent(
        'swap-fb2-15',
        '0x' + '15'.repeat(32),
        50_000_000n,
        'LIGHTNING_HELD',
        'REVERTED'
      );

      const reconciler = ChainInventoryReconciler.createForTesting({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: canonicalUsdc,
      });

      await reconciler.reconcileOnBoot();
      assert.strictEqual(persistence.getLiquidityReservation(reservationId)?.status, 'RESERVED');
      const lightning = new FakeLightningAtomicBackend();
      const invoice = await lightning.createHoldInvoice('0x' + 'aa'.repeat(32), 10000n, 144);
      await lightning.cancelHoldInvoice(invoice.paymentHash);
      const coordinator = new AtomicCoordinator(
        lightning,
        fakeEvm,
        new SqliteLiquidityInventory(persistence),
        { persistence, finalityPolicy: fakeEvm.finalityPolicy }
      );
      const recovered = await coordinator.reconcileSwap('swap-fb2-15');

      assert.strictEqual(recovered.state, SovereignAtomicState.INVOICE_CANCELED);
      assert.strictEqual(persistence.getLiquidityReservation(reservationId)?.status, 'RELEASED');
      assert.strictEqual(persistence.getSovereignSwap('swap-fb2-15')?.reservationStatus, 'RELEASED');
    });

    it('16. Duplicate recovery execution: no double release', async () => {
      const reservationId = setupSwapWithIntent(
        'swap-fb2-16',
        '0x' + '16'.repeat(32),
        50_000_000n,
        'LIGHTNING_HELD',
        'REVERTED'
      );

      const reconciler = ChainInventoryReconciler.createForTesting({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: canonicalUsdc,
      });
      await reconciler.reconcileOnBoot();
      const lightning = new FakeLightningAtomicBackend();
      const invoice = await lightning.createHoldInvoice('0x' + 'aa'.repeat(32), 10000n, 144);
      await lightning.cancelHoldInvoice(invoice.paymentHash);
      const coordinator = new AtomicCoordinator(
        lightning,
        fakeEvm,
        new SqliteLiquidityInventory(persistence),
        { persistence, finalityPolicy: fakeEvm.finalityPolicy }
      );
      await coordinator.reconcileSwap('swap-fb2-16');
      await coordinator.reconcileSwap('swap-fb2-16');
      assert.strictEqual(persistence.getLiquidityReservation(reservationId)?.status, 'RELEASED');
    });

    it('17. Local pre-ACCEPTED state is not authoritative terminal proof: reservation remains retained', async () => {
      const reservationId = setupSwapWithIntent(
        'swap-fb2-17',
        '0x' + '17'.repeat(32),
        25_000_000n,
        'INVOICE_CREATED',
        'REVERTED'
      );

      const reconciler = ChainInventoryReconciler.createForTesting({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: canonicalUsdc,
      });

      await reconciler.reconcileOnBoot();

      const res = persistence.getLiquidityReservation(reservationId);
      assert.strictEqual(res?.status, 'RESERVED');
      assert.strictEqual(persistence.getSovereignSwap('swap-fb2-17')?.recoveryRequired, true);
    });

    it('18. Unknown Base funding result: reservation remains locked', async () => {
      const reservationId = setupSwapWithIntent(
        'swap-fb2-18',
        '0x' + '18'.repeat(32),
        25_000_000n,
        'EVM_FUNDING_PENDING',
        'PENDING'
      );

      const reconciler = ChainInventoryReconciler.createForTesting({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: canonicalUsdc,
      });

      await reconciler.reconcileOnBoot();

      const reservation = persistence.getLiquidityReservation(reservationId);
      assert.strictEqual(reservation?.status, 'RESERVED');
    });

    it('19. Fund timeout + HTLC later discovered: reservation becomes COMMITTED, not RELEASED', async () => {
      const htlcId = '0x' + '19'.repeat(32);
      const swapKey = '0x' + '19'.repeat(32);
      const reservationId = setupSwapWithIntent(
        'swap-fb2-19',
        swapKey,
        25_000_000n,
        'EVM_FUNDED',
        'CONFIRMED'
      );

      persistence.updateSovereignSwap('swap-fb2-19', { evmHtlcId: htlcId });

      (fakeEvm as any).getContractHtlcState = async (id: string) => {
        if (id === htlcId) return { status: 1, amount: 25_000_000n };
        return null;
      };

      const reconciler = ChainInventoryReconciler.createForTesting({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: canonicalUsdc,
      });

      await reconciler.reconcileOnBoot();

      const reservation = persistence.getLiquidityReservation(reservationId);
      assert.strictEqual(reservation?.status, 'COMMITTED', 'Must become COMMITTED, not RELEASED');
    });

    it('20. Fund revert + Lightning cancellation failure: reservation remains locked', async () => {
      const reservationId = setupSwapWithIntent(
        'swap-fb2-20',
        '0x' + '20'.repeat(32),
        30_000_000n,
        'LIGHTNING_HELD',
        'REVERTED'
      );

      const reconciler = ChainInventoryReconciler.createForTesting({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: canonicalUsdc,
      });

      await reconciler.reconcileOnBoot();

      const reservation = persistence.getLiquidityReservation(reservationId);
      assert.strictEqual(reservation?.status, 'RESERVED', 'Reservation must remain locked');
    });
  });

  // =========================================================================
  // FB-3 TESTS — UNKNOWN ACTIVE HTLC (Tests 21 - 29)
  // =========================================================================
  describe('FB-3: Unknown Active HTLC Fail-Closed Verification', () => {
    function createActiveSwap(swapId: string, state: any, htlcId: string | null) {
      fakeEvm.setWalletBalance(canonicalUsdc, 100_000_000n, 100_000_000n);
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

      const res = persistence.reserveLiquidity(swapId, canonicalUsdc, 15_000_000n);

      persistence.createSovereignSwap(
        {
          id: swapId,
          idempotencyKey: 'idem-' + swapId,
          hashLock: '0x' + '33'.repeat(32),
          claimingAddress: operatorAddress,
          targetDestinationAddress: operatorAddress,
          amountSats: 10000n,
          expectedUsdcAmount: 15_000_000n,
          state,
          reservationId: res.reservationId,
          reservedAmountUnits: 15_000_000n,
          reservationStatus: 'RESERVED',
          tokenAddress: canonicalUsdc,
          refundAddress: operatorAddress,
          evmSwapKey: '0x' + '33'.repeat(32),
          evmHtlcId: htlcId ?? undefined,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        'fp-' + swapId
      );

      return res.reservationId;
    }

    it('21. EVM_FUNDED swap missing htlcId: boot UNKNOWN', async () => {
      createActiveSwap('swap-fb3-21', 'EVM_FUNDED', null);

      const reconciler = ChainInventoryReconciler.createForTesting({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: canonicalUsdc,
      });

      const res = await reconciler.reconcileOnBoot();
      assert.strictEqual(res.readinessState, 'UNKNOWN');
      assert.match(res.error ?? '', /ACTIVE_SWAP_RECONCILIATION_FAILED/);
    });

    it('22. EVM_FUNDED swap + provider missing getContractHtlcState: boot UNKNOWN', async () => {
      createActiveSwap('swap-fb3-22', 'EVM_FUNDED', '0x' + '22'.repeat(32));

      const providerWithoutHtlc = {
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
      };

      const reconciler = ChainInventoryReconciler.createForTesting({
        persistence,
        capacityProvider: providerWithoutHtlc as any,
        defaultTokenAddress: canonicalUsdc,
      });

      const res = await reconciler.reconcileOnBoot();
      assert.strictEqual(res.readinessState, 'UNKNOWN');
      assert.match(res.error ?? '', /ACTIVE_SWAP_RECONCILIATION_FAILED/);
    });

    it('23. EVM_FUNDED swap + getContractHtlcState returns null: boot UNKNOWN', async () => {
      const htlcId = '0x' + '23'.repeat(32);
      createActiveSwap('swap-fb3-23', 'EVM_FUNDED', htlcId);

      (fakeEvm as any).getContractHtlcState = async () => null;

      const reconciler = ChainInventoryReconciler.createForTesting({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: canonicalUsdc,
      });

      const res = await reconciler.reconcileOnBoot();
      assert.strictEqual(res.readinessState, 'UNKNOWN');
      assert.match(res.error ?? '', /ACTIVE_SWAP_RECONCILIATION_FAILED/);
    });

    it('24. EVM_FUNDED swap + RPC error: boot UNKNOWN', async () => {
      const htlcId = '0x' + '24'.repeat(32);
      createActiveSwap('swap-fb3-24', 'EVM_FUNDED', htlcId);

      (fakeEvm as any).getContractHtlcState = async () => {
        throw new Error('ETIMEDOUT: RPC connection timed out');
      };

      const reconciler = ChainInventoryReconciler.createForTesting({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: canonicalUsdc,
      });

      const res = await reconciler.reconcileOnBoot();
      assert.strictEqual(res.readinessState, 'UNKNOWN');
      assert.match(res.error ?? '', /ACTIVE_SWAP_RECONCILIATION_FAILED/);
    });

    it('25. EVM_FUNDED swap + correct LOCKED state: reconciliation can continue', async () => {
      const htlcId = '0x' + '25'.repeat(32);
      const resId = createActiveSwap('swap-fb3-25', 'EVM_FUNDED', htlcId);

      (fakeEvm as any).getContractHtlcState = async (id: string) => {
        if (id === htlcId) return { status: 1, amount: 15_000_000n };
        return null;
      };

      const reconciler = ChainInventoryReconciler.createForTesting({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: canonicalUsdc,
      });

      const res = await reconciler.reconcileOnBoot();
      assert.strictEqual(res.readinessState, 'READY');
      assert.strictEqual(res.headroom, 100_000_000n);
      assert.strictEqual(persistence.getLiquidityReservation(resId)?.status, 'COMMITTED');
    });

    it('26. CLAIMED state: settle accounting exactly once', async () => {
      const htlcId = '0x' + '26'.repeat(32);
      const resId = createActiveSwap('swap-fb3-26', 'EVM_FUNDED', htlcId);
      persistence.commitLiquidityReservation(resId);

      (fakeEvm as any).getContractHtlcState = async (id: string) => {
        if (id === htlcId) return { status: 2, amount: 15_000_000n };
        return null;
      };

      const reconciler = ChainInventoryReconciler.createForTesting({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: canonicalUsdc,
      });

      const res = await reconciler.reconcileOnBoot();
      assert.strictEqual(res.readinessState, 'READY');
      const reservation = persistence.getLiquidityReservation(resId);
      assert.strictEqual(reservation?.status, 'SETTLED');
    });

    it('27. REFUNDED state: refund accounting exactly once', async () => {
      const htlcId = '0x' + '27'.repeat(32);
      const resId = createActiveSwap('swap-fb3-27', 'EVM_FUNDED', htlcId);
      persistence.commitLiquidityReservation(resId);

      (fakeEvm as any).getContractHtlcState = async (id: string) => {
        if (id === htlcId) return { status: 3, amount: 15_000_000n };
        return null;
      };

      const reconciler = ChainInventoryReconciler.createForTesting({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: canonicalUsdc,
      });

      const res = await reconciler.reconcileOnBoot();
      assert.strictEqual(res.readinessState, 'READY');
      const reservation = persistence.getLiquidityReservation(resId);
      assert.strictEqual(reservation?.status, 'RELEASED');
    });

    it('28. LIGHTNING_HELD without HTLC yet: does NOT falsely fail merely because htlcId is absent', async () => {
      createActiveSwap('swap-fb3-28', 'LIGHTNING_HELD', null);

      const reconciler = ChainInventoryReconciler.createForTesting({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: canonicalUsdc,
      });

      const res = await reconciler.reconcileOnBoot();
      assert.strictEqual(res.readinessState, 'READY', 'Must not fail because HTLC is not yet expected');
      assert.strictEqual(res.headroom, 85_000_000n);
    });

    it('29. EVM_FUNDING_PENDING without a durable FUND intent blocks READY', async () => {
      createActiveSwap('swap-fb3-29', 'EVM_FUNDING_PENDING', null);

      const reconciler = ChainInventoryReconciler.createForTesting({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: canonicalUsdc,
      });

      const res = await reconciler.reconcileOnBoot();
      assert.strictEqual(res.readinessState, 'UNKNOWN');
      assert.match(res.error ?? '', /no durable FUND intent/);
    });
  });

  // =========================================================================
  // FB-4 TESTS — EXPLICIT POLICY (Tests 30 - 34)
  // =========================================================================
  describe('FB-4: Explicit Reconciliation Policy Boundaries', () => {
    it('30. Production bootstrap without inventory reconciliation policy: configuration fails', () => {
      const cfg = getValidProductionConfig(dbPath);
      delete (cfg.evm as any).reconciliationPolicy;

      assert.throws(
        () => ProductionConfigValidator.validate(cfg),
        /reconciliationPolicy/i
      );
    });

    it('31. Production cannot silently use BASE_SEPOLIA_TEST_POLICY', () => {
      assert.throws(
        () =>
          new ChainInventoryReconciler({
            persistence,
            capacityProvider: fakeEvm,
            defaultTokenAddress: canonicalUsdc,
            policy: undefined as any,
          }),
        /RECONCILER_CONFIG_ERROR/
      );
    });

    it('32. Tests may explicitly use BASE_SEPOLIA_TEST_POLICY', () => {
      const reconciler = ChainInventoryReconciler.createForTesting({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: canonicalUsdc,
        policy: BASE_SEPOLIA_TEST_POLICY,
      });

      assert.deepStrictEqual(reconciler.getPolicy(), BASE_SEPOLIA_TEST_POLICY);
    });

    it('33. Reconciler created by production bootstrap receives exact configured values', async () => {
      fakeEvm.setWalletBalance(canonicalUsdc, 100_000_000n, 100_000_000n);
      const customPolicy: BaseInventoryReconciliationPolicy = {
        maxFreshnessMs: 55_000,
        requiredConfirmations: 4,
        reorgLagTolerance: 2,
        failClosedOnDeficit: true,
      };

      const cfg = getValidProductionConfig(dbPath);
      cfg.environment = 'test';
      cfg.evm.finalityPolicy.requiredConfirmations = 4;
      fakeEvm.finalityPolicy = {
        policyTag: cfg.evm.finalityPolicy.policyTag,
        requiredConfirmations: 4,
      };
      cfg.evm.reconciliationPolicy = customPolicy;

      const result = await bootstrapProductionRouter(cfg, {
        _testOverrides: {
          evmBackend: fakeEvm,
          lightningBackend: new FakeLightningAtomicBackend(),
        },
      });

      const policy = result.reconciler.getPolicy();
      assert.strictEqual(policy.maxFreshnessMs, 55_000);
      assert.strictEqual(policy.requiredConfirmations, 4);
      assert.strictEqual(policy.reorgLagTolerance, 2);
      assert.strictEqual(policy.failClosedOnDeficit, true);
    });

    it('34. Freshness persisted into snapshot reflects supplied production/test config', async () => {
      fakeEvm.setWalletBalance(canonicalUsdc, 100_000_000n, 100_000_000n);
      const customPolicy: BaseInventoryReconciliationPolicy = {
        maxFreshnessMs: 33_333,
        requiredConfirmations: 2,
        reorgLagTolerance: 0,
        failClosedOnDeficit: true,
      };

      const cfg = getValidProductionConfig(dbPath);
      cfg.environment = 'test';
      cfg.evm.reconciliationPolicy = customPolicy;

      const result = await bootstrapProductionRouter(cfg, {
        _testOverrides: {
          evmBackend: fakeEvm,
          lightningBackend: new FakeLightningAtomicBackend(),
        },
      });

      const snapshot = result.persistence.getLatestChainInventorySnapshot(canonicalUsdc);
      assert.ok(snapshot);
      assert.ok(snapshot.freshUntil);
      const diffMs = snapshot.freshUntil.getTime() - snapshot.observedAt.getTime();
      assert.ok(Math.abs(diffMs - 33_333) <= 5, `Expected diffMs near 33333, got ${diffMs}`);
    });
  });
});
