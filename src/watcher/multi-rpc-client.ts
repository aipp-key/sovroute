/**
 * SovRoute — Sovereign Cross-Rail Settlement Infrastructure
 * Multi-RPC Resilient Client with Failover & Health Tracking
 */

import {
  createPublicClient,
  http,
  type Log,
  type BlockNumber,
} from 'viem';
import { baseSepolia, base } from 'viem/chains';
import type { RpcEndpointStatus, RpcHealthStatus } from './types.ts';

export class AllRpcEndpointsFailedError extends Error {
  public readonly errors: Record<string, string>;

  constructor(errors: Record<string, string>) {
    super(`ALL_RPC_ENDPOINTS_FAILED: All configured RPC endpoints failed. Details: ${JSON.stringify(errors)}`);
    this.name = 'AllRpcEndpointsFailedError';
    this.errors = errors;
  }
}

export interface MultiRpcOptions {
  chainId: number;
  rpcUrls: string[];
  timeoutMs?: number;
  maxConsecutiveFailures?: number;
  cooldownMs?: number;
}

export class MultiRpcClient {
  private readonly chainId: number;
  private readonly timeoutMs: number;
  private readonly maxConsecutiveFailures: number;
  private readonly cooldownMs: number;
  private readonly endpoints: RpcEndpointStatus[];
  private readonly clientCache: Map<string, any> = new Map();
  private activeIndex: number = 0;

  constructor(options: MultiRpcOptions) {
    if (!options.rpcUrls || options.rpcUrls.length === 0) {
      throw new Error('MULTI_RPC_INIT_ERROR: At least one RPC URL must be provided.');
    }

    this.chainId = options.chainId;
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 2;
    this.cooldownMs = options.cooldownMs ?? 30_000;

    this.endpoints = options.rpcUrls.map((url) => ({
      url,
      status: 'HEALTHY' as RpcHealthStatus,
      consecutiveFailures: 0,
    }));
  }

  public getActiveEndpoint(): string {
    return this.endpoints[this.activeIndex].url;
  }

  public getEndpointStatuses(): RpcEndpointStatus[] {
    return this.endpoints.map((ep) => ({ ...ep }));
  }

  private getViemClient(url: string): any {
    let client = this.clientCache.get(url);
    if (!client) {
      const chain = this.chainId === 8453 ? base : baseSepolia;
      client = createPublicClient({
        chain,
        transport: http(url, {
          timeout: this.timeoutMs,
          retryCount: 1,
        }),
        cacheTime: 0,
      });
      this.clientCache.set(url, client);
    }
    return client;
  }

  /**
   * Executes an RPC operation with automatic failover to healthy alternatives.
   */
  public async executeWithFailover<T>(
    operationName: string,
    operation: (client: any) => Promise<T>
  ): Promise<T> {
    const errorLog: Record<string, string> = {};
    const totalEndpoints = this.endpoints.length;
    const now = Date.now();

    // Check cooldown for down/degraded endpoints
    for (const ep of this.endpoints) {
      if (ep.status !== 'HEALTHY' && ep.lastFailureTime) {
        if (now - ep.lastFailureTime > this.cooldownMs) {
          ep.status = 'HEALTHY';
          ep.consecutiveFailures = 0;
        }
      }
    }

    for (let attempt = 0; attempt < totalEndpoints; attempt++) {
      const candidateIndex = (this.activeIndex + attempt) % totalEndpoints;
      const candidate = this.endpoints[candidateIndex];

      // If marked DOWN and still within cooldown, skip unless all are down
      if (candidate.status === 'DOWN') {
        const anyHealthy = this.endpoints.some((e) => e.status !== 'DOWN');
        if (anyHealthy) {
          continue;
        }
      }

      const client = this.getViemClient(candidate.url);
      const startTime = Date.now();

      try {
        const result = await operation(client);
        
        // Success: record latency and restore health
        candidate.status = 'HEALTHY';
        candidate.consecutiveFailures = 0;
        candidate.lastSuccessfulCheck = Date.now();
        candidate.lastLatencyMs = Date.now() - startTime;
        this.activeIndex = candidateIndex;

        return result;
      } catch (err: any) {
        const elapsed = Date.now() - startTime;
        candidate.consecutiveFailures++;
        candidate.lastFailureTime = Date.now();
        candidate.lastLatencyMs = elapsed;

        const isRateLimit = err?.message?.includes('429') || err?.message?.includes('rate limit');
        const isNetworkErr =
          err?.name === 'TimeoutError' ||
          err?.message?.includes('fetch failed') ||
          err?.message?.includes('timeout') ||
          err?.message?.includes('502') ||
          err?.message?.includes('503');

        if (candidate.consecutiveFailures >= this.maxConsecutiveFailures || isRateLimit || isNetworkErr) {
          candidate.status = isRateLimit ? 'DEGRADED' : 'DOWN';
        }

        errorLog[candidate.url] = `[${operationName}] ${err?.message || String(err)}`;
      }
    }

    throw new AllRpcEndpointsFailedError(errorLog);
  }

  public async getBlockNumber(): Promise<bigint> {
    return this.executeWithFailover('getBlockNumber', (client) => client.getBlockNumber());
  }

  public async getLogs(params: {
    address: `0x${string}`;
    event?: any;
    events?: any;
    args?: any;
    fromBlock: bigint | BlockNumber;
    toBlock: bigint | BlockNumber;
  }): Promise<Log[]> {
    return this.executeWithFailover('getLogs', (client) =>
      client.getLogs({
        address: params.address,
        event: params.event,
        events: params.events,
        args: params.args,
        fromBlock: params.fromBlock,
        toBlock: params.toBlock,
      })
    );
  }

  public async getTransactionReceipt(hash: `0x${string}`) {
    return this.executeWithFailover('getTransactionReceipt', (client) =>
      client.getTransactionReceipt({ hash })
    );
  }

  public async readContract(params: {
    address: `0x${string}`;
    abi: any;
    functionName: string;
    args?: any[];
  }) {
    return this.executeWithFailover('readContract', (client) =>
      client.readContract({
        address: params.address,
        abi: params.abi,
        functionName: params.functionName,
        args: params.args as any,
      })
    );
  }
}
