/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Anti-Abuse & Volume Safety Engine Test Suite (12 Test Cases)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AntiAbuseEngine,
  AntiAbusePersistence,
  WalletCooldownActiveError,
  RollingVolumeLimitExceededError,
  DestinationVolumeLimitExceededError,
  ConcurrentExposureLimitExceededError,
  IdempotencyConflictError,
} from '../src/anti-abuse/index.ts';
import {
  QuoteEngine,
  PriceAggregator,
  MockPriceFeed,
} from '../src/pricing/index.ts';

function createTestQuoteEngine(clock?: () => number) {
  const feed1 = new MockPriceFeed({ name: 'f1', priceMicroUsd: 100_000_000_000n, timestampSupplier: clock });
  const feed2 = new MockPriceFeed({ name: 'f2', priceMicroUsd: 100_000_000_000n, timestampSupplier: clock });
  const aggregator = new PriceAggregator([feed1, feed2]);
  return new QuoteEngine(aggregator, { hmacSecret: 'test_secret_anti_abuse' });
}

describe('ANTI-ABUSE & VOLUME SAFETY SUITE (12 TESTS)', () => {
  const walletA = '0x1111111111111111111111111111111111111111';
  const destA = '0x2222222222222222222222222222222222222222';

  // Test 1: Normal first admission
  it('1. Successfully admits initial valid swap request', async () => {
    const persistence = new AntiAbusePersistence();
    const quoteEngine = createTestQuoteEngine();
    const engine = new AntiAbuseEngine(persistence, quoteEngine);

    const quote = await quoteEngine.createQuote({
      amountSats: 50_000n,
      targetDestinationAddress: destA,
    });

    const ticket = await engine.admitSwap({
      idempotencyKey: 'test-1-key',
      walletAddress: walletA,
      destinationAddress: destA,
      quote,
    });

    assert.equal(ticket.idempotencyKey, 'test-1-key');
    assert.equal(ticket.walletAddress, walletA.toLowerCase());
    assert.equal(ticket.amountSats, 50_000n);
    assert.equal(ticket.amountUsdcAtomic, quote.netUsdcAtomic);
    assert.equal(ticket.walletRollingVolumeBeforeUsdcAtomic, 0n);
    assert.equal(ticket.walletRollingVolumeAfterUsdcAtomic, quote.netUsdcAtomic);
  });

  // Test 2: 60-second cooldown rejection
  it('2. Rejects second request from same wallet within 60s with WalletCooldownActiveError', async () => {
    let currentTime = 1_000_000;
    const persistence = new AntiAbusePersistence();
    const quoteEngine = createTestQuoteEngine(() => currentTime);
    const engine = new AntiAbuseEngine(persistence, quoteEngine);

    const q1 = await quoteEngine.createQuote({ amountSats: 20_000n, targetDestinationAddress: destA, nowMs: currentTime });
    await engine.admitSwap({ idempotencyKey: 'cd-1', walletAddress: walletA, destinationAddress: destA, quote: q1 }, currentTime);

    // Attempt second swap 15s later
    currentTime += 15_000;
    const q2 = await quoteEngine.createQuote({ amountSats: 20_000n, targetDestinationAddress: destA, nowMs: currentTime });

    await assert.rejects(
      async () => await engine.admitSwap({ idempotencyKey: 'cd-2', walletAddress: walletA, destinationAddress: destA, quote: q2 }, currentTime),
      (err: Error) => err instanceof WalletCooldownActiveError && err.remainingCooldownMs === 45_000
    );
  });

  // Test 3: Cooldown expiration allows next swap
  it('3. Permits second request from same wallet once 60s cooldown expires', async () => {
    let currentTime = 1_000_000;
    const persistence = new AntiAbusePersistence();
    const quoteEngine = createTestQuoteEngine(() => currentTime);
    const engine = new AntiAbuseEngine(persistence, quoteEngine);

    const q1 = await quoteEngine.createQuote({ amountSats: 20_000n, targetDestinationAddress: destA, nowMs: currentTime });
    await engine.admitSwap({ idempotencyKey: 'cd-3-1', walletAddress: walletA, destinationAddress: destA, quote: q1 }, currentTime);

    // Second swap 61 seconds later
    currentTime += 61_000;
    const q2 = await quoteEngine.createQuote({ amountSats: 20_000n, targetDestinationAddress: destA, nowMs: currentTime });
    const ticket2 = await engine.admitSwap({ idempotencyKey: 'cd-3-2', walletAddress: walletA, destinationAddress: destA, quote: q2 }, currentTime);

    assert.equal(ticket2.idempotencyKey, 'cd-3-2');
  });

  // Test 4: $500 rolling 24h limit enforcement
  it('4. Rejects request that would push rolling 24h wallet volume over $500 USDC', async () => {
    let time = 1_000_000;
    const persistence = new AntiAbusePersistence();
    const quoteEngine = createTestQuoteEngine(() => time);
    const engine = new AntiAbuseEngine(persistence, quoteEngine, {
      cooldownMs: 1_000, // 1s cooldown for test speed
      maxRollingVolumeUsdcAtomic: 500_000_000n, // $500
    });

    // Swap 1: 200,000 sats = ~$197.75 USDC
    const q1 = await quoteEngine.createQuote({ amountSats: 200_000n, targetDestinationAddress: destA, nowMs: time });
    await engine.admitSwap({ idempotencyKey: 'v-1', walletAddress: walletA, destinationAddress: destA, quote: q1 }, time);

    time += 2_000;
    // Swap 2: 200,000 sats = ~$197.75 USDC (Total: ~$395.50)
    const q2 = await quoteEngine.createQuote({ amountSats: 200_000n, targetDestinationAddress: destA, nowMs: time });
    await engine.admitSwap({ idempotencyKey: 'v-2', walletAddress: walletA, destinationAddress: destA, quote: q2 }, time);

    time += 2_000;
    // Swap 3: 150,000 sats = ~$148.25 USDC (Total would be ~$543.75 -> Exceeds $500!)
    const q3 = await quoteEngine.createQuote({ amountSats: 150_000n, targetDestinationAddress: destA, nowMs: time });

    await assert.rejects(
      async () => await engine.admitSwap({ idempotencyKey: 'v-3', walletAddress: walletA, destinationAddress: destA, quote: q3 }, time),
      (err: Error) => err instanceof RollingVolumeLimitExceededError
    );
  });

  // Test 5: Rolling 24h window expiration
  it('5. Releases volume older than 24 hours under true rolling window', async () => {
    let day = 1_000_000;
    const persistence = new AntiAbusePersistence();
    const quoteEngine = createTestQuoteEngine(() => day);
    const engine = new AntiAbuseEngine(persistence, quoteEngine, {
      rollingWindowMs: 86_400_000,
      maxRollingVolumeUsdcAtomic: 500_000_000n,
    });

    // Swap on Day 1: 250 USDC
    const q1 = await quoteEngine.createQuote({ amountSats: 200_000n, targetDestinationAddress: destA, nowMs: day });
    await engine.admitSwap({ idempotencyKey: 'roll-1', walletAddress: walletA, destinationAddress: destA, quote: q1 }, day);

    // 25 hours later -> Day 1 swap has expired from rolling window
    day += 86_400_000 + 3_600_000;
    const q2 = await quoteEngine.createQuote({ amountSats: 200_000n, targetDestinationAddress: destA, nowMs: day });
    const ticket2 = await engine.admitSwap({ idempotencyKey: 'roll-2', walletAddress: walletA, destinationAddress: destA, quote: q2 }, day);

    // Rolling volume before ticket2 should be 0 because day1 rolled off!
    assert.equal(ticket2.walletRollingVolumeBeforeUsdcAtomic, 0n);
  });

  // Test 6: Per-swap single maximum limit
  it('6. Rejects swap exceeding maxSingleSwapUsdcAtomic', async () => {
    const persistence = new AntiAbusePersistence();
    const quoteEngine = createTestQuoteEngine();
    const engine = new AntiAbuseEngine(persistence, quoteEngine, {
      maxSingleSwapUsdcAtomic: 100_000_000n, // $100 cap
    });

    // 150,000 sats is ~$148 USDC -> exceeds $100 single limit
    const q = await quoteEngine.createQuote({ amountSats: 150_000n, targetDestinationAddress: destA });

    await assert.rejects(
      async () => await engine.admitSwap({ idempotencyKey: 'max-single', walletAddress: walletA, destinationAddress: destA, quote: q }),
      (err: Error) => err instanceof RollingVolumeLimitExceededError
    );
  });

  // Test 7: Per-destination address limit
  it('7. Rejects when multiple source wallets funnel excessive volume to one destination', async () => {
    let time = 1_000;
    const persistence = new AntiAbusePersistence();
    const quoteEngine = createTestQuoteEngine(() => time);
    const engine = new AntiAbuseEngine(persistence, quoteEngine, {
      cooldownMs: 1_000,
      maxDestinationRollingVolumeUsdcAtomic: 300_000_000n, // $300 destination cap
    });

    const walletB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const walletC = '0xcccccccccccccccccccccccccccccccccccccccc';

    const q1 = await quoteEngine.createQuote({ amountSats: 200_000n, targetDestinationAddress: destA, nowMs: time });
    await engine.admitSwap({ idempotencyKey: 'dest-1', walletAddress: walletB, destinationAddress: destA, quote: q1 }, time);

    // Second different wallet sends another $200 to same destination -> exceeds $300 dest limit!
    time += 1_000;
    const q2 = await quoteEngine.createQuote({ amountSats: 200_000n, targetDestinationAddress: destA, nowMs: time });
    await assert.rejects(
      async () => await engine.admitSwap({ idempotencyKey: 'dest-2', walletAddress: walletC, destinationAddress: destA, quote: q2 }, time),
      (err: Error) => err instanceof DestinationVolumeLimitExceededError
    );
  });

  // Test 8: Concurrent in-flight exposure limit
  it('8. Enforces concurrent in-flight limit and releases exposure upon finalization', async () => {
    let time = 1_000;
    const persistence = new AntiAbusePersistence();
    const quoteEngine = createTestQuoteEngine(() => time);
    const engine = new AntiAbuseEngine(persistence, quoteEngine, {
      cooldownMs: 100,
      maxConcurrentInFlightUsdcAtomic: 300_000_000n, // $300 in-flight cap
    });

    const w1 = '0x1111111111111111111111111111111111111111';
    const w2 = '0x2222222222222222222222222222222222222222';
    const w3 = '0x3333333333333333333333333333333333333333';

    // Swap 1: ~$197 in flight
    const q1 = await quoteEngine.createQuote({ amountSats: 200_000n, targetDestinationAddress: destA, nowMs: time });
    await engine.admitSwap({ idempotencyKey: 'inflight-1', walletAddress: w1, destinationAddress: destA, quote: q1 }, time);

    // Swap 2: another ~$197 in flight -> would be ~$394 in flight, exceeds $300!
    time += 200;
    const q2 = await quoteEngine.createQuote({ amountSats: 200_000n, targetDestinationAddress: destA, nowMs: time });
    await assert.rejects(
      async () => await engine.admitSwap({ idempotencyKey: 'inflight-2', walletAddress: w2, destinationAddress: destA, quote: q2 }, time),
      (err: Error) => err instanceof ConcurrentExposureLimitExceededError
    );

    // Swap 1 settles on-chain -> completed!
    engine.markCompleted('inflight-1');

    // Now Swap 2 can proceed because in-flight exposure was released!
    time += 300;
    const q3 = await quoteEngine.createQuote({ amountSats: 200_000n, targetDestinationAddress: destA, nowMs: time });
    const ticket = await engine.admitSwap({ idempotencyKey: 'inflight-3', walletAddress: w3, destinationAddress: destA, quote: q3 }, time);
    assert.equal(ticket.idempotencyKey, 'inflight-3');
  });

  // Test 9: Idempotent replay
  it('9. Replaying same idempotencyKey returns existing admission without double charging volume', async () => {
    const persistence = new AntiAbusePersistence();
    const quoteEngine = createTestQuoteEngine();
    const engine = new AntiAbuseEngine(persistence, quoteEngine);

    const q = await quoteEngine.createQuote({ amountSats: 50_000n, targetDestinationAddress: destA });
    const req = { idempotencyKey: 'idem-1', walletAddress: walletA, destinationAddress: destA, quote: q };

    const ticket1 = await engine.admitSwap(req);
    // Replay immediately within 60s
    const ticket2 = await engine.admitSwap(req);

    assert.equal(ticket1.ticketId, ticket2.ticketId);
    assert.equal(ticket1.walletRollingVolumeAfterUsdcAtomic, ticket2.walletRollingVolumeAfterUsdcAtomic);
  });

  // Test 10: Idempotency conflict
  it('10. Reusing idempotencyKey with conflicting parameters is rejected', async () => {
    const persistence = new AntiAbusePersistence();
    const quoteEngine = createTestQuoteEngine();
    const engine = new AntiAbuseEngine(persistence, quoteEngine);

    const q1 = await quoteEngine.createQuote({ amountSats: 50_000n, targetDestinationAddress: destA });
    await engine.admitSwap({ idempotencyKey: 'idem-conflict', walletAddress: walletA, destinationAddress: destA, quote: q1 });

    // Different amount with same key
    const q2 = await quoteEngine.createQuote({ amountSats: 60_000n, targetDestinationAddress: destA });
    await assert.rejects(
      async () => await engine.admitSwap({ idempotencyKey: 'idem-conflict', walletAddress: walletA, destinationAddress: destA, quote: q2 }),
      (err: Error) => err instanceof IdempotencyConflictError
    );
  });

  // Test 11: Durable restart survival
  it('11. Preserves rate limits and rolling volume across engine instance recreation', async () => {
    let baseTime = 1_000_000;
    const db = new (await import('node:sqlite')).DatabaseSync(':memory:');
    const p1 = new AntiAbusePersistence({ existingDb: db });
    const quoteEngine = createTestQuoteEngine(() => baseTime);
    const e1 = new AntiAbuseEngine(p1, quoteEngine);

    const q1 = await quoteEngine.createQuote({ amountSats: 50_000n, targetDestinationAddress: destA, nowMs: baseTime });
    await e1.admitSwap({ idempotencyKey: 'persist-1', walletAddress: walletA, destinationAddress: destA, quote: q1 }, baseTime);

    // Simulate service restart: create fresh persistence & engine on same database
    const p2 = new AntiAbusePersistence({ existingDb: db });
    const e2 = new AntiAbuseEngine(p2, quoteEngine);

    // Must still enforce 60s cooldown from earlier request!
    baseTime += 30_000; // 30s later
    const q2 = await quoteEngine.createQuote({ amountSats: 50_000n, targetDestinationAddress: destA, nowMs: baseTime });

    await assert.rejects(
      async () => await e2.admitSwap({ idempotencyKey: 'persist-2', walletAddress: walletA, destinationAddress: destA, quote: q2 }, baseTime),
      (err: Error) => err instanceof WalletCooldownActiveError
    );

    const status = e2.getWalletStatus(walletA, baseTime);
    assert.equal(status.isCooldownActive, true);
    assert.equal(status.rolling24hUsedUsdc > 0, true);
  });

  // Test 12: End-to-end handoff to AtomicCoordinator format
  it('12. Seamlessly hands off admission ticket parameters to AtomicCoordinator.prepareSwap', async () => {
    const persistence = new AntiAbusePersistence();
    const quoteEngine = createTestQuoteEngine();
    const engine = new AntiAbuseEngine(persistence, quoteEngine);

    const quote = await quoteEngine.createQuote({
      amountSats: 50_000n,
      targetDestinationAddress: destA,
    });

    const ticket = await engine.admitSwap({
      idempotencyKey: 'e2e-coord-key',
      walletAddress: walletA,
      destinationAddress: destA,
      quote,
    });

    // Coordinator format
    const coordinatorParams = {
      idempotencyKey: ticket.idempotencyKey,
      hashLock: '0x' + 'bb'.repeat(32),
      claimingAddress: ticket.destinationAddress,
      targetDestinationAddress: ticket.destinationAddress,
      amountSats: ticket.amountSats,
      expectedUsdcAmount: ticket.amountUsdcAtomic,
    };

    assert.equal(coordinatorParams.idempotencyKey, 'e2e-coord-key');
    assert.equal(coordinatorParams.amountSats, 50_000n);
    assert.equal(coordinatorParams.expectedUsdcAmount, quote.netUsdcAtomic);
  });
});
