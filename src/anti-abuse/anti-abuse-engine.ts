/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Anti-Abuse & Rate-Limiting Engine (Section 25 Compliance)
 *
 * Integrates Quote verification with durable SQLite admission limits.
 * Protects liquidity from rapid draining, bot velocity, and concurrent exposure.
 */

import type {
  AntiAbuseConfig,
  SwapAdmissionRequest,
  AdmissionTicket,
} from './types.ts';
import { AntiAbusePersistence } from './persistence.ts';
import { QuoteEngine } from '../pricing/quote-engine.ts';

export const DEFAULT_ANTI_ABUSE_CONFIG: AntiAbuseConfig = {
  cooldownMs: 60_000,                          // 60 seconds per-wallet cooldown
  rollingWindowMs: 86_400_000,                  // 24 hours rolling window
  maxRollingVolumeUsdcAtomic: 500_000_000n,     // $500.00 USDC per-wallet rolling 24h
  maxDestinationRollingVolumeUsdcAtomic: 1_000_000_000n, // $1,000.00 max per receiver
  maxSingleSwapUsdcAtomic: 250_000_000n,        // $250.00 USDC max per single swap
  maxGlobalRollingVolumeUsdcAtomic: 5_000_000_000n, // $5,000.00 daily beta system cap
  maxConcurrentInFlightUsdcAtomic: 1_000_000_000n, // $1,000.00 concurrent in-flight cap
};

export class AntiAbuseEngine {
  private readonly persistence: AntiAbusePersistence;
  private readonly quoteEngine: QuoteEngine;
  private readonly policy: AntiAbuseConfig;

  constructor(
    persistence: AntiAbusePersistence,
    quoteEngine: QuoteEngine,
    policy: Partial<AntiAbuseConfig> = {}
  ) {
    this.persistence = persistence;
    this.quoteEngine = quoteEngine;
    this.policy = { ...DEFAULT_ANTI_ABUSE_CONFIG, ...policy };
  }

  public getPolicy(): AntiAbuseConfig {
    return this.policy;
  }

  /**
   * Evaluates a swap intent: verifies cryptographic quote authenticity,
   * checks velocity and volume boundaries, and records admission atomically.
   */
  public async admitSwap(
    request: SwapAdmissionRequest,
    nowMs = Date.now()
  ): Promise<AdmissionTicket> {
    // 1. Authenticate Quote against tampering, expiration, and destination binding
    this.quoteEngine.verifyOrReject(request.quote, request.destinationAddress, nowMs);

    // 2. Evaluate and atomically record admission under write lock
    return this.persistence.evaluateAndRecordAdmission(request, this.policy, nowMs);
  }

  /**
   * Finalizes an admitted swap upon verified on-chain completion.
   */
  public markCompleted(idempotencyKey: string, nowMs = Date.now()): void {
    this.persistence.updateSwapStatus(idempotencyKey, 'COMPLETED', nowMs);
  }

  /**
   * Finalizes an admitted swap upon verified on-chain refund.
   */
  public markRefunded(idempotencyKey: string, nowMs = Date.now()): void {
    this.persistence.updateSwapStatus(idempotencyKey, 'REFUNDED', nowMs);
  }

  /**
   * Finalizes an admitted swap upon cancellation prior to on-chain execution.
   */
  public markCancelled(idempotencyKey: string, nowMs = Date.now()): void {
    this.persistence.updateSwapStatus(idempotencyKey, 'CANCELLED', nowMs);
  }

  /**
   * Returns current UX limit metrics for display in frontend (Section 25.3).
   */
  public getWalletStatus(walletAddress: string, nowMs = Date.now()) {
    const metrics = this.persistence.getWalletMetrics(walletAddress, this.policy, nowMs);
    const remainingBudget =
      this.policy.maxRollingVolumeUsdcAtomic > metrics.rollingVolumeUsdcAtomic
        ? this.policy.maxRollingVolumeUsdcAtomic - metrics.rollingVolumeUsdcAtomic
        : 0n;

    const cooldownRemainingMs =
      metrics.lastRequestAtMs !== null
        ? Math.max(0, this.policy.cooldownMs - (nowMs - metrics.lastRequestAtMs))
        : 0;

    return {
      walletAddress: walletAddress.toLowerCase(),
      rolling24hLimitUsdc: Number(this.policy.maxRollingVolumeUsdcAtomic) / 1e6,
      rolling24hUsedUsdc: Number(metrics.rollingVolumeUsdcAtomic) / 1e6,
      remainingBudgetUsdc: Number(remainingBudget) / 1e6,
      cooldownRemainingSeconds: Math.ceil(cooldownRemainingMs / 1000),
      isCooldownActive: cooldownRemainingMs > 0,
      activeInFlightCount: metrics.activeInFlightCount,
    };
  }
}
