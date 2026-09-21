/**
 * SovRoute — Sovereign Cross-Rail Settlement Infrastructure
 * On-Chain Watcher Domain & Configuration Types
 */

import type { HashLock, SecretPreimage } from '../atomic/types.ts';

export type RpcHealthStatus = 'HEALTHY' | 'DEGRADED' | 'DOWN';

export interface RpcEndpointConfig {
  readonly url: string;
  readonly timeoutMs?: number;
}

export interface RpcEndpointStatus {
  readonly url: string;
  status: RpcHealthStatus;
  consecutiveFailures: number;
  lastFailureTime?: number;
  lastSuccessfulCheck?: number;
  lastLatencyMs?: number;
}

export interface WatcherConfig {
  /**
   * Prioritized list of RPC URLs. Primary is tried first; fallbacks used upon failure.
   */
  readonly rpcUrls: string[];

  /**
   * Address of the deployed HtlcErc20 contract to monitor.
   */
  readonly contractAddress: string;

  /**
   * Chain ID of the EVM network (e.g. 84532 for Base Sepolia, 8453 for Base Mainnet).
   */
  readonly chainId: number;

  /**
   * Starting block for scanning. Defaults to latest block if omitted.
   */
  readonly startBlock?: bigint | number;

  /**
   * Number of block confirmations required before an event is considered final
   * and eligible for Lightning settlement. Protects against chain reorgs.
   * Default: 2 for Base L2.
   */
  readonly reorgConfirmations?: number;

  /**
   * Polling interval in milliseconds for fetching new blocks.
   * Default: 2000 ms.
   */
  readonly pollIntervalMs?: number;

  /**
   * Maximum number of blocks to scan in a single getLogs chunk.
   * Default: 1000n.
   */
  readonly maxBlockRange?: bigint;

  /**
   * Timeout per RPC request in milliseconds before triggering fallback.
   * Default: 8000 ms.
   */
  readonly rpcTimeoutMs?: number;
}

export interface HtlcClaimedEvent {
  readonly htlcId: string;
  readonly hashLock: HashLock;
  readonly preimage: SecretPreimage;
  readonly claimAddress: string;
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly txHash: string;
  readonly logIndex: number;
  readonly confirmations: number;
}

export type SettlementOutcome =
  | 'SETTLED'
  | 'ALREADY_SETTLED'
  | 'INVALID_PREIMAGE'
  | 'SETTLEMENT_FAILED_CLOSED';

export interface SettlementResult {
  readonly outcome: SettlementOutcome;
  readonly hashLock: HashLock;
  readonly htlcId: string;
  readonly settledAt?: Date;
  readonly error?: string;
}

export interface IBlockTracker {
  getLastProcessedBlock(): Promise<bigint>;
  setLastProcessedBlock(blockNumber: bigint): Promise<void>;
}
