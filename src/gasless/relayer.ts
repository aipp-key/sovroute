/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Gasless Relayer Service (Fail-Closed, Nonce & Replay Safe)
 */

import type { DatabaseSync } from 'node:sqlite';
import type { QuoteEngine } from '../pricing/quote-engine.ts';
import type { AntiAbuseEngine } from '../anti-abuse/anti-abuse-engine.ts';
import type { GaslessAuthorizer } from './authorizer.ts';
import type { NonceManager } from './nonce-manager.ts';
import type {
  IOnchainBroadcaster,
  RelayerSubmissionRequest,
  RelayerExecutionResult,
  OnchainContractCall,
} from './types.ts';
import {
  AmbiguousBroadcastError,
  RelayerExecutionRevertedError,
  InvalidSignatureError,
} from './errors.ts';

export interface GaslessRelayerOptions {
  quoteEngine: QuoteEngine;
  antiAbuseEngine: AntiAbuseEngine;
  authorizer: GaslessAuthorizer;
  nonceManager: NonceManager;
  broadcaster: IOnchainBroadcaster;
  db: DatabaseSync;
}

export class GaslessRelayer {
  private readonly quoteEngine: QuoteEngine;
  private readonly antiAbuseEngine: AntiAbuseEngine;
  private readonly authorizer: GaslessAuthorizer;
  private readonly nonceManager: NonceManager;
  private readonly broadcaster: IOnchainBroadcaster;
  private readonly db: DatabaseSync;

  constructor(options: GaslessRelayerOptions) {
    this.quoteEngine = options.quoteEngine;
    this.antiAbuseEngine = options.antiAbuseEngine;
    this.authorizer = options.authorizer;
    this.nonceManager = options.nonceManager;
    this.broadcaster = options.broadcaster;
    this.db = options.db;

    this.initializeSchema();
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS relayer_executions (
        idempotency_key TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        tx_hash TEXT,
        block_number INTEGER,
        nonce INTEGER NOT NULL,
        swapper TEXT NOT NULL,
        destination TEXT NOT NULL,
        amount_usdc_atomic TEXT NOT NULL,
        amount_sats TEXT NOT NULL,
        error TEXT,
        submitted_at_ms INTEGER NOT NULL,
        confirmed_at_ms INTEGER
      );
    `);
  }

  public async submitSwap(
    request: RelayerSubmissionRequest,
    nowMs = Date.now()
  ): Promise<RelayerExecutionResult> {
    const { authorization, quote, idempotencyKey } = request;
    const { message, signature } = authorization;

    // 1. Check idempotency at relayer level
    const existing = this.db
      .prepare('SELECT * FROM relayer_executions WHERE idempotency_key = ?')
      .get(idempotencyKey) as any;

    if (existing) {
      return {
        idempotencyKey: existing.idempotency_key,
        status: existing.status,
        txHash: existing.tx_hash ?? undefined,
        blockNumber: existing.block_number ? BigInt(existing.block_number) : undefined,
        nonce: BigInt(existing.nonce),
        swapper: existing.swapper,
        destination: existing.destination,
        amountUsdcAtomic: BigInt(existing.amount_usdc_atomic),
        amountSats: BigInt(existing.amount_sats),
        error: existing.error ?? undefined,
        submittedAtMs: existing.submitted_at_ms,
        confirmedAtMs: existing.confirmed_at_ms ?? undefined,
      };
    }

    // 2. Validate Quote freshness and HMAC signature
    const quoteVerification = this.quoteEngine.verifyQuote(quote, message.destination, nowMs);
    if (!quoteVerification.valid) {
      throw new InvalidSignatureError(quoteVerification.reason ?? 'Quote verification failed.');
    }

    // 3. Anti-Abuse Admission Check (Rate limits, rolling 24h volume, in-flight exposure)
    await this.antiAbuseEngine.admitSwap(
      {
        idempotencyKey,
        walletAddress: message.swapper,
        destinationAddress: message.destination,
        quote,
      },
      nowMs
    );

    // 4. Validate EIP-712 Typed-Data Signature and Parameter Consistency
    const nowSeconds = BigInt(Math.floor(nowMs / 1000));
    await this.authorizer.verifyAuthorization(authorization, quote, nowSeconds);

    // 5. Durable Nonce & Replay Check (Atomically records nonce, quoteId, and sigHash)
    this.nonceManager.verifyAndConsume(
      message.swapper,
      message.nonce,
      message.quoteId,
      signature,
      nowMs
    );

    // 6. Broadcast On-Chain Transaction via Relayer Operator
    const contractCall: OnchainContractCall = {
      to: this.authorizer.domainConfig.verifyingContract,
      data: '0x' as `0x${string}`, // In actual contract integration, ABI-encoded authorizeAndDeposit(...)
    };

    let txHash: `0x${string}` | undefined;
    try {
      const broadcastResult = await this.broadcaster.broadcastTransaction(contractCall);
      txHash = broadcastResult.txHash;

      // Record submitted state
      this.db
        .prepare(`
          INSERT INTO relayer_executions (
            idempotency_key, status, tx_hash, nonce, swapper, destination,
            amount_usdc_atomic, amount_sats, submitted_at_ms
          ) VALUES (?, 'SUBMITTED', ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          idempotencyKey,
          txHash,
          Number(message.nonce),
          message.swapper.toLowerCase(),
          message.destination.toLowerCase(),
          message.amountUsdcAtomic.toString(),
          message.amountSats.toString(),
          nowMs
        );

      // Wait for confirmation
      const receipt = await broadcastResult.waitForReceipt();

      if (receipt.status === 'reverted') {
        this.antiAbuseEngine.markCancelled(idempotencyKey);
        this.db
          .prepare("UPDATE relayer_executions SET status = 'FAILED', error = 'reverted' WHERE idempotency_key = ?")
          .run(idempotencyKey);
        throw new RelayerExecutionRevertedError(txHash);
      }

      const confirmedAtMs = Date.now();
      this.antiAbuseEngine.markCompleted(idempotencyKey);
      this.db
        .prepare(`
          UPDATE relayer_executions
          SET status = 'CONFIRMED', block_number = ?, confirmed_at_ms = ?
          WHERE idempotency_key = ?
        `)
        .run(Number(receipt.blockNumber), confirmedAtMs, idempotencyKey);

      return {
        idempotencyKey,
        status: 'CONFIRMED',
        txHash,
        blockNumber: receipt.blockNumber,
        nonce: message.nonce,
        swapper: message.swapper,
        destination: message.destination,
        amountUsdcAtomic: message.amountUsdcAtomic,
        amountSats: message.amountSats,
        submittedAtMs: nowMs,
        confirmedAtMs,
      };
    } catch (err) {
      if (err instanceof RelayerExecutionRevertedError) {
        throw err;
      }

      // If txHash exists, it was broadcasted! Distinguish broadcast from confirmation failure.
      if (txHash) {
        // Attempt single non-blocking receipt probe to see if it actually confirmed
        try {
          const probe = await this.broadcaster.getTransactionReceipt(txHash);
          if (probe && probe.status === 'success') {
            this.antiAbuseEngine.markCompleted(idempotencyKey);
            this.db
              .prepare("UPDATE relayer_executions SET status = 'CONFIRMED', block_number = ? WHERE idempotency_key = ?")
              .run(Number(probe.blockNumber), idempotencyKey);
            return {
              idempotencyKey,
              status: 'CONFIRMED',
              txHash,
              blockNumber: probe.blockNumber,
              nonce: message.nonce,
              swapper: message.swapper,
              destination: message.destination,
              amountUsdcAtomic: message.amountUsdcAtomic,
              amountSats: message.amountSats,
              submittedAtMs: nowMs,
              confirmedAtMs: Date.now(),
            };
          }
        } catch {
          // Probe failed
        }

        // FAIL-CLOSED: Refuse blind retry! Record AMBIGUOUS_TIMEOUT
        this.db
          .prepare("UPDATE relayer_executions SET status = 'AMBIGUOUS_TIMEOUT', error = ? WHERE idempotency_key = ?")
          .run((err as Error).message, idempotencyKey);

        throw new AmbiguousBroadcastError(txHash, (err as Error).message);
      }

      // If broadcast itself never succeeded: release admission and fail closed
      this.antiAbuseEngine.markCancelled(idempotencyKey);
      throw err;
    }
  }
}
