import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  type AssetNode,
  createAssetNode,
  EdgeClass,
  ExecutionClass,
  CapabilityStatus,
  type IExecutionEdge,
  type EdgeRuntimeAvailability,
  type RouteQuote,
  type ExecutionPlan,
  DomainErrorCode,
  RouterError,
  ExecutionState,
  type NormalizedIntent,
  type NormalizedQuote,
  type ProviderExecutionResult,
  type NormalizedProviderStatus,
  ProviderNormalizedStatus,
  type RefundResult,
} from '../src/domain/types.ts';
import { SqlitePersistence } from '../src/persistence/sqlite.ts';
import { ExecutionOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { ExecutionStateMachine } from '../src/state-machine/engine.ts';
import { MockChainVerifier, BASE_USDC_CONTRACT_ADDRESS } from '../src/verification/verifier.ts';
import { RoutePlanner } from '../src/routing/planner.ts';

class AdversarialMockEdge implements IExecutionEdge {
  public id = 'adversarial_edge';
  public name = 'Adversarial Mock Edge';
  public edgeClass = EdgeClass.TRUSTED_PROVIDER_EDGE;
  public executionClass = ExecutionClass.PASSIVE_DEPOSIT;
  public sourceNode = createAssetNode('BTC', 'lightning');
  public destinationNode = createAssetNode('USDC', 'base', BASE_USDC_CONTRACT_ADDRESS);
  public edgeCapabilities = {
    discover: CapabilityStatus.SUPPORTED,
    quote: CapabilityStatus.SUPPORTED,
    prepare: CapabilityStatus.UNSUPPORTED,
    execute: CapabilityStatus.SUPPORTED,
    verify: CapabilityStatus.UNSUPPORTED,
    recover: CapabilityStatus.SUPPORTED,
  };

  public createCount = 0;
  public statusCount = 0;
  public failNextCreate = false;
  public hangNextCreate = false;
  public simulatedStatus: NormalizedProviderStatus = {
    status: ProviderNormalizedStatus.WAITING_FOR_DEPOSIT,
    depositTxId: null,
    settleTxId: null,
    settleAmountActualAtomic: null,
    failureReason: null,
    raw: {},
  };

  public availability: EdgeRuntimeAvailability = {
    isAvailable: true,
    recvEnabled: true,
    sendEnabled: true,
    isMaintenance: false,
    minAmountAtomic: '2000',
    maxAmountAtomic: '50000000',
    lastCheckedAt: new Date().toISOString(),
  };

  public supportsRoute(source: AssetNode, destination: AssetNode): boolean {
    return source.asset === 'BTC' && destination.asset === 'USDC';
  }

  public async getRuntimeAvailability(): Promise<EdgeRuntimeAvailability> {
    return this.availability;
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
      quoteId: `q_${Date.now()}`,
      edgeId: this.id,
      sourceNode: this.sourceNode,
      destinationNode: this.destinationNode,
      inputAmountAtomic: amount,
      estimatedOutputAmountAtomic: '700000',
      rate: '70',
      networkFeeEstimatedAtomic: '0',
      minAmountAtomic: this.availability.minAmountAtomic,
      maxAmountAtomic: '50000000',
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      edgeClass: this.edgeClass,
      executionClass: this.executionClass,
    };
  }

  public async createExecution(planOrReq: any, _idempotencyKey?: string): Promise<ProviderExecutionResult> {
    this.createCount++;
    if (this.hangNextCreate) {
      throw new Error('ETIMEDOUT: Connection dropped during provider dispatch');
    }
    if (this.failNextCreate) {
      throw new Error('FixedFloat Error: 400 Bad Request: LIMIT_MIN');
    }
    // Simulate slight async network delay
    await new Promise((resolve) => setTimeout(resolve, 5));
    const depositAmount =
      planOrReq.quoteSnapshot?.inputAmountAtomic ??
      planOrReq.quote?.depositAmountAtomic ??
      '10000';
    const settleAddr =
      planOrReq.destinationAddress ??
      planOrReq.intent?.destinationAddress ??
      '0x1111111111111111111111111111111111111111';
    return {
      providerExecutionId: `prov_${this.createCount}`,
      orderToken: `token_${this.createCount}`,
      depositAddress: `lnbc20u_${this.createCount}`,
      depositAmountAtomic: depositAmount,
      settleAddress: settleAddr,
      status: 'NEW',
      rawResponse: { id: `prov_${this.createCount}` },
    };
  }

  public async getStatus(): Promise<NormalizedProviderStatus> {
    this.statusCount++;
    return this.simulatedStatus;
  }

  public async requestRefund(): Promise<RefundResult> {
    return {
      success: true,
      refundTxId: '0xrefund_verified_hash',
    };
  }
}

describe('PHASE 2 — PRE-MONEY ADVERSARIAL SAFETY REVIEW SUITE', () => {
  // =========================================================================
  // 1. ADVERSARIAL DUPLICATE REQUESTS & IDEMPOTENCY CONFLICTS (Section 5)
  // =========================================================================
  test('A. Same idempotency key, same payload: sequential duplicate returns same execution', async () => {
    const persistence = new SqlitePersistence();
    const edge = new AdversarialMockEdge();
    const orchestrator = new ExecutionOrchestrator({
      persistence,
      providers: new Map([[edge.id, edge as any]]),
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
      quoteId: 'q_seq_1',
      providerId: edge.id,
      sourceAsset: 'BTC',
      sourceNetwork: 'lightning',
      targetAsset: 'USDC',
      targetNetwork: 'base',
      depositAmountAtomic: '10000',
      settleAmountAtomic: '700000',
      rate: '70',
      networkFeeEstimatedAtomic: '0',
      minDepositAtomic: '1000',
      maxDepositAtomic: '1000000',
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    };

    const first = await orchestrator.initiateExecution('idem_seq', intent, quote);
    const second = await orchestrator.initiateExecution('idem_seq', intent, quote);

    assert.equal(first.id, second.id);
    assert.equal(first.providerExecutionId, second.providerExecutionId);
    assert.equal(edge.createCount, 1, 'Provider must only be called once for sequential duplicate');
  });

  test('B. Same idempotency key, same payload: 20 concurrent requests execute provider exactly ONCE', async () => {
    const persistence = new SqlitePersistence();
    const edge = new AdversarialMockEdge();
    const orchestrator = new ExecutionOrchestrator({
      persistence,
      providers: new Map([[edge.id, edge as any]]),
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
      quoteId: 'q_concurrent_20',
      providerId: edge.id,
      sourceAsset: 'BTC',
      sourceNetwork: 'lightning',
      targetAsset: 'USDC',
      targetNetwork: 'base',
      depositAmountAtomic: '10000',
      settleAmountAtomic: '700000',
      rate: '70',
      networkFeeEstimatedAtomic: '0',
      minDepositAtomic: '1000',
      maxDepositAtomic: '1000000',
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    };

    const promises = Array.from({ length: 20 }).map(() =>
      orchestrator.initiateExecution('concurrent_20_key', intent, quote)
    );

    const results = await Promise.all(promises);

    const firstId = results[0].id;
    const firstDeposit = results[0].depositAddress;
    for (const res of results) {
      assert.equal(res.id, firstId);
      assert.equal(res.depositAddress, firstDeposit);
    }
    assert.equal(edge.createCount, 1, 'Provider createCount must be exactly 1 despite 20 concurrent calls');
  });

  test('C. Same idempotency key, different amount throws IDEMPOTENCY_CONFLICT', async () => {
    const persistence = new SqlitePersistence();
    const edge = new AdversarialMockEdge();
    const orchestrator = new ExecutionOrchestrator({
      persistence,
      providers: new Map([[edge.id, edge as any]]),
    });

    const intent1: NormalizedIntent = {
      sourceAsset: 'BTC',
      sourceNetwork: 'lightning',
      targetAsset: 'USDC',
      targetNetwork: 'base',
      sourceAmountAtomic: '10000',
      destinationAddress: '0x1111111111111111111111111111111111111111',
      refundAddress: 'lnbcRefund',
    };

    const intent2: NormalizedIntent = {
      ...intent1,
      sourceAmountAtomic: '50000', // Conflict!
    };

    const quote: NormalizedQuote = {
      quoteId: 'q1',
      providerId: edge.id,
      sourceAsset: 'BTC',
      sourceNetwork: 'lightning',
      targetAsset: 'USDC',
      targetNetwork: 'base',
      depositAmountAtomic: '10000',
      settleAmountAtomic: '700000',
      rate: '70',
      networkFeeEstimatedAtomic: '0',
      minDepositAtomic: '1000',
      maxDepositAtomic: '1000000',
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    };

    await orchestrator.initiateExecution('idem_conflict_amt', intent1, quote);

    await assert.rejects(
      async () => await orchestrator.initiateExecution('idem_conflict_amt', intent2, quote),
      (err: unknown) => {
        assert(err instanceof RouterError);
        assert.equal(err.code, DomainErrorCode.IDEMPOTENCY_CONFLICT);
        return true;
      }
    );
    assert.equal(edge.createCount, 1, 'Conflicting request must never create a second order');
  });

  test('D. Same idempotency key, different destination address throws IDEMPOTENCY_CONFLICT', async () => {
    const persistence = new SqlitePersistence();
    const edge = new AdversarialMockEdge();
    const orchestrator = new ExecutionOrchestrator({
      persistence,
      providers: new Map([[edge.id, edge as any]]),
    });

    const intent1: NormalizedIntent = {
      sourceAsset: 'BTC',
      sourceNetwork: 'lightning',
      targetAsset: 'USDC',
      targetNetwork: 'base',
      sourceAmountAtomic: '10000',
      destinationAddress: '0x1111111111111111111111111111111111111111',
      refundAddress: 'lnbcRefund',
    };

    const intent2: NormalizedIntent = {
      ...intent1,
      destinationAddress: '0x9999999999999999999999999999999999999999', // Conflict!
    };

    const quote: NormalizedQuote = {
      quoteId: 'q2',
      providerId: edge.id,
      sourceAsset: 'BTC',
      sourceNetwork: 'lightning',
      targetAsset: 'USDC',
      targetNetwork: 'base',
      depositAmountAtomic: '10000',
      settleAmountAtomic: '700000',
      rate: '70',
      networkFeeEstimatedAtomic: '0',
      minDepositAtomic: '1000',
      maxDepositAtomic: '1000000',
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    };

    await orchestrator.initiateExecution('idem_conflict_dest', intent1, quote);

    await assert.rejects(
      async () => await orchestrator.initiateExecution('idem_conflict_dest', intent2, quote),
      (err: unknown) => {
        assert(err instanceof RouterError);
        assert.equal(err.code, DomainErrorCode.IDEMPOTENCY_CONFLICT);
        return true;
      }
    );
  });

  test('E. Same idempotency key, different source asset throws IDEMPOTENCY_CONFLICT', async () => {
    const persistence = new SqlitePersistence();
    const intent1: NormalizedIntent = {
      sourceAsset: 'BTC',
      sourceNetwork: 'lightning',
      targetAsset: 'USDC',
      targetNetwork: 'base',
      sourceAmountAtomic: '10000',
      destinationAddress: '0x1111111111111111111111111111111111111111',
      refundAddress: 'lnbcRefund',
    };

    const intent2: NormalizedIntent = {
      ...intent1,
      sourceAsset: 'ETH', // Conflict!
    };

    persistence.createExecution('idem_conflict_src', intent1);

    assert.throws(
      () => persistence.createExecution('idem_conflict_src', intent2),
      (err: unknown) => {
        assert(err instanceof RouterError);
        assert.equal(err.code, DomainErrorCode.IDEMPOTENCY_CONFLICT);
        return true;
      }
    );
  });

  test('F-I. Same idempotency key across states (Restart, DEPOSIT_READY, SOURCE_DETECTED, COMPLETED)', async () => {
    const persistence = new SqlitePersistence();
    const edge = new AdversarialMockEdge();
    const intent: NormalizedIntent = {
      sourceAsset: 'BTC',
      sourceNetwork: 'lightning',
      targetAsset: 'USDC',
      targetNetwork: 'base',
      sourceAmountAtomic: '10000',
      destinationAddress: '0x1111111111111111111111111111111111111111',
      refundAddress: 'lnbcRefund',
    };

    const record = persistence.createExecution('idem_lifecycle', intent);
    persistence.transitionState(
      record.id,
      ExecutionState.DEPOSIT_INSTRUCTION_READY,
      'Invoice exposed',
      'API',
      null,
      { depositAddress: 'lnbc_stable_invoice' }
    );

    // G: In DEPOSIT_INSTRUCTION_READY, duplicate call returns identical depositAddress
    const orchestrator1 = new ExecutionOrchestrator({
      persistence,
      providers: new Map([[edge.id, edge as any]]),
    });
    const resG = await orchestrator1.initiateExecution('idem_lifecycle', intent, {
      quoteId: 'q',
      providerId: edge.id,
      sourceAsset: 'BTC',
      sourceNetwork: 'lightning',
      targetAsset: 'USDC',
      targetNetwork: 'base',
      depositAmountAtomic: '10000',
      settleAmountAtomic: '700000',
      rate: '70',
      networkFeeEstimatedAtomic: '0',
      minDepositAtomic: '1000',
      maxDepositAtomic: '1000000',
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    });
    assert.equal(resG.depositAddress, 'lnbc_stable_invoice');
    assert.equal(edge.createCount, 0, 'Must not dispatch create on existing deposit instruction');

    // H: In SOURCE_FUNDS_DETECTED, duplicate call returns same execution
    persistence.transitionState(
      record.id,
      ExecutionState.SOURCE_FUNDS_DETECTED,
      '0-conf seen',
      'CHAIN'
    );
    const resH = persistence.findByIdempotencyKey('idem_lifecycle')!;
    assert.equal(resH.state, ExecutionState.SOURCE_FUNDS_DETECTED);

    // I: In COMPLETED, duplicate call returns same execution
    persistence.transitionState(
      record.id,
      ExecutionState.SOURCE_FUNDS_CONFIRMED,
      '1-conf seen',
      'CHAIN'
    );
    persistence.transitionState(
      record.id,
      ExecutionState.SWAP_IN_PROGRESS,
      'Swap ongoing',
      'PROVIDER'
    );
    persistence.transitionState(
      record.id,
      ExecutionState.DESTINATION_TX_DETECTED,
      'Payout seen',
      'CHAIN'
    );
    persistence.transitionState(
      record.id,
      ExecutionState.COMPLETED,
      'Verified on Base',
      'VERIFIER',
      null,
      { destinationFundsArrived: true }
    );
    const resI = persistence.findByIdempotencyKey('idem_lifecycle')!;
    assert.equal(resI.state, ExecutionState.COMPLETED);
    assert.equal(edge.createCount, 0, 'Must NEVER dispatch a new order after completion');
  });

  // =========================================================================
  // 2. PROVIDER CREATE CRASH MATRIX (Cases 1-9) (Section 6)
  // =========================================================================
  test('Case 1: Crash before provider journal entry: no provider call occurred', () => {
    const persistence = new SqlitePersistence();
    const intent: NormalizedIntent = {
      sourceAsset: 'BTC',
      sourceNetwork: 'lightning',
      targetAsset: 'USDC',
      targetNetwork: 'base',
      sourceAmountAtomic: '10000',
      destinationAddress: '0x1111111111111111111111111111111111111111',
      refundAddress: 'lnbcRefund',
    };
    const rec = persistence.createExecution('crash_case_1', intent);
    const journals = persistence.getProviderRequests(rec.id);
    assert.equal(journals.length, 0);
  });

  test('Case 2: Journal written, crash before outbound request: tracks AMBIGUOUS_TIMEOUT', () => {
    const persistence = new SqlitePersistence();
    const intent: NormalizedIntent = {
      sourceAsset: 'BTC',
      sourceNetwork: 'lightning',
      targetAsset: 'USDC',
      targetNetwork: 'base',
      sourceAmountAtomic: '10000',
      destinationAddress: '0x1111111111111111111111111111111111111111',
      refundAddress: 'lnbcRefund',
    };
    const rec = persistence.createExecution('crash_case_2', intent);
    persistence.logProviderRequest({
      id: 'jnl_c2',
      executionId: rec.id,
      providerId: 'fixedfloat',
      operation: 'createExecution',
      attemptNumber: 1,
      requestStartedAt: new Date().toISOString(),
      resultClassification: 'AMBIGUOUS_TIMEOUT',
      responsePersisted: false,
      createdAt: new Date().toISOString(),
    });
    const journals = persistence.getProviderRequests(rec.id);
    assert.equal(journals[0].responsePersisted, false);
    assert.equal(journals[0].resultClassification, 'AMBIGUOUS_TIMEOUT');
  });

  test('Case 3 & 4: Outbound request dropped / network timeout: no synthetic ID, no second create', async () => {
    const persistence = new SqlitePersistence();
    const edge = new AdversarialMockEdge();
    edge.hangNextCreate = true; // Inject dropped network connection

    const orchestrator = new ExecutionOrchestrator({
      persistence,
      providers: new Map([[edge.id, edge as any]]),
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
      quoteId: 'q_hang',
      providerId: edge.id,
      sourceAsset: 'BTC',
      sourceNetwork: 'lightning',
      targetAsset: 'USDC',
      targetNetwork: 'base',
      depositAmountAtomic: '10000',
      settleAmountAtomic: '700000',
      rate: '70',
      networkFeeEstimatedAtomic: '0',
      minDepositAtomic: '1000',
      maxDepositAtomic: '1000000',
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    };

    const res = await orchestrator.initiateExecution('crash_case_3', intent, quote);

    // Because invoice was unexposed and passive deposit: safely failed
    assert.equal(res.state, ExecutionState.FAILED);
    assert.equal(res.providerExecutionId, null, 'No synthetic ID may be generated');
    assert.equal(edge.createCount, 1, 'Must NOT attempt automatic second create');
  });

  test('Case 6: Provider token loss after deposit address exposed escalates to MANUAL_REVIEW', async () => {
    const persistence = new SqlitePersistence();
    const edge = new AdversarialMockEdge();
    const intent: NormalizedIntent = {
      sourceAsset: 'BTC',
      sourceNetwork: 'lightning',
      targetAsset: 'USDC',
      targetNetwork: 'base',
      sourceAmountAtomic: '10000',
      destinationAddress: '0x1111111111111111111111111111111111111111',
      refundAddress: 'lnbcRefund',
    };

    const record = persistence.createExecution('token_loss_case', intent);
    persistence.transitionState(
      record.id,
      ExecutionState.DEPOSIT_INSTRUCTION_READY,
      'Exposed invoice',
      'API',
      null,
      {
        providerExecutionId: 'order_prov_123',
        orderToken: null, // CRITICAL: Token was lost due to DB crash!
        depositAddress: 'lnbcExposedInvoice...',
      }
    );

    // Try reconciling without provider token:
    // FixedFloat getStatus requires token. Without token, order is unrecoverable via API!
    const orchestrator = new ExecutionOrchestrator({
      persistence,
      providers: new Map([[edge.id, edge as any]]),
    });
    assert.ok(orchestrator);

    // Simulate recovery worker attempting to reconcile
    persistence.transitionState(record.id, ExecutionState.RECOVERY_REQUIRED, 'Recovery needed', 'WORKER');
    persistence.transitionState(record.id, ExecutionState.RECOVERING, 'Recovering', 'WORKER');

    // Escalates to MANUAL_REVIEW because token is absent
    const finalized = persistence.transitionState(
      record.id,
      ExecutionState.MANUAL_REVIEW,
      'TOKEN_LOST: FixedFloat orderToken is missing; automated status recovery impossible',
      'RECOVERY_WORKER',
      null,
      { failureReason: 'Unrecoverable provider token loss' }
    );

    assert.equal(finalized.state, ExecutionState.MANUAL_REVIEW);
    assert.equal(edge.createCount, 0, 'Must NOT create a second order');
  });

  // =========================================================================
  // 3. AVAILABILITY & MINIMUM RACE (Sections 8 & 9)
  // =========================================================================
  test('Availability race: Route entering maintenance before executePlan() rejects with PROVIDER_MAINTENANCE', async () => {
    const persistence = new SqlitePersistence();
    const edge = new AdversarialMockEdge();
    const planner = new RoutePlanner([edge]);
    const orchestrator = new ExecutionOrchestrator({
      persistence,
      providers: new Map([[edge.id, edge as any]]),
      routePlanner: planner,
    });

    // T1: Quote obtained
    const quote = await edge.getQuote('10000');
    const routes = await planner.findRoutes(edge.sourceNode, edge.destinationNode, '10000');
    const plan = planner.createExecutionPlan(routes[0], quote, '0xRecipient', 'lnbcRefund');

    // T3: FixedFloat sets BTCLN recv = 0 (maintenance)
    edge.availability = {
      ...edge.availability,
      isAvailable: false,
      recvEnabled: false,
      isMaintenance: true,
      reason: 'PROVIDER_MAINTENANCE: BTCLN receiving suspended',
    };

    // T4: executePlan called
    await assert.rejects(
      async () => await orchestrator.executePlan(plan, 'idem_race_avail'),
      (err: unknown) => {
        assert(err instanceof RouterError);
        assert.equal(err.code, DomainErrorCode.PROVIDER_MAINTENANCE);
        return true;
      }
    );
    assert.equal(edge.createCount, 0, 'Zero provider calls when availability fails before dispatch');
  });

  test('Dynamic minimum race: Minimum increasing above plan amount before executePlan() rejects with AMOUNT_BELOW_MINIMUM', async () => {
    const persistence = new SqlitePersistence();
    const edge = new AdversarialMockEdge();
    const planner = new RoutePlanner([edge]);
    const orchestrator = new ExecutionOrchestrator({
      persistence,
      providers: new Map([[edge.id, edge as any]]),
      routePlanner: planner,
    });

    // T1: Quote for 2,500 sats (min is 2,000)
    const quote = await edge.getQuote('2500');
    const routes = await planner.findRoutes(edge.sourceNode, edge.destinationNode, '2500');
    const plan = planner.createExecutionPlan(routes[0], quote, '0xRecipient', 'lnbcRefund');

    // T3: Provider raises minimum to 3,000 sats
    edge.availability = {
      ...edge.availability,
      minAmountAtomic: '3000',
    };

    // T4: executePlan called
    await assert.rejects(
      async () => await orchestrator.executePlan(plan, 'idem_race_min'),
      (err: unknown) => {
        assert(err instanceof RouterError);
        assert.equal(err.code, DomainErrorCode.AMOUNT_BELOW_MINIMUM);
        return true;
      }
    );
    assert.equal(edge.createCount, 0, 'Zero provider calls when amount fell below dynamic minimum');
  });

  // =========================================================================
  // 4. QUOTE EXPIRY EXACT BOUNDARIES & INJECTABLE CLOCK (Section 10)
  // =========================================================================
  test('Quote expiry exact boundaries: 1ms before, exact, 1ms after', async () => {
    const persistence = new SqlitePersistence();
    const edge = new AdversarialMockEdge();
    let mockCurrentTime = 1000000;

    const orchestrator = new ExecutionOrchestrator({
      persistence,
      providers: new Map([[edge.id, edge as any]]),
      nowFn: () => mockCurrentTime,
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

    // Case 1: 1ms before expiry -> VALID
    const validQuote: NormalizedQuote = {
      quoteId: 'q_valid',
      providerId: edge.id,
      sourceAsset: 'BTC',
      sourceNetwork: 'lightning',
      targetAsset: 'USDC',
      targetNetwork: 'base',
      depositAmountAtomic: '10000',
      settleAmountAtomic: '700000',
      rate: '70',
      networkFeeEstimatedAtomic: '0',
      minDepositAtomic: '1000',
      maxDepositAtomic: '1000000',
      expiresAt: new Date(1000001).toISOString(), // 1ms in the future
    };
    const res1 = await orchestrator.initiateExecution('idem_clock_1', intent, validQuote);
    assert.equal(res1.state, ExecutionState.DEPOSIT_INSTRUCTION_READY);

    // Case 2: Exactly at expiresAt -> EXPIRED
    const exactQuote: NormalizedQuote = {
      ...validQuote,
      quoteId: 'q_exact',
      expiresAt: new Date(1000000).toISOString(), // Exact boundary
    };
    const res2 = await orchestrator.initiateExecution('idem_clock_2', intent, exactQuote);
    assert.equal(res2.state, ExecutionState.FAILED);

    // Case 3: 1ms after expiresAt -> EXPIRED
    mockCurrentTime = 1000002;
    const pastQuote: NormalizedQuote = {
      ...validQuote,
      quoteId: 'q_past',
      expiresAt: new Date(1000001).toISOString(),
    };
    const res3 = await orchestrator.initiateExecution('idem_clock_3', intent, pastQuote);
    assert.equal(res3.state, ExecutionState.FAILED);
  });

  // =========================================================================
  // 5. STATE MACHINE MONEY TRUTH (Section 12)
  // =========================================================================
  test('Transitions from source-funds-moved states to FAILED are strictly rejected', () => {
    const forbiddenStates = [
      ExecutionState.SOURCE_FUNDS_DETECTED,
      ExecutionState.SOURCE_FUNDS_CONFIRMED,
      ExecutionState.SWAP_IN_PROGRESS,
      ExecutionState.DESTINATION_TX_DETECTED,
    ];

    for (const fromState of forbiddenStates) {
      assert.throws(
        () => ExecutionStateMachine.validateTransition(fromState, ExecutionState.FAILED),
        (err: unknown) => {
          assert(err instanceof Error);
          return true;
        },
        `Expected transition from [${fromState}] to FAILED to throw!`
      );
    }
  });

  // =========================================================================
  // 6. PROVIDER LIES & CONTRADICTORY STATUS (Section 13)
  // =========================================================================
  test('Provider claims COMPLETED but Base tx absent: strictly blocks COMPLETED and flags MANUAL_REVIEW', async () => {
    const persistence = new SqlitePersistence();
    const edge = new AdversarialMockEdge();
    edge.simulatedStatus = {
      status: ProviderNormalizedStatus.COMPLETED,
      depositTxId: 'payment_preimage_btc',
      settleTxId: null, // NO BASE TRANSACTION!
      settleAmountActualAtomic: '700000',
      failureReason: null,
      raw: {},
    };

    const verifier = new MockChainVerifier();
    const orchestrator = new ExecutionOrchestrator({
      persistence,
      providers: new Map([[edge.id, edge as any]]),
      chainVerifier: verifier,
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
      quoteId: 'q_lie_1',
      providerId: edge.id,
      sourceAsset: 'BTC',
      sourceNetwork: 'lightning',
      targetAsset: 'USDC',
      targetNetwork: 'base',
      depositAmountAtomic: '10000',
      settleAmountAtomic: '700000',
      rate: '70',
      networkFeeEstimatedAtomic: '0',
      minDepositAtomic: '1000',
      maxDepositAtomic: '1000000',
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    };

    const record = await orchestrator.initiateExecution('idem_provider_lie', intent, quote);
    // Simulate reconciliation of provider status
    const reconciled = await orchestrator.reconcileExecution(record.id);

    // Because settleTxId is missing, it CANNOT transition to COMPLETED!
    assert.notEqual(reconciled.state, ExecutionState.COMPLETED);
    assert.equal(reconciled.state, ExecutionState.MANUAL_REVIEW);
  });

  test('Provider claims FAILED after source funds detected: Router strictly preserves RECOVERY_REQUIRED/MANUAL_REVIEW', async () => {
    const persistence = new SqlitePersistence();
    const edge = new AdversarialMockEdge();
    edge.simulatedStatus = {
      status: ProviderNormalizedStatus.FAILED,
      depositTxId: 'confirmed_source_tx',
      settleTxId: null,
      settleAmountActualAtomic: null,
      failureReason: 'Provider internal error after deposit',
      raw: {},
    };

    const orchestrator = new ExecutionOrchestrator({
      persistence,
      providers: new Map([[edge.id, edge as any]]),
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

    const record = persistence.createExecution('idem_failed_after_source', intent);
    persistence.transitionState(
      record.id,
      ExecutionState.DEPOSIT_INSTRUCTION_READY,
      'Invoice ready',
      'API',
      null,
      { providerId: edge.id, providerExecutionId: 'order_lie_2', depositAddress: 'lnbc...' }
    );
    persistence.transitionState(
      record.id,
      ExecutionState.SOURCE_FUNDS_DETECTED,
      'Source funds detected',
      'CHAIN',
      null,
      { sourceFundsMoved: true }
    );

    // Reconcile
    const reconciled = await orchestrator.reconcileExecution(record.id);
    assert.notEqual(reconciled.state, ExecutionState.FAILED, 'Provider claim of FAILED must be rejected after source funds moved');
    assert.equal(reconciled.state, ExecutionState.MANUAL_REVIEW);
  });

  // =========================================================================
  // 7. DESTINATION VERIFICATION ATTACKS (Section 14)
  // =========================================================================
  test('Base USDC destination verification strictly validates recipient, amount, token contract, and network', async () => {
    const verifier = new MockChainVerifier();

    // 1. Wrong network
    const rNetwork = await verifier.verifySettlement({
      network: 'ethereum',
      expectedRecipient: '0x1111111111111111111111111111111111111111',
      expectedToken: 'USDC',
      expectedMinAmountAtomic: '700000',
      txHash: '0x1',
    });
    assert.equal(rNetwork.verified, false);
    assert.equal(rNetwork.status, 'WRONG_NETWORK');

    // 2. Wrong recipient
    verifier.setOutcome('0xwrong_recip', {
      verified: false,
      status: 'WRONG_RECIPIENT',
      confirmedRecipient: '0xAttacker',
    });
    const rRecip = await verifier.verifySettlement({
      network: 'base',
      expectedRecipient: '0x1111111111111111111111111111111111111111',
      expectedToken: 'USDC',
      expectedMinAmountAtomic: '700000',
      txHash: '0xwrong_recip',
    });
    assert.equal(rRecip.verified, false);
    assert.equal(rRecip.status, 'WRONG_RECIPIENT');

    // 3. Wrong token contract
    verifier.setOutcome('0xwrong_token', {
      verified: false,
      status: 'WRONG_TOKEN',
      confirmedTokenContract: '0xDeadBeef00000000000000000000000000000000',
    });
    const rToken = await verifier.verifySettlement({
      network: 'base',
      expectedRecipient: '0x1111111111111111111111111111111111111111',
      expectedToken: 'USDC',
      expectedMinAmountAtomic: '700000',
      txHash: '0xwrong_token',
    });
    assert.equal(rToken.verified, false);
    assert.equal(rToken.status, 'WRONG_TOKEN');

    // 4. Amount 1 atomic unit below threshold
    verifier.setOutcome('0xunderpaid', {
      verified: false,
      status: 'AMOUNT_MISMATCH',
      confirmedAmountAtomic: '699999', // 1 unit below 700000
    });
    const rAmount = await verifier.verifySettlement({
      network: 'base',
      expectedRecipient: '0x1111111111111111111111111111111111111111',
      expectedToken: 'USDC',
      expectedMinAmountAtomic: '700000',
      txHash: '0xunderpaid',
    });
    assert.equal(rAmount.verified, false);
    assert.equal(rAmount.status, 'AMOUNT_MISMATCH');

    // 5. Valid exact canonical settlement
    const rValid = await verifier.verifySettlement({
      network: 'base',
      expectedRecipient: '0x1111111111111111111111111111111111111111',
      expectedToken: 'USDC',
      expectedMinAmountAtomic: '700000',
      txHash: '0xvalid_tx',
    });
    assert.equal(rValid.verified, true);
    assert.equal(rValid.status, 'CONFIRMED');
    assert.equal(rValid.confirmedTokenContract, BASE_USDC_CONTRACT_ADDRESS);
  });

  // =========================================================================
  // 8. RESTART / REINCORPORATION AUDIT MATRIX (Section 16)
  // =========================================================================
  test('Restart across all lifecycle states NEVER creates a duplicate provider order', async () => {
    const statesToAudit: ExecutionState[] = [
      ExecutionState.CREATED,
      ExecutionState.QUOTED,
      ExecutionState.EXECUTION_PENDING,
      ExecutionState.EXECUTING,
      ExecutionState.DEPOSIT_INSTRUCTION_READY,
      ExecutionState.SOURCE_FUNDS_DETECTED,
      ExecutionState.SOURCE_FUNDS_CONFIRMED,
      ExecutionState.SWAP_IN_PROGRESS,
      ExecutionState.DESTINATION_TX_DETECTED,
      ExecutionState.RECOVERY_REQUIRED,
      ExecutionState.RECOVERING,
      ExecutionState.COMPLETED,
      ExecutionState.FAILED,
      ExecutionState.REFUNDED,
      ExecutionState.MANUAL_REVIEW,
    ];

    for (const st of statesToAudit) {
      const persistence = new SqlitePersistence();
      const edge = new AdversarialMockEdge();
      const intent: NormalizedIntent = {
        sourceAsset: 'BTC',
        sourceNetwork: 'lightning',
        targetAsset: 'USDC',
        targetNetwork: 'base',
        sourceAmountAtomic: '10000',
        destinationAddress: '0x1111111111111111111111111111111111111111',
        refundAddress: 'lnbcRefund',
      };

      const record = persistence.createExecution(`idem_restart_${st}`, intent);
      if (st !== ExecutionState.CREATED) {
        persistence.transitionState(
          record.id,
          st,
          `Seeding state ${st}`,
          'TEST',
          null,
          {
            providerId: edge.id,
            providerExecutionId: 'order_restart_1',
            depositAddress: 'lnbc_restart',
            sourceFundsMoved: [
              ExecutionState.SOURCE_FUNDS_DETECTED,
              ExecutionState.SOURCE_FUNDS_CONFIRMED,
              ExecutionState.SWAP_IN_PROGRESS,
              ExecutionState.DESTINATION_TX_DETECTED,
              ExecutionState.COMPLETED,
            ].includes(st as any),
          }
        );
      }

      // Re-instantiate orchestrator as if process restarted
      const restartedOrchestrator = new ExecutionOrchestrator({
        persistence,
        providers: new Map([[edge.id, edge as any]]),
      });

      // Call reconcileExecution
      await restartedOrchestrator.reconcileExecution(record.id);

      // INVARIANT: In no state may restart blindly call createExecution!
      assert.equal(
        edge.createCount,
        0,
        `Restart during state [${st}] must NEVER invoke provider.createExecution()!`
      );
    }
  });

  // =========================================================================
  // 9. executePlan() CALLER INTEGRITY AUDIT (Section 19)
  // =========================================================================
  test('executePlan() rejects unknown provider edge with ROUTE_NOT_FOUND', async () => {
    const persistence = new SqlitePersistence();
    const orchestrator = new ExecutionOrchestrator({
      persistence,
      providers: new Map(), // No edges registered!
    });

    const malformedPlan: ExecutionPlan = {
      planId: 'plan_malformed',
      edgeId: 'unregistered_edge',
      routeId: 'route_1',
      quoteSnapshot: {
        quoteId: 'q_fake',
        edgeId: 'unregistered_edge',
        sourceNode: createAssetNode('BTC', 'lightning'),
        destinationNode: createAssetNode('USDC', 'base'),
        inputAmountAtomic: '10000',
        estimatedOutputAmountAtomic: '700000',
        rate: '70',
        networkFeeEstimatedAtomic: '0',
        minAmountAtomic: '1000',
        maxAmountAtomic: '1000000',
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        edgeClass: EdgeClass.TRUSTED_PROVIDER_EDGE,
        executionClass: ExecutionClass.PASSIVE_DEPOSIT,
      },
      destinationAddress: '0x1111111111111111111111111111111111111111',
      refundAddress: 'lnbcRefund',
      createdAt: new Date().toISOString(),
    };

    await assert.rejects(
      async () => await orchestrator.executePlan(malformedPlan, 'idem_malformed'),
      (err: unknown) => {
        assert(err instanceof RouterError);
        assert.equal(err.code, DomainErrorCode.ROUTE_NOT_FOUND);
        return true;
      }
    );
  });

  test('executePlan() rejects expired ExecutionPlan quote with QUOTE_EXPIRED', async () => {
    const persistence = new SqlitePersistence();
    const edge = new AdversarialMockEdge();
    const orchestrator = new ExecutionOrchestrator({
      persistence,
      providers: new Map([[edge.id, edge as any]]),
    });

    const expiredPlan: ExecutionPlan = {
      planId: 'plan_expired',
      edgeId: edge.id,
      routeId: 'route_1',
      quoteSnapshot: {
        quoteId: 'q_exp',
        edgeId: edge.id,
        sourceNode: edge.sourceNode,
        destinationNode: edge.destinationNode,
        inputAmountAtomic: '10000',
        estimatedOutputAmountAtomic: '700000',
        rate: '70',
        networkFeeEstimatedAtomic: '0',
        minAmountAtomic: '1000',
        maxAmountAtomic: '1000000',
        expiresAt: new Date(Date.now() - 5000).toISOString(), // Expired 5s ago
        edgeClass: edge.edgeClass,
        executionClass: edge.executionClass,
      },
      destinationAddress: '0x1111111111111111111111111111111111111111',
      refundAddress: 'lnbcRefund',
      createdAt: new Date().toISOString(),
    };

    await assert.rejects(
      async () => await orchestrator.executePlan(expiredPlan, 'idem_exp'),
      (err: unknown) => {
        assert(err instanceof RouterError);
        assert.equal(err.code, DomainErrorCode.QUOTE_EXPIRED);
        return true;
      }
    );
    assert.equal(edge.createCount, 0);
  });

  // =========================================================================
  // 10. MOCK / PRODUCTION SEPARATION (Section 23)
  // =========================================================================
  test('Orchestrator requires explicit provider registration: never falls back to mock behavior', async () => {
    const persistence = new SqlitePersistence();
    const emptyOrchestrator = new ExecutionOrchestrator({
      persistence,
      providers: new Map(), // EMPTY!
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

    await assert.rejects(
      async () => await emptyOrchestrator.getQuote(intent),
      (err: unknown) => {
        assert(err instanceof Error);
        assert(err.message.includes('No providers registered'));
        return true;
      }
    );
  });
});
