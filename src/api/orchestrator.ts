/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Unified Swap Orchestrator
 *
 * Coordinates QuoteEngine, AntiAbuseEngine, GaslessRelayer, and AtomicCoordinator.
 */

import { createHash } from 'node:crypto';
import type { QuoteEngine } from '../pricing/quote-engine.ts';
import type { AntiAbuseEngine } from '../anti-abuse/anti-abuse-engine.ts';
import type { GaslessAuthorizer } from '../gasless/authorizer.ts';
import type { NonceManager } from '../gasless/nonce-manager.ts';
import type { GaslessRelayer } from '../gasless/relayer.ts';
import type { AtomicCoordinator } from '../atomic/coordinator/coordinator.ts';
import type { SovereignQuote } from '../pricing/types.ts';
import type {
  CreateQuoteRequest,
  WalletLimitsResponse,
  SubmitSwapRequest,
  SubmitSwapResponse,
  SwapStatusResponse,
  ApiHealthResponse,
} from './types.ts';

export interface SwapOrchestratorOptions {
  quoteEngine: QuoteEngine;
  antiAbuseEngine: AntiAbuseEngine;
  authorizer: GaslessAuthorizer;
  nonceManager: NonceManager;
  relayer: GaslessRelayer;
  coordinator: AtomicCoordinator;
}

export class SwapOrchestrator {
  public readonly quoteEngine: QuoteEngine;
  public readonly antiAbuseEngine: AntiAbuseEngine;
  public readonly authorizer: GaslessAuthorizer;
  public readonly nonceManager: NonceManager;
  public readonly relayer: GaslessRelayer;
  public readonly coordinator: AtomicCoordinator;

  constructor(options: SwapOrchestratorOptions) {
    this.quoteEngine = options.quoteEngine;
    this.antiAbuseEngine = options.antiAbuseEngine;
    this.authorizer = options.authorizer;
    this.nonceManager = options.nonceManager;
    this.relayer = options.relayer;
    this.coordinator = options.coordinator;
  }

  public async getHealth(): Promise<ApiHealthResponse> {
    try {
      const priceResult = await this.quoteEngine.getAggregator().getAuthoritativePrice();
      const btcPrice = (Number(priceResult.referencePriceMicroUsd) / 1_000_000).toFixed(2);
      return {
        status: 'HEALTHY',
        service: 'sovroute-api',
        timestamp: Date.now(),
        btcPriceUsd: btcPrice,
        activePriceFeeds: priceResult.activeSamples.length,
        chainId: this.authorizer.domainConfig.chainId,
      };
    } catch {
      return {
        status: 'DEGRADED',
        service: 'sovroute-api',
        timestamp: Date.now(),
        btcPriceUsd: '0.00',
        activePriceFeeds: 0,
        chainId: this.authorizer.domainConfig.chainId,
      };
    }
  }

  public async getQuote(request: CreateQuoteRequest): Promise<SovereignQuote> {
    const amountSats = BigInt(request.amountSats);
    return await this.quoteEngine.createQuote({
      amountSats,
      targetDestinationAddress: request.targetDestinationAddress,
    });
  }

  public getLimits(walletAddress: string, nowMs = Date.now()): WalletLimitsResponse {
    const status = this.antiAbuseEngine.getWalletStatus(walletAddress, nowMs);
    const maxSingle = Number(this.antiAbuseEngine.getPolicy().maxSingleSwapUsdcAtomic) / 1_000_000;
    return {
      walletAddress: walletAddress.toLowerCase(),
      isCooldownActive: status.isCooldownActive,
      remainingCooldownMs: status.cooldownRemainingSeconds * 1000,
      rolling24hUsedUsdc: status.rolling24hUsedUsdc,
      remaining24hUsdc: status.remainingBudgetUsdc,
      maxSingleSwapUsdc: maxSingle,
    };
  }

  public async submitGaslessSwap(
    request: SubmitSwapRequest,
    nowMs = Date.now()
  ): Promise<SubmitSwapResponse> {
    const { authorization, quote, idempotencyKey } = request;

    // 1. Execute upstream Gasless Relayer flow
    // (Verifies quote, enforces anti-abuse, validates EIP-712 signature, consumes nonce, broadcasts on-chain)
    const relayerResult = await this.relayer.submitSwap(
      {
        authorization,
        quote,
        idempotencyKey,
      },
      nowMs
    );

    // 2. Derive deterministic hashLock from quoteId & idempotencyKey for Coordinator handoff
    const hashLock = ('0x' +
      createHash('sha256')
        .update(`SOVROUTE-SWAP:${idempotencyKey}:${authorization.message.quoteId}`)
        .digest('hex')) as `0x${string}`;

    // 3. Handoff to frozen Sovereign AtomicCoordinator
    const record = await this.coordinator.prepareSwap({
      idempotencyKey,
      hashLock,
      claimingAddress: authorization.message.destination,
      targetDestinationAddress: authorization.message.destination,
      amountSats: authorization.message.amountSats,
      expectedUsdcAmount: authorization.message.amountUsdcAtomic,
    });

    const invoice = record.holdInvoice;

    return {
      idempotencyKey,
      swapId: record.id,
      status: record.state,
      lightning: {
        paymentRequest: invoice?.bolt11 ?? '',
        hashLock: record.hashLock,
        amountSats: record.amountSats.toString(),
        expiresAt: invoice?.expiryHeight ?? 0,
      },
      base: {
        claimingAddress: record.claimingAddress,
        targetDestinationAddress: record.targetDestinationAddress,
        expectedUsdcAmount: record.expectedUsdcAmount.toString(),
      },
      relayer: {
        status: relayerResult.status,
        txHash: relayerResult.txHash,
        blockNumber: relayerResult.blockNumber?.toString(),
      },
    };
  }

  public getSwapStatus(idempotencyKey: string): SwapStatusResponse | null {
    const record = this.coordinator.getPersistence().getSovereignSwapByIdempotencyKey(idempotencyKey);
    if (!record) {
      return null;
    }

    return {
      idempotencyKey: record.idempotencyKey,
      swapId: record.id,
      state: record.state,
      amountSats: record.amountSats.toString(),
      expectedUsdcAmount: record.expectedUsdcAmount.toString(),
      claimingAddress: record.claimingAddress,
      targetDestinationAddress: record.targetDestinationAddress,
      paymentRequest: record.holdInvoice?.bolt11 ?? (record.holdInvoice as any)?.paymentRequest,
      createdAt: record.createdAt.getTime(),
    };
  }
}
