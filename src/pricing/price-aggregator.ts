/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Multi-Source Price Aggregator & Outlier Detection
 */

import type { IPriceFeedProvider, PriceFeedSample } from './types.ts';
import {
  InsufficientPriceFeedsError,
  CrossFeedDispersionTooHighError,
} from './errors.ts';

export interface PriceAggregatorConfig {
  maxStalePriceMs?: number;
  minFeedsRequired?: number;
  maxCrossFeedDispersionBps?: bigint;
}

export class PriceAggregator {
  private readonly providers: IPriceFeedProvider[];
  private readonly maxStalePriceMs: number;
  private readonly minFeedsRequired: number;
  private readonly maxCrossFeedDispersionBps: bigint;

  constructor(providers: IPriceFeedProvider[], config: PriceAggregatorConfig = {}) {
    if (!providers || providers.length === 0) {
      throw new Error('PRICE_AGGREGATOR_INIT: At least one price feed provider must be provided.');
    }
    this.providers = providers;
    this.maxStalePriceMs = config.maxStalePriceMs ?? 30_000;
    this.minFeedsRequired = config.minFeedsRequired ?? 2;
    this.maxCrossFeedDispersionBps = config.maxCrossFeedDispersionBps ?? 150n; // 1.50%
  }

  public async getAuthoritativePrice(nowMs = Date.now()): Promise<{
    referencePriceMicroUsd: bigint;
    activeSamples: PriceFeedSample[];
  }> {
    const results = await Promise.allSettled(this.providers.map((p) => p.fetchPrice()));

    const validSamples: PriceFeedSample[] = [];

    for (const res of results) {
      if (res.status === 'fulfilled') {
        const sample = res.value;
        const ageMs = nowMs - sample.timestampMs;

        // Reject stale prices or timestamps from far in the future (>5s clock skew)
        if (ageMs <= this.maxStalePriceMs && ageMs >= -5_000) {
          validSamples.push(sample);
        }
      }
    }

    if (validSamples.length < this.minFeedsRequired) {
      throw new InsufficientPriceFeedsError(validSamples.length, this.minFeedsRequired);
    }

    // Sort prices ascending for dispersion check and median computation
    validSamples.sort((a, b) => (a.priceMicroUsd < b.priceMicroUsd ? -1 : a.priceMicroUsd > b.priceMicroUsd ? 1 : 0));

    const minPrice = validSamples[0].priceMicroUsd;
    const maxPrice = validSamples[validSamples.length - 1].priceMicroUsd;

    if (minPrice <= 0n) {
      throw new Error(`INVALID_PRICE_VALUE: Non-positive price sample detected: ${minPrice}`);
    }

    // Cross-feed dispersion check: (max - min) / min * 10,000 bps
    const dispersionBps = ((maxPrice - minPrice) * 10_000n) / minPrice;
    if (dispersionBps > this.maxCrossFeedDispersionBps) {
      throw new CrossFeedDispersionTooHighError(
        dispersionBps,
        this.maxCrossFeedDispersionBps,
        minPrice,
        maxPrice
      );
    }

    // Compute median price
    const mid = Math.floor(validSamples.length / 2);
    let medianPrice: bigint;
    if (validSamples.length % 2 === 1) {
      medianPrice = validSamples[mid].priceMicroUsd;
    } else {
      medianPrice = (validSamples[mid - 1].priceMicroUsd + validSamples[mid].priceMicroUsd) / 2n;
    }

    return {
      referencePriceMicroUsd: medianPrice,
      activeSamples: validSamples,
    };
  }
}
