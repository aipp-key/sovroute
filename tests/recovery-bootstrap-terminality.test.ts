import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqlitePersistence } from '../src/persistence/sqlite.ts';
import { AtomicCoordinator } from '../src/atomic/coordinator/coordinator.ts';
import { FakeEvmAtomicBackend } from '../src/atomic/evm/fake-backend.ts';
import { FakeLightningAtomicBackend } from '../src/atomic/lightning/fake-backend.ts';
import { SqliteLiquidityInventory } from '../src/atomic/liquidity/sqlite-inventory.ts';
import { ChainInventoryReconciler } from '../src/atomic/liquidity/chain-reconciler.ts';
import { LndLightningAtomicBackend } from '../src/atomic/lightning/lnd-backend.ts';
import {
  SovereignAtomicState,
  BASE_SEPOLIA_TEST_POLICY,
  type HoldInvoice,
  type HoldInvoiceState,
  type EvmHtlcState,
} from '../src/atomic/types.ts';
import {
  LndRestError,
  type ILndClient,
} from '../src/atomic/lightning/lnd-client.ts';
import { OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS } from '../src/atomic/evm/base-guard.ts';
import { bootstrapProductionRouter } from '../src/bootstrap.ts';

const token = OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS.toLowerCase();
const operator = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

class ConfigurableLightning extends FakeLightningAtomicBackend {
  public states = new Map<string, HoldInvoiceState>();

  setInvoiceState(hashLock: string, state: HoldInvoiceState) {
    this.states.set(hashLock.replace(/^0x/, '').toLowerCase(), state);
  }

  override async observeHoldInvoice(paymentHash: string): Promise<HoldInvoice> {
    const clean = paymentHash.replace(/^0x/, '').toLowerCase();
    const state = this.states.get(clean);
    if (!state) {
      return super.observeHoldInvoice(paymentHash);
    }
    return {
      paymentHash: clean,
      bolt11: `lnbc...${clean.slice(0, 8)}`,
      amountSats: 10_000n,
      cltvExpiryBlocks: 144,
      state,
      createdAt: new Date(),
      settledAt: state === 'SETTLED' ? new Date() : undefined,
      canceledAt: state === 'CANCELED' ? new Date() : undefined,
    };
  }

  override async getInvoiceState(paymentHash: string): Promise<HoldInvoiceState> {
    const clean = paymentHash.replace(/^0x/, '').toLowerCase();
    return this.states.get(clean) ?? super.getInvoiceState(paymentHash);
  }
}

class ConfigurableEvm extends FakeEvmAtomicBackend {
  private htlcStates = new Map<string, EvmHtlcState>();

  setHtlcState(swapKey: string, state: Partial<EvmHtlcState>) {
    this.htlcStates.set(swapKey, {
      swapKey,
      htlcId: `0x_mock_${swapKey}`,
      funded: false,
      completed: false,
      refunded: false,
      balance: 0n,
      timelock: 0,
      blockTimestamp: Math.floor(Date.now() / 1000),
      ...state,
    });
  }

  override async observeHtlc(swapKey: string): Promise<EvmHtlcState> {
    const overridden = this.htlcStates.get(swapKey);
    if (overridden) return overridden;
    return super.observeHtlc(swapKey);
  }

  override async getContractHtlcState(htlcId: string): Promise<{ status: number; amount: bigint } | null> {
    for (const [key, state] of this.htlcStates.entries()) {
      if (key === htlcId || `swap_${key}` === htlcId || htlcId.includes(key)) {
        if (state.completed) return { status: 2, amount: state.balance };
        if (state.refunded) return { status: 3, amount: state.balance };
        if (state.funded) return { status: 1, amount: state.balance };
        return { status: 0, amount: 0n };
      }
    }
    return super.getContractHtlcState(htlcId);
  }
}

function getValidBootstrapConfig(dbFilename: string) {
  return {
    environment: 'production' as const,
    databasePath: dbFilename,
    evm: {
      rpcUrl: 'http://127.0.0.1:8545',
      chainId: 84532,
      htlcAddress: '0x1111111111111111111111111111111111111111',
      usdcAddress: token,
      operationalPrivateKey: '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      finalityPolicy: {
        policyTag: 'BASE_SEPOLIA_TEST_POLICY',
        requiredConfirmations: 2,
        finalityStrategy: 'reorg_resistant_window' as const,
        deepReorgThreshold: 5,
        maxSafetyBudgetSeconds: 7200,
      },
      reconciliationPolicy: {
        maxFreshnessMs: 60_000,
        requiredConfirmations: 2,
        reorgLagTolerance: 1,
        failClosedOnDeficit: true,
      },
    },
    lightning: {
      host: '127.0.0.1',
      port: 18080,
      network: 'regtest' as const,
      macaroonHex: '0123456789abcdef',
      tlsCertHex: '0123456789abcdef',
    },
    safety: {
      leaseMs: 30_000,
      maxReconciliationRetries: 3,
      minRemainingBtcBlocks: 144,
    },
  };
}

describe('RECOVERY BOOTSTRAP & CROSS-RAIL TERMINALITY CLOSURE', () => {
  let dbPath: string;
  let persistence: SqlitePersistence;

  beforeEach(() => {
    dbPath = join(tmpdir(), `sovroute-recovery-term-${randomUUID()}.db`);
    persistence = new SqlitePersistence({ filename: dbPath, allowLegacyFallback: true });
  });

  afterEach(() => {
    try {
      persistence.close();
    } catch {}
    if (existsSync(dbPath)) rmSync(dbPath, { force: true });
  });

  // =========================================================================
  // SUITE 1: BLOCKER 1 — STARTUP RECOVERY BOOTSTRAP DEADLOCK CLOSURE
  // =========================================================================
  describe('Blocker 1: Startup Cross-Rail Recovery Bootstrap Deadlock Closure', () => {
    it('1.1: Bootstrap with unresolved RECOVERY_REQUIRED swap completes recovery wiring, keeps economic acceptance blocked fail-closed', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const executionId = 'exec-unresolved-1';
      const hashLock = '0x' + '11'.repeat(32);
      const reservation = persistence.reserveLiquidity(executionId, token, 20_000_000n, {
        allowLegacyFallback: true,
      });

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'idemp-1',
        hashLock,
        claimingAddress: operator,
        targetDestinationAddress: operator,
        amountSats: 10_000n,
        expectedUsdcAmount: 20_000_000n,
        state: SovereignAtomicState.RECOVERY_REQUIRED,
        recoveryRequired: true,
        reservationId: reservation.reservationId,
        reservedAmountUnits: 20_000_000n,
        reservationStatus: 'RESERVED',
        tokenAddress: token,
        refundAddress: operator,
        evmSwapKey: `swap_${executionId}`,
        cltvExpiryBlocks: 144,
        timelockSeconds: 3600,
        createdAt: new Date(),
        updatedAt: new Date(),
      }, 'test-fp-1');

      // Prepare fake backends with sufficient balance
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);
      const fakeLightning = new ConfigurableLightning();
      fakeLightning.setInvoiceState(hashLock, 'ACCEPTED'); // LND still held, cannot resolve yet

      const config = getValidBootstrapConfig(dbPath);
      config.environment = 'test' as any;

      // Bootstrap must succeed in constructing recovery coordinator (NO deadlock crash)
      const res = await bootstrapProductionRouter(config, {
        _testOverrides: {
          evmBackend: fakeEvm,
          lightningBackend: fakeLightning,
        },
      });

      assert.ok(res.coordinator, 'Coordinator must be constructed for recovery');
      assert.strictEqual(res.isProcessRecoveryReady, true, 'Process recovery machinery must be ready');
      assert.strictEqual(res.isEconomicAcceptanceReady, false, 'Economic acceptance must be blocked fail-closed');

      // Attempting to reserve liquidity for a new swap must be rejected fail-closed
      await assert.rejects(
        () => res.inventory.reserve(1_000_000n, token),
        /INVENTORY_NOT_READY|Operator inventory is NOT_READY/i
      );

      res.persistence.close();
    });

    it('1.2: Bootstrap with failed FUND intent runs recovery, resolves clean swap and enables economic readiness', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const executionId = 'exec-failed-fund-1';
      const hashLock = '0x' + '22'.repeat(32);
      const evmSwapKey = `swap_${executionId}`;
      const reservation = persistence.reserveLiquidity(executionId, token, 20_000_000n, {
        allowLegacyFallback: true,
      });

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'idemp-2',
        hashLock,
        claimingAddress: operator,
        targetDestinationAddress: operator,
        amountSats: 10_000n,
        expectedUsdcAmount: 20_000_000n,
        state: SovereignAtomicState.EVM_FUNDING_PENDING,
        recoveryRequired: false,
        reservationId: reservation.reservationId,
        reservedAmountUnits: 20_000_000n,
        reservationStatus: 'RESERVED',
        tokenAddress: token,
        refundAddress: operator,
        evmSwapKey,
        cltvExpiryBlocks: 144,
        timelockSeconds: 3600,
        createdAt: new Date(),
        updatedAt: new Date(),
      }, 'test-fp-2');

      // Failed FUND intent in SQLite
      const intent = persistence.getOrCreateEvmIntent({
        swapKey: evmSwapKey,
        chainId: 84532,
        signerAddress: operator as `0x${string}`,
        actionType: 'FUND',
        targetAddress: '0x1111111111111111111111111111111111111111',
        calldata: '0x',
      });
      persistence.markEvmIntentFailed(intent.id, 'EVM_CALL_EXCEPTION');

      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);
      const fakeLightning = new ConfigurableLightning();
      fakeLightning.setInvoiceState(hashLock, 'CANCELED');

      const config = getValidBootstrapConfig(dbPath);
      config.environment = 'test' as any;

      const res = await bootstrapProductionRouter(config, {
        _testOverrides: {
          evmBackend: fakeEvm,
          lightningBackend: fakeLightning,
        },
      });

      assert.strictEqual(res.isProcessRecoveryReady, true);
      assert.strictEqual(res.isEconomicAcceptanceReady, true, 'Clean recovery must transition inventory to READY');

      // Now new reservations succeed cleanly
      const newReservation = await res.inventory.reserve(5_000_000n, token);
      assert.strictEqual(newReservation.reserved, true);

      res.persistence.close();
    });
  });

  // =========================================================================
  // SUITE 2: BLOCKER 2 — CROSS-RAIL TERMINALITY MATRIX IN reconcileSwap()
  // =========================================================================
  describe('Blocker 2: Cross-Rail Terminality Matrix in reconcileSwap()', () => {
    function setupCoordinator(lightning: ConfigurableLightning, evm: ConfigurableEvm) {
      const reconciler = new ChainInventoryReconciler({
        persistence,
        capacityProvider: evm,
        defaultTokenAddress: token,
        expectedChainId: 84532,
        policy: BASE_SEPOLIA_TEST_POLICY,
      });
      const inventory = new SqliteLiquidityInventory(persistence, { reconciler });
      const coordinator = new AtomicCoordinator(lightning, evm, inventory, {
        persistence,
        finalityPolicy: evm.finalityPolicy,
      });
      return { coordinator, inventory, reconciler };
    }

    it('2.1: Case A — Lightning SETTLED + Base CLAIMED transitions to COMPLETED', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const fakeLightning = new ConfigurableLightning();
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);
      const { coordinator } = setupCoordinator(fakeLightning, fakeEvm);

      const executionId = 'case-a-exec';
      const hashLock = '0x' + 'aa'.repeat(32);
      const evmSwapKey = `swap_${executionId}`;

      const reservation = persistence.reserveLiquidity(executionId, token, 20_000_000n, {
        allowLegacyFallback: true,
      });

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'case-a',
        hashLock,
        claimingAddress: operator,
        targetDestinationAddress: operator,
        amountSats: 10_000n,
        expectedUsdcAmount: 20_000_000n,
        state: SovereignAtomicState.LIGHTNING_SETTLEMENT_PENDING,
        reservationId: reservation.reservationId,
        reservedAmountUnits: 20_000_000n,
        reservationStatus: 'RESERVED',
        tokenAddress: token,
        refundAddress: operator,
        evmSwapKey,
        cltvExpiryBlocks: 144,
        timelockSeconds: 3600,
        createdAt: new Date(),
        updatedAt: new Date(),
      }, 'test-fp-a');

      // External truth: LN settled, Base completed (claimed)
      fakeLightning.setInvoiceState(hashLock, 'SETTLED');
      fakeEvm.setHtlcState(evmSwapKey, {
        funded: true,
        completed: true,
        refunded: false,
        balance: 20_000_000n,
        timelock: Math.floor(Date.now() / 1000) + 3600,
        blockTimestamp: Math.floor(Date.now() / 1000),
      });

      const reconciled = await coordinator.reconcileSwap(executionId);
      assert.strictEqual(reconciled.state, SovereignAtomicState.COMPLETED);
      assert.strictEqual(reconciled.recoveryRequired, false);
      assert.strictEqual(reconciled.reservationStatus, 'SETTLED');
    });

    it('2.2: Case B — Lightning SETTLED + Base LOCKED/FUNDED transitions to RECOVERY_REQUIRED (never COMPLETED)', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const fakeLightning = new ConfigurableLightning();
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);
      const { coordinator } = setupCoordinator(fakeLightning, fakeEvm);

      const executionId = 'case-b-exec';
      const hashLock = '0x' + 'bb'.repeat(32);
      const evmSwapKey = `swap_${executionId}`;

      const reservation = persistence.reserveLiquidity(executionId, token, 20_000_000n, {
        allowLegacyFallback: true,
      });

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'case-b',
        hashLock,
        claimingAddress: operator,
        targetDestinationAddress: operator,
        amountSats: 10_000n,
        expectedUsdcAmount: 20_000_000n,
        state: SovereignAtomicState.EVM_FUNDED,
        reservationId: reservation.reservationId,
        reservedAmountUnits: 20_000_000n,
        reservationStatus: 'COMMITTED',
        tokenAddress: token,
        refundAddress: operator,
        evmSwapKey,
        cltvExpiryBlocks: 144,
        timelockSeconds: 3600,
        createdAt: new Date(),
        updatedAt: new Date(),
      }, 'test-fp-b');

      // External truth: LN settled, but Base HTLC is still locked (funded, not completed)
      fakeLightning.setInvoiceState(hashLock, 'SETTLED');
      fakeEvm.setHtlcState(evmSwapKey, {
        funded: true,
        completed: false,
        refunded: false,
        balance: 20_000_000n,
        timelock: Math.floor(Date.now() / 1000) + 3600,
        blockTimestamp: Math.floor(Date.now() / 1000),
      });

      const reconciled = await coordinator.reconcileSwap(executionId);
      assert.strictEqual(reconciled.state, SovereignAtomicState.RECOVERY_REQUIRED);
      assert.strictEqual(reconciled.recoveryRequired, true);
      assert.match(reconciled.failureReason!, /Lightning is SETTLED but Base HTLC remains LOCKED\/FUNDED/);
    });

    it('2.3: Case C — Lightning SETTLED + Base NOT_FUNDED_PROVEN marks RECOVERY_REQUIRED invariant violation', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const fakeLightning = new ConfigurableLightning();
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);
      const { coordinator } = setupCoordinator(fakeLightning, fakeEvm);

      const executionId = 'case-c-exec';
      const hashLock = '0x' + 'cc'.repeat(32);
      const evmSwapKey = `swap_${executionId}`;

      const reservation = persistence.reserveLiquidity(executionId, token, 20_000_000n, {
        allowLegacyFallback: true,
      });

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'case-c',
        hashLock,
        claimingAddress: operator,
        targetDestinationAddress: operator,
        amountSats: 10_000n,
        expectedUsdcAmount: 20_000_000n,
        state: SovereignAtomicState.EVM_FUNDING_PENDING,
        reservationId: reservation.reservationId,
        reservedAmountUnits: 20_000_000n,
        reservationStatus: 'RESERVED',
        tokenAddress: token,
        refundAddress: operator,
        evmSwapKey,
        cltvExpiryBlocks: 144,
        timelockSeconds: 3600,
        createdAt: new Date(),
        updatedAt: new Date(),
      }, 'test-fp-c');

      // LN settled, but Base HTLC does not exist and has a failed intent
      fakeLightning.setInvoiceState(hashLock, 'SETTLED');
      fakeEvm.setHtlcState(evmSwapKey, {
        funded: false,
        completed: false,
        refunded: false,
        balance: 0n,
        timelock: 0,
        blockTimestamp: Math.floor(Date.now() / 1000),
      });
      const intent = persistence.getOrCreateEvmIntent({
        swapKey: evmSwapKey,
        chainId: 84532,
        signerAddress: operator as `0x${string}`,
        actionType: 'FUND',
        targetAddress: '0x1111111111111111111111111111111111111111',
        calldata: '0x',
      });
      persistence.markEvmIntentFailed(intent.id, 'EVM_CALL_EXCEPTION');

      const reconciled = await coordinator.reconcileSwap(executionId);
      assert.strictEqual(reconciled.state, SovereignAtomicState.RECOVERY_REQUIRED);
      assert.strictEqual(reconciled.recoveryRequired, true);
      assert.match(reconciled.failureReason!, /CRITICAL_INVARIANT_VIOLATION.*proven NOT_FUNDED/);
    });

    it('2.4: Case D — Lightning SETTLED + Base REFUNDED marks RECOVERY_REQUIRED invariant violation', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const fakeLightning = new ConfigurableLightning();
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);
      const { coordinator } = setupCoordinator(fakeLightning, fakeEvm);

      const executionId = 'case-d-exec';
      const hashLock = '0x' + 'dd'.repeat(32);
      const evmSwapKey = `swap_${executionId}`;

      const reservation = persistence.reserveLiquidity(executionId, token, 20_000_000n, {
        allowLegacyFallback: true,
      });

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'case-d',
        hashLock,
        claimingAddress: operator,
        targetDestinationAddress: operator,
        amountSats: 10_000n,
        expectedUsdcAmount: 20_000_000n,
        state: SovereignAtomicState.EVM_REFUND_CONFIRMED,
        reservationId: reservation.reservationId,
        reservedAmountUnits: 20_000_000n,
        reservationStatus: 'COMMITTED',
        tokenAddress: token,
        refundAddress: operator,
        evmSwapKey,
        cltvExpiryBlocks: 144,
        timelockSeconds: 3600,
        createdAt: new Date(),
        updatedAt: new Date(),
      }, 'test-fp-d');

      fakeLightning.setInvoiceState(hashLock, 'SETTLED');
      fakeEvm.setHtlcState(evmSwapKey, {
        funded: true,
        completed: false,
        refunded: true,
        balance: 20_000_000n,
        timelock: Math.floor(Date.now() / 1000) - 10,
        blockTimestamp: Math.floor(Date.now() / 1000),
      });

      const reconciled = await coordinator.reconcileSwap(executionId);
      assert.strictEqual(reconciled.state, SovereignAtomicState.RECOVERY_REQUIRED);
      assert.strictEqual(reconciled.recoveryRequired, true);
      assert.match(reconciled.failureReason!, /CRITICAL_INVARIANT_VIOLATION.*Base HTLC is REFUNDED/);
    });

    it('2.5: Case F — Base CLAIMED + Lightning CANCELED marks RECOVERY_REQUIRED invariant violation', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const fakeLightning = new ConfigurableLightning();
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);
      const { coordinator } = setupCoordinator(fakeLightning, fakeEvm);

      const executionId = 'case-f-exec';
      const hashLock = '0x' + 'ff'.repeat(32);
      const evmSwapKey = `swap_${executionId}`;

      const reservation = persistence.reserveLiquidity(executionId, token, 20_000_000n, {
        allowLegacyFallback: true,
      });

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'case-f',
        hashLock,
        claimingAddress: operator,
        targetDestinationAddress: operator,
        amountSats: 10_000n,
        expectedUsdcAmount: 20_000_000n,
        state: SovereignAtomicState.EVM_CLAIM_CONFIRMED,
        reservationId: reservation.reservationId,
        reservedAmountUnits: 20_000_000n,
        reservationStatus: 'COMMITTED',
        tokenAddress: token,
        refundAddress: operator,
        evmSwapKey,
        cltvExpiryBlocks: 144,
        timelockSeconds: 3600,
        createdAt: new Date(),
        updatedAt: new Date(),
      }, 'test-fp-f');

      fakeLightning.setInvoiceState(hashLock, 'CANCELED');
      fakeEvm.setHtlcState(evmSwapKey, {
        funded: true,
        completed: true,
        refunded: false,
        balance: 20_000_000n,
        timelock: Math.floor(Date.now() / 1000) + 3600,
        blockTimestamp: Math.floor(Date.now() / 1000),
      });

      const reconciled = await coordinator.reconcileSwap(executionId);
      assert.strictEqual(reconciled.state, SovereignAtomicState.RECOVERY_REQUIRED);
      assert.strictEqual(reconciled.recoveryRequired, true);
      assert.match(reconciled.failureReason!, /CRITICAL_INVARIANT_VIOLATION.*CLAIMED.*CANCELED/);
    });

    it('2.6: Case G — Base FUNDED/LOCKED + Lightning CANCELED marks RECOVERY_REQUIRED and retains reservation', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const fakeLightning = new ConfigurableLightning();
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);
      const { coordinator } = setupCoordinator(fakeLightning, fakeEvm);

      const executionId = 'case-g-exec';
      const hashLock = '0x' + '55'.repeat(32);
      const evmSwapKey = `swap_${executionId}`;

      const reservation = persistence.reserveLiquidity(executionId, token, 20_000_000n, {
        allowLegacyFallback: true,
      });

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'case-g',
        hashLock,
        claimingAddress: operator,
        targetDestinationAddress: operator,
        amountSats: 10_000n,
        expectedUsdcAmount: 20_000_000n,
        state: SovereignAtomicState.EVM_FUNDED,
        reservationId: reservation.reservationId,
        reservedAmountUnits: 20_000_000n,
        reservationStatus: 'COMMITTED',
        tokenAddress: token,
        refundAddress: operator,
        evmSwapKey,
        cltvExpiryBlocks: 144,
        timelockSeconds: 3600,
        createdAt: new Date(),
        updatedAt: new Date(),
      }, 'test-fp-g');

      fakeLightning.setInvoiceState(hashLock, 'CANCELED');
      fakeEvm.setHtlcState(evmSwapKey, {
        funded: true,
        completed: false,
        refunded: false,
        balance: 20_000_000n,
        timelock: Math.floor(Date.now() / 1000) + 3600,
        blockTimestamp: Math.floor(Date.now() / 1000),
      });

      const reconciled = await coordinator.reconcileSwap(executionId);
      assert.strictEqual(reconciled.state, SovereignAtomicState.RECOVERY_REQUIRED);
      assert.strictEqual(reconciled.recoveryRequired, true);
      assert.strictEqual(reconciled.reservationStatus, 'COMMITTED');
      assert.match(reconciled.failureReason!, /CRITICAL_INVARIANT_VIOLATION.*Base HTLC is FUNDED.*reservation retained/);
    });
  });

  // =========================================================================
  // SUITE 3: SEMANTIC CLEANUP 3 — LndLightningAtomicBackend.recoverAfterRestart()
  // =========================================================================
  describe('Semantic Cleanup 3: LndLightningAtomicBackend.recoverAfterRestart()', () => {
    function mockLndClient(lookupFn: (hash: string) => Promise<any>): ILndClient {
      return {
        getInfo: async () => ({ block_height: 100 } as any),
        addHoldInvoice: async () => ({ payment_request: 'lnbc...' } as any),
        lookupInvoice: lookupFn,
        settleInvoice: async () => {},
        cancelInvoice: async () => {},
      };
    }

    it('3.1: Returns null ONLY on typed LightningInvoiceNotFoundError (404)', async () => {
      const client = mockLndClient(async (_hash) => {
        throw new LndRestError(404, 'Invoice not found', '{"error":"not found"}');
      });
      const backend = new LndLightningAtomicBackend(client);

      const result = await backend.recoverAfterRestart('0x' + '12'.repeat(32));
      assert.strictEqual(result, null, 'Must return null for 404 absence');
    });

    it('3.2: Propagates transport / network ECONNREFUSED error (never returns null)', async () => {
      const client = mockLndClient(async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:18080');
      });
      const backend = new LndLightningAtomicBackend(client);

      await assert.rejects(
        () => backend.recoverAfterRestart('0x' + '34'.repeat(32)),
        /ECONNREFUSED/
      );
    });

    it('3.3: Propagates timeout / aborted error (never returns null)', async () => {
      const client = mockLndClient(async () => {
        throw new Error('The operation was aborted due to timeout');
      });
      const backend = new LndLightningAtomicBackend(client);

      await assert.rejects(
        () => backend.recoverAfterRestart('0x' + '56'.repeat(32)),
        /timeout/
      );
    });

    it('3.4: Propagates authentication 401 macaroon error (never returns null)', async () => {
      const client = mockLndClient(async () => {
        throw new LndRestError(401, 'Permission denied', '{"error":"permission denied"}');
      });
      const backend = new LndLightningAtomicBackend(client);

      await assert.rejects(
        () => backend.recoverAfterRestart('0x' + '78'.repeat(32)),
        (err: any) => err instanceof LndRestError && err.statusCode === 401
      );
    });

    it('3.5: Returns mapped HoldInvoice when invoice exists', async () => {
      const paymentHash = '99'.repeat(32);
      const client = mockLndClient(async () => ({
        r_hash: paymentHash,
        value: '5000',
        settled: false,
        state: 'ACCEPTED',
        creation_date: '1700000000',
        cltv_expiry: '144',
      }));
      const backend = new LndLightningAtomicBackend(client);

      const res = await backend.recoverAfterRestart('0x' + paymentHash);
      assert.ok(res);
      assert.strictEqual(res.paymentHash, paymentHash);
      assert.strictEqual(res.state, 'ACCEPTED');
      assert.strictEqual(res.amountSats, 5000n);
    });
  });
});
