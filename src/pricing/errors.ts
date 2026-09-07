/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Pricing & Quote Engine Error Definitions
 */

export class InsufficientPriceFeedsError extends Error {
  constructor(activeFeeds: number, minRequired: number) {
    super(
      `INSUFFICIENT_PRICE_FEEDS: Only ${activeFeeds} non-stale feed(s) available; minimum required is ${minRequired}. Refusing to quote.`
    );
    this.name = 'InsufficientPriceFeedsError';
  }
}

export class StalePriceFeedError extends Error {
  constructor(provider: string, ageMs: number, maxStaleMs: number) {
    super(
      `STALE_PRICE_FEED: Feed '${provider}' sample age ${ageMs}ms exceeds max allowed age ${maxStaleMs}ms.`
    );
    this.name = 'StalePriceFeedError';
  }
}

export class CrossFeedDispersionTooHighError extends Error {
  constructor(dispersionBps: bigint, maxAllowedBps: bigint, minPrice: bigint, maxPrice: bigint) {
    super(
      `CROSS_FEED_DISPERSION_TOO_HIGH: Spread between feeds is ${dispersionBps} bps (exceeds max ${maxAllowedBps} bps). Min: ${minPrice}, Max: ${maxPrice}. Potential market anomaly/flash crash.`
    );
    this.name = 'CrossFeedDispersionTooHighError';
  }
}

export class SwapAmountOutOfBoundsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SwapAmountOutOfBoundsError';
  }
}

export class QuoteOutputTooLowError extends Error {
  constructor(grossAtomic: bigint, feesAtomic: bigint) {
    super(
      `QUOTE_OUTPUT_TOO_LOW: Gross output ${grossAtomic} is less than or equal to fees ${feesAtomic}. Net USDC would be zero or negative.`
    );
    this.name = 'QuoteOutputTooLowError';
  }
}

export class QuoteExpiredError extends Error {
  constructor(quoteId: string, expiresAt: number, nowMs: number) {
    super(
      `QUOTE_EXPIRED: Quote '${quoteId}' expired at ${new Date(expiresAt).toISOString()} (current time: ${new Date(nowMs).toISOString()}).`
    );
    this.name = 'QuoteExpiredError';
  }
}

export class QuoteTamperedError extends Error {
  constructor(quoteId: string, details: string) {
    super(`QUOTE_TAMPERED: Cryptographic signature mismatch for quote '${quoteId}'. Details: ${details}`);
    this.name = 'QuoteTamperedError';
  }
}
