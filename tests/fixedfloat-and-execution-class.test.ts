import test from 'node:test';
import assert from 'node:assert';
import { SqlitePersistence } from '../src/persistence/sqlite.ts';
import { ExecutionOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { FixedFloatAdapter } from '../src/providers/fixedfloat.ts';
import { MockChainVerifier } from '../src/verification/verifier.ts';
import {
  ExecutionState,
  ExecutionClass,
  type NormalizedIntent,
} from '../src/domain/types.ts';
import { ExecutionStateMachine } from '../src/state-machine/engine.ts';

const sampleIntent: NormalizedIntent = {
  sourceAsset: 'BTC',
  sourceNetwork: 'lightning',
  targetAsset: 'USDC',
  targetNetwork: 'base',
  sourceAmountAtomic: '3500', // 3,500 sats (~$2.70)
  destinationAddress: '0x1111111111111111111111111111111111111111',
  refundAddress: 'bc1qtestrefundaddress00000000000000000000',
};

test('Invariant 1: FixedFloat is classified PASSIVE_DEPOSIT', async () => {
  const adapter = new FixedFloatAdapter({
    apiKey: 'fake_test_key_xyz',
    apiSecret: 'fake_test_secret_abc123',
  });
  const caps = await adapter.capabilities();
  assert.strictEqual(caps.executionClass, ExecutionClass.PASSIVE_DEPOSIT);
  assert.strictEqual(caps.supportsLightning, true);
  assert.strictEqual(caps.supportsRefunds, true);
  assert.strictEqual(caps.supportsStrongIdempotency, false);
});

test('Invariant 2: PASSIVE_DEPOSIT ambiguous create before invoice persistence cannot move funds and aborts to FAILED', async () => {
  const persistence = new SqlitePersistence({ filename: ':memory:' });
  const mockProvider = new MockProvider();
  mockProvider.executionClass = ExecutionClass.PASSIVE_DEPOSIT;
  mockProvider.supportsStrongIdempotency = false;
  mockProvider.failureMode = 'TIMEOUT_ON_CREATE';

  const orchestrator = new ExecutionOrchestrator({
    persistence,
    providers: new Map([[mockProvider.id, mockProvider]]),
  });

  const quote = await orchestrator.getQuote(sampleIntent);
  const record = await orchestrator.initiateExecution('passive_ambiguity_key', sampleIntent, quote);

  assert.strictEqual(record.state, ExecutionState.FAILED);
  assert.strictEqual(record.sourceFundsMoved, false);
  assert.strictEqual(record.depositAddress, null);
  assert.ok(record.failureReason?.includes('PASSIVE_DEPOSIT_AMBIGUITY_ABORT'));

  persistence.close();
});

test('Invariant 3: ACTIVE_EXECUTION ambiguity cannot transition directly to FAILED -> escalates to MANUAL_REVIEW', async () => {
  const persistence = new SqlitePersistence({ filename: ':memory:' });
  const mockProvider = new MockProvider();
  mockProvider.executionClass = ExecutionClass.ACTIVE_EXECUTION; // Class B (Active hot wallet/contract)
  mockProvider.failureMode = 'TIMEOUT_ON_CREATE';

  const orchestrator = new ExecutionOrchestrator({
    persistence,
    providers: new Map([[mockProvider.id, mockProvider]]),
  });

  const quote = await orchestrator.getQuote(sampleIntent);
  const record = await orchestrator.initiateExecution('active_ambiguity_key', sampleIntent, quote);

  // Invariant: Active execution provider cannot be marked FAILED safely because funds may have moved!
  assert.strictEqual(record.state, ExecutionState.MANUAL_REVIEW);
  assert.ok(record.failureReason?.includes('ACTIVE_EXECUTION_AMBIGUITY'));

  persistence.close();
});

test('Invariant 4: Duplicate local idempotency key cannot create two exposed invoices', async () => {
  const persistence = new SqlitePersistence({ filename: ':memory:' });
  const mockProvider = new MockProvider();

  const orchestrator = new ExecutionOrchestrator({
    persistence,
    providers: new Map([[mockProvider.id, mockProvider]]),
  });

  const quote = await orchestrator.getQuote(sampleIntent);
  const first = await orchestrator.initiateExecution('same_idempotency_key', sampleIntent, quote);
  const second = await orchestrator.initiateExecution('same_idempotency_key', sampleIntent, quote);

  assert.strictEqual(first.id, second.id);
  assert.strictEqual(first.depositAddress, second.depositAddress);
  assert.strictEqual(mockProvider.createExecutionCallCount, 1); // Exact-once dispatch

  persistence.close();
});

test('Invariant 5 & 6: Provider token and API secret are never present in audit logs', async () => {
  const persistence = new SqlitePersistence({ filename: ':memory:' });
  const fakeSecret = 'SUPER_SECRET_HMAC_KEY_99999';
  const fakeToken = 'SENSITIVE_ORDER_TOKEN_88888';

  const adapter = new FixedFloatAdapter({
    apiKey: 'FAKECREDENTIALKEY',
    apiSecret: fakeSecret,
  });

  // Test error sanitization
  const sanitized = adapter.sanitizeError(`Failed to authenticate with secret: ${fakeSecret} and key: FAKECREDENTIALKEY`);
  assert.strictEqual(sanitized.includes(fakeSecret), false);
  assert.strictEqual(sanitized.includes('FAKECREDENTIALKEY'), false);
  assert.ok(sanitized.includes('[REDACTED_SECRET]'));
  assert.ok(sanitized.includes('[REDACTED_KEY]'));

  // Test persistence transition logs do not leak token
  const record = persistence.createExecution('secret_audit_key', sampleIntent);
  persistence.transitionState(
    record.id,
    ExecutionState.DEPOSIT_INSTRUCTION_READY,
    'Order created successfully',
    'API',
    { orderId: 'test_order_123' }, // Safe metadata
    {
      providerExecutionId: 'test_order_123',
      orderToken: fakeToken, // Secure field
      depositAddress: 'lnbc3500n1mockinvoice...',
    }
  );

  const transitions = persistence.getTransitions(record.id);
  for (const t of transitions) {
    const rawTransition = JSON.stringify(t);
    assert.strictEqual(
      rawTransition.includes(fakeToken),
      false,
      'Order token must NEVER appear in transition logs or metadata'
    );
  }

  // But the token is retrievable from the execution record for status polling
  const fetched = persistence.findById(record.id)!;
  assert.strictEqual(fetched.orderToken, fakeToken);

  persistence.close();
});

test('Invariant 7: Unknown provider status never becomes FAILED automatically', async () => {
  const persistence = new SqlitePersistence({ filename: ':memory:' });
  const mockProvider = new MockProvider();

  const orchestrator = new ExecutionOrchestrator({
    persistence,
    providers: new Map([[mockProvider.id, mockProvider]]),
    maxRecoveryAttempts: 2,
  });

  const quote = await orchestrator.getQuote(sampleIntent);
  const record = await orchestrator.initiateExecution('unknown_status_key', sampleIntent, quote);

  // Set mock to return UNKNOWN
  mockProvider.failureMode = 'FAIL_STATUS_RECOVERY'; // Throws network error -> retry handler
  const reconciled = await orchestrator.reconcileExecution(record.id);

  // Invariant: Moves to RECOVERY_REQUIRED for retry, NOT FAILED!
  assert.strictEqual(reconciled.state, ExecutionState.RECOVERY_REQUIRED);
  assert.strictEqual(reconciled.recoveryAttempts, 1);

  persistence.close();
});

test('Invariant 8: Expired unfunded order terminates safely with zero funds moved', async () => {
  const persistence = new SqlitePersistence({ filename: ':memory:' });
  const mockProvider = new MockProvider();

  const orchestrator = new ExecutionOrchestrator({
    persistence,
    providers: new Map([[mockProvider.id, mockProvider]]),
  });

  const quote = await orchestrator.getQuote(sampleIntent);
  const record = await orchestrator.initiateExecution('expired_order_key', sampleIntent, quote);

  assert.strictEqual(record.state, ExecutionState.DEPOSIT_INSTRUCTION_READY);
  assert.strictEqual(record.sourceFundsMoved, false);

  mockProvider.failureMode = 'EXPIRE_ZERO_DEPOSIT';
  const reconciled = await orchestrator.reconcileExecution(record.id);

  assert.strictEqual(reconciled.state, ExecutionState.FAILED);
  assert.strictEqual(reconciled.sourceFundsMoved, false);
  assert.ok(reconciled.failureReason?.includes('Deposit window expired with zero deposit'));

  persistence.close();
});

test('Invariant 9: Source funds detected strictly blocks safe FAILED transition', async () => {
  const persistence = new SqlitePersistence({ filename: ':memory:' });
  const mockProvider = new MockProvider();

  const orchestrator = new ExecutionOrchestrator({
    persistence,
    providers: new Map([[mockProvider.id, mockProvider]]),
  });

  const quote = await orchestrator.getQuote(sampleIntent);
  const record = await orchestrator.initiateExecution('source_detected_guard_key', sampleIntent, quote);

  mockProvider.failureMode = 'SOURCE_DEPOSIT_ONLY';
  const reconciled = await orchestrator.reconcileExecution(record.id);

  assert.strictEqual(reconciled.state, ExecutionState.SOURCE_FUNDS_DETECTED);
  assert.strictEqual(reconciled.sourceFundsMoved, true);

  // Invariant: validateTransition to FAILED must throw IllegalStateTransitionError
  assert.throws(() => {
    ExecutionStateMachine.validateTransition(reconciled.state, ExecutionState.FAILED);
  }, /is not permitted/);

  persistence.close();
});

test('Invariant 10: Wrong Base USDC recipient, token, or amount blocks COMPLETED -> escalates to MANUAL_REVIEW', async () => {
  const persistence = new SqlitePersistence({ filename: ':memory:' });
  const mockProvider = new MockProvider();
  const chainVerifier = new MockChainVerifier();

  const orchestrator = new ExecutionOrchestrator({
    persistence,
    providers: new Map([[mockProvider.id, mockProvider]]),
    chainVerifier,
  });

  const quote = await orchestrator.getQuote(sampleIntent);
  const record = await orchestrator.initiateExecution('wrong_recipient_guard_key', sampleIntent, quote);

  // Inbound deposit processed
  mockProvider.simulateExternalDeposit(record.providerExecutionId!);
  await orchestrator.reconcileExecution(record.id);

  // Provider claims settlement, but recipient was forged
  chainVerifier.setOutcome('0xsettle_tx_forged', {
    verified: false,
    status: 'WRONG_RECIPIENT',
    reason: 'Recipient 0xAttacker does not match destinationAddress',
  });

  mockProvider.simulateExternalSettlement(record.providerExecutionId!, '0xsettle_tx_forged');
  const reconciled = await orchestrator.reconcileExecution(record.id);

  assert.strictEqual(reconciled.state, ExecutionState.MANUAL_REVIEW);
  assert.strictEqual(reconciled.destinationFundsArrived, false);
  assert.ok(reconciled.failureReason?.includes('WRONG_RECIPIENT'));

  persistence.close();
});
