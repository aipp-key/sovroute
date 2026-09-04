/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Sovereign Atomic Core Interfaces and Types
 *
 * Enforces SEC-1 (no user private keys), SEC-10 (claim/refund mutual exclusion),
 * SEC-11 (secret material sanitization), SEC-21 (consensus timelocks).
 */


import { createHash } from 'node:crypto';

export type HashLock = string; // 32-byte hex with 0x prefix
export type SecretPreimage = string; // 32-byte hex with 0x prefix
export type PaymentHash = string; // 32-byte hex (no 0x or with 0x)

/**
 * Secret-bearing wrapper for settlement preimages.
 * Enforces:
 * - Format validation (32-byte hex)
 * - Cryptographic matching against expected HashLock
 * - Redaction on toString()
 * - Suppression on JSON.stringify() via toJSON() => undefined
 */
export class AuthorizedSettlementPreimage {
  private readonly rawHex: string;

  constructor(preimageHex: string) {
    const clean = preimageHex.replace(/^0x/, '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(clean)) {
      throw new Error('PREIMAGE_FORMAT_ERROR: Preimage must be a 32-byte hex string');
    }
    this.rawHex = clean;
  }

  public getRawHex(): string {
    return this.rawHex;
  }

  public matchesHashLock(hashLockHex: string): boolean {
    const cleanHash = hashLockHex.replace(/^0x/, '').toLowerCase();
    const computed = createHash('sha256').update(Buffer.from(this.rawHex, 'hex')).digest('hex');
    return computed === cleanHash;
  }

  public toJSON(): undefined {
    return undefined;
  }

  public toString(): string {
    return '[REDACTED_AUTHORIZED_PREIMAGE]';
  }
}

export type HoldInvoiceState = 'OPEN' | 'ACCEPTED' | 'SETTLED' | 'CANCELED';

export interface HoldInvoice {
  paymentHash: PaymentHash;
  bolt11: string;
  amountSats: bigint;
  cltvExpiryBlocks: number;
  expiryHeight?: number | undefined;
  state: HoldInvoiceState;
  createdAt: Date;
  acceptedAt?: Date | undefined;
  settledAt?: Date | undefined;
  canceledAt?: Date | undefined;
}

export interface ILightningAtomicBackend {
  readonly backendName: string;

  createHoldInvoice(
    hashLock: HashLock,
    amountSats: bigint,
    cltvExpiryBlocks: number,
    memo?: string
  ): Promise<HoldInvoice>;

  observeHoldInvoice(paymentHash: PaymentHash): Promise<HoldInvoice>;

  settleHoldInvoice(
    preimage: SecretPreimage
  ): Promise<{ settled: boolean; settledAt: Date }>;

  cancelHoldInvoice(
    paymentHash: PaymentHash
  ): Promise<{ canceled: boolean; canceledAt: Date }>;

  getInvoiceState(paymentHash: PaymentHash): Promise<HoldInvoiceState>;

  getBlockHeight?(): Promise<number>;
}

export interface EvmHtlcParams {
  swapKey: string;
  hashLock: HashLock;
  amountUnits: bigint;
  tokenAddress: string;
  refundLocktime: number; // Unix timestamp
  claimAddress: string;
  refundAddress: string;
}

export interface EvmHtlcState {
  swapKey: string;
  funded: boolean;
  completed: boolean;
  refunded: boolean;
  balance: bigint;
  timelock: number;
  blockTimestamp: number;
}

import type { EvmHtlcClaimedEvidence, EvmHtlcRefundedEvidence } from './evm/evm-types.ts';
export type { EvmHtlcClaimedEvidence, EvmHtlcRefundedEvidence };

export interface IEvmAtomicBackend {
  readonly backendName: string;
  readonly chainId: number;

  fundHtlc(params: EvmHtlcParams): Promise<{ txHash: string; blockNumber: number; htlcId?: string }>;

  observeHtlc(swapKey: string): Promise<EvmHtlcState>;

  claimHtlc?(params: {
    swapKey: string;
    preimage: SecretPreimage;
    destination: string;
    signature?: string;
    dexCalldata?: string;
  }): Promise<{ txHash: string; blockNumber: number; success: boolean }>;

  extractAndVerifyClaimEvidence?(params: {
    claimTxHash: string;
    expectedHtlcId: string;
    expectedHashLock: string;
    expectedClaimAddress: string;
    expectedAmount: bigint;
    requiredConfirmations?: number;
  }): Promise<any>;

  verifyRefundEvidence?(params: {
    refundTxHash: string;
    expectedHtlcId: string;
    expectedRefundAddress: string;
    expectedAmount: bigint;
    requiredConfirmations?: number;
  }): Promise<EvmHtlcRefundedEvidence>;

  refundHtlc(swapKey: string): Promise<{ txHash: string; blockNumber: number; refunded: boolean }>;

  getBlockTimestamp(): Promise<number>;
}

export interface ILiquidityInventory {
  reserve(
    amountUnits: bigint,
    tokenAddress: string
  ): Promise<{ reservationId: string; reserved: boolean }>;

  release(reservationId: string): Promise<void>;

  commit(reservationId: string): Promise<void>;

  getAvailableBalance(tokenAddress: string): Promise<bigint>;
}

export const SovereignAtomicState = {
  PLAN_PREPARED: 'PLAN_PREPARED',
  INVOICE_CREATED: 'INVOICE_CREATED',
  LIGHTNING_HELD: 'LIGHTNING_HELD',
  EVM_FUNDING_PENDING: 'EVM_FUNDING_PENDING',
  EVM_FUNDED: 'EVM_FUNDED',
  CLAIMING: 'CLAIMING',
  EVM_CLAIM_DETECTED: 'EVM_CLAIM_DETECTED',
  EVM_CLAIM_CONFIRMED: 'EVM_CLAIM_CONFIRMED',
  LIGHTNING_SETTLEMENT_PENDING: 'LIGHTNING_SETTLEMENT_PENDING',
  LIGHTNING_SETTLED: 'LIGHTNING_SETTLED',
  DESTINATION_PENDING: 'DESTINATION_PENDING',
  COMPLETED: 'COMPLETED',

  // Recovery & Terminal states
  EXPIRED: 'EXPIRED',
  INVOICE_CANCELED: 'INVOICE_CANCELED',
  REFUND_ELIGIBLE: 'REFUND_ELIGIBLE',
  EVM_REFUND_PENDING: 'EVM_REFUND_PENDING',
  EVM_REFUND_CONFIRMED: 'EVM_REFUND_CONFIRMED',
  LIGHTNING_CANCEL_PENDING: 'LIGHTNING_CANCEL_PENDING',
  REFUNDED: 'REFUNDED',
  RECOVERY_REQUIRED: 'RECOVERY_REQUIRED',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
} as const;

export type SovereignAtomicState = (typeof SovereignAtomicState)[keyof typeof SovereignAtomicState];

export interface SovereignExecutionRecord {
  id: string;
  idempotencyKey: string;
  hashLock: HashLock;
  claimingAddress: string;
  targetDestinationAddress: string;
  amountSats: bigint;
  expectedUsdcAmount: bigint;
  state: SovereignAtomicState;
  holdInvoice?: HoldInvoice | undefined;
  evmSwapKey?: string | undefined;
  evmHtlcId?: string | undefined;
  evmFundingTxHash?: string | undefined;
  evmClaimTxHash?: string | undefined;
  evmRefundTxHash?: string | undefined;
  destinationTxHash?: string | undefined;
  tokenAddress?: string | undefined;
  refundAddress?: string | undefined;
  cltvExpiryBlocks?: number | undefined;
  timelockSeconds?: number | undefined;
  refundLocktime?: number | undefined;
  economicFingerprint?: string | undefined;
  actionInFlight?: string | undefined;
  actionClaimedBy?: string | undefined;
  actionClaimedAt?: Date | undefined;
  actionGeneration?: number | undefined;
  recoveryRequired?: boolean | undefined;
  failureReason?: string | undefined;
  retryCount?: number | undefined;
  createdAt: Date;
  updatedAt: Date;
}

export interface SovereignSwapTransition {
  id: string;
  swapId: string;
  fromState?: SovereignAtomicState | undefined;
  toState: SovereignAtomicState;
  reason: string;
  evidenceId?: string | undefined;
  metadataJson?: string | undefined;
  createdAt: Date;
}
