/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Deterministic Local Fake EVM Atomic Backend
 *
 * Simulates HTLCErc20 and HTLCCoordinator smart contracts in local memory.
 * Enforces SEC-10 (claim vs refund mutual exclusion) and SEC-21 (block timestamp consensus).
 */

import { createHash } from 'node:crypto';
import type {
  IEvmAtomicBackend,
  EvmHtlcParams,
  EvmHtlcState,
  SecretPreimage,
} from '../types.ts';

interface StoredHtlc {
  params: EvmHtlcParams;
  funded: boolean;
  completed: boolean;
  refunded: boolean;
  balance: bigint;
  fundingTxHash: string;
  fundingBlockNumber: number;
}

export class FakeEvmAtomicBackend implements IEvmAtomicBackend {
  readonly backendName = 'FakeEvmAtomicBackend';
  readonly chainId = 42161; // Arbitrum One
  private htlcs = new Map<string, StoredHtlc>();
  private currentBlockTimestamp = Math.floor(Date.now() / 1000);
  private currentBlockNumber = 1000;

  async fundHtlc(
    params: EvmHtlcParams
  ): Promise<{ txHash: string; blockNumber: number; htlcId?: string }> {
    if (this.htlcs.has(params.swapKey)) {
      throw new Error(`HTLC with swapKey ${params.swapKey} already exists`);
    }

    this.currentBlockNumber++;
    const txHash = `0x${createHash('sha256').update(params.swapKey + ':fund:' + this.currentBlockNumber).digest('hex')}`;

    const stored: StoredHtlc = {
      params,
      funded: true,
      completed: false,
      refunded: false,
      balance: params.amountUnits,
      fundingTxHash: txHash,
      fundingBlockNumber: this.currentBlockNumber,
    };

    this.htlcs.set(params.swapKey, stored);
    const htlcId = `0x${createHash('sha256').update(params.swapKey).digest('hex')}`;
    return { txHash, blockNumber: this.currentBlockNumber, htlcId };
  }

  async observeHtlc(swapKey: string): Promise<EvmHtlcState> {
    const htlc = this.htlcs.get(swapKey);
    if (!htlc) {
      return {
        swapKey,
        funded: false,
        completed: false,
        refunded: false,
        balance: 0n,
        timelock: 0,
        blockTimestamp: this.currentBlockTimestamp,
      };
    }

    return {
      swapKey,
      funded: htlc.funded,
      completed: htlc.completed,
      refunded: htlc.refunded,
      balance: htlc.balance,
      timelock: htlc.params.refundLocktime,
      blockTimestamp: this.currentBlockTimestamp,
    };
  }

  async claimHtlc(params: {
    swapKey: string;
    preimage: SecretPreimage;
    destination: string;
    signature?: string;
    dexCalldata?: string;
  }): Promise<{ txHash: string; blockNumber: number; success: boolean }> {
    const htlc = this.htlcs.get(params.swapKey);
    if (!htlc || !htlc.funded) {
      throw new Error(`HTLC ${params.swapKey} does not exist or is not funded`);
    }

    if (htlc.completed) {
      throw new Error(`HTLC ${params.swapKey} is already claimed`);
    }

    if (htlc.refunded) {
      throw new Error(`HTLC ${params.swapKey} is already refunded (SEC-10 violation: mutual exclusion)`);
    }

    // Verify SHA-256(preimage) == hashLock
    const rawPreimage = params.preimage.startsWith('0x')
      ? Buffer.from(params.preimage.slice(2), 'hex')
      : Buffer.from(params.preimage, 'hex');

    const computedHash = '0x' + createHash('sha256').update(rawPreimage).digest('hex').toLowerCase();
    const expectedHash = htlc.params.hashLock.toLowerCase();

    if (computedHash !== expectedHash) {
      throw new Error(`Invalid preimage: computed hash ${computedHash} does not match hashlock ${expectedHash}`);
    }

    this.currentBlockNumber++;
    const txHash = `0x${createHash('sha256').update(params.swapKey + ':claim:' + this.currentBlockNumber).digest('hex')}`;

    htlc.completed = true;
    htlc.balance = 0n;

    return { txHash, blockNumber: this.currentBlockNumber, success: true };
  }

  async refundHtlc(
    swapKey: string
  ): Promise<{ txHash: string; blockNumber: number; refunded: boolean }> {
    const htlc = this.htlcs.get(swapKey);
    if (!htlc || !htlc.funded) {
      throw new Error(`HTLC ${swapKey} does not exist or is not funded`);
    }

    if (htlc.completed) {
      throw new Error(`HTLC ${swapKey} is already completed/claimed (SEC-10 violation: mutual exclusion)`);
    }

    if (htlc.refunded) {
      throw new Error(`HTLC ${swapKey} is already refunded`);
    }

    // Check SEC-21: Block timestamp must be >= refundLocktime
    if (this.currentBlockTimestamp < htlc.params.refundLocktime) {
      throw new Error(
        `Timelock not expired: current block timestamp ${this.currentBlockTimestamp} < locktime ${htlc.params.refundLocktime}`
      );
    }

    this.currentBlockNumber++;
    const txHash = `0x${createHash('sha256').update(swapKey + ':refund:' + this.currentBlockNumber).digest('hex')}`;

    htlc.refunded = true;
    htlc.balance = 0n;

    return { txHash, blockNumber: this.currentBlockNumber, refunded: true };
  }

  async getBlockTimestamp(): Promise<number> {
    return this.currentBlockTimestamp;
  }

  // --- Test Simulation Methods ---

  setBlockTimestamp(ts: number): void {
    this.currentBlockTimestamp = ts;
  }

  advanceTime(seconds: number): void {
    this.currentBlockTimestamp += seconds;
  }
}
