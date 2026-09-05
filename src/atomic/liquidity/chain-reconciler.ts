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
  BASE_SEPOLIA_TEST_POLICY,
  InventoryReadinessState,
  LiquidityDeficitError,
  EvmInventoryUnavailableError,
  SovereignAtomicState,
} from '../types.ts';
import type { ReconciliationOutcome } from '../evm/transaction-types.ts';

type ReconciliationCapacityProvider = IChainCapacityProvider & {
  rehydrateBindings?: () => number;
  getTransactionManager?: () => {
    reconcileIntent(intentId: string): Promise<ReconciliationOutcome>;
  } | undefined;
};

const CROSS_RAIL_TERMINAL_STATES = new Set<SovereignAtomicState>([
  SovereignAtomicState.COMPLETED,
  SovereignAtomicState.REFUNDED,
  SovereignAtomicState.INVOICE_CANCELED,
  SovereignAtomicState.EXPIRED,
]);

export interface ChainInventoryReconcilerConfig {
  persistence: SqlitePersistence;
  capacityProvider: IChainCapacityProvider;
  defaultTokenAddress: string;
  expectedChainId?: number;
  policy: BaseInventoryReconciliationPolicy;
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

  /**
   * Explicit test helper for constructing a reconciler in non-production tests.
   * Unmistakably marked for testing only.
   */
  public static createForTesting(
    config: Omit<ChainInventoryReconcilerConfig, 'policy'> & {
      policy?: Partial<BaseInventoryReconciliationPolicy>;
    }
  ): ChainInventoryReconciler {
    return new ChainInventoryReconciler({
      ...config,
      policy: {
        ...BASE_SEPOLIA_TEST_POLICY,
        ...config.policy,
      },
    });
  }

  constructor(config: ChainInventoryReconcilerConfig) {
    if (!config || !config.policy) {
      throw new Error('RECONCILER_CONFIG_ERROR: Explicit reconciliation policy is required.');
    }
    this.persistence = config.persistence;
    this.capacityProvider = config.capacityProvider;
    this.defaultTokenAddress = config.defaultTokenAddress.toLowerCase();
    this.expectedChainId = config.expectedChainId ?? 84532;
    this.policy = { ...config.policy };
    if (
      !Number.isFinite(this.policy.maxFreshnessMs) || this.policy.maxFreshnessMs <= 0 ||
      !Number.isInteger(this.policy.requiredConfirmations) || this.policy.requiredConfirmations < 1 ||
      !Number.isInteger(this.policy.reorgLagTolerance) || this.policy.reorgLagTolerance < 0 ||
      this.policy.failClosedOnDeficit !== true
    ) {
      throw new Error('RECONCILER_CONFIG_ERROR: Invalid fail-closed reconciliation policy.');
    }
  }

  public getPolicy(): BaseInventoryReconciliationPolicy {
    return { ...this.policy };
  }

  public getCapacityProvider(): IChainCapacityProvider {
    return this.capacityProvider;
  }

  public getDefaultTokenAddress(): string {
    return this.defaultTokenAddress;
  }

  public getExpectedChainId(): number {
    return this.expectedChainId;
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

    // Active swaps requiring cross-rail recovery block READY state (economic acceptance blocked)
    const activeSwaps = this.persistence.listNonTerminalSovereignSwaps();
    const hasUnresolved = activeSwaps.some(
      (s) =>
        (!s.tokenAddress || s.tokenAddress.toLowerCase() === token) &&
        (s.recoveryRequired ||
          s.state === SovereignAtomicState.RECOVERY_REQUIRED ||
          s.state === SovereignAtomicState.MANUAL_REVIEW)
    );
    if (hasUnresolved) {
      return 'NOT_READY';
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
      const provider = this.capacityProvider as ReconciliationCapacityProvider;
      if (typeof provider.rehydrateBindings === 'function') {
        provider.rehydrateBindings();
      }

      // PHASE 3.5: Reconcile unresolved FUND transaction intents against external chain truth (FF-7)
      await this.reconcileUnresolvedFundingIntents(token);

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

    if (observation.chainId !== this.expectedChainId) {
      throw new EvmInventoryUnavailableError(
        `Observed chain ${observation.chainId} does not match configured chain ${this.expectedChainId}`
      );
    }
    const expectedFinalized = Math.max(
      0,
      observation.latestBlockNumber - this.policy.requiredConfirmations
    );
    if (
      observation.finalizedBlockNumber > expectedFinalized ||
      observation.finalizedBlockNumber < Math.max(0, expectedFinalized - this.policy.reorgLagTolerance)
    ) {
      throw new EvmInventoryUnavailableError(
        `FINALITY_POLICY_MISMATCH: expected finalized block in [${Math.max(0, expectedFinalized - this.policy.reorgLagTolerance)}, ${expectedFinalized}], observed ${observation.finalizedBlockNumber}`
      );
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
    const freshUntil = new Date(now.getTime() + this.policy.maxFreshnessMs);

    // 5. Deficit detection (REC-7, REC-17)
    if (headroom < 0n && this.policy.failClosedOnDeficit) {
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
        freshUntil,
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
      freshUntil,
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
   * Fail-closed: Any failure to observe onchain state of an active swap aborts reconciliation. (FB-3, FF-3)
   */
  private async reconcileActiveSwaps(token: string): Promise<void> {
    const activeSwaps = this.persistence.listNonTerminalSovereignSwaps();
    const statesRequiringHtlc = new Set<SovereignAtomicState>([
      SovereignAtomicState.EVM_FUNDED,
      SovereignAtomicState.CLAIMING,
      SovereignAtomicState.EVM_CLAIM_DETECTED,
      SovereignAtomicState.EVM_CLAIM_CONFIRMED,
      SovereignAtomicState.LIGHTNING_SETTLEMENT_PENDING,
      SovereignAtomicState.LIGHTNING_SETTLED,
      SovereignAtomicState.DESTINATION_PENDING,
      SovereignAtomicState.REFUND_ELIGIBLE,
      SovereignAtomicState.EVM_REFUND_PENDING,
      SovereignAtomicState.EVM_REFUND_CONFIRMED,
      SovereignAtomicState.LIGHTNING_CANCEL_PENDING,
    ]);

    for (const swap of activeSwaps) {
      if (swap.tokenAddress && swap.tokenAddress.toLowerCase() !== token) continue;

      if (
        swap.state === SovereignAtomicState.PLAN_PREPARED ||
        swap.state === SovereignAtomicState.INVOICE_CREATED ||
        swap.state === SovereignAtomicState.LIGHTNING_HELD
      ) {
        continue;
      }

      if (swap.state === SovereignAtomicState.EVM_FUNDING_PENDING) {
        if (!swap.evmSwapKey) {
          throw new Error(
            `ACTIVE_SWAP_RECONCILIATION_FAILED: Funding-pending swap ${swap.id} has no durable evmSwapKey`
          );
        }
        const intent = this.persistence.getEvmIntentBySwapKey(swap.evmSwapKey, 'FUND');
        if (!intent) {
          throw new Error(
            `ACTIVE_SWAP_RECONCILIATION_FAILED: Funding-pending swap ${swap.id} has no durable FUND intent`
          );
        }
        if (['CREATED', 'NONCE_RESERVED', 'DISPATCHING', 'PENDING'].includes(intent.status)) {
          // Exposure is durably represented in R/P and remains non-terminal.
          continue;
        }
        if (intent.status !== 'CONFIRMED') {
          throw new Error(
            `ACTIVE_SWAP_RECONCILIATION_FAILED: Funding-pending swap ${swap.id} has terminal FUND ${intent.status} and requires cross-rail recovery`
          );
        }
        // A confirmed FUND intent must converge through mandatory HTLC evidence.
      } else if (
        swap.state === SovereignAtomicState.RECOVERY_REQUIRED ||
        swap.state === SovereignAtomicState.MANUAL_REVIEW
      ) {
        throw new Error(
          `ACTIVE_SWAP_RECONCILIATION_FAILED: Swap ${swap.id} in ${swap.state} requires coordinator cross-rail recovery before inventory can become READY`
        );
      } else if (!statesRequiringHtlc.has(swap.state)) {
        throw new Error(
          `ACTIVE_SWAP_RECONCILIATION_FAILED: Unclassified non-terminal state ${swap.state} for swap ${swap.id}`
        );
      }

      // 1. Observation capability must exist
      if (typeof this.capacityProvider.getContractHtlcState !== 'function') {
        throw new Error(
          `ACTIVE_SWAP_RECONCILIATION_FAILED: Capacity provider does not support getContractHtlcState for active funded swap ${swap.id} in state ${swap.state}`
        );
      }

      // 2. evmHtlcId must be present for states requiring HTLC
      const htlcId = swap.evmHtlcId;
      if (!htlcId) {
        throw new Error(
          `ACTIVE_SWAP_RECONCILIATION_FAILED: Active swap ${swap.id} in state ${swap.state} is missing required evmHtlcId`
        );
      }

      // 3. Query on-chain HTLC state
      let onchainState: unknown;
      try {
        onchainState = await this.capacityProvider.getContractHtlcState(htlcId);
      } catch (err: any) {
        throw new Error(
          `ACTIVE_SWAP_RECONCILIATION_FAILED: RPC error observing HTLC ${htlcId} for active swap ${swap.id}: ${err?.message ?? err}`
        );
      }

      if (onchainState === null || onchainState === undefined) {
        throw new Error(
          `ACTIVE_SWAP_RECONCILIATION_FAILED: Onchain HTLC state returned null or indeterminate for active swap ${swap.id} (htlcId: ${htlcId})`
        );
      }

      if (typeof onchainState !== 'object' || !('status' in onchainState)) {
        throw new Error(
          `ACTIVE_SWAP_RECONCILIATION_FAILED: Malformed HTLC state for active swap ${swap.id}`
        );
      }
      const rawStatus = (onchainState as { status: unknown }).status;
      const status = typeof rawStatus === 'bigint' ? Number(rawStatus) : rawStatus;
      if (!Number.isInteger(status) || ![0, 1, 2, 3].includes(status as number)) {
        throw new Error(
          `ACTIVE_SWAP_RECONCILIATION_FAILED: Unknown HTLC status ${String(rawStatus)} for active swap ${swap.id}`
        );
      }

      // Status 0: INVALID / NONEXISTENT
      if (status === 0) {
        throw new Error(
          `ACTIVE_SWAP_RECONCILIATION_FAILED: HTLC ${htlcId} for active funded swap ${swap.id} does not exist on contract (status 0)`
        );
      }

      // Status 1: LOCKED (active funded HTLC) -> ensure reservation committed and swap advanced
      if (status === 1) {
        if (!swap.reservationId) {
          this.persistence.markSovereignRecoveryRequired(
            swap.id,
            `CRITICAL_INVARIANT_VIOLATION: Onchain HTLC is LOCKED but swap has no reservationId; economic inconsistency`,
            'MISSING_RESERVATION_ID'
          );
          throw new Error(
            `ACTIVE_SWAP_RECONCILIATION_FAILED: MISSING_RESERVATION_ID: Swap ${swap.id} has no reservationId for locked onchain HTLC`
          );
        }
        try {
          this.persistence.commitReservationAndAdvanceSwapToFunded(swap.reservationId, swap.id);
        } catch (err: any) {
          this.persistence.markSovereignRecoveryRequired(
            swap.id,
            `CRITICAL_INVARIANT_VIOLATION: Onchain HTLC is LOCKED but reservation commit failed (${err?.message ?? err}); economic inconsistency`,
            'RESERVATION_COMMIT_FAILED'
          );
          throw new Error(
            `ACTIVE_SWAP_RECONCILIATION_FAILED: Swap ${swap.id} reservation commit failed for locked HTLC: ${err?.message ?? err}`
          );
        }
      }
      // Status 2: CLAIMED onchain
      else if (status === 2) {
        if (!swap.reservationId) {
          this.persistence.markSovereignRecoveryRequired(
            swap.id,
            `CRITICAL_INVARIANT_VIOLATION: Onchain HTLC is CLAIMED but swap has no reservationId; economic inconsistency`,
            'MISSING_RESERVATION_ID'
          );
          throw new Error(
            `ACTIVE_SWAP_RECONCILIATION_FAILED: MISSING_RESERVATION_ID: Swap ${swap.id} has no reservationId for claimed onchain HTLC`
          );
        }
        try {
          this.persistence.settleLiquidityReservation(swap.reservationId);
        } catch (err: any) {
          this.persistence.markSovereignRecoveryRequired(
            swap.id,
            `CRITICAL_INVARIANT_VIOLATION: Onchain HTLC is CLAIMED but reservation settle failed (${err?.message ?? err}); economic inconsistency`,
            'RESERVATION_SETTLE_FAILED'
          );
          throw new Error(
            `ACTIVE_SWAP_RECONCILIATION_FAILED: Swap ${swap.id} reservation settle failed for claimed HTLC: ${err?.message ?? err}`
          );
        }
      }
      // Status 3: REFUNDED onchain
      else if (status === 3) {
        if (!swap.reservationId) {
          this.persistence.markSovereignRecoveryRequired(
            swap.id,
            `CRITICAL_INVARIANT_VIOLATION: Onchain HTLC is REFUNDED but swap has no reservationId; economic inconsistency`,
            'MISSING_RESERVATION_ID'
          );
          throw new Error(
            `ACTIVE_SWAP_RECONCILIATION_FAILED: MISSING_RESERVATION_ID: Swap ${swap.id} has no reservationId for refunded onchain HTLC`
          );
        }
        try {
          this.persistence.restoreRefundLiquidityReservation(swap.reservationId);
        } catch (err: any) {
          this.persistence.markSovereignRecoveryRequired(
            swap.id,
            `CRITICAL_INVARIANT_VIOLATION: Onchain HTLC is REFUNDED but reservation refund restoration failed (${err?.message ?? err}); economic inconsistency`,
            'RESERVATION_REFUND_RESTORE_FAILED'
          );
          throw new Error(
            `ACTIVE_SWAP_RECONCILIATION_FAILED: Swap ${swap.id} reservation restore failed for refunded HTLC: ${err?.message ?? err}`
          );
        }
      }
    }
  }

  /**
   * Reconciles unresolved FUND transaction intents against external chain truth (Phase 3.5 of boot).
   * Fail-closed: Any unexpected RPC error during intent verification aborts reconciliation. (FB-2, FF-7)
   */
  private async reconcileUnresolvedFundingIntents(token: string): Promise<void> {
    const activeIntents = this.persistence.getActiveEvmIntents(this.expectedChainId);
    const recoveryIntents = this.persistence.getFailedFundIntentsRequiringCrossRailRecovery(
      this.expectedChainId
    );
    const fundIntents = [...new Map(
      [...activeIntents.filter((i) => i.actionType === 'FUND'), ...recoveryIntents]
        .map((intent) => [intent.id, intent])
    ).values()];

    for (const intent of fundIntents) {
      const swap = this.persistence.getSovereignSwapBySwapKey(intent.swapKey);
      if (swap && swap.tokenAddress && swap.tokenAddress.toLowerCase() !== token) {
        continue;
      }

      if (
        swap &&
        !CROSS_RAIL_TERMINAL_STATES.has(swap.state) &&
        (intent.status === 'REVERTED' || intent.status === 'FAILED' || intent.status === 'NONCE_CONFLICT')
      ) {
        this.persistence.markSovereignRecoveryRequired(
          swap.id,
          `Base FUND intent ${intent.id} is ${intent.status}; authoritative cross-rail recovery required`,
          `BASE_FUNDING_${intent.status}_CROSS_RAIL_RESERVED`
        );
      }

      const provider = this.capacityProvider as ReconciliationCapacityProvider;
      const txManager =
        typeof provider.getTransactionManager === 'function'
          ? provider.getTransactionManager()
          : undefined;

      if (txManager && typeof txManager.reconcileIntent === 'function') {
        try {
          const outcome = await txManager.reconcileIntent(intent.id);
          if (outcome.status === 'CONFIRMED') {
            if (swap && swap.reservationId) {
              if (swap.state === SovereignAtomicState.EVM_FUNDING_PENDING) {
                try {
                  this.persistence.commitReservationAndAdvanceSwapToFunded(swap.reservationId, swap.id);
                } catch (err: any) {
                  this.persistence.markSovereignRecoveryRequired(
                    swap.id,
                    `CRITICAL_INVARIANT_VIOLATION: Funding intent is CONFIRMED but reservation commit failed (${err?.message ?? err}); economic inconsistency`,
                    'RESERVATION_COMMIT_FAILED'
                  );
                  throw new Error(
                    `UNRESOLVED_INTENT_RECONCILIATION_FAILED: Swap ${swap.id} reservation commit failed for confirmed intent: ${err?.message ?? err}`
                  );
                }
              } else {
                this.persistence.commitLiquidityReservation(swap.reservationId);
              }
            } else if (swap && !swap.reservationId) {
              this.persistence.markSovereignRecoveryRequired(
                swap.id,
                `CRITICAL_INVARIANT_VIOLATION: Funding intent is CONFIRMED but swap has no reservationId; economic inconsistency`,
                'MISSING_RESERVATION_ID'
              );
              throw new Error(
                `UNRESOLVED_INTENT_RECONCILIATION_FAILED: MISSING_RESERVATION_ID: Swap ${swap.id} has no reservationId for confirmed intent`
              );
            }
          } else if (
            outcome.status === 'REVERTED' ||
            outcome.status === 'FAILED' ||
            outcome.status === 'NONCE_CONFLICT'
          ) {
            // EVM terminality never proves Lightning terminality. Startup has no
            // Lightning authority, so it only escalates and preserves R.
            if (
              swap &&
              !CROSS_RAIL_TERMINAL_STATES.has(swap.state)
            ) {
              this.persistence.markSovereignRecoveryRequired(
                swap.id,
                `Base FUND intent ${intent.id} is ${outcome.status}; authoritative cross-rail recovery required`,
                `BASE_FUNDING_${outcome.status}_CROSS_RAIL_RESERVED`
              );
            }
          }
        } catch (err: any) {
          throw new Error(
            `UNRESOLVED_INTENT_RECONCILIATION_FAILED: Failed to reconcile funding intent ${intent.id} for swap ${intent.swapKey}: ${err?.message ?? err}`
          );
        }
      } else if (typeof this.capacityProvider.getContractHtlcState === 'function' && swap?.evmHtlcId) {
        try {
          const state = await this.capacityProvider.getContractHtlcState(swap.evmHtlcId);
          if (!state || typeof state !== 'object' || !('status' in state)) {
            throw new Error('Indeterminate or malformed HTLC state');
          }
          const rawStatus = (state as { status: unknown }).status;
          const status = typeof rawStatus === 'bigint' ? Number(rawStatus) : rawStatus;
          if (typeof status !== 'number' || !Number.isInteger(status) || ![0, 1, 2, 3].includes(status)) {
            throw new Error(`Unknown HTLC status ${String(rawStatus)}`);
          }
          if (status === 0) {
            throw new Error('HTLC absence does not resolve a durable pending FUND intent');
          }

          this.persistence.markEvmIntentConfirmedByChainEvidence(
            intent.id,
            intent.canonicalTxHash ?? undefined
          );
          if (swap.reservationId) {
            if (status === 1) {
              this.persistence.commitLiquidityReservation(swap.reservationId);
            } else if (status === 2) {
              this.persistence.settleLiquidityReservation(swap.reservationId);
            } else {
              this.persistence.restoreRefundLiquidityReservation(swap.reservationId);
            }
          }
          this.persistence.updateSovereignSwap(swap.id, {
            state: status === 1
              ? SovereignAtomicState.EVM_FUNDED
              : status === 2
                ? SovereignAtomicState.EVM_CLAIM_DETECTED
                : SovereignAtomicState.EVM_REFUND_CONFIRMED,
            recoveryRequired: status !== 1,
          });
        } catch (err: any) {
          throw new Error(
            `UNRESOLVED_INTENT_RECONCILIATION_FAILED: Failed to check HTLC state for funding intent ${intent.id}: ${err?.message ?? err}`
          );
        }
      } else if (['CREATED', 'NONCE_RESERVED', 'DISPATCHING', 'PENDING'].includes(intent.status)) {
        throw new Error(
          `UNRESOLVED_INTENT_RECONCILIATION_FAILED: No authoritative transaction manager or HTLC observation is available for FUND intent ${intent.id}`
        );
      }
    }
  }
}
