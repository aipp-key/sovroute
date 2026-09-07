/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Anti-Abuse SQLite Persistence Layer (Node 24 DatabaseSync)
 *
 * Enforces atomic transactions (BEGIN IMMEDIATE), WAL durability,
 * race-condition prevention, and rolling-window aggregations.
 */

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AntiAbuseConfig,
  SwapAdmissionRequest,
  AdmissionTicket,
  AntiAbuseEventRow,
  SwapAdmissionStatus,
  WalletMetrics,
} from './types.ts';
import {
  WalletCooldownActiveError,
  RollingVolumeLimitExceededError,
  DestinationVolumeLimitExceededError,
  GlobalCapacityExceededError,
  ConcurrentExposureLimitExceededError,
  IdempotencyConflictError,
} from './errors.ts';

export interface AntiAbusePersistenceOptions {
  filename?: string;
  existingDb?: DatabaseSync;
}

export class AntiAbusePersistence {
  private readonly db: DatabaseSync;
  private readonly ownsDb: boolean;

  constructor(options: AntiAbusePersistenceOptions = {}) {
    if (options.existingDb) {
      this.db = options.existingDb;
      this.ownsDb = false;
    } else {
      const filename = options.filename ?? ':memory:';
      if (filename !== ':memory:') {
        const dir = path.dirname(filename);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
      }
      this.db = new DatabaseSync(filename);
      this.ownsDb = true;
    }

    this.initPragmas();
    this.initSchema();
  }

  private initPragmas(): void {
    try {
      this.db.exec('PRAGMA busy_timeout = 5000;');
    } catch {}
    try {
      this.db.exec('PRAGMA foreign_keys = ON;');
    } catch {}
    try {
      this.db.exec('PRAGMA journal_mode = WAL;');
    } catch {}
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS anti_abuse_events (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT UNIQUE NOT NULL,
        wallet_address TEXT NOT NULL,
        destination_address TEXT NOT NULL,
        amount_usdc_atomic TEXT NOT NULL,
        amount_sats TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        client_ip TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_anti_abuse_wallet_time ON anti_abuse_events(wallet_address, created_at_ms);
      CREATE INDEX IF NOT EXISTS idx_anti_abuse_dest_time ON anti_abuse_events(destination_address, created_at_ms);
      CREATE INDEX IF NOT EXISTS idx_anti_abuse_status ON anti_abuse_events(status, created_at_ms);
    `);
  }

  /**
   * Atomically evaluates safety boundaries and records admission under BEGIN IMMEDIATE write lock.
   */
  public evaluateAndRecordAdmission(
    req: SwapAdmissionRequest,
    policy: AntiAbuseConfig,
    nowMs = Date.now()
  ): AdmissionTicket {
    const normalizedWallet = req.walletAddress.toLowerCase();
    const normalizedDest = req.destinationAddress.toLowerCase();
    const requestedUsdcAtomic = req.quote.netUsdcAtomic;
    const requestedSats = req.quote.amountSats;

    // Single swap maximum limit check
    if (requestedUsdcAtomic > policy.maxSingleSwapUsdcAtomic) {
      throw new RollingVolumeLimitExceededError(
        normalizedWallet,
        0n,
        requestedUsdcAtomic,
        policy.maxSingleSwapUsdcAtomic
      );
    }

    this.db.exec('BEGIN IMMEDIATE;');

    try {
      // 1. Idempotency Check: Existing request replay
      const existing = this.db
        .prepare('SELECT * FROM anti_abuse_events WHERE idempotency_key = ?')
        .get(req.idempotencyKey) as AntiAbuseEventRow | undefined;

      if (existing) {
        if (
          existing.wallet_address !== normalizedWallet ||
          existing.destination_address !== normalizedDest ||
          BigInt(existing.amount_usdc_atomic) !== requestedUsdcAtomic ||
          BigInt(existing.amount_sats) !== requestedSats
        ) {
          throw new IdempotencyConflictError(
            req.idempotencyKey,
            `Expected wallet=${existing.wallet_address}, dest=${existing.destination_address}, usdc=${existing.amount_usdc_atomic}, sats=${existing.amount_sats}`
          );
        }

        // Idempotent replay returns existing ticket without re-charging
        this.db.exec('COMMIT;');
        const volumeBefore = this.calculateRollingVolumeInternal(normalizedWallet, nowMs, policy.rollingWindowMs);
        return {
          ticketId: existing.id,
          idempotencyKey: existing.idempotency_key,
          walletAddress: existing.wallet_address,
          destinationAddress: existing.destination_address,
          amountSats: BigInt(existing.amount_sats),
          amountUsdcAtomic: BigInt(existing.amount_usdc_atomic),
          admittedAtMs: existing.created_at_ms,
          walletRollingVolumeBeforeUsdcAtomic: volumeBefore,
          walletRollingVolumeAfterUsdcAtomic: volumeBefore,
          walletRemainingBudgetUsdcAtomic:
            policy.maxRollingVolumeUsdcAtomic > volumeBefore
              ? policy.maxRollingVolumeUsdcAtomic - volumeBefore
              : 0n,
        };
      }

      // 2. Per-Wallet Cooldown: 1 request / 60 seconds
      const cooldownCutoff = nowMs - policy.cooldownMs;
      const recentRequest = this.db
        .prepare(
          `SELECT created_at_ms FROM anti_abuse_events 
           WHERE wallet_address = ? AND created_at_ms > ? 
           ORDER BY created_at_ms DESC LIMIT 1`
        )
        .get(normalizedWallet, cooldownCutoff) as { created_at_ms: number } | undefined;

      if (recentRequest) {
        const elapsed = nowMs - recentRequest.created_at_ms;
        const remaining = policy.cooldownMs - elapsed;
        if (remaining > 0) {
          throw new WalletCooldownActiveError(normalizedWallet, remaining);
        }
      }

      // 3. Per-Wallet 24h Rolling Volume Cap ($500 USDC)
      const walletRollingVolume = this.calculateRollingVolumeInternal(
        normalizedWallet,
        nowMs,
        policy.rollingWindowMs
      );

      if (walletRollingVolume + requestedUsdcAtomic > policy.maxRollingVolumeUsdcAtomic) {
        throw new RollingVolumeLimitExceededError(
          normalizedWallet,
          walletRollingVolume,
          requestedUsdcAtomic,
          policy.maxRollingVolumeUsdcAtomic
        );
      }

      // 4. Per-Destination 24h Rolling Volume Cap
      const destRollingCutoff = nowMs - policy.rollingWindowMs;
      const destRows = this.db
        .prepare(
          `SELECT amount_usdc_atomic FROM anti_abuse_events 
           WHERE destination_address = ? AND created_at_ms > ? AND status != 'FAILED'`
        )
        .all(normalizedDest, destRollingCutoff) as Array<{ amount_usdc_atomic: string }>;

      const destRollingVolume = destRows.reduce((sum, r) => sum + BigInt(r.amount_usdc_atomic), 0n);

      if (destRollingVolume + requestedUsdcAtomic > policy.maxDestinationRollingVolumeUsdcAtomic) {
        throw new DestinationVolumeLimitExceededError(
          normalizedDest,
          destRollingVolume,
          requestedUsdcAtomic,
          policy.maxDestinationRollingVolumeUsdcAtomic
        );
      }

      // 5. Concurrent In-Flight Exposure Cap
      // In-flight swaps are those in 'ADMITTED' status created in the last 2 hours
      const inFlightCutoff = nowMs - 7_200_000;
      const inFlightRows = this.db
        .prepare(
          `SELECT amount_usdc_atomic FROM anti_abuse_events 
           WHERE status = 'ADMITTED' AND created_at_ms > ?`
        )
        .all(inFlightCutoff) as Array<{ amount_usdc_atomic: string }>;

      const currentInFlightVolume = inFlightRows.reduce((sum, r) => sum + BigInt(r.amount_usdc_atomic), 0n);

      if (currentInFlightVolume + requestedUsdcAtomic > policy.maxConcurrentInFlightUsdcAtomic) {
        throw new ConcurrentExposureLimitExceededError(
          currentInFlightVolume,
          policy.maxConcurrentInFlightUsdcAtomic
        );
      }

      // 6. Global 24h Rolling System Exposure Cap
      const globalCutoff = nowMs - policy.rollingWindowMs;
      const globalRows = this.db
        .prepare(
          `SELECT amount_usdc_atomic FROM anti_abuse_events 
           WHERE created_at_ms > ? AND status != 'FAILED'`
        )
        .all(globalCutoff) as Array<{ amount_usdc_atomic: string }>;

      const globalRollingVolume = globalRows.reduce((sum, r) => sum + BigInt(r.amount_usdc_atomic), 0n);

      if (globalRollingVolume + requestedUsdcAtomic > policy.maxGlobalRollingVolumeUsdcAtomic) {
        throw new GlobalCapacityExceededError(globalRollingVolume, policy.maxGlobalRollingVolumeUsdcAtomic);
      }

      // All bounds satisfied -> Record admission
      const ticketId = `ticket_${randomUUID()}`;
      this.db
        .prepare(
          `INSERT INTO anti_abuse_events (
            id, idempotency_key, wallet_address, destination_address,
            amount_usdc_atomic, amount_sats, status,
            created_at_ms, updated_at_ms, client_ip
          ) VALUES (?, ?, ?, ?, ?, ?, 'ADMITTED', ?, ?, ?)`
        )
        .run(
          ticketId,
          req.idempotencyKey,
          normalizedWallet,
          normalizedDest,
          requestedUsdcAtomic.toString(),
          requestedSats.toString(),
          nowMs,
          nowMs,
          req.clientIp ?? null
        );

      this.db.exec('COMMIT;');

      const volumeAfter = walletRollingVolume + requestedUsdcAtomic;
      const remainingBudget =
        policy.maxRollingVolumeUsdcAtomic > volumeAfter
          ? policy.maxRollingVolumeUsdcAtomic - volumeAfter
          : 0n;

      return {
        ticketId,
        idempotencyKey: req.idempotencyKey,
        walletAddress: normalizedWallet,
        destinationAddress: normalizedDest,
        amountSats: requestedSats,
        amountUsdcAtomic: requestedUsdcAtomic,
        admittedAtMs: nowMs,
        walletRollingVolumeBeforeUsdcAtomic: walletRollingVolume,
        walletRollingVolumeAfterUsdcAtomic: volumeAfter,
        walletRemainingBudgetUsdcAtomic: remainingBudget,
      };
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {}
      throw err;
    }
  }

  /**
   * Updates swap lifecycle status upon completion, cancellation, or refund.
   */
  public updateSwapStatus(idempotencyKey: string, status: SwapAdmissionStatus, nowMs = Date.now()): void {
    this.db
      .prepare('UPDATE anti_abuse_events SET status = ?, updated_at_ms = ? WHERE idempotency_key = ?')
      .run(status, nowMs, idempotencyKey);
  }

  /**
   * Reads current telemetry metrics for a given wallet address.
   */
  public getWalletMetrics(
    walletAddress: string,
    policy: AntiAbuseConfig,
    nowMs = Date.now()
  ): WalletMetrics {
    const normalizedWallet = walletAddress.toLowerCase();
    const rollingCutoff = nowMs - policy.rollingWindowMs;

    const latest = this.db
      .prepare(
        `SELECT created_at_ms FROM anti_abuse_events 
         WHERE wallet_address = ? 
         ORDER BY created_at_ms DESC LIMIT 1`
      )
      .get(normalizedWallet) as { created_at_ms: number } | undefined;

    const rollingVolume = this.calculateRollingVolumeInternal(normalizedWallet, nowMs, policy.rollingWindowMs);

    const inFlightRows = this.db
      .prepare(
        `SELECT amount_usdc_atomic FROM anti_abuse_events 
         WHERE wallet_address = ? AND status = 'ADMITTED' AND created_at_ms > ?`
      )
      .all(normalizedWallet, rollingCutoff) as Array<{ amount_usdc_atomic: string }>;

    const inFlightVolume = inFlightRows.reduce((sum, r) => sum + BigInt(r.amount_usdc_atomic), 0n);

    return {
      lastRequestAtMs: latest ? latest.created_at_ms : null,
      rollingVolumeUsdcAtomic: rollingVolume,
      activeInFlightCount: inFlightRows.length,
      activeInFlightVolumeUsdcAtomic: inFlightVolume,
    };
  }

  private calculateRollingVolumeInternal(walletAddress: string, nowMs: number, rollingWindowMs: number): bigint {
    const cutoff = nowMs - rollingWindowMs;
    const rows = this.db
      .prepare(
        `SELECT amount_usdc_atomic FROM anti_abuse_events 
         WHERE wallet_address = ? AND created_at_ms > ? AND status != 'FAILED'`
      )
      .all(walletAddress, cutoff) as Array<{ amount_usdc_atomic: string }>;

    return rows.reduce((sum, r) => sum + BigInt(r.amount_usdc_atomic), 0n);
  }

  public close(): void {
    if (this.ownsDb) {
      try {
        this.db.close();
      } catch {}
    }
  }
}
