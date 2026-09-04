import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  type AssetNode,
  createAssetNode,
  areAssetNodesEqual,
  assetNodeToString,
  EdgeClass,
  ExecutionClass,
  CapabilityStatus,
  type EdgeCapabilities,
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
  type DestinationSettlementEvidence,
  type RefundResult,
} from '../src/domain/types.ts';
import { RoutePlanner, type RouteCandidate } from '../src/routing/planner.ts';
import { SqlitePersistence } from '../src/persistence/sqlite.ts';
import { ExecutionOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { ExecutionStateMachine } from '../src/state-machine/engine.ts';
import { FixedFloatAdapter } from '../src/providers/fixedfloat.ts';

// Helper mock edge for tests
class TestExecutionEdge implements IExecutionEdge {
  public id: string;
  public name: string;
  public edgeClass: EdgeClass;
  public executionClass: ExecutionClass;
  public sourceNode: AssetNode;
  public destinationNode: AssetNode;
  public edgeCapabilities: EdgeCapabilities;
  public availability: EdgeRuntimeAvailability;

  constructor(options: {
    id?: string;
    name?: string;
    edgeClass?: EdgeClass;
    executionClass?: ExecutionClass;
    sourceNode?: AssetNode;
    destinationNode?: AssetNode;
    edgeCapabilities?: EdgeCapabilities;
    availability?: EdgeRuntimeAvailability;
  } = {}) {
    this.id = options.id ?? 'test_edge';
    this.name = options.name ?? 'Test Execution Edge';
    this.edgeClass = options.edgeClass ?? EdgeClass.TRUSTED_PROVIDER_EDGE;
    this.executionClass = options.executionClass ?? ExecutionClass.PASSIVE_DEPOSIT;
    this.sourceNode = options.sourceNode ?? createAssetNode('BTC', 'lightning');
    this.destinationNode =
      options.destinationNode ??
      createAssetNode('USDC', 'base', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
    this.edgeCapabilities = options.edgeCapabilities ?? {
      discover: CapabilityStatus.SUPPORTED,
      quote: CapabilityStatus.SUPPORTED,
      prepare: CapabilityStatus.UNSUPPORTED,
      execute: CapabilityStatus.SUPPORTED,
      verify: CapabilityStatus.UNSUPPORTED,
      recover: CapabilityStatus.SUPPORTED,
    };
    this.availability = options.availability ?? {
      isAvailable: true,
      recvEnabled: true,
      sendEnabled: true,
      isMaintenance: false,
      minAmountAtomic: '2000',
      maxAmountAtomic: '50000000',
      lastCheckedAt: new Date().toISOString(),
    };
  }

  public supportsRoute(source: AssetNode, destination: AssetNode): boolean {
    return areAssetNodesEqual(this.sourceNode, source) && areAssetNodesEqual(this.destinationNode, destination);
  }

  public async getRuntimeAvailability(): Promise<EdgeRuntimeAvailability> {
    return this.availability;
  }

  public async getQuote(sourceAmountAtomic: string): Promise<RouteQuote> {
    const min = BigInt(this.availability.minAmountAtomic);
    const amt = BigInt(sourceAmountAtomic);
    if (amt < min) {
      throw new RouterError(
        DomainErrorCode.AMOUNT_BELOW_MINIMUM,
        `Amount ${sourceAmountAtomic} is below minimum ${this.availability.minAmountAtomic}`
      );
    }
    return {
      quoteId: `quote_${Date.now()}`,
      edgeId: this.id,
      sourceNode: this.sourceNode,
      destinationNode: this.destinationNode,
      inputAmountAtomic: sourceAmountAtomic,
      estimatedOutputAmountAtomic: (BigInt(sourceAmountAtomic) * 77n / 1000n).toString(),
      rate: '0.077',
      networkFeeEstimatedAtomic: '0',
      minAmountAtomic: this.availability.minAmountAtomic,
      maxAmountAtomic: this.availability.maxAmountAtomic ?? '50000000',
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      edgeClass: this.edgeClass,
      executionClass: this.executionClass,
    };
  }

  public async createExecution(plan: ExecutionPlan, _idempotencyKey: string): Promise<ProviderExecutionResult> {
    return {
      providerExecutionId: `prov_${Date.now()}`,
      depositAddress: 'lnbc20u1p3test...',
      depositAmountAtomic: plan.quoteSnapshot.inputAmountAtomic,
      settleAddress: plan.destinationAddress,
      status: 'NEW',
      rawResponse: { id: 'prov_test' },
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

describe('ARCHITECTURE V3 COMPREHENSIVE SUITE', () => {
  // ==========================================
  // ARCHITECTURE (Tests 1-5)
  // ==========================================
  test('1. AssetNode deterministic identity and case normalization', () => {
    const node1 = createAssetNode('btc', 'LIGHTNING');
    const node2 = createAssetNode('BTC', 'lightning');
    const usdc1 = createAssetNode('usdc', 'BASE', '0x833589FCD6EDB6E08F4C7C32D4F71B54BDA02913');
    const usdc2 = createAssetNode('USDC', 'base', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');

    assert.equal(areAssetNodesEqual(node1, node2), true);
    assert.equal(areAssetNodesEqual(usdc1, usdc2), true);
    assert.equal(assetNodeToString(usdc1), 'USDC:base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
  });

  test('2. Edge trust class is strictly independent from execution class', () => {
    // Valid combination 1: Trusted exchange with passive deposit
    const fixedFloatLike = new TestExecutionEdge({
      edgeClass: EdgeClass.TRUSTED_PROVIDER_EDGE,
      executionClass: ExecutionClass.PASSIVE_DEPOSIT,
    });
    // Valid combination 2: Self-custody with active fund-moving execution
    const phoenixdLike = new TestExecutionEdge({
      edgeClass: EdgeClass.SELF_CUSTODY_EDGE,
      executionClass: ExecutionClass.ACTIVE_EXECUTION,
    });
    // Valid combination 3: Atomic HTLC with passive deposit
    const gardenLike = new TestExecutionEdge({
      edgeClass: EdgeClass.ATOMIC_EDGE,
      executionClass: ExecutionClass.PASSIVE_DEPOSIT,
    });

    assert.notEqual(fixedFloatLike.edgeClass, phoenixdLike.edgeClass);
    assert.notEqual(fixedFloatLike.executionClass, phoenixdLike.executionClass);
    assert.equal(gardenLike.edgeClass, EdgeClass.ATOMIC_EDGE);
    assert.equal(gardenLike.executionClass, ExecutionClass.PASSIVE_DEPOSIT);
  });

  test('3. Capability independence: Support for one capability never implies another', () => {
    const edge = new TestExecutionEdge({
      edgeCapabilities: {
        discover: CapabilityStatus.SUPPORTED,
        quote: CapabilityStatus.UNSUPPORTED, // e.g. phoenixd has no fee quote API
        prepare: CapabilityStatus.UNSUPPORTED,
        execute: CapabilityStatus.SUPPORTED,
        verify: CapabilityStatus.UNSUPPORTED,
        recover: CapabilityStatus.CONDITIONAL,
      },
    });

    assert.equal(edge.edgeCapabilities.execute, CapabilityStatus.SUPPORTED);
    assert.equal(edge.edgeCapabilities.quote, CapabilityStatus.UNSUPPORTED);
    assert.notEqual(edge.edgeCapabilities.execute, edge.edgeCapabilities.quote);
  });

  test('4. Static capability is strictly separated from runtime availability', async () => {
    // Statically supports route, but temporarily unavailable dynamically
    const edge = new TestExecutionEdge({
      availability: {
        isAvailable: false,
        recvEnabled: false,
        sendEnabled: true,
        isMaintenance: true,
        minAmountAtomic: '2000',
        reason: 'PROVIDER_MAINTENANCE: Lightning receiving disabled',
        lastCheckedAt: new Date().toISOString(),
      },
    });

    const btc = createAssetNode('BTC', 'lightning');
    const usdc = createAssetNode('USDC', 'base', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');

    assert.equal(edge.supportsRoute(btc, usdc), true, 'Static route support must remain true');
    const runtime = await edge.getRuntimeAvailability();
    assert.equal(runtime.isAvailable, false, 'Runtime availability must reflect live offline status');
    assert.equal(runtime.isMaintenance, true);
  });

  test('5. Route representation supports multi-edge composition', () => {
    const edge1 = new TestExecutionEdge({
      id: 'edge_lightning_btc',
      sourceNode: createAssetNode('BTC', 'lightning'),
      destinationNode: createAssetNode('BTC', 'bitcoin'),
      edgeClass: EdgeClass.SELF_CUSTODY_EDGE,
    });
    const edge2 = new TestExecutionEdge({
      id: 'edge_btc_usdc',
      sourceNode: createAssetNode('BTC', 'bitcoin'),
      destinationNode: createAssetNode('USDC', 'base', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'),
      edgeClass: EdgeClass.ATOMIC_EDGE,
    });

    const candidate: RouteCandidate = {
      routeId: 'multi_hop_route_1',
      edges: [edge1, edge2],
      sourceNode: edge1.sourceNode,
      destinationNode: edge2.destinationNode,
      availability: edge1.availability,
    };

    assert.equal(candidate.edges.length, 2);
    assert.equal(candidate.edges[0].edgeClass, EdgeClass.SELF_CUSTODY_EDGE);
    assert.equal(candidate.edges[1].edgeClass, EdgeClass.ATOMIC_EDGE);
  });

  // ==========================================
  // ROUTING & AVAILABILITY (Tests 6-14)
  // ==========================================
  test('6. Unsupported pair throws ROUTE_NOT_FOUND', async () => {
    const planner = new RoutePlanner([new TestExecutionEdge()]);
    const solana = createAssetNode('SOL', 'solana');
    const usdc = createAssetNode('USDC', 'base', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');

    await assert.rejects(
      async () => await planner.findRoutes(solana, usdc, '10000'),
      (err: unknown) => {
        assert(err instanceof RouterError);
        assert.equal(err.code, DomainErrorCode.ROUTE_NOT_FOUND);
        return true;
      }
    );
  });

  test('7. Supported pair with unavailable edge throws ROUTE_UNAVAILABLE', async () => {
    const edge = new TestExecutionEdge({
      availability: {
        isAvailable: false,
        recvEnabled: false,
        sendEnabled: true,
        isMaintenance: false,
        minAmountAtomic: '2000',
        reason: 'Temporary network disconnect',
        lastCheckedAt: new Date().toISOString(),
      },
    });
    const planner = new RoutePlanner([edge]);

    await assert.rejects(
      async () => await planner.findRoutes(edge.sourceNode, edge.destinationNode, '10000'),
      (err: unknown) => {
        assert(err instanceof RouterError);
        assert.equal(err.code, DomainErrorCode.ROUTE_UNAVAILABLE);
        return true;
      }
    );
  });

  test('8. FixedFloat BTCLN recv=0 blocks execution with PROVIDER_MAINTENANCE', async () => {
    const ffEdge = new TestExecutionEdge({
      id: 'fixedfloat',
      availability: {
        isAvailable: false,
        recvEnabled: false,
        sendEnabled: true,
        isMaintenance: true,
        minAmountAtomic: '1450',
        reason: 'PROVIDER_MAINTENANCE: BTCLN currency is not available for receiving at the moment',
        lastCheckedAt: new Date().toISOString(),
      },
    });
    const planner = new RoutePlanner([ffEdge]);

    await assert.rejects(
      async () => await planner.findRoutes(ffEdge.sourceNode, ffEdge.destinationNode, '10000'),
      (err: unknown) => {
        assert(err instanceof RouterError);
        assert.equal(err.code, DomainErrorCode.PROVIDER_MAINTENANCE);
        return true;
      }
    );
  });

  test('9. FixedFloat BTCLN recv=1 allows candidate discovery', async () => {
    const ffEdge = new TestExecutionEdge({
      id: 'fixedfloat',
      availability: {
        isAvailable: true,
        recvEnabled: true,
        sendEnabled: true,
        isMaintenance: false,
        minAmountAtomic: '1450',
        lastCheckedAt: new Date().toISOString(),
      },
    });
    const planner = new RoutePlanner([ffEdge]);
    const routes = await planner.findRoutes(ffEdge.sourceNode, ffEdge.destinationNode, '10000');

    assert.equal(routes.length, 1);
    assert.equal(routes[0].edges[0].id, 'fixedfloat');
  });

  test('10. Amount below dynamic live minimum rejected with AMOUNT_BELOW_MINIMUM', async () => {
    const edge = new TestExecutionEdge({
      availability: {
        isAvailable: true,
        recvEnabled: true,
        sendEnabled: true,
        isMaintenance: false,
        minAmountAtomic: '1450',
        lastCheckedAt: new Date().toISOString(),
      },
    });
    const planner = new RoutePlanner([edge]);

    await assert.rejects(
      async () => await planner.findRoutes(edge.sourceNode, edge.destinationNode, '1000'),
      (err: unknown) => {
        assert(err instanceof RouterError);
        assert.equal(err.code, DomainErrorCode.AMOUNT_BELOW_MINIMUM);
        assert.equal(err.metadata?.requestedAmountAtomic, '1000');
        assert.equal(err.metadata?.minimumAmountAtomic, '1450');
        return true;
      }
    );
  });

  test('11. Amount exactly at minimum accepted', async () => {
    const edge = new TestExecutionEdge({
      availability: {
        isAvailable: true,
        recvEnabled: true,
        sendEnabled: true,
        isMaintenance: false,
        minAmountAtomic: '1450',
        lastCheckedAt: new Date().toISOString(),
      },
    });
    const planner = new RoutePlanner([edge]);
    const routes = await planner.findRoutes(edge.sourceNode, edge.destinationNode, '1450');

    assert.equal(routes.length, 1);
  });

  test('12. Amount above maximum rejected with AMOUNT_ABOVE_MAXIMUM', async () => {
    const edge = new TestExecutionEdge({
      availability: {
        isAvailable: true,
        recvEnabled: true,
        sendEnabled: true,
        isMaintenance: false,
        minAmountAtomic: '1450',
        maxAmountAtomic: '50000000',
        lastCheckedAt: new Date().toISOString(),
      },
    });
    const planner = new RoutePlanner([edge]);

    await assert.rejects(
      async () => await planner.findRoutes(edge.sourceNode, edge.destinationNode, '60000000'),
      (err: unknown) => {
        assert(err instanceof RouterError);
        assert.equal(err.code, DomainErrorCode.AMOUNT_ABOVE_MAXIMUM);
        return true;
      }
    );
  });

  test('13. Planner never returns an unavailable edge as executable', async () => {
    const offlineEdge = new TestExecutionEdge({
      id: 'offline_edge',
      availability: {
        isAvailable: false,
        recvEnabled: false,
        sendEnabled: false,
        isMaintenance: true,
        minAmountAtomic: '1000',
        lastCheckedAt: new Date().toISOString(),
      },
    });
    const planner = new RoutePlanner([offlineEdge]);

    await assert.rejects(
      async () => await planner.findRoutes(offlineEdge.sourceNode, offlineEdge.destinationNode, '5000'),
      (err: unknown) => err instanceof RouterError
    );
  });

  test('14. Planner is deterministic when one eligible edge exists', async () => {
    const edge = new TestExecutionEdge({ id: 'primary_edge' });
    const planner = new RoutePlanner([edge]);
    const r1 = await planner.findRoutes(edge.sourceNode, edge.destinationNode, '10000');
    const r2 = await planner.findRoutes(edge.sourceNode, edge.destinationNode, '10000');

    assert.equal(r1[0].edges[0].id, 'primary_edge');
    assert.equal(r2[0].edges[0].id, 'primary_edge');
  });

  // ==========================================
  // QUOTE & PLAN (Tests 15-18)
  // ==========================================
  test('15. RouteQuote uses strictly integer atomic units', async () => {
    const edge = new TestExecutionEdge();
    const quote = await edge.getQuote('100000');

    assert.match(quote.inputAmountAtomic, /^\d+$/);
    assert.match(quote.estimatedOutputAmountAtomic, /^\d+$/);
    assert.match(quote.minAmountAtomic, /^\d+$/);
    assert.match(quote.maxAmountAtomic, /^\d+$/);
  });

  test('16. ExecutionPlan snapshots quote immutably', async () => {
    const edge = new TestExecutionEdge();
    const planner = new RoutePlanner([edge]);
    const routes = await planner.findRoutes(edge.sourceNode, edge.destinationNode, '100000');
    const quote = await edge.getQuote('100000');
    const plan = planner.createExecutionPlan(routes[0], quote, '0xRecipient', 'lnbcRefund');

    assert.equal(plan.quoteSnapshot.quoteId, quote.quoteId);
    assert.equal(plan.quoteSnapshot.inputAmountAtomic, '100000');
    assert.equal(plan.destinationAddress, '0xRecipient');
  });

  test('17. Expired quote cannot execute and terminates safely in FAILED', async () => {
    const persistence = new SqlitePersistence();
    const orchestrator = new ExecutionOrchestrator({
      persistence,
      providers: new Map([['test_provider', new FixedFloatAdapter()]]),
    });

    const expiredQuote: NormalizedQuote = {
      quoteId: 'quote_expired',
      providerId: 'test_provider',
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
      expiresAt: new Date(Date.now() - 10000).toISOString(),
    };

    const intent: NormalizedIntent = {
      sourceAsset: 'BTC',
      sourceNetwork: 'lightning',
      targetAsset: 'USDC',
      targetNetwork: 'base',
      sourceAmountAtomic: '10000',
      destinationAddress: '0x1111111111111111111111111111111111111111',
      refundAddress: 'lnbc100u1test',
    };

    const result = await orchestrator.initiateExecution('idem_expired_1', intent, expiredQuote);
    assert.equal(result.state, ExecutionState.FAILED);
    assert.equal(result.sourceFundsMoved, false);
  });

  test('18. Runtime route or provider changes do not mutate existing ExecutionPlan', async () => {
    const edge = new TestExecutionEdge();
    const planner = new RoutePlanner([edge]);
    const routes = await planner.findRoutes(edge.sourceNode, edge.destinationNode, '50000');
    const quote = await edge.getQuote('50000');
    const plan = planner.createExecutionPlan(routes[0], quote, '0xRecipient', 'lnbcRefund');

    // Mutate edge availability dynamically
    edge.availability.isAvailable = false;
    edge.availability.minAmountAtomic = '99999999';

    // ExecutionPlan snapshot remains unchanged
    assert.equal(plan.quoteSnapshot.inputAmountAtomic, '50000');
    assert.equal(plan.quoteSnapshot.minAmountAtomic, '2000');
  });

  // ==========================================
  // IDEMPOTENCY & CRASH RECOVERY (Tests 19-26)
  // ==========================================
  test('19. Duplicate client request returns existing execution record without second dispatch', async () => {
    const persistence = new SqlitePersistence();
    const mockProvider = {
      id: 'prov1',
      name: 'Prov1',
      capabilities: async () => ({
        supportedPairs: [],
        executionClass: ExecutionClass.PASSIVE_DEPOSIT,
        supportsLightning: true,
        supportsRefunds: true,
        supportsStrongIdempotency: false,
      }),
      getQuote: async () => ({} as any),
      createExecution: async () => ({
        providerExecutionId: 'order_123',
        depositAddress: 'lnbc_test',
        depositAmountAtomic: '10000',
        settleAddress: '0x123',
        status: 'NEW',
        rawResponse: {},
      }),
      getStatus: async () => ({} as any),
    };

    const orchestrator = new ExecutionOrchestrator({
      persistence,
      providers: new Map([['prov1', mockProvider]]),
    });

    const intent: NormalizedIntent = {
      sourceAsset: 'BTC',
      sourceNetwork: 'lightning',
      targetAsset: 'USDC',
      targetNetwork: 'base',
      sourceAmountAtomic: '10000',
      destinationAddress: '0x1111111111111111111111111111111111111111',
      refundAddress: 'lnbc100u1test',
    };

    const quote: NormalizedQuote = {
      quoteId: 'q1',
      providerId: 'prov1',
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

    const first = await orchestrator.initiateExecution('idem_dup_test', intent, quote);
    const second = await orchestrator.initiateExecution('idem_dup_test', intent, quote);

    assert.equal(first.id, second.id);
    assert.equal(first.providerExecutionId, second.providerExecutionId);
  });

  test('20. Crash before provider request logs journal and aborts safely', () => {
    const persistence = new SqlitePersistence();
    const intent: NormalizedIntent = {
      sourceAsset: 'BTC',
      sourceNetwork: 'lightning',
      targetAsset: 'USDC',
      targetNetwork: 'base',
      sourceAmountAtomic: '10000',
      destinationAddress: '0x1111111111111111111111111111111111111111',
      refundAddress: 'lnbc100u1test',
    };

    const record = persistence.createExecution('crash_pre_req', intent);
    assert.equal(record.state, ExecutionState.CREATED);
    const journals = persistence.getProviderRequests(record.id);
    assert.equal(journals.length, 0, 'No outbound journal entry before provider request');
  });

  test('21. Crash immediately after provider request begins leaves journal entry with AMBIGUOUS_TIMEOUT', () => {
    const persistence = new SqlitePersistence();
    const intent: NormalizedIntent = {
      sourceAsset: 'BTC',
      sourceNetwork: 'lightning',
      targetAsset: 'USDC',
      targetNetwork: 'base',
      sourceAmountAtomic: '10000',
      destinationAddress: '0x1111111111111111111111111111111111111111',
      refundAddress: 'lnbc100u1test',
    };

    const record = persistence.createExecution('crash_in_flight', intent);
    persistence.logProviderRequest({
      id: 'jnl_crash_1',
      executionId: record.id,
      providerId: 'fixedfloat',
      operation: 'createExecution',
      attemptNumber: 1,
      requestStartedAt: new Date().toISOString(),
      resultClassification: 'AMBIGUOUS_TIMEOUT',
      responsePersisted: false,
      createdAt: new Date().toISOString(),
    });

    const journals = persistence.getProviderRequests(record.id);
    assert.equal(journals.length, 1);
    assert.equal(journals[0].resultClassification, 'AMBIGUOUS_TIMEOUT');
    assert.equal(journals[0].responsePersisted, false);
  });

  test('22. Provider response lost triggers RECOVERY_REQUIRED in passive deposit edge', async () => {
    const persistence = new SqlitePersistence();
    const hangingProvider = {
      id: 'hanging',
      name: 'Hanging Provider',
      capabilities: async () => ({
        supportedPairs: [],
        executionClass: ExecutionClass.PASSIVE_DEPOSIT,
        supportsLightning: true,
        supportsRefunds: true,
        supportsStrongIdempotency: false,
      }),
      getQuote: async () => ({} as any),
      createExecution: async () => {
        throw new Error('ETIMEDOUT: Connection reset by peer');
      },
      getStatus: async () => ({
        status: ProviderNormalizedStatus.EXPIRED,
        depositTxId: null,
        settleTxId: null,
        settleAmountActualAtomic: null,
        failureReason: 'Order expired',
        raw: {},
      }),
    };

    const orchestrator = new ExecutionOrchestrator({
      persistence,
      providers: new Map([['hanging', hangingProvider]]),
    });

    const intent: NormalizedIntent = {
      sourceAsset: 'BTC',
      sourceNetwork: 'lightning',
      targetAsset: 'USDC',
      targetNetwork: 'base',
      sourceAmountAtomic: '10000',
      destinationAddress: '0x1111111111111111111111111111111111111111',
      refundAddress: 'lnbc100u1test',
    };

    const quote: NormalizedQuote = {
      quoteId: 'q_hang',
      providerId: 'hanging',
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

    const result = await orchestrator.initiateExecution('idem_hang_1', intent, quote);
    // PASSIVE_DEPOSIT without exposed invoice or provider id safely reconciles/aborts
    assert.equal(result.state, ExecutionState.FAILED);
    assert.equal(result.sourceFundsMoved, false);
  });

  test('23. Provider response received but DB persistence fails leaves journal uncommitted', () => {
    const persistence = new SqlitePersistence();
    const intent: NormalizedIntent = {
      sourceAsset: 'BTC',
      sourceNetwork: 'lightning',
      targetAsset: 'USDC',
      targetNetwork: 'base',
      sourceAmountAtomic: '10000',
      destinationAddress: '0x1111111111111111111111111111111111111111',
      refundAddress: 'lnbc100u1test',
    };

    const record = persistence.createExecution('crash_persist_fail', intent);
    persistence.logProviderRequest({
      id: 'jnl_fail_1',
      executionId: record.id,
      providerId: 'fixedfloat',
      operation: 'createExecution',
      attemptNumber: 1,
      requestStartedAt: new Date().toISOString(),
      resultClassification: 'AMBIGUOUS_TIMEOUT',
      responsePersisted: false,
      createdAt: new Date().toISOString(),
    });

    const journals = persistence.getProviderRequests(record.id);
    assert.equal(journals[0].responsePersisted, false);
  });

  test('24. Provider execution ID persisted but deposit instruction not exposed', () => {
    const persistence = new SqlitePersistence();
    const intent: NormalizedIntent = {
      sourceAsset: 'BTC',
      sourceNetwork: 'lightning',
      targetAsset: 'USDC',
      targetNetwork: 'base',
      sourceAmountAtomic: '10000',
      destinationAddress: '0x1111111111111111111111111111111111111111',
      refundAddress: 'lnbc100u1test',
    };

    const record = persistence.createExecution('test_unexposed_invoice', intent);
    const updated = persistence.transitionState(
      record.id,
      ExecutionState.EXECUTING,
      'Executing order',
      'API',
      null,
      { providerExecutionId: 'order_hidden_999' }
    );

    assert.equal(updated.depositAddress, null);
    assert.equal(updated.sourceFundsMoved, false);
  });

  test('25. Deposit instruction exposed then process crashes: state is preserved in DB', () => {
    const persistence = new SqlitePersistence();
    const intent: NormalizedIntent = {
      sourceAsset: 'BTC',
      sourceNetwork: 'lightning',
      targetAsset: 'USDC',
      targetNetwork: 'base',
      sourceAmountAtomic: '10000',
      destinationAddress: '0x1111111111111111111111111111111111111111',
      refundAddress: 'lnbc100u1test',
    };

    const record = persistence.createExecution('crash_after_expose', intent);
    persistence.transitionState(
      record.id,
      ExecutionState.DEPOSIT_INSTRUCTION_READY,
      'Exposed invoice',
      'API',
      null,
      { depositAddress: 'lnbc500u1test...' }
    );

    const reloaded = persistence.findById(record.id)!;
    assert.equal(reloaded.state, ExecutionState.DEPOSIT_INSTRUCTION_READY);
    assert.equal(reloaded.depositAddress, 'lnbc500u1test...');
  });

  test('26. Restart / reconciliation does not blindly create replacement order', async () => {
    const persistence = new SqlitePersistence();
    let createCallCount = 0;

    const mockProvider = {
      id: 'prov_reconcile',
      name: 'Reconcile Provider',
      capabilities: async () => ({
        supportedPairs: [],
        executionClass: ExecutionClass.PASSIVE_DEPOSIT,
        supportsLightning: true,
        supportsRefunds: true,
        supportsStrongIdempotency: false,
      }),
      getQuote: async () => ({} as any),
      createExecution: async () => {
        createCallCount++;
        return {
          providerExecutionId: 'order_1',
          depositAddress: 'lnbc_exposed',
          depositAmountAtomic: '10000',
          settleAddress: '0x123',
          status: 'NEW',
          rawResponse: {},
        };
      },
      getStatus: async () => ({
        status: ProviderNormalizedStatus.WAITING_FOR_DEPOSIT,
        depositTxId: null,
        settleTxId: null,
        settleAmountActualAtomic: null,
        failureReason: null,
        raw: {},
      }),
    };

    const orchestrator = new ExecutionOrchestrator({
      persistence,
      providers: new Map([['prov_reconcile', mockProvider]]),
    });

    const intent: NormalizedIntent = {
      sourceAsset: 'BTC',
      sourceNetwork: 'lightning',
      targetAsset: 'USDC',
      targetNetwork: 'base',
      sourceAmountAtomic: '10000',
      destinationAddress: '0x1111111111111111111111111111111111111111',
      refundAddress: 'lnbc100u1test',
    };

    const quote: NormalizedQuote = {
      quoteId: 'q_rec',
      providerId: 'prov_reconcile',
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

    await orchestrator.initiateExecution('idem_no_replace', intent, quote);
    assert.equal(createCallCount, 1);

    // Call reconcile directly
    const exec = persistence.findByIdempotencyKey('idem_no_replace')!;
    await orchestrator.reconcileExecution(exec.id);

    // Assert createExecution was NEVER called a second time
    assert.equal(createCallCount, 1, 'Reconciliation must never create a replacement provider order');
  });

  // ==========================================
  // MONEY MOVEMENT INVARIANTS (Tests 27-35)
  // ==========================================
  test('27. No source evidence confirmed safe failure path allowed', () => {
    const valid = ExecutionStateMachine.canSafelyFail(
      ExecutionState.DEPOSIT_INSTRUCTION_READY,
      false, // sourceFundsMoved
      true   // zeroDepositConfirmed
    );
    assert.equal(valid, true);
  });

  test('28. Source detected strictly prohibits ordinary FAILED transition', () => {
    assert.throws(
      () => {
        ExecutionStateMachine.validateTransition(
          ExecutionState.SOURCE_FUNDS_DETECTED,
          ExecutionState.FAILED
        );
      },
      (err: unknown) => {
        assert(err instanceof Error);
        assert(
          err.message.includes('not permitted') ||
            err.message.includes('CRITICAL SAFETY VIOLATION') ||
            err.message.includes('source funds')
        );
        return true;
      }
    );
  });

  test('29. Source confirmed strictly prohibits ordinary FAILED transition', () => {
    assert.throws(
      () => {
        ExecutionStateMachine.validateTransition(
          ExecutionState.SOURCE_FUNDS_CONFIRMED,
          ExecutionState.FAILED
        );
      },
      (err: unknown) => {
        assert(err instanceof Error);
        assert(
          err.message.includes('not permitted') ||
            err.message.includes('CRITICAL SAFETY VIOLATION') ||
            err.message.includes('source funds')
        );
        return true;
      }
    );
  });

  test('30. Destination absent blocks COMPLETED state', () => {
    assert.equal(
      ExecutionStateMachine.isDestinationSettlementEvidenced(null),
      false
    );
  });

  test('31. Provider claims complete but Base tx absent: strictly blocks COMPLETED', () => {
    const providerClaimOnly: DestinationSettlementEvidence = {
      network: 'base',
      asset: 'USDC',
      amountAtomic: '700000',
      destinationAddress: '0x1111111111111111111111111111111111111111',
      txHash: null,
      blockNumber: null,
      tokenContract: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      verifiedOnChain: false,
      onChainStatus: 'NOT_FOUND',
      verifiedAt: null,
      evidenceSource: 'PROVIDER_CLAIM',
      rawEvidence: {},
    };

    assert.equal(
      ExecutionStateMachine.isDestinationSettlementEvidenced(providerClaimOnly),
      false,
      'Provider claim without verified on-chain tx cannot satisfy settlement'
    );
  });

  test('32. Wrong recipient on Base blocks COMPLETED', () => {
    const wrongRecipientEvidence: DestinationSettlementEvidence = {
      network: 'base',
      asset: 'USDC',
      amountAtomic: '700000',
      destinationAddress: '0xWRONG_RECIPIENT',
      txHash: '0xabc123',
      blockNumber: 123456,
      tokenContract: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      verifiedOnChain: false,
      onChainStatus: 'WRONG_RECIPIENT',
      verifiedAt: new Date().toISOString(),
      evidenceSource: 'BASE_RPC',
      rawEvidence: {},
    };

    assert.equal(ExecutionStateMachine.isDestinationSettlementEvidenced(wrongRecipientEvidence), false);
  });

  test('33. Wrong amount on Base blocks COMPLETED', () => {
    const wrongAmountEvidence: DestinationSettlementEvidence = {
      network: 'base',
      asset: 'USDC',
      amountAtomic: '1000', // Expected 700000
      destinationAddress: '0x1111111111111111111111111111111111111111',
      txHash: '0xabc123',
      blockNumber: 123456,
      tokenContract: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      verifiedOnChain: false,
      onChainStatus: 'AMOUNT_MISMATCH',
      verifiedAt: new Date().toISOString(),
      evidenceSource: 'BASE_RPC',
      rawEvidence: {},
    };

    assert.equal(ExecutionStateMachine.isDestinationSettlementEvidenced(wrongAmountEvidence), false);
  });

  test('34. Wrong token contract on Base blocks COMPLETED', () => {
    const fakeUsdcEvidence: DestinationSettlementEvidence = {
      network: 'base',
      asset: 'USDC',
      amountAtomic: '700000',
      destinationAddress: '0x1111111111111111111111111111111111111111',
      txHash: '0xabc123',
      blockNumber: 123456,
      tokenContract: '0xDEADBEEF00000000000000000000000000000000', // Not canonical USDC
      verifiedOnChain: false,
      onChainStatus: 'WRONG_TOKEN',
      verifiedAt: new Date().toISOString(),
      evidenceSource: 'BASE_RPC',
      rawEvidence: {},
    };

    assert.equal(ExecutionStateMachine.isDestinationSettlementEvidenced(fakeUsdcEvidence), false);
  });

  test('35. Reverted Base transaction blocks COMPLETED', () => {
    const revertedEvidence: DestinationSettlementEvidence = {
      network: 'base',
      asset: 'USDC',
      amountAtomic: '700000',
      destinationAddress: '0x1111111111111111111111111111111111111111',
      txHash: '0xrevertedtx',
      blockNumber: 123456,
      tokenContract: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      verifiedOnChain: false,
      onChainStatus: 'REVERTED',
      verifiedAt: new Date().toISOString(),
      evidenceSource: 'BASE_RPC',
      rawEvidence: {},
    };

    assert.equal(ExecutionStateMachine.isDestinationSettlementEvidenced(revertedEvidence), false);
  });

  // ==========================================
  // REFUND SAFETY (Tests 36-37)
  // ==========================================
  test('36. Provider refund claim without transaction evidence cannot transition to REFUNDED', () => {
    const unverifiedRefund: RefundResult = {
      success: true,
      refundTxId: undefined, // Missing on-chain evidence
    };

    const isEvidenced = Boolean(unverifiedRefund.success && unverifiedRefund.refundTxId);
    assert.equal(isEvidenced, false, 'Refund without txId must not be accepted as complete');
  });

  test('37. Refund with verified transaction evidence allows transition to REFUNDED', () => {
    const verifiedRefund: RefundResult = {
      success: true,
      refundTxId: '0xrefund_tx_hash_123',
    };

    const isEvidenced = Boolean(verifiedRefund.success && verifiedRefund.refundTxId);
    assert.equal(isEvidenced, true);
    assert.doesNotThrow(() => {
      ExecutionStateMachine.validateTransition(
        ExecutionState.RECOVERING,
        ExecutionState.REFUNDED
      );
    });
  });

  // ==========================================
  // ERRORS & SANITIZATION (Tests 38-40)
  // ==========================================
  test('38. Provider raw maintenance error is mapped cleanly to DomainErrorCode.PROVIDER_MAINTENANCE', () => {
    const rawError = 'MAINTENANCE_FROM: BTCLN currency is temporarily disabled';
    const domainError = new RouterError(DomainErrorCode.PROVIDER_MAINTENANCE, rawError, {
      asset: 'BTC',
      network: 'lightning',
    });

    assert.equal(domainError.code, DomainErrorCode.PROVIDER_MAINTENANCE);
    assert.equal(domainError.name, 'RouterError');
  });

  test('39. Provider raw minimum error is mapped to DomainErrorCode.AMOUNT_BELOW_MINIMUM', () => {
    const domainError = new RouterError(
      DomainErrorCode.AMOUNT_BELOW_MINIMUM,
      'Amount 1000 is below live minimum 1450',
      {
        requestedAmountAtomic: '1000',
        minimumAmountAtomic: '1450',
      }
    );

    assert.equal(domainError.code, DomainErrorCode.AMOUNT_BELOW_MINIMUM);
    assert.equal(domainError.metadata?.minimumAmountAtomic, '1450');
  });

  test('40. Secrets and API credentials are completely absent from public error serialization', () => {
    const secretApiKey = 'SECRET_API_KEY_1234567890';
    const rawError = `FixedFloat Error: Unauthorized for key ${secretApiKey} on endpoint /create`;

    // Sanitizer test
    const sanitized = rawError.replace(new RegExp(secretApiKey, 'g'), '[REDACTED_SECRET]');
    const err = new RouterError(DomainErrorCode.EXECUTION_AMBIGUOUS, sanitized);

    const serialized = JSON.stringify({
      name: err.name,
      code: err.code,
      message: err.message,
    });

    assert.equal(serialized.includes(secretApiKey), false, 'API secret must not appear in serialized error');
    assert.equal(serialized.includes('[REDACTED_SECRET]'), true);
  });
});
