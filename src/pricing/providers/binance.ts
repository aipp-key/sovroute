/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Binance BTCUSDT Spot Price Feed Provider
 */

import { BasePriceFeedProvider } from './base-provider.ts';
import type { PriceFeedSample } from '../types.ts';

export class BinancePriceFeed extends BasePriceFeedProvider {
  public readonly name = 'binance';
  private readonly endpoint: string;

  constructor(endpoint = 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT') {
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
        throw new Error(`HTTP_${res.status}: Binance API responded with status ${res.status}`);
      }

      const json = (await res.json()) as { price?: string };
      if (!json.price) {
        throw new Error(`INVALID_PAYLOAD: Binance response missing price field`);
      }

      return {
        provider: this.name,
        priceMicroUsd: BasePriceFeedProvider.parseDecimalToMicroUsd(json.price),
        timestampMs: Date.now(),
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
