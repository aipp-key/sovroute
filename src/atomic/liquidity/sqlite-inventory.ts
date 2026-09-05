/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Durable SQLite-Backed Liquidity Inventory
 *
 * Implements ILiquidityInventory authoritatively backed by SQLite persistence.
 * Uses BEGIN IMMEDIATE for multi-process / multi-worker oversubscription safety.
 */

import { randomUUID } from 'node:crypto';
import type { ILiquidityInventory } from '../types.ts';
import type { SqlitePersistence, LiquidityReservationRecord } from '../../persistence/sqlite.ts';

export class SqliteLiquidityInventory implements ILiquidityInventory {
  private readonly persistence: SqlitePersistence;

  constructor(persistence: SqlitePersistence, initialBalances?: Record<string, bigint>) {
    this.persistence = persistence;
    if (initialBalances) {
      for (const [token, amt] of Object.entries(initialBalances)) {
        this.setConfirmedBalance(token, amt);
      }
    }
  }

  async reserve(
    amountUnits: bigint,
    tokenAddress: string,
    executionId?: string
  ): Promise<{ reservationId: string; reserved: boolean }> {
    const execId = executionId ?? `anon_${randomUUID()}`;
    return this.persistence.reserveLiquidity(execId, tokenAddress, amountUnits);
  }

  async release(reservationId: string): Promise<void> {
    this.persistence.releaseLiquidityReservation(reservationId);
  }

  async commit(reservationId: string): Promise<void> {
    this.persistence.commitLiquidityReservation(reservationId);
  }

  async restoreRefund(reservationId: string): Promise<void> {
    this.persistence.restoreRefundLiquidityReservation(reservationId);
  }

  async getAvailableBalance(tokenAddress: string): Promise<bigint> {
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
