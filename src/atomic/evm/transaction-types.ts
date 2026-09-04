/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Phase 5A: Base Transaction Reliability Types & Policy Model
 *
 * Implements strict separation between:
 * - Logical Transaction Intent: Represents the immutable economic action.
 * - Physical Transaction Attempt: Represents an individual signed/broadcast EVM transaction.
 */

import type { Hex } from 'viem';

export const EvmLogicalIntentState = {
  CREATED: 'CREATED',
  NONCE_RESERVED: 'NONCE_RESERVED',
  DISPATCHING: 'DISPATCHING',
  PENDING: 'PENDING',
  CONFIRMED: 'CONFIRMED',
  REVERTED: 'REVERTED',
  FEE_CAP_BLOCKED: 'FEE_CAP_BLOCKED',
  NONCE_CONFLICT: 'NONCE_CONFLICT',
  FAILED: 'FAILED',
} as const;

export type EvmLogicalIntentState = (typeof EvmLogicalIntentState)[keyof typeof EvmLogicalIntentState];

export const EvmPhysicalAttemptStatus = {
  PREPARED: 'PREPARED',
  BROADCAST: 'BROADCAST',
  MINED_SUCCESS: 'MINED_SUCCESS',
  MINED_REVERT: 'MINED_REVERT',
  SUPERSEDED: 'SUPERSEDED',
  NOT_FOUND: 'NOT_FOUND',
} as const;

export type EvmPhysicalAttemptStatus = (typeof EvmPhysicalAttemptStatus)[keyof typeof EvmPhysicalAttemptStatus];

export interface BaseTransactionPolicy {
  /** Minimum percentage bump for maxPriorityFeePerGas (e.g. 10 for 10% EIP-1559 compliance) */
  minPriorityFeeBumpPercent: number;
  /** Maximum number of fee replacements allowed per logical intent (e.g. 3) */
  maxReplacements: number;
  /** Hard cap on maxFeePerGas in wei (e.g. 50 gwei) */
  maxFeePerGasCapWei: bigint;
  /** Hard cap on maxPriorityFeePerGas in wei (e.g. 10 gwei) */
  maxPriorityFeePerGasCapWei: bigint;
  /** Hard cap on gasLimit (e.g. 1,000,000) */
  maxGasLimitCap: bigint;
  /** Hard cap on worst-case transaction cost (gasLimit * maxFee + value) in wei (e.g. 0.05 ETH) */
  maxWorstCaseCostWeiCap: bigint;
  /** Number of confirmations required to treat receipt as final */
  requiredConfirmations: number;
  /** Age in milliseconds after which a pending attempt is eligible for fee replacement */
  stalledAgeMs: number;
}

export const DEFAULT_BASE_TRANSACTION_POLICY: BaseTransactionPolicy = {
  minPriorityFeeBumpPercent: 10,
  maxReplacements: 3,
  maxFeePerGasCapWei: 50_000_000_000n, // 50 gwei
  maxPriorityFeePerGasCapWei: 10_000_000_000n, // 10 gwei
  maxGasLimitCap: 1_000_000n,
  maxWorstCaseCostWeiCap: 50_000_000_000_000_000n, // 0.05 ETH
  requiredConfirmations: 2,
  stalledAgeMs: 15_000, // 15 seconds
};

export interface EvmLogicalIntent {
  id: string;
  swapKey: string;
  chainId: number;
  signerAddress: `0x${string}`;
  nonce: number | null;
  actionType: 'FUND' | 'REFUND' | 'APPROVE';
  targetAddress: `0x${string}`;
  calldataFingerprint: Hex;
  calldata?: Hex;
  valueWei: bigint;
  status: EvmLogicalIntentState;
  canonicalTxHash: Hex | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EvmPhysicalAttempt {
  id: string;
  intentId: string;
  attemptNumber: number;
  chainId: number;
  signerAddress: `0x${string}`;
  nonce: number;
  txHash: Hex;
  toAddress: `0x${string}`;
  valueWei: bigint;
  data: Hex;
  calldataFingerprint: Hex;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  status: EvmPhysicalAttemptStatus;
  minedBlockNumber: number | null;
  receiptStatus: number | null;
  broadcastAt: string;
  reconciledAt: string | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface CreateIntentParams {
  swapKey: string;
  chainId: number;
  signerAddress: `0x${string}`;
  actionType: 'FUND' | 'REFUND' | 'APPROVE';
  targetAddress: `0x${string}`;
  calldata: Hex;
  valueWei?: bigint;
}

export interface PrepareAttemptParams {
  intentId: string;
  attemptNumber: number;
  chainId: number;
  signerAddress: `0x${string}`;
  nonce: number;
  txHash: Hex;
  toAddress: `0x${string}`;
  valueWei: bigint;
  data: Hex;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface ReconciliationOutcome {
  intentId: string;
  status: EvmLogicalIntentState;
  minedTxHash?: Hex | undefined;
  minedBlockNumber?: number | undefined;
  replacedByAttemptNumber?: number | undefined;
  reason?: string | undefined;
}
