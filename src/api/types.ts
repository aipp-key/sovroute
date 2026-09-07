/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Unified Swap API Types & Interfaces
 */

import type { SovereignQuote } from '../pricing/types.ts';
import type { SignedSwapAuthorization } from '../gasless/types.ts';

export interface CreateQuoteRequest {
  amountSats: number | string | bigint;
  targetDestinationAddress: string;
}

export interface WalletLimitsResponse {
  walletAddress: string;
  isCooldownActive: boolean;
  remainingCooldownMs: number;
  rolling24hUsedUsdc: number;
  remaining24hUsdc: number;
  maxSingleSwapUsdc: number;
}

export interface SubmitSwapRequest {
  authorization: SignedSwapAuthorization;
  quote: SovereignQuote;
  idempotencyKey: string;
}

export interface SubmitSwapResponse {
  idempotencyKey: string;
  swapId: string;
  status: string;
  lightning: {
    paymentRequest: string;
    hashLock: string;
    amountSats: string;
    expiresAt: number;
  };
  base: {
    claimingAddress: string;
    targetDestinationAddress: string;
    expectedUsdcAmount: string;
  };
  relayer: {
    status: string;
    txHash?: string | undefined;
    blockNumber?: string | undefined;
  };
}

export interface SwapStatusResponse {
  idempotencyKey: string;
  swapId: string;
  state: string;
  amountSats: string;
  expectedUsdcAmount: string;
  claimingAddress: string;
  targetDestinationAddress: string;
  paymentRequest?: string | undefined;
  createdAt: number;
}

export interface ApiHealthResponse {
  status: 'HEALTHY' | 'DEGRADED';
  service: 'sovroute-api';
  timestamp: number;
  btcPriceUsd: string;
  activePriceFeeds: number;
  chainId: number | bigint;
}
