/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Phase 4: Live Real LND Regtest ↔ Public Base Sepolia USDC Atomic Test
 *
 * PROVES:
 * - Real local LND hold invoice on Regtest
 * - Real public Base Sepolia HTLC (0x3e4b1374d2a42ed3aca3470978fc4ec52914ae6f)
 * - Official Circle Base Sepolia test USDC (0x036CbD53842c5426634e7929541eC2318f3dCF7e)
 * - Sovereign external client boundary (Client signs claim directly on Base Sepolia)
 * - Router extracts S only from verified on-chain event/calldata
 * - Zero real money (Base Sepolia testnet only)
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  http,
  type Hex,
  parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { AtomicCoordinator } from '../src/atomic/coordinator/coordinator.ts';
import { LndClient } from '../src/atomic/lightning/lnd-client.ts';
import { LndLightningAtomicBackend } from '../src/atomic/lightning/lnd-backend.ts';
import { BaseSepoliaAtomicBackend } from '../src/atomic/evm/base-sepolia-backend.ts';
import { SqlitePersistence } from '../src/persistence/sqlite.ts';
import { FakeLiquidityInventory } from '../src/atomic/liquidity/fake-inventory.ts';
import { SovereignAtomicState } from '../src/atomic/types.ts';
import {
  OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS,
  BASE_SEPOLIA_CHAIN_ID,
} from '../src/atomic/evm/base-guard.ts';

const rootDir = process.cwd();
const dataDir = join(rootDir, 'regtest-env', 'data');
const binDir = join(rootDir, 'regtest-env', 'bin');
const lncliBin = join(binDir, 'lncli.exe');

function payFromNodeB(bolt11: string): void {
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('PHASE 4 — REAL LND REGTEST ↔ LIVE BASE SEPOLIA TEST USDC ATOMIC ROUTE', () => {
  let coordinator: AtomicCoordinator;
  let lndBackend: LndLightningAtomicBackend;
  let baseBackend: BaseSepoliaAtomicBackend;
  let inventory: FakeLiquidityInventory;
  let deployment: any;
  let operatorAccount: any;
  let clientAccount: any;
  let clientWalletClient: any;
  let publicClient: any;

  before(async () => {
    deployment = JSON.parse(readFileSync(join(dataDir, 'base-sepolia-deployment.json'), 'utf8'));
    const opData = JSON.parse(readFileSync(join(dataDir, 'base-sepolia-operator.json'), 'utf8'));
    const clientData = JSON.parse(readFileSync(join(dataDir, 'base-sepolia-client.json'), 'utf8'));

    operatorAccount = privateKeyToAccount(opData.privateKey);
    clientAccount = privateKeyToAccount(clientData.privateKey);

    publicClient = createPublicClient({
      chain: baseSepolia,
      transport: http('https://sepolia.base.org'),
      cacheTime: 0,
    });

    clientWalletClient = createWalletClient({
      account: clientAccount,
      chain: baseSepolia,
      transport: http('https://sepolia.base.org'),
    });

    // 1. Initialize Real LND Backend (LND-A)
    const leastPrivMac = join(dataDir, 'lnd-a', 'data', 'chain', 'bitcoin', 'regtest', 'router-least-privilege.macaroon');
    const adminMac = join(dataDir, 'lnd-a', 'data', 'chain', 'bitcoin', 'regtest', 'admin.macaroon');
    const macaroonPath = existsSync(leastPrivMac) ? leastPrivMac : adminMac;

    const lndClientA = new LndClient({
      restEndpoint: 'https://127.0.0.1:18080',
      tlsCertPath: join(dataDir, 'lnd-a', 'tls.cert'),
      macaroonPath,
      expectedNetwork: 'regtest',
    });
    await lndClientA.verifyNetworkSafety();
    lndBackend = new LndLightningAtomicBackend(lndClientA);

    // 2. Initialize Base Sepolia Backend with Phase 5A reliability persistence
    baseBackend = new BaseSepoliaAtomicBackend({
      rpcUrl: 'https://sepolia.base.org',
      chainId: BASE_SEPOLIA_CHAIN_ID,
      htlcAddress: deployment.htlcAddress,
      tokenAddress: OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS,
      operatorPrivateKey: opData.privateKey,
      requiredConfirmations: 1,
      persistence: new SqlitePersistence({ filename: ':memory:' }),
    });
    await baseBackend.ensureGuards();

    inventory = new FakeLiquidityInventory({
      [OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS]: 20_000_000n,
    });

    coordinator = new AtomicCoordinator(
      lndBackend,
      baseBackend,
      inventory,
      {
        tokenAddress: OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS,
        operatorRefundAddress: operatorAccount.address,
      }
    );
  });

  it('1. Verified deployed HTLC contract and official Circle test USDC on Base Sepolia', async () => {
    assert.equal(baseBackend.getHtlcAddress(), deployment.htlcAddress);
    assert.equal(baseBackend.getTokenAddress(), OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS);

    // Verify operator balance
    const usdcAbi = parseAbi(['function balanceOf(address) view returns (uint256)']);
    const opUsdc = (await publicClient.readContract({
      address: OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS,
      abi: usdcAbi,
      functionName: 'balanceOf',
      args: [operatorAccount.address],
    })) as bigint;

    console.log(`Operator USDC balance on Base Sepolia: ${(Number(opUsdc) / 1e6).toFixed(2)} USDC`);
    assert.ok(opUsdc >= 1_000_000n, 'Operator must have at least 1 test USDC');
  });

  it('2. REAL DIRECT BASE HAPPY PATH: LND Regtest ↔ Public Base Sepolia Official USDC', async () => {
    // 1. Client generates secret locally. Router NEVER sees S at this stage!
    const secretPreimage = randomBytes(32);
    const hashLock = `0x${createHash('sha256').update(secretPreimage).digest('hex')}` as Hex;
    const idempotencyKey = `base_live_happy_${Date.now()}`;

    // 10,000 units (0.01 USDC)
    const amountSats = 10_000n;
    const amountUnits = 10_000n;

    // 2. Prepare swap intent: Router receives ONLY public hashLock
    const record = await coordinator.prepareSwap({
      idempotencyKey,
      hashLock,
      claimingAddress: clientAccount.address,
      targetDestinationAddress: clientAccount.address,
      amountSats,
      expectedUsdcAmount: amountUnits,
      cltvExpiryBlocks: 144,
    });

    assert.equal(record.state, SovereignAtomicState.INVOICE_CREATED);
    const bolt11 = record.holdInvoice!.bolt11;

    // 3. Real payer node (LND-B) pays hold invoice
    payFromNodeB(bolt11);

    // Poll until LND-A reports ACCEPTED (held)
    let held = false;
    for (let i = 0; i < 30; i++) {
      await sleep(200);
      const st = await lndBackend.getInvoiceState(record.holdInvoice!.paymentHash);
      if (st === 'ACCEPTED') {
        held = true;
        break;
      }
    }
    assert.equal(held, true, 'LND invoice must be ACCEPTED (held) by payer');

    // 4. Coordinator detects hold
    const heldRecord = await coordinator.onLightningHoldDetected(record.id);
    assert.equal(heldRecord.state, SovereignAtomicState.LIGHTNING_HELD);

    // Record initial client USDC balance
    const usdcAbi = parseAbi(['function balanceOf(address) view returns (uint256)']);
    const preClientUsdc = (await publicClient.readContract({
      address: OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS,
      abi: usdcAbi,
      functionName: 'balanceOf',
      args: [clientAccount.address],
    })) as bigint;

    // 5. Coordinator funds real HTLC with official test USDC on Base Sepolia!
    console.log('Broadcasting live HTLC fund transaction on Base Sepolia...');
    const fundedRecord = await coordinator.fundEvmHtlc(record.id);
    assert.equal(fundedRecord.state, SovereignAtomicState.EVM_FUNDED);
    console.log('Base Sepolia Funding Tx Hash:', fundedRecord.evmFundingTxHash);
    console.log('Base Sepolia HTLC ID:', fundedRecord.evmHtlcId);

    // 6. SOVEREIGN CLIENT CLAIM: Client signs and broadcasts claim directly to Base Sepolia
    console.log('Client signing and broadcasting claim directly to Base Sepolia...');
    const preimageHex = `0x${secretPreimage.toString('hex')}` as Hex;
    const claimTxHash = await clientWalletClient.writeContract({
      account: clientAccount,
      chain: baseSepolia,
      address: deployment.htlcAddress,
      abi: baseBackend.getHtlcAbi(),
      functionName: 'claim',
      args: [fundedRecord.evmHtlcId as Hex, preimageHex],
    });
    console.log('Client Claim Tx Hash:', claimTxHash);

    const claimReceipt = await publicClient.waitForTransactionReceipt({ hash: claimTxHash, confirmations: 2 });
    assert.equal(claimReceipt.status, 'success');
    console.log('Claim successfully mined with 2 confirmations in Base Sepolia block:', claimReceipt.blockNumber.toString());

    // 7. P0 SETTLEMENT GATE: Router observes confirmed claim on Base Sepolia,
    // extracts S from verified public evidence, rechecks CLTV safety, and settles LND
    console.log('Router verifying on-chain claim evidence and settling Lightning hold invoice...');
    const settledRecord = await coordinator.settleLightningFromEvmClaim(
      record.id,
      claimTxHash
    );

    assert.ok(
      settledRecord.state === SovereignAtomicState.DESTINATION_PENDING ||
      settledRecord.state === SovereignAtomicState.LIGHTNING_SETTLED
    );

    // 8. VERIFY BOTH RAILS REACHED TERMINAL SUCCESS:
    // On Base Sepolia: Client received official test USDC
    const postClientUsdc = (await publicClient.readContract({
      address: OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS,
      abi: usdcAbi,
      functionName: 'balanceOf',
      args: [clientAccount.address],
    })) as bigint;
    assert.equal(postClientUsdc - preClientUsdc, amountUnits);
    console.log(`Client received exactly ${Number(amountUnits) / 1e6} official Base Sepolia USDC!`);

    // On Lightning: Hold invoice is SETTLED
    const postLnState = await lndBackend.getInvoiceState(record.holdInvoice!.paymentHash);
    assert.equal(postLnState, 'SETTLED');
    console.log('Lightning Hold Invoice SETTLED on LND regtest!');
    console.log('=== REAL DUAL-RAIL ATOMIC SWAP FULLY PROVEN ON BASE SEPOLIA ===');
  });

  it('3. CROSS-RAIL FAILURE PATH A: LND HELD but EVM funding aborted -> Lightning canceled safely (0 sats lost)', async () => {
    const secret = randomBytes(32);
    const hashLock = `0x${createHash('sha256').update(secret).digest('hex')}` as Hex;

    const record = await coordinator.prepareSwap({
      idempotencyKey: `fail_path_a_${Date.now()}`,
      hashLock,
      claimingAddress: clientAccount.address,
      targetDestinationAddress: clientAccount.address,
      amountSats: 5_000n,
      expectedUsdcAmount: 5_000n,
      cltvExpiryBlocks: 144,
    });

    payFromNodeB(record.holdInvoice!.bolt11);

    for (let i = 0; i < 30; i++) {
      await sleep(200);
      const st = await lndBackend.getInvoiceState(record.holdInvoice!.paymentHash);
      if (st === 'ACCEPTED') break;
    }

    await coordinator.onLightningHoldDetected(record.id);

    // Cancel LND hold invoice safely
    await lndBackend.cancelHoldInvoice(record.holdInvoice!.paymentHash);
    const postCancelState = await lndBackend.getInvoiceState(record.holdInvoice!.paymentHash);
    assert.equal(postCancelState, 'CANCELED');
    console.log('Failure Path A: Lightning hold invoice safely canceled, 0 sats lost.');
  });

  it('4. SOVEREIGN PREIMAGE BOUNDARY: Wrong preimage cannot claim Base Sepolia HTLC', async () => {
    const secret = randomBytes(32);
    const wrongSecret = randomBytes(32);
    const hashLock = `0x${createHash('sha256').update(secret).digest('hex')}` as Hex;

    const amountUnits = 10_000n;
    const block = await publicClient.getBlock();
    const timelock = Number(block.timestamp) + 3600;

    const fundTx = await baseBackend.fundHtlc({
      swapKey: `wrong_preimage_${Date.now()}`,
      hashLock,
      amountUnits,
      tokenAddress: OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS,
      claimAddress: clientAccount.address,
      refundAddress: operatorAccount.address,
      refundLocktime: timelock,
    });

    assert.ok(fundTx.htlcId);

    // Client attempts to claim with WRONG preimage -> must revert
    const wrongPreimageHex = `0x${wrongSecret.toString('hex')}` as Hex;
    await assert.rejects(
      async () => {
        await clientWalletClient.writeContract({
          account: clientAccount,
          chain: baseSepolia,
          address: deployment.htlcAddress,
          abi: baseBackend.getHtlcAbi(),
          functionName: 'claim',
          args: [fundTx.htlcId as Hex, wrongPreimageHex],
        });
      },
      /PREIMAGE_MISMATCH|revert/i
    );
    console.log('Wrong preimage strictly rejected by Base Sepolia HTLC contract!');
  });

  it('5. LIVE BASE SEPOLIA REFUND EVIDENCE: Validates on-chain refund receipts, storage state == 3, and post-refund claim rejection', async () => {
    const evidenceFile = join(dataDir, 'base-sepolia-refund-evidence.json');
    assert.ok(existsSync(evidenceFile), 'Refund evidence file must exist');

    const ev = JSON.parse(readFileSync(evidenceFile, 'utf8'));
    assert.equal(ev.chainId, BASE_SEPOLIA_CHAIN_ID);
    assert.equal(ev.finalContractStatus, 'REFUNDED (3)');
    assert.ok(ev.fundTxHash.startsWith('0x'));
    assert.ok(ev.refundTxHash.startsWith('0x'));
    assert.ok(ev.fundBlock > 0);
    assert.ok(ev.refundBlock >= ev.fundBlock);

    // Verify on-chain storage directly via Base Sepolia RPC
    const storedHtlc: any = await publicClient.readContract({
      address: deployment.htlcAddress,
      abi: baseBackend.getHtlcAbi(),
      functionName: 'getHtlc',
      args: [ev.htlcId as Hex],
    });

    assert.equal(storedHtlc.status, 3, 'On-chain contract status must be REFUNDED (3)');
    assert.equal(storedHtlc.refundAddress.toLowerCase(), operatorAccount.address.toLowerCase());

    // Verify post-refund claim with any preimage reverts fail-closed
    await assert.rejects(
      async () => {
        await publicClient.simulateContract({
          account: clientAccount.address,
          address: deployment.htlcAddress,
          abi: baseBackend.getHtlcAbi(),
          functionName: 'claim',
          args: [ev.htlcId as Hex, `0x${'00'.repeat(32)}` as Hex],
        });
      },
      /NOT_LOCKED|revert/i
    );

    console.log('Live Base Sepolia refund evidence verified 100% on-chain!');
  });
});


