/**
 * SovRoute — Sovereign Cross-Rail Settlement Infrastructure
 * Fail-Closed On-Chain Watcher Daemon
 */

import { parseAbiItem } from 'viem';
import { MultiRpcClient } from './multi-rpc-client.ts';
import { SettlementHandler } from './settlement-handler.ts';
import type {
  WatcherConfig,
  HtlcClaimedEvent,
  SettlementResult,
  IBlockTracker,
} from './types.ts';

const HTLC_CLAIMED_EVENT = parseAbiItem(
  'event HtlcClaimed(bytes32 indexed htlcId, bytes32 indexed hashLock, bytes preimage, address claimAddress)'
);

export class InMemoryBlockTracker implements IBlockTracker {
  private lastBlock: bigint;

  constructor(initialBlock: bigint = 0n) {
    this.lastBlock = initialBlock;
  }

  public async getLastProcessedBlock(): Promise<bigint> {
    return this.lastBlock;
  }

  public async setLastProcessedBlock(blockNumber: bigint): Promise<void> {
    this.lastBlock = blockNumber;
  }
}

export class ChainWatcher {
  private readonly config: Required<WatcherConfig>;
  private readonly multiRpc: MultiRpcClient;
  private readonly settlementHandler: SettlementHandler;
  private readonly blockTracker: IBlockTracker;
  private isRunningState: boolean = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private inFlightTick: boolean = false;

  constructor(
    config: WatcherConfig,
    settlementHandler: SettlementHandler,
    blockTracker?: IBlockTracker
  ) {
    this.config = {
      rpcUrls: config.rpcUrls,
      contractAddress: config.contractAddress,
      chainId: config.chainId,
      startBlock: config.startBlock !== undefined ? BigInt(config.startBlock) : 0n,
      reorgConfirmations: config.reorgConfirmations ?? 2,
      pollIntervalMs: config.pollIntervalMs ?? 2000,
      maxBlockRange: config.maxBlockRange ?? 1000n,
      rpcTimeoutMs: config.rpcTimeoutMs ?? 8000,
    };

    this.multiRpc = new MultiRpcClient({
      chainId: this.config.chainId,
      rpcUrls: this.config.rpcUrls,
      timeoutMs: this.config.rpcTimeoutMs,
    });

    this.settlementHandler = settlementHandler;
    this.blockTracker = blockTracker || new InMemoryBlockTracker(BigInt(this.config.startBlock));
  }

  public isRunning(): boolean {
    return this.isRunningState;
  }

  public getMultiRpc(): MultiRpcClient {
    return this.multiRpc;
  }

  public async getLastProcessedBlock(): Promise<bigint> {
    return this.blockTracker.getLastProcessedBlock();
  }

  /**
   * Starts the continuous background polling loop.
   */
  public async start(): Promise<void> {
    if (this.isRunningState) return;
    this.isRunningState = true;

    // If startBlock was unset (0n), initialize tracker to (currentTip - reorgConfirmations)
    const currentLast = await this.blockTracker.getLastProcessedBlock();
    if (currentLast === 0n) {
      try {
        const tip = await this.multiRpc.getBlockNumber();
        const initial = tip > BigInt(this.config.reorgConfirmations)
          ? tip - BigInt(this.config.reorgConfirmations)
          : tip;
        await this.blockTracker.setLastProcessedBlock(initial);
      } catch (err) {
        // Multi-RPC error at startup; will retry on first tick
      }
    }

    const poll = async () => {
      if (!this.isRunningState) return;
      try {
        await this.tick();
      } catch (err) {
        // Log tick error and fail closed; loop continues
      }
      if (this.isRunningState) {
        this.pollTimer = setTimeout(poll, this.config.pollIntervalMs);
      }
    };

    this.pollTimer = setTimeout(poll, 0);
  }

  /**
   * Stops the background polling loop.
   */
  public stop(): void {
    this.isRunningState = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Executes a single processing tick over the next available block chunk.
   * Enforces reorg depth, chunk boundaries, and fail-closed advancement.
   */
  public async tick(): Promise<{
    fromBlock: bigint;
    toBlock: bigint;
    eventsFound: number;
    settlements: SettlementResult[];
  }> {
    if (this.inFlightTick) {
      return { fromBlock: 0n, toBlock: 0n, eventsFound: 0, settlements: [] };
    }
    this.inFlightTick = true;

    try {
      const currentTip = await this.multiRpc.getBlockNumber();
      const safeTip = currentTip - BigInt(this.config.reorgConfirmations);
      const lastProcessed = await this.blockTracker.getLastProcessedBlock();

      if (safeTip <= lastProcessed) {
        // No new confirmed blocks past reorg window
        return { fromBlock: lastProcessed, toBlock: lastProcessed, eventsFound: 0, settlements: [] };
      }

      const fromBlock = lastProcessed + 1n;
      const toBlock = fromBlock + this.config.maxBlockRange - 1n < safeTip
        ? fromBlock + this.config.maxBlockRange - 1n
        : safeTip;

      const rawLogs = await this.multiRpc.getLogs({
        address: this.config.contractAddress as `0x${string}`,
        event: HTLC_CLAIMED_EVENT,
        fromBlock,
        toBlock,
      });

      const settlements: SettlementResult[] = [];
      let advanceUpToBlock = toBlock;

      for (const log of rawLogs) {
        const decoded = log as any;
        const args = decoded.args || {};

        const event: HtlcClaimedEvent = {
          htlcId: args.htlcId,
          hashLock: args.hashLock,
          preimage: args.preimage,
          claimAddress: args.claimAddress,
          blockNumber: log.blockNumber ?? fromBlock,
          blockHash: log.blockHash ?? '0x',
          txHash: log.transactionHash ?? '0x',
          logIndex: Number(log.logIndex ?? 0),
          confirmations: Number(currentTip - (log.blockNumber ?? fromBlock)) + 1,
        };

        const result = await this.settlementHandler.handleClaimEvent(event);
        settlements.push(result);

        // FAIL-CLOSED INVARIANT: If settlement fails closed, do not advance block tracker past this block!
        if (result.outcome === 'SETTLEMENT_FAILED_CLOSED') {
          advanceUpToBlock = event.blockNumber > fromBlock ? event.blockNumber - 1n : fromBlock - 1n;
          break;
        }
      }

      if (advanceUpToBlock >= fromBlock) {
        await this.blockTracker.setLastProcessedBlock(advanceUpToBlock);
      }

      return {
        fromBlock,
        toBlock: advanceUpToBlock,
        eventsFound: rawLogs.length,
        settlements,
      };
    } finally {
      this.inFlightTick = false;
    }
  }

  /**
   * Catches up on historical blocks between fromBlock and toBlock across multiple chunks.
   */
  public async catchUp(
    fromBlock?: bigint,
    toBlock?: bigint
  ): Promise<{ eventsFound: number; settlements: SettlementResult[] }> {
    const currentTip = await this.multiRpc.getBlockNumber();
    const safeTip = currentTip - BigInt(this.config.reorgConfirmations);

    let start = fromBlock ?? (await this.blockTracker.getLastProcessedBlock()) + 1n;
    const end = toBlock ?? safeTip;

    let totalEvents = 0;
    const allSettlements: SettlementResult[] = [];

    while (start <= end) {
      const chunkEnd = start + this.config.maxBlockRange - 1n < end
        ? start + this.config.maxBlockRange - 1n
        : end;

      const rawLogs = await this.multiRpc.getLogs({
        address: this.config.contractAddress as `0x${string}`,
        event: HTLC_CLAIMED_EVENT,
        fromBlock: start,
        toBlock: chunkEnd,
      });

      totalEvents += rawLogs.length;

      for (const log of rawLogs) {
        const decoded = log as any;
        const args = decoded.args || {};

        const event: HtlcClaimedEvent = {
          htlcId: args.htlcId,
          hashLock: args.hashLock,
          preimage: args.preimage,
          claimAddress: args.claimAddress,
          blockNumber: log.blockNumber ?? start,
          blockHash: log.blockHash ?? '0x',
          txHash: log.transactionHash ?? '0x',
          logIndex: Number(log.logIndex ?? 0),
          confirmations: Number(currentTip - (log.blockNumber ?? start)) + 1,
        };

        const result = await this.settlementHandler.handleClaimEvent(event);
        allSettlements.push(result);

        if (result.outcome === 'SETTLEMENT_FAILED_CLOSED') {
          await this.blockTracker.setLastProcessedBlock(event.blockNumber > start ? event.blockNumber - 1n : start - 1n);
          return { eventsFound: totalEvents, settlements: allSettlements };
        }
      }

      await this.blockTracker.setLastProcessedBlock(chunkEnd);
      start = chunkEnd + 1n;
    }

    return { eventsFound: totalEvents, settlements: allSettlements };
  }
}
