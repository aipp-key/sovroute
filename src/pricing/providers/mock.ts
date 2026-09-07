/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Mock Controllable Price Feed Provider for Testing
 */

import { BasePriceFeedProvider } from './base-provider.ts';
import type { PriceFeedSample } from '../types.ts';

export interface MockPriceFeedOptions {
  name?: string;
  priceMicroUsd?: bigint;
  timestampOffsetMs?: number;
  timestampSupplier?: (() => number) | undefined;
  shouldFail?: boolean;
  failureError?: Error;
  delayMs?: number;
}

export class MockPriceFeed extends BasePriceFeedProvider {
  public readonly name: string;
  private priceMicroUsd: bigint;
  private timestampOffsetMs: number;
  private timestampSupplier?: (() => number) | undefined;
  private shouldFail: boolean;
  private failureError?: Error | undefined;
  private delayMs: number;

  constructor(options: MockPriceFeedOptions = {}) {
    super();
    this.name = options.name ?? 'mock-feed';
    this.priceMicroUsd = options.priceMicroUsd ?? 98_500_000_000n; // Default $98,500.00
    this.timestampOffsetMs = options.timestampOffsetMs ?? 0;
    this.timestampSupplier = options.timestampSupplier;
    this.shouldFail = options.shouldFail ?? false;
    this.failureError = options.failureError;
    this.delayMs = options.delayMs ?? 0;
  }

  public setPrice(priceMicroUsd: bigint): void {
    this.priceMicroUsd = priceMicroUsd;
  }

  public setTimestampOffsetMs(offsetMs: number): void {
    this.timestampOffsetMs = offsetMs;
  }

  public setTimestampSupplier(supplier?: (() => number) | undefined): void {
    this.timestampSupplier = supplier;
  }

  public setShouldFail(fail: boolean, error?: Error | undefined): void {
    this.shouldFail = fail;
    this.failureError = error;
  }

  public async fetchPrice(): Promise<PriceFeedSample> {
    if (this.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.delayMs));
    }

    if (this.shouldFail) {
      throw this.failureError ?? new Error(`MOCK_FEED_FAILURE: Provider '${this.name}' failed intentionally.`);
    }

    const baseTs = this.timestampSupplier ? this.timestampSupplier() : Date.now();

    return {
      provider: this.name,
      priceMicroUsd: this.priceMicroUsd,
      timestampMs: baseTs + this.timestampOffsetMs,
    };
  }
}
