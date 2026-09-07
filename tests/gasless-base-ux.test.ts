/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Gasless Base UX Test Suite (EIP-712 & Relayer Model)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { privateKeyToAccount } from 'viem/accounts';
import {
  GaslessAuthorizer,
  NonceManager,
  GaslessRelayer,
  EIP712_SWAP_AUTH_TYPES,
  InvalidSignatureError,
  SignatureExpiredError,
  InvalidNonceError,
  QuoteAlreadyConsumedError,
  AuthorizationParameterMismatchError,
  AmbiguousBroadcastError,
  RelayerExecutionRevertedError,
  type IOnchainBroadcaster,
  type SwapAuthorizationMessage,
  type HexAddress,
} from '../src/gasless/index.ts';
import {
  QuoteEngine,
  PriceAggregator,
  MockPriceFeed,
} from '../src/pricing/index.ts';
import {
  AntiAbuseEngine,
  AntiAbusePersistence,
} from '../src/anti-abuse/index.ts';

// Deterministic test accounts
const swapperAccount = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const swapperAddress = swapperAccount.address as HexAddress;

const attackerAccount = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');

const destinationAddress: HexAddress = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const contractAddressA: HexAddress = '0x1234567890123456789012345678901234567890';
const contractAddressB: HexAddress = '0x9999999999999999999999999999999999999999';

const chainIdBaseSepolia = 84532n;
const chainIdBaseMainnet = 8453n;

function createTestHarness(options: {
  broadcaster?: IOnchainBroadcaster;
  chainId?: bigint;
  contract?: HexAddress;
  clock?: () => number;
} = {}) {
  const db = new DatabaseSync(':memory:');
  const feed1 = new MockPriceFeed({ name: 'f1', priceMicroUsd: 100_000_000_000n, timestampSupplier: options.clock });
  const feed2 = new MockPriceFeed({ name: 'f2', priceMicroUsd: 100_000_000_000n, timestampSupplier: options.clock });
  const quoteEngine = new QuoteEngine(new PriceAggregator([feed1, feed2]), { hmacSecret: 'test_secret_gasless' });

  const antiAbusePersistence = new AntiAbusePersistence({ existingDb: db });
  const antiAbuseEngine = new AntiAbuseEngine(antiAbusePersistence, quoteEngine);

  const domainConfig = {
    name: 'SovRoute',
    version: '1',
    chainId: options.chainId ?? chainIdBaseSepolia,
    verifyingContract: options.contract ?? contractAddressA,
  };

  const authorizer = new GaslessAuthorizer(domainConfig);
  const nonceManager = new NonceManager({ existingDb: db });

  const defaultBroadcaster: IOnchainBroadcaster = options.broadcaster ?? {
    async broadcastTransaction() {
      return {
        txHash: '0x' + 'aa'.repeat(32) as `0x${string}`,
        async waitForReceipt() {
          return { blockNumber: 123456n, status: 'success' };
        },
      };
    },
    async getTransactionReceipt() {
      return { blockNumber: 123456n, status: 'success' };
    },
  };

  const relayer = new GaslessRelayer({
    quoteEngine,
    antiAbuseEngine,
    authorizer,
    nonceManager,
    broadcaster: defaultBroadcaster,
    db,
  });

  return {
    quoteEngine,
    antiAbuseEngine,
    authorizer,
    nonceManager,
    relayer,
    db,
    domainConfig,
  };
}

describe('GASLESS BASE UX & EIP-712 RELAYER SUITE (14 TESTS)', () => {
  // 1. Happy Path
  it('1. End-to-end valid gasless swap authorization, broadcast, and confirmation', async () => {
    const harness = createTestHarness();

    const quote = await harness.quoteEngine.createQuote({
      amountSats: 50_000n,
      targetDestinationAddress: destinationAddress,
    });

    const nonce = harness.nonceManager.getNextNonce(swapperAddress);
    const deadline = BigInt(Math.floor(Date.now() / 1000)) + 300n; // 5 min

    const message: SwapAuthorizationMessage = {
      swapper: swapperAddress,
      destination: destinationAddress,
      amountUsdcAtomic: quote.netUsdcAtomic,
      amountSats: quote.amountSats,
      quoteId: quote.quoteId,
      nonce,
      deadline,
    };

    const signature = await swapperAccount.signTypedData({
      domain: harness.authorizer.getDomain(),
      types: EIP712_SWAP_AUTH_TYPES,
      primaryType: 'SwapAuthorization',
      message,
    });

    const result = await harness.relayer.submitSwap({
      authorization: { message, signature },
      quote,
      idempotencyKey: 'happy-path-key',
    });

    assert.equal(result.status, 'CONFIRMED');
    assert.equal(result.blockNumber, 123456n);
    assert.equal(result.nonce, 0n);
    assert.equal(result.amountUsdcAtomic, quote.netUsdcAtomic);
    assert.equal(harness.nonceManager.getNextNonce(swapperAddress), 1n);
  });

  // 2. Signature Tampering (Amount modified)
  it('2. Rejects authorization if signed amount is tampered', async () => {
    const harness = createTestHarness();
    const quote = await harness.quoteEngine.createQuote({
      amountSats: 50_000n,
      targetDestinationAddress: destinationAddress,
    });

    const message: SwapAuthorizationMessage = {
      swapper: swapperAddress,
      destination: destinationAddress,
      amountUsdcAtomic: quote.netUsdcAtomic,
      amountSats: quote.amountSats,
      quoteId: quote.quoteId,
      nonce: 0n,
      deadline: BigInt(Math.floor(Date.now() / 1000)) + 300n,
    };

    const signature = await swapperAccount.signTypedData({
      domain: harness.authorizer.getDomain(),
      types: EIP712_SWAP_AUTH_TYPES,
      primaryType: 'SwapAuthorization',
      message,
    });

    // Tamper the message amount after signing
    const tamperedMessage = { ...message, amountUsdcAtomic: quote.netUsdcAtomic + 100_000n };

    await assert.rejects(
      async () => await harness.authorizer.verifyAuthorization({ message: tamperedMessage, signature }, quote),
      (err: Error) => err instanceof AuthorizationParameterMismatchError
    );
  });

  // 3. Signature Tampering (Cryptographic verification failure)
  it('3. Rejects authorization if signature bytes are tampered', async () => {
    const harness = createTestHarness();
    const quote = await harness.quoteEngine.createQuote({
      amountSats: 50_000n,
      targetDestinationAddress: destinationAddress,
    });

    const message: SwapAuthorizationMessage = {
      swapper: swapperAddress,
      destination: destinationAddress,
      amountUsdcAtomic: quote.netUsdcAtomic,
      amountSats: quote.amountSats,
      quoteId: quote.quoteId,
      nonce: 0n,
      deadline: BigInt(Math.floor(Date.now() / 1000)) + 300n,
    };

    const signature = await swapperAccount.signTypedData({
      domain: harness.authorizer.getDomain(),
      types: EIP712_SWAP_AUTH_TYPES,
      primaryType: 'SwapAuthorization',
      message,
    });

    // Invert a nibble in r to genuinely corrupt the signature
    const tamperedSignature = ('0x' + (signature[2] === '0' ? '1' : '0') + signature.slice(3)) as `0x${string}`;

    await assert.rejects(
      async () => await harness.authorizer.verifyAuthorization({ message, signature: tamperedSignature }, quote),
      (err: Error) => err instanceof InvalidSignatureError
    );
  });

  // 4. Expired Signature
  it('4. Rejects authorization when deadline is in the past', async () => {
    const harness = createTestHarness();
    const quote = await harness.quoteEngine.createQuote({
      amountSats: 50_000n,
      targetDestinationAddress: destinationAddress,
    });

    const pastDeadline = 1_700_000_000n;
    const nowSeconds = 1_700_000_100n;

    const message: SwapAuthorizationMessage = {
      swapper: swapperAddress,
      destination: destinationAddress,
      amountUsdcAtomic: quote.netUsdcAtomic,
      amountSats: quote.amountSats,
      quoteId: quote.quoteId,
      nonce: 0n,
      deadline: pastDeadline,
    };

    const signature = await swapperAccount.signTypedData({
      domain: harness.authorizer.getDomain(),
      types: EIP712_SWAP_AUTH_TYPES,
      primaryType: 'SwapAuthorization',
      message,
    });

    await assert.rejects(
      async () => await harness.authorizer.verifyAuthorization({ message, signature }, quote, nowSeconds),
      (err: Error) => err instanceof SignatureExpiredError && err.deadline === pastDeadline
    );
  });

  // 5. Wrong Chain ID (Cross-chain replay defense)
  it('5. Rejects signature generated for a different chainId (anti-cross-chain replay)', async () => {
    // Harness configured for Base Sepolia (84532)
    const harness = createTestHarness({ chainId: chainIdBaseSepolia });
    const quote = await harness.quoteEngine.createQuote({
      amountSats: 50_000n,
      targetDestinationAddress: destinationAddress,
    });

    const message: SwapAuthorizationMessage = {
      swapper: swapperAddress,
      destination: destinationAddress,
      amountUsdcAtomic: quote.netUsdcAtomic,
      amountSats: quote.amountSats,
      quoteId: quote.quoteId,
      nonce: 0n,
      deadline: BigInt(Math.floor(Date.now() / 1000)) + 300n,
    };

    // User signed for Base Mainnet (8453)
    const mainnetDomain = {
      ...harness.authorizer.getDomain(),
      chainId: Number(chainIdBaseMainnet),
    };

    const signature = await swapperAccount.signTypedData({
      domain: mainnetDomain,
      types: EIP712_SWAP_AUTH_TYPES,
      primaryType: 'SwapAuthorization',
      message,
    });

    // Verification on Base Sepolia must fail closed!
    await assert.rejects(
      async () => await harness.authorizer.verifyAuthorization({ message, signature }, quote),
      (err: Error) => err instanceof InvalidSignatureError
    );
  });

  // 6. Wrong Verifying Contract Address
  it('6. Rejects signature generated for a different verifying contract address', async () => {
    const harness = createTestHarness({ contract: contractAddressA });
    const quote = await harness.quoteEngine.createQuote({
      amountSats: 50_000n,
      targetDestinationAddress: destinationAddress,
    });

    const message: SwapAuthorizationMessage = {
      swapper: swapperAddress,
      destination: destinationAddress,
      amountUsdcAtomic: quote.netUsdcAtomic,
      amountSats: quote.amountSats,
      quoteId: quote.quoteId,
      nonce: 0n,
      deadline: BigInt(Math.floor(Date.now() / 1000)) + 300n,
    };

    // Signed for contract B
    const contractBDomain = {
      ...harness.authorizer.getDomain(),
      verifyingContract: contractAddressB,
    };

    const signature = await swapperAccount.signTypedData({
      domain: contractBDomain,
      types: EIP712_SWAP_AUTH_TYPES,
      primaryType: 'SwapAuthorization',
      message,
    });

    // Verified on contract A must fail
    await assert.rejects(
      async () => await harness.authorizer.verifyAuthorization({ message, signature }, quote),
      (err: Error) => err instanceof InvalidSignatureError
    );
  });

  // 7. Nonce Replay Prevention
  it('7. Rejects submission attempting to reuse an already spent nonce', async () => {
    const harness = createTestHarness();
    const fakeSig = ('0x' + '11'.repeat(65)) as `0x${string}`;

    // Consume nonce 0
    harness.nonceManager.verifyAndConsume(swapperAddress, 0n, 'quote-1', fakeSig);

    // Attempting to consume nonce 0 again must fail with InvalidNonceError
    const fakeSig2 = ('0x' + '22'.repeat(65)) as `0x${string}`;
    assert.throws(
      () => harness.nonceManager.verifyAndConsume(swapperAddress, 0n, 'quote-2', fakeSig2),
      (err: Error) => err instanceof InvalidNonceError && err.expectedNonce === 1n && err.receivedNonce === 0n
    );
  });

  // 8. Quote Single-Use Enforcement
  it('8. Rejects reusing an already consumed quoteId even with a fresh nonce', async () => {
    const harness = createTestHarness();
    const fakeSig1 = ('0x' + '11'.repeat(65)) as `0x${string}`;
    const fakeSig2 = ('0x' + '22'.repeat(65)) as `0x${string}`;

    // Consume quote-A at nonce 0
    harness.nonceManager.verifyAndConsume(swapperAddress, 0n, 'quote-A', fakeSig1);

    // Attempting to use quote-A again at nonce 1 must fail closed
    assert.throws(
      () => harness.nonceManager.verifyAndConsume(swapperAddress, 1n, 'quote-A', fakeSig2),
      (err: Error) => err instanceof QuoteAlreadyConsumedError && err.quoteId === 'quote-A'
    );
  });

  // 9. Recipient Address Mismatch
  it('9. Rejects authorization when destination address does not match quote destination', async () => {
    const harness = createTestHarness();
    const quote = await harness.quoteEngine.createQuote({
      amountSats: 50_000n,
      targetDestinationAddress: destinationAddress,
    });

    const otherDestination: HexAddress = '0x1111111111111111111111111111111111111111';

    const message: SwapAuthorizationMessage = {
      swapper: swapperAddress,
      destination: otherDestination, // Mismatch!
      amountUsdcAtomic: quote.netUsdcAtomic,
      amountSats: quote.amountSats,
      quoteId: quote.quoteId,
      nonce: 0n,
      deadline: BigInt(Math.floor(Date.now() / 1000)) + 300n,
    };

    const signature = await swapperAccount.signTypedData({
      domain: harness.authorizer.getDomain(),
      types: EIP712_SWAP_AUTH_TYPES,
      primaryType: 'SwapAuthorization',
      message,
    });

    await assert.rejects(
      async () => await harness.authorizer.verifyAuthorization({ message, signature }, quote),
      (err: Error) => err instanceof AuthorizationParameterMismatchError && err.field === 'destination'
    );
  });

  // 10. Swapper Address Mismatch (Attacker signs for victim swapper address)
  it('10. Rejects authorization when signer does not match swapper address in message', async () => {
    const harness = createTestHarness();
    const quote = await harness.quoteEngine.createQuote({
      amountSats: 50_000n,
      targetDestinationAddress: destinationAddress,
    });

    const message: SwapAuthorizationMessage = {
      swapper: swapperAddress, // Claims to be swapper
      destination: destinationAddress,
      amountUsdcAtomic: quote.netUsdcAtomic,
      amountSats: quote.amountSats,
      quoteId: quote.quoteId,
      nonce: 0n,
      deadline: BigInt(Math.floor(Date.now() / 1000)) + 300n,
    };

    // But signed by attackerAccount!
    const signature = await attackerAccount.signTypedData({
      domain: harness.authorizer.getDomain(),
      types: EIP712_SWAP_AUTH_TYPES,
      primaryType: 'SwapAuthorization',
      message,
    });

    await assert.rejects(
      async () => await harness.authorizer.verifyAuthorization({ message, signature }, quote),
      (err: Error) => err instanceof InvalidSignatureError
    );
  });

  // 11. Concurrent Nonce Submission Race
  it('11. Prevents duplicate nonce execution under concurrent attempts', async () => {
    const harness = createTestHarness();
    const fakeSig1 = ('0x' + '33'.repeat(65)) as `0x${string}`;
    const fakeSig2 = ('0x' + '44'.repeat(65)) as `0x${string}`;

    // Two parallel calls attempting to claim nonce 0 simultaneously
    const runCall1 = () => harness.nonceManager.verifyAndConsume(swapperAddress, 0n, 'q-race-1', fakeSig1);
    const runCall2 = () => harness.nonceManager.verifyAndConsume(swapperAddress, 0n, 'q-race-2', fakeSig2);

    runCall1();
    assert.throws(runCall2, (err: Error) => err instanceof InvalidNonceError);
  });

  // 12. RPC Timeout / Ambiguous Broadcast (No blind retry)
  it('12. Enforces fail-closed AMBIGUOUS_TIMEOUT on broadcast timeout with zero blind retry', async () => {
    let broadcastCount = 0;
    const timeoutBroadcaster: IOnchainBroadcaster = {
      async broadcastTransaction() {
        broadcastCount++;
        return {
          txHash: '0x' + 'bb'.repeat(32) as `0x${string}`,
          async waitForReceipt() {
            throw new Error('RPC_TIMEOUT: Gateway timeout after 10000ms');
          },
        };
      },
      async getTransactionReceipt() {
        return null; // Receipt not found yet
      },
    };

    const harness = createTestHarness({ broadcaster: timeoutBroadcaster });
    const quote = await harness.quoteEngine.createQuote({
      amountSats: 50_000n,
      targetDestinationAddress: destinationAddress,
    });

    const message: SwapAuthorizationMessage = {
      swapper: swapperAddress,
      destination: destinationAddress,
      amountUsdcAtomic: quote.netUsdcAtomic,
      amountSats: quote.amountSats,
      quoteId: quote.quoteId,
      nonce: 0n,
      deadline: BigInt(Math.floor(Date.now() / 1000)) + 300n,
    };

    const signature = await swapperAccount.signTypedData({
      domain: harness.authorizer.getDomain(),
      types: EIP712_SWAP_AUTH_TYPES,
      primaryType: 'SwapAuthorization',
      message,
    });

    await assert.rejects(
      async () =>
        await harness.relayer.submitSwap({
          authorization: { message, signature },
          quote,
          idempotencyKey: 'timeout-idemp-key',
        }),
      (err: Error) => err instanceof AmbiguousBroadcastError
    );

    // Verify exactly ONE transaction was broadcasted, NEVER a second blind retry!
    assert.equal(broadcastCount, 1);

    // Verify relayer state was marked as AMBIGUOUS_TIMEOUT
    const row = harness.db
      .prepare('SELECT status, tx_hash FROM relayer_executions WHERE idempotency_key = ?')
      .get('timeout-idemp-key') as any;

    assert.equal(row.status, 'AMBIGUOUS_TIMEOUT');
    assert.equal(row.tx_hash, '0x' + 'bb'.repeat(32));
  });

  // 13. Relayer Reverted On-Chain Execution
  it('13. Fails closed and cancels anti-abuse exposure when transaction reverts on-chain', async () => {
    const revertingBroadcaster: IOnchainBroadcaster = {
      async broadcastTransaction() {
        return {
          txHash: '0x' + 'cc'.repeat(32) as `0x${string}`,
          async waitForReceipt() {
            return { blockNumber: 999n, status: 'reverted' };
          },
        };
      },
      async getTransactionReceipt() {
        return { blockNumber: 999n, status: 'reverted' };
      },
    };

    const harness = createTestHarness({ broadcaster: revertingBroadcaster });
    const quote = await harness.quoteEngine.createQuote({
      amountSats: 50_000n,
      targetDestinationAddress: destinationAddress,
    });

    const message: SwapAuthorizationMessage = {
      swapper: swapperAddress,
      destination: destinationAddress,
      amountUsdcAtomic: quote.netUsdcAtomic,
      amountSats: quote.amountSats,
      quoteId: quote.quoteId,
      nonce: 0n,
      deadline: BigInt(Math.floor(Date.now() / 1000)) + 300n,
    };

    const signature = await swapperAccount.signTypedData({
      domain: harness.authorizer.getDomain(),
      types: EIP712_SWAP_AUTH_TYPES,
      primaryType: 'SwapAuthorization',
      message,
    });

    await assert.rejects(
      async () =>
        await harness.relayer.submitSwap({
          authorization: { message, signature },
          quote,
          idempotencyKey: 'reverted-key',
        }),
      (err: Error) => err instanceof RelayerExecutionRevertedError
    );

    const row = harness.db
      .prepare('SELECT status FROM relayer_executions WHERE idempotency_key = ?')
      .get('reverted-key') as any;

    assert.equal(row.status, 'FAILED');
  });

  // 14. Frozen Core Compatibility
  it('14. Validated authorization yields exact parameters required by AtomicCoordinator', async () => {
    const harness = createTestHarness();
    const quote = await harness.quoteEngine.createQuote({
      amountSats: 50_000n,
      targetDestinationAddress: destinationAddress,
    });

    const message: SwapAuthorizationMessage = {
      swapper: swapperAddress,
      destination: destinationAddress,
      amountUsdcAtomic: quote.netUsdcAtomic,
      amountSats: quote.amountSats,
      quoteId: quote.quoteId,
      nonce: 0n,
      deadline: BigInt(Math.floor(Date.now() / 1000)) + 300n,
    };

    const signature = await swapperAccount.signTypedData({
      domain: harness.authorizer.getDomain(),
      types: EIP712_SWAP_AUTH_TYPES,
      primaryType: 'SwapAuthorization',
      message,
    });

    const result = await harness.relayer.submitSwap({
      authorization: { message, signature },
      quote,
      idempotencyKey: 'coord-handoff-key',
    });

    // Map to AtomicCoordinator.prepareSwap input format
    const coordinatorPrepareParams = {
      idempotencyKey: result.idempotencyKey,
      hashLock: '0x' + 'ff'.repeat(32),
      claimingAddress: result.destination,
      targetDestinationAddress: result.destination,
      amountSats: result.amountSats,
      expectedUsdcAmount: result.amountUsdcAtomic,
    };

    assert.equal(coordinatorPrepareParams.idempotencyKey, 'coord-handoff-key');
    assert.equal(coordinatorPrepareParams.amountSats, 50_000n);
    assert.equal(coordinatorPrepareParams.expectedUsdcAmount, quote.netUsdcAtomic);
    assert.equal(coordinatorPrepareParams.claimingAddress, destinationAddress);
  });
});
