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

/**
 * Raised only when an authoritative Lightning lookup proves that an invoice
 * does not exist. Transport, authentication, and protocol failures must never
 * be converted to this error.
 */
export class LightningInvoiceNotFoundError extends Error {
  public readonly code = 'LIGHTNING_INVOICE_NOT_FOUND';

  constructor(paymentHash: PaymentHash) {
    super(`LIGHTNING_INVOICE_NOT_FOUND: Invoice not found for payment hash ${paymentHash}`);
    this.name = 'LightningInvoiceNotFoundError';
  }
}

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
  htlcId?: string | undefined;
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

export const LiquidityReservationStatus = {
  RESERVED: 'RESERVED',
  COMMITTED: 'COMMITTED',
  RELEASED: 'RELEASED',
  SETTLED: 'SETTLED',
} as const;

export type LiquidityReservationStatus =
  (typeof LiquidityReservationStatus)[keyof typeof LiquidityReservationStatus];

export const InventoryReadinessState = {
  NOT_READY: 'NOT_READY',
  RECONCILING: 'RECONCILING',
  READY: 'READY',
  DEFICIT: 'DEFICIT',
  UNKNOWN: 'UNKNOWN',
  DEGRADED: 'DEGRADED',
} as const;

export type InventoryReadinessState =
  (typeof InventoryReadinessState)[keyof typeof InventoryReadinessState];

export class InventoryNotReadyError extends Error {
  public readonly code = 'INVENTORY_NOT_READY';
  constructor(message: string = 'Operator inventory is not ready for swap quotation or reservation') {
    super(`INVENTORY_NOT_READY: ${message}`);
    this.name = 'InventoryNotReadyError';
  }
}

export class LiquidityDeficitError extends Error {
  public readonly code = 'LIQUIDITY_DEFICIT';
  constructor(message: string = 'Operator inventory is in deficit: safe wallet capacity is less than obligations') {
    super(`LIQUIDITY_DEFICIT: ${message}`);
    this.name = 'LiquidityDeficitError';
  }
}

export class EvmInventoryUnavailableError extends Error {
  public readonly code = 'EVM_INVENTORY_UNAVAILABLE';
  constructor(message: string = 'Base RPC or EVM inventory state is unavailable, degraded, or stale') {
    super(`EVM_INVENTORY_UNAVAILABLE: ${message}`);
    this.name = 'EvmInventoryUnavailableError';
  }
}

export interface ChainCapacityObservation {
  tokenAddress: string;
  chainId: number;
  operatorAddress: string;
  walletBalanceLatest: bigint;
  walletBalanceFinalized: bigint;
  safeWalletCapacity: bigint;
  latestBlockNumber: number;
  finalizedBlockNumber: number;
  blockHash?: string | undefined;
  observedAt: Date;
}

export interface ChainInventorySnapshot {
  tokenAddress: string;
  chainId: number;
  operatorAddress: string;
  walletBalanceLatest: bigint;
  walletBalanceFinalized: bigint;
  safeWalletCapacity: bigint;
  latestBlockNumber: number;
  finalizedBlockNumber: number;
  blockHash?: string | undefined;
  readinessState: InventoryReadinessState;
  observedAt: Date;
  freshUntil?: Date | undefined;
  updatedAt: Date;
}

export interface BaseInventoryReconciliationPolicy {
  maxFreshnessMs: number;
  requiredConfirmations: number;
  reorgLagTolerance: number;
  failClosedOnDeficit: boolean;
}

/**
 * Explicit Base Sepolia TEST policy.
 * NEVER to be used silently as future production policy.
 */
export const BASE_SEPOLIA_TEST_POLICY: BaseInventoryReconciliationPolicy = {
  maxFreshnessMs: 60_000, // 60 seconds
  requiredConfirmations: 2, // Matches Base Sepolia test policy
  reorgLagTolerance: 3,
  failClosedOnDeficit: true,
};

// Backwards-compatible alias for test transitions
export const DEFAULT_INVENTORY_RECONCILIATION_POLICY = BASE_SEPOLIA_TEST_POLICY;

export interface IChainCapacityProvider {
  observeWalletCapacity(tokenAddress: string): Promise<ChainCapacityObservation>;
  verifyChainAndToken(expectedChainId: number, tokenAddress: string): Promise<{ valid: boolean; reason?: string }>;
  getContractHtlcState?(htlcId: string): Promise<any>;
}

export interface ILiquidityInventory {
  reserve(
    amountUnits: bigint,
    tokenAddress: string,
    executionId?: string
  ): Promise<{ reservationId: string; reserved: boolean }>;

  release(reservationId: string): Promise<void>;

  commit(reservationId: string): Promise<void>;

  getAvailableBalance(tokenAddress: string): Promise<bigint>;

  restoreRefund?(reservationId: string): Promise<void>;

  getConfirmedBalance?(tokenAddress: string): Promise<bigint>;
  getReservedBalance?(tokenAddress: string): Promise<bigint>;
  getCommittedBalance?(tokenAddress: string): Promise<bigint>;
  getReadinessState?(tokenAddress?: string): Promise<InventoryReadinessState>;
  getSafeHeadroom?(tokenAddress: string): Promise<bigint>;
  reconcile?(tokenAddress?: string): Promise<any>;
  reconcileOnBoot?(tokenAddress?: string): Promise<any>;
}

/**
 * Mandatory production-grade inventory interface with typed startup reconciliation (FF-1).
 */
export interface IReconciledLiquidityInventory extends ILiquidityInventory {
  reconcileOnBoot(tokenAddress?: string): Promise<{
    readinessState: InventoryReadinessState;
    headroom: bigint;
    error?: string;
  }>;
  reconcile(tokenAddress?: string): Promise<{
    readinessState: InventoryReadinessState;
    headroom: bigint;
  }>;
  getReadinessState(tokenAddress?: string): Promise<InventoryReadinessState>;
  getSafeHeadroom(tokenAddress: string): Promise<bigint>;
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

export const TERMINAL_SOVEREIGN_ATOMIC_STATES: ReadonlySet<SovereignAtomicState> = new Set([
  SovereignAtomicState.COMPLETED,
  SovereignAtomicState.REFUNDED,
  SovereignAtomicState.INVOICE_CANCELED,
  SovereignAtomicState.EXPIRED,
]);

export function isNonTerminalSovereignAtomicState(state: SovereignAtomicState): boolean {
  return !TERMINAL_SOVEREIGN_ATOMIC_STATES.has(state);
}


export interface SovereignExecutionRecord {
  id: string;
  idempotencyKey: string;
  hashLock: HashLock;
  claimingAddress: string;
  targetDestinationAddress: string;
  amountSats: bigint;
  expectedUsdcAmount: bigint;
  state: SovereignAtomicState;
  reservationId?: string | undefined;
  reservedAmountUnits?: bigint | undefined;
  reservationStatus?: LiquidityReservationStatus | undefined;
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
  fundRetryCount?: number | undefined;
  settleRetryCount?: number | undefined;
  refundRetryCount?: number | undefined;
  cancelRetryCount?: number | undefined;
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
