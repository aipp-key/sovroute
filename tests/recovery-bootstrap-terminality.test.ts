import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync, readFileSync } from 'node:fs';
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
  LiquidityDeficitError,
  InventoryNotReadyError,
  LightningInvoiceNotFoundError,
  type HoldInvoice,
  type HoldInvoiceState,
  type EvmHtlcState,
} from '../src/atomic/types.ts';
import {
  LndRestError,
  type ILndClient,
} from '../src/atomic/lightning/lnd-client.ts';
import { OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS, BASE_SEPOLIA_CHAIN_ID } from '../src/atomic/evm/base-guard.ts';
import { BaseSepoliaAtomicBackend } from '../src/atomic/evm/base-sepolia-backend.ts';
import {
  bootstrapProductionRouter,
  bootstrapProductionRouterForTesting,
} from '../src/bootstrap.ts';

const token = OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS.toLowerCase();
const operator = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

class ConfigurableLightning extends FakeLightningAtomicBackend {
  public states = new Map<string, HoldInvoiceState>();
  public cancelCalls: string[] = [];
  public cancelError: Error | null = null;
  public settleError: Error | null = null;
  public observeError: Error | null = null;
  public createCalls: string[] = [];

  setInvoiceState(hashLock: string, state: HoldInvoiceState) {
    this.states.set(hashLock.replace(/^0x/, '').toLowerCase(), state);
  }

  override async createHoldInvoice(
    hashLock: string,
    amountSats: bigint,
    cltvExpiryBlocks: number,
    memo?: string
  ): Promise<HoldInvoice> {
    this.createCalls.push(hashLock);
    return super.createHoldInvoice(hashLock, amountSats, cltvExpiryBlocks, memo);
  }

  override async settleHoldInvoice(preimage: string): Promise<{ settled: boolean; settledAt: Date }> {
    if (this.settleError) {
      throw this.settleError;
    }
    return super.settleHoldInvoice(preimage);
  }

  override async cancelHoldInvoice(paymentHash: string): Promise<{ canceled: boolean; canceledAt: Date }> {
    const clean = paymentHash.replace(/^0x/, '').toLowerCase();
    this.cancelCalls.push(clean);
    if (this.cancelError) {
      throw this.cancelError;
    }
    this.states.set(clean, 'CANCELED');
    return { canceled: true, canceledAt: new Date() };
  }

  override async observeHoldInvoice(paymentHash: string): Promise<HoldInvoice> {
    if (this.observeError) {
      throw this.observeError;
    }
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
      expiryHeight: 800000 + 200,
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
  public fundError: Error | null = null;
  public refundError: Error | null = null;
  public observeError: Error | null = null;

  override async fundHtlc(params: any): Promise<{ txHash: string; blockNumber: number; htlcId?: string }> {
    if (this.fundError) {
      throw this.fundError;
    }
    return super.fundHtlc(params);
  }

  override async refundHtlc(swapKey: string): Promise<{ txHash: string; blockNumber: number; refunded: boolean }> {
    if (this.refundError) {
      throw this.refundError;
    }
    return super.refundHtlc(swapKey);
  }

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
    if (this.observeError) {
      throw this.observeError;
    }
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
      chainId: BASE_SEPOLIA_CHAIN_ID,
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

const pinnedHtlcBytecode = JSON.parse(
  readFileSync(join(process.cwd(), 'artifacts', 'contracts', 'HtlcErc20.sol', 'HtlcErc20.json'), 'utf8')
).deployedBytecode as string;

function createMockBasePublicClient(
  operatorBalanceUnits: bigint = 100_000_000n,
  htlcStateOverrides?: any
) {
  let broadcastCount = 0;
  return {
    getBroadcastCount: () => broadcastCount,
    getChainId: async () => BASE_SEPOLIA_CHAIN_ID,
    getBlockNumber: async () => 1000n,
    getBlock: async () => ({
      number: 1000n,
      hash: '0x' + 'aa'.repeat(32),
      timestamp: 1700000000n,
    }),
    getBalance: async () => 1_000_000_000_000_000_000n,
    getCode: async () => '0x' + '12'.repeat(100),
    getBytecode: async () => pinnedHtlcBytecode,
    readContract: async (args: any) => {
      if (args.functionName === 'decimals') {
        return 6;
      }
      if (args.functionName === 'balanceOf') {
        return operatorBalanceUnits;
      }
      if (args.functionName === 'getHtlc') {
        const overrides = htlcStateOverrides;
        if (overrides) {
          const status = overrides.status ?? (overrides.completed ? 2 : overrides.refunded ? 3 : overrides.funded ? 1 : 0);
          return {
            status,
            amount: overrides.amount ?? 0n,
            funded: status === 1 || status === 2 || status === 3,
            completed: status === 2,
            refunded: status === 3,
            timelock: overrides.timelock ?? 0n,
            ...overrides,
          };
        }
        return {
          status: 0,
          amount: 0n,
          funded: false,
          completed: false,
          refunded: false,
          timelock: 0n,
        };
      }
      return 0n;
    },
    getTransactionReceipt: async () => null,
    sendRawTransaction: async () => {
      broadcastCount++;
      return '0x' + '99'.repeat(32);
    },
  };
}

function createMockLndClient(overrides?: Partial<ILndClient>): ILndClient {
  return {
    getInfo: async () => ({
      block_height: 1000,
      identity_pubkey: '02' + '00'.repeat(32),
      uris: ['node@127.0.0.1:9735'],
      chains: [{ chain: 'bitcoin', network: 'regtest' }],
    } as any),
    addHoldInvoice: async () => ({ payment_request: 'lnbcrt100u...' } as any),
    lookupInvoice: async () => ({ state: 'ACCEPTED', value: '1000' } as any),
    settleInvoice: async () => {},
    cancelInvoice: async () => {},
    ...overrides,
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

    it('1.3: Recovery swap + DEFICIT constructs coordinator, recovery ready = true, economic acceptance = false', async () => {
      persistence.setConfirmedOperatorBalance(token, 0n);
      const executionId = 'exec-deficit-rec';
      const hashLock = '0x' + '33'.repeat(32);
      const reservation = persistence.reserveLiquidity(executionId, token, 20_000_000n, {
        allowLegacyFallback: true,
      });

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'idemp-deficit-1',
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
      }, 'test-fp-deficit');

      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 0n);
      const fakeLightning = new ConfigurableLightning();
      fakeLightning.setInvoiceState(hashLock, 'ACCEPTED');

      const config = getValidBootstrapConfig(dbPath);
      config.environment = 'test' as any;

      const res = await bootstrapProductionRouter(config, {
        _testOverrides: {
          evmBackend: fakeEvm,
          lightningBackend: fakeLightning,
        },
      });

      assert.ok(res.coordinator, 'Coordinator must exist for recovery even under DEFICIT');
      assert.strictEqual(res.isProcessRecoveryReady, true, 'Process recovery ready must be true');
      assert.strictEqual(res.isEconomicAcceptanceReady, false, 'Economic acceptance must be false during DEFICIT');

      // prepareSwap rejected fail-closed
      const startResCount = persistence.listLiquidityReservations().length;
      await assert.rejects(
        () => res.coordinator.prepareSwap({
          idempotencyKey: 'new-swap-deficit',
          hashLock: '0x' + '99'.repeat(32),
          amountSats: 5000n,
          expectedUsdcAmount: 5_000_000n,
          claimingAddress: operator,
          targetDestinationAddress: operator,
        }),
        (err: any) => err instanceof LiquidityDeficitError || err instanceof InventoryNotReadyError
      );

      // Zero new reservation created
      assert.strictEqual(persistence.listLiquidityReservations().length, startResCount, 'Zero new reservations allowed');

      // Zero new Lightning invoice created
      assert.strictEqual(fakeLightning.createCalls.length, 0, 'Zero new Lightning invoices allowed');

      res.persistence.close();
    });

    it('1.4: Recovery resolves but wallet still DEFICIT keeps economic acceptance false', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const executionId = 'exec-deficit-resolve';
      const hashLock = '0x' + '34'.repeat(32);
      const evmSwapKey = `swap_${executionId}`;
      const reservation = persistence.reserveLiquidity(executionId, token, 20_000_000n, {
        allowLegacyFallback: true,
      });

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'idemp-deficit-res-1',
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
      }, 'test-fp-def-res');

      const intent = persistence.getOrCreateEvmIntent({
        swapKey: evmSwapKey,
        chainId: BASE_SEPOLIA_CHAIN_ID,
        signerAddress: operator as `0x${string}`,
        actionType: 'FUND',
        targetAddress: '0x1111111111111111111111111111111111111111',
        calldata: '0x',
      });
      persistence.markEvmIntentFailed(intent.id, 'EVM_CALL_EXCEPTION');

      // Unrelated active reservation on wallet creates an ongoing obligation of 10 USDC
      persistence.reserveLiquidity('unrelated-active-reserve', token, 10_000_000n, {
        allowLegacyFallback: true,
      });

      // Wallet onchain balance is 0 (below obligations 10 USDC -> DEFICIT)
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 0n);
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

      // Recovery resolved the swap, but onchain wallet has 0 balance and ongoing obligation -> remains in DEFICIT
      assert.strictEqual(res.isProcessRecoveryReady, true);
      assert.strictEqual(res.isEconomicAcceptanceReady, false, 'Economic acceptance must remain false if wallet still lacks funds');

      res.persistence.close();
    });

    it('1.5: Zero recovery swaps + DEFICIT aborts bootstrap fail-closed immediately', async () => {
      persistence.setConfirmedOperatorBalance(token, 50_000_000n);
      // Active reservation with 0 onchain balance creates a DEFICIT
      persistence.reserveLiquidity('orphan-reserve', token, 10_000_000n, {
        allowLegacyFallback: true,
      });
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 0n); // Onchain capacity is 0, below active reservation 10M
      const fakeLightning = new ConfigurableLightning();

      const config = getValidBootstrapConfig(dbPath);
      config.environment = 'test' as any;

      await assert.rejects(
        () => bootstrapProductionRouter(config, {
          _testOverrides: {
            evmBackend: fakeEvm,
            lightningBackend: fakeLightning,
          },
        }),
        /INVENTORY_BOOT_RECONCILIATION_FAILED: Inventory readiness state is DEFICIT/
      );
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

    it('2.7: Base REFUNDED + LN OPEN cancels Lightning and transitions to REFUNDED only after authoritative cancellation', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const fakeLightning = new ConfigurableLightning();
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);
      const { coordinator } = setupCoordinator(fakeLightning, fakeEvm);

      const executionId = 'ref-ln-open-exec';
      const hashLock = '0x' + '71'.repeat(32);
      const evmSwapKey = `swap_${executionId}`;

      const reservation = persistence.reserveLiquidity(executionId, token, 20_000_000n, {
        allowLegacyFallback: true,
      });

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'ref-ln-open',
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
      }, 'test-fp-ref-open');

      fakeLightning.setInvoiceState(hashLock, 'OPEN');
      fakeEvm.setHtlcState(evmSwapKey, {
        funded: true,
        completed: false,
        refunded: true,
        balance: 20_000_000n,
        timelock: Math.floor(Date.now() / 1000) - 10,
        blockTimestamp: Math.floor(Date.now() / 1000),
      });

      const cleanHash = hashLock.replace(/^0x/, '').toLowerCase();
      const reconciled = await coordinator.reconcileSwap(executionId);

      assert.ok(fakeLightning.cancelCalls.includes(cleanHash), 'cancelHoldInvoice must have been called on LND');
      assert.strictEqual(reconciled.state, SovereignAtomicState.REFUNDED);
      assert.strictEqual(reconciled.reservationStatus, 'RELEASED');
      assert.strictEqual(reconciled.holdInvoice?.state, 'CANCELED');
      assert.strictEqual(reconciled.recoveryRequired, false);
    });

    it('2.8: Base REFUNDED + LN OPEN + cancel timeout marks RECOVERY_REQUIRED, retains reservation, no forged CANCELED', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const fakeLightning = new ConfigurableLightning();
      fakeLightning.cancelError = new Error('The operation was aborted due to timeout');
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);
      const { coordinator } = setupCoordinator(fakeLightning, fakeEvm);

      const executionId = 'ref-ln-open-timeout-exec';
      const hashLock = '0x' + '72'.repeat(32);
      const evmSwapKey = `swap_${executionId}`;

      const reservation = persistence.reserveLiquidity(executionId, token, 20_000_000n, {
        allowLegacyFallback: true,
      });

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'ref-ln-open-timeout',
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
      }, 'test-fp-ref-timeout');

      fakeLightning.setInvoiceState(hashLock, 'OPEN');
      fakeEvm.setHtlcState(evmSwapKey, {
        funded: true,
        completed: false,
        refunded: true,
        balance: 20_000_000n,
        timelock: Math.floor(Date.now() / 1000) - 10,
        blockTimestamp: Math.floor(Date.now() / 1000),
      });

      const reconciled = await coordinator.reconcileSwap(executionId);

      assert.notStrictEqual(reconciled.state, SovereignAtomicState.REFUNDED);
      assert.strictEqual(reconciled.recoveryRequired, true);
      assert.strictEqual(reconciled.reservationStatus, 'COMMITTED', 'Reservation must remain committed');
      assert.notStrictEqual(reconciled.holdInvoice?.state, 'CANCELED', 'Local state must not be forged to CANCELED');
      assert.match(reconciled.failureReason!, /LIGHTNING_CANCEL_AMBIGUOUS|cancellation could not be authoritatively confirmed/);
    });

    it('2.9: Base REFUNDED + LN ACCEPTED + cancel timeout marks RECOVERY_REQUIRED and retains reservation', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const fakeLightning = new ConfigurableLightning();
      fakeLightning.cancelError = new Error('connect ECONNREFUSED 127.0.0.1:18080');
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);
      const { coordinator } = setupCoordinator(fakeLightning, fakeEvm);

      const executionId = 'ref-ln-accepted-timeout-exec';
      const hashLock = '0x' + '73'.repeat(32);
      const evmSwapKey = `swap_${executionId}`;

      const reservation = persistence.reserveLiquidity(executionId, token, 20_000_000n, {
        allowLegacyFallback: true,
      });

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'ref-ln-accepted-timeout',
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
      }, 'test-fp-ref-acc-timeout');

      fakeLightning.setInvoiceState(hashLock, 'ACCEPTED');
      fakeEvm.setHtlcState(evmSwapKey, {
        funded: true,
        completed: false,
        refunded: true,
        balance: 20_000_000n,
        timelock: Math.floor(Date.now() / 1000) - 10,
        blockTimestamp: Math.floor(Date.now() / 1000),
      });

      const reconciled = await coordinator.reconcileSwap(executionId);
      assert.notStrictEqual(reconciled.state, SovereignAtomicState.REFUNDED);
      assert.strictEqual(reconciled.recoveryRequired, true);
      assert.strictEqual(reconciled.reservationStatus, 'COMMITTED');
    });

    it('2.10: Base CLAIMED + LN OPEN marks RECOVERY_REQUIRED (never COMPLETED)', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const fakeLightning = new ConfigurableLightning();
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);
      const { coordinator } = setupCoordinator(fakeLightning, fakeEvm);

      const executionId = 'claimed-ln-open-exec';
      const hashLock = '0x' + '74'.repeat(32);
      const evmSwapKey = `swap_${executionId}`;

      const reservation = persistence.reserveLiquidity(executionId, token, 20_000_000n, {
        allowLegacyFallback: true,
      });

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'claimed-ln-open',
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
      }, 'test-fp-claimed-open');

      fakeLightning.setInvoiceState(hashLock, 'OPEN');
      fakeEvm.setHtlcState(evmSwapKey, {
        funded: true,
        completed: true,
        refunded: false,
        balance: 20_000_000n,
        timelock: Math.floor(Date.now() / 1000) + 3600,
        blockTimestamp: Math.floor(Date.now() / 1000),
      });

      const reconciled = await coordinator.reconcileSwap(executionId);
      assert.notStrictEqual(reconciled.state, SovereignAtomicState.COMPLETED);
      assert.strictEqual(reconciled.recoveryRequired, true);
      assert.match(reconciled.failureReason!, /CRITICAL_INVARIANT_VIOLATION.*Base HTLC is CLAIMED but Lightning invoice is OPEN/);
    });

    it('2.11: Base FUNDED + LN OPEN marks RECOVERY_REQUIRED (reservation remains COMMITTED)', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const fakeLightning = new ConfigurableLightning();
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);
      const { coordinator } = setupCoordinator(fakeLightning, fakeEvm);

      const executionId = 'funded-ln-open-exec';
      const hashLock = '0x' + '75'.repeat(32);
      const evmSwapKey = `swap_${executionId}`;

      const reservation = persistence.reserveLiquidity(executionId, token, 20_000_000n, {
        allowLegacyFallback: true,
      });

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'funded-ln-open',
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
      }, 'test-fp-funded-open');

      fakeLightning.setInvoiceState(hashLock, 'OPEN');
      fakeEvm.setHtlcState(evmSwapKey, {
        funded: true,
        completed: false,
        refunded: false,
        balance: 20_000_000n,
        timelock: Math.floor(Date.now() / 1000) + 3600,
        blockTimestamp: Math.floor(Date.now() / 1000),
      });

      const reconciled = await coordinator.reconcileSwap(executionId);
      assert.notStrictEqual(reconciled.state, SovereignAtomicState.EVM_FUNDED);
      assert.strictEqual(reconciled.recoveryRequired, true);
      assert.strictEqual(reconciled.reservationStatus, 'COMMITTED');
      assert.match(reconciled.failureReason!, /CRITICAL_INVARIANT_VIOLATION.*Base HTLC is FUNDED but Lightning invoice is OPEN.*reservation retained/);
    });

    it('2.12: Base CLAIMED + LN NOT_FOUND marks RECOVERY_REQUIRED', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const fakeLightning = new ConfigurableLightning();
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);
      const { coordinator } = setupCoordinator(fakeLightning, fakeEvm);

      const executionId = 'claimed-not-found-exec';
      const hashLock = '0x' + '76'.repeat(32);
      const evmSwapKey = `swap_${executionId}`;

      const reservation = persistence.reserveLiquidity(executionId, token, 20_000_000n, {
        allowLegacyFallback: true,
      });

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'claimed-not-found',
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
      }, 'test-fp-claimed-not-found');

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
      assert.match(reconciled.failureReason!, /CRITICAL_INVARIANT_VIOLATION.*CLAIMED.*NOT_FOUND/);
    });

    it('2.13: Base FUNDED + LN NOT_FOUND marks RECOVERY_REQUIRED and retains reservation', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const fakeLightning = new ConfigurableLightning();
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);
      const { coordinator } = setupCoordinator(fakeLightning, fakeEvm);

      const executionId = 'funded-not-found-exec';
      const hashLock = '0x' + '77'.repeat(32);
      const evmSwapKey = `swap_${executionId}`;

      const reservation = persistence.reserveLiquidity(executionId, token, 20_000_000n, {
        allowLegacyFallback: true,
      });

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'funded-not-found',
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
      }, 'test-fp-funded-not-found');

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
      assert.match(reconciled.failureReason!, /CRITICAL_INVARIANT_VIOLATION.*Base HTLC is FUNDED.*NOT_FOUND.*reservation retained/);
    });

    it('2.14: UNKNOWN observations never lead to terminal success', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const fakeLightning = new ConfigurableLightning();
      const fakeEvm = new ConfigurableEvm();
      const { coordinator } = setupCoordinator(fakeLightning, fakeEvm);

      const executionId = 'unknown-obs-exec';
      const hashLock = '0x' + '78'.repeat(32);
      const evmSwapKey = `swap_${executionId}`;

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'unknown-obs',
        hashLock,
        claimingAddress: operator,
        targetDestinationAddress: operator,
        amountSats: 10_000n,
        expectedUsdcAmount: 20_000_000n,
        state: SovereignAtomicState.LIGHTNING_SETTLEMENT_PENDING,
        tokenAddress: token,
        refundAddress: operator,
        evmSwapKey,
        cltvExpiryBlocks: 144,
        timelockSeconds: 3600,
        createdAt: new Date(),
        updatedAt: new Date(),
      }, 'test-fp-unknown');

      fakeEvm.observeHtlc = async () => { throw new Error('RPC_DISCONNECTED'); };

      const reconciled = await coordinator.reconcileSwap(executionId);
      assert.notStrictEqual(reconciled.state, SovereignAtomicState.COMPLETED);
      assert.notStrictEqual(reconciled.state, SovereignAtomicState.REFUNDED);
      assert.strictEqual(reconciled.recoveryRequired, true);
      assert.match(reconciled.failureReason!, /Authoritative cross-rail observation unavailable/);
    });
  });

  // =========================================================================
  // SUITE 3: TRUE PRODUCTION PROFILE RECOVERY CERTIFICATION
  // =========================================================================
  describe('Suite 3: True Production Profile Recovery Certification', () => {
    it('3.1: True environment:production transport-only recovery bootstrap preserves canonical object graph', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const executionId = 'prod-rec-swap-1';
      const hashLock = '0x' + '81'.repeat(32);
      const reservation = persistence.reserveLiquidity(executionId, token, 20_000_000n, {
        allowLegacyFallback: true,
      });

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'prod-rec-idemp',
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
      }, 'test-fp-prod');

      const config = getValidBootstrapConfig(dbPath);
      config.environment = 'production';

      const basePublicClient = createMockBasePublicClient(100_000_000n);
      const cleanHash = hashLock.replace(/^0x/, '').toLowerCase();
      const lndClient = createMockLndClient({
        lookupInvoice: async (hash: string) => {
          if (hash === cleanHash) {
            return { state: 'ACCEPTED', value: '10000', r_hash: cleanHash } as any;
          }
          throw new LndRestError(404, 'not found', '');
        },
      });

      const res = await bootstrapProductionRouterForTesting(config, {
        basePublicClient,
        lndClient,
      });

      assert.ok(res.persistence instanceof SqlitePersistence, 'Real SqlitePersistence');
      assert.ok(res.evmBackend instanceof BaseSepoliaAtomicBackend, 'Real BaseSepoliaAtomicBackend');
      assert.ok(res.reconciler instanceof ChainInventoryReconciler, 'Real ChainInventoryReconciler');
      assert.ok(res.inventory instanceof SqliteLiquidityInventory, 'Real SqliteLiquidityInventory');
      assert.ok(res.lightningBackend instanceof LndLightningAtomicBackend, 'Real LndLightningAtomicBackend');
      assert.ok(res.coordinator instanceof AtomicCoordinator, 'Real AtomicCoordinator');

      assert.strictEqual(res.isProcessRecoveryReady, true);
      assert.strictEqual(res.isEconomicAcceptanceReady, false);

      res.persistence.close();
    });

    it('3.2: True environment:production recovery + DEFICIT constructs recovery machinery and blocks new swaps', async () => {
      persistence.setConfirmedOperatorBalance(token, 0n);
      const executionId = 'prod-deficit-exec';
      const hashLock = '0x' + '82'.repeat(32);
      const reservation = persistence.reserveLiquidity(executionId, token, 20_000_000n, {
        allowLegacyFallback: true,
      });

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'prod-deficit-idemp',
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
      }, 'test-fp-prod-def');

      const config = getValidBootstrapConfig(dbPath);
      config.environment = 'production';

      const basePublicClient = createMockBasePublicClient(0n);
      const cleanHash = hashLock.replace(/^0x/, '').toLowerCase();
      let createdInvoices = 0;
      const lndClient = createMockLndClient({
        lookupInvoice: async (hash: string) => {
          if (hash === cleanHash) {
            return { state: 'ACCEPTED', value: '10000', r_hash: cleanHash } as any;
          }
          throw new LndRestError(404, 'not found', '');
        },
        addHoldInvoice: async () => {
          createdInvoices++;
          return { payment_request: 'lnbc...' } as any;
        },
      });

      const res = await bootstrapProductionRouterForTesting(config, {
        basePublicClient,
        lndClient,
      });

      assert.strictEqual(res.isProcessRecoveryReady, true);
      assert.strictEqual(res.isEconomicAcceptanceReady, false);

      const initialReservations = persistence.listLiquidityReservations().length;
      await assert.rejects(
        () => res.coordinator.prepareSwap({
          idempotencyKey: 'new-swap-during-deficit',
          hashLock: '0x' + '83'.repeat(32),
          amountSats: 5000n,
          expectedUsdcAmount: 5_000_000n,
          claimingAddress: operator,
          targetDestinationAddress: operator,
        }),
        (err: any) => err instanceof LiquidityDeficitError || err instanceof InventoryNotReadyError
      );

      assert.strictEqual(persistence.listLiquidityReservations().length, initialReservations);
      assert.strictEqual(createdInvoices, 0);

      res.persistence.close();
    });

    it('3.3: Production Base mock proves chain ID = 84532, canonical USDC, decimals = 6, and HTLC bytecode validation PASS', async () => {
      const basePublicClient = createMockBasePublicClient(100_000_000n);
      const backend = BaseSepoliaAtomicBackend.createForTesting({
        chainId: BASE_SEPOLIA_CHAIN_ID,
        htlcAddress: '0x1111111111111111111111111111111111111111',
        tokenAddress: OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS,
        operatorPrivateKey: '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        persistence,
        finalityPolicy: { policyTag: 'BASE_SEPOLIA_TEST_POLICY', requiredConfirmations: 2 },
      }, basePublicClient as any);

      await assert.doesNotReject(() => backend.ensureGuards());
      const verifyRes = await backend.verifyChainAndToken(BASE_SEPOLIA_CHAIN_ID, token);
      assert.strictEqual(verifyRes.valid, true);
    });

    it('3.4: True environment:production + healthy Base transport guards + PLAN_PREPARED recovery', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const executionId = 'prod-plan-prep-exec';
      const hashLock = '0x' + '84'.repeat(32);
      const reservation = persistence.reserveLiquidity(executionId, token, 20_000_000n, {
        allowLegacyFallback: true,
      });

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'prod-plan-prep-idemp',
        hashLock,
        claimingAddress: operator,
        targetDestinationAddress: operator,
        amountSats: 10_000n,
        expectedUsdcAmount: 20_000_000n,
        state: SovereignAtomicState.PLAN_PREPARED,
        recoveryRequired: false,
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
      }, 'test-fp-prod-plan');

      const config = getValidBootstrapConfig(dbPath);
      config.environment = 'production';

      const basePublicClient = createMockBasePublicClient(100_000_000n);
      const cleanHash = hashLock.replace(/^0x/, '').toLowerCase();
      let createdInvoices = 0;
      const lndClient = createMockLndClient({
        lookupInvoice: async (hash: string) => {
          if (hash === cleanHash) {
            return { state: 'OPEN', value: '10000', r_hash: cleanHash, payment_request: 'lnbc100u...' } as any;
          }
          throw new LndRestError(404, 'not found', '');
        },
        addHoldInvoice: async () => {
          createdInvoices++;
          return { payment_request: 'lnbc...' } as any;
        },
      });

      const res = await bootstrapProductionRouterForTesting(config, {
        basePublicClient,
        lndClient,
      });

      assert.ok(res.coordinator instanceof AtomicCoordinator);
      assert.ok(res.evmBackend instanceof BaseSepoliaAtomicBackend);
      assert.ok(res.reconciler instanceof ChainInventoryReconciler);
      assert.ok(res.inventory instanceof SqliteLiquidityInventory);
      assert.ok(res.lightningBackend instanceof LndLightningAtomicBackend);
      assert.ok(res.persistence instanceof SqlitePersistence);

      assert.strictEqual(res.isProcessRecoveryReady, true);
      assert.strictEqual(createdInvoices, 0, 'Zero duplicate hold invoice calls');

      const convergedSwap = persistence.getSovereignSwap(executionId)!;
      assert.strictEqual(convergedSwap.state, SovereignAtomicState.INVOICE_CREATED);
      assert.strictEqual(convergedSwap.reservationStatus, 'RESERVED');
      assert.strictEqual(convergedSwap.recoveryRequired, false);
      assert.ok(convergedSwap.holdInvoice);
      assert.strictEqual(convergedSwap.holdInvoice.state, 'OPEN');

      const resRecord = persistence.getLiquidityReservation(reservation.reservationId)!;
      assert.strictEqual(resRecord.status, 'RESERVED');

      res.persistence.close();
    });

    it('3.5: True environment:production + healthy Base transport guards + EVM_FUNDING_PENDING CONFIRMED/LOCKED', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const executionId = 'prod-funded-exec';
      const hashLock = '0x' + '85'.repeat(32);
      const evmSwapKey = `swap_${executionId}`;
      const reservation = persistence.reserveLiquidity(executionId, token, 20_000_000n, {
        allowLegacyFallback: true,
      });

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'prod-funded-idemp',
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
        evmHtlcId: '0x' + '11'.repeat(32),
        refundLocktime: 1700003600,
        cltvExpiryBlocks: 144,
        timelockSeconds: 3600,
        createdAt: new Date(),
        updatedAt: new Date(),
      }, 'test-fp-prod-funded');

      const intent = persistence.getOrCreateEvmIntent({
        swapKey: evmSwapKey,
        chainId: 84532,
        signerAddress: operator as `0x${string}`,
        actionType: 'FUND',
        targetAddress: '0x1111111111111111111111111111111111111111',
        calldata: '0x',
      });
      persistence.markEvmIntentConfirmedByChainEvidence(intent.id, ('0x' + 'aa'.repeat(32)) as `0x${string}`);

      const config = getValidBootstrapConfig(dbPath);
      config.environment = 'production';

      const basePublicClient = createMockBasePublicClient(100_000_000n, {
        funded: true,
        completed: false,
        refunded: false,
        amount: 20_000_000n,
        timelock: BigInt(Math.floor(Date.now() / 1000) + 3600),
      });
      const cleanHash = hashLock.replace(/^0x/, '').toLowerCase();
      const lndClient = createMockLndClient({
        lookupInvoice: async (hash: string) => {
          if (hash === cleanHash) {
            return { state: 'ACCEPTED', value: '10000', r_hash: cleanHash } as any;
          }
          throw new LndRestError(404, 'not found', '');
        },
      });

      const res = await bootstrapProductionRouterForTesting(config, {
        basePublicClient,
        lndClient,
      });

      assert.strictEqual(res.isProcessRecoveryReady, true);

      const convergedSwap = persistence.getSovereignSwap(executionId)!;
      assert.strictEqual(convergedSwap.state, SovereignAtomicState.EVM_FUNDED);
      assert.strictEqual(convergedSwap.reservationStatus, 'COMMITTED');
      assert.strictEqual(convergedSwap.recoveryRequired, false);

      const resRecord = persistence.getLiquidityReservation(reservation.reservationId)!;
      assert.strictEqual(resRecord.status, 'COMMITTED');

      res.persistence.close();
    });
  });

  // =========================================================================
  // SUITE 4: PLAN_PREPARED & EVM_FUNDING_PENDING STARTUP STATE CONVERGENCE
  // =========================================================================
  describe('Suite 4: PLAN_PREPARED & EVM_FUNDING_PENDING Startup State Convergence', () => {
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

    it('4.1: PLAN_PREPARED + LN invoice OPEN after restart discovers invoice, zero duplicate createHoldInvoice, reservation retained', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const executionId = 'plan-prep-open-exec';
      const hashLock = '0x' + '91'.repeat(32);
      const reservation = persistence.reserveLiquidity(executionId, token, 20_000_000n, {
        allowLegacyFallback: true,
      });

      const fakeLightning = new ConfigurableLightning();
      fakeLightning.setInvoiceState(hashLock, 'OPEN');
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);

      const { coordinator, inventory } = setupCoordinator(fakeLightning, fakeEvm);
      const expectedFingerprint = (coordinator as any).computeEconomicFingerprint({
        amountSats: 10_000n,
        expectedUsdcAmount: 20_000_000n,
        hashLock,
        claimingAddress: operator,
        targetDestinationAddress: operator,
        tokenAddress: (coordinator as any).defaultTokenAddress,
        refundAddress: (coordinator as any).defaultRefundAddress,
      });

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'plan-prep-open',
        hashLock,
        claimingAddress: operator,
        targetDestinationAddress: operator,
        amountSats: 10_000n,
        expectedUsdcAmount: 20_000_000n,
        state: SovereignAtomicState.PLAN_PREPARED,
        recoveryRequired: false,
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
      }, expectedFingerprint);

      const reconciled = await coordinator.reconcileSwap(executionId);
      assert.strictEqual(reconciled.state, SovereignAtomicState.INVOICE_CREATED);
      assert.strictEqual(reconciled.reservationStatus, 'RESERVED');
      assert.strictEqual(reconciled.recoveryRequired, false);
      assert.ok(reconciled.holdInvoice);
      assert.strictEqual(reconciled.holdInvoice.state, 'OPEN');
      assert.strictEqual(fakeLightning.createCalls.length, 0, 'Zero duplicate hold invoices created');

      const resRec = persistence.getLiquidityReservation(reservation.reservationId)!;
      assert.strictEqual(resRec.status, 'RESERVED');
      assert.strictEqual(await inventory.getReservedBalance(token), 20_000_000n);

      // Subsequent prepareSwap with same idempotencyKey returns converged swap without duplicate createHoldInvoice
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: 'plan-prep-open',
        hashLock,
        amountSats: 10_000n,
        expectedUsdcAmount: 20_000_000n,
        claimingAddress: operator,
        targetDestinationAddress: operator,
      });
      assert.strictEqual(prepared.id, executionId);
      assert.strictEqual(fakeLightning.createCalls.length, 0, 'No duplicate invoice created on prepare retry');
    });

    it('4.2: PLAN_PREPARED + LN ACCEPTED converges to LIGHTNING_HELD and funds Base HTLC, zero duplicate invoice', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const executionId = 'plan-prep-accepted-exec';
      const hashLock = '0x' + '92'.repeat(32);
      const reservation = persistence.reserveLiquidity(executionId, token, 20_000_000n, {
        allowLegacyFallback: true,
      });

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'plan-prep-acc',
        hashLock,
        claimingAddress: operator,
        targetDestinationAddress: operator,
        amountSats: 10_000n,
        expectedUsdcAmount: 20_000_000n,
        state: SovereignAtomicState.PLAN_PREPARED,
        recoveryRequired: false,
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
      }, 'test-fp-plan-acc');

      const fakeLightning = new ConfigurableLightning();
      fakeLightning.setInvoiceState(hashLock, 'ACCEPTED');
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);

      const { coordinator } = setupCoordinator(fakeLightning, fakeEvm);

      const reconciled = await coordinator.reconcileSwap(executionId);
      assert.strictEqual(fakeLightning.createCalls.length, 0, 'Zero duplicate hold invoices created');
      assert.ok(reconciled.holdInvoice);
      assert.strictEqual(reconciled.holdInvoice.state, 'ACCEPTED');
      // Coordinator advanced and funded EVM
      assert.ok(
        reconciled.state === SovereignAtomicState.EVM_FUNDING_PENDING ||
        reconciled.state === SovereignAtomicState.EVM_FUNDED
      );
    });

    it('4.3: PLAN_PREPARED + LN NOT_FOUND + Base authoritative absence releases reservation exactly once', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const executionId = 'plan-prep-absent-exec';
      const hashLock = '0x' + '93'.repeat(32);
      const reservation = persistence.reserveLiquidity(executionId, token, 20_000_000n, {
        allowLegacyFallback: true,
      });

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'plan-prep-absent',
        hashLock,
        claimingAddress: operator,
        targetDestinationAddress: operator,
        amountSats: 10_000n,
        expectedUsdcAmount: 20_000_000n,
        state: SovereignAtomicState.PLAN_PREPARED,
        recoveryRequired: false,
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
      }, 'test-fp-plan-abs');

      const fakeLightning = new ConfigurableLightning();
      // default observeHoldInvoice throws LightningInvoiceNotFoundError
      fakeLightning.observeHoldInvoice = async () => {
        throw new LightningInvoiceNotFoundError(hashLock);
      };
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);

      const { coordinator, inventory } = setupCoordinator(fakeLightning, fakeEvm);

      const reconciled = await coordinator.reconcileSwap(executionId);
      assert.strictEqual(reconciled.state, SovereignAtomicState.INVOICE_CANCELED);
      assert.strictEqual(reconciled.reservationStatus, 'RELEASED');
      assert.strictEqual(reconciled.recoveryRequired, false);

      const resRec = persistence.getLiquidityReservation(reservation.reservationId)!;
      assert.strictEqual(resRec.status, 'RELEASED');
      assert.strictEqual(await inventory.getReservedBalance(token), 0n, 'R must be 0 after safe release');
    });

    it('4.4: PLAN_PREPARED + LN UNKNOWN marks RECOVERY_REQUIRED and retains reservation', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const executionId = 'plan-prep-unknown-exec';
      const hashLock = '0x' + '94'.repeat(32);
      const reservation = persistence.reserveLiquidity(executionId, token, 20_000_000n, {
        allowLegacyFallback: true,
      });

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'plan-prep-unk',
        hashLock,
        claimingAddress: operator,
        targetDestinationAddress: operator,
        amountSats: 10_000n,
        expectedUsdcAmount: 20_000_000n,
        state: SovereignAtomicState.PLAN_PREPARED,
        recoveryRequired: false,
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
      }, 'test-fp-plan-unk');

      const fakeLightning = new ConfigurableLightning();
      fakeLightning.observeHoldInvoice = async () => {
        throw new Error('LND connection timeout');
      };
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);

      const { coordinator, inventory } = setupCoordinator(fakeLightning, fakeEvm);

      const reconciled = await coordinator.reconcileSwap(executionId);
      assert.strictEqual(reconciled.state, SovereignAtomicState.RECOVERY_REQUIRED);
      assert.strictEqual(reconciled.recoveryRequired, true);
      assert.strictEqual(reconciled.reservationStatus, 'RESERVED');

      const resRec = persistence.getLiquidityReservation(reservation.reservationId)!;
      assert.strictEqual(resRec.status, 'RESERVED');
      assert.strictEqual(await inventory.getReservedBalance(token), 20_000_000n, 'R must remain locked');
    });

    it('4.5: PLAN_PREPARED + Base FUNDED unexpectedly triggers fail-closed cross-rail recovery and retains reservation', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const executionId = 'plan-prep-funded-exec';
      const hashLock = '0x' + '95'.repeat(32);
      const evmSwapKey = `swap_${executionId}`;
      const reservation = persistence.reserveLiquidity(executionId, token, 20_000_000n, {
        allowLegacyFallback: true,
      });

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'plan-prep-funded',
        hashLock,
        claimingAddress: operator,
        targetDestinationAddress: operator,
        amountSats: 10_000n,
        expectedUsdcAmount: 20_000_000n,
        state: SovereignAtomicState.PLAN_PREPARED,
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
      }, 'test-fp-plan-fund');

      const fakeLightning = new ConfigurableLightning();
      fakeLightning.setInvoiceState(hashLock, 'OPEN');
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);
      fakeEvm.setHtlcState(evmSwapKey, {
        funded: true,
        completed: false,
        refunded: false,
        balance: 20_000_000n,
        timelock: Math.floor(Date.now() / 1000) + 3600,
      });

      const { coordinator } = setupCoordinator(fakeLightning, fakeEvm);

      const reconciled = await coordinator.reconcileSwap(executionId);
      assert.strictEqual(reconciled.state, SovereignAtomicState.RECOVERY_REQUIRED);
      assert.strictEqual(reconciled.recoveryRequired, true);
      assert.match(reconciled.failureReason!, /CRITICAL_INVARIANT_VIOLATION.*Base HTLC is FUNDED.*reservation retained/);
    });

    it('4.6: EVM_FUNDING_PENDING + FUND CONFIRMED + Base LOCKED converges to EVM_FUNDED with reservation COMMITTED', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const executionId = 'fund-conf-locked-exec';
      const hashLock = '0x' + '96'.repeat(32);
      const evmSwapKey = `swap_${executionId}`;
      const reservation = persistence.reserveLiquidity(executionId, token, 20_000_000n, {
        allowLegacyFallback: true,
      });

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'fund-conf-locked',
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
      }, 'test-fp-fund-locked');

      const intent = persistence.getOrCreateEvmIntent({
        swapKey: evmSwapKey,
        chainId: 84532,
        signerAddress: operator as `0x${string}`,
        actionType: 'FUND',
        targetAddress: '0x1111111111111111111111111111111111111111',
        calldata: '0x',
      });
      persistence.markEvmIntentConfirmedByChainEvidence(intent.id, ('0x' + '96'.repeat(32)) as `0x${string}`);

      const fakeLightning = new ConfigurableLightning();
      fakeLightning.setInvoiceState(hashLock, 'ACCEPTED');
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);
      fakeEvm.setHtlcState(evmSwapKey, {
        funded: true,
        completed: false,
        refunded: false,
        balance: 20_000_000n,
        timelock: Math.floor(Date.now() / 1000) + 3600,
      });

      const { coordinator, inventory } = setupCoordinator(fakeLightning, fakeEvm);

      const reconciled = await coordinator.reconcileSwap(executionId);
      assert.strictEqual(reconciled.state, SovereignAtomicState.EVM_FUNDED);
      assert.strictEqual(reconciled.reservationStatus, 'COMMITTED');
      assert.strictEqual(reconciled.recoveryRequired, false);

      const resRec = persistence.getLiquidityReservation(reservation.reservationId)!;
      assert.strictEqual(resRec.status, 'COMMITTED');
      assert.strictEqual(await inventory.getCommittedBalance(token), 20_000_000n);
      assert.strictEqual(await inventory.getReservedBalance(token), 0n);
    });

    it('4.7: Same EVM_FUNDING_PENDING scenario repeated after restart is idempotent with zero double-commit', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const executionId = 'fund-idem-exec';
      const hashLock = '0x' + '97'.repeat(32);
      const evmSwapKey = `swap_${executionId}`;
      const reservation = persistence.reserveLiquidity(executionId, token, 20_000_000n, {
        allowLegacyFallback: true,
      });

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'fund-idem',
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
      }, 'test-fp-fund-idem');

      const intent = persistence.getOrCreateEvmIntent({
        swapKey: evmSwapKey,
        chainId: 84532,
        signerAddress: operator as `0x${string}`,
        actionType: 'FUND',
        targetAddress: '0x1111111111111111111111111111111111111111',
        calldata: '0x',
      });
      persistence.markEvmIntentConfirmedByChainEvidence(intent.id, ('0x' + '97'.repeat(32)) as `0x${string}`);

      const fakeLightning = new ConfigurableLightning();
      fakeLightning.setInvoiceState(hashLock, 'ACCEPTED');
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);
      fakeEvm.setHtlcState(evmSwapKey, {
        funded: true,
        completed: false,
        refunded: false,
        balance: 20_000_000n,
        timelock: Math.floor(Date.now() / 1000) + 3600,
      });

      const { coordinator, inventory } = setupCoordinator(fakeLightning, fakeEvm);

      const reconciled1 = await coordinator.reconcileSwap(executionId);
      assert.strictEqual(reconciled1.state, SovereignAtomicState.EVM_FUNDED);

      // Reconcile a second time (restart simulation)
      const reconciled2 = await coordinator.reconcileSwap(executionId);
      assert.strictEqual(reconciled2.state, SovereignAtomicState.EVM_FUNDED);
      assert.strictEqual(reconciled2.reservationStatus, 'COMMITTED');

      const resRec = persistence.getLiquidityReservation(reservation.reservationId)!;
      assert.strictEqual(resRec.status, 'COMMITTED');
      assert.strictEqual(await inventory.getCommittedBalance(token), 20_000_000n);
      assert.strictEqual(await inventory.getReservedBalance(token), 0n);
    });

    it('4.8: EVM_FUNDING_PENDING + FUND PENDING runs recovery pass with zero blind retry and retains reservation', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const executionId = 'fund-pend-exec';
      const hashLock = '0x' + '98'.repeat(32);
      const evmSwapKey = `swap_${executionId}`;
      const reservation = persistence.reserveLiquidity(executionId, token, 20_000_000n, {
        allowLegacyFallback: true,
      });

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'fund-pend',
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
      }, 'test-fp-fund-pend');

      persistence.getOrCreateEvmIntent({
        swapKey: evmSwapKey,
        chainId: 84532,
        signerAddress: operator as `0x${string}`,
        actionType: 'FUND',
        targetAddress: '0x1111111111111111111111111111111111111111',
        calldata: '0x',
      });

      const fakeLightning = new ConfigurableLightning();
      fakeLightning.setInvoiceState(hashLock, 'ACCEPTED');
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);
      fakeEvm.observeHtlc = async () => ({
        swapKey: evmSwapKey,
        funded: false,
        completed: false,
        refunded: false,
        balance: 0n,
        timelock: 0,
        blockTimestamp: 0,
      } as any);

      const { coordinator, inventory } = setupCoordinator(fakeLightning, fakeEvm);

      const reconciled = await coordinator.reconcileSwap(executionId);
      // LN is ACCEPTED, EVM is not funded proven, but swap is EVM_FUNDING_PENDING with intent -> marks recovery required, NO blind retry!
      assert.strictEqual(reconciled.recoveryRequired, true);
      assert.strictEqual(reconciled.reservationStatus, 'RESERVED');
      assert.strictEqual(await inventory.getReservedBalance(token), 20_000_000n);
    });

    it('4.9: EVM_FUNDING_PENDING + FUND FAILED runs recovery pass and retains reservation', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const executionId = 'fund-failed-exec';
      const hashLock = '0x' + '99'.repeat(32);
      const evmSwapKey = `swap_${executionId}`;
      const reservation = persistence.reserveLiquidity(executionId, token, 20_000_000n, {
        allowLegacyFallback: true,
      });

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'fund-failed',
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
      }, 'test-fp-fund-fail');

      const intent = persistence.getOrCreateEvmIntent({
        swapKey: evmSwapKey,
        chainId: 84532,
        signerAddress: operator as `0x${string}`,
        actionType: 'FUND',
        targetAddress: '0x1111111111111111111111111111111111111111',
        calldata: '0x',
      });
      persistence.markEvmIntentFailed(intent.id, 'RPC_TIMEOUT');

      const fakeLightning = new ConfigurableLightning();
      fakeLightning.setInvoiceState(hashLock, 'ACCEPTED');
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);

      const { coordinator, inventory } = setupCoordinator(fakeLightning, fakeEvm);

      const reconciled = await coordinator.reconcileSwap(executionId);
      assert.strictEqual(reconciled.recoveryRequired, true);
      assert.strictEqual(reconciled.reservationStatus, 'RESERVED');
      assert.strictEqual(await inventory.getReservedBalance(token), 20_000_000n, 'Reservation must be retained');
    });

    it('4.10: EVM_FUNDING_PENDING + FUND REVERTED runs recovery pass and retains reservation', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const executionId = 'fund-revert-exec';
      const hashLock = '0x' + '9a'.repeat(32);
      const evmSwapKey = `swap_${executionId}`;
      const reservation = persistence.reserveLiquidity(executionId, token, 20_000_000n, {
        allowLegacyFallback: true,
      });

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'fund-revert',
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
      }, 'test-fp-fund-rev');

      const intent = persistence.getOrCreateEvmIntent({
        swapKey: evmSwapKey,
        chainId: 84532,
        signerAddress: operator as `0x${string}`,
        actionType: 'FUND',
        targetAddress: '0x1111111111111111111111111111111111111111',
        calldata: '0x',
      });
      persistence.markEvmSimulationReverted(intent.id, 'OUT_OF_GAS');

      const fakeLightning = new ConfigurableLightning();
      fakeLightning.setInvoiceState(hashLock, 'ACCEPTED');
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);

      const { coordinator, inventory } = setupCoordinator(fakeLightning, fakeEvm);

      const reconciled = await coordinator.reconcileSwap(executionId);
      assert.strictEqual(reconciled.recoveryRequired, true);
      assert.strictEqual(reconciled.reservationStatus, 'RESERVED');
      assert.strictEqual(await inventory.getReservedBalance(token), 20_000_000n);
    });

    it('4.11: EVM_FUNDING_PENDING + NONCE_CONFLICT runs recovery pass and retains reservation', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const executionId = 'fund-nonce-conflict-exec';
      const hashLock = '0x' + '9b'.repeat(32);
      const evmSwapKey = `swap_${executionId}`;
      const reservation = persistence.reserveLiquidity(executionId, token, 20_000_000n, {
        allowLegacyFallback: true,
      });

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'fund-nonce-conf',
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
      }, 'test-fp-fund-nonce');

      const intent = persistence.getOrCreateEvmIntent({
        swapKey: evmSwapKey,
        chainId: 84532,
        signerAddress: operator as `0x${string}`,
        actionType: 'FUND',
        targetAddress: '0x1111111111111111111111111111111111111111',
        calldata: '0x',
      });
      persistence.markEvmNonceConflict(intent.id, 'NONCE_ALREADY_USED');

      const fakeLightning = new ConfigurableLightning();
      fakeLightning.setInvoiceState(hashLock, 'ACCEPTED');
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);

      const { coordinator, inventory } = setupCoordinator(fakeLightning, fakeEvm);

      const reconciled = await coordinator.reconcileSwap(executionId);
      assert.strictEqual(reconciled.recoveryRequired, true);
      assert.strictEqual(reconciled.reservationStatus, 'RESERVED');
      assert.strictEqual(await inventory.getReservedBalance(token), 20_000_000n);
    });

    it('4.12: EVM_FUNDING_PENDING + missing FUND intent marks RECOVERY_REQUIRED, NOT READY, reservation retained', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const executionId = 'fund-missing-intent-exec';
      const hashLock = '0x' + '9c'.repeat(32);
      const evmSwapKey = `swap_${executionId}`;
      const reservation = persistence.reserveLiquidity(executionId, token, 20_000_000n, {
        allowLegacyFallback: true,
      });

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'fund-missing-intent',
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
      }, 'test-fp-fund-miss');

      // Do NOT create FUND intent in persistence!

      const fakeLightning = new ConfigurableLightning();
      fakeLightning.setInvoiceState(hashLock, 'ACCEPTED');
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);

      const { coordinator, reconciler, inventory } = setupCoordinator(fakeLightning, fakeEvm);

      const reconciled = await coordinator.reconcileSwap(executionId);
      assert.strictEqual(reconciled.state, SovereignAtomicState.RECOVERY_REQUIRED);
      assert.strictEqual(reconciled.recoveryRequired, true);
      assert.match(reconciled.failureReason!, /no durable FUND intent/);
      assert.strictEqual(reconciled.reservationStatus, 'RESERVED');
      assert.strictEqual(await reconciler.getReadinessState(token), 'NOT_READY');
      assert.strictEqual(await inventory.getReservedBalance(token), 20_000_000n);
    });

    it('4.13: No new swap is accepted while unresolved recovery remains (prepareSwap rejected fail-closed)', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const executionId = 'unresolved-gate-exec';
      const hashLock = '0x' + '9d'.repeat(32);
      const reservation = persistence.reserveLiquidity(executionId, token, 20_000_000n, {
        allowLegacyFallback: true,
      });

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'unresolved-gate',
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
      }, 'test-fp-unresolved');

      const fakeLightning = new ConfigurableLightning();
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);

      const { coordinator, reconciler } = setupCoordinator(fakeLightning, fakeEvm);

      assert.strictEqual(await reconciler.getReadinessState(token), 'NOT_READY');

      const initialReservations = persistence.listLiquidityReservations().length;
      await assert.rejects(
        () => coordinator.prepareSwap({
          idempotencyKey: 'new-swap-attempt',
          hashLock: '0x' + '9e'.repeat(32),
          amountSats: 5000n,
          expectedUsdcAmount: 5_000_000n,
          claimingAddress: operator,
          targetDestinationAddress: operator,
        }),
        (err: any) => err instanceof InventoryNotReadyError || err instanceof LiquidityDeficitError
      );

      assert.strictEqual(persistence.listLiquidityReservations().length, initialReservations);
      assert.strictEqual(fakeLightning.createCalls.length, 0);
    });

    it('4.14: After all recovery resolves and inventory is healthy -> economic acceptance returns READY', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const executionId = 'resolve-clean-exec';
      const hashLock = '0x' + '9f'.repeat(32);
      const reservation = persistence.reserveLiquidity(executionId, token, 20_000_000n, {
        allowLegacyFallback: true,
      });

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'resolve-clean',
        hashLock,
        claimingAddress: operator,
        targetDestinationAddress: operator,
        amountSats: 10_000n,
        expectedUsdcAmount: 20_000_000n,
        state: SovereignAtomicState.PLAN_PREPARED,
        recoveryRequired: false,
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
      }, 'test-fp-resolve-clean');

      const fakeLightning = new ConfigurableLightning();
      fakeLightning.observeHoldInvoice = async () => {
        throw new LightningInvoiceNotFoundError(hashLock);
      };
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);

      const { coordinator, reconciler } = setupCoordinator(fakeLightning, fakeEvm);

      // Reconcile the swap to clean terminal cancellation
      const reconciled = await coordinator.reconcileSwap(executionId);
      assert.strictEqual(reconciled.state, SovereignAtomicState.INVOICE_CANCELED);
      assert.strictEqual(reconciled.recoveryRequired, false);

      // Reconcile inventory
      await reconciler.reconcile();
      assert.strictEqual(await reconciler.getReadinessState(token), 'READY');

      // Now a new swap CAN be prepared successfully
      const newSwap = await coordinator.prepareSwap({
        idempotencyKey: 'new-clean-swap',
        hashLock: '0x' + 'a1'.repeat(32),
        amountSats: 5000n,
        expectedUsdcAmount: 5_000_000n,
        claimingAddress: operator,
        targetDestinationAddress: operator,
      });
      assert.ok(newSwap);
      assert.strictEqual(newSwap.state, SovereignAtomicState.INVOICE_CREATED);
    });
  });

  // =========================================================================
  // SUITE 5: SEMANTIC CLEANUP 3 — LndLightningAtomicBackend.recoverAfterRestart()
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

    it('4.1: Returns null ONLY on typed LightningInvoiceNotFoundError (404)', async () => {
      const client = mockLndClient(async (_hash) => {
        throw new LndRestError(404, 'Invoice not found', '{"error":"not found"}');
      });
      const backend = new LndLightningAtomicBackend(client);

      const result = await backend.recoverAfterRestart('0x' + '12'.repeat(32));
      assert.strictEqual(result, null, 'Must return null for 404 absence');
    });

    it('4.2: Propagates transport / network ECONNREFUSED error (never returns null)', async () => {
      const client = mockLndClient(async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:18080');
      });
      const backend = new LndLightningAtomicBackend(client);

      await assert.rejects(
        () => backend.recoverAfterRestart('0x' + '34'.repeat(32)),
        /ECONNREFUSED/
      );
    });

    it('4.3: Propagates timeout / aborted error (never returns null)', async () => {
      const client = mockLndClient(async () => {
        throw new Error('The operation was aborted due to timeout');
      });
      const backend = new LndLightningAtomicBackend(client);

      await assert.rejects(
        () => backend.recoverAfterRestart('0x' + '56'.repeat(32)),
        /timeout/
      );
    });

    it('4.4: Propagates authentication 401 macaroon error (never returns null)', async () => {
      const client = mockLndClient(async () => {
        throw new LndRestError(401, 'Permission denied', '{"error":"permission denied"}');
      });
      const backend = new LndLightningAtomicBackend(client);

      await assert.rejects(
        () => backend.recoverAfterRestart('0x' + '78'.repeat(32)),
        (err: any) => err instanceof LndRestError && err.statusCode === 401
      );
    });

    it('4.5: Returns mapped HoldInvoice when invoice exists', async () => {
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

  // =========================================================================
  // SUITE 5: BLOCKER 1 — RECONCILIATION OBSERVATION VS MUTATION RETRY BUDGET
  // =========================================================================
  describe('Blocker 1: Read-Only / Authoritative Reconciliation Observation vs Mutation Retry Limits', () => {
    function setupTestCoordinator(lightning: ConfigurableLightning, evm: ConfigurableEvm, maxReconciliationRetries = 3) {
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
        maxRetries: maxReconciliationRetries,
      });
      return { coordinator, inventory, reconciler };
    }

    it('5.1: INVOICE_CREATED + LN OPEN + Base NOT_FUNDED_PROVEN called maxRetries + 5 times does NOT consume retry budget and remains observable', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const fakeLightning = new ConfigurableLightning();
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);
      const { coordinator } = setupTestCoordinator(fakeLightning, fakeEvm, 3);

      const executionId = 'obs-limit-1';
      const hashLock = '0x' + 'b1'.repeat(32);
      const reservation = persistence.reserveLiquidity(executionId, token, 20_000_000n, {
        allowLegacyFallback: true,
      });

      fakeLightning.setInvoiceState(hashLock, 'OPEN');

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'obs-limit-key-1',
        hashLock,
        claimingAddress: operator,
        targetDestinationAddress: operator,
        amountSats: 10_000n,
        expectedUsdcAmount: 20_000_000n,
        state: SovereignAtomicState.INVOICE_CREATED,
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
        retryCount: 0,
      }, 'test-fp-obs-1');

      // Call reconcileSwap 8 times (maxRetries = 3)
      for (let i = 0; i < 8; i++) {
        const res = await coordinator.reconcileSwap(executionId);
        assert.strictEqual(res.state, SovereignAtomicState.INVOICE_CREATED);
        assert.strictEqual(res.recoveryRequired, false, `Pass ${i + 1} must not mark recoveryRequired`);
        assert.strictEqual(res.retryCount ?? 0, 0, `Pass ${i + 1} must not increment retryCount`);
      }

      const inDb = persistence.getSovereignSwap(executionId)!;
      assert.strictEqual(inDb.state, SovereignAtomicState.INVOICE_CREATED);
      assert.strictEqual(inDb.recoveryRequired, false);
      assert.strictEqual(inDb.retryCount, 0);
    });

    it('5.2: Same observed swap advances when LN becomes ACCEPTED on subsequent reconciliation', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const fakeLightning = new ConfigurableLightning();
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);
      const { coordinator } = setupTestCoordinator(fakeLightning, fakeEvm, 3);

      const executionId = 'obs-limit-advance';
      const hashLock = '0x' + 'b2'.repeat(32);
      const reservation = persistence.reserveLiquidity(executionId, token, 20_000_000n, {
        allowLegacyFallback: true,
      });

      fakeLightning.setInvoiceState(hashLock, 'OPEN');

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'obs-limit-key-2',
        hashLock,
        claimingAddress: operator,
        targetDestinationAddress: operator,
        amountSats: 10_000n,
        expectedUsdcAmount: 20_000_000n,
        state: SovereignAtomicState.INVOICE_CREATED,
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
        retryCount: 0,
      }, 'test-fp-obs-2');

      // 6 passive observations while OPEN
      for (let i = 0; i < 6; i++) {
        await coordinator.reconcileSwap(executionId);
      }

      // Now LN payment arrives -> ACCEPTED
      fakeLightning.setInvoiceState(hashLock, 'ACCEPTED');

      // Next reconcile observes ACCEPTED, transitions to LIGHTNING_HELD and funds EVM HTLC
      const updated = await coordinator.reconcileSwap(executionId);
      assert.strictEqual(updated.state, SovereignAtomicState.EVM_FUNDED);
      assert.strictEqual(updated.recoveryRequired, false);
      assert.ok(updated.evmHtlcId);
    });

    it('5.3: RECOVERY_REQUIRED from transient LN RPC failure can be observed indefinitely beyond maxRetries, recovers when LN heals', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const fakeLightning = new ConfigurableLightning();
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);
      const { coordinator } = setupTestCoordinator(fakeLightning, fakeEvm, 3);

      const executionId = 'obs-ln-transient';
      const hashLock = '0x' + 'b3'.repeat(32);
      const reservation = persistence.reserveLiquidity(executionId, token, 20_000_000n, {
        allowLegacyFallback: true,
      });

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'obs-limit-key-3',
        hashLock,
        claimingAddress: operator,
        targetDestinationAddress: operator,
        amountSats: 10_000n,
        expectedUsdcAmount: 20_000_000n,
        state: SovereignAtomicState.INVOICE_CREATED,
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
        retryCount: 0,
      }, 'test-fp-obs-3');

      // LN has network failure
      fakeLightning.observeError = new Error('LND connection timeout');

      // Observe 7 times while LN is failing (maxRetries = 3)
      for (let i = 0; i < 7; i++) {
        const res = await coordinator.reconcileSwap(executionId);
        assert.strictEqual(res.recoveryRequired, true);
        assert.ok(res.failureReason?.includes('Authoritative cross-rail observation unavailable'));
        assert.strictEqual(res.retryCount ?? 0, 0, 'Transient observation failure must not consume mutation retry budget');
      }

      // LN heals!
      fakeLightning.observeError = null;
      fakeLightning.setInvoiceState(hashLock, 'OPEN');

      // Next reconcile should observe OPEN and clear recoveryRequired
      const healed = await coordinator.reconcileSwap(executionId);
      assert.strictEqual(healed.recoveryRequired, false);
      assert.strictEqual(healed.failureReason, undefined);
      assert.strictEqual(healed.state, SovereignAtomicState.INVOICE_CREATED);
    });

    it('5.4: RECOVERY_REQUIRED from transient Base RPC failure can be observed indefinitely beyond maxRetries, recovers when Base heals', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const fakeLightning = new ConfigurableLightning();
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);
      const { coordinator } = setupTestCoordinator(fakeLightning, fakeEvm, 3);

      const executionId = 'obs-base-transient';
      const hashLock = '0x' + 'b4'.repeat(32);
      const reservation = persistence.reserveLiquidity(executionId, token, 20_000_000n, {
        allowLegacyFallback: true,
      });

      fakeLightning.setInvoiceState(hashLock, 'OPEN');

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'obs-limit-key-4',
        hashLock,
        claimingAddress: operator,
        targetDestinationAddress: operator,
        amountSats: 10_000n,
        expectedUsdcAmount: 20_000_000n,
        state: SovereignAtomicState.INVOICE_CREATED,
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
        retryCount: 0,
      }, 'test-fp-obs-4');

      // Base has RPC error
      fakeEvm.observeError = new Error('Base RPC 502 Bad Gateway');

      for (let i = 0; i < 7; i++) {
        const res = await coordinator.reconcileSwap(executionId);
        assert.strictEqual(res.recoveryRequired, true);
        assert.ok(res.failureReason?.includes('Authoritative cross-rail observation unavailable'));
        assert.strictEqual(res.retryCount ?? 0, 0);
      }

      // Base heals!
      fakeEvm.observeError = null;

      const healed = await coordinator.reconcileSwap(executionId);
      assert.strictEqual(healed.recoveryRequired, false);
      assert.strictEqual(healed.failureReason, undefined);
      assert.strictEqual(healed.state, SovereignAtomicState.INVOICE_CREATED);
    });

    it('5.5: EVM_FUNDED + Base LOCKED repeated restart reconciliation does not consume finite mutation budget', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const fakeLightning = new ConfigurableLightning();
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);
      const { coordinator } = setupTestCoordinator(fakeLightning, fakeEvm, 3);

      const executionId = 'obs-evm-funded-locked';
      const hashLock = '0x' + 'b5'.repeat(32);
      const evmSwapKey = `swap_${executionId}`;
      const reservation = persistence.reserveLiquidity(executionId, token, 20_000_000n, {
        allowLegacyFallback: true,
      });

      fakeLightning.setInvoiceState(hashLock, 'ACCEPTED');
      fakeEvm.setHtlcState(evmSwapKey, {
        funded: true,
        completed: false,
        refunded: false,
        balance: 20_000_000n,
        timelock: Math.floor(Date.now() / 1000) + 3600,
        blockTimestamp: Math.floor(Date.now() / 1000),
      });

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'obs-limit-key-5',
        hashLock,
        claimingAddress: operator,
        targetDestinationAddress: operator,
        amountSats: 10_000n,
        expectedUsdcAmount: 20_000_000n,
        state: SovereignAtomicState.EVM_FUNDED,
        evmHtlcId: `0x_mock_${evmSwapKey}`,
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
        retryCount: 0,
      }, 'test-fp-obs-5');

      // Reconcile 8 times
      for (let i = 0; i < 8; i++) {
        const res = await coordinator.reconcileSwap(executionId);
        assert.strictEqual(res.state, SovereignAtomicState.EVM_FUNDED);
        assert.strictEqual(res.recoveryRequired, false);
        assert.strictEqual(res.retryCount ?? 0, 0);
      }
    });

    it('5.6: Side-effecting mutation fundEvmHtlc strictly exhausts retry budget after maxRetries', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const fakeLightning = new ConfigurableLightning();
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);
      const { coordinator } = setupTestCoordinator(fakeLightning, fakeEvm, 3);

      const executionId = 'mut-fund-fail';
      const hashLock = '0x' + 'b6'.repeat(32);
      const reservation = persistence.reserveLiquidity(executionId, token, 20_000_000n, {
        allowLegacyFallback: true,
      });

      fakeLightning.setInvoiceState(hashLock, 'ACCEPTED');
      fakeEvm.fundError = new Error('Base gas estimation failed / nonce stalled');

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'obs-limit-key-6',
        hashLock,
        claimingAddress: operator,
        targetDestinationAddress: operator,
        amountSats: 10_000n,
        expectedUsdcAmount: 20_000_000n,
        state: SovereignAtomicState.LIGHTNING_HELD,
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
        retryCount: 0,
      }, 'test-fp-obs-6');

      // Pass 1: attempts fundEvmHtlc, increments retryCount to 1, throws and catches
      await coordinator.reconcileSwap(executionId);
      let r1 = persistence.getSovereignSwap(executionId)!;
      assert.strictEqual(r1.retryCount, 1);

      // Simulate retry count reaching maxRetries (3) for LIGHTNING_HELD
      persistence.updateSovereignSwap(executionId, { state: SovereignAtomicState.LIGHTNING_HELD, fundRetryCount: 3, retryCount: 3 });

      // Pass 2: retryCount (3) >= maxRetries (3) -> marks RECOVERY_REQUIRED with MAX_RETRIES_EXCEEDED
      const r4 = await coordinator.reconcileSwap(executionId);
      assert.strictEqual(r4.recoveryRequired, true);
      assert.ok(r4.failureReason?.includes('retry limit (3) exceeded'));
      const trans = persistence.getSovereignTransitions(executionId).slice(-1)[0];
      assert.strictEqual(trans.reason, 'MAX_RETRIES_EXCEEDED');
    });

    it('5.7: Side-effecting mutation processRefund strictly exhausts retry budget after maxRetries', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const fakeLightning = new ConfigurableLightning();
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);
      const { coordinator } = setupTestCoordinator(fakeLightning, fakeEvm, 3);

      const executionId = 'mut-refund-fail';
      const hashLock = '0x' + 'b7'.repeat(32);
      const evmSwapKey = `swap_${executionId}`;
      const reservation = persistence.reserveLiquidity(executionId, token, 20_000_000n, {
        allowLegacyFallback: true,
      });

      fakeLightning.setInvoiceState(hashLock, 'ACCEPTED');
      fakeEvm.setHtlcState(evmSwapKey, {
        funded: true,
        completed: false,
        refunded: false,
        balance: 20_000_000n,
        timelock: 1000,
        blockTimestamp: 2000, // Expired timelock!
      });
      fakeEvm.refundError = new Error('EVM refund broadcast failed');

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'obs-limit-key-7',
        hashLock,
        claimingAddress: operator,
        targetDestinationAddress: operator,
        amountSats: 10_000n,
        expectedUsdcAmount: 20_000_000n,
        state: SovereignAtomicState.EVM_FUNDED,
        evmHtlcId: `0x_mock_${evmSwapKey}`,
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
        retryCount: 0,
      }, 'test-fp-obs-7');

      // 3 attempts -> retryCount reaches 3
      await coordinator.reconcileSwap(executionId);
      await coordinator.reconcileSwap(executionId);
      await coordinator.reconcileSwap(executionId);

      // 4th pass: maxRetries exceeded
      const res = await coordinator.reconcileSwap(executionId);
      assert.strictEqual(res.recoveryRequired, true);
      assert.ok(res.failureReason?.includes('retries (3) exceeded'));
      const trans = persistence.getSovereignTransitions(executionId).slice(-1)[0];
      assert.strictEqual(trans.reason, 'MAX_RETRIES_EXCEEDED');
    });

    it('5.8: Side-effecting mutation settleLightningFromEvmClaim strictly exhausts retry budget after maxRetries', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const fakeLightning = new ConfigurableLightning();
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);
      const { coordinator } = setupTestCoordinator(fakeLightning, fakeEvm, 3);

      const executionId = 'mut-settle-fail';
      const hashLock = '0x' + 'b8'.repeat(32);
      const evmSwapKey = `swap_${executionId}`;
      const reservation = persistence.reserveLiquidity(executionId, token, 20_000_000n, {
        allowLegacyFallback: true,
      });

      fakeLightning.setInvoiceState(hashLock, 'ACCEPTED');
      fakeLightning.settleError = new Error('LND settle RPC unavailable');

      fakeEvm.setHtlcState(evmSwapKey, {
        funded: true,
        completed: true, // CLAIMED onchain
        refunded: false,
        balance: 20_000_000n,
      });

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'obs-limit-key-8',
        hashLock,
        claimingAddress: operator,
        targetDestinationAddress: operator,
        amountSats: 10_000n,
        expectedUsdcAmount: 20_000_000n,
        state: SovereignAtomicState.EVM_FUNDED,
        evmHtlcId: `0x_mock_${evmSwapKey}`,
        evmClaimTxHash: '0x' + '99'.repeat(32),
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
        retryCount: 0,
      }, 'test-fp-obs-8');

      // Pass 1: attempts settlement, increments retryCount to 1
      await coordinator.reconcileSwap(executionId);
      let r1 = persistence.getSovereignSwap(executionId)!;
      assert.strictEqual(r1.retryCount, 1);

      // Simulate retry count reaching maxRetries (3)
      persistence.updateSovereignSwap(executionId, { settleRetryCount: 3, retryCount: 3 });

      // Next pass: maxRetries exceeded
      const res = await coordinator.reconcileSwap(executionId);
      assert.strictEqual(res.recoveryRequired, true);
      assert.ok(res.failureReason?.includes('settle'));
      const trans = persistence.getSovereignTransitions(executionId).slice(-1)[0];
      assert.strictEqual(trans.reason, 'MAX_RETRIES_EXCEEDED');
    });

    it('5.9: Side-effecting mutation cancelHoldInvoice strictly exhausts retry budget after maxRetries', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const fakeLightning = new ConfigurableLightning();
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);
      const { coordinator } = setupTestCoordinator(fakeLightning, fakeEvm, 3);

      const executionId = 'mut-cancel-fail';
      const hashLock = '0x' + 'b9'.repeat(32);
      const evmSwapKey = `swap_${executionId}`;
      const reservation = persistence.reserveLiquidity(executionId, token, 20_000_000n, {
        allowLegacyFallback: true,
      });

      fakeLightning.setInvoiceState(hashLock, 'ACCEPTED');
      fakeLightning.cancelError = new Error('LND cancel RPC failed');

      fakeEvm.setHtlcState(evmSwapKey, {
        funded: false,
        completed: false,
        refunded: true, // REFUNDED onchain
        balance: 0n,
      });

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'obs-limit-key-9',
        hashLock,
        claimingAddress: operator,
        targetDestinationAddress: operator,
        amountSats: 10_000n,
        expectedUsdcAmount: 20_000_000n,
        state: SovereignAtomicState.EVM_FUNDED,
        evmHtlcId: `0x_mock_${evmSwapKey}`,
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
        retryCount: 0,
      }, 'test-fp-obs-9');

      // 3 attempts
      await coordinator.reconcileSwap(executionId);
      await coordinator.reconcileSwap(executionId);
      await coordinator.reconcileSwap(executionId);

      // 4th pass: maxRetries exceeded
      const res = await coordinator.reconcileSwap(executionId);
      assert.strictEqual(res.recoveryRequired, true);
      assert.ok(res.failureReason?.includes('retries (3) exceeded') || res.failureReason?.includes('retry limit'));
    });
  });

  // =========================================================================
  // SUITE 6: BLOCKER 2 — FAIL-CLOSED ATOMIC commitReservationAndAdvanceSwapToFunded()
  // =========================================================================
  describe('Blocker 2: Fail-Closed Atomic commitReservationAndAdvanceSwapToFunded()', () => {
    it('6.1: Healthy match commits reservation to COMMITTED and advances swap EVM_FUNDING_PENDING -> EVM_FUNDED', () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const swapId = 'commit-match-swap';
      const hashLock = '0x' + 'c1'.repeat(32);
      const res = persistence.reserveLiquidity(swapId, token, 25_000_000n, { allowLegacyFallback: true });

      persistence.createSovereignSwap({
        id: swapId,
        idempotencyKey: 'commit-match-idemp',
        hashLock,
        claimingAddress: operator,
        targetDestinationAddress: operator,
        amountSats: 10_000n,
        expectedUsdcAmount: 25_000_000n,
        state: SovereignAtomicState.EVM_FUNDING_PENDING,
        reservationId: res.reservationId,
        reservedAmountUnits: 25_000_000n,
        reservationStatus: 'RESERVED',
        tokenAddress: token,
        refundAddress: operator,
        evmSwapKey: `swap_${swapId}`,
        cltvExpiryBlocks: 144,
        timelockSeconds: 3600,
        createdAt: new Date(),
        updatedAt: new Date(),
      }, 'fp-commit-1');

      // Execute atomic transaction
      persistence.commitReservationAndAdvanceSwapToFunded(res.reservationId, swapId);

      // Verify DB state
      const updatedRes = persistence.getLiquidityReservation(res.reservationId)!;
      assert.strictEqual(updatedRes.status, 'COMMITTED');

      const updatedSwap = persistence.getSovereignSwap(swapId)!;
      assert.strictEqual(updatedSwap.state, SovereignAtomicState.EVM_FUNDED);
      assert.strictEqual(updatedSwap.reservationStatus, 'COMMITTED');
      assert.strictEqual(updatedSwap.recoveryRequired, false);

      // Verify audit entry exists
      const audit = persistence.getSovereignTransitions(swapId);
      assert.ok(audit.some(e => e.toState === SovereignAtomicState.EVM_FUNDED && e.reason === 'RESERVATION_COMMITTED_EVM_FUNDED_CONVERGED'));
    });

    it('6.2: Idempotent replay when reservation is already COMMITTED succeeds without error', () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const swapId = 'commit-idemp-swap';
      const hashLock = '0x' + 'c2'.repeat(32);
      const res = persistence.reserveLiquidity(swapId, token, 15_000_000n, { allowLegacyFallback: true });

      persistence.createSovereignSwap({
        id: swapId,
        idempotencyKey: 'commit-idemp-idemp',
        hashLock,
        claimingAddress: operator,
        targetDestinationAddress: operator,
        amountSats: 10_000n,
        expectedUsdcAmount: 15_000_000n,
        state: SovereignAtomicState.EVM_FUNDING_PENDING,
        reservationId: res.reservationId,
        reservedAmountUnits: 15_000_000n,
        reservationStatus: 'RESERVED',
        tokenAddress: token,
        refundAddress: operator,
        evmSwapKey: `swap_${swapId}`,
        cltvExpiryBlocks: 144,
        timelockSeconds: 3600,
        createdAt: new Date(),
        updatedAt: new Date(),
      }, 'fp-commit-2');

      // First commit
      persistence.commitReservationAndAdvanceSwapToFunded(res.reservationId, swapId);

      // Replay commit
      assert.doesNotThrow(() => {
        persistence.commitReservationAndAdvanceSwapToFunded(res.reservationId, swapId);
      });

      const updatedRes = persistence.getLiquidityReservation(res.reservationId)!;
      assert.strictEqual(updatedRes.status, 'COMMITTED');
      const updatedSwap = persistence.getSovereignSwap(swapId)!;
      assert.strictEqual(updatedSwap.state, SovereignAtomicState.EVM_FUNDED);
      assert.strictEqual(updatedSwap.reservationStatus, 'COMMITTED');
    });

    it('6.3: Missing reservation throws RESERVATION_NOT_FOUND and leaves swap unchanged', () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const swapId = 'commit-missing-res-swap';
      const hashLock = '0x' + 'c3'.repeat(32);

      persistence.createSovereignSwap({
        id: swapId,
        idempotencyKey: 'commit-missing-res-idemp',
        hashLock,
        claimingAddress: operator,
        targetDestinationAddress: operator,
        amountSats: 10_000n,
        expectedUsdcAmount: 15_000_000n,
        state: SovereignAtomicState.EVM_FUNDING_PENDING,
        reservationId: 'non-existent-res',
        reservedAmountUnits: 15_000_000n,
        reservationStatus: 'RESERVED',
        tokenAddress: token,
        refundAddress: operator,
        evmSwapKey: `swap_${swapId}`,
        cltvExpiryBlocks: 144,
        timelockSeconds: 3600,
        createdAt: new Date(),
        updatedAt: new Date(),
      }, 'fp-commit-3');

      assert.throws(
        () => persistence.commitReservationAndAdvanceSwapToFunded('non-existent-res', swapId),
        /RESERVATION_NOT_FOUND/
      );

      const swap = persistence.getSovereignSwap(swapId)!;
      assert.strictEqual(swap.state, SovereignAtomicState.EVM_FUNDING_PENDING);
    });

    it('6.4: Released reservation throws INVALID_RESERVATION_STATUS, keeps reservation RELEASED, leaves swap unchanged', () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const swapId = 'commit-released-swap';
      const hashLock = '0x' + 'c4'.repeat(32);
      const res = persistence.reserveLiquidity(swapId, token, 15_000_000n, { allowLegacyFallback: true });
      persistence.releaseLiquidityReservation(res.reservationId);

      persistence.createSovereignSwap({
        id: swapId,
        idempotencyKey: 'commit-released-idemp',
        hashLock,
        claimingAddress: operator,
        targetDestinationAddress: operator,
        amountSats: 10_000n,
        expectedUsdcAmount: 15_000_000n,
        state: SovereignAtomicState.EVM_FUNDING_PENDING,
        reservationId: res.reservationId,
        reservedAmountUnits: 15_000_000n,
        reservationStatus: 'RELEASED',
        tokenAddress: token,
        refundAddress: operator,
        evmSwapKey: `swap_${swapId}`,
        cltvExpiryBlocks: 144,
        timelockSeconds: 3600,
        createdAt: new Date(),
        updatedAt: new Date(),
      }, 'fp-commit-4');

      assert.throws(
        () => persistence.commitReservationAndAdvanceSwapToFunded(res.reservationId, swapId),
        /INVALID_RESERVATION_STATUS.*RELEASED/
      );

      // Verify no silent resurrection!
      const resInDb = persistence.getLiquidityReservation(res.reservationId)!;
      assert.strictEqual(resInDb.status, 'RELEASED');

      const swapInDb = persistence.getSovereignSwap(swapId)!;
      assert.strictEqual(swapInDb.state, SovereignAtomicState.EVM_FUNDING_PENDING);
    });

    it('6.5: Settled reservation throws INVALID_RESERVATION_STATUS and leaves swap unchanged', () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const swapId = 'commit-settled-swap';
      const hashLock = '0x' + 'c5'.repeat(32);
      const res = persistence.reserveLiquidity(swapId, token, 15_000_000n, { allowLegacyFallback: true });
      // Settle reservation
      persistence.settleLiquidityReservation(res.reservationId);

      persistence.createSovereignSwap({
        id: swapId,
        idempotencyKey: 'commit-settled-idemp',
        hashLock,
        claimingAddress: operator,
        targetDestinationAddress: operator,
        amountSats: 10_000n,
        expectedUsdcAmount: 15_000_000n,
        state: SovereignAtomicState.EVM_FUNDING_PENDING,
        reservationId: res.reservationId,
        reservedAmountUnits: 15_000_000n,
        reservationStatus: 'SETTLED',
        tokenAddress: token,
        refundAddress: operator,
        evmSwapKey: `swap_${swapId}`,
        cltvExpiryBlocks: 144,
        timelockSeconds: 3600,
        createdAt: new Date(),
        updatedAt: new Date(),
      }, 'fp-commit-5');

      assert.throws(
        () => persistence.commitReservationAndAdvanceSwapToFunded(res.reservationId, swapId),
        /INVALID_RESERVATION_STATUS.*SETTLED/
      );

      const resInDb = persistence.getLiquidityReservation(res.reservationId)!;
      assert.strictEqual(resInDb.status, 'SETTLED');

      const swapInDb = persistence.getSovereignSwap(swapId)!;
      assert.strictEqual(swapInDb.state, SovereignAtomicState.EVM_FUNDING_PENDING);
    });

    it('6.6: Reservation owned by different swap throws RESERVATION_OWNER_MISMATCH and mutates neither', () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const swapId = 'commit-owner-swap-1';
      const otherSwapId = 'commit-owner-swap-other';
      const hashLock = '0x' + 'c6'.repeat(32);
      const res = persistence.reserveLiquidity(otherSwapId, token, 15_000_000n, { allowLegacyFallback: true });

      persistence.createSovereignSwap({
        id: swapId,
        idempotencyKey: 'commit-owner-idemp',
        hashLock,
        claimingAddress: operator,
        targetDestinationAddress: operator,
        amountSats: 10_000n,
        expectedUsdcAmount: 15_000_000n,
        state: SovereignAtomicState.EVM_FUNDING_PENDING,
        reservationId: res.reservationId,
        reservedAmountUnits: 15_000_000n,
        reservationStatus: 'RESERVED',
        tokenAddress: token,
        refundAddress: operator,
        evmSwapKey: `swap_${swapId}`,
        cltvExpiryBlocks: 144,
        timelockSeconds: 3600,
        createdAt: new Date(),
        updatedAt: new Date(),
      }, 'fp-commit-6');

      assert.throws(
        () => persistence.commitReservationAndAdvanceSwapToFunded(res.reservationId, swapId),
        /RESERVATION_OWNER_MISMATCH/
      );

      const resInDb = persistence.getLiquidityReservation(res.reservationId)!;
      assert.strictEqual(resInDb.status, 'RESERVED');
      assert.strictEqual(resInDb.executionId, otherSwapId);

      const swapInDb = persistence.getSovereignSwap(swapId)!;
      assert.strictEqual(swapInDb.state, SovereignAtomicState.EVM_FUNDING_PENDING);
    });

    it('6.7: Swap with mismatched reservation_id throws SWAP_RESERVATION_MISMATCH and rolls back', () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const swapId = 'commit-swap-res-mismatch';
      const hashLock = '0x' + 'c7'.repeat(32);
      const res1 = persistence.reserveLiquidity(swapId, token, 15_000_000n, { allowLegacyFallback: true });

      persistence.createSovereignSwap({
        id: swapId,
        idempotencyKey: 'commit-swap-res-mismatch-idemp',
        hashLock,
        claimingAddress: operator,
        targetDestinationAddress: operator,
        amountSats: 10_000n,
        expectedUsdcAmount: 15_000_000n,
        state: SovereignAtomicState.EVM_FUNDING_PENDING,
        reservationId: randomUUID(), // Deliberately mismatched UUID!
        reservedAmountUnits: 15_000_000n,
        reservationStatus: 'RESERVED',
        tokenAddress: token,
        refundAddress: operator,
        evmSwapKey: `swap_${swapId}`,
        cltvExpiryBlocks: 144,
        timelockSeconds: 3600,
        createdAt: new Date(),
        updatedAt: new Date(),
      }, 'fp-commit-7');

      // Calling with res1, which does not match swap.reservation_id
      assert.throws(
        () => persistence.commitReservationAndAdvanceSwapToFunded(res1.reservationId, swapId),
        /SWAP_RESERVATION_MISMATCH/
      );

      // Verify transaction rollback: res1 must remain RESERVED!
      const res1InDb = persistence.getLiquidityReservation(res1.reservationId)!;
      assert.strictEqual(res1InDb.status, 'RESERVED', 'res1 must remain RESERVED due to rollback');

      const swapInDb = persistence.getSovereignSwap(swapId)!;
      assert.strictEqual(swapInDb.state, SovereignAtomicState.EVM_FUNDING_PENDING);
    });

    it('6.8: Missing swap throws SOVEREIGN_SWAP_NOT_FOUND and rolls back reservation', () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const res = persistence.reserveLiquidity('missing-swap-id', token, 15_000_000n, { allowLegacyFallback: true });

      assert.throws(
        () => persistence.commitReservationAndAdvanceSwapToFunded(res.reservationId, 'missing-swap-id'),
        /SOVEREIGN_SWAP_NOT_FOUND/
      );

      const resInDb = persistence.getLiquidityReservation(res.reservationId)!;
      assert.strictEqual(resInDb.status, 'RESERVED', 'Reservation must remain RESERVED due to rollback');
    });

    it('6.9: Chain Reconciler: Onchain LOCKED HTLC with locally RELEASED reservation throws and marks RECOVERY_REQUIRED', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const swapId = 'reconciler-released-res-swap';
      const hashLock = '0x' + 'c9'.repeat(32);
      const evmSwapKey = `swap_${swapId}`;
      const res = persistence.reserveLiquidity(swapId, token, 20_000_000n, { allowLegacyFallback: true });
      persistence.releaseLiquidityReservation(res.reservationId);

      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);
      fakeEvm.setHtlcState(evmSwapKey, {
        funded: true,
        completed: false,
        refunded: false,
        balance: 20_000_000n,
      });

      persistence.createSovereignSwap({
        id: swapId,
        idempotencyKey: 'reconciler-released-idemp',
        hashLock,
        claimingAddress: operator,
        targetDestinationAddress: operator,
        amountSats: 10_000n,
        expectedUsdcAmount: 20_000_000n,
        state: SovereignAtomicState.EVM_FUNDING_PENDING,
        evmHtlcId: `0x_mock_${evmSwapKey}`,
        reservationId: res.reservationId,
        reservedAmountUnits: 20_000_000n,
        reservationStatus: 'RELEASED',
        tokenAddress: token,
        refundAddress: operator,
        evmSwapKey,
        cltvExpiryBlocks: 144,
        timelockSeconds: 3600,
        createdAt: new Date(),
        updatedAt: new Date(),
      }, 'fp-commit-9');

      // Create durable intent in CONFIRMED state
      const intent = persistence.getOrCreateEvmIntent({
        swapKey: evmSwapKey,
        chainId: 84532,
        signerAddress: operator as `0x${string}`,
        actionType: 'FUND',
        targetAddress: '0x1111111111111111111111111111111111111111',
        calldata: '0x',
      });
      persistence.markEvmIntentConfirmedByChainEvidence(intent.id, ('0x' + '11'.repeat(32)) as `0x${string}`);

      const reconciler = new ChainInventoryReconciler({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: token,
        expectedChainId: 84532,
        policy: BASE_SEPOLIA_TEST_POLICY,
      });

      const result = await reconciler.reconcileOnBoot(token);
      assert.strictEqual(result.readinessState, 'UNKNOWN');
      assert.ok(result.error?.includes('RESERVATION_COMMIT_FAILED') || result.error?.includes('INVALID_RESERVATION_STATUS'));

      // The swap is marked RECOVERY_REQUIRED
      const swapInDb = persistence.getSovereignSwap(swapId)!;
      assert.strictEqual(swapInDb.recoveryRequired, true);
      assert.ok(swapInDb.failureReason?.includes('reservation commit failed') || swapInDb.failureReason?.includes('INVALID_RESERVATION_STATUS'));
      const trans = persistence.getSovereignTransitions(swapId).slice(-1)[0];
      assert.strictEqual(trans.reason, 'RESERVATION_COMMIT_FAILED');

      // The reservation is STILL RELEASED (never silently resurrected to COMMITTED)
      const resInDb = persistence.getLiquidityReservation(res.reservationId)!;
      assert.strictEqual(resInDb.status, 'RELEASED');
    });
  });

  // =========================================================================
  // SUITE 7: COMBINED INTERACTION TEST
  // =========================================================================
  describe('Combined Interaction: Invariant Recovery Resumes Observation Past Mutation Budget', () => {
    it('7.1: Reservation failure marks RECOVERY_REQUIRED; after operator data correction, reconciliation succeeds past maxRetries without being blocked', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const fakeLightning = new ConfigurableLightning();
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);

      const reconciler = new ChainInventoryReconciler({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: token,
        expectedChainId: 84532,
        policy: BASE_SEPOLIA_TEST_POLICY,
      });
      const inventory = new SqliteLiquidityInventory(persistence, { reconciler });
      const coordinator = new AtomicCoordinator(fakeLightning, fakeEvm, inventory, {
        persistence,
        finalityPolicy: fakeEvm.finalityPolicy,
        maxRetries: 3,
      });

      const executionId = 'combined-recovery-test';
      const hashLock = '0x' + 'd1'.repeat(32);
      const evmSwapKey = `swap_${executionId}`;

      fakeLightning.setInvoiceState(hashLock, 'ACCEPTED');
      fakeEvm.setHtlcState(evmSwapKey, {
        funded: true,
        completed: false,
        refunded: false,
        balance: 20_000_000n,
        timelock: Math.floor(Date.now() / 1000) + 3600,
        blockTimestamp: Math.floor(Date.now() / 1000),
      });

      // Create a reservation that is incorrectly RELEASED
      const res = persistence.reserveLiquidity(executionId, token, 20_000_000n, { allowLegacyFallback: true });
      persistence.releaseLiquidityReservation(res.reservationId);

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'combined-idemp-1',
        hashLock,
        claimingAddress: operator,
        targetDestinationAddress: operator,
        amountSats: 10_000n,
        expectedUsdcAmount: 20_000_000n,
        state: SovereignAtomicState.EVM_FUNDING_PENDING,
        evmHtlcId: `0x_mock_${evmSwapKey}`,
        reservationId: res.reservationId,
        reservedAmountUnits: 20_000_000n,
        reservationStatus: 'RELEASED',
        tokenAddress: token,
        refundAddress: operator,
        evmSwapKey,
        cltvExpiryBlocks: 144,
        timelockSeconds: 3600,
        createdAt: new Date(),
        updatedAt: new Date(),
        retryCount: 10, // Pre-exhausted beyond maxRetries = 3!
        recoveryRequired: true,
        failureReason: 'RESERVATION_COMMIT_FAILED',
      }, 'test-fp-comb-1');

      // Attempt reconcile: fails because reservation is RELEASED
      const r1 = await coordinator.reconcileSwap(executionId);
      assert.strictEqual(r1.recoveryRequired, true);
      assert.ok(r1.failureReason?.includes('reservation commit failed') || r1.failureReason?.includes('INVALID_RESERVATION_STATUS'));

      // Now operator fixes the data: updates reservation status to RESERVED so commit can proceed
      (persistence as any).db.prepare('UPDATE liquidity_reservations SET status = ? WHERE id = ?').run('RESERVED', res.reservationId);

      // Reconcile again: Even though retryCount = 10 (exceeds maxRetries = 3),
      // read-only observation and commit succeed without being blocked by retry limit!
      const r2 = await coordinator.reconcileSwap(executionId);
      assert.strictEqual(r2.state, SovereignAtomicState.EVM_FUNDED);
      assert.strictEqual(r2.reservationStatus, 'COMMITTED');
      assert.strictEqual(r2.recoveryRequired, false);
      assert.strictEqual(r2.failureReason, undefined);
    });
  });
  // =========================================================================
  // SUITE 8: FINAL RESERVATION & RETRY ISOLATION GAPS
  // =========================================================================
  describe('Suite 8: Final Reservation & Retry Isolation Gaps', () => {
    function setupTestCoordinator(lightning: ConfigurableLightning, evm: ConfigurableEvm, maxReconciliationRetries = 3) {
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
        maxRetries: maxReconciliationRetries,
      });
      return { coordinator, inventory, reconciler };
    }
    // 1) MISSING RESERVATION MUST FAIL CLOSED
    it('8.1: Base FUNDED / LOCKED + missing reservationId fails closed into RECOVERY_REQUIRED', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const fakeLightning = new ConfigurableLightning();
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);
      const { coordinator } = setupTestCoordinator(fakeLightning, fakeEvm, 3);

      const executionId = 'missing-res-funded';
      const hashLock = '0x' + 'e1'.repeat(32);
      const evmSwapKey = `swap_${executionId}`;

      fakeLightning.setInvoiceState(hashLock, 'ACCEPTED');
      fakeEvm.setHtlcState(evmSwapKey, {
        funded: true,
        completed: false,
        refunded: false,
        balance: 20_000_000n,
        timelock: 5000,
        blockTimestamp: 1000,
      });

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'missing-res-funded-idemp',
        hashLock,
        claimingAddress: operator,
        targetDestinationAddress: operator,
        amountSats: 10_000n,
        expectedUsdcAmount: 20_000_000n,
        state: SovereignAtomicState.EVM_FUNDING_PENDING,
        evmHtlcId: `0x_mock_${evmSwapKey}`,
        reservationId: undefined,
        tokenAddress: token,
        refundAddress: operator,
        evmSwapKey,
        cltvExpiryBlocks: 144,
        timelockSeconds: 3600,
        createdAt: new Date(),
        updatedAt: new Date(),
      }, 'test-fp-8-1');

      const res = await coordinator.reconcileSwap(executionId);
      assert.strictEqual(res.recoveryRequired, true);
      assert.strictEqual(res.state, SovereignAtomicState.RECOVERY_REQUIRED);
      assert.notEqual(res.reservationStatus, 'COMMITTED');
      assert.ok(res.failureReason?.includes('no valid reservationId'));
    });

    it('8.2: Base CLAIMED + missing reservationId fails closed into RECOVERY_REQUIRED', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const fakeLightning = new ConfigurableLightning();
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);
      const { coordinator } = setupTestCoordinator(fakeLightning, fakeEvm, 3);

      const executionId = 'missing-res-claimed';
      const hashLock = '0x' + 'e2'.repeat(32);
      const evmSwapKey = `swap_${executionId}`;

      fakeLightning.setInvoiceState(hashLock, 'ACCEPTED');
      fakeEvm.setHtlcState(evmSwapKey, {
        funded: true,
        completed: true,
        refunded: false,
        balance: 20_000_000n,
      });

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'missing-res-claimed-idemp',
        hashLock,
        claimingAddress: operator,
        targetDestinationAddress: operator,
        amountSats: 10_000n,
        expectedUsdcAmount: 20_000_000n,
        state: SovereignAtomicState.EVM_FUNDING_PENDING,
        evmHtlcId: `0x_mock_${evmSwapKey}`,
        reservationId: undefined,
        tokenAddress: token,
        refundAddress: operator,
        evmSwapKey,
        cltvExpiryBlocks: 144,
        timelockSeconds: 3600,
        createdAt: new Date(),
        updatedAt: new Date(),
      }, 'test-fp-8-2');

      const res = await coordinator.reconcileSwap(executionId);
      assert.strictEqual(res.recoveryRequired, true);
      assert.strictEqual(res.state, SovereignAtomicState.RECOVERY_REQUIRED);
      assert.notEqual(res.reservationStatus, 'COMMITTED');
      assert.notEqual(res.reservationStatus, 'SETTLED');
      assert.ok(res.failureReason?.includes('no valid reservationId'));
    });

    it('8.3: Base LOCKED seen by chain reconciler + missing reservation throws and marks RECOVERY_REQUIRED', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);

      const executionId = 'reconciler-missing-res';
      const hashLock = '0x' + 'e3'.repeat(32);
      const evmSwapKey = `swap_${executionId}`;
      const htlcId = `0x_mock_${evmSwapKey}`;

      fakeEvm.setHtlcState(evmSwapKey, { funded: true, balance: 20_000_000n });

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'reconciler-missing-res-idemp',
        hashLock,
        claimingAddress: operator,
        targetDestinationAddress: operator,
        amountSats: 10_000n,
        expectedUsdcAmount: 20_000_000n,
        state: SovereignAtomicState.EVM_FUNDED,
        evmHtlcId: htlcId,
        reservationId: undefined,
        tokenAddress: token,
        refundAddress: operator,
        evmSwapKey,
        cltvExpiryBlocks: 144,
        timelockSeconds: 3600,
        createdAt: new Date(),
        updatedAt: new Date(),
      }, 'test-fp-8-3');

      const reconciler = new ChainInventoryReconciler({
        persistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: token,
        expectedChainId: 84532,
        policy: BASE_SEPOLIA_TEST_POLICY,
      });

      const res = await reconciler.reconcileOnBoot(token);
      assert.strictEqual(res.readinessState, 'UNKNOWN');
      assert.ok(res.error?.includes('MISSING_RESERVATION_ID'));

      const swapInDb = persistence.getSovereignSwap(executionId)!;
      assert.strictEqual(swapInDb.recoveryRequired, true);
      assert.strictEqual(swapInDb.state, SovereignAtomicState.RECOVERY_REQUIRED);
      assert.notEqual(swapInDb.reservationStatus, 'COMMITTED');
    });

    // 2) ACTION-SCOPED RETRY BUDGET
    it('8.4: Exhausting FUND retry budget does NOT consume SETTLE budget', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const fakeLightning = new ConfigurableLightning();
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);
      const { coordinator } = setupTestCoordinator(fakeLightning, fakeEvm, 3);

      const executionId = 'fund-exhaust-settle-ok';
      const hashLock = '0x' + 'e4'.repeat(32);
      const evmSwapKey = `swap_${executionId}`;
      const res = persistence.reserveLiquidity(executionId, token, 20_000_000n, { allowLegacyFallback: true });

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'fund-exhaust-settle-ok-idemp',
        hashLock,
        claimingAddress: operator,
        targetDestinationAddress: operator,
        amountSats: 10_000n,
        expectedUsdcAmount: 20_000_000n,
        state: SovereignAtomicState.EVM_FUNDED,
        evmHtlcId: `0x_mock_${evmSwapKey}`,
        evmClaimTxHash: '0x' + '44'.repeat(32),
        reservationId: res.reservationId,
        reservedAmountUnits: 20_000_000n,
        reservationStatus: 'COMMITTED',
        tokenAddress: token,
        refundAddress: operator,
        evmSwapKey,
        cltvExpiryBlocks: 144,
        timelockSeconds: 3600,
        createdAt: new Date(),
        updatedAt: new Date(),
        fundRetryCount: 3,
        settleRetryCount: 0,
        retryCount: 3,
      }, 'test-fp-8-4');

      fakeLightning.setInvoiceState(hashLock, 'ACCEPTED');
      fakeEvm.setHtlcState(evmSwapKey, {
        funded: true,
        completed: true,
        refunded: false,
        balance: 20_000_000n,
      });

      await coordinator.reconcileSwap(executionId);
      const swap = persistence.getSovereignSwap(executionId)!;
      assert.strictEqual(swap.settleRetryCount, 1);
      assert.strictEqual(swap.fundRetryCount, 3);
    });

    it('8.5: Exhausting CANCEL retry budget does NOT affect REFUND or SETTLE budget', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const fakeLightning = new ConfigurableLightning();
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);
      const { coordinator } = setupTestCoordinator(fakeLightning, fakeEvm, 3);

      const executionId = 'cancel-exhaust-refund-ok';
      const hashLock = '0x' + 'e5'.repeat(32);
      const evmSwapKey = `swap_${executionId}`;
      const res = persistence.reserveLiquidity(executionId, token, 20_000_000n, { allowLegacyFallback: true });

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'cancel-exhaust-refund-ok-idemp',
        hashLock,
        claimingAddress: operator,
        targetDestinationAddress: operator,
        amountSats: 10_000n,
        expectedUsdcAmount: 20_000_000n,
        state: SovereignAtomicState.EVM_FUNDED,
        evmHtlcId: `0x_mock_${evmSwapKey}`,
        reservationId: res.reservationId,
        reservedAmountUnits: 20_000_000n,
        reservationStatus: 'COMMITTED',
        tokenAddress: token,
        refundAddress: operator,
        evmSwapKey,
        cltvExpiryBlocks: 144,
        timelockSeconds: 3600,
        createdAt: new Date(),
        updatedAt: new Date(),
        cancelRetryCount: 3,
        refundRetryCount: 0,
        retryCount: 3,
      }, 'test-fp-8-5');

      fakeLightning.setInvoiceState(hashLock, 'ACCEPTED');
      fakeEvm.setHtlcState(evmSwapKey, {
        funded: true,
        completed: false,
        refunded: false,
        balance: 20_000_000n,
        timelock: 1000,
        blockTimestamp: 2000,
      });
      fakeEvm.refundError = new Error('RPC transient drop');

      await coordinator.reconcileSwap(executionId);
      const swap = persistence.getSovereignSwap(executionId)!;
      assert.strictEqual(swap.refundRetryCount, 1);
      assert.strictEqual(swap.cancelRetryCount, 3);
    });

    it('8.6: Observation remains unlimited regardless of individual retry budgets', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const fakeLightning = new ConfigurableLightning();
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);
      const { coordinator } = setupTestCoordinator(fakeLightning, fakeEvm, 3);

      const executionId = 'obs-unlimited-suite8';
      const hashLock = '0x' + 'e6'.repeat(32);
      const evmSwapKey = `swap_${executionId}`;
      const res = persistence.reserveLiquidity(executionId, token, 20_000_000n, { allowLegacyFallback: true });

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'obs-unlimited-suite8-idemp',
        hashLock,
        claimingAddress: operator,
        targetDestinationAddress: operator,
        amountSats: 10_000n,
        expectedUsdcAmount: 20_000_000n,
        state: SovereignAtomicState.INVOICE_CREATED,
        reservationId: res.reservationId,
        reservedAmountUnits: 20_000_000n,
        reservationStatus: 'RESERVED',
        tokenAddress: token,
        refundAddress: operator,
        evmSwapKey,
        cltvExpiryBlocks: 144,
        timelockSeconds: 3600,
        createdAt: new Date(),
        updatedAt: new Date(),
        fundRetryCount: 10,
        settleRetryCount: 10,
        refundRetryCount: 10,
        cancelRetryCount: 10,
        retryCount: 40,
      }, 'test-fp-8-6');

      fakeLightning.setInvoiceState(hashLock, 'OPEN');
      fakeEvm.setHtlcState(evmSwapKey, {
        funded: false,
        completed: false,
        refunded: false,
        balance: 0n,
      });

      for (let i = 0; i < 5; i++) {
        const r = await coordinator.reconcileSwap(executionId);
        assert.strictEqual(r.recoveryRequired, false);
        assert.strictEqual(r.state, SovereignAtomicState.INVOICE_CREATED);
      }
    });
  });

  // =========================================================================
  // SUITE 9: RESERVATION INTEGRITY & TRANSITION FAIL-CLOSED
  // =========================================================================
  describe('Suite 9: Reservation Integrity & Transition Fail-Closed', () => {
    function setupTestCoordinator(lightning: ConfigurableLightning, evm: ConfigurableEvm, maxReconciliationRetries = 3) {
      const inventory = new SqliteLiquidityInventory(persistence);
      const coordinator = new AtomicCoordinator(lightning, evm, inventory, {
        persistence,
        finalityPolicy: evm.finalityPolicy,
        maxRetries: maxReconciliationRetries,
      });
      return { inventory, coordinator };
    }

    it('9.1: CLAIMED + LN SETTLED + stale reservationId but reservation row missing -> RECOVERY_REQUIRED, not COMPLETED', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const fakeLightning = new ConfigurableLightning();
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);
      const { coordinator } = setupTestCoordinator(fakeLightning, fakeEvm);

      const executionId = 'test-suite-9-1';
      const hashLock = '0x' + '91'.repeat(32);
      const evmSwapKey = `swap_${executionId}`;

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'test-suite-9-1-idemp',
        hashLock,
        claimingAddress: operator,
        targetDestinationAddress: operator,
        amountSats: 10_000n,
        expectedUsdcAmount: 20_000_000n,
        state: SovereignAtomicState.EVM_FUNDED,
        reservationId: 'missing-res-row-9-1',
        tokenAddress: token,
        refundAddress: operator,
        evmSwapKey,
        cltvExpiryBlocks: 144,
        timelockSeconds: 3600,
        createdAt: new Date(),
        updatedAt: new Date(),
      }, 'test-fp-9-1');

      fakeLightning.setInvoiceState(hashLock, 'SETTLED');
      fakeEvm.setHtlcState(evmSwapKey, {
        funded: false,
        completed: true,
        refunded: false,
        balance: 20_000_000n,
      });

      const r = await coordinator.reconcileSwap(executionId);
      assert.strictEqual(r.recoveryRequired, true);
      assert.strictEqual(r.state, SovereignAtomicState.RECOVERY_REQUIRED);
      assert.notEqual(r.state, SovereignAtomicState.COMPLETED);
      assert.notEqual(r.reservationStatus, 'SETTLED');

      const swapInDb = persistence.getSovereignSwap(executionId)!;
      assert.strictEqual(swapInDb.recoveryRequired, true);
      assert.strictEqual(swapInDb.state, SovereignAtomicState.RECOVERY_REQUIRED);
      assert.notEqual(swapInDb.state, SovereignAtomicState.COMPLETED);
    });

    it('9.2: REFUNDED + reservation row missing -> RECOVERY_REQUIRED, not REFUNDED', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const fakeLightning = new ConfigurableLightning();
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);
      const { coordinator } = setupTestCoordinator(fakeLightning, fakeEvm);

      const executionId = 'test-suite-9-2';
      const hashLock = '0x' + '92'.repeat(32);
      const evmSwapKey = `swap_${executionId}`;

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'test-suite-9-2-idemp',
        hashLock,
        claimingAddress: operator,
        targetDestinationAddress: operator,
        amountSats: 10_000n,
        expectedUsdcAmount: 20_000_000n,
        state: SovereignAtomicState.EVM_FUNDED,
        reservationId: 'missing-res-row-9-2',
        tokenAddress: token,
        refundAddress: operator,
        evmSwapKey,
        cltvExpiryBlocks: 144,
        timelockSeconds: 3600,
        createdAt: new Date(),
        updatedAt: new Date(),
      }, 'test-fp-9-2');

      fakeLightning.setInvoiceState(hashLock, 'CANCELED');
      fakeEvm.setHtlcState(evmSwapKey, {
        funded: false,
        completed: false,
        refunded: true,
        balance: 20_000_000n,
      });

      const r = await coordinator.reconcileSwap(executionId);
      assert.strictEqual(r.recoveryRequired, true);
      assert.strictEqual(r.state, SovereignAtomicState.RECOVERY_REQUIRED);
      assert.notEqual(r.state, SovereignAtomicState.REFUNDED);
      assert.notEqual(r.reservationStatus, 'RELEASED');

      const swapInDb = persistence.getSovereignSwap(executionId)!;
      assert.strictEqual(swapInDb.recoveryRequired, true);
      assert.strictEqual(swapInDb.state, SovereignAtomicState.RECOVERY_REQUIRED);
      assert.notEqual(swapInDb.state, SovereignAtomicState.REFUNDED);
    });

    it('9.3: CLAIMED + reservation RELEASED -> RECOVERY_REQUIRED', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const fakeLightning = new ConfigurableLightning();
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);
      const { coordinator } = setupTestCoordinator(fakeLightning, fakeEvm);

      const executionId = 'test-suite-9-3';
      const hashLock = '0x' + '93'.repeat(32);
      const evmSwapKey = `swap_${executionId}`;
      const res = persistence.reserveLiquidity(executionId, token, 20_000_000n, { allowLegacyFallback: true });
      persistence.releaseLiquidityReservation(res.reservationId);

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'test-suite-9-3-idemp',
        hashLock,
        claimingAddress: operator,
        targetDestinationAddress: operator,
        amountSats: 10_000n,
        expectedUsdcAmount: 20_000_000n,
        state: SovereignAtomicState.EVM_FUNDED,
        reservationId: res.reservationId,
        reservedAmountUnits: 20_000_000n,
        reservationStatus: 'RELEASED',
        tokenAddress: token,
        refundAddress: operator,
        evmSwapKey,
        cltvExpiryBlocks: 144,
        timelockSeconds: 3600,
        createdAt: new Date(),
        updatedAt: new Date(),
      }, 'test-fp-9-3');

      fakeLightning.setInvoiceState(hashLock, 'SETTLED');
      fakeEvm.setHtlcState(evmSwapKey, {
        funded: false,
        completed: true,
        refunded: false,
        balance: 20_000_000n,
      });

      const r = await coordinator.reconcileSwap(executionId);
      assert.strictEqual(r.recoveryRequired, true);
      assert.strictEqual(r.state, SovereignAtomicState.RECOVERY_REQUIRED);
      assert.notEqual(r.state, SovereignAtomicState.COMPLETED);

      const swapInDb = persistence.getSovereignSwap(executionId)!;
      assert.strictEqual(swapInDb.recoveryRequired, true);
      assert.strictEqual(swapInDb.state, SovereignAtomicState.RECOVERY_REQUIRED);
    });

    it('9.4: REFUNDED + reservation SETTLED -> RECOVERY_REQUIRED', async () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);
      const fakeLightning = new ConfigurableLightning();
      const fakeEvm = new ConfigurableEvm();
      fakeEvm.setWalletBalance(token, 100_000_000n);
      const { coordinator } = setupTestCoordinator(fakeLightning, fakeEvm);

      const executionId = 'test-suite-9-4';
      const hashLock = '0x' + '94'.repeat(32);
      const evmSwapKey = `swap_${executionId}`;
      const res = persistence.reserveLiquidity(executionId, token, 20_000_000n, { allowLegacyFallback: true });
      persistence.commitLiquidityReservation(res.reservationId);
      persistence.settleLiquidityReservation(res.reservationId);

      persistence.createSovereignSwap({
        id: executionId,
        idempotencyKey: 'test-suite-9-4-idemp',
        hashLock,
        claimingAddress: operator,
        targetDestinationAddress: operator,
        amountSats: 10_000n,
        expectedUsdcAmount: 20_000_000n,
        state: SovereignAtomicState.EVM_FUNDED,
        reservationId: res.reservationId,
        reservedAmountUnits: 20_000_000n,
        reservationStatus: 'SETTLED',
        tokenAddress: token,
        refundAddress: operator,
        evmSwapKey,
        cltvExpiryBlocks: 144,
        timelockSeconds: 3600,
        createdAt: new Date(),
        updatedAt: new Date(),
      }, 'test-fp-9-4');

      fakeLightning.setInvoiceState(hashLock, 'CANCELED');
      fakeEvm.setHtlcState(evmSwapKey, {
        funded: false,
        completed: false,
        refunded: true,
        balance: 20_000_000n,
      });

      const r = await coordinator.reconcileSwap(executionId);
      assert.strictEqual(r.recoveryRequired, true);
      assert.strictEqual(r.state, SovereignAtomicState.RECOVERY_REQUIRED);
      assert.notEqual(r.state, SovereignAtomicState.REFUNDED);

      const swapInDb = persistence.getSovereignSwap(executionId)!;
      assert.strictEqual(swapInDb.recoveryRequired, true);
      assert.strictEqual(swapInDb.state, SovereignAtomicState.RECOVERY_REQUIRED);
    });

    it('9.5: valid idempotent SETTLED->SETTLED and RELEASED->RELEASED still pass where semantically allowed', () => {
      persistence.setConfirmedOperatorBalance(token, 100_000_000n);

      const res1 = persistence.reserveLiquidity('idemp-settle-1', token, 10_000_000n, { allowLegacyFallback: true });
      persistence.commitLiquidityReservation(res1.reservationId);
      persistence.settleLiquidityReservation(res1.reservationId);

      // Idempotent SETTLED -> SETTLED
      assert.doesNotThrow(() => {
        persistence.settleLiquidityReservation(res1.reservationId);
      });
      const item1 = persistence.getLiquidityReservation(res1.reservationId);
      assert.strictEqual(item1?.status, 'SETTLED');

      const res2 = persistence.reserveLiquidity('idemp-release-2', token, 10_000_000n, { allowLegacyFallback: true });
      persistence.releaseLiquidityReservation(res2.reservationId);

      // Idempotent RELEASED -> RELEASED
      assert.doesNotThrow(() => {
        persistence.releaseLiquidityReservation(res2.reservationId);
      });
      assert.doesNotThrow(() => {
        persistence.restoreRefundLiquidityReservation(res2.reservationId);
      });
      const item2 = persistence.getLiquidityReservation(res2.reservationId);
      assert.strictEqual(item2?.status, 'RELEASED');
    });
  });

});
