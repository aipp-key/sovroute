/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Coinbase BTC-USD Spot Price Feed Provider
 */

import { BasePriceFeedProvider } from './base-provider.ts';
import type { PriceFeedSample } from '../types.ts';

export class CoinbasePriceFeed extends BasePriceFeedProvider {
  public readonly name = 'coinbase';
  private readonly endpoint: string;

  constructor(endpoint = 'https://api.coinbase.com/v2/prices/BTC-USD/spot') {
    super();
    this.endpoint = endpoint;
  }

  public async fetchPrice(): Promise<PriceFeedSample> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2500);

    try {
      const res = await fetch(this.endpoint, {
        signal: controller.signal,
        headers: { Accept: 'application/json', 'User-Agent': 'SovRoute-QuoteEngine/1.0' },
      });

      if (!res.ok) {
        throw new Error(`HTTP_${res.status}: Coinbase API responded with status ${res.status}`);
      }

      const json = (await res.json()) as { data?: { amount?: string } };
      if (!json.data?.amount) {
        throw new Error(`INVALID_PAYLOAD: Coinbase response missing data.amount`);
      }

      return {
        provider: this.name,
        priceMicroUsd: BasePriceFeedProvider.parseDecimalToMicroUsd(json.data.amount),
        timestampMs: Date.now(),
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
