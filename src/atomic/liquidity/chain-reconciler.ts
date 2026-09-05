/**
 * UNIVERSAL AGENT ASSET ROUTER — SOVROUTE ARCHITECTURE V4
 * Phase 7 / Pre-Phase 2D: Base USDC Chain Inventory Reconciler
 *
 * Implements the authoritative reconciliation engine between onchain Base USDC reality
 * and local SQLite persistence:
 * - REC-1: Zero double deduction: committed escrows are NEVER subtracted from wallet balance.
 * - REC-2: New Lightning obligations require verified safe wallet headroom (Headroom = W_safe - R - P).
 * - REC-3: Stale or UNKNOWN chain inventory cannot authorize new swaps.
 * - REC-4: Router starts NOT_READY and cannot accept swaps before reconciliation completes.
 * - REC-5 & 6: Chain ID and canonical USDC contract identity verified fail-closed.
 * - REC-7 & 8: Asymmetric finality: deposits require finality; withdrawals reduce capacity immediately.
 * - REC-9 & 10: Active reservations and unresolved intents subtracted conservatively exactly once.
 * - REC-11 & 12: Terminal claim/refund accounting strictly preserved.
 * - REC-14: Durable swap <-> HTLC binding across process restart.
 * - REC-17: Deficit state freezes new obligation creation.
 */

import type { SqlitePersistence } from '../../persistence/sqlite.ts';
import {
  type IChainCapacityProvider,
  type ChainCapacityObservation,
  type ChainInventorySnapshot,
  type BaseInventoryReconciliationPolicy,
  DEFAULT_INVENTORY_RECONCILIATION_POLICY,
  InventoryReadinessState,
  LiquidityDeficitError,
  EvmInventoryUnavailableError,
} from '../types.ts';

export interface ChainInventoryReconcilerConfig {
  persistence: SqlitePersistence;
  capacityProvider: IChainCapacityProvider;
  defaultTokenAddress: string;
  expectedChainId?: number;
  policy?: Partial<BaseInventoryReconciliationPolicy>;
}

export class ChainInventoryReconciler {
  private readonly persistence: SqlitePersistence;
  private readonly capacityProvider: IChainCapacityProvider;
  private readonly defaultTokenAddress: string;
  private readonly expectedChainId: number;
  private readonly policy: BaseInventoryReconciliationPolicy;

  // In-memory readiness state starts NOT_READY on boot (REC-4)
  private readinessState: InventoryReadinessState = 'NOT_READY';
  private lastReconciliationTime: number = 0;
  private lastObservedSnapshot: ChainInventorySnapshot | null = null;

  constructor(config: ChainInventoryReconcilerConfig) {
    this.persistence = config.persistence;
    this.capacityProvider = config.capacityProvider;
    this.defaultTokenAddress = config.defaultTokenAddress.toLowerCase();
    this.expectedChainId = config.expectedChainId ?? 84532;
    this.policy = {
      ...DEFAULT_INVENTORY_RECONCILIATION_POLICY,
      ...config.policy,
    };
  }

  public getPolicy(): BaseInventoryReconciliationPolicy {
    return { ...this.policy };
  }

  public getLastReconciliationTime(): number {
    return this.lastReconciliationTime;
  }

  public getLastObservedSnapshot(): ChainInventorySnapshot | null {
    return this.lastObservedSnapshot;
  }

  public getReadinessState(tokenAddress?: string): InventoryReadinessState {
    const token = (tokenAddress ?? this.defaultTokenAddress).toLowerCase();

    // If in-memory state is NOT_READY or RECONCILING, always report that
    if (this.readinessState === 'NOT_READY' || this.readinessState === 'RECONCILING') {
      return this.readinessState;
    }

    // Check persistence snapshot
    const snapshot = this.persistence.getLatestChainInventorySnapshot(token);
    if (!snapshot) {
      return 'NOT_READY';
    }

    // Check freshness: if snapshot is older than policy.maxFreshnessMs, it is DEGRADED / NOT_READY (REC-3)
    const ageMs = Date.now() - snapshot.observedAt.getTime();
    if (ageMs > this.policy.maxFreshnessMs) {
      return 'DEGRADED';
    }

    if (snapshot.readinessState === 'DEFICIT') {
      return 'DEFICIT';
    }

    return this.readinessState;
  }

  /**
   * Five-Phase Reconcile-on-Boot Protocol (REC-4)
   * Must be executed before Router opens HTTP / accepts quotes.
   */
  public async reconcileOnBoot(
    tokenAddress?: string
  ): Promise<{ readinessState: InventoryReadinessState; headroom: bigint; error?: string }> {
    const token = (tokenAddress ?? this.defaultTokenAddress).toLowerCase();
    this.readinessState = 'RECONCILING';
    this.persistence.setInventoryReadinessState(token, 'RECONCILING');

    try {
      // PHASE 1: Verify Base chain identity and canonical USDC contract (REC-5, REC-6)
      const chainVerification = await this.capacityProvider.verifyChainAndToken(
        this.expectedChainId,
        token
      );
      if (!chainVerification.valid) {
        this.readinessState = 'NOT_READY';
        this.persistence.setInventoryReadinessState(token, 'NOT_READY', chainVerification.reason);
        return {
          readinessState: 'NOT_READY',
          headroom: 0n,
          error: chainVerification.reason ?? 'CHAIN_TOKEN_VERIFICATION_FAILED',
        };
      }

      // PHASE 2 & 3: In-Flight Mempool / Intent & HTLC Binding Rehydration (REC-14)
      if (typeof (this.capacityProvider as any).rehydrateBindings === 'function') {
        (this.capacityProvider as any).rehydrateBindings();
      }

      // PHASE 4: Reconcile active SQLite swaps against onchain HTLC states (REC-11, REC-12)
      await this.reconcileActiveSwaps(token);

      // PHASE 5: Query authoritative onchain wallet capacity & compute Safe Headroom (REC-1, REC-2)
      return await this.executeCapacityReconciliation(token);
    } catch (err: any) {
      const msg = String(err?.message ?? '');
      if (msg.includes('LIQUIDITY_DEFICIT')) {
        this.readinessState = 'DEFICIT';
        this.persistence.setInventoryReadinessState(token, 'DEFICIT');
        return { readinessState: 'DEFICIT', headroom: 0n, error: msg };
      }
      this.readinessState = 'UNKNOWN';
      this.persistence.setInventoryReadinessState(token, 'UNKNOWN');
      return { readinessState: 'UNKNOWN', headroom: 0n, error: msg };
    }
  }

  /**
   * Periodic or on-demand reconciliation of wallet capacity and active headroom.
   */
  public async reconcile(
    tokenAddress?: string
  ): Promise<{ readinessState: InventoryReadinessState; headroom: bigint }> {
    const token = (tokenAddress ?? this.defaultTokenAddress).toLowerCase();

    try {
      return await this.executeCapacityReconciliation(token);
    } catch (err: any) {
      const msg = String(err?.message ?? '');
      if (msg.includes('LIQUIDITY_DEFICIT')) {
        this.readinessState = 'DEFICIT';
        this.persistence.setInventoryReadinessState(token, 'DEFICIT');
        return { readinessState: 'DEFICIT', headroom: 0n };
      }
      this.readinessState = 'UNKNOWN';
      this.persistence.setInventoryReadinessState(token, 'UNKNOWN');
      return { readinessState: 'UNKNOWN', headroom: 0n };
    }
  }

  /**
   * Computes authoritative Safe Headroom for a token.
   * Safe Headroom = W_safe - R - P
   * If snapshot is stale, re-reconciles synchronously.
   */
  public async getSafeHeadroom(tokenAddress?: string): Promise<bigint> {
    const token = (tokenAddress ?? this.defaultTokenAddress).toLowerCase();

    // If not ready or stale, trigger reconciliation
    const currentReadiness = this.getReadinessState(token);
    if (currentReadiness === 'NOT_READY' || currentReadiness === 'DEGRADED') {
      const res = await this.reconcile(token);
      if (res.readinessState !== 'READY') {
        return 0n;
      }
      return res.headroom;
    }

    if (currentReadiness !== 'READY') {
      return 0n;
    }

    const snapshot = this.persistence.getLatestChainInventorySnapshot(token);
    if (!snapshot) return 0n;

    const R = this.persistence.getReservedOperatorBalance(token);
    const P = this.persistence.getUnresolvedFundingIntentsAmount(token);
    const headroom = snapshot.safeWalletCapacity - R - P;
    return headroom > 0n ? headroom : 0n;
  }

  /**
   * Private executor for onchain capacity observation, deficit detection, and snapshot persistence.
   */
  private async executeCapacityReconciliation(
    token: string
  ): Promise<{ readinessState: InventoryReadinessState; headroom: bigint }> {
    // 1. Query chain capacity observation (W_latest, W_finalized, W_safe)
    let observation: ChainCapacityObservation;
    try {
      observation = await this.capacityProvider.observeWalletCapacity(token);
    } catch (err: any) {
      this.readinessState = 'UNKNOWN';
      this.persistence.setInventoryReadinessState(token, 'UNKNOWN');
      throw new EvmInventoryUnavailableError(`Failed to observe chain capacity: ${err.message}`);
    }

    // 2. Safe wallet capacity = min(W_latest, W_finalized) (REC-7, REC-8)
    const W_safe = observation.safeWalletCapacity;

    // 3. Compute active reserved obligations (R) and unresolved funding intents (P)
    const R = this.persistence.getReservedOperatorBalance(token);
    const P = this.persistence.getUnresolvedFundingIntentsAmount(token);

    // 4. Safe Headroom = W_safe - R - P (REC-1, REC-2)
    // CRITICAL: Committed HTLC capital (C) is NOT subtracted from W_safe!
    const headroom = W_safe - R - P;

    const now = new Date();

    // 5. Deficit detection (REC-7, REC-17)
    if (headroom < 0n) {
      this.readinessState = 'DEFICIT';
      const deficitSnapshot: ChainInventorySnapshot = {
        tokenAddress: token,
        chainId: observation.chainId,
        operatorAddress: observation.operatorAddress,
        walletBalanceLatest: observation.walletBalanceLatest,
        walletBalanceFinalized: observation.walletBalanceFinalized,
        safeWalletCapacity: W_safe,
        latestBlockNumber: observation.latestBlockNumber,
        finalizedBlockNumber: observation.finalizedBlockNumber,
        blockHash: observation.blockHash,
        readinessState: 'DEFICIT',
        observedAt: observation.observedAt,
        updatedAt: now,
      };
      this.persistence.recordChainInventorySnapshot(deficitSnapshot);
      this.lastObservedSnapshot = deficitSnapshot;
      this.lastReconciliationTime = Date.now();

      throw new LiquidityDeficitError(
        `Safe wallet capacity ${W_safe} is less than active obligations ${R + P} (deficit: ${R + P - W_safe})`
      );
    }

    // 6. Healthy READY transition
    this.readinessState = 'READY';
    const snapshot: ChainInventorySnapshot = {
      tokenAddress: token,
      chainId: observation.chainId,
      operatorAddress: observation.operatorAddress,
      walletBalanceLatest: observation.walletBalanceLatest,
      walletBalanceFinalized: observation.walletBalanceFinalized,
      safeWalletCapacity: W_safe,
      latestBlockNumber: observation.latestBlockNumber,
      finalizedBlockNumber: observation.finalizedBlockNumber,
      blockHash: observation.blockHash,
      readinessState: 'READY',
      observedAt: observation.observedAt,
      updatedAt: now,
    };

    this.persistence.recordChainInventorySnapshot(snapshot);
    // Keep operator_inventory synchronized for legacy queries without double-deducting C
    this.persistence.setConfirmedOperatorBalance(token, W_safe);
    this.lastObservedSnapshot = snapshot;
    this.lastReconciliationTime = Date.now();

    return {
      readinessState: 'READY',
      headroom,
    };
  }

  /**
   * Reconciles active swaps against onchain HTLC states (Phase 4 of boot).
   */
  private async reconcileActiveSwaps(token: string): Promise<void> {
    const activeSwaps = this.persistence.listNonTerminalSovereignSwaps();
    for (const swap of activeSwaps) {
      if (!swap.evmSwapKey) continue;
      if (swap.tokenAddress && swap.tokenAddress.toLowerCase() !== token) continue;

      try {
        if (typeof (this.capacityProvider as any).getContractHtlcState === 'function') {
          const htlcId = swap.evmHtlcId;
          if (!htlcId) continue;

          const onchainState = await (this.capacityProvider as any).getContractHtlcState(htlcId);
          if (!onchainState) continue;

          // Status 2: CLAIMED onchain
          if (onchainState.status === 2 && swap.reservationId) {
            this.persistence.settleLiquidityReservation(swap.reservationId);
          }
          // Status 3: REFUNDED onchain
          else if (onchainState.status === 3 && swap.reservationId) {
            this.persistence.restoreRefundLiquidityReservation(swap.reservationId);
          }
        }
      } catch {
        // Individual swap reconciliation error does not halt the overall scan
      }
    }
  }
}
