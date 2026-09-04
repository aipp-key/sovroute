import { randomBytes, createHash } from 'node:crypto';
import { LndClient } from '../src/atomic/lightning/lnd-client.ts';
import { LndLightningAtomicBackend } from '../src/atomic/lightning/lnd-backend.ts';
import { spawn } from 'node:child_process';
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
  console.log('EMPIRICAL HOLD-INVOICE CANCELLATION VALIDATION');
  console.log('======================================================');

  const clientA = new LndClient({
    restEndpoint: 'https://127.0.0.1:18080',
    tlsCertPath: join(dataDir, 'lnd-a', 'tls.cert'),
    macaroonPath: join(dataDir, 'lnd-a', 'data', 'chain', 'bitcoin', 'regtest', 'admin.macaroon'),
    expectedNetwork: 'regtest',
  });
  await clientA.verifyNetworkSafety();

  const backendA = new LndLightningAtomicBackend(clientA);

  const secret = '0x' + randomBytes(32).toString('hex');
  const hashLock = '0x' + createHash('sha256').update(Buffer.from(secret.slice(2), 'hex')).digest('hex');
  const amountSats = 1500n;

  // 1. Create hold invoice
  console.log('[1] Creating Hold Invoice on LND-A (Cancel Path)...');
  const invoice = await backendA.createHoldInvoice(hashLock, amountSats, 144, 'Test Cancel Invoice');
  assert.equal(invoice.state, 'OPEN');

  // 2. Pay invoice from LND-B
  console.log('[2] Payer (LND-B) dispatching payment...');
  payFromNodeB(invoice.bolt11);

  // 3. Wait for ACCEPTED
  console.log('Waiting for payment to be HELD by LND-A...');
  let state = 'OPEN';
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    state = await backendA.getInvoiceState(invoice.paymentHash);
    if (state === 'ACCEPTED') break;
  }
  assert.equal(state, 'ACCEPTED');
  console.log('[PASS] Invoice is HELD.');

  // 4. Cancel invoice
  console.log('[3] Canceling invoice on LND-A...');
  const cancelRes = await backendA.cancelHoldInvoice(invoice.paymentHash);
  assert.equal(cancelRes.canceled, true);

  const canceledState = await backendA.getInvoiceState(invoice.paymentHash);
  assert.equal(canceledState, 'CANCELED');
  console.log('[PASS] Real LND Hold Invoice canceled cleanly; state is CANCELED.');

  // 5. Attempt settlement after cancel -> must reject
  console.log('[4] Verifying Settle after Cancel is rejected...');
  let settleRejected = false;
  try {
    await backendA.settleHoldInvoice(secret);
  } catch {
    settleRejected = true;
  }
  assert.ok(settleRejected, 'Settling a canceled invoice must strictly fail');
  console.log('[PASS] Settlement on canceled invoice strictly rejected.');

  console.log('\n======================================================');
  console.log('REAL LND HOLD-INVOICE CANCELLATION 100% PROVEN');
  console.log('======================================================');
}

main().catch((err) => {
  console.error('Cancellation validation failed:', err);
  process.exit(1);
});
