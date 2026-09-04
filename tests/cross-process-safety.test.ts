import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  createAssetNode,
  EdgeClass,
  ExecutionClass,
  CapabilityStatus,
  type IExecutionEdge,
  type EdgeRuntimeAvailability,
  type RouteQuote,
  type NormalizedIntent,
  type NormalizedQuote,
  type ProviderExecutionResult,
  type NormalizedProviderStatus,
  ProviderNormalizedStatus,
  ExecutionState,
} from '../src/domain/types.ts';
import { SqlitePersistence } from '../src/persistence/sqlite.ts';
import { ExecutionOrchestrator } from '../src/orchestrator/orchestrator.ts';

class CrossProcessCountingEdge implements IExecutionEdge {
  public id = 'cross_process_edge';
  public name = 'Cross Process Counting Edge';
  public edgeClass = EdgeClass.TRUSTED_PROVIDER_EDGE;
  public executionClass = ExecutionClass.PASSIVE_DEPOSIT;
  public sourceNode = createAssetNode('BTC', 'lightning');
  public destinationNode = createAssetNode('USDC', 'base');
  public edgeCapabilities = {
    discover: CapabilityStatus.SUPPORTED,
    quote: CapabilityStatus.SUPPORTED,
    prepare: CapabilityStatus.UNSUPPORTED,
    execute: CapabilityStatus.SUPPORTED,
    verify: CapabilityStatus.UNSUPPORTED,
    recover: CapabilityStatus.SUPPORTED,
  };

  public createCount = 0;
  public createdOrders: string[] = [];
  public delayMs = 30;

  public supportsRoute(): boolean {
    return true;
  }

  public async getRuntimeAvailability(): Promise<EdgeRuntimeAvailability> {
    return {
      isAvailable: true,
      recvEnabled: true,
      sendEnabled: true,
      isMaintenance: false,
      minAmountAtomic: '2000',
      maxAmountAtomic: '50000000',
      lastCheckedAt: new Date().toISOString(),
    };
  }

  public async capabilities() {
    return {
      supportedPairs: [],
      executionClass: this.executionClass,
      supportsLightning: true,
      supportsRefunds: true,
      supportsStrongIdempotency: false,
    };
  }

  public async getQuote(amount: string): Promise<RouteQuote> {
    return {
      quoteId: 'q_cross_test',
      edgeId: this.id,
      sourceNode: this.sourceNode,
      destinationNode: this.destinationNode,
      inputAmountAtomic: amount,
      estimatedOutputAmountAtomic: '700000',
      rate: '70',
      networkFeeEstimatedAtomic: '0',
      minAmountAtomic: '2000',
      maxAmountAtomic: '50000000',
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      edgeClass: this.edgeClass,
      executionClass: this.executionClass,
    };
  }

  public async createExecution(planOrReq: any): Promise<ProviderExecutionResult> {
    this.createCount++;
    const orderId = `prov_order_${this.createCount}`;
    this.createdOrders.push(orderId);

    // Controlled async latency to expose any concurrent race window
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }

    const depositAmt =
      planOrReq.quoteSnapshot?.inputAmountAtomic ??
      planOrReq.quote?.depositAmountAtomic ??
      '10000';
    const settleAddr =
      planOrReq.destinationAddress ??
      planOrReq.intent?.destinationAddress ??
      '0x1111111111111111111111111111111111111111';

    return {
      providerExecutionId: orderId,
      orderToken: `token_${orderId}`,
      depositAddress: `lnbc_${orderId}`,
      depositAmountAtomic: depositAmt,
      settleAddress: settleAddr,
      status: 'NEW',
      rawResponse: { id: orderId },
    };
  }

  public async getStatus(): Promise<NormalizedProviderStatus> {
    return {
      status: ProviderNormalizedStatus.WAITING_FOR_DEPOSIT,
      depositTxId: null,
      settleTxId: null,
      settleAmountActualAtomic: null,
      failureReason: null,
      raw: {},
    };
  }
}

describe('PHASE 2.1 — CROSS-PROCESS & DURABLE DISPATCH SAFETY', () => {
  const scratchDir = path.join(process.cwd(), 'scratch');
  const testDbFile = path.join(scratchDir, 'test_cross_process.db');

  function cleanupDb() {
    for (const ext of ['', '-wal', '-shm']) {
      const p = `${testDbFile}${ext}`;
      if (fs.existsSync(p)) {
        try {
          fs.unlinkSync(p);
        } catch {}
      }
    }
  }

  beforeEach(() => {
    cleanupDb();
  });

  afterEach(() => {
    cleanupDb();
  });

  test('1. Two independent orchestrators & separate DB connections: exactly ONE provider CREATE dispatch', async () => {
    const persistenceA = new SqlitePersistence({ filename: testDbFile });
    const persistenceB = new SqlitePersistence({ filename: testDbFile });

    const sharedEdge = new CrossProcessCountingEdge();

    // Orchestrator A: completely independent instance
    const orchestratorA = new ExecutionOrchestrator({
      persistence: persistenceA,
      providers: new Map([[sharedEdge.id, sharedEdge as any]]),
    });

    // Orchestrator B: completely independent instance (separate memory & separate inFlightExecutions map)
    const orchestratorB = new ExecutionOrchestrator({
      persistence: persistenceB,
      providers: new Map([[sharedEdge.id, sharedEdge as any]]),
    });

    const intent: NormalizedIntent = {
      sourceAsset: 'BTC',
      sourceNetwork: 'lightning',
      targetAsset: 'USDC',
      targetNetwork: 'base',
      sourceAmountAtomic: '10000',
      destinationAddress: '0x1111111111111111111111111111111111111111',
      refundAddress: 'lnbcRefund',
    };

    const quote: NormalizedQuote = {
      quoteId: 'q_cross_test',
      providerId: sharedEdge.id,
      sourceAsset: 'BTC',
      sourceNetwork: 'lightning',
      targetAsset: 'USDC',
      targetNetwork: 'base',
      depositAmountAtomic: '10000',
      settleAmountAtomic: '700000',
      rate: '70',
      networkFeeEstimatedAtomic: '0',
      minDepositAtomic: '2000',
      maxDepositAtomic: '50000000',
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    };

    // Both independent orchestrators attempt execution concurrently on the exact same idempotencyKey
    const [resA, resB] = await Promise.all([
      orchestratorA.initiateExecution('cross_process_idem_1', intent, quote),
      orchestratorB.initiateExecution('cross_process_idem_1', intent, quote),
    ]);

    // INVARIANT INV-1 / INV-18: Provider createExecution call count MUST BE EXACTLY 1!
    assert.equal(
      sharedEdge.createCount,
      1,
      `P0 VIOLATION: Cross-worker race caused provider.createExecution to be called ${sharedEdge.createCount} times!`
    );

    // Both independent callers receive the identical execution record and deposit address
    assert.equal(resA.id, resB.id);
    assert.equal(resA.depositAddress, resB.depositAddress);
    assert.equal(resA.depositAddress, 'lnbc_prov_order_1');
  });

  test('2. Losing worker does not dispatch after contention and awaits winning worker completion', async () => {
    const persistenceA = new SqlitePersistence({ filename: testDbFile });
    const persistenceB = new SqlitePersistence({ filename: testDbFile });
    const sharedEdge = new CrossProcessCountingEdge();

    const orchestratorA = new ExecutionOrchestrator({
      persistence: persistenceA,
      providers: new Map([[sharedEdge.id, sharedEdge as any]]),
    });

    const orchestratorB = new ExecutionOrchestrator({
      persistence: persistenceB,
      providers: new Map([[sharedEdge.id, sharedEdge as any]]),
    });

    const intent: NormalizedIntent = {
      sourceAsset: 'BTC',
      sourceNetwork: 'lightning',
      targetAsset: 'USDC',
      targetNetwork: 'base',
      sourceAmountAtomic: '10000',
      destinationAddress: '0x1111111111111111111111111111111111111111',
      refundAddress: 'lnbcRefund',
    };

    const quote: NormalizedQuote = {
      quoteId: 'q_contention',
      providerId: sharedEdge.id,
      sourceAsset: 'BTC',
      sourceNetwork: 'lightning',
      targetAsset: 'USDC',
      targetNetwork: 'base',
      depositAmountAtomic: '10000',
      settleAmountAtomic: '700000',
      rate: '70',
      networkFeeEstimatedAtomic: '0',
      minDepositAtomic: '2000',
      maxDepositAtomic: '50000000',
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    };

    // Staggered launch by 5ms: Worker A starts first, Worker B starts while Worker A is awaiting provider
    const pA = orchestratorA.initiateExecution('staggered_idem_1', intent, quote);
    await new Promise((r) => setTimeout(r, 5));
    const pB = orchestratorB.initiateExecution('staggered_idem_1', intent, quote);

    const [resA, resB] = await Promise.all([pA, pB]);

    assert.equal(sharedEdge.createCount, 1);
    assert.equal(resA.depositAddress, 'lnbc_prov_order_1');
    assert.equal(resB.depositAddress, 'lnbc_prov_order_1');
  });

  test('3. Process restart after durable dispatch claim NEVER re-dispatches createExecution', async () => {
    const persistence = new SqlitePersistence({ filename: testDbFile });
    const sharedEdge = new CrossProcessCountingEdge();

    const intent: NormalizedIntent = {
      sourceAsset: 'BTC',
      sourceNetwork: 'lightning',
      targetAsset: 'USDC',
      targetNetwork: 'base',
      sourceAmountAtomic: '10000',
      destinationAddress: '0x1111111111111111111111111111111111111111',
      refundAddress: 'lnbcRefund',
    };

    // Worker 1 acquires claim and crashes while EXECUTING
    const rec = persistence.createExecution('crash_after_claim', intent);
    persistence.transitionState(
      rec.id,
      ExecutionState.QUOTED,
      'Quote secured',
      'API',
      null,
      { providerId: sharedEdge.id }
    );
    persistence.transitionState(
      rec.id,
      ExecutionState.EXECUTION_PENDING,
      'Execution pending',
      'API'
    );

    const claimed = persistence.acquireDispatchClaim(
      rec.id,
      'createExecution',
      'jnl_claim_1',
      sharedEdge.id,
      new Date().toISOString()
    );
    assert.equal(claimed, true);

    // Worker 1 dies here. Worker 2 starts fresh.
    const freshPersistence = new SqlitePersistence({ filename: testDbFile });
    const freshOrchestrator = new ExecutionOrchestrator({
      persistence: freshPersistence,
      providers: new Map([[sharedEdge.id, sharedEdge as any]]),
    });

    // Worker 2 calls reconcileExecution
    const reconciled = await freshOrchestrator.reconcileExecution(rec.id);

    // INVARIANT: Worker 2 must NEVER call createExecution on a previously claimed execution!
    assert.equal(sharedEdge.createCount, 0, 'Restarting worker must NEVER dispatch createExecution');
    // Because passive deposit and deposit instruction was never exposed: safely failed
    assert.equal(reconciled.state, ExecutionState.FAILED);
  });

  test('4. Process restart after ambiguous outbound request does not duplicate order', async () => {
    const persistence = new SqlitePersistence({ filename: testDbFile });
    const sharedEdge = new CrossProcessCountingEdge();

    const intent: NormalizedIntent = {
      sourceAsset: 'BTC',
      sourceNetwork: 'lightning',
      targetAsset: 'USDC',
      targetNetwork: 'base',
      sourceAmountAtomic: '10000',
      destinationAddress: '0x1111111111111111111111111111111111111111',
      refundAddress: 'lnbcRefund',
    };

    // Simulate an execution in RECOVERY_REQUIRED
    const rec = persistence.createExecution('crash_ambiguous_outbound', intent);
    persistence.transitionState(
      rec.id,
      ExecutionState.DEPOSIT_INSTRUCTION_READY,
      'Invoice exposed',
      'API',
      null,
      {
        providerId: sharedEdge.id,
        providerExecutionId: 'order_123',
        orderToken: 'token_123',
        depositAddress: 'lnbc_exposed_123',
      }
    );
    persistence.transitionState(
      rec.id,
      ExecutionState.RECOVERY_REQUIRED,
      'Network timeout during recovery check',
      'RECOVERY_WORKER'
    );

    // Restart process
    const freshPersistence = new SqlitePersistence({ filename: testDbFile });
    const freshOrchestrator = new ExecutionOrchestrator({
      persistence: freshPersistence,
      providers: new Map([[sharedEdge.id, sharedEdge as any]]),
    });

    const reconciled = await freshOrchestrator.reconcileExecution(rec.id);

    assert.equal(sharedEdge.createCount, 0, 'Reconciliation must never create a replacement order');
    assert.equal(reconciled.depositAddress, 'lnbc_exposed_123');
  });

  test('5. SQLite contention: duplicate acquireDispatchClaim calls definitively reject losing worker', () => {
    const persistenceA = new SqlitePersistence({ filename: testDbFile });
    const persistenceB = new SqlitePersistence({ filename: testDbFile });

    const intent: NormalizedIntent = {
      sourceAsset: 'BTC',
      sourceNetwork: 'lightning',
      targetAsset: 'USDC',
      targetNetwork: 'base',
      sourceAmountAtomic: '10000',
      destinationAddress: '0x1111111111111111111111111111111111111111',
      refundAddress: 'lnbcRefund',
    };

    const rec = persistenceA.createExecution('contention_test', intent);
    persistenceA.transitionState(
      rec.id,
      ExecutionState.QUOTED,
      'Quoted',
      'API',
      null,
      { providerId: 'edge_test' }
    );
    persistenceA.transitionState(
      rec.id,
      ExecutionState.EXECUTION_PENDING,
      'Pending',
      'API'
    );

    // Worker A claims dispatch right
    const claimA = persistenceA.acquireDispatchClaim(
      rec.id,
      'createExecution',
      'jnl_A',
      'edge_test',
      new Date().toISOString()
    );
    assert.equal(claimA, true, 'First worker must acquire claim');

    // Worker B attempts to claim dispatch right on same execution
    const claimB = persistenceB.acquireDispatchClaim(
      rec.id,
      'createExecution',
      'jnl_B',
      'edge_test',
      new Date().toISOString()
    );
    assert.equal(claimB, false, 'Second worker must be strictly rejected by unique claim table & CAS');

    // Claim details verify worker A owns it
    const claim = persistenceA.getDispatchClaim(rec.id);
    assert.equal(claim?.journalId, 'jnl_A');
  });
});
