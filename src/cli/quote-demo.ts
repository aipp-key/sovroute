/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Sovereign Atomic Core Execution Demo
 *
 * Demonstrates the non-custodial, zero-hosted-provider atomic swap rail:
 * Lightning BTC -> Arbitrum HTLC -> Base USDC
 */

import { randomBytes, createHash } from 'node:crypto';
import { AtomicCoordinator } from '../atomic/coordinator/coordinator.ts';
import { FakeLightningAtomicBackend } from '../atomic/lightning/fake-backend.ts';
import { FakeEvmAtomicBackend } from '../atomic/evm/fake-backend.ts';
import { FakeLiquidityInventory } from '../atomic/liquidity/fake-inventory.ts';

async function main() {
  console.log('='.repeat(70));
  console.log('UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4 SOVEREIGN CORE DEMO');
  console.log('Target Route: Lightning BTC -> Arbitrum HTLC -> Base Canonical USDC');
  console.log('Policy: Non-custodial, sovereign atomic execution. Zero hosted APIs.');
  console.log('='.repeat(70));

  // 1. Initialize local sovereign atomic components
  const lightning = new FakeLightningAtomicBackend();
  const evm = new FakeEvmAtomicBackend();
  const inventory = new FakeLiquidityInventory({
    '0x6c84a8f1c29108f47a79964b5fe888d4f4d0de40': 100_000_000n, // 1 BTC equivalent tBTC
  });
  const coordinator = new AtomicCoordinator(lightning, evm, inventory);

  // 2. Client generates secret and hashlock locally (SEC-1: Router never touches secret)
  const secret = '0x' + randomBytes(32).toString('hex');
  const hashLock = '0x' + createHash('sha256').update(Buffer.from(secret.slice(2), 'hex')).digest('hex');
  const claimingAddress = '0x1111111111111111111111111111111111111111';
  const targetDestination = '0x00b1A1425121408b066060cFe3B00d60d33e3eeE';
  const amountSats = 10_000n;
  const expectedUsdcAmount = 7_650_000n; // ~7.65 USDC

  console.log('\n[1] Client Generated Cryptographic Parameters:');
  console.log('  HashLock (SHA256):    ', hashLock);
  console.log('  Claiming Address:     ', claimingAddress);
  console.log('  Target Base Address:  ', targetDestination);
  console.log('  (Notice: Secret remains with client, NOT stored in Router!)');

  // 3. Coordinator prepares swap and generates BOLT11 hold invoice
  console.log('\n[2] Coordinator Preparing Sovereign Atomic Swap...');
  const record = await coordinator.prepareSwap({
    idempotencyKey: 'demo-swap-' + Date.now(),
    hashLock,
    claimingAddress,
    targetDestinationAddress: targetDestination,
    amountSats,
    expectedUsdcAmount,
  });

  console.log('  Execution ID:         ', record.id);
  console.log('  State:                ', record.state);
  console.log('  BOLT11 Hold Invoice:  ', record.holdInvoice?.bolt11);
  console.log('  Payment Hash:         ', record.holdInvoice?.paymentHash);

  // 4. Simulate payer funding Lightning hold invoice
  console.log('\n[3] Simulating Payer Funding Lightning Hold Invoice...');
  lightning.simulatePayerHold(record.holdInvoice!.paymentHash);
  const heldRecord = await coordinator.onLightningHoldDetected(record.id);
  console.log('  Updated State:        ', heldRecord.state);

  // 5. Coordinator funds EVM HTLC using operator liquidity
  console.log('\n[4] Coordinator Funding EVM HTLC on Arbitrum One...');
  const fundedRecord = await coordinator.fundEvmHtlc(record.id);
  console.log('  Updated State:        ', fundedRecord.state);
  console.log('  EVM Funding TxHash:   ', fundedRecord.evmFundingTxHash);
  console.log('  EVM Swap Key:         ', fundedRecord.evmSwapKey);

  // 6. Client submits EIP-712 claim with secret
  console.log('\n[5] Client Claiming on EVM with Preimage...');
  const claimedRecord = await coordinator.claimSwap(record.id, secret);
  console.log('  Updated State:        ', claimedRecord.state);
  console.log('  EVM Claim TxHash:     ', claimedRecord.evmClaimTxHash);
  console.log('  Lightning Settled:     YES (Satoshis claimed by coordinator)');

  // 7. Base delivery confirmation
  console.log('\n[6] Confirming Canonical Base USDC Delivery via CCTP...');
  const completedRecord = coordinator.confirmBaseDelivery(record.id, '0xbase_cctp_mint_tx_hash_123');
  console.log('  Final State:          ', completedRecord.state);
  console.log('  Base TxHash:          ', completedRecord.destinationTxHash);

  console.log('\n' + '='.repeat(70));
  console.log('SOVEREIGN ATOMIC LIFECYCLE COMPLETED SUCCESSFULLY (100% OFFLINE)');
  console.log('='.repeat(70));
}

main().catch(console.error);
