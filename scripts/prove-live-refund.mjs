/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Phase 4.0A: Live Public Base Sepolia HTLC Refund Proof
 *
 * Sequence:
 * 1. Generate fresh test secret/hashlock
 * 2. Prepare swap and create LND hold invoice
 * 3. Payer locks sats on LND (HELD)
 * 4. Operator funds fresh HTLC on Base Sepolia with compressed test timelock (120s)
 * 5. Verify EARLY refund reverts (TIMELOCK_NOT_EXPIRED)
 * 6. Client intentionally refrains from claiming
 * 7. Wait until Base Sepolia block timestamp passes timelock threshold
 * 8. Operator broadcasts refund on Base Sepolia
 * 9. Verify contract storage status == REFUNDED (3)
 * 10. Verify operator test USDC balance delta (+10,000 units restored)
 * 11. Verify post-refund claim with correct preimage reverts fail-closed
 * 12. Verify Lightning hold invoice canceled safely (0 sats lost)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { LndClient } from '../src/atomic/lightning/lnd-client.ts';
import { LndLightningAtomicBackend } from '../src/atomic/lightning/lnd-backend.ts';
import { BaseSepoliaAtomicBackend } from '../src/atomic/evm/base-sepolia-backend.ts';
import {
  BASE_SEPOLIA_CHAIN_ID,
  OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS,
} from '../src/atomic/evm/base-guard.ts';

const rootDir = process.cwd();
const dataDir = join(rootDir, 'regtest-env', 'data');
const binDir = join(rootDir, 'regtest-env', 'bin');
const lncliBin = join(binDir, 'lncli.exe');

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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log('=== PHASE 4.0A: LIVE BASE SEPOLIA REFUND PROOF ===');

  const deployment = JSON.parse(readFileSync(join(dataDir, 'base-sepolia-deployment.json'), 'utf8'));
  const opData = JSON.parse(readFileSync(join(dataDir, 'base-sepolia-operator.json'), 'utf8'));
  const clientData = JSON.parse(readFileSync(join(dataDir, 'base-sepolia-client.json'), 'utf8'));

  const operatorAccount = privateKeyToAccount(opData.privateKey);
  const clientAccount = privateKeyToAccount(clientData.privateKey);

  console.log('Operator Address:', operatorAccount.address);
  console.log('Client Address:  ', clientAccount.address);
  console.log('HTLC Address:    ', deployment.htlcAddress);
  console.log('USDC Address:    ', OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS);

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http('https://sepolia.base.org'),
    cacheTime: 0,
  });

  const operatorWallet = createWalletClient({
    account: operatorAccount,
    chain: baseSepolia,
    transport: http('https://sepolia.base.org'),
  });

  const clientWallet = createWalletClient({
    account: clientAccount,
    chain: baseSepolia,
    transport: http('https://sepolia.base.org'),
  });

  const htlcAbi = JSON.parse(
    readFileSync(join(rootDir, 'artifacts', 'contracts', 'HtlcErc20.sol', 'HtlcErc20.json'), 'utf8')
  ).abi;

  const usdcAbi = parseAbi([
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address, address) view returns (uint256)',
    'function approve(address, uint256) returns (bool)',
  ]);

  // Connect LND
  const lndClient = new LndClient({
    restEndpoint: 'https://127.0.0.1:18080',
    tlsCertPath: join(dataDir, 'lnd-a', 'tls.cert'),
    macaroonPath: join(dataDir, 'lnd-a', 'data', 'chain', 'bitcoin', 'regtest', 'admin.macaroon'),
    expectedNetwork: 'regtest',
  });
  await lndClient.verifyNetworkSafety();
  const lndBackend = new LndLightningAtomicBackend(lndClient);

  // 1. Secret & Hashlock
  const secret = randomBytes(32);
  const hashLock = `0x${createHash('sha256').update(secret).digest('hex')}`;
  const amountUnits = 10_000n; // 0.01 USDC
  const amountSats = 5_000n;

  console.log('Secret HashLock:', hashLock);

  // 2. Create LND hold invoice
  const holdInv = await lndBackend.createHoldInvoice(
    hashLock,
    amountSats,
    144,
    'refund_proof'
  );
  console.log('LND Hold Invoice Created:', holdInv.paymentHash);

  // 3. Payer pays hold invoice
  payFromNodeB(holdInv.bolt11);
  let held = false;
  for (let i = 0; i < 30; i++) {
    await sleep(200);
    const st = await lndBackend.getInvoiceState(holdInv.paymentHash);
    if (st === 'ACCEPTED') {
      held = true;
      break;
    }
  }
  if (!held) throw new Error('LND invoice failed to reach ACCEPTED');
  console.log('LND Invoice ACCEPTED (Held by payer)');

  // 4. Record operator initial USDC balance
  const preOpUsdc = await publicClient.readContract({
    address: OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS,
    abi: usdcAbi,
    functionName: 'balanceOf',
    args: [operatorAccount.address],
  });
  console.log('Operator Pre-Fund USDC Balance:', (Number(preOpUsdc) / 1e6).toFixed(4), 'USDC');

  // 5. Approve exact USDC if needed
  const curAllowance = await publicClient.readContract({
    address: OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS,
    abi: usdcAbi,
    functionName: 'allowance',
    args: [operatorAccount.address, deployment.htlcAddress],
  });
  if (curAllowance < amountUnits) {
    console.log('Approving exact USDC on Base Sepolia...');
    const appTx = await operatorWallet.writeContract({
      address: OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS,
      abi: usdcAbi,
      functionName: 'approve',
      args: [deployment.htlcAddress, amountUnits],
    });
    await publicClient.waitForTransactionReceipt({ hash: appTx });
    for (let i = 0; i < 10; i++) {
      const al = await publicClient.readContract({
        address: OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS,
        abi: usdcAbi,
        functionName: 'allowance',
        args: [operatorAccount.address, deployment.htlcAddress],
      });
      if (al >= amountUnits) break;
      await sleep(1000);
    }
  }

  // 6. Fund HTLC with COMPRESSED TEST TIMELOCK (120 seconds)
  const currentBlock = await publicClient.getBlock();
  const currentChainTime = Number(currentBlock.timestamp);
  const testTimelockDuration = 120; // 2 minutes (test-only compressed timelock)
  const timelockTimestamp = currentChainTime + testTimelockDuration;

  console.log(`Current Base Sepolia chain time: ${currentChainTime} (${new Date(currentChainTime * 1000).toISOString()})`);
  console.log(`Target refund timelock:        ${timelockTimestamp} (${new Date(timelockTimestamp * 1000).toISOString()})`);

  console.log('Broadcasting live HTLC fund transaction on Base Sepolia...');
  const fundTxHash = await operatorWallet.writeContract({
    address: deployment.htlcAddress,
    abi: htlcAbi,
    functionName: 'fund',
    args: [
      hashLock,
      amountUnits,
      OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS,
      clientAccount.address,
      operatorAccount.address,
      BigInt(timelockTimestamp),
    ],
  });
  console.log('Fund Tx Hash:', fundTxHash);

  const fundReceipt = await publicClient.waitForTransactionReceipt({ hash: fundTxHash });
  const fundBlock = Number(fundReceipt.blockNumber);
  console.log('Fund Mined in Block:', fundBlock);

  const fundedLog = fundReceipt.logs.find(
    (l) => l.address.toLowerCase() === deployment.htlcAddress.toLowerCase()
  );
  const htlcId = fundedLog.topics[1];
  console.log('HTLC ID:', htlcId);

  // Check state == 1 (LOCKED)
  let htlcAfterFund;
  for (let i = 0; i < 10; i++) {
    try {
      htlcAfterFund = await publicClient.readContract({
        address: deployment.htlcAddress,
        abi: htlcAbi,
        functionName: 'getHtlc',
        args: [htlcId],
      });
      if (htlcAfterFund && htlcAfterFund.status === 1) break;
    } catch {}
    await sleep(1000);
  }
  console.log('HTLC status after funding:', htlcAfterFund?.status, '(Expected 1 = LOCKED)');
  if (!htlcAfterFund || htlcAfterFund.status !== 1) throw new Error('Expected HTLC status 1');

  // 7. STEP 5: VERIFY EARLY REFUND REJECTION (before timelock expires)
  console.log('\n--- VERIFYING EARLY REFUND REJECTION ---');
  let earlyRefundRejected = false;
  let earlyRefundRevertReason = '';
  try {
    await publicClient.simulateContract({
      account: operatorAccount.address,
      address: deployment.htlcAddress,
      abi: htlcAbi,
      functionName: 'refund',
      args: [htlcId],
    });
  } catch (err) {
    earlyRefundRejected = true;
    earlyRefundRevertReason = err.message;
    console.log('Early refund correctly reverted with:', err.shortMessage || err.message);
  }
  if (!earlyRefundRejected) {
    throw new Error('CRITICAL VULNERABILITY: Early refund before timelock did not revert!');
  }

  // 8. STEP 7: WAIT FOR TIMELOCK EXPIRY ON PUBLIC BASE SEPOLIA
  console.log('\n--- WAITING FOR BASE SEPOLIA CHAIN TIME TO EXCEED TIMELOCK ---');
  let nowTimestamp = currentChainTime;
  while (nowTimestamp <= timelockTimestamp) {
    const latestBlock = await publicClient.getBlock();
    nowTimestamp = Number(latestBlock.timestamp);
    const remaining = timelockTimestamp - nowTimestamp;
    process.stdout.write(`\rBase Sepolia chain time: ${nowTimestamp} | Target: ${timelockTimestamp} | Remaining: ${remaining > 0 ? remaining : 0}s `);
    if (nowTimestamp > timelockTimestamp) break;
    await sleep(4000);
  }
  console.log('\nTimelock expired on-chain! Ready to broadcast refund.');

  // 9. STEP 8: BROADCAST LIVE REFUND TRANSACTION
  console.log('Broadcasting live refund transaction on Base Sepolia...');
  const refundTxHash = await operatorWallet.writeContract({
    address: deployment.htlcAddress,
    abi: htlcAbi,
    functionName: 'refund',
    args: [htlcId],
  });
  console.log('Refund Tx Hash:', refundTxHash);

  const refundReceipt = await publicClient.waitForTransactionReceipt({ hash: refundTxHash });
  const refundBlock = Number(refundReceipt.blockNumber);
  console.log('Refund Mined in Block:', refundBlock);
  console.log('Refund Receipt Status:', refundReceipt.status);

  // 10. STEP 9: VERIFY ON-CHAIN STORAGE == REFUNDED (3)
  let htlcAfterRefund;
  for (let i = 0; i < 10; i++) {
    try {
      htlcAfterRefund = await publicClient.readContract({
        address: deployment.htlcAddress,
        abi: htlcAbi,
        functionName: 'getHtlc',
        args: [htlcId],
      });
      if (htlcAfterRefund && htlcAfterRefund.status === 3) break;
    } catch {}
    await sleep(1000);
  }
  console.log('HTLC status after refund:', htlcAfterRefund?.status, '(Expected 3 = REFUNDED)');
  if (!htlcAfterRefund || htlcAfterRefund.status !== 3) throw new Error('Expected HTLC status 3 (REFUNDED)');

  // 11. STEP 10: VERIFY TOKEN BALANCE RESTORED
  const postOpUsdc = await publicClient.readContract({
    address: OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS,
    abi: usdcAbi,
    functionName: 'balanceOf',
    args: [operatorAccount.address],
  });
  console.log('Operator Post-Refund USDC Balance:', (Number(postOpUsdc) / 1e6).toFixed(4), 'USDC');
  const delta = postOpUsdc - (preOpUsdc - amountUnits);
  console.log('Restored token units:', delta.toString(), '(Expected 10000)');
  if (delta !== amountUnits) throw new Error('Tokens not restored to operator refund address!');

  // 12. STEP 11: VERIFY POST-REFUND CLAIM FAILS (Mutual Exclusion)
  console.log('\n--- VERIFYING POST-REFUND CLAIM MUTUAL EXCLUSION ---');
  let postRefundClaimFailed = false;
  try {
    const preimageHex = `0x${secret.toString('hex')}`;
    await publicClient.simulateContract({
      account: clientAccount.address,
      address: deployment.htlcAddress,
      abi: htlcAbi,
      functionName: 'claim',
      args: [htlcId, preimageHex],
    });
  } catch (err) {
    postRefundClaimFailed = true;
    console.log('Post-refund claim correctly reverted with:', err.shortMessage || err.message);
  }
  if (!postRefundClaimFailed) {
    throw new Error('CRITICAL VULNERABILITY: Post-refund claim succeeded!');
  }

  // 13. STEP 12: CANCEL LIGHTNING HOLD INVOICE
  console.log('\n--- VERIFYING LIGHTNING SETTLEMENT MUTUAL EXCLUSION ---');
  await lndBackend.cancelHoldInvoice(holdInv.paymentHash);
  const postLnState = await lndBackend.getInvoiceState(holdInv.paymentHash);
  console.log('Lightning invoice state:', postLnState, '(Expected CANCELED)');
  if (postLnState !== 'CANCELED') throw new Error('Expected CANCELED Lightning invoice');

  // Save evidence
  const evidence = {
    protocolVersion: '4.0.0',
    chainId: BASE_SEPOLIA_CHAIN_ID,
    network: 'base-sepolia',
    htlcContractAddress: deployment.htlcAddress,
    tokenAddress: OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS,
    operatorRefundAddress: operatorAccount.address,
    clientClaimAddress: clientAccount.address,
    amountUnits: amountUnits.toString(),
    hashLock,
    htlcId,
    fundTxHash,
    fundBlock,
    testTimelockTimestamp: timelockTimestamp,
    testTimelockDurationSeconds: testTimelockDuration,
    earlyRefundRejectionVerified: true,
    refundTxHash,
    refundBlock,
    finalContractStatus: 'REFUNDED (3)',
    operatorTokenBalanceRestored: true,
    postRefundClaimRejectionVerified: true,
    lightningHoldInvoiceCanceled: true,
    completedAt: new Date().toISOString(),
  };

  const evidencePath = join(dataDir, 'base-sepolia-refund-evidence.json');
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  console.log('\nEvidence saved to:', evidencePath);
  console.log('=== LIVE PUBLIC BASE SEPOLIA REFUND PROOF FULLY ACCOMPLISHED ===');
}

main().catch((err) => {
  console.error('Refund proof failed:', err);
  process.exit(1);
});
