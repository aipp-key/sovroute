import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';

import { SqlitePersistence } from '../src/persistence/sqlite.ts';
import { AtomicCoordinator } from '../src/atomic/coordinator/coordinator.ts';
import { FakeEvmAtomicBackend } from '../src/atomic/evm/fake-backend.ts';
import { BaseSepoliaAtomicBackend } from '../src/atomic/evm/base-sepolia-backend.ts';
import {
  BaseTransactionManager,
  EvmTransactionObservationUnknownError,
} from '../src/atomic/evm/transaction-manager.ts';
import { EvmLogicalIntentState } from '../src/atomic/evm/transaction-types.ts';
import { FakeLightningAtomicBackend } from '../src/atomic/lightning/fake-backend.ts';
import { SqliteLiquidityInventory } from '../src/atomic/liquidity/sqlite-inventory.ts';
import { ChainInventoryReconciler } from '../src/atomic/liquidity/chain-reconciler.ts';
import { HealthService } from '../src/health/health-service.ts';
import { ProductionConfigValidator } from '../src/config/production-config.ts';
import {
  LightningInvoiceNotFoundError,
  SovereignAtomicState,
} from '../src/atomic/types.ts';
import {
  BASE_SEPOLIA_CHAIN_ID,
  OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS,
} from '../src/atomic/evm/base-guard.ts';

const token = OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS.toLowerCase();
const operator = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const privateKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const pinnedHtlcBytecode = JSON.parse(
  readFileSync(join(process.cwd(), 'artifacts', 'contracts', 'HtlcErc20.sol', 'HtlcErc20.json'), 'utf8')
).deployedBytecode as string;

class AmbiguousInvoiceLightning extends FakeLightningAtomicBackend {
  override async createHoldInvoice(): Promise<never> {
    throw new Error('LND add timeout');
  }
  override async observeHoldInvoice(): Promise<never> {
    throw new Error('LND lookup timeout');
  }
}

class AbsentInvoiceLightning extends FakeLightningAtomicBackend {
  override async createHoldInvoice(): Promise<never> {
    throw new Error('LND add rejected');
  }
  override async observeHoldInvoice(paymentHash: string): Promise<never> {
    throw new LightningInvoiceNotFoundError(paymentHash);
  }
}

describe('FINAL BLOCKER REMEDIATION — AMBIGUITY AND ECONOMIC STATE', () => {
  let dbPath: string;
  let persistence: SqlitePersistence;

  beforeEach(() => {
    dbPath = join(tmpdir(), `sovroute-final-remediation-${randomUUID()}.db`);
    persistence = new SqlitePersistence({ filename: dbPath, allowLegacyFallback: true });
  });

  afterEach(() => {
    persistence.close();
    if (existsSync(dbPath)) rmSync(dbPath, { force: true });
  });

  function coordinatorWith(lightning: FakeLightningAtomicBackend, evm = new FakeEvmAtomicBackend()) {
    const inventory = new SqliteLiquidityInventory(persistence, { [token]: 100_000_000n });
    const coordinator = new AtomicCoordinator(lightning, evm, inventory, {
      persistence,
      finalityPolicy: evm.finalityPolicy,
    });
    return { coordinator, inventory, evm };
  }

  const swapParams = {
    idempotencyKey: 'ambiguous-invoice',
    hashLock: ('0x' + '44'.repeat(32)) as `0x${string}`,
    claimingAddress: operator,
    targetDestinationAddress: operator,
    amountSats: 10_000n,
    expectedUsdcAmount: 30_000_000n,
  };

  it('prepareSwap retains R and marks recovery when create and lookup are unknown', async () => {
    const { coordinator, inventory } = coordinatorWith(new AmbiguousInvoiceLightning());
    await assert.rejects(() => coordinator.prepareSwap(swapParams), /AMBIGUOUS_HOLD_INVOICE_CREATION/);
    const swap = persistence.getSovereignSwapByIdempotencyKey(swapParams.idempotencyKey)!;
    assert.strictEqual(swap.state, SovereignAtomicState.RECOVERY_REQUIRED);
    assert.strictEqual(swap.recoveryRequired, true);
    assert.strictEqual(swap.reservationStatus, 'RESERVED');
    assert.strictEqual(persistence.getLiquidityReservation(swap.reservationId!)?.status, 'RESERVED');
    assert.strictEqual(persistence.getReservedOperatorBalance(token), 30_000_000n);
    assert.strictEqual(persistence.getUnresolvedFundingIntentsAmount(token), 0n);
    assert.strictEqual(await inventory.getAvailableBalance(token), 70_000_000n);
  });

  it('prepareSwap releases exactly once only after authoritative invoice absence', async () => {
    const { coordinator, inventory } = coordinatorWith(new AbsentInvoiceLightning());
    await assert.rejects(() => coordinator.prepareSwap(swapParams), /LND add rejected/);
    const swap = persistence.getSovereignSwapByIdempotencyKey(swapParams.idempotencyKey)!;
    assert.strictEqual(swap.state, SovereignAtomicState.INVOICE_CANCELED);
    assert.strictEqual(swap.recoveryRequired, false);
    assert.strictEqual(swap.reservationStatus, 'RELEASED');
    assert.strictEqual(persistence.getLiquidityReservation(swap.reservationId!)?.status, 'RELEASED');
    assert.strictEqual(await inventory.getAvailableBalance(token), 100_000_000n);
  });

  it('reconcileSwap retains reservation when EVM is UNKNOWN even if Lightning is CANCELED', async () => {
    const lightning = new FakeLightningAtomicBackend();
    const evm = new FakeEvmAtomicBackend();
    const { coordinator, inventory } = coordinatorWith(lightning, evm);
    const prepared = await coordinator.prepareSwap({ ...swapParams, idempotencyKey: 'evm-unknown' });
    await lightning.cancelHoldInvoice(prepared.holdInvoice!.paymentHash);
    persistence.markSovereignRecoveryRequired(prepared.id, 'test recovery', 'TEST_RECOVERY');
    evm.observeHtlc = async () => { throw new Error('Base RPC timeout'); };

    const recovered = await coordinator.reconcileSwap(prepared.id);
    assert.strictEqual(recovered.state, SovereignAtomicState.RECOVERY_REQUIRED);
    assert.strictEqual(recovered.recoveryRequired, true);
    assert.strictEqual(recovered.reservationStatus, 'RESERVED');
    assert.strictEqual(persistence.getLiquidityReservation(prepared.reservationId!)?.status, 'RESERVED');
    assert.strictEqual(await inventory.getAvailableBalance(token), 70_000_000n);
  });

  it('reconcileSwap releases only with CANCELED Lightning and proven EVM absence', async () => {
    const lightning = new FakeLightningAtomicBackend();
    const { coordinator, inventory } = coordinatorWith(lightning);
    const prepared = await coordinator.prepareSwap({ ...swapParams, idempotencyKey: 'proven-absence' });
    await lightning.cancelHoldInvoice(prepared.holdInvoice!.paymentHash);
    persistence.markSovereignRecoveryRequired(prepared.id, 'test recovery', 'TEST_RECOVERY');

    const recovered = await coordinator.reconcileSwap(prepared.id);
    assert.strictEqual(recovered.state, SovereignAtomicState.INVOICE_CANCELED);
    assert.strictEqual(recovered.recoveryRequired, false);
    assert.strictEqual(recovered.reservationStatus, 'RELEASED');
    assert.strictEqual(persistence.getLiquidityReservation(prepared.reservationId!)?.status, 'RELEASED');
    assert.strictEqual(persistence.getReservedOperatorBalance(token), 0n);
    assert.strictEqual(await inventory.getAvailableBalance(token), 100_000_000n);
  });

  it('RECOVERY_REQUIRED is atomically persisted and surfaced by health', async () => {
    const { coordinator } = coordinatorWith(new AmbiguousInvoiceLightning());
    await assert.rejects(() => coordinator.prepareSwap({ ...swapParams, idempotencyKey: 'health' }));
    const swap = persistence.getSovereignSwapByIdempotencyKey('health')!;
    assert.strictEqual(swap.state, SovereignAtomicState.RECOVERY_REQUIRED);
    assert.strictEqual(swap.recoveryRequired, true);
    const report = await new HealthService(persistence).getHealthReport();
    assert.strictEqual(report.status, 'RECOVERY_REQUIRED');
    assert.strictEqual(report.swaps.recoveryRequiredSwaps, 1);
  });

  it('reservation COMMITTED transition synchronizes the swap row', async () => {
    const { coordinator } = coordinatorWith(new FakeLightningAtomicBackend());
    const prepared = await coordinator.prepareSwap({ ...swapParams, idempotencyKey: 'commit-sync' });
    persistence.commitLiquidityReservation(prepared.reservationId!);
    assert.strictEqual(persistence.getLiquidityReservation(prepared.reservationId!)?.status, 'COMMITTED');
    assert.strictEqual(persistence.getSovereignSwap(prepared.id)?.reservationStatus, 'COMMITTED');
  });

  it('reservation RELEASED transition synchronizes the swap row', async () => {
    const { coordinator } = coordinatorWith(new FakeLightningAtomicBackend());
    const prepared = await coordinator.prepareSwap({ ...swapParams, idempotencyKey: 'release-sync' });
    persistence.releaseLiquidityReservation(prepared.reservationId!);
    assert.strictEqual(persistence.getLiquidityReservation(prepared.reservationId!)?.status, 'RELEASED');
    assert.strictEqual(persistence.getSovereignSwap(prepared.id)?.reservationStatus, 'RELEASED');
  });

  it('refund restoration synchronizes a COMMITTED swap row to RELEASED', async () => {
    const { coordinator } = coordinatorWith(new FakeLightningAtomicBackend());
    const prepared = await coordinator.prepareSwap({ ...swapParams, idempotencyKey: 'refund-sync' });
    persistence.commitLiquidityReservation(prepared.reservationId!);
    persistence.restoreRefundLiquidityReservation(prepared.reservationId!);
    assert.strictEqual(persistence.getLiquidityReservation(prepared.reservationId!)?.status, 'RELEASED');
    assert.strictEqual(persistence.getSovereignSwap(prepared.id)?.reservationStatus, 'RELEASED');
  });

  function transactionHarness(receiptBehavior: () => Promise<any>, minedNonce = 1) {
    const account = privateKeyToAccount(privateKey);
    const intent = persistence.getOrCreateEvmIntent({
      swapKey: `tx-${randomUUID()}`,
      chainId: BASE_SEPOLIA_CHAIN_ID,
      signerAddress: account.address,
      actionType: 'FUND',
      targetAddress: operator as `0x${string}`,
      calldata: '0x',
    });
    persistence.reserveEvmNonce(intent.id, 1);
    const attempt = persistence.recordEvmAttempt({
      intentId: intent.id,
      attemptNumber: 1,
      chainId: BASE_SEPOLIA_CHAIN_ID,
      signerAddress: account.address,
      nonce: 1,
      txHash: ('0x' + '55'.repeat(32)) as `0x${string}`,
      toAddress: operator as `0x${string}`,
      valueWei: 0n,
      data: '0x',
      gasLimit: 21_000n,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    });
    const publicClient = {
      getTransactionReceipt: receiptBehavior,
      getTransactionCount: async () => minedNonce,
      sendRawTransaction: async () => attempt.txHash,
    } as any;
    return {
      intent,
      attempt,
      manager: new BaseTransactionManager({
        persistence,
        publicClient,
        account,
        chainId: BASE_SEPOLIA_CHAIN_ID,
      }),
    };
  }

  it('provider error containing not found remains UNKNOWN, not receipt absence', async () => {
    const { manager, intent } = transactionHarness(async () => {
      throw new Error('provider project not found');
    });
    await assert.rejects(
      () => manager.reconcileIntent(intent.id),
      (err: unknown) => err instanceof EvmTransactionObservationUnknownError
    );
    assert.notStrictEqual(persistence.getEvmIntentById(intent.id)?.status, EvmLogicalIntentState.NONCE_CONFLICT);
  });

  it('typed authoritative receipt-not-found remains PENDING', async () => {
    const notFound = new Error('receipt unavailable');
    notFound.name = 'TransactionReceiptNotFoundError';
    const { manager, intent } = transactionHarness(async () => { throw notFound; });
    const result = await manager.reconcileIntent(intent.id);
    assert.strictEqual(result.status, EvmLogicalIntentState.PENDING);
  });

  it('advanced nonce plus ambiguous receipt never becomes NONCE_CONFLICT', async () => {
    const { manager, intent } = transactionHarness(async () => {
      throw new Error('upstream method not found');
    }, 9);
    await assert.rejects(() => manager.reconcileIntent(intent.id), /EVM_TRANSACTION_OBSERVATION_UNKNOWN/);
    assert.notStrictEqual(persistence.getEvmIntentById(intent.id)?.status, EvmLogicalIntentState.NONCE_CONFLICT);
  });

  it('advanced nonce plus authoritative receipt absence remains PENDING without conflict proof', async () => {
    const notFound = new Error('receipt unavailable');
    notFound.name = 'TransactionReceiptNotFoundError';
    const { manager, intent } = transactionHarness(async () => { throw notFound; }, 9);
    const result = await manager.reconcileIntent(intent.id);
    assert.strictEqual(result.status, EvmLogicalIntentState.PENDING);
    assert.match(result.reason ?? '', /NONCE_ADVANCED_OUTCOME_UNKNOWN/);
  });

  it('explicit nonce-too-low plus authoritative absence and advanced nonce is conflict evidence', async () => {
    const { manager, intent, attempt } = transactionHarness(async () => null, 9);
    manager.publicClient.sendRawTransaction = async () => { throw new Error('nonce too low'); };
    await assert.rejects(() => manager.broadcastAttempt(attempt, '0x'), /NONCE_CONFLICT/);
    assert.strictEqual(persistence.getEvmIntentById(intent.id)?.status, EvmLogicalIntentState.NONCE_CONFLICT);
  });

  it('recoverOnStartup propagates signing failures', async () => {
    const { manager } = transactionHarness(async () => null);
    (manager as any).signAttemptTransaction = async () => { throw new Error('signing hardware unavailable'); };
    await assert.rejects(() => manager.recoverOnStartup(), /signing hardware unavailable/);
  });

  it('recoverOnStartup rejects deterministic signature mismatch', async () => {
    const { manager } = transactionHarness(async () => null);
    await assert.rejects(() => manager.recoverOnStartup(), /DETERMINISTIC_SIGNATURE_MISMATCH/);
  });

  function createFundingSwap(state: string, htlcId?: string) {
    persistence.setConfirmedOperatorBalance(token, 100_000_000n);
    const id = `funding-${randomUUID()}`;
    const swapKey = `swap_${id}`;
    const reservation = persistence.reserveLiquidity(id, token, 25_000_000n, {
      allowLegacyFallback: true,
    });
    persistence.createSovereignSwap({
      id,
      idempotencyKey: `idem-${id}`,
      hashLock: '0x' + '66'.repeat(32),
      claimingAddress: operator,
      targetDestinationAddress: operator,
      amountSats: 10_000n,
      expectedUsdcAmount: 25_000_000n,
      state: state as any,
      reservationId: reservation.reservationId,
      reservedAmountUnits: 25_000_000n,
      reservationStatus: 'RESERVED',
      tokenAddress: token,
      refundAddress: operator,
      evmSwapKey: swapKey,
      evmHtlcId: htlcId,
      createdAt: new Date(),
      updatedAt: new Date(),
    }, `fp-${id}`);
    const intent = persistence.getOrCreateEvmIntent({
      swapKey,
      chainId: BASE_SEPOLIA_CHAIN_ID,
      signerAddress: operator as `0x${string}`,
      actionType: 'FUND',
      targetAddress: '0x1111111111111111111111111111111111111111',
      calldata: '0x',
    });
    return { id, swapKey, reservationId: reservation.reservationId, intent };
  }

  function capacityProvider(status: unknown) {
    return {
      verifyChainAndToken: async () => ({ valid: true }),
      getContractHtlcState: async () => ({ status }),
      observeWalletCapacity: async () => ({
        tokenAddress: token,
        chainId: BASE_SEPOLIA_CHAIN_ID,
        operatorAddress: operator,
        walletBalanceLatest: 100_000_000n,
        walletBalanceFinalized: 100_000_000n,
        safeWalletCapacity: 100_000_000n,
        latestBlockNumber: 100,
        finalizedBlockNumber: 98,
        observedAt: new Date(),
      }),
    };
  }

  it('fallback LOCKED HTLC converges FUND intent, P, reservation, and swap status', async () => {
    const htlcId = '0x' + '77'.repeat(32);
    const created = createFundingSwap(SovereignAtomicState.EVM_FUNDING_PENDING, htlcId);
    const reconciler = ChainInventoryReconciler.createForTesting({
      persistence,
      capacityProvider: capacityProvider(1),
      defaultTokenAddress: token,
    });
    const result = await reconciler.reconcileOnBoot();
    assert.strictEqual(result.readinessState, 'READY');
    assert.strictEqual(result.headroom, 100_000_000n);
    assert.strictEqual(persistence.getEvmIntentById(created.intent.id)?.status, EvmLogicalIntentState.CONFIRMED);
    assert.strictEqual(persistence.getUnresolvedFundingIntentsAmount(token), 0n);
    assert.strictEqual(persistence.getLiquidityReservation(created.reservationId)?.status, 'COMMITTED');
    assert.strictEqual(persistence.getSovereignSwap(created.id)?.reservationStatus, 'COMMITTED');
    assert.strictEqual(persistence.getSovereignSwap(created.id)?.state, SovereignAtomicState.EVM_FUNDED);
  });

  it('restart discovers an already FAILED FUND cross-rail obligation', async () => {
    const created = createFundingSwap(SovereignAtomicState.LIGHTNING_HELD);
    persistence.markEvmIntentFailed(created.intent.id, 'definitive test failure');
    const reconciler = ChainInventoryReconciler.createForTesting({
      persistence,
      capacityProvider: capacityProvider(0),
      defaultTokenAddress: token,
    });
    const result = await reconciler.reconcileOnBoot();
    assert.strictEqual(result.readinessState, 'UNKNOWN');
    const swap = persistence.getSovereignSwap(created.id)!;
    assert.strictEqual(swap.state, SovereignAtomicState.RECOVERY_REQUIRED);
    assert.strictEqual(swap.recoveryRequired, true);
    assert.strictEqual(swap.reservationStatus, 'RESERVED');
  });

  it('malformed active HTLC status blocks READY', async () => {
    const created = createFundingSwap(SovereignAtomicState.EVM_FUNDED, '0x' + '88'.repeat(32));
    persistence.markEvmIntentConfirmedByChainEvidence(created.intent.id);
    const reconciler = ChainInventoryReconciler.createForTesting({
      persistence,
      capacityProvider: capacityProvider('LOCKED'),
      defaultTokenAddress: token,
    });
    const result = await reconciler.reconcileOnBoot();
    assert.strictEqual(result.readinessState, 'UNKNOWN');
    assert.match(result.error ?? '', /Unknown HTLC status/);
  });

  it('RECOVERY_REQUIRED exposure blocks inventory READY', async () => {
    const created = createFundingSwap(SovereignAtomicState.LIGHTNING_HELD);
    persistence.markSovereignRecoveryRequired(created.id, 'unresolved', 'TEST_UNRESOLVED');
    const reconciler = ChainInventoryReconciler.createForTesting({
      persistence,
      capacityProvider: capacityProvider(0),
      defaultTokenAddress: token,
    });
    const result = await reconciler.reconcileOnBoot();
    assert.strictEqual(result.readinessState, 'UNKNOWN');
  });

  it('pre-funding HTLC read failure produces zero financial broadcast', async () => {
    let broadcasts = 0;
    const publicClient = {
      getChainId: async () => BASE_SEPOLIA_CHAIN_ID,
      getBytecode: async () => pinnedHtlcBytecode,
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === 'decimals') return 6;
        if (functionName === 'getHtlc') throw new Error('contract RPC timeout');
        return 100_000_000n;
      },
      sendRawTransaction: async () => { broadcasts++; return '0x' + '99'.repeat(32); },
    } as any;
    const backend = BaseSepoliaAtomicBackend.createForTesting({
      chainId: BASE_SEPOLIA_CHAIN_ID,
      htlcAddress: '0x1111111111111111111111111111111111111111',
      tokenAddress: OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS,
      operatorPrivateKey: privateKey,
      persistence,
      finalityPolicy: { policyTag: 'TEST', requiredConfirmations: 2 },
    }, publicClient);
    await assert.rejects(() => backend.fundHtlc({
      swapKey: 'prefund-read-failure',
      hashLock: '0x' + '99'.repeat(32),
      amountUnits: 1_000_000n,
      tokenAddress: token,
      refundLocktime: Math.floor(Date.now() / 1000) + 3600,
      claimAddress: operator,
      refundAddress: operator,
    }), /HTLC_EXISTENCE_UNKNOWN/);
    assert.strictEqual(broadcasts, 0);
    assert.strictEqual(persistence.getActiveEvmIntents(BASE_SEPOLIA_CHAIN_ID).length, 0);
  });

  function productionConfigForValidation() {
    return {
      environment: 'production' as const,
      databasePath: dbPath,
      lightning: {
        network: 'regtest',
        host: '127.0.0.1',
        port: 18080,
        tlsCertHex: '00',
        macaroonHex: '00',
      },
      evm: {
        chainId: BASE_SEPOLIA_CHAIN_ID,
        rpcUrl: 'https://sepolia.base.org',
        htlcAddress: '0x1111111111111111111111111111111111111111',
        usdcAddress: OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS,
        finalityPolicy: { policyTag: 'EXPLICIT_TESTNET_POLICY', requiredConfirmations: 2 },
        reconciliationPolicy: {
          maxFreshnessMs: 60_000,
          requiredConfirmations: 2,
          reorgLagTolerance: 1,
          failClosedOnDeficit: true,
        },
      },
      safety: {
        allowMainnet: false,
        minRemainingBtcBlocks: 140,
        maxReconciliationRetries: 5,
        leaseMs: 30_000,
      },
    };
  }

  it('production validation rejects a zero HTLC address', () => {
    const config = productionConfigForValidation();
    config.evm.htlcAddress = '0x0000000000000000000000000000000000000000';
    assert.throws(() => ProductionConfigValidator.validate(config), /Zero EVM HTLC/);
  });

  it('production validation rejects confirmation-policy divergence', () => {
    const config = productionConfigForValidation();
    config.evm.reconciliationPolicy.requiredConfirmations = 3;
    assert.throws(() => ProductionConfigValidator.validate(config), /must equal finalityPolicy/);
  });
});
