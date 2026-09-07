/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Anti-Abuse & Volume Safety Engine Types (Section 25 Policy)
 */

import type { SovereignQuote } from '../pricing/types.ts';

export type SwapAdmissionStatus = 'ADMITTED' | 'COMPLETED' | 'CANCELLED' | 'REFUNDED' | 'FAILED';

export interface AntiAbuseConfig {
  /** Minimum time in ms between swap admissions for a given wallet (default: 60_000 = 60s) */
  cooldownMs: number;
  /** Duration of rolling volume window in ms (default: 86_400_000 = 24h) */
  rollingWindowMs: number;
  /** Maximum allowable total volume per source wallet in rolling window (default: 500_000_000n = $500 USDC) */
  maxRollingVolumeUsdcAtomic: bigint;
  /** Maximum allowable volume sent to any single destination address in rolling window (default: 1_000_000_000n = $1000 USDC) */
  maxDestinationRollingVolumeUsdcAtomic: bigint;
  /** Maximum single swap amount in Base USDC atomic units (default: 250_000_000n = $250 USDC) */
  maxSingleSwapUsdcAtomic: bigint;
  /** Global daily ceiling for all beta swaps combined (default: 5_000_000_000n = $5,000 USDC) */
  maxGlobalRollingVolumeUsdcAtomic: bigint;
  /** Maximum concurrent in-flight (unsettled) USDC volume (default: 1_000_000_000n = $1,000 USDC) */
  maxConcurrentInFlightUsdcAtomic: bigint;
}

export interface SwapAdmissionRequest {
  idempotencyKey: string;
  walletAddress: string;
  destinationAddress: string;
  quote: SovereignQuote;
  clientIp?: string | undefined;
}

export interface AdmissionTicket {
  ticketId: string;
  idempotencyKey: string;
  walletAddress: string;
  destinationAddress: string;
  amountSats: bigint;
  amountUsdcAtomic: bigint;
  admittedAtMs: number;
  walletRollingVolumeBeforeUsdcAtomic: bigint;
  walletRollingVolumeAfterUsdcAtomic: bigint;
  walletRemainingBudgetUsdcAtomic: bigint;
}

export interface AntiAbuseEventRow {
  id: string;
  idempotency_key: string;
  wallet_address: string;
  destination_address: string;
  amount_usdc_atomic: string; // stored as string in SQLite to preserve BigInt precision
  amount_sats: string;
  status: SwapAdmissionStatus;
  created_at_ms: number;
  updated_at_ms: number;
  client_ip: string | null;
}

export interface WalletMetrics {
  lastRequestAtMs: number | null;
  rollingVolumeUsdcAtomic: bigint;
  activeInFlightCount: number;
  activeInFlightVolumeUsdcAtomic: bigint;
}
