/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * EVM HTLC Domain & Evidence Types (Phase 3)
 *
 * Implements SEC-1, SEC-5, SEC-10, SEC-14, SEC-21, EVM-SEC-1..18
 */

import type { HashLock } from '../types.ts';

export type EvmHtlcStatus = 'EMPTY' | 'LOCKED' | 'CLAIMED' | 'REFUNDED';

export interface EvmHtlcContractRecord {
  readonly htlcId: string; // 0x-prefixed 32-byte hex
  readonly hashLock: HashLock;
  readonly amount: bigint;
  readonly token: string; // checksummed address
  readonly sender: string; // funder/operator
  readonly claimAddress: string; // client claiming address
  readonly refundAddress: string; // operator refund address
  readonly timelock: number; // unix timestamp seconds
  readonly status: EvmHtlcStatus;
}

export interface EvmHtlcFundedEvidence {
  readonly evidenceType: 'EVM_HTLC_FUNDED';
  readonly chainId: number;
  readonly contractAddress: string;
  readonly htlcId: string;
  readonly hashLock: HashLock;
  readonly token: string;
  readonly amount: bigint;
  readonly claimAddress: string;
  readonly refundAddress: string;
  readonly timelock: number;
  readonly txHash: string;
  readonly blockNumber: number;
  readonly blockTimestamp: number;
  readonly observedAt: Date;
}

export type EvmClaimFinalityState =
  | 'EVM_CLAIM_DETECTED'
  | 'EVM_CLAIM_CONFIRMED'
  | 'FINAL_ENOUGH_FOR_PROTOCOL'
  | 'INSUFFICIENT_CONFIRMATIONS';

export interface EvmHtlcClaimedEvidence {
  readonly evidenceType: 'EVM_HTLC_CLAIMED';
  readonly chainId: number;
  readonly contractAddress: string;
  readonly htlcId: string;
  readonly hashLock: HashLock;
  readonly preimageRevealed: string; // 32-byte hex (public on-chain evidence)
  readonly claimAddress: string;
  readonly amount: bigint;
  readonly txHash: string;
  readonly blockNumber: number;
  readonly blockTimestamp: number;
  readonly confirmations: number;
  readonly finalityState: EvmClaimFinalityState;
  readonly observedAt: Date;
}

export interface EvmHtlcRefundedEvidence {
  readonly evidenceType: 'EVM_HTLC_REFUNDED';
  readonly chainId: number;
  readonly contractAddress: string;
  readonly htlcId: string;
  readonly swapKey?: string | undefined;
  readonly hashLock?: HashLock | undefined;
  readonly refundAddress: string;
  readonly amount?: bigint | undefined;
  readonly txHash: string;
  readonly blockNumber: number;
  readonly blockTimestamp: number;
  readonly confirmations?: number | undefined;
  readonly finalityState?: EvmClaimFinalityState | undefined;
  readonly observedAt: Date;
}

export type EvmHtlcEvidence =
  | EvmHtlcFundedEvidence
  | EvmHtlcClaimedEvidence
  | EvmHtlcRefundedEvidence;

export class EvmNetworkGuardError extends Error {
  constructor(message: string) {
    super(`EVM_NETWORK_GUARD_VIOLATION: ${message}`);
    this.name = 'EvmNetworkGuardError';
  }
}

export class EvmBytecodeMismatchError extends Error {
  constructor(message: string) {
    super(`EVM_BYTECODE_MISMATCH: ${message}`);
    this.name = 'EvmBytecodeMismatchError';
  }
}

export class LightningSettlementGateError extends Error {
  constructor(message: string) {
    super(`LIGHTNING_SETTLEMENT_GATE_VIOLATION: ${message}`);
    this.name = 'LightningSettlementGateError';
  }
}
