import test from 'node:test';
import assert from 'node:assert';
import { SqlitePersistence } from '../src/persistence/sqlite.ts';
import { ExecutionOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { MockChainVerifier } from '../src/verification/verifier.ts';
import {
  ExecutionState,
  type NormalizedIntent,
  type NormalizedQuote,
} from '../src/domain/types.ts';
import { ExecutionStateMachine } from '../src/state-machine/engine.ts';

const sampleIntent: NormalizedIntent = {
  sourceAsset: 'BTC',
  sourceNetwork: 'bitcoin',
  targetAsset: 'USDC',
  targetNetwork: 'base',
  sourceAmountAtomic: '10000', // 10,000 sats (~$7.50)
  destinationAddress: '0x1111111111111111111111111111111111111111',
  refundAddress: 'bc1qtestrefundaddress00000000000000000000',
};

function setupHarness() {
  const persistence = new SqlitePersistence({ filename: ':memory:' });
  const mockProvider = new MockProvider();
  const chainVerifier = new MockChainVerifier();
  const providers = new Map([[mockProvider.id, mockProvider]]);

  const orchestrator = new ExecutionOrchestrator({
    persistence,
    providers,
    chainVerifier,
    maxRecoveryAttempts: 3,
  });

  return { persistence, mockProvider, chainVerifier, orchestrator };
}

test('Happy Path: Complete Lifecycle with Distinct Evidence', async () => {
  const { persistence, mockProvider, orchestrator } = setupHarness();

  const quote = await orchestrator.getQuote(sampleIntent);
  const record = await orchestrator.initiateExecution(
    'happy_path_refined',
    sampleIntent,
    quote
  );

  // 1. Order created: DEPOSIT_INSTRUCTION_READY (Source funds NOT yet moved)
  assert.strictEqual(record.state, ExecutionState.DEPOSIT_INSTRUCTION_READY);
  assert.strictEqual(record.sourceFundsMoved, false);
  assert.strictEqual(record.destinationFundsArrived, false);
  assert.strictEqual(
    ExecutionStateMachine.haveSourceFundsMoved(record.state),
    false
  );

  // 2. Simulate source deposit
  mockProvider.simulateExternalDeposit(record.providerExecutionId!);
  const depositDetected = await orchestrator.reconcileExecution(record.id);

  // 3. Provider processing: SOURCE_FUNDS_CONFIRMED -> SWAP_IN_PROGRESS
  assert.strictEqual(depositDetected.state, ExecutionState.SWAP_IN_PROGRESS);
  assert.strictEqual(depositDetected.sourceFundsMoved, true);
  assert.strictEqual(
    ExecutionStateMachine.haveSourceFundsMoved(depositDetected.state),
    true
  );
  assert.strictEqual(depositDetected.sourceEvidence?.confirmations, 1);

  // 4. Provider settles on Base
  mockProvider.simulateExternalSettlement(record.providerExecutionId!);
  const completed = await orchestrator.reconcileExecution(record.id);

  // 5. Independently verified on Base
  assert.strictEqual(completed.state, ExecutionState.COMPLETED);
  assert.strictEqual(completed.destinationFundsArrived, true);
  assert.strictEqual(completed.destinationEvidence?.verifiedOnChain, true);
  assert.strictEqual(completed.destinationEvidence?.onChainStatus, 'CONFIRMED');

  persistence.close();
});

test('Audit 1: Ambiguous create with no providerExecutionId (Provider Lacks Strong Idempotency)', async () => {
  const { persistence, mockProvider, orchestrator } = setupHarness();
  mockProvider.failureMode = 'TIMEOUT_ON_CREATE';
  mockProvider.supportsStrongIdempotency = false; // Mirrors SideShift / FixedFloat

  const quote = await orchestrator.getQuote(sampleIntent);

  const record = await orchestrator.initiateExecution(
    'ambiguous_create_key',
    sampleIntent,
    quote
  );

  // Invariant: Router discovers provider lacks idempotency lookup.
  // Because no deposit address was ever returned/persisted, it proves zero funds moved
  // and marks FAILED with an explicit audit reason.
  assert.strictEqual(record.state, ExecutionState.FAILED);
  assert.strictEqual(record.sourceFundsMoved, false);
  assert.ok(
    record.failureReason?.includes(
      'PROVIDER_DOES_NOT_SUPPORT_STRONG_EXECUTION_IDEMPOTENCY'
    )
  );

  persistence.close();
});

test('Audit 2: Crash immediately after outbound provider request', async () => {
  const { persistence, orchestrator } = setupHarness();

  // Create record stuck in EXECUTING with NULL providerExecutionId
  const initial = persistence.createExecution('crash_mid_post_key', sampleIntent);
  persistence.transitionState(
    initial.id,
    ExecutionState.EXECUTING,
    'Request left router but process crashed before response',
    'API',
    null,
    { providerId: 'mock_provider' }
  );

  // Reconcile on reboot
  const reconciled = await orchestrator.reconcileExecution(initial.id);
  assert.strictEqual(reconciled.state, ExecutionState.FAILED);
  assert.ok(
    reconciled.failureReason?.includes(
      'PROVIDER_DOES_NOT_SUPPORT_STRONG_EXECUTION_IDEMPOTENCY'
    )
  );

  persistence.close();
});

test('Audit 3: Crash immediately after provider response but before DB persistence', async () => {
  const { persistence, mockProvider, orchestrator } = setupHarness();

  // Provider created order in its internal state, but DB never got providerExecutionId
  mockProvider.failureMode = 'TIMEOUT_ON_CREATE';
  const quote = await orchestrator.getQuote(sampleIntent);
  const record = await orchestrator.initiateExecution(
    'crash_before_db_write',
    sampleIntent,
    quote
  );

  assert.strictEqual(record.state, ExecutionState.FAILED);
  assert.strictEqual(record.providerExecutionId, null);
  assert.strictEqual(record.depositAddress, null);

  persistence.close();
});

test('Audit 4: Retry after restart returns identical state without duplicate dispatch', async () => {
  const { persistence, mockProvider, orchestrator } = setupHarness();

  const quote = await orchestrator.getQuote(sampleIntent);
  const first = await orchestrator.initiateExecution(
    'retry_restart_key',
    sampleIntent,
    quote
  );

  // New orchestrator instance simulating restart
  const restarted = new ExecutionOrchestrator({
    persistence,
    providers: new Map([[mockProvider.id, mockProvider]]),
  });

  const retry = await restarted.initiateExecution(
    'retry_restart_key',
    sampleIntent,
    quote
  );
  assert.strictEqual(retry.id, first.id);
  assert.strictEqual(mockProvider.createExecutionCallCount, 1);

  persistence.close();
});

test('Audit 5: Duplicate client request during recovery does not trigger second dispatch', async () => {
  const { persistence, mockProvider, orchestrator } = setupHarness();

  const quote = await orchestrator.getQuote(sampleIntent);
  const record = await orchestrator.initiateExecution(
    'dup_during_rec_key',
    sampleIntent,
    quote
  );

  persistence.transitionState(
    record.id,
    ExecutionState.RECOVERING,
    'Recovery active',
    'RECOVERY_WORKER'
  );

  const duplicate = await orchestrator.initiateExecution(
    'dup_during_rec_key',
    sampleIntent,
    quote
  );
  assert.strictEqual(duplicate.id, record.id);
  assert.strictEqual(duplicate.state, ExecutionState.RECOVERING);
  assert.strictEqual(mockProvider.createExecutionCallCount, 1);

  persistence.close();
});

test('Audit 6: Source deposit observed but destination absent -> Source moved, destination false', async () => {
  const { persistence, mockProvider, orchestrator } = setupHarness();

  const quote = await orchestrator.getQuote(sampleIntent);
  const record = await orchestrator.initiateExecution(
    'source_only_key',
    sampleIntent,
    quote
  );

  mockProvider.failureMode = 'SOURCE_DEPOSIT_ONLY';
  const reconciled = await orchestrator.reconcileExecution(record.id);

  assert.strictEqual(reconciled.state, ExecutionState.SOURCE_FUNDS_DETECTED);
  assert.strictEqual(reconciled.sourceFundsMoved, true);
  assert.strictEqual(reconciled.destinationFundsArrived, false);
  assert.strictEqual(
    ExecutionStateMachine.haveSourceFundsMoved(reconciled.state),
    true
  );

  // INVARIANT: State CANNOT transition to FAILED because source funds have moved!
  assert.throws(() => {
    ExecutionStateMachine.validateTransition(
      reconciled.state,
      ExecutionState.FAILED
    );
  });

  persistence.close();
});

test('Audit 7: Provider claims completed but Base tx not found -> MANUAL_REVIEW', async () => {
  const { persistence, mockProvider, chainVerifier, orchestrator } = setupHarness();

  const quote = await orchestrator.getQuote(sampleIntent);
  const record = await orchestrator.initiateExecution(
    'chain_absent_key',
    sampleIntent,
    quote
  );

  chainVerifier.setOutcome('0xmissing_tx_hash', {
    verified: false,
    status: 'NOT_FOUND',
    reason: 'Transaction hash not found in Base mempool or blocks',
  });

  mockProvider.simulateExternalDeposit(record.providerExecutionId!);
  await orchestrator.reconcileExecution(record.id);

  mockProvider.simulateExternalSettlement(
    record.providerExecutionId!,
    '0xmissing_tx_hash'
  );
  const reconciled = await orchestrator.reconcileExecution(record.id);

  assert.strictEqual(reconciled.state, ExecutionState.MANUAL_REVIEW);
  assert.strictEqual(reconciled.destinationFundsArrived, false);
  assert.ok(reconciled.failureReason?.includes('NOT_FOUND'));

  persistence.close();
});

test('Audit 8: Destination tx exists but wrong recipient -> MANUAL_REVIEW', async () => {
  const { persistence, mockProvider, chainVerifier, orchestrator } = setupHarness();

  const quote = await orchestrator.getQuote(sampleIntent);
  const record = await orchestrator.initiateExecution(
    'wrong_recip_key',
    sampleIntent,
    quote
  );

  chainVerifier.setOutcome('0xwrong_recipient_tx_hash', {
    verified: false,
    status: 'WRONG_RECIPIENT',
    reason: 'Transfer recipient 0xAttacker does not match expected destinationAddress',
  });

  mockProvider.failureMode = 'WRONG_RECIPIENT';
  mockProvider.simulateExternalDeposit(record.providerExecutionId!);
  await orchestrator.reconcileExecution(record.id);

  const reconciled = await orchestrator.reconcileExecution(record.id);

  assert.strictEqual(reconciled.state, ExecutionState.MANUAL_REVIEW);
  assert.strictEqual(reconciled.destinationFundsArrived, false);
  assert.ok(reconciled.failureReason?.includes('WRONG_RECIPIENT'));

  persistence.close();
});

test('Audit 9: Destination USDC Transfer exists but wrong amount -> MANUAL_REVIEW', async () => {
  const { persistence, mockProvider, chainVerifier, orchestrator } = setupHarness();

  const quote = await orchestrator.getQuote(sampleIntent);
  const record = await orchestrator.initiateExecution(
    'wrong_amt_key',
    sampleIntent,
    quote
  );

  chainVerifier.setOutcome('0xwrong_amount_tx_hash', {
    verified: false,
    status: 'AMOUNT_MISMATCH',
    reason: 'Confirmed amount (100) is below minimum expected (7425000)',
  });

  mockProvider.failureMode = 'WRONG_AMOUNT';
  mockProvider.simulateExternalDeposit(record.providerExecutionId!);
  await orchestrator.reconcileExecution(record.id);

  const reconciled = await orchestrator.reconcileExecution(record.id);

  assert.strictEqual(reconciled.state, ExecutionState.MANUAL_REVIEW);
  assert.strictEqual(reconciled.destinationFundsArrived, false);
  assert.ok(reconciled.failureReason?.includes('AMOUNT_MISMATCH'));

  persistence.close();
});

test('Audit 10: Destination tx uses wrong token contract -> MANUAL_REVIEW', async () => {
  const { persistence, mockProvider, chainVerifier, orchestrator } = setupHarness();

  const quote = await orchestrator.getQuote(sampleIntent);
  const record = await orchestrator.initiateExecution(
    'wrong_token_key',
    sampleIntent,
    quote
  );

  chainVerifier.setOutcome('0xwrong_token_tx_hash', {
    verified: false,
    status: 'WRONG_TOKEN',
    reason: 'Transfer event emitted from 0xFakeToken instead of Base USDC contract',
  });

  mockProvider.failureMode = 'WRONG_TOKEN';
  mockProvider.simulateExternalDeposit(record.providerExecutionId!);
  await orchestrator.reconcileExecution(record.id);

  const reconciled = await orchestrator.reconcileExecution(record.id);

  assert.strictEqual(reconciled.state, ExecutionState.MANUAL_REVIEW);
  assert.strictEqual(reconciled.destinationFundsArrived, false);
  assert.ok(reconciled.failureReason?.includes('WRONG_TOKEN'));

  persistence.close();
});

test('Audit 11: Stale / Expired Quote Execution Attempt -> Safe FAILED', async () => {
  const { persistence, orchestrator } = setupHarness();

  const expiredQuote: NormalizedQuote = {
    quoteId: 'expired_q_1',
    providerId: 'mock_provider',
    sourceAsset: 'BTC',
    sourceNetwork: 'bitcoin',
    targetAsset: 'USDC',
    targetNetwork: 'base',
    depositAmountAtomic: '10000',
    settleAmountAtomic: '7425000',
    rate: '75000',
    networkFeeEstimatedAtomic: '500000',
    minDepositAtomic: '1000',
    maxDepositAtomic: '50000000',
    expiresAt: new Date(Date.now() - 60 * 1000).toISOString(), // 1 minute ago
  };

  const record = await orchestrator.initiateExecution(
    'stale_quote_key',
    sampleIntent,
    expiredQuote
  );

  assert.strictEqual(record.state, ExecutionState.FAILED);
  assert.ok(record.failureReason?.includes('Quote expired'));

  persistence.close();
});

test('Audit 12: Refund claimed by provider without tx hash evidence -> MANUAL_REVIEW', async () => {
  const { persistence, mockProvider, orchestrator } = setupHarness();

  const quote = await orchestrator.getQuote(sampleIntent);
  const record = await orchestrator.initiateExecution(
    'refund_no_evidence_key',
    sampleIntent,
    quote
  );

  mockProvider.failureMode = 'REFUND_WITHOUT_EVIDENCE';
  const reconciled = await orchestrator.reconcileExecution(record.id);

  // Invariant: Unproven refund claims cannot transition to REFUNDED!
  assert.strictEqual(reconciled.state, ExecutionState.MANUAL_REVIEW);
  assert.ok(reconciled.failureReason?.includes('zero refund transaction evidence'));

  persistence.close();
});
