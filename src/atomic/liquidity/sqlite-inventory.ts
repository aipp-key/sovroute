/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Durable SQLite-Backed Liquidity Inventory
 *
 * Implements ILiquidityInventory authoritatively backed by SQLite persistence.
 * Uses BEGIN IMMEDIATE for multi-process / multi-worker oversubscription safety.
 */

import { randomUUID } from 'node:crypto';
import {
  type InventoryReadinessState,
  InventoryNotReadyError,
  LiquidityDeficitError,
  EvmInventoryUnavailableError,
  type IReconciledLiquidityInventory,
} from '../types.ts';
import type { SqlitePersistence, LiquidityReservationRecord } from '../../persistence/sqlite.ts';
import type { ChainInventoryReconciler } from './chain-reconciler.ts';

export interface SqliteLiquidityInventoryOptions {
  reconciler?: ChainInventoryReconciler | undefined;
}

export class SqliteLiquidityInventory implements IReconciledLiquidityInventory {
  private readonly persistence: SqlitePersistence;
  private reconciler?: ChainInventoryReconciler | undefined;

  constructor(
    persistence: SqlitePersistence,
    initialBalancesOrOptions?: Record<string, bigint> | SqliteLiquidityInventoryOptions,
    options?: SqliteLiquidityInventoryOptions
  ) {
    this.persistence = persistence;
    if (initialBalancesOrOptions && 'reconciler' in initialBalancesOrOptions) {
      this.reconciler = (initialBalancesOrOptions as SqliteLiquidityInventoryOptions).reconciler;
    } else {
      this.reconciler = options?.reconciler;
      if (initialBalancesOrOptions) {
        for (const [token, amt] of Object.entries(initialBalancesOrOptions as Record<string, bigint>)) {
          this.setConfirmedBalance(token, amt);
        }
      }
    }
  }

  public getPersistence(): SqlitePersistence {
    return this.persistence;
  }

  public setReconciler(reconciler: ChainInventoryReconciler): void {
    this.reconciler = reconciler;
  }

  public getReconciler(): ChainInventoryReconciler | undefined {
    return this.reconciler;
  }

  public async getReadinessState(tokenAddress?: string): Promise<InventoryReadinessState> {
    if (this.reconciler) {
      return this.reconciler.getReadinessState(tokenAddress);
    }
    const token = (tokenAddress ?? '0x0000000000000000000000000000000000000000').toLowerCase();
    const state = this.persistence.getInventoryReadinessState(token);
    if (state === 'NOT_READY' && (!this.reconciler || this.persistence.isLegacyFallbackEnabled())) {
      const legacy = this.persistence.getConfirmedOperatorBalance(token);
      if (legacy > 0n) {
        return 'READY';
      }
    }
    return state;
  }

  public async getSafeHeadroom(tokenAddress: string): Promise<bigint> {
    if (this.reconciler) {
      return this.reconciler.getSafeHeadroom(tokenAddress);
    }
    return this.persistence.getSafeHeadroom(tokenAddress);
  }

  public async reconcile(tokenAddress?: string): Promise<{
    readinessState: InventoryReadinessState;
    headroom: bigint;
  }> {
    if (!this.reconciler) {
      throw new Error('RECONCILER_NOT_CONFIGURED: Reconciler is required for reconciliation');
    }
    return await this.reconciler.reconcile(tokenAddress);
  }

  public async reconcileOnBoot(tokenAddress?: string): Promise<{
    readinessState: InventoryReadinessState;
    headroom: bigint;
    error?: string;
  }> {
    if (!this.reconciler) {
      throw new Error(
        'RECONCILER_NOT_CONFIGURED: SqliteLiquidityInventory requires a ChainInventoryReconciler for startup reconciliation'
      );
    }
    return await this.reconciler.reconcileOnBoot(tokenAddress);
  }

  async reserve(
    amountUnits: bigint,
    tokenAddress: string,
    executionId?: string
  ): Promise<{ reservationId: string; reserved: boolean }> {
    if (this.reconciler) {
      const state = this.reconciler.getReadinessState(tokenAddress);
      if (state !== 'READY') {
        if (state === 'DEFICIT') {
          throw new LiquidityDeficitError(`Operator inventory is in DEFICIT for token ${tokenAddress}`);
        } else if (state === 'UNKNOWN' || state === 'DEGRADED') {
          throw new EvmInventoryUnavailableError(`Operator inventory state is ${state} for token ${tokenAddress}`);
        } else {
          throw new InventoryNotReadyError(`Operator inventory is ${state} for token ${tokenAddress}`);
        }
      }
    }
    const execId = executionId ?? `anon_${randomUUID()}`;
    return this.persistence.reserveLiquidity(execId, tokenAddress, amountUnits, {
      allowLegacyFallback: !this.reconciler,
    });
  }

  async release(reservationId: string): Promise<void> {
    this.persistence.releaseLiquidityReservation(reservationId);
  }

  async commit(reservationId: string): Promise<void> {
    this.persistence.commitLiquidityReservation(reservationId);
  }

  async settle(reservationId: string): Promise<void> {
    this.persistence.settleLiquidityReservation(reservationId);
  }

  async restoreRefund(reservationId: string): Promise<void> {
    this.persistence.restoreRefundLiquidityReservation(reservationId);
  }

  async getAvailableBalance(tokenAddress: string): Promise<bigint> {
    const snapshot = this.persistence.getLatestChainInventorySnapshot(tokenAddress);
    if (snapshot) {
      return this.persistence.getSafeHeadroom(tokenAddress);
    }
    return this.persistence.getAvailableOperatorBalance(tokenAddress);
  }

  async getConfirmedBalance(tokenAddress: string): Promise<bigint> {
    return this.persistence.getConfirmedOperatorBalance(tokenAddress);
  }

  async getReservedBalance(tokenAddress: string): Promise<bigint> {
    return this.persistence.getReservedOperatorBalance(tokenAddress);
  }

  async getCommittedBalance(tokenAddress: string): Promise<bigint> {
    return this.persistence.getCommittedOperatorBalance(tokenAddress);
  }

  setConfirmedBalance(tokenAddress: string, amount: bigint): void {
    this.persistence.setConfirmedOperatorBalance(tokenAddress, amount);
  }

  getReservation(reservationId: string): LiquidityReservationRecord | null {
    return this.persistence.getLiquidityReservation(reservationId);
  }

  getReservationByExecutionId(executionId: string): LiquidityReservationRecord | null {
    return this.persistence.getLiquidityReservationByExecutionId(executionId);
  }
}
