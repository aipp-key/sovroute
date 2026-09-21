/**
 * SovRoute — Sovereign Cross-Rail Settlement Infrastructure
 * Idempotent & Fail-Closed Lightning Settlement Handler
 */

import type { ILightningAtomicBackend, HashLock } from '../atomic/types.ts';
import { AuthorizedSettlementPreimage } from '../atomic/types.ts';
import type { HtlcClaimedEvent, SettlementResult } from './types.ts';

export class SettlementHandler {
  private readonly lightning: ILightningAtomicBackend;
  private readonly settledHashLocks: Set<string> = new Set();

  constructor(lightning: ILightningAtomicBackend) {
    this.lightning = lightning;
  }

  /**
   * Processes a verified on-chain HtlcClaimed event idempotently.
   */
  public async handleClaimEvent(event: HtlcClaimedEvent): Promise<SettlementResult> {
    const cleanHashLock = event.hashLock.replace(/^0x/, '').toLowerCase();

    // 1. Check local idempotency cache
    if (this.settledHashLocks.has(cleanHashLock)) {
      return {
        outcome: 'ALREADY_SETTLED',
        hashLock: event.hashLock,
        htlcId: event.htlcId,
      };
    }

    // 2. Independent Cryptographic Validation: SHA-256(preimage) MUST equal hashLock
    let authPreimage: AuthorizedSettlementPreimage;
    try {
      authPreimage = new AuthorizedSettlementPreimage(event.preimage);
    } catch (err: any) {
      return {
        outcome: 'INVALID_PREIMAGE',
        hashLock: event.hashLock,
        htlcId: event.htlcId,
        error: `Malformed preimage format: ${err?.message}`,
      };
    }

    if (!authPreimage.matchesHashLock(event.hashLock)) {
      return {
        outcome: 'INVALID_PREIMAGE',
        hashLock: event.hashLock,
        htlcId: event.htlcId,
        error: `Cryptographic mismatch: SHA-256(preimage) does not equal hashLock ${event.hashLock}`,
      };
    }

    // 3. Inspect LND state first (idempotent lookup)
    try {
      const state = await this.lightning.getInvoiceState(cleanHashLock);
      if (state === 'SETTLED') {
        this.settledHashLocks.add(cleanHashLock);
        return {
          outcome: 'ALREADY_SETTLED',
          hashLock: event.hashLock,
          htlcId: event.htlcId,
          settledAt: new Date(),
        };
      }
    } catch (err) {
      // Invoice state lookup failed; continue to settlement attempt
    }

    // 4. Settle Lightning Hold Invoice
    try {
      const settleRes = await this.lightning.settleHoldInvoice(authPreimage.getRawHex());
      this.settledHashLocks.add(cleanHashLock);

      return {
        outcome: 'SETTLED',
        hashLock: event.hashLock,
        htlcId: event.htlcId,
        settledAt: settleRes.settledAt || new Date(),
      };
    } catch (err: any) {
      // Reconcile ambiguity: check if settlement actually succeeded despite transport error
      try {
        const state = await this.lightning.getInvoiceState(cleanHashLock);
        if (state === 'SETTLED') {
          this.settledHashLocks.add(cleanHashLock);
          return {
            outcome: 'ALREADY_SETTLED',
            hashLock: event.hashLock,
            htlcId: event.htlcId,
            settledAt: new Date(),
          };
        }
      } catch {
        // Ignore secondary error
      }

      return {
        outcome: 'SETTLEMENT_FAILED_CLOSED',
        hashLock: event.hashLock,
        htlcId: event.htlcId,
        error: err?.message || String(err),
      };
    }
  }

  public isSettled(hashLock: HashLock): boolean {
    return this.settledHashLocks.has(hashLock.replace(/^0x/, '').toLowerCase());
  }
}
