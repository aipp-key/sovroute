/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Pricing & Quote Engine Test Suite (11 Test Cases)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  QuoteEngine,
  PriceAggregator,
  MockPriceFeed,
  InsufficientPriceFeedsError,
  CrossFeedDispersionTooHighError,
  SwapAmountOutOfBoundsError,
  QuoteOutputTooLowError,
  QuoteExpiredError,
} from '../src/pricing/index.ts';

describe('PRICING & QUOTE ENGINE SUITE (11 TESTS)', () => {
  // Test 1: Multi-source price aggregation & median calculation
  it('1. Computes exact median across odd and even numbers of valid feeds', async () => {
    const feed1 = new MockPriceFeed({ name: 'feed-1', priceMicroUsd: 100_000_000_000n }); // $100,000
    const feed2 = new MockPriceFeed({ name: 'feed-2', priceMicroUsd: 100_500_000_000n }); // $100,500
    const feed3 = new MockPriceFeed({ name: 'feed-3', priceMicroUsd: 100_200_000_000n }); // $100,200

    // Odd feeds: median should be feed3 ($100,200)
    const aggregatorOdd = new PriceAggregator([feed1, feed2, feed3]);
    const resOdd = await aggregatorOdd.getAuthoritativePrice();
    assert.equal(resOdd.referencePriceMicroUsd, 100_200_000_000n);
    assert.equal(resOdd.activeSamples.length, 3);

    // Even feeds: median should be average of $100,000 and $100,200 = $100,100
    const aggregatorEven = new PriceAggregator([feed1, feed3]);
    const resEven = await aggregatorEven.getAuthoritativePrice();
    assert.equal(resEven.referencePriceMicroUsd, 100_100_000_000n);
  });

  // Test 2: Stale price rejection
  it('2. Rejects stale price feeds older than maxStalePriceMs fail-closed', async () => {
    const freshFeed = new MockPriceFeed({ name: 'fresh', priceMicroUsd: 100_000_000_000n, timestampOffsetMs: 0 });
    // Stale feed: 35 seconds old (max is 30 seconds)
    const staleFeed = new MockPriceFeed({ name: 'stale', priceMicroUsd: 100_000_000_000n, timestampOffsetMs: -35_000 });

    const aggregator = new PriceAggregator([freshFeed, staleFeed], {
      minFeedsRequired: 2,
      maxStalePriceMs: 30_000,
    });

    await assert.rejects(
      async () => await aggregator.getAuthoritativePrice(),
      (err: Error) => err instanceof InsufficientPriceFeedsError
    );
  });

  // Test 3: Insufficient feeds rejection
  it('3. Fails closed when fewer than minFeedsRequired feeds are operational', async () => {
    const liveFeed = new MockPriceFeed({ name: 'live', priceMicroUsd: 100_000_000_000n });
    const failingFeed = new MockPriceFeed({ name: 'failing', shouldFail: true });

    const aggregator = new PriceAggregator([liveFeed, failingFeed], { minFeedsRequired: 2 });

    await assert.rejects(
      async () => await aggregator.getAuthoritativePrice(),
      (err: Error) => err instanceof InsufficientPriceFeedsError
    );
  });

  // Test 4: Cross-feed dispersion guard
  it('4. Rejects pricing when cross-feed spread exceeds maxCrossFeedDispersionBps', async () => {
    // $100,000 vs $102,000 is a 2.0% (200 bps) difference; max allowed is 1.5% (150 bps)
    const feed1 = new MockPriceFeed({ name: 'feed-1', priceMicroUsd: 100_000_000_000n });
    const feed2 = new MockPriceFeed({ name: 'feed-2', priceMicroUsd: 102_000_000_000n });

    const aggregator = new PriceAggregator([feed1, feed2], {
      minFeedsRequired: 2,
      maxCrossFeedDispersionBps: 150n,
    });

    await assert.rejects(
      async () => await aggregator.getAuthoritativePrice(),
      (err: Error) => err instanceof CrossFeedDispersionTooHighError
    );
  });

  // Test 5: Exact atomic unit math
  it('5. Computes exact atomic units with zero floating-point error', async () => {
    // 50,000 sats at $100,000.00/BTC
    // Gross = 50,000 * 100,000.00 / 100,000,000 = $50.000000 = 50_000_000 micro-units
    // Spread 50 bps (0.5%) = 50_000_000 * 50 / 10,000 = 250_000 atomic units ($0.25)
    // Fixed fee = 250_000 atomic units ($0.25)
    // Net = 50_000_000 - 250_000 - 250_000 = 49_500_000 atomic units ($49.50)
    const feed1 = new MockPriceFeed({ name: 'feed-1', priceMicroUsd: 100_000_000_000n });
    const feed2 = new MockPriceFeed({ name: 'feed-2', priceMicroUsd: 100_000_000_000n });
    const aggregator = new PriceAggregator([feed1, feed2]);

    const engine = new QuoteEngine(aggregator, {
      spreadBps: 50n,
      fixedFeeUsdcAtomic: 250_000n,
    });

    const quote = await engine.createQuote({ amountSats: 50_000n });

    assert.equal(quote.amountSats, 50_000n);
    assert.equal(quote.grossUsdcAtomic, 50_000_000n);
    assert.equal(quote.spreadAmountAtomic, 250_000n);
    assert.equal(quote.fixedFeeAtomic, 250_000n);
    assert.equal(quote.netUsdcAtomic, 49_500_000n);
    assert.equal(quote.effectiveRate, '99000.000000');
  });

  // Test 6: Enforces minimum swap sats boundary
  it('6. Rejects swap requests below minSwapSats', async () => {
    const feed1 = new MockPriceFeed({ name: 'feed-1', priceMicroUsd: 100_000_000_000n });
    const feed2 = new MockPriceFeed({ name: 'feed-2', priceMicroUsd: 100_000_000_000n });
    const aggregator = new PriceAggregator([feed1, feed2]);
    const engine = new QuoteEngine(aggregator, { minSwapSats: 5_000n });

    await assert.rejects(
      async () => await engine.createQuote({ amountSats: 4_999n }),
      (err: Error) => err instanceof SwapAmountOutOfBoundsError
    );
  });

  // Test 7: Enforces maximum swap beta limit
  it('7. Rejects swap requests exceeding maxSwapUsdcAtomic', async () => {
    // 500,000 sats at $100,000 = ~$500 gross, exceeds max beta limit of 250 USDC
    const feed1 = new MockPriceFeed({ name: 'feed-1', priceMicroUsd: 100_000_000_000n });
    const feed2 = new MockPriceFeed({ name: 'feed-2', priceMicroUsd: 100_000_000_000n });
    const aggregator = new PriceAggregator([feed1, feed2]);
    const engine = new QuoteEngine(aggregator, { maxSwapUsdcAtomic: 250_000_000n });

    await assert.rejects(
      async () => await engine.createQuote({ amountSats: 500_000n }),
      (err: Error) => err instanceof SwapAmountOutOfBoundsError
    );
  });

  // Test 8: Rejects quotes where fees exceed gross output
  it('8. Throws QuoteOutputTooLowError when gross amount cannot cover fees', async () => {
    const feed1 = new MockPriceFeed({ name: 'feed-1', priceMicroUsd: 10_000_000_000n }); // $10,000 BTC
    const feed2 = new MockPriceFeed({ name: 'feed-2', priceMicroUsd: 10_000_000_000n });
    const aggregator = new PriceAggregator([feed1, feed2]);

    // 1,000 sats at $10,000 = $0.10 gross. Fixed fee is $0.25 -> fees exceed gross
    const engine = new QuoteEngine(aggregator, {
      minSwapSats: 1_000n,
      fixedFeeUsdcAtomic: 250_000n,
    });

    await assert.rejects(
      async () => await engine.createQuote({ amountSats: 1_000n }),
      (err: Error) => err instanceof QuoteOutputTooLowError
    );
  });

  // Test 9: Quote expiry validation
  it('9. Rejects expired quotes after validityMs window', async () => {
    const feed1 = new MockPriceFeed({ name: 'feed-1', priceMicroUsd: 100_000_000_000n });
    const feed2 = new MockPriceFeed({ name: 'feed-2', priceMicroUsd: 100_000_000_000n });
    const aggregator = new PriceAggregator([feed1, feed2]);
    const engine = new QuoteEngine(aggregator, { validityMs: 20_000 });

    const baseTime = Date.now();
    const quote = await engine.createQuote({ amountSats: 50_000n, nowMs: baseTime });

    // 10s later -> still valid
    const resValid = engine.verifyQuote(quote, undefined, baseTime + 10_000);
    assert.equal(resValid.valid, true);

    // 21s later -> expired
    const resExpired = engine.verifyQuote(quote, undefined, baseTime + 21_000);
    assert.equal(resExpired.valid, false);
    assert.match(resExpired.reason!, /QUOTE_EXPIRED/);

    assert.throws(
      () => engine.verifyOrReject(quote, undefined, baseTime + 21_000),
      (err: Error) => err instanceof QuoteExpiredError
    );
  });

  // Test 10: HMAC cryptographic tamper protection
  it('10. Detects any tampering with quote fields or destination address', async () => {
    const feed1 = new MockPriceFeed({ name: 'feed-1', priceMicroUsd: 100_000_000_000n });
    const feed2 = new MockPriceFeed({ name: 'feed-2', priceMicroUsd: 100_000_000_000n });
    const aggregator = new PriceAggregator([feed1, feed2]);
    const engine = new QuoteEngine(aggregator, { hmacSecret: 'secret_key_123' });

    const baseTime = Date.now();
    const quote = await engine.createQuote({
      amountSats: 50_000n,
      targetDestinationAddress: '0x1111111111111111111111111111111111111111',
      nowMs: baseTime,
    });

    // Valid unmodified quote verifies successfully
    assert.equal(engine.verifyQuote(quote, undefined, baseTime + 5_000).valid, true);

    // Tampering 1: Client fraudulently inflates netUsdcAtomic
    const tamperedUsdc = { ...quote, netUsdcAtomic: quote.netUsdcAtomic + 1_000_000n };
    assert.equal(engine.verifyQuote(tamperedUsdc, undefined, baseTime + 5_000).valid, false);

    // Tampering 2: Client reduces amountSats
    const tamperedSats = { ...quote, amountSats: quote.amountSats - 1_000n };
    assert.equal(engine.verifyQuote(tamperedSats, undefined, baseTime + 5_000).valid, false);

    // Tampering 3: Client changes destination address
    const tamperedAddress = { ...quote, targetDestinationAddress: '0x9999999999999999999999999999999999999999' };
    assert.equal(engine.verifyQuote(tamperedAddress, undefined, baseTime + 5_000).valid, false);

    // Tampering 4: Different HMAC secret fails verification
    const differentSecretEngine = new QuoteEngine(aggregator, { hmacSecret: 'wrong_secret_456' });
    assert.equal(differentSecretEngine.verifyQuote(quote, undefined, baseTime + 5_000).valid, false);
  });

  // Test 11: Seamless handoff to Sovereign Atomic Coordinator format
  it('11. Generates exact parameters required by AtomicCoordinator.prepareSwap', async () => {
    const feed1 = new MockPriceFeed({ name: 'feed-1', priceMicroUsd: 100_000_000_000n });
    const feed2 = new MockPriceFeed({ name: 'feed-2', priceMicroUsd: 100_000_000_000n });
    const aggregator = new PriceAggregator([feed1, feed2]);
    const engine = new QuoteEngine(aggregator);

    const quote = await engine.createQuote({
      amountSats: 25_000n,
      targetDestinationAddress: '0x3333333333333333333333333333333333333333',
    });

    // Verification before coordinator execution
    const verified = engine.verifyOrReject(quote);

    // Parameters ready for AtomicCoordinator.prepareSwap
    const swapParams = {
      idempotencyKey: `swap_${verified.quoteId}`,
      hashLock: '0x' + 'aa'.repeat(32),
      claimingAddress: '0x2222222222222222222222222222222222222222',
      targetDestinationAddress: verified.targetDestinationAddress!,
      amountSats: verified.amountSats,
      expectedUsdcAmount: verified.netUsdcAtomic,
    };

    assert.equal(typeof swapParams.idempotencyKey, 'string');
    assert.equal(typeof swapParams.amountSats, 'bigint');
    assert.equal(typeof swapParams.expectedUsdcAmount, 'bigint');
    assert.equal(swapParams.amountSats, 25_000n);
    assert.ok(swapParams.expectedUsdcAmount > 0n);
  });
});
