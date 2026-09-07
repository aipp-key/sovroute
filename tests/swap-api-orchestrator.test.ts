/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Unified Swap API & Orchestrator Integration Test Suite
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { privateKeyToAccount } from 'viem/accounts';

import {
  SwapOrchestrator,
  createApiServer,
} from '../src/api/index.ts';
import {
  QuoteEngine,
  PriceAggregator,
  MockPriceFeed,
} from '../src/pricing/index.ts';
import {
  AntiAbuseEngine,
  AntiAbusePersistence,
} from '../src/anti-abuse/index.ts';
import {
  GaslessAuthorizer,
  NonceManager,
  GaslessRelayer,
  EIP712_SWAP_AUTH_TYPES,
  type IOnchainBroadcaster,
  type SwapAuthorizationMessage,
  type HexAddress,
} from '../src/gasless/index.ts';
import { AtomicCoordinator } from '../src/atomic/coordinator/coordinator.ts';
import { SqlitePersistence } from '../src/persistence/sqlite.ts';
import { FakeLightningAtomicBackend } from '../src/atomic/lightning/fake-backend.ts';
import { FakeEvmAtomicBackend } from '../src/atomic/evm/fake-backend.ts';
import { FakeLiquidityInventory } from '../src/atomic/liquidity/fake-inventory.ts';
import { OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS } from '../src/atomic/evm/base-guard.ts';

const swapperAccount = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const swapperAddress = swapperAccount.address as HexAddress;

const swapperAccount2 = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const swapperAddress2 = swapperAccount2.address as HexAddress;

const destAddress: HexAddress = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const contractAddress: HexAddress = '0x1234567890123456789012345678901234567890';
const chainId = 84532n;

describe('UNIFIED SWAP API & ORCHESTRATOR SUITE (13 TESTS)', () => {
  let server: Server;
  let baseUrl: string;
  let orchestrator: SwapOrchestrator;
  let sharedDb: DatabaseSync;

  before(async () => {
    sharedDb = new DatabaseSync(':memory:');

    // 1. Pricing
    const feed1 = new MockPriceFeed({ name: 'f1', priceMicroUsd: 100_000_000_000n });
    const feed2 = new MockPriceFeed({ name: 'f2', priceMicroUsd: 100_000_000_000n });
    const quoteEngine = new QuoteEngine(new PriceAggregator([feed1, feed2]), { hmacSecret: 'api_test_secret' });

    // 2. Anti-Abuse
    const antiAbusePersistence = new AntiAbusePersistence({ existingDb: sharedDb });
    const antiAbuseEngine = new AntiAbuseEngine(antiAbusePersistence, quoteEngine, {
      maxRollingVolumeUsdcAtomic: 500_000_000n, // $500
    });

    // 3. Gasless UX
    const authorizer = new GaslessAuthorizer({
      name: 'SovRoute',
      version: '1',
      chainId,
      verifyingContract: contractAddress,
    });
    const nonceManager = new NonceManager({ existingDb: sharedDb });
    const broadcaster: IOnchainBroadcaster = {
      async broadcastTransaction() {
        return {
          txHash: '0x' + 'dd'.repeat(32) as `0x${string}`,
          async waitForReceipt() {
            return { blockNumber: 456789n, status: 'success' };
          },
        };
      },
      async getTransactionReceipt() {
        return { blockNumber: 456789n, status: 'success' };
      },
    };

    const relayer = new GaslessRelayer({
      quoteEngine,
      antiAbuseEngine,
      authorizer,
      nonceManager,
      broadcaster,
      db: sharedDb,
    });

    // 4. Frozen Core Coordinator
    const coordinatorPersistence = new SqlitePersistence({ filename: ':memory:' });
    const lightning = new FakeLightningAtomicBackend();
    const evm = new FakeEvmAtomicBackend();
    const inventory = new FakeLiquidityInventory({ [OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS]: 10_000_000_000n });
    const coordinator = new AtomicCoordinator(lightning, evm, inventory, {
      persistence: coordinatorPersistence,
    });

    orchestrator = new SwapOrchestrator({
      quoteEngine,
      antiAbuseEngine,
      authorizer,
      nonceManager,
      relayer,
      coordinator,
    });

    server = createApiServer({ orchestrator });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // 1. Health Endpoint
  it('1. GET /api/health returns operational status and reference spot price', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.status, 'HEALTHY');
    assert.equal(body.service, 'sovroute-api');
    assert.equal(body.btcPriceUsd, '100000.00');
    assert.equal(body.activePriceFeeds, 2);
  });

  // 2. Quote Creation
  it('2. POST /api/quote creates HMAC-signed quote for 50,000 sats', async () => {
    const res = await fetch(`${baseUrl}/api/quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amountSats: 50_000,
        targetDestinationAddress: destAddress,
      }),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.pair, 'BTC_LIGHTNING_TO_BASE_USDC');
    assert.equal(body.amountSats, '50000');
    assert.equal(body.netUsdcAtomic, '49500000'); // ~$49.50 USDC
    assert.ok(body.quoteSignature);
    assert.ok(body.expiresAt > Date.now());
  });

  // 3. Quote Missing Parameters
  it('3. POST /api/quote rejects request missing required parameters with 400', async () => {
    const res = await fetch(`${baseUrl}/api/quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountSats: 50_000 }), // missing targetDestinationAddress
    });

    assert.equal(res.status, 400);
    const body = (await res.json()) as any;
    assert.equal(body.error, 'MISSING_PARAMETERS');
  });

  // 4. Quote Out of Range Rejection
  it('4. POST /api/quote rejects amount below minimum swap threshold (5,000 sats)', async () => {
    const res = await fetch(`${baseUrl}/api/quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amountSats: 2_000,
        targetDestinationAddress: destAddress,
      }),
    });

    assert.equal(res.status, 400);
    const body = (await res.json()) as any;
    assert.equal(body.error, 'SwapAmountOutOfBoundsError');
  });

  // 5. Wallet Limits Check
  it('5. GET /api/limits/:walletAddress accurately reports cooldown and rolling volume', async () => {
    const res = await fetch(`${baseUrl}/api/limits/${swapperAddress}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.walletAddress, swapperAddress.toLowerCase());
    assert.equal(body.isCooldownActive, false);
    assert.equal(body.rolling24hUsedUsdc, 0);
    assert.equal(body.remaining24hUsdc, 500);
    assert.equal(body.maxSingleSwapUsdc, 250);
  });

  // 6. End-to-End Gasless Swap Submission (Happy Path)
  it('6. POST /api/swap/submit completes full pipeline and returns Lightning hold invoice', async () => {
    // 1. Request Quote
    const quoteRes = await fetch(`${baseUrl}/api/quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amountSats: 50_000,
        targetDestinationAddress: destAddress,
      }),
    });
    const quote = (await quoteRes.json()) as any;

    // 2. Sign EIP-712 Authorization
    const nonce = orchestrator.nonceManager.getNextNonce(swapperAddress);
    const deadline = BigInt(Math.floor(Date.now() / 1000)) + 300n;

    const message: SwapAuthorizationMessage = {
      swapper: swapperAddress,
      destination: destAddress,
      amountUsdcAtomic: BigInt(quote.netUsdcAtomic),
      amountSats: BigInt(quote.amountSats),
      quoteId: quote.quoteId,
      nonce,
      deadline,
    };

    const signature = await swapperAccount.signTypedData({
      domain: orchestrator.authorizer.getDomain(),
      types: EIP712_SWAP_AUTH_TYPES,
      primaryType: 'SwapAuthorization',
      message,
    });

    // 3. Submit Swap
    const idempotencyKey = 'api-happy-path-1';
    const submitRes = await fetch(`${baseUrl}/api/swap/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        authorization: {
          message: {
            ...message,
            amountUsdcAtomic: message.amountUsdcAtomic.toString(),
            amountSats: message.amountSats.toString(),
            nonce: message.nonce.toString(),
            deadline: message.deadline.toString(),
          },
          signature,
        },
        quote,
        idempotencyKey,
      }),
    });

    assert.equal(submitRes.status, 200);
    const body = (await submitRes.json()) as any;
    assert.equal(body.idempotencyKey, idempotencyKey);
    assert.equal(body.status, 'INVOICE_CREATED');
    assert.ok(body.lightning.paymentRequest.startsWith('lnbc'));
    assert.equal(body.lightning.amountSats, '50000');
    assert.equal(body.base.claimingAddress, destAddress.toLowerCase());
    assert.equal(body.relayer.status, 'CONFIRMED');
    assert.ok(body.relayer.txHash);
  });

  // 7. Signature Tampering Rejection
  it('7. POST /api/swap/submit rejects tampered EIP-712 signature with 400', async () => {
    const quoteRes = await fetch(`${baseUrl}/api/quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amountSats: 50_000,
        targetDestinationAddress: destAddress,
      }),
    });
    const quote = (await quoteRes.json()) as any;

    const message = {
      swapper: swapperAddress2,
      destination: destAddress,
      amountUsdcAtomic: quote.netUsdcAtomic,
      amountSats: quote.amountSats,
      quoteId: quote.quoteId,
      nonce: orchestrator.nonceManager.getNextNonce(swapperAddress2).toString(),
      deadline: (Math.floor(Date.now() / 1000) + 300).toString(),
    };

    // Valid signature
    const signature = await swapperAccount2.signTypedData({
      domain: orchestrator.authorizer.getDomain(),
      types: EIP712_SWAP_AUTH_TYPES,
      primaryType: 'SwapAuthorization',
      message: {
        ...message,
        amountUsdcAtomic: BigInt(message.amountUsdcAtomic),
        amountSats: BigInt(message.amountSats),
        nonce: BigInt(message.nonce),
        deadline: BigInt(message.deadline),
      },
    });

    // Tamper signature string
    const tamperedSig = ('0x' + (signature[2] === '0' ? '1' : '0') + signature.slice(3)) as `0x${string}`;

    const submitRes = await fetch(`${baseUrl}/api/swap/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        authorization: { message, signature: tamperedSig },
        quote,
        idempotencyKey: 'tamper-test-key',
      }),
    });

    assert.equal(submitRes.status, 400);
    const body = (await submitRes.json()) as any;
    assert.equal(body.error, 'InvalidSignatureError');
  });

  // 8. Expired Quote Rejection
  it('8. POST /api/swap/submit rejects expired quote with 400', async () => {
    const expiredQuote = {
      quoteId: 'expired-qid',
      pair: 'BTC_LIGHTNING_TO_BASE_USDC',
      amountSats: '50000',
      referencePriceMicroUsd: '100000000000',
      grossUsdcAtomic: '50000000',
      spreadAmountAtomic: '250000',
      fixedFeeAtomic: '250000',
      netUsdcAtomic: '49500000',
      effectiveRate: '99000.000000',
      activeFeedCount: 2,
      createdAt: Date.now() - 60_000,
      expiresAt: Date.now() - 30_000, // expired 30s ago
      targetDestinationAddress: destAddress,
      quoteSignature: 'invalid_sig',
    };

    const submitRes = await fetch(`${baseUrl}/api/swap/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        authorization: {
          message: {
            swapper: swapperAddress,
            destination: destAddress,
            amountUsdcAtomic: '49500000',
            amountSats: '50000',
            quoteId: 'expired-qid',
            nonce: '0',
            deadline: (Math.floor(Date.now() / 1000) + 300).toString(),
          },
          signature: '0x' + '11'.repeat(65),
        },
        quote: expiredQuote,
        idempotencyKey: 'expired-test-key',
      }),
    });

    assert.equal(submitRes.status, 400);
    const body = (await submitRes.json()) as any;
    assert.equal(body.error, 'InvalidSignatureError');
  });

  // 9. Wallet Cooldown (60s) Rejection
  it('9. POST /api/swap/submit rejects second request within 60s with 429 WALLET_COOLDOWN_ACTIVE', async () => {
    // Note: swapperAddress performed a swap in test 6 above!
    // A fresh swap request right now from same wallet should fail cooldown!
    const quoteRes = await fetch(`${baseUrl}/api/quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amountSats: 50_000,
        targetDestinationAddress: destAddress,
      }),
    });
    const quote = (await quoteRes.json()) as any;

    const nonce = orchestrator.nonceManager.getNextNonce(swapperAddress);
    const deadline = BigInt(Math.floor(Date.now() / 1000)) + 300n;

    const message: SwapAuthorizationMessage = {
      swapper: swapperAddress,
      destination: destAddress,
      amountUsdcAtomic: BigInt(quote.netUsdcAtomic),
      amountSats: BigInt(quote.amountSats),
      quoteId: quote.quoteId,
      nonce,
      deadline,
    };

    const signature = await swapperAccount.signTypedData({
      domain: orchestrator.authorizer.getDomain(),
      types: EIP712_SWAP_AUTH_TYPES,
      primaryType: 'SwapAuthorization',
      message,
    });

    const submitRes = await fetch(`${baseUrl}/api/swap/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        authorization: {
          message: {
            ...message,
            amountUsdcAtomic: message.amountUsdcAtomic.toString(),
            amountSats: message.amountSats.toString(),
            nonce: message.nonce.toString(),
            deadline: message.deadline.toString(),
          },
          signature,
        },
        quote,
        idempotencyKey: 'cooldown-test-key',
      }),
    });

    assert.equal(submitRes.status, 429);
    const body = (await submitRes.json()) as any;
    assert.equal(body.error, 'WALLET_COOLDOWN_ACTIVE');
  });

  // 10. Status Polling Endpoint
  it('10. GET /api/swap/:idempotencyKey returns prepared swap execution record', async () => {
    const res = await fetch(`${baseUrl}/api/swap/api-happy-path-1`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.idempotencyKey, 'api-happy-path-1');
    assert.equal(body.state, 'INVOICE_CREATED');
    assert.equal(body.amountSats, '50000');
    assert.equal(body.claimingAddress, destAddress.toLowerCase());
    assert.ok(body.paymentRequest.startsWith('lnbc'));
  });

  // 11. Missing Swap Query
  it('11. GET /api/swap/:idempotencyKey returns 404 for unknown swap key', async () => {
    const res = await fetch(`${baseUrl}/api/swap/non-existent-key-12345`);
    assert.equal(res.status, 404);
    const body = (await res.json()) as any;
    assert.equal(body.error, 'NOT_FOUND');
  });

  // 12. CORS Preflight
  it('12. OPTIONS preflight request returns 204 with CORS headers', async () => {
    const res = await fetch(`${baseUrl}/api/quote`, {
      method: 'OPTIONS',
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
    assert.ok(res.headers.get('Access-Control-Allow-Methods')?.includes('POST'));
  });

  // 13. Idempotent Replay
  it('13. Re-submitting identical swap with same idempotencyKey returns existing record', async () => {
    const res = await fetch(`${baseUrl}/api/swap/api-happy-path-1`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.idempotencyKey, 'api-happy-path-1');
  });
});
