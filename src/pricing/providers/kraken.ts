/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Kraken XBTUSD Spot Price Feed Provider
 */

import { BasePriceFeedProvider } from './base-provider.ts';
import type { PriceFeedSample } from '../types.ts';

export class KrakenPriceFeed extends BasePriceFeedProvider {
  public readonly name = 'kraken';
  private readonly endpoint: string;

  constructor(endpoint = 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD') {
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
        throw new Error(`HTTP_${res.status}: Kraken API responded with status ${res.status}`);
      }

      const json = (await res.json()) as {
        result?: Record<string, { c?: string[] }>;
        error?: string[];
      };

      if (json.error && json.error.length > 0) {
        throw new Error(`KRAKEN_ERROR: ${json.error.join(', ')}`);
      }

      // Kraken returns either XXBTZUSD or XBTUSD
      const ticker = json.result?.XXBTZUSD || json.result?.XBTUSD;
      const lastPrice = ticker?.c?.[0];
      if (!lastPrice) {
        throw new Error(`INVALID_PAYLOAD: Kraken response missing result ticker last price`);
      }

      return {
        provider: this.name,
        priceMicroUsd: BasePriceFeedProvider.parseDecimalToMicroUsd(lastPrice),
        timestampMs: Date.now(),
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
