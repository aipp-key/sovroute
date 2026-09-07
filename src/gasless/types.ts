/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Gasless Base UX Type Definitions (EIP-712 & Relayer Model)
 */

import type { SovereignQuote } from '../pricing/types.ts';

export type HexAddress = `0x${string}`;
export type HexSignature = `0x${string}`;
export type HexHash = `0x${string}`;

export interface Eip712DomainConfig {
  readonly name: string;
  readonly version: string;
  readonly chainId: number | bigint;
  readonly verifyingContract: HexAddress;
}

export interface SwapAuthorizationMessage {
  readonly swapper: HexAddress;
  readonly destination: HexAddress;
  readonly amountUsdcAtomic: bigint;
  readonly amountSats: bigint;
  readonly quoteId: string;
  readonly nonce: bigint;
  readonly deadline: bigint; // Unix timestamp in seconds
}

export interface SignedSwapAuthorization {
  readonly message: SwapAuthorizationMessage;
  readonly signature: HexSignature;
}

export type RelayerExecutionStatus =
  | 'SUBMITTED'
  | 'CONFIRMED'
  | 'AMBIGUOUS_TIMEOUT'
  | 'FAILED';

export interface RelayerSubmissionRequest {
  readonly authorization: SignedSwapAuthorization;
  readonly quote: SovereignQuote;
  readonly idempotencyKey: string;
}

export interface RelayerExecutionResult {
  readonly idempotencyKey: string;
  readonly status: RelayerExecutionStatus;
  readonly txHash?: HexHash | undefined;
  readonly blockNumber?: bigint | undefined;
  readonly nonce: bigint;
  readonly swapper: HexAddress;
  readonly destination: HexAddress;
  readonly amountUsdcAtomic: bigint;
  readonly amountSats: bigint;
  readonly error?: string | undefined;
  readonly submittedAtMs: number;
  readonly confirmedAtMs?: number | undefined;
}

export interface OnchainContractCall {
  to: HexAddress;
  data: `0x${string}`;
  value?: bigint | undefined;
}

export interface IOnchainBroadcaster {
  broadcastTransaction(call: OnchainContractCall): Promise<{
    txHash: HexHash;
    waitForReceipt: () => Promise<{ blockNumber: bigint; status: 'success' | 'reverted' }>;
  }>;
  getTransactionReceipt(txHash: HexHash): Promise<{ blockNumber: bigint; status: 'success' | 'reverted' } | null>;
}
