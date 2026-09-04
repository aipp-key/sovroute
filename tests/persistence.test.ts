import test from 'node:test';
import assert from 'node:assert';
import { SqlitePersistence } from '../src/persistence/sqlite.ts';
import {
  ExecutionState,
  type NormalizedIntent,
  type SourceSettlementEvidence,
  type DestinationSettlementEvidence,
} from '../src/domain/types.ts';

const sampleIntent: NormalizedIntent = {
  sourceAsset: 'BTC',
  sourceNetwork: 'bitcoin',
  targetAsset: 'USDC',
  targetNetwork: 'base',
  sourceAmountAtomic: '50000',
  destinationAddress: '0x1111111111111111111111111111111111111111',
  refundAddress: 'bc1qsamplebtcaddressforrefund0000000000000',
};

test('Persistence - Atomic execution creation with initial audit log', () => {
  const db = new SqlitePersistence({ filename: ':memory:' });

  const record = db.createExecution('idem_key_001', sampleIntent);
  assert.strictEqual(record.idempotencyKey, 'idem_key_001');
  assert.strictEqual(record.state, ExecutionState.CREATED);
  assert.strictEqual(record.sourceFundsMoved, false);
  assert.strictEqual(record.destinationFundsArrived, false);

  const transitions = db.getTransitions(record.id);
  assert.strictEqual(transitions.length, 1);
  assert.strictEqual(transitions[0]?.toState, ExecutionState.CREATED);

  db.close();
});

test('Persistence - Idempotency deduplication returns existing record without duplicate write', () => {
  const db = new SqlitePersistence({ filename: ':memory:' });

  const first = db.createExecution('same_key', sampleIntent);
  const second = db.createExecution('same_key', sampleIntent);

  assert.strictEqual(first.id, second.id);
  const transitions = db.getTransitions(first.id);
  assert.strictEqual(transitions.length, 1);

  db.close();
});

test('Persistence - Saves and retrieves Source & Destination Evidence', () => {
  const db = new SqlitePersistence({ filename: ':memory:' });
  const record = db.createExecution('idem_key_002', sampleIntent);

  const sourceEvidence: SourceSettlementEvidence = {
    network: 'bitcoin',
    asset: 'BTC',
    amountAtomic: '50000',
    depositAddressOrInvoice: 'bc1qtestdepositaddress',
    txIdOrPaymentHash: 'btc_tx_12345',
    confirmations: 2,
    detectedAt: new Date().toISOString(),
    confirmedAt: new Date().toISOString(),
    evidenceSource: 'BITCOIN_RPC',
    rawEvidence: { block: 800000 },
  };

  const destinationEvidence: DestinationSettlementEvidence = {
    network: 'base',
    asset: 'USDC',
    amountAtomic: '37500000',
    destinationAddress: sampleIntent.destinationAddress,
    txHash: '0xbase_tx_67890',
    blockNumber: 12345,
    tokenContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'.toLowerCase(),
    verifiedOnChain: true,
    onChainStatus: 'CONFIRMED',
    verifiedAt: new Date().toISOString(),
    evidenceSource: 'BASE_RPC',
    rawEvidence: { status: 1 },
  };

  const updated = db.transitionState(
    record.id,
    ExecutionState.COMPLETED,
    'Verified on chain',
    'POLLING',
    null,
    {
      sourceEvidence,
      destinationEvidence,
      sourceFundsMoved: true,
      destinationFundsArrived: true,
    }
  );

  assert.strictEqual(updated.state, ExecutionState.COMPLETED);
  assert.strictEqual(updated.sourceFundsMoved, true);
  assert.strictEqual(updated.destinationFundsArrived, true);
  assert.strictEqual(updated.sourceEvidence?.txIdOrPaymentHash, 'btc_tx_12345');
  assert.strictEqual(updated.destinationEvidence?.txHash, '0xbase_tx_67890');

  db.close();
});
