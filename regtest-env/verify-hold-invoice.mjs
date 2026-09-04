import { randomBytes, createHash } from 'node:crypto';
import { LndClient } from '../src/atomic/lightning/lnd-client.ts';
import { LndLightningAtomicBackend } from '../src/atomic/lightning/lnd-backend.ts';
import { spawn, execSync } from 'node:child_process';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const rootDir = process.cwd();
const dataDir = join(rootDir, 'regtest-env', 'data');
const binDir = join(rootDir, 'regtest-env', 'bin');
const lncliBin = join(binDir, 'lncli.exe');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function payFromNodeB(bolt11) {
  // Spawn payment from LND-B in background
  const p = spawn(
    lncliBin,
    [
      '--network=regtest',
      '--rpcserver=127.0.0.1:10010',
      `--lnddir=${join(dataDir, 'lnd-b')}`,
      'payinvoice',
      '--force',
      bolt11,
    ],
    { stdio: 'ignore' }
  );
  p.unref();
}

async function main() {
  console.log('======================================================');
  console.log('EMPIRICAL HOLD-INVOICE VALIDATION ON REAL LND REGTEST');
  console.log('======================================================');

  // 1. Initialize LND-A Client with Network Safety Guard
  const clientA = new LndClient({
    restEndpoint: 'https://127.0.0.1:18080',
    tlsCertPath: join(dataDir, 'lnd-a', 'tls.cert'),
    macaroonPath: join(dataDir, 'lnd-a', 'data', 'chain', 'bitcoin', 'regtest', 'admin.macaroon'),
    expectedNetwork: 'regtest',
  });

  await clientA.verifyNetworkSafety();
  console.log('[PASS] LND-A Network Safety Guard verified (regtest).');

  const backendA = new LndLightningAtomicBackend(clientA);

  // 2. Client generates secret and hashlock
  const secret = '0x' + randomBytes(32).toString('hex');
  const hashLock = '0x' + createHash('sha256').update(Buffer.from(secret.slice(2), 'hex')).digest('hex');
  const amountSats = 2500n;

  console.log('\n[1] Creating Hold Invoice on LND-A:');
  console.log('  HashLock:   ', hashLock);
  console.log('  Amount:     ', amountSats.toString(), 'sats');

  const invoice = await backendA.createHoldInvoice(hashLock, amountSats, 144, 'Test Hold Invoice');
  console.log('  BOLT11:     ', invoice.bolt11.slice(0, 40) + '...');
  console.log('  Initial State:', invoice.state);
  assert.equal(invoice.state, 'OPEN', 'Initial state must be OPEN');

  // 3. Payer (LND-B) pays the invoice
  console.log('\n[2] Payer (LND-B) dispatching payment...');
  payFromNodeB(invoice.bolt11);

  // 4. Observe transition to ACCEPTED / HELD
  console.log('Waiting for payment to be HELD by LND-A...');
  let observedState = 'OPEN';
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    observedState = await backendA.getInvoiceState(invoice.paymentHash);
    if (observedState === 'ACCEPTED') break;
  }

  console.log('  Observed State:', observedState);
  assert.equal(observedState, 'ACCEPTED', 'Payment must enter ACCEPTED / HELD state!');
  console.log('[PASS] Real LND Hold Invoice reached ACCEPTED / HELD state without settling!');

  // 5. Attempt settlement with WRONG preimage
  console.log('\n[3] Testing Settlement with WRONG Preimage...');
  const wrongPreimage = '0x' + randomBytes(32).toString('hex');
  let rejectedWrong = false;
  try {
    await backendA.settleHoldInvoice(wrongPreimage);
  } catch (err) {
    rejectedWrong = true;
    console.log('  LND rejected wrong preimage as expected:', err.message);
  }
  assert.ok(rejectedWrong, 'LND must strictly reject settlement with wrong preimage!');

  // Verify invoice remains HELD
  const stillHeld = await backendA.getInvoiceState(invoice.paymentHash);
  assert.equal(stillHeld, 'ACCEPTED', 'Invoice must remain ACCEPTED after wrong preimage rejection');
  console.log('[PASS] Wrong preimage rejected; invoice remains safely HELD.');

  // 6. Settle with CORRECT preimage
  console.log('\n[4] Settling with CORRECT Preimage...');
  const settleResult = await backendA.settleHoldInvoice(secret);
  console.log('  Settle Result:', settleResult);
  assert.equal(settleResult.settled, true);

  const finalState = await backendA.getInvoiceState(invoice.paymentHash);
  console.log('  Final State on LND-A:', finalState);
  assert.equal(finalState, 'SETTLED', 'Invoice must transition to SETTLED');
  console.log('[PASS] Settle with correct preimage succeeded! State is SETTLED.');

  console.log('\n======================================================');
  console.log('REAL LND HOLD-INVOICE LIFECYCLE 100% PROVEN ON REGTEST');
  console.log('======================================================');
}

main().catch((err) => {
  console.error('Empirical validation failed:', err);
  process.exit(1);
});
