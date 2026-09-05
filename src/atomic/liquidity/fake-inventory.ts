/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Deterministic Local Fake Liquidity Inventory
 *
 * Enforces operator inventory reservation caps.
 */

import { randomUUID } from 'node:crypto';
import type { IReconciledLiquidityInventory, InventoryReadinessState } from '../types.ts';
import { OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS } from '../evm/base-guard.ts';

export interface FakeReservationRecord {
  id: string;
  executionId?: string | undefined;
  amount: bigint;
  tokenAddress: string;
  status: 'RESERVED' | 'COMMITTED' | 'RELEASED';
}

export class FakeLiquidityInventory implements IReconciledLiquidityInventory {
  private balances = new Map<string, bigint>();
  private reservations = new Map<string, FakeReservationRecord>();

  constructor(initialBalances?: Record<string, bigint>) {
    if (initialBalances) {
      for (const [token, amt] of Object.entries(initialBalances)) {
        this.balances.set(token.toLowerCase(), amt);
        if (token.toLowerCase() === '0x6c84a8f1c29108f47a79964b5fe888d4f4d0de40') {
          this.balances.set(OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS.toLowerCase(), amt);
        }
      }
    }
  }

  async reserve(
    amountUnits: bigint,
    tokenAddress: string,
    executionId?: string
  ): Promise<{ reservationId: string; reserved: boolean }> {
    if (amountUnits <= 0n) {
      return { reservationId: '', reserved: false };
    }
    const token = tokenAddress.toLowerCase();

    // Idempotency: if executionId already has active/committed reservation, return it
    if (executionId) {
      for (const res of this.reservations.values()) {
        if (res.executionId === executionId && (res.status === 'RESERVED' || res.status === 'COMMITTED')) {
          return { reservationId: res.id, reserved: true };
        }
      }
    }

    const available = await this.getAvailableBalance(token);
    if (available < amountUnits) {
      return { reservationId: '', reserved: false };
    }

    const reservationId = randomUUID();
    this.reservations.set(reservationId, {
      id: reservationId,
      executionId,
      amount: amountUnits,
      tokenAddress: token,
      status: 'RESERVED',
    });

    return { reservationId, reserved: true };
  }

  async release(reservationId: string): Promise<void> {
    const res = this.reservations.get(reservationId);
    if (!res) return;
    if (res.status === 'RESERVED') {
      res.status = 'RELEASED';
    }
  }

  async commit(reservationId: string): Promise<void> {
    const res = this.reservations.get(reservationId);
    if (!res) return;
    if (res.status === 'RESERVED') {
      res.status = 'COMMITTED';
    }
  }

  async restoreRefund(reservationId: string): Promise<void> {
    const res = this.reservations.get(reservationId);
    if (!res) return;
    if (res.status === 'COMMITTED') {
      res.status = 'RELEASED';
    }
  }

  async getAvailableBalance(tokenAddress: string): Promise<bigint> {
    const token = tokenAddress.toLowerCase();
    const confirmed = this.balances.get(token) ?? 0n;
    let reserved = 0n;
    let committed = 0n;
    for (const res of this.reservations.values()) {
      if (res.tokenAddress === token) {
        if (res.status === 'RESERVED') reserved += res.amount;
        else if (res.status === 'COMMITTED') committed += res.amount;
      }
    }
    const available = confirmed - reserved - committed;
    return available > 0n ? available : 0n;
  }

  async getReservedBalance(tokenAddress: string): Promise<bigint> {
    const token = tokenAddress.toLowerCase();
    let reserved = 0n;
    for (const res of this.reservations.values()) {
      if (res.tokenAddress === token && res.status === 'RESERVED') {
        reserved += res.amount;
      }
    }
    return reserved;
  }

  async getCommittedBalance(tokenAddress: string): Promise<bigint> {
    const token = tokenAddress.toLowerCase();
    let committed = 0n;
    for (const res of this.reservations.values()) {
      if (res.tokenAddress === token && res.status === 'COMMITTED') {
        committed += res.amount;
      }
    }
    return committed;
  }

  setBalance(tokenAddress: string, amount: bigint): void {
    this.balances.set(tokenAddress.toLowerCase(), amount);
    if (tokenAddress.toLowerCase() === '0x6c84a8f1c29108f47a79964b5fe888d4f4d0de40') {
      this.balances.set(OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS.toLowerCase(), amount);
    }
  }

  async getReadinessState(_tokenAddress?: string): Promise<InventoryReadinessState> {
    return 'READY';
  }

  async getSafeHeadroom(tokenAddress: string): Promise<bigint> {
    return this.getAvailableBalance(tokenAddress);
  }

  async reconcile(
    tokenAddress?: string
  ): Promise<{ readinessState: InventoryReadinessState; headroom: bigint }> {
    const headroom = await this.getAvailableBalance(tokenAddress ?? '');
    return { readinessState: 'READY', headroom };
  }

  async reconcileOnBoot(
    tokenAddress?: string
  ): Promise<{ readinessState: InventoryReadinessState; headroom: bigint; error?: string }> {
    const headroom = await this.getAvailableBalance(tokenAddress ?? '');
    return { readinessState: 'READY', headroom };
  }
}
