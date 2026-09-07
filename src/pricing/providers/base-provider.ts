/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Base Price Feed Provider Helper
 */

import type { PriceFeedSample, IPriceFeedProvider } from '../types.ts';

export abstract class BasePriceFeedProvider implements IPriceFeedProvider {
  public abstract readonly name: string;
  public abstract fetchPrice(): Promise<PriceFeedSample>;

  /**
   * Safely converts a decimal USD string into micro-USD BigInt (6 decimals)
   * Example: "98500.25" -> 98_500_250_000n
   * Completely eliminates IEEE 754 floating point precision loss.
   */
  public static parseDecimalToMicroUsd(priceStr: string): bigint {
    const trimmed = priceStr.trim();
    if (!/^\d+(\.\d+)?$/.test(trimmed)) {
      throw new Error(`INVALID_PRICE_FORMAT: Cannot parse price '${priceStr}'`);
    }

    const [integerPart, fractionalPart = ''] = trimmed.split('.');
    const paddedFraction = (fractionalPart + '000000').slice(0, 6);
    return BigInt(integerPart) * 1_000_000n + BigInt(paddedFraction);
  }
}
