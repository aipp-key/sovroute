/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Sovereign Quote Engine & FX Risk Processor
 *
 * Implements deterministic integer-safe pricing between Lightning BTC and Base USDC,
 * enforcing spread policies, short-term expiry, and cryptographic HMAC tamper binding.
 */

import { randomBytes, createHmac } from 'node:crypto';
import type {
  QuotePolicyConfig,
  SovereignQuote,
  QuoteVerificationResult,
} from './types.ts';
import { PriceAggregator } from './price-aggregator.ts';
import {
  SwapAmountOutOfBoundsError,
  QuoteOutputTooLowError,
  QuoteExpiredError,
  QuoteTamperedError,
} from './errors.ts';

export const DEFAULT_QUOTE_POLICY: QuotePolicyConfig = {
  validityMs: 20_000,              // 20 seconds short expiry
  maxStalePriceMs: 30_000,         // 30 seconds max price age
  maxCrossFeedDispersionBps: 150n, // 1.50% max spread across feeds
  minFeedsRequired: 2,             // at least 2 feeds required
  spreadBps: 50n,                  // 0.50% spread fee
  fixedFeeUsdcAtomic: 250_000n,    // 0.25 USDC fixed overhead
  minSwapSats: 5_000n,             // 5,000 sats (~$5 at $100k)
  maxSwapUsdcAtomic: 250_000_000n, // 250 USDC max for public beta
  hmacSecret: 'sovroute_default_local_quote_secret_change_in_prod',
};

export class QuoteEngine {
  private readonly aggregator: PriceAggregator;
  private readonly policy: QuotePolicyConfig;

  constructor(aggregator: PriceAggregator, policy: Partial<QuotePolicyConfig> = {}) {
    this.aggregator = aggregator;
    this.policy = { ...DEFAULT_QUOTE_POLICY, ...policy };
  }

  public getAggregator(): PriceAggregator {
    return this.aggregator;
  }

  /**
   * Creates an authoritative, signed quote for a given satoshi input.
   */
  public async createQuote(params: {
    amountSats: bigint;
    targetDestinationAddress?: string;
    nowMs?: number;
  }): Promise<SovereignQuote> {
    const { amountSats, targetDestinationAddress, nowMs = Date.now() } = params;

    if (amountSats < this.policy.minSwapSats) {
      throw new SwapAmountOutOfBoundsError(
        `SWAP_AMOUNT_TOO_LOW: Input ${amountSats} sats is below minimum allowable ${this.policy.minSwapSats} sats.`
      );
    }

    const { referencePriceMicroUsd, activeSamples } = await this.aggregator.getAuthoritativePrice(nowMs);

    // 1 BTC = 100_000_000 sats.
    // referencePriceMicroUsd is in 1e6 (micro-USD per BTC).
    // Gross USDC (6 decimals) = (amountSats * referencePriceMicroUsd) / 100_000_000n
    const grossUsdcAtomic = (amountSats * referencePriceMicroUsd) / 100_000_000n;

    // Spread deduction (in basis points, 1 bps = 0.01% = 1/10000)
    const spreadAmountAtomic = (grossUsdcAtomic * this.policy.spreadBps) / 10_000n;
    const fixedFeeAtomic = this.policy.fixedFeeUsdcAtomic;
    const totalDeductionsAtomic = spreadAmountAtomic + fixedFeeAtomic;

    if (grossUsdcAtomic <= totalDeductionsAtomic) {
      throw new QuoteOutputTooLowError(grossUsdcAtomic, totalDeductionsAtomic);
    }

    const netUsdcAtomic = grossUsdcAtomic - totalDeductionsAtomic;

    if (netUsdcAtomic > this.policy.maxSwapUsdcAtomic) {
      throw new SwapAmountOutOfBoundsError(
        `SWAP_AMOUNT_TOO_HIGH: Net output ${netUsdcAtomic} atomic USDC exceeds beta limit ${this.policy.maxSwapUsdcAtomic} (250 USDC).`
      );
    }

    // Effective rate = netUsdcAtomic / (amountSats in BTC)
    const effectiveRateScaled = (netUsdcAtomic * 100_000_000n) / amountSats;
    const effectiveRateInteger = effectiveRateScaled / 1_000_000n;
    const effectiveRateFraction = (effectiveRateScaled % 1_000_000n).toString().padStart(6, '0');
    const effectiveRate = `${effectiveRateInteger}.${effectiveRateFraction}`;

    const quoteId = `quote_${nowMs}_${randomBytes(8).toString('hex')}`;
    const expiresAt = nowMs + this.policy.validityMs;

    const signature = this.computeQuoteSignature({
      quoteId,
      amountSats,
      netUsdcAtomic,
      expiresAt,
      targetDestinationAddress,
    });

    return {
      quoteId,
      pair: 'BTC_LIGHTNING_TO_BASE_USDC',
      amountSats,
      referencePriceMicroUsd,
      grossUsdcAtomic,
      spreadAmountAtomic,
      fixedFeeAtomic,
      netUsdcAtomic,
      effectiveRate,
      activeFeedCount: activeSamples.length,
      createdAt: nowMs,
      expiresAt,
      targetDestinationAddress,
      quoteSignature: signature,
    };
  }

  /**
   * Cryptographically validates a quote against tampering and expiration.
   */
  public verifyQuote(
    quote: SovereignQuote,
    targetDestinationAddress?: string,
    nowMs = Date.now()
  ): QuoteVerificationResult {
    // 1. Check expiration
    if (nowMs > quote.expiresAt) {
      return {
        valid: false,
        reason: `QUOTE_EXPIRED: Expired at ${new Date(quote.expiresAt).toISOString()} (now: ${new Date(nowMs).toISOString()})`,
      };
    }

    // 2. Validate destination address binding if provided
    const addressToVerify = targetDestinationAddress ?? quote.targetDestinationAddress;
    if (quote.targetDestinationAddress && addressToVerify !== quote.targetDestinationAddress) {
      return {
        valid: false,
        reason: `DESTINATION_ADDRESS_MISMATCH: Quote bound to '${quote.targetDestinationAddress}', but received '${addressToVerify}'`,
      };
    }

    // 3. Verify cryptographic HMAC signature
    const expectedSignature = this.computeQuoteSignature({
      quoteId: quote.quoteId,
      amountSats: quote.amountSats,
      netUsdcAtomic: quote.netUsdcAtomic,
      expiresAt: quote.expiresAt,
      targetDestinationAddress: addressToVerify,
    });

    if (quote.quoteSignature !== expectedSignature) {
      return {
        valid: false,
        reason: 'SIGNATURE_INVALID: Quote fields have been tampered with or HMAC secret mismatch.',
      };
    }

    return {
      valid: true,
      quote,
    };
  }

  /**
   * Helper that throws QuoteExpiredError or QuoteTamperedError fail-closed if invalid.
   */
  public verifyOrReject(
    quote: SovereignQuote,
    targetDestinationAddress?: string,
    nowMs = Date.now()
  ): SovereignQuote {
    const result = this.verifyQuote(quote, targetDestinationAddress, nowMs);
    if (!result.valid) {
      if (result.reason?.includes('QUOTE_EXPIRED')) {
        throw new QuoteExpiredError(quote.quoteId, quote.expiresAt, nowMs);
      }
      throw new QuoteTamperedError(quote.quoteId, result.reason ?? 'Unknown validation failure');
    }
    return quote;
  }

  private computeQuoteSignature(params: {
    quoteId: string;
    amountSats: bigint;
    netUsdcAtomic: bigint;
    expiresAt: number;
    targetDestinationAddress?: string | undefined;
  }): string {
    const payload = [
      params.quoteId,
      'BTC_LIGHTNING_TO_BASE_USDC',
      params.amountSats.toString(),
      params.netUsdcAtomic.toString(),
      params.expiresAt.toString(),
      params.targetDestinationAddress ?? '',
    ].join('|');

    return createHmac('sha256', this.policy.hmacSecret).update(payload).digest('hex');
  }
}
