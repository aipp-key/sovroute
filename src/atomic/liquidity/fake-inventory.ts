/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Deterministic Local Fake Liquidity Inventory
 *
 * Enforces operator inventory reservation caps.
 */

import { randomUUID } from 'node:crypto';
import type { ILiquidityInventory } from '../types.ts';

export class FakeLiquidityInventory implements ILiquidityInventory {
  private balances = new Map<string, bigint>();
  private reservations = new Map<string, { amount: bigint; tokenAddress: string }>();

  constructor(initialBalances?: Record<string, bigint>) {
    if (initialBalances) {
      for (const [token, amt] of Object.entries(initialBalances)) {
        this.balances.set(token.toLowerCase(), amt);
      }
    }
  }

  async reserve(
    amountUnits: bigint,
    tokenAddress: string
  ): Promise<{ reservationId: string; reserved: boolean }> {
    const token = tokenAddress.toLowerCase();
    const available = this.balances.get(token) ?? 0n;

    if (available < amountUnits) {
      return { reservationId: '', reserved: false };
    }

    this.balances.set(token, available - amountUnits);
    const reservationId = randomUUID();
    this.reservations.set(reservationId, { amount: amountUnits, tokenAddress: token });

    return { reservationId, reserved: true };
  }

  async release(reservationId: string): Promise<void> {
    const res = this.reservations.get(reservationId);
    if (!res) return;

    const available = this.balances.get(res.tokenAddress) ?? 0n;
    this.balances.set(res.tokenAddress, available + res.amount);
    this.reservations.delete(reservationId);
  }

  async commit(reservationId: string): Promise<void> {
    this.reservations.delete(reservationId);
  }

  async getAvailableBalance(tokenAddress: string): Promise<bigint> {
    return this.balances.get(tokenAddress.toLowerCase()) ?? 0n;
  }

  setBalance(tokenAddress: string, amount: bigint): void {
    this.balances.set(tokenAddress.toLowerCase(), amount);
  }
}
