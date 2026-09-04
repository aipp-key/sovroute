/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Phase 7: Production Health & Observability Semantics
 *
 * Implements granular operational status evaluation (HEALTHY, DEGRADED,
 * RECOVERY_REQUIRED, UNHEALTHY), isolation of poisoned swaps, and secret-safe
 * telemetry serialization.
 */

import type { SqlitePersistence } from '../persistence/sqlite.ts';
import type { DatabaseSync } from 'node:sqlite';

export type HealthStatus = 'HEALTHY' | 'DEGRADED' | 'RECOVERY_REQUIRED' | 'UNHEALTHY';

export interface ComponentStatus {
  status: 'UP' | 'DOWN' | 'DEGRADED' | 'UNKNOWN';
  latencyMs?: number | undefined;
  message?: string | undefined;
  details?: Record<string, any> | undefined;
}

export interface HealthReport {
  status: HealthStatus;
  timestamp: string;
  uptimeSeconds: number;
  process: {
    pid: number;
    nodeVersion: string;
    memoryUsageBytes: NodeJS.MemoryUsage;
  };
  components: {
    database: ComponentStatus;
    lightningRail: ComponentStatus;
    evmRail: ComponentStatus;
  };
  swaps: {
    totalSwaps: number;
    inFlightSwaps: number;
    completedSwaps: number;
    refundedSwaps: number;
    recoveryRequiredSwaps: number;
  };
  diagnosticNotes: string[];
}

export interface RailHealthCheckers {
  checkLightning?: (() => Promise<{ available: boolean; latencyMs?: number | undefined; details?: Record<string, any> | undefined }>) | undefined;
  checkEvm?: (() => Promise<{ available: boolean; latencyMs?: number | undefined; details?: Record<string, any> | undefined }>) | undefined;
}

export class HealthService {
  private persistence: SqlitePersistence;
  private railCheckers: RailHealthCheckers;
  private startTime: number;

  constructor(persistence: SqlitePersistence, railCheckers: RailHealthCheckers = {}) {
    this.persistence = persistence;
    this.railCheckers = railCheckers;
    this.startTime = Date.now();
  }

  /**
   * Evaluates system health across process, SQLite database, and active rails.
   * Ensures output contains zero secrets or client private keys.
   */
  public async getHealthReport(): Promise<HealthReport> {
    const diagnosticNotes: string[] = [];
    const timestamp = new Date().toISOString();
    const uptimeSeconds = Math.floor((Date.now() - this.startTime) / 1000);

    // 1. Process health
    const processInfo = {
      pid: process.pid,
      nodeVersion: process.version,
      memoryUsageBytes: process.memoryUsage(),
    };

    // 2. Database health
    let dbStatus: ComponentStatus = { status: 'UP' };
    let swapCounts = {
      totalSwaps: 0,
      inFlightSwaps: 0,
      completedSwaps: 0,
      refundedSwaps: 0,
      recoveryRequiredSwaps: 0,
    };

    try {
      const db: DatabaseSync = (this.persistence as any).db;
      const startDb = Date.now();
      const checkRes = db.prepare('PRAGMA integrity_check;').all() as Array<{ integrity_check: string }>;
      const latencyMs = Date.now() - startDb;

      if (!checkRes || checkRes.length === 0 || checkRes[0].integrity_check !== 'ok') {
        dbStatus = { status: 'DOWN', message: 'Database integrity check failed' };
        diagnosticNotes.push('CRITICAL: SQLite database failed integrity check');
      } else {
        dbStatus = { status: 'UP', latencyMs };

        // Query swap statistics
        const total = (db.prepare('SELECT count(*) as c FROM sovereign_swaps;').get() as { c: number })?.c ?? 0;
        const recoveryRequired = (
          db.prepare('SELECT count(*) as c FROM sovereign_swaps WHERE recovery_required = 1;').get() as { c: number }
        )?.c ?? 0;
        const completed = (
          db.prepare("SELECT count(*) as c FROM sovereign_swaps WHERE state = 'COMPLETED';").get() as { c: number }
        )?.c ?? 0;
        const refunded = (
          db.prepare("SELECT count(*) as c FROM sovereign_swaps WHERE state = 'REFUNDED';").get() as { c: number }
        )?.c ?? 0;

        swapCounts = {
          totalSwaps: total,
          inFlightSwaps: total - completed - refunded,
          completedSwaps: completed,
          refundedSwaps: refunded,
          recoveryRequiredSwaps: recoveryRequired,
        };

        if (recoveryRequired > 0) {
          diagnosticNotes.push(
            `OPERATOR_ACTION_REQUIRED: ${recoveryRequired} swap(s) flagged with recoveryRequired = true.`
          );
        }
      }
    } catch (err: any) {
      dbStatus = { status: 'DOWN', message: err.message };
      diagnosticNotes.push(`CRITICAL: Database query failed: ${err.message}`);
    }

    // 3. Lightning rail health
    let lnStatus: ComponentStatus = { status: 'UNKNOWN' };
    if (this.railCheckers.checkLightning) {
      try {
        const lnRes = await this.railCheckers.checkLightning();
        lnStatus = {
          status: lnRes.available ? 'UP' : 'DOWN',
          latencyMs: lnRes.latencyMs,
          details: lnRes.details ? HealthService.sanitizeDetails(lnRes.details) : undefined,
        };
        if (!lnRes.available) {
          diagnosticNotes.push('WARNING: Lightning rail connection is currently unavailable');
        }
      } catch (err: any) {
        lnStatus = { status: 'DOWN', message: err.message };
        diagnosticNotes.push(`WARNING: Lightning health check threw error: ${err.message}`);
      }
    }

    // 4. EVM rail health
    let evmStatus: ComponentStatus = { status: 'UNKNOWN' };
    if (this.railCheckers.checkEvm) {
      try {
        const evmRes = await this.railCheckers.checkEvm();
        evmStatus = {
          status: evmRes.available ? 'UP' : 'DOWN',
          latencyMs: evmRes.latencyMs,
          details: evmRes.details ? HealthService.sanitizeDetails(evmRes.details) : undefined,
        };
        if (!evmRes.available) {
          diagnosticNotes.push('WARNING: Base EVM RPC connection is currently unavailable');
        }
      } catch (err: any) {
        evmStatus = { status: 'DOWN', message: err.message };
        diagnosticNotes.push(`WARNING: Base EVM health check threw error: ${err.message}`);
      }
    }

    // 5. Aggregate overall status
    let overallStatus: HealthStatus = 'HEALTHY';

    if (dbStatus.status === 'DOWN') {
      overallStatus = 'UNHEALTHY';
    } else if (swapCounts.recoveryRequiredSwaps > 0) {
      // Swaps requiring operator recovery escalate status to RECOVERY_REQUIRED
      overallStatus = 'RECOVERY_REQUIRED';
    } else if (lnStatus.status === 'DOWN' || evmStatus.status === 'DOWN') {
      // Degraded connectivity on one or both rails
      overallStatus = 'DEGRADED';
    }

    return {
      status: overallStatus,
      timestamp,
      uptimeSeconds,
      process: processInfo,
      components: {
        database: dbStatus,
        lightningRail: lnStatus,
        evmRail: evmStatus,
      },
      swaps: swapCounts,
      diagnosticNotes,
    };
  }

  /**
   * Sanitizes diagnostic details to ensure zero private keys, macaroons, or secrets leak into telemetry.
   */
  private static sanitizeDetails(details: Record<string, any>): Record<string, any> {
    const sanitized: Record<string, any> = {};
    for (const [key, value] of Object.entries(details)) {
      const lower = key.toLowerCase();
      if (
        lower.includes('key') ||
        lower.includes('secret') ||
        lower.includes('macaroon') ||
        lower.includes('pass') ||
        lower.includes('token') ||
        lower.includes('cert')
      ) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }
}
