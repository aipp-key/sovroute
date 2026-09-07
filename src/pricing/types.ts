/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Pricing & Quote Engine Type Definitions
 *
 * Enforces integer-safe atomic units (satoshis for BTC, 6-decimal micro-units for Base USDC),
 * multi-source price samples, policy boundaries, and cryptographic HMAC quote binding.
 */

export interface PriceFeedSample {
  provider: string;
  /**
   * Price in micro-USD per BTC (1 USD = 1,000,000 micro-USD).
   * For example, $98,500.25 is stored as 98_500_250_000n.
   * This guarantees zero floating-point rounding errors.
   */
  priceMicroUsd: bigint;
  timestampMs: number;
}

export interface IPriceFeedProvider {
  readonly name: string;
  fetchPrice(): Promise<PriceFeedSample>;
}

export interface QuotePolicyConfig {
  /** Quote validity window in milliseconds (default: 20_000 = 20s) */
  validityMs: number;
  /** Max acceptable age of a price feed sample in ms (default: 30_000 = 30s) */
  maxStalePriceMs: number;
  /** Maximum spread between highest and lowest feed in basis points (default: 150 = 1.5%) */
  maxCrossFeedDispersionBps: bigint;
  /** Minimum number of valid, non-stale feeds required to form reference price (default: 2) */
  minFeedsRequired: number;
  /** Spread fee deducted from gross output in basis points (default: 50n = 0.50%) */
  spreadBps: bigint;
  /** Fixed overhead fee in Base USDC atomic units (default: 250_000n = 0.25 USDC) */
  fixedFeeUsdcAtomic: bigint;
  /** Minimum allowable swap amount in satoshis (default: 5_000n sats) */
  minSwapSats: bigint;
  /** Maximum allowable swap amount in Base USDC atomic units (default: 250_000_000n = 250 USDC) */
  maxSwapUsdcAtomic: bigint;
  /** Secret key used to sign quotes with HMAC-SHA256 preventing tampering */
  hmacSecret: string;
}

export interface SovereignQuote {
  quoteId: string;
  pair: 'BTC_LIGHTNING_TO_BASE_USDC';
  amountSats: bigint;
  /** Reference BTC spot price in micro-USD per BTC (1e6) */
  referencePriceMicroUsd: bigint;
  /** Gross USDC value before fees (6 decimals) */
  grossUsdcAtomic: bigint;
  /** Spread amount deducted (6 decimals) */
  spreadAmountAtomic: bigint;
  /** Fixed fee deducted (6 decimals) */
  fixedFeeAtomic: bigint;
  /** Exact net Base USDC customer receives (6 decimals) */
  netUsdcAtomic: bigint;
  /** Human-readable effective rate (USDC per BTC) */
  effectiveRate: string;
  /** Active feeds used in median calculation */
  activeFeedCount: number;
  createdAt: number;
  expiresAt: number;
  targetDestinationAddress?: string | undefined;
  /** HMAC-SHA256 signature binding all critical quote fields */
  quoteSignature: string;
}

export interface QuoteVerificationResult {
  valid: boolean;
  reason?: string;
  quote?: SovereignQuote;
}
