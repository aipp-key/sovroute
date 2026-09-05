/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Sovereign Atomic Coordinator (Phase 5B — End-to-End Coordinator Recovery)
 *
 * Coordinates cross-chain atomic swaps between Bitcoin Lightning hold invoices
 * and EVM HTLCs (Base USDC).
 *
 * Invariants Enforced:
 * - SEC-1: Never stores or custodies user private keys.
 * - SEC-5: Durable action ownership before side effects.
 * - SEC-6: Ambiguous financial side effects never blindly retried.
 * - SEC-9: Once funds move/held, ordinary FAILED transition forbidden.
 * - SEC-10: Claim and refund paths are mutually exclusive.
 * - SEC-11: Secret-bearing material sanitized from public interfaces.
 * - SEC-14: Exactly one action owner across concurrent workers / processes.
 * - SEC-21: Authoritative consensus block timestamps for timelocks.
 * - INVARIANT A: No BTC settlement before verified Base claim.
 * - INVARIANT B: Claimed Base -> never cancel Lightning.
 * - INVARIANT C: Refunded Base -> never settle Lightning.
 * - INVARIANT D: Never cancel Lightning while funded Base can still be claimed.
 * - INVARIANT E: No double economic action (idempotent convergence).
 * - INVARIANT F: Durable payment-hash ownership.
 */

import { randomUUID, createHash } from 'node:crypto';
import type {
  ILightningAtomicBackend,
  IEvmAtomicBackend,
  ILiquidityInventory,
  SovereignExecutionRecord,
  SovereignSwapTransition,
  HoldInvoice,
  HashLock,
  SecretPreimage,
  EvmHtlcState,
} from '../types.ts';
import {
  SovereignAtomicState,
  AuthorizedSettlementPreimage,
  InventoryNotReadyError,
  LiquidityDeficitError,
  EvmInventoryUnavailableError,
  LightningInvoiceNotFoundError,
} from '../types.ts';
import {
  LightningSettlementGateError,
  type EvmHtlcClaimedEvidence,
  type EvmHtlcRefundedEvidence,
} from '../evm/evm-types.ts';
import { OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS } from '../evm/base-guard.ts';
import { SqlitePersistence } from '../../persistence/sqlite.ts';
import { SqliteLiquidityInventory } from '../liquidity/sqlite-inventory.ts';

export interface CreateAtomicSwapParams {
  idempotencyKey: string;
  hashLock: HashLock;
  claimingAddress: string;
  targetDestinationAddress: string;
  amountSats: bigint;
  expectedUsdcAmount: bigint;
  cltvExpiryBlocks?: number;
  timelockSeconds?: number;
}

export const CROSS_RAIL_FAST_BLOCK_TAIL_TARGET = 1e-10;
export const STANDARD_BASE_SAFETY_BUDGET_SECONDS = 46_200; // 43,200s (12h Base HTLC) + 600s dispatch + 300s finality + 300s LND + 1,800s emergency margin
export const NOMINAL_BITCOIN_BLOCK_TIME_SECONDS = 600; // 10 minutes nominal block arrival
export const NOMINAL_POISSON_MEAN_BLOCKS = 77; // 46,200 / 600 = 77
export const VERIFIED_POISSON_BLOCK_THRESHOLD = 140; // Smallest integer K where P(N >= K | mu=77) < 1e-10

/**
 * Direct numerically stable Poisson upper-tail calculation:
 * P(N >= k | mu) = P(N = k) * [1 + mu/(k+1) + mu^2/((k+1)(k+2)) + ...]
 * Computes strictly positive terms in log space to eliminate (1 - CDF) floating-point cancellation.
 */
export function computePoissonTailDirect(k: number, mu: number): number {
  if (k <= 0) return 1;
  let logFact = 0;
  for (let i = 1; i <= k; i++) {
    logFact += Math.log(i);
  }
  const logPk = -mu + k * Math.log(mu) - logFact;
  const Pk = Math.exp(logPk);

  let sumSeries = 1;
  let term = 1;
  for (let r = 1; r < 200; r++) {
    term *= mu / (k + r);
    sumSeries += term;
    if (term < 1e-16) break;
  }
  return Pk * sumSeries;
}

// Backwards-compatible alias for existing imports
export const computePoissonTail = computePoissonTailDirect;

/**
 * Derives the minimum required Bitcoin block threshold K such that
 * P(N >= K | mu = totalBudgetSeconds / 600) < tailRiskTarget (default 1e-10)
 * using direct stable Poisson upper-tail recurrence without hardcoded shortcuts.
 *
 * NOTE: The coordinator uses a conservative statistical fast-block planning bound
 * under the documented Poisson block-arrival model. This is a statistical engineering
 * risk bound, NOT a deterministic wall-clock guarantee.
 */
export function computeRequiredBtcBlocksForBudget(
  totalBudgetSeconds: number,
  tailRiskTarget: number = CROSS_RAIL_FAST_BLOCK_TAIL_TARGET
): number {
  const mu = totalBudgetSeconds / NOMINAL_BITCOIN_BLOCK_TIME_SECONDS;
  let k = Math.ceil(mu);
  while (computePoissonTailDirect(k, mu) >= tailRiskTarget) {
    k++;
  }
  return k;
}

export interface CrossRailTimeSafetyConfig {
  tailRiskTarget?: number; // default: 1e-10 (conservative statistical engineering risk bound)
  baseDispatchBudgetSeconds: number; // default: 600 (10 min for Base transaction dispatch & replacements)
  baseFinalityBudgetSeconds: number; // default: 300 (5 min for Base confirmations)
  lndResolutionBudgetSeconds: number; // default: 300 (5 min for LND RPC settlement/cancel reconciliation)
  safetyMarginSeconds: number; // default: 1800 (30 min explicit conservative reserve)
  conservativeBlockTimeSeconds?: number; // Explanatory metadata: effective seconds/block (~330s/block for 46,200s / 140)
}

export interface BaseFinalityPolicy {
  policyTag: string; // e.g. 'BASE_SEPOLIA_TEST_POLICY'
  requiredConfirmations: number;
}

export const BASE_SEPOLIA_FINALITY_POLICY: BaseFinalityPolicy = {
  policyTag: 'BASE_SEPOLIA_TEST_POLICY',
  requiredConfirmations: 2,
};

export class MissingFinalityPolicyError extends Error {
  constructor(message?: string) {
    super(
      message ??
        'MISSING_FINALITY_POLICY: No explicit Base finality policy configured. Irreversible cross-rail action forbidden fail-closed.'
    );
    this.name = 'MissingFinalityPolicyError';
  }
}

export interface CoordinatorConfig {
  tokenAddress?: string;
  operatorRefundAddress?: string;
  persistence?: SqlitePersistence;
  workerId?: string;
  leaseMs?: number | undefined;
  finalityPolicy?: BaseFinalityPolicy | undefined;
  requiredConfirmations?: number | undefined;
  maxRetries?: number | undefined;
  timeSafety?: Partial<CrossRailTimeSafetyConfig> | undefined;
  timeSafetyConfig?: Partial<CrossRailTimeSafetyConfig> | undefined;
}

type LightningRecoveryObservation =
  | { kind: 'FOUND'; invoice: HoldInvoice }
  | { kind: 'NOT_FOUND' }
  | { kind: 'UNKNOWN'; reason: string };

type EvmRecoveryObservation =
  | { kind: 'FUNDED'; state: EvmHtlcState }
  | { kind: 'CLAIMED'; state: EvmHtlcState }
  | { kind: 'REFUNDED'; state: EvmHtlcState }
  | { kind: 'NOT_FUNDED_PROVEN'; state: EvmHtlcState }
  | { kind: 'PENDING'; state: EvmHtlcState }
  | { kind: 'UNKNOWN'; reason: string };

export class AtomicCoordinator {
  private records = new Map<string, SovereignExecutionRecord>();
  private idempotencyIndex = new Map<string, string>();
  private inFlightPrepares = new Map<string, Promise<SovereignExecutionRecord>>();
  private actionClaims = new Map<string, string>(); // executionId -> claimOwner

  private readonly lightning: ILightningAtomicBackend;
  private readonly evm: IEvmAtomicBackend;
  private readonly inventory: ILiquidityInventory;
  private readonly persistence: SqlitePersistence;
  private readonly defaultTokenAddress: string;
  private readonly defaultRefundAddress: string;
  private readonly defaultWorkerId: string;
  private readonly leaseMs: number;
  private readonly finalityPolicy?: BaseFinalityPolicy | undefined;
  private readonly requiredConfirmations?: number | undefined;
  private readonly maxRetries: number;
  private readonly timeSafetyConfig: CrossRailTimeSafetyConfig;

  constructor(
    lightning: ILightningAtomicBackend,
    evm: IEvmAtomicBackend,
    inventory: ILiquidityInventory,
    config?: CoordinatorConfig
  ) {
    this.lightning = lightning;
    this.evm = evm;
    this.inventory = inventory;
    this.persistence = config?.persistence ?? new SqlitePersistence({ filename: ':memory:' });
    this.defaultWorkerId = config?.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
    this.leaseMs = config?.leaseMs ?? 60_000;
    this.maxRetries = config?.maxRetries ?? 5;

    const backendFinality = (evm as { finalityPolicy?: BaseFinalityPolicy }).finalityPolicy;
    if (
      config?.finalityPolicy &&
      backendFinality &&
      config.finalityPolicy.requiredConfirmations !== backendFinality.requiredConfirmations
    ) {
      throw new Error('FINALITY_POLICY_MISMATCH: Coordinator and EVM backend policies disagree');
    }

    if (config?.finalityPolicy) {
      this.finalityPolicy = config.finalityPolicy;
      this.requiredConfirmations = config.finalityPolicy.requiredConfirmations;
    } else if (config?.requiredConfirmations !== undefined) {
      this.requiredConfirmations = config.requiredConfirmations;
      this.finalityPolicy = {
        policyTag: 'EXPLICIT_CONFIRMATIONS',
        requiredConfirmations: config.requiredConfirmations,
      };
    } else if ((evm as any)?.finalityPolicy) {
      this.finalityPolicy = (evm as any).finalityPolicy;
      this.requiredConfirmations = this.finalityPolicy!.requiredConfirmations;
    } else {
      this.finalityPolicy = undefined;
      this.requiredConfirmations = undefined;
    }

    const timeCfg = config?.timeSafetyConfig ?? config?.timeSafety;
    this.timeSafetyConfig = {
      tailRiskTarget: timeCfg?.tailRiskTarget ?? CROSS_RAIL_FAST_BLOCK_TAIL_TARGET,
      baseDispatchBudgetSeconds: timeCfg?.baseDispatchBudgetSeconds ?? 600,
      baseFinalityBudgetSeconds: timeCfg?.baseFinalityBudgetSeconds ?? 300,
      lndResolutionBudgetSeconds: timeCfg?.lndResolutionBudgetSeconds ?? 300,
      safetyMarginSeconds: timeCfg?.safetyMarginSeconds ?? 1800,
      conservativeBlockTimeSeconds: timeCfg?.conservativeBlockTimeSeconds ?? 360,
    };

    this.defaultTokenAddress =
      config?.tokenAddress ??
      (typeof (evm as any).getTokenAddress === 'function'
        ? (evm as any).getTokenAddress()
        : OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS);
    this.defaultRefundAddress =
      config?.operatorRefundAddress ?? '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
  }

  public getPersistence(): SqlitePersistence {
    return this.persistence;
  }

  public getEvmBackend(): IEvmAtomicBackend {
    return this.evm;
  }

  public getInventory(): ILiquidityInventory {
    return this.inventory;
  }

  public getFinalityPolicy(): BaseFinalityPolicy | undefined {
    return this.finalityPolicy ? { ...this.finalityPolicy } : undefined;
  }

  /**
   * Helper: computes immutable economic fingerprint over swap agreement parameters.
   */
  public computeEconomicFingerprint(params: {
    amountSats: bigint;
    expectedUsdcAmount: bigint;
    hashLock: string;
    claimingAddress: string;
    targetDestinationAddress: string;
    tokenAddress: string;
    refundAddress: string;
  }): string {
    const data = [
      params.amountSats.toString(),
      params.expectedUsdcAmount.toString(),
      params.hashLock.toLowerCase(),
      params.claimingAddress.toLowerCase(),
      params.targetDestinationAddress.toLowerCase(),
      params.tokenAddress.toLowerCase(),
      params.refundAddress.toLowerCase(),
    ].join('|');
    return createHash('sha256').update(data).digest('hex');
  }

  /**
   * 1. Initialize Swap Intent and Create Lightning Hold Invoice
   */
  async prepareSwap(params: CreateAtomicSwapParams): Promise<SovereignExecutionRecord> {
    // 1. Validate hashlock format (32 bytes hex)
    if (!/^0x[a-fA-F0-9]{64}$/.test(params.hashLock)) {
      throw new Error(`Invalid hashLock format: must be 0x-prefixed 32-byte hex`);
    }

    if (params.amountSats <= 0n) {
      throw new Error(`Invalid amountSats: [${params.amountSats.toString()}]. Must be positive integer sats.`);
    }

    if (params.expectedUsdcAmount <= 0n) {
      throw new Error(
        `Invalid expectedUsdcAmount: [${params.expectedUsdcAmount.toString()}]. Must be positive integer USDC atomic units.`
      );
    }

    const tokenAddress = this.defaultTokenAddress;
    const refundAddress = this.defaultRefundAddress;
    const paymentHash = params.hashLock.replace(/^0x/, '').toLowerCase();
    const fingerprint = this.computeEconomicFingerprint({
      amountSats: params.amountSats,
      expectedUsdcAmount: params.expectedUsdcAmount,
      hashLock: params.hashLock,
      claimingAddress: params.claimingAddress,
      targetDestinationAddress: params.targetDestinationAddress,
      tokenAddress,
      refundAddress,
    });

    // 2. Durable Idempotency Check in authoritative SQLite
    const existing = this.persistence.getSovereignSwapByIdempotencyKey(params.idempotencyKey);
    if (existing) {
      if (existing.economicFingerprint && existing.economicFingerprint !== fingerprint) {
        throw new Error(
          `IMMUTABLE_FINGERPRINT_MISMATCH: Duplicate request with idempotencyKey ${params.idempotencyKey} has conflicting economic parameters`
        );
      }
      this.syncCache(existing);
      if (existing.recoveryRequired || existing.state === SovereignAtomicState.RECOVERY_REQUIRED) {
        throw new Error(
          `RECOVERY_REQUIRED: Existing swap ${existing.id} has ambiguous external state; prepare retry is forbidden`
        );
      }
      if (
        existing.state === SovereignAtomicState.INVOICE_CANCELED ||
        existing.state === SovereignAtomicState.EXPIRED ||
        existing.state === SovereignAtomicState.REFUNDED ||
        existing.state === SovereignAtomicState.COMPLETED
      ) {
        return existing;
      }
      if (existing.holdInvoice) {
        return existing;
      }
    }

    // 3. Durable Payment Hash Ownership (Invariant F)
    const existingHash = this.persistence.getSovereignSwapByPaymentHash(paymentHash);
    if (existingHash && existingHash.idempotencyKey !== params.idempotencyKey) {
      throw new Error(
        `PAYMENT_HASH_COLLISION: Payment hash ${paymentHash} is already assigned to active swap ${existingHash.id}`
      );
    }

    // 4. In-flight memoization to prevent local parallel duplicate dispatches
    const inFlight = this.inFlightPrepares.get(params.idempotencyKey);
    if (inFlight) return inFlight;

    const preparePromise = (async () => {
      // Recheck SQLite inside promise
      const recheck = this.persistence.getSovereignSwapByIdempotencyKey(params.idempotencyKey);
      if (recheck && recheck.holdInvoice) {
        this.syncCache(recheck);
        return recheck;
      }

      if (recheck && !recheck.holdInvoice) {
        try {
          const existingInv = await this.lightning.observeHoldInvoice(paymentHash);
          if (existingInv && existingInv.paymentHash.toLowerCase() === paymentHash) {
            const converged = this.updateRecord(recheck.id, {
              holdInvoice: existingInv,
              state: existingInv.state === 'OPEN' ? SovereignAtomicState.INVOICE_CREATED : recheck.state,
            });
            return converged;
          }
        } catch (obsErr: unknown) {
          if (!(obsErr instanceof LightningInvoiceNotFoundError)) {
            throw obsErr;
          }
        }
      }

      const executionId = recheck ? recheck.id : randomUUID();
      const cltv = params.cltvExpiryBlocks ?? 144; // ~24h in Bitcoin blocks
      const timelockSeconds = params.timelockSeconds ?? 43200; // 12h
      const now = new Date();

      if (typeof (this.inventory as any).getReadinessState === 'function') {
        const readiness = await (this.inventory as any).getReadinessState(tokenAddress);
        if (readiness !== 'READY') {
          if (readiness === 'DEFICIT') {
            throw new LiquidityDeficitError(
              `Cannot prepare swap: operator liquidity is in DEFICIT for token ${tokenAddress}`
            );
          } else if (readiness === 'UNKNOWN' || readiness === 'DEGRADED') {
            throw new EvmInventoryUnavailableError(
              `Cannot prepare swap: EVM inventory state is ${readiness} for token ${tokenAddress}`
            );
          } else {
            throw new InventoryNotReadyError(
              `Cannot prepare swap: operator inventory is not ready (state: ${readiness})`
            );
          }
        }
      }

      if (!recheck) {
        // Reserve operator inventory before issuing hold invoice (USDC atomic units, NOT sats)
        const reservation = await this.inventory.reserve(
          params.expectedUsdcAmount,
          tokenAddress,
          executionId
        );
        if (!reservation.reserved) {
          throw new Error(`Insufficient operator liquidity to facilitate atomic swap`);
        }

        const initialRecord: SovereignExecutionRecord = {
          id: executionId,
          idempotencyKey: params.idempotencyKey,
          hashLock: params.hashLock.toLowerCase(),
          claimingAddress: params.claimingAddress.toLowerCase(),
          targetDestinationAddress: params.targetDestinationAddress.toLowerCase(),
          amountSats: params.amountSats,
          expectedUsdcAmount: params.expectedUsdcAmount,
          state: SovereignAtomicState.PLAN_PREPARED,
          reservationId: reservation.reservationId,
          reservedAmountUnits: params.expectedUsdcAmount,
          reservationStatus: 'RESERVED',
          tokenAddress,
          refundAddress,
          evmSwapKey: `swap_${executionId}`,
          cltvExpiryBlocks: cltv,
          timelockSeconds,
          economicFingerprint: fingerprint,
          createdAt: now,
          updatedAt: now,
        };

        // Persist plan in SQLite before calling external LND RPC
        this.persistence.createSovereignSwap(initialRecord, fingerprint);
        this.syncCache(initialRecord);
      }

      // Create Lightning Hold Invoice bound to user's hashlock with ambiguity handling
      let holdInvoice: HoldInvoice;
      try {
        holdInvoice = await this.lightning.createHoldInvoice(
          params.hashLock,
          params.amountSats,
          cltv,
          `Sovereign swap ${executionId}`
        );
      } catch (err: any) {
        // Ambiguity check: did LND actually create the invoice?
        let observed: HoldInvoice | null = null;
        let absenceProven = false;
        try {
          observed = await this.lightning.observeHoldInvoice(paymentHash);
        } catch (observationError: unknown) {
          absenceProven = observationError instanceof LightningInvoiceNotFoundError;
        }

        if (observed && observed.paymentHash.toLowerCase() === paymentHash) {
          holdInvoice = observed;
        } else if (absenceProven) {
          // Only typed authoritative absence permits release.
          const currentRec = recheck ?? this.persistence.getSovereignSwap(executionId);
          const resId = currentRec?.reservationId;
          if (resId && currentRec?.reservationStatus === 'RESERVED') {
            await this.inventory.release(resId);
          }
          this.updateRecord(
            executionId,
            {
              state: SovereignAtomicState.INVOICE_CANCELED,
              reservationStatus: 'RELEASED',
              recoveryRequired: false,
              failureReason: undefined,
            },
            { reason: 'HOLD_INVOICE_AUTHORITATIVELY_NOT_CREATED' }
          );
          throw err;
        } else {
          this.markRecoveryRequired(
            executionId,
            `Ambiguous hold-invoice creation: ${err?.message ?? String(err)}`,
            'HOLD_INVOICE_CREATION_AMBIGUOUS'
          );
          throw new Error(
            `AMBIGUOUS_HOLD_INVOICE_CREATION: Reservation retained for ${executionId}; authoritative Lightning reconciliation required`
          );
        }
      }

      const updated = this.updateRecord(
        executionId,
        {
          state: SovereignAtomicState.INVOICE_CREATED,
          holdInvoice,
          actionInFlight: undefined,
          actionClaimedBy: undefined,
          actionClaimedAt: undefined,
        },
        { reason: 'HOLD_INVOICE_CREATED', evidenceId: holdInvoice.bolt11 }
      );

      return updated;
    })();

    this.inFlightPrepares.set(params.idempotencyKey, preparePromise);
    try {
      return await preparePromise;
    } finally {
      this.inFlightPrepares.delete(params.idempotencyKey);
    }
  }

  /**
   * 2. Detect when Payer has funded the Lightning Hold Invoice
   */
  async onLightningHoldDetected(
    executionId: string,
    _workerId: string = this.defaultWorkerId
  ): Promise<SovereignExecutionRecord> {
    const record = this.mustGetRecord(executionId);

    if (record.state === SovereignAtomicState.LIGHTNING_HELD) {
      return record;
    }

    if (
      record.state !== SovereignAtomicState.INVOICE_CREATED &&
      record.state !== SovereignAtomicState.PLAN_PREPARED
    ) {
      throw new Error(`Invalid transition to LIGHTNING_HELD from state ${record.state}`);
    }

    const invoiceState = await this.lightning.getInvoiceState(record.holdInvoice!.paymentHash);
    if (invoiceState !== 'ACCEPTED') {
      throw new Error(`Invoice is not held by payer (current state: ${invoiceState})`);
    }

    let observedExpiryHeight = record.holdInvoice?.expiryHeight;
    let observedHtlcs: any[] | undefined;
    try {
      const observed = await this.lightning.observeHoldInvoice(record.holdInvoice!.paymentHash);
      if (observed?.expiryHeight !== undefined) {
        observedExpiryHeight = observed.expiryHeight;
      }
      if ((observed as any)?.htlcs) {
        observedHtlcs = (observed as any).htlcs;
      }
    } catch {}

    const updated = this.updateRecord(
      executionId,
      {
        state: SovereignAtomicState.LIGHTNING_HELD,
        holdInvoice: {
          ...record.holdInvoice!,
          state: 'ACCEPTED',
          acceptedAt: new Date(),
          expiryHeight: observedExpiryHeight,
          ...(observedHtlcs ? { htlcs: observedHtlcs } : {}),
        },
      },
      { reason: 'LIGHTNING_ACCEPTED_OBSERVED', evidenceId: record.holdInvoice!.paymentHash }
    );

    return updated;
  }

  /**
   * 3. Fund the EVM HTLC using Operator Liquidity
   */
  async fundEvmHtlc(
    executionId: string,
    workerId: string = 'worker-1'
  ): Promise<SovereignExecutionRecord> {
    const record = this.mustGetRecord(executionId);

    // SEC-14: Concurrency control via action claim
    const claimKey = `fund:${executionId}`;
    if (this.actionClaims.has(claimKey) && this.actionClaims.get(claimKey) !== workerId) {
      throw new Error(`Action ${claimKey} already claimed by another worker (SEC-14 violation)`);
    }

    // Idempotent return if already funded
    if (record.state === SovereignAtomicState.EVM_FUNDED) {
      return record;
    }

    if (
      record.state !== SovereignAtomicState.LIGHTNING_HELD &&
      record.state !== SovereignAtomicState.EVM_FUNDING_PENDING
    ) {
      throw new Error(`Cannot fund EVM HTLC: Lightning payment not held (state: ${record.state})`);
    }

    const claimed = this.persistence.claimSovereignAction(executionId, 'FUND', workerId, this.leaseMs);
    if (!claimed) {
      // Re-read authoritative state; another worker may have completed the action
      const authRecord = this.persistence.getSovereignSwap(executionId);
      if (authRecord && authRecord.state === SovereignAtomicState.EVM_FUNDED) {
        return this.syncCache(authRecord);
      }
      throw new Error(`Action ${claimKey} already claimed by another worker (SEC-14 violation)`);
    }
    this.actionClaims.set(claimKey, workerId);

    try {

      // INVARIANT D check: Verify LND is still ACCEPTED before locking EVM capital!
      const currentLnState = await this.lightning.getInvoiceState(record.holdInvoice!.paymentHash);
      if (currentLnState !== 'ACCEPTED') {
        throw new Error(`Cannot fund Base HTLC: Lightning hold invoice is not in ACCEPTED state (${currentLnState})`);
      }

      // Verify reservation is still valid and amounts/tokens match exactly
      if (record.reservationId && record.reservationStatus && record.reservationStatus !== 'RESERVED') {
        throw new Error(
          `Cannot fund Base HTLC: Reservation ${record.reservationId} is in status ${record.reservationStatus}, expected RESERVED`
        );
      }
      if (
        record.reservedAmountUnits !== undefined &&
        record.reservedAmountUnits !== record.expectedUsdcAmount
      ) {
        throw new Error(
          `Cannot fund Base HTLC: Reserved amount (${record.reservedAmountUnits}) does not match expected USDC amount (${record.expectedUsdcAmount})`
        );
      }

      // Cross-Rail CLTV Safety Window Gate
      await this.assertLightningCltvSafety(record, 'FUND');

      // Calculate asymmetric timelock: EVM lock = now + timelockSeconds (12h)
      const blockTs = await this.evm.getBlockTimestamp();
      const timelockSeconds = record.timelockSeconds ?? 43200;
      const refundLocktime = blockTs + timelockSeconds;
      const swapKey = record.evmSwapKey ?? `swap_${executionId}`;

      // Persist every deterministic HTLC input before the external dispatch.
      this.updateRecord(
        executionId,
        {
          state: SovereignAtomicState.EVM_FUNDING_PENDING,
          evmSwapKey: swapKey,
          refundLocktime,
        },
        { reason: 'EVM_FUNDING_DISPATCH_STARTED' }
      );

      // Lock tokens on HTLCErc20 via EVM backend (calls Phase 5A BaseTransactionManager)
      let fundRes: { txHash: string; blockNumber: number; htlcId?: string | undefined };
      try {
        fundRes = await this.evm.fundHtlc({
          swapKey,
          hashLock: record.hashLock,
          amountUnits: record.expectedUsdcAmount,
          tokenAddress: record.tokenAddress ?? this.defaultTokenAddress,
          refundLocktime,
          claimAddress: record.claimingAddress,
          refundAddress: record.refundAddress ?? this.defaultRefundAddress,
        });
      } catch (err: any) {
        // Reconcile ambiguity: check if HTLC was actually funded on-chain
        try {
          const obs = await this.evm.observeHtlc(swapKey);
          if (obs.funded) {
            fundRes = {
              txHash: '0x_reconciled_funding_after_ambiguity',
              blockNumber: 0,
              htlcId: record.evmHtlcId,
            };
          } else {
            throw err;
          }
        } catch {
          throw err;
        }
      }

      if (record.reservationId) {
        await this.inventory.commit(record.reservationId);
      }

      const updated = this.updateRecord(
        executionId,
        {
          state: SovereignAtomicState.EVM_FUNDED,
          reservationStatus: 'COMMITTED',
          evmSwapKey: swapKey,
          evmHtlcId: fundRes.htlcId ?? record.evmHtlcId,
          evmFundingTxHash: fundRes.txHash,
          refundLocktime,
          actionInFlight: undefined,
          actionClaimedBy: undefined,
          actionClaimedAt: undefined,
        },
        { reason: 'EVM_FUNDED_CONFIRMED', evidenceId: fundRes.txHash }
      );

      return updated;
    } finally {
      this.persistence.releaseSovereignAction(executionId, workerId);
    }
  }

  /**
   * 4a. SOVEREIGN SETTLEMENT GATE:
   * Settles Lightning hold invoice ONLY after confirmed, verified on-chain EVM claim.
   *
   * Invariant A: Preimage must be extracted from verified on-chain Base claim evidence.
   * Invariant B: Once Base is claimed, never cancel Lightning.
   * Invariant C: Once Base is refunded, never settle Lightning.
   */
  async settleLightningFromEvmClaim(
    executionId: string,
    claimTxHash: string,
    workerId: string = 'worker-1'
  ): Promise<SovereignExecutionRecord> {
    const record = this.mustGetRecord(executionId);

    if (!this.finalityPolicy || this.requiredConfirmations === undefined) {
      throw new MissingFinalityPolicyError(
        'MISSING_FINALITY_POLICY: No explicit Base finality policy configured. Irreversible cross-rail action forbidden fail-closed.'
      );
    }

    // INVARIANT C: Mutual exclusion of claim vs refund
    if (
      record.state === SovereignAtomicState.REFUNDED ||
      record.state === SovereignAtomicState.REFUND_ELIGIBLE ||
      record.state === SovereignAtomicState.EVM_REFUND_PENDING ||
      record.state === SovereignAtomicState.EVM_REFUND_CONFIRMED
    ) {
      throw new LightningSettlementGateError(
        `Cannot settle: swap is already in refund path (SEC-10 / INVARIANT C violation)`
      );
    }

    if (
      record.state === SovereignAtomicState.LIGHTNING_SETTLED ||
      record.state === SovereignAtomicState.COMPLETED ||
      record.state === SovereignAtomicState.DESTINATION_PENDING
    ) {
      return record;
    }

    // SEC-14: Cross-process durable action claim via SQLite CAS (authoritative)
    const claimKey = `claim:${executionId}`;

    const claimed = this.persistence.claimSovereignAction(executionId, 'SETTLE', workerId, this.leaseMs);
    if (!claimed) {
      throw new Error(`Action ${claimKey} already claimed by another worker`);
    }

    try {
      // Cross-Rail CLTV Safety Window Gate
      await this.assertLightningCltvSafety(record, 'SETTLE');

      if (
        record.state !== SovereignAtomicState.EVM_FUNDED &&
        record.state !== SovereignAtomicState.EVM_CLAIM_DETECTED &&
        record.state !== SovereignAtomicState.EVM_CLAIM_CONFIRMED &&
        record.state !== SovereignAtomicState.LIGHTNING_SETTLEMENT_PENDING
      ) {
        throw new LightningSettlementGateError(
          `Cannot settle: EVM HTLC is not in EVM_FUNDED state (current state: ${record.state})`
        );
      }

      if (!record.evmHtlcId) {
        throw new LightningSettlementGateError(
          `Cannot settle: execution record ${executionId} is missing evmHtlcId`
        );
      }

      if (typeof (this.evm as any).extractAndVerifyClaimEvidence !== 'function') {
        throw new LightningSettlementGateError(
          `EVM backend does not support authoritative extractAndVerifyClaimEvidence`
        );
      }

      // Authoritative EVM extraction and verification
      let evidence: EvmHtlcClaimedEvidence;
      try {
        evidence = await (this.evm as any).extractAndVerifyClaimEvidence({
          claimTxHash,
          expectedHtlcId: record.evmHtlcId,
          expectedHashLock: record.hashLock,
          expectedClaimAddress: record.claimingAddress,
          expectedAmount: record.expectedUsdcAmount,
          requiredConfirmations: this.requiredConfirmations,
        });
      } catch (err: any) {
        if (err.message?.includes('EVM_FINALITY_DISAGREEMENT')) {
          this.updateRecord(
            executionId,
            { recoveryRequired: true, failureReason: `EVM_FINALITY_DISAGREEMENT: ${err.message}` },
            { reason: 'EVM_FINALITY_DISAGREEMENT' }
          );
        }
        if (err instanceof LightningSettlementGateError) throw err;
        throw new LightningSettlementGateError(
          `LIGHTNING_SETTLEMENT_GATE_VIOLATION: Failed to extract and verify claim evidence: ${err.message}`
        );
      }

      if (evidence.finalityState !== 'FINAL_ENOUGH_FOR_PROTOCOL') {
        throw new LightningSettlementGateError(
          `Claim evidence finality state ${evidence.finalityState} does not satisfy FINAL_ENOUGH_FOR_PROTOCOL`
        );
      }

      // Record EVM_CLAIM_CONFIRMED and pending settlement in SQLite
      this.updateRecord(
        executionId,
        {
          state: SovereignAtomicState.EVM_CLAIM_CONFIRMED,
          evmClaimTxHash: claimTxHash,
        },
        { reason: 'EVM_CLAIM_VERIFIED', evidenceId: claimTxHash }
      );

      this.updateRecord(
        executionId,
        { state: SovereignAtomicState.LIGHTNING_SETTLEMENT_PENDING },
        { reason: 'LIGHTNING_SETTLEMENT_DISPATCHED' }
      );

      // Settle Lightning hold invoice with revealed preimage, handling RPC ambiguity
      let settleRes: { settled: boolean; settledAt: Date };
      try {
        settleRes = await this.lightning.settleHoldInvoice(evidence.preimageRevealed);
      } catch (err: any) {
        // Reconcile ambiguity: inspect LND invoice state
        const lnState = await this.lightning.getInvoiceState(record.holdInvoice!.paymentHash);
        if (lnState === 'SETTLED') {
          settleRes = { settled: true, settledAt: new Date() };
        } else if (lnState === 'CANCELED') {
          // CRITICAL INVARIANT VIOLATION: Base claimed but Lightning invoice canceled
          this.updateRecord(
            executionId,
            { recoveryRequired: true, failureReason: 'CRITICAL: Base claimed but Lightning invoice CANCELED' },
            { reason: 'CRITICAL_INVARIANT_VIOLATION' }
          );
          throw new Error('CRITICAL_INVARIANT_VIOLATION: Base HTLC was claimed but Lightning invoice is CANCELED');
        } else {
          throw err;
        }
      }

      const finalRecord = this.updateRecord(
        executionId,
        {
          state: SovereignAtomicState.DESTINATION_PENDING,
          holdInvoice: {
            ...record.holdInvoice!,
            state: 'SETTLED',
            settledAt: settleRes.settledAt,
          },
          actionInFlight: undefined,
          actionClaimedBy: undefined,
          actionClaimedAt: undefined,
        },
        { reason: 'LIGHTNING_SETTLED_CONFIRMED', evidenceId: evidence.preimageRevealed }
      );

      return finalRecord;
    } finally {
      this.persistence.releaseSovereignAction(executionId, workerId);
    }
  }

  /**
   * 4b. Client Claims EVM HTLC by revealing Preimage (Simulated / Unit test path)
   */
  async claimSwap(
    executionId: string,
    preimage: SecretPreimage | AuthorizedSettlementPreimage,
    workerId: string = 'worker-1'
  ): Promise<SovereignExecutionRecord> {
    const record = this.mustGetRecord(executionId);

    if (!this.finalityPolicy || this.requiredConfirmations === undefined) {
      throw new MissingFinalityPolicyError(
        'MISSING_FINALITY_POLICY: No explicit Base finality policy configured. Irreversible cross-rail action forbidden fail-closed.'
      );
    }

    if (
      record.state === SovereignAtomicState.REFUNDED ||
      record.state === SovereignAtomicState.REFUND_ELIGIBLE ||
      record.state === SovereignAtomicState.EVM_REFUND_PENDING ||
      record.state === SovereignAtomicState.EVM_REFUND_CONFIRMED
    ) {
      throw new Error(`Cannot claim swap: swap is already in refund path (SEC-10 violation)`);
    }

    if (
      record.state !== SovereignAtomicState.EVM_FUNDED &&
      record.state !== SovereignAtomicState.EVM_CLAIM_CONFIRMED &&
      record.state !== SovereignAtomicState.LIGHTNING_SETTLEMENT_PENDING &&
      record.state !== SovereignAtomicState.CLAIMING
    ) {
      throw new Error(`Cannot claim swap: EVM HTLC is not in EVM_FUNDED state (state: ${record.state})`);
    }

    const authPreimage =
      preimage instanceof AuthorizedSettlementPreimage
        ? preimage
        : new AuthorizedSettlementPreimage(preimage);

    if (!authPreimage.matchesHashLock(record.hashLock)) {
      throw new Error(
        `Invalid preimage: Provided preimage does not match execution hashlock ${record.hashLock}`
      );
    }

    // SEC-14: Cross-process durable action claim via SQLite CAS (authoritative)
    const claimKey = `claim:${executionId}`;

    const claimed = this.persistence.claimSovereignAction(executionId, 'CLAIM', workerId, this.leaseMs);
    if (!claimed) {
      throw new Error(`Action ${claimKey} already claimed by another worker`);
    }

    try {
      this.updateRecord(
        executionId,
        { state: SovereignAtomicState.CLAIMING },
        { reason: 'CLIENT_CLAIM_DISPATCHED' }
      );

      let claimTxHash = record.evmClaimTxHash ?? '0x_preclaimed';

      const htlcState = await this.evm.observeHtlc(record.evmSwapKey!);
      if (!htlcState.completed) {
        if (typeof this.evm.claimHtlc !== 'function') {
          throw new Error(
            'EVM backend does not support direct claimHtlc. For sovereign on-chain execution, use settleLightningFromEvmClaim.'
          );
        }

        const claimRes = await this.evm.claimHtlc({
          swapKey: record.evmSwapKey!,
          preimage: authPreimage.getRawHex(),
          destination: record.targetDestinationAddress,
        });

        if (!claimRes.success) {
          this.updateRecord(
            executionId,
            { state: SovereignAtomicState.RECOVERY_REQUIRED, recoveryRequired: true },
            { reason: 'EVM_CLAIM_FAILED' }
          );
          throw new Error(`EVM claim failed; escalated to RECOVERY_REQUIRED`);
        }
        claimTxHash = claimRes.txHash;
      }

      // Preimage proven on EVM -> verify finality before settling Lightning
      if (typeof this.evm.extractAndVerifyClaimEvidence === 'function' && claimTxHash && !claimTxHash.startsWith('0x_preclaimed')) {
        let evidence: EvmHtlcClaimedEvidence;
        try {
          evidence = await this.evm.extractAndVerifyClaimEvidence({
            claimTxHash,
            expectedHtlcId: record.evmHtlcId ?? record.evmSwapKey!,
            expectedHashLock: record.hashLock,
            expectedClaimAddress: record.claimingAddress,
            expectedAmount: record.expectedUsdcAmount,
            requiredConfirmations: this.requiredConfirmations,
          });
        } catch (err: any) {
          if (err.message?.includes('EVM_FINALITY_DISAGREEMENT')) {
            this.updateRecord(
              executionId,
              { recoveryRequired: true, failureReason: `EVM_FINALITY_DISAGREEMENT: ${err.message}` },
              { reason: 'EVM_FINALITY_DISAGREEMENT' }
            );
          }
          throw err;
        }

        if (evidence.finalityState !== 'FINAL_ENOUGH_FOR_PROTOCOL') {
          throw new Error(
            `INSUFFICIENT_FINALITY: Claim evidence finality state (${evidence.finalityState}) does not satisfy FINAL_ENOUGH_FOR_PROTOCOL. Lightning settlement deferred.`
          );
        }
      }

      await this.lightning.settleHoldInvoice(authPreimage.getRawHex());

      const updated = this.updateRecord(
        executionId,
        {
          state: SovereignAtomicState.DESTINATION_PENDING,
          evmClaimTxHash: claimTxHash,
          holdInvoice: {
            ...record.holdInvoice!,
            state: 'SETTLED',
            settledAt: new Date(),
          },
          actionInFlight: undefined,
          actionClaimedBy: undefined,
          actionClaimedAt: undefined,
        },
        { reason: 'CLAIM_AND_SETTLE_COMPLETED' }
      );

      return updated;
    } finally {
      this.persistence.releaseSovereignAction(executionId, workerId);
    }
  }

  /**
   * 5. Confirm Final Base Delivery
   */
  confirmBaseDelivery(executionId: string, destinationTxHash: string): SovereignExecutionRecord {
    const record = this.mustGetRecord(executionId);
    if (record.state === SovereignAtomicState.COMPLETED) {
      return record;
    }

    if (
      record.state !== SovereignAtomicState.DESTINATION_PENDING &&
      record.state !== SovereignAtomicState.LIGHTNING_SETTLED
    ) {
      throw new Error(`Cannot complete delivery: state must be DESTINATION_PENDING (current: ${record.state})`);
    }

    const updated = this.updateRecord(
      executionId,
      {
        state: SovereignAtomicState.COMPLETED,
        destinationTxHash,
      },
      { reason: 'FINAL_DELIVERY_CONFIRMED', evidenceId: destinationTxHash }
    );

    return updated;
  }

  /**
   * 6. Refund Flow (if client fails to claim within timelock)
   *
   * Invariant B: Never refund if Base was claimed.
   * Invariant D: Never cancel Lightning while funded Base can still be claimed.
   */
  async processRefund(
    executionId: string,
    workerId: string = this.defaultWorkerId
  ): Promise<SovereignExecutionRecord> {
    const record = this.mustGetRecord(executionId);

    if (record.state === SovereignAtomicState.REFUNDED) {
      return record;
    }

    // INVARIANT B: Claim and refund mutual exclusion
    if (
      record.state === SovereignAtomicState.CLAIMING ||
      record.state === SovereignAtomicState.EVM_CLAIM_CONFIRMED ||
      record.state === SovereignAtomicState.LIGHTNING_SETTLED ||
      record.state === SovereignAtomicState.DESTINATION_PENDING ||
      record.state === SovereignAtomicState.COMPLETED
    ) {
      throw new Error(`Cannot refund swap: swap already claimed or completed (SEC-10 / INVARIANT B violation)`);
    }

    const claimed = this.persistence.claimSovereignAction(executionId, 'REFUND', workerId, this.leaseMs);
    if (!claimed) {
      // Re-read authoritative state; another worker may have completed the refund
      const authRecord = this.persistence.getSovereignSwap(executionId);
      if (authRecord && authRecord.state === SovereignAtomicState.REFUNDED) {
        return this.syncCache(authRecord);
      }
      throw new Error(`Action REFUND for ${executionId} already claimed by another worker`);
    }

    try {
      if (record.state === SovereignAtomicState.INVOICE_CREATED) {
        // Unfunded invoice expired -> cancel Lightning safely
        await this.lightning.cancelHoldInvoice(record.holdInvoice!.paymentHash);
        if (record.reservationId && record.reservationStatus === 'RESERVED') {
          await this.inventory.release(record.reservationId);
        }
        return this.updateRecord(
          executionId,
          {
            state: SovereignAtomicState.EXPIRED,
            reservationStatus: 'RELEASED',
            holdInvoice: { ...record.holdInvoice!, state: 'CANCELED', canceledAt: new Date() },
            actionInFlight: undefined,
            actionClaimedBy: undefined,
            actionClaimedAt: undefined,
          },
          { reason: 'UNFUNDED_INVOICE_EXPIRED' }
        );
      }

      if (record.state === SovereignAtomicState.LIGHTNING_HELD) {
        // Lightning payment held, but EVM funding was never initiated
        // Double check EVM is NOT funded before cancelling
        if (record.evmSwapKey) {
          const obs = await this.evm.observeHtlc(record.evmSwapKey);
          if (obs.funded) {
            throw new Error(`Cannot cancel Lightning: Base HTLC is funded! (INVARIANT D violation)`);
          }
        }

        await this.lightning.cancelHoldInvoice(record.holdInvoice!.paymentHash);
        if (record.reservationId && record.reservationStatus === 'RESERVED') {
          await this.inventory.release(record.reservationId);
        }
        return this.updateRecord(
          executionId,
          {
            state: SovereignAtomicState.INVOICE_CANCELED,
            reservationStatus: 'RELEASED',
            holdInvoice: { ...record.holdInvoice!, state: 'CANCELED', canceledAt: new Date() },
            actionInFlight: undefined,
            actionClaimedBy: undefined,
            actionClaimedAt: undefined,
          },
          { reason: 'LIGHTNING_HELD_CANCELLED_BEFORE_EVM_FUND' }
        );
      }

      if (
        record.state === SovereignAtomicState.EVM_FUNDED ||
        record.state === SovereignAtomicState.REFUND_ELIGIBLE ||
        record.state === SovereignAtomicState.EVM_REFUND_PENDING ||
        record.state === SovereignAtomicState.EVM_REFUND_CONFIRMED ||
        record.state === SovereignAtomicState.LIGHTNING_CANCEL_PENDING
      ) {
        if (!this.finalityPolicy || this.requiredConfirmations === undefined) {
          throw new MissingFinalityPolicyError(
            'MISSING_FINALITY_POLICY: No explicit Base finality policy configured. Irreversible cross-rail action forbidden fail-closed.'
          );
        }

        const swapKey = record.evmSwapKey!;
        const htlcState = await this.evm.observeHtlc(swapKey);

        // RACE A & RACE C: Client claim arrived near / during refund evaluation
        if (htlcState.completed) {
          // Client claimed on-chain! Mutual exclusion forbids refund. Settle Lightning instead.
          this.updateRecord(
            executionId,
            { state: SovereignAtomicState.EVM_CLAIM_CONFIRMED },
            { reason: 'RACE_DETECTED_CLIENT_CLAIM_WON_ON_CHAIN' }
          );
          throw new Error('MUTUAL_EXCLUSION_VIOLATION: HTLC already claimed on-chain; refund aborted');
        }

        if (!htlcState.refunded) {
          // Verify consensus timelock
          if (htlcState.blockTimestamp < htlcState.timelock) {
            throw new Error(
              `Timelock not expired on EVM (block: ${htlcState.blockTimestamp} < lock: ${htlcState.timelock})`
            );
          }

          this.updateRecord(
            executionId,
            { state: SovereignAtomicState.EVM_REFUND_PENDING },
            { reason: 'EVM_REFUND_DISPATCH_STARTED' }
          );

          // Execute Base refund (calls Phase 5A BaseTransactionManager)
          let refRes: { txHash: string; blockNumber: number; refunded: boolean };
          try {
            refRes = await this.evm.refundHtlc(swapKey);
          } catch (err: any) {
            // Check ambiguity
            const recheck = await this.evm.observeHtlc(swapKey);
            if (recheck.refunded) {
              refRes = { txHash: '0x_reconciled_refund', blockNumber: 0, refunded: true };
            } else {
              throw err;
            }
          }

          this.updateRecord(
            executionId,
            {
              state: SovereignAtomicState.EVM_REFUND_CONFIRMED,
              evmRefundTxHash: refRes.txHash,
            },
            { reason: 'EVM_REFUND_CONFIRMED', evidenceId: refRes.txHash }
          );
        }

        // Verify refund finality before cancelling Lightning
        const refundTxHash = this.mustGetRecord(executionId).evmRefundTxHash ?? record.evmRefundTxHash;
        if (
          typeof this.evm.verifyRefundEvidence === 'function' &&
          refundTxHash &&
          !refundTxHash.startsWith('0x_reconciled')
        ) {
          let refundEvidence: EvmHtlcRefundedEvidence;
          try {
            refundEvidence = await this.evm.verifyRefundEvidence({
              refundTxHash,
              expectedHtlcId: record.evmHtlcId ?? swapKey,
              expectedRefundAddress: record.refundAddress ?? '',
              expectedAmount: record.expectedUsdcAmount,
              requiredConfirmations: this.requiredConfirmations,
            });
          } catch (err: any) {
            if (err.message?.includes('EVM_FINALITY_DISAGREEMENT')) {
              this.updateRecord(
                executionId,
                { recoveryRequired: true, failureReason: `EVM_FINALITY_DISAGREEMENT: ${err.message}` },
                { reason: 'EVM_FINALITY_DISAGREEMENT' }
              );
            }
            throw err;
          }

          if (refundEvidence.finalityState !== 'FINAL_ENOUGH_FOR_PROTOCOL') {
            throw new Error(
              `INSUFFICIENT_FINALITY: Refund evidence finality state (${refundEvidence.finalityState}) does not satisfy FINAL_ENOUGH_FOR_PROTOCOL. Lightning cancellation deferred.`
            );
          }
        }

        // Now that Base collateral is authoritatively refunded, cancel Lightning hold invoice
        this.updateRecord(
          executionId,
          { state: SovereignAtomicState.LIGHTNING_CANCEL_PENDING },
          { reason: 'LIGHTNING_CANCEL_DISPATCHED' }
        );

        let cancelRes: { canceled: boolean; canceledAt: Date };
        try {
          cancelRes = await this.lightning.cancelHoldInvoice(record.holdInvoice!.paymentHash);
        } catch (err: any) {
          const lnState = await this.lightning.getInvoiceState(record.holdInvoice!.paymentHash);
          if (lnState === 'CANCELED') {
            cancelRes = { canceled: true, canceledAt: new Date() };
          } else if (lnState === 'SETTLED') {
            // CRITICAL INVARIANT VIOLATION: Base refunded but Lightning invoice settled
            this.updateRecord(
              executionId,
              { recoveryRequired: true, failureReason: 'CRITICAL: Base refunded but Lightning invoice SETTLED' },
              { reason: 'CRITICAL_INVARIANT_VIOLATION' }
            );
            throw new Error('CRITICAL_INVARIANT_VIOLATION: Base HTLC refunded but Lightning invoice is SETTLED');
          } else {
            throw err;
          }
        }

        if (record.reservationId && record.reservationStatus === 'COMMITTED') {
          if (typeof (this.inventory as any).restoreRefund === 'function') {
            await (this.inventory as any).restoreRefund(record.reservationId);
          } else {
            await this.inventory.release(record.reservationId);
          }
        }

        const terminalRefunded = this.updateRecord(
          executionId,
          {
            state: SovereignAtomicState.REFUNDED,
            reservationStatus: 'RELEASED',
            holdInvoice: {
              ...record.holdInvoice!,
              state: 'CANCELED',
              canceledAt: cancelRes.canceledAt,
            },
            actionInFlight: undefined,
            actionClaimedBy: undefined,
            actionClaimedAt: undefined,
          },
          { reason: 'SWAP_TERMINAL_REFUNDED_AND_CANCELED' }
        );

        return terminalRefunded;
      }

      throw new Error(`Refund not supported for state: ${record.state}`);
    } finally {
      this.persistence.releaseSovereignAction(executionId, workerId);
    }
  }

  /**
   * Authoritative Restart Reconciliation for a single swap.
   * Inspects external chain state (LND + Base) and converges deterministically.
   */
  async reconcileSwap(
    executionId: string,
    workerId: string = this.defaultWorkerId
  ): Promise<SovereignExecutionRecord> {
    let record = this.mustGetRecord(executionId);

    // Terminal states require no action
    if (
      record.state === SovereignAtomicState.COMPLETED ||
      record.state === SovereignAtomicState.REFUNDED ||
      record.state === SovereignAtomicState.INVOICE_CANCELED ||
      record.state === SovereignAtomicState.EXPIRED
    ) {
      return record;
    }

    // Acquire action claim for reconciliation
    const claimed = this.persistence.claimSovereignAction(executionId, 'RECONCILE', workerId, this.leaseMs);
    if (!claimed) {
      return record;
    }

    try {

      const lightningObservation = await this.observeLightningForRecovery(record);
      const evmObservation = await this.observeEvmForRecovery(record);

      if (lightningObservation.kind === 'UNKNOWN' || evmObservation.kind === 'UNKNOWN') {
        const reasons = [
          lightningObservation.kind === 'UNKNOWN' ? `Lightning: ${lightningObservation.reason}` : '',
          evmObservation.kind === 'UNKNOWN' ? `EVM: ${evmObservation.reason}` : '',
        ].filter(Boolean).join('; ');
        return this.markRecoveryRequired(
          executionId,
          `Authoritative cross-rail observation unavailable: ${reasons}`,
          'RECONCILIATION_EXTERNAL_STATE_UNKNOWN'
        );
      }

      const observedInvoice = lightningObservation.kind === 'FOUND'
        ? lightningObservation.invoice
        : undefined;
      const lnState = observedInvoice?.state;
      const evmState = 'state' in evmObservation ? evmObservation.state : undefined;

      const isBaseClaimed = evmObservation.kind === 'CLAIMED' || evmState?.completed === true;
      const isBaseRefunded = evmObservation.kind === 'REFUNDED' || evmState?.refunded === true;
      const isBaseFunded = evmObservation.kind === 'FUNDED' || (evmState?.funded && !evmState?.completed && !evmState?.refunded);
      const isBaseAbsent = evmObservation.kind === 'NOT_FUNDED_PROVEN';

      // Bind discovered holdInvoice to record if missing
      if (!record.holdInvoice && observedInvoice) {
        record = this.updateRecord(executionId, { holdInvoice: observedInvoice });
      }



      // =========================================================================
      // CASE 1: Lightning is already SETTLED externally
      // =========================================================================
      if (lnState === 'SETTLED') {
        // CASE A: Lightning = SETTLED and Base = CLAIMED / completed
        if (isBaseClaimed) {
          if (!record.reservationId) {
            return this.markRecoveryRequired(
              executionId,
              `CRITICAL_INVARIANT_VIOLATION: Base HTLC is CLAIMED but swap has no valid reservationId; economic inconsistency`,
              'MISSING_RESERVATION_ID'
            );
          }
          const isSqliteInventory =
            this.inventory instanceof SqliteLiquidityInventory ||
            typeof (this.inventory as any).getPersistence === 'function';

          if (isSqliteInventory || this.persistence.getLiquidityReservation(record.reservationId)) {
            try {
              this.persistence.settleLiquidityReservation(record.reservationId);
            } catch (settleErr: any) {
              return this.markRecoveryRequired(
                executionId,
                `CRITICAL_INVARIANT_VIOLATION: Base HTLC is CLAIMED but reservation settlement failed (${settleErr?.message ?? settleErr}); economic inconsistency`,
                'RESERVATION_SETTLE_FAILED'
              );
            }
          } else {
            try {
              if (typeof (this.inventory as any).settle === 'function') {
                await (this.inventory as any).settle(record.reservationId);
              }
            } catch (settleErr: any) {
              return this.markRecoveryRequired(
                executionId,
                `CRITICAL_INVARIANT_VIOLATION: Base HTLC is CLAIMED but reservation settlement failed (${settleErr?.message ?? settleErr}); economic inconsistency`,
                'RESERVATION_SETTLE_FAILED'
              );
            }
          }
          return this.updateRecord(
            executionId,
            {
              state: SovereignAtomicState.COMPLETED,
              reservationStatus: 'SETTLED',
              holdInvoice: { ...observedInvoice!, state: 'SETTLED' },
              recoveryRequired: false,
              failureReason: undefined,
            },
            { reason: 'RECONCILED_FROM_CROSS_RAIL_COMPLETED' }
          );
        }

        // CASE B: Lightning = SETTLED and Base = FUNDED / LOCKED
        if (isBaseFunded) {
          return this.markRecoveryRequired(
            executionId,
            'Lightning is SETTLED but Base HTLC remains LOCKED/FUNDED; claim confirmation required',
            'CROSS_RAIL_LN_SETTLED_BASE_LOCKED'
          );
        }

        // CASE C: Lightning = SETTLED and Base = NOT_FUNDED_PROVEN
        if (isBaseAbsent) {
          return this.markRecoveryRequired(
            executionId,
            'CRITICAL_INVARIANT_VIOLATION: Lightning is SETTLED but Base HTLC was proven NOT_FUNDED',
            'CROSS_RAIL_INVARIANT_VIOLATION'
          );
        }

        // CASE D: Lightning = SETTLED and Base = REFUNDED
        if (isBaseRefunded) {
          return this.markRecoveryRequired(
            executionId,
            'CRITICAL_INVARIANT_VIOLATION: Lightning is SETTLED but Base HTLC is REFUNDED',
            'CROSS_RAIL_INVARIANT_VIOLATION'
          );
        }

        // PENDING / INCOMPLETE
        return this.markRecoveryRequired(
          executionId,
          'Lightning is SETTLED but Base HTLC state is not completed',
          'CROSS_RAIL_LN_SETTLED_BASE_INCOMPLETE'
        );
      }

      // =========================================================================
      // CASE 2: Base HTLC is CLAIMED on-chain
      // =========================================================================
      if (isBaseClaimed) {
        // CASE F: Lightning = CANCELED (or NOT_FOUND) and Base = CLAIMED
        if (lnState === 'CANCELED' || lightningObservation.kind === 'NOT_FOUND') {
          return this.markRecoveryRequired(
            executionId,
            `CRITICAL_INVARIANT_VIOLATION: Base HTLC is CLAIMED but Lightning invoice is ${lightningObservation.kind === 'NOT_FOUND' ? 'NOT_FOUND' : 'CANCELED'}`,
            'CROSS_RAIL_INVARIANT_VIOLATION'
          );
        }

        // Base = CLAIMED and Lightning = OPEN
        if (lnState === 'OPEN') {
          return this.markRecoveryRequired(
            executionId,
            'CRITICAL_INVARIANT_VIOLATION: Base HTLC is CLAIMED but Lightning invoice is OPEN',
            'CROSS_RAIL_INVARIANT_VIOLATION'
          );
        }

        if (lnState === 'ACCEPTED') {
          // If we have claim evidence or can extract it, settle LND
          if (record.evmClaimTxHash) {
            const currentRetries = record.settleRetryCount ?? 0;
            if (currentRetries >= this.maxRetries) {
              return this.markRecoveryRequired(
                executionId,
                `Max mutation retries (${this.maxRetries}) exceeded while attempting to settle Lightning from EVM claim`,
                'MAX_RETRIES_EXCEEDED'
              );
            }
            this.updateRecord(executionId, {
              settleRetryCount: currentRetries + 1,
              retryCount: (record.retryCount ?? 0) + 1,
            });
            try {
              return await this.settleLightningFromEvmClaim(executionId, record.evmClaimTxHash, workerId);
            } catch {
              // Settlement in progress or manual review needed
            }
          } else {
            if (!record.reservationId) {
              return this.markRecoveryRequired(
                executionId,
                `CRITICAL_INVARIANT_VIOLATION: Base HTLC is CLAIMED but swap has no valid reservationId; economic inconsistency`,
                'MISSING_RESERVATION_ID'
              );
            }
            const isSqliteInventory =
              this.inventory instanceof SqliteLiquidityInventory ||
              typeof (this.inventory as any).getPersistence === 'function';

            if (isSqliteInventory || this.persistence.getLiquidityReservation(record.reservationId)) {
              try {
                this.persistence.commitReservationAndAdvanceSwapToFunded(record.reservationId, executionId);
              } catch (commitErr: any) {
                return this.markRecoveryRequired(
                  executionId,
                  `CRITICAL_INVARIANT_VIOLATION: Base HTLC is CLAIMED but reservation commit failed (${commitErr?.message ?? commitErr}); economic inconsistency`,
                  'RESERVATION_COMMIT_FAILED'
                );
              }
            } else if (record.reservationStatus === 'RESERVED' || record.reservationStatus === undefined) {
              try {
                await this.inventory.commit(record.reservationId);
              } catch (commitErr: any) {
                return this.markRecoveryRequired(
                  executionId,
                  `CRITICAL_INVARIANT_VIOLATION: Base HTLC is CLAIMED but reservation commit failed (${commitErr?.message ?? commitErr}); economic inconsistency`,
                  'RESERVATION_COMMIT_FAILED'
                );
              }
            }
            return this.updateRecord(
              executionId,
              {
                state: SovereignAtomicState.EVM_CLAIM_DETECTED,
                reservationStatus: 'COMMITTED',
                recoveryRequired: true,
                failureReason: 'Base HTLC is CLAIMED onchain but claim transaction hash / preimage is pending extraction to settle Lightning',
              },
              { reason: 'RECONCILED_FROM_EVM_CLAIMED_WITHOUT_TX_HASH' }
            );
          }
        }

        return this.mustGetRecord(executionId);
      }

      // =========================================================================
      // CASE 3: Base HTLC is REFUNDED on-chain
      // =========================================================================
      if (isBaseRefunded) {
        if (lnState === 'OPEN' || lnState === 'ACCEPTED') {
          const cleanHash = record.holdInvoice?.paymentHash ?? record.hashLock.replace(/^0x/, '').toLowerCase();
          const currentRetries = record.cancelRetryCount ?? 0;
          if (currentRetries >= this.maxRetries) {
            return this.markRecoveryRequired(
              executionId,
              `Max mutation retries (${this.maxRetries}) exceeded while attempting to cancel Lightning hold invoice`,
              'MAX_RETRIES_EXCEEDED'
            );
          }
          this.updateRecord(executionId, {
            cancelRetryCount: currentRetries + 1,
            retryCount: (record.retryCount ?? 0) + 1,
          });
          let cancelConfirmed = false;
          let authoritativeCanceledAt: Date | undefined;

          try {
            const cancelRes = await this.lightning.cancelHoldInvoice(cleanHash);
            if (cancelRes && cancelRes.canceled) {
              cancelConfirmed = true;
              authoritativeCanceledAt = cancelRes.canceledAt;
            }
          } catch (cancelErr: unknown) {
            // Attempt authoritative observation to see if invoice was canceled despite call error
            try {
              const recheckObs = await this.observeLightningForRecovery(record);
              if (recheckObs.kind === 'FOUND' && recheckObs.invoice.state === 'CANCELED') {
                cancelConfirmed = true;
                authoritativeCanceledAt = recheckObs.invoice.canceledAt ?? new Date();
              }
            } catch {
              // Re-observation failed, will mark recovery required below
            }
          }

          if (!cancelConfirmed) {
            return this.markRecoveryRequired(
              executionId,
              `Base HTLC is REFUNDED but Lightning invoice cancellation could not be authoritatively confirmed (current lnState: ${lnState}); reservation retained`,
              'LIGHTNING_CANCEL_AMBIGUOUS'
            );
          }

          // Authoritative cancellation confirmed
          if (!record.reservationId) {
            return this.markRecoveryRequired(
              executionId,
              `CRITICAL_INVARIANT_VIOLATION: Base HTLC is REFUNDED but swap has no valid reservationId; economic inconsistency`,
              'MISSING_RESERVATION_ID'
            );
          }
          if (record.reservationStatus === 'COMMITTED') {
            if (typeof (this.inventory as any).restoreRefund === 'function') {
              await (this.inventory as any).restoreRefund(record.reservationId);
            } else {
              await this.inventory.release(record.reservationId);
            }
          } else if (record.reservationStatus === 'RESERVED') {
            await this.inventory.release(record.reservationId);
          }

          return this.updateRecord(
            executionId,
            {
              state: SovereignAtomicState.REFUNDED,
              reservationStatus: 'RELEASED',
              holdInvoice: observedInvoice
                ? { ...observedInvoice, state: 'CANCELED', canceledAt: authoritativeCanceledAt ?? observedInvoice.canceledAt ?? new Date() }
                : record.holdInvoice
                  ? { ...record.holdInvoice, state: 'CANCELED', canceledAt: authoritativeCanceledAt ?? record.holdInvoice.canceledAt ?? new Date() }
                  : undefined,
              recoveryRequired: false,
              failureReason: undefined,
            },
            { reason: 'RECONCILED_FROM_AUTHORITATIVE_EVM_REFUNDED' }
          );
        }

        if (lnState === 'CANCELED' || lightningObservation.kind === 'NOT_FOUND') {
          if (!record.reservationId) {
            return this.markRecoveryRequired(
              executionId,
              `CRITICAL_INVARIANT_VIOLATION: Base HTLC is REFUNDED but swap has no valid reservationId; economic inconsistency`,
              'MISSING_RESERVATION_ID'
            );
          }
          if (record.reservationStatus === 'COMMITTED') {
            if (typeof (this.inventory as any).restoreRefund === 'function') {
              await (this.inventory as any).restoreRefund(record.reservationId);
            } else {
              await this.inventory.release(record.reservationId);
            }
          } else if (record.reservationStatus === 'RESERVED') {
            await this.inventory.release(record.reservationId);
          }

          return this.updateRecord(
            executionId,
            {
              state: SovereignAtomicState.REFUNDED,
              reservationStatus: 'RELEASED',
              holdInvoice: observedInvoice
                ? { ...observedInvoice, state: 'CANCELED', canceledAt: observedInvoice.canceledAt ?? new Date() }
                : record.holdInvoice
                  ? { ...record.holdInvoice, state: 'CANCELED', canceledAt: record.holdInvoice.canceledAt ?? new Date() }
                  : undefined,
              recoveryRequired: false,
              failureReason: undefined,
            },
            { reason: 'RECONCILED_FROM_AUTHORITATIVE_EVM_REFUNDED' }
          );
        }
      }

      // =========================================================================
      // CASE 4: Base HTLC is LOCKED (funded) on-chain
      // =========================================================================
      if (isBaseFunded) {
        // CASE G: Lightning = CANCELED (or NOT_FOUND) and Base = FUNDED / LOCKED
        if (lnState === 'CANCELED' || lightningObservation.kind === 'NOT_FOUND') {
          return this.markRecoveryRequired(
            executionId,
            `CRITICAL_INVARIANT_VIOLATION: Base HTLC is FUNDED but Lightning invoice is ${lightningObservation.kind === 'NOT_FOUND' ? 'NOT_FOUND' : 'CANCELED'}; reservation retained`,
            'CROSS_RAIL_INVARIANT_VIOLATION'
          );
        }

        // Base = FUNDED and Lightning = OPEN
        if (lnState === 'OPEN') {
          return this.markRecoveryRequired(
            executionId,
            'CRITICAL_INVARIANT_VIOLATION: Base HTLC is FUNDED but Lightning invoice is OPEN; reservation retained',
            'CROSS_RAIL_INVARIANT_VIOLATION'
          );
        }

        if (evmState && evmState.blockTimestamp >= evmState.timelock) {
          // Timelock expired -> resume refund
          const currentRetries = record.refundRetryCount ?? 0;
          if (currentRetries >= this.maxRetries) {
            return this.markRecoveryRequired(
              executionId,
              `Max mutation retries (${this.maxRetries}) exceeded while attempting to process Base refund`,
              'MAX_RETRIES_EXCEEDED'
            );
          }
          this.updateRecord(executionId, {
            refundRetryCount: currentRetries + 1,
            retryCount: (record.retryCount ?? 0) + 1,
          });
          try {
            return await this.processRefund(executionId, workerId);
          } catch {
            return this.mustGetRecord(executionId);
          }
        } else {
          // Locked and waiting for claim or timelock
          if (!record.reservationId) {
            return this.markRecoveryRequired(
              executionId,
              `CRITICAL_INVARIANT_VIOLATION: Base HTLC is LOCKED but swap has no valid reservationId; economic inconsistency`,
              'MISSING_RESERVATION_ID'
            );
          }
          const isSqliteInventory =
            this.inventory instanceof SqliteLiquidityInventory ||
            typeof (this.inventory as any).getPersistence === 'function';

          if (isSqliteInventory || this.persistence.getLiquidityReservation(record.reservationId)) {
            try {
              this.persistence.commitReservationAndAdvanceSwapToFunded(record.reservationId, executionId);
            } catch (commitErr: any) {
              return this.markRecoveryRequired(
                executionId,
                `CRITICAL_INVARIANT_VIOLATION: Base HTLC is LOCKED but reservation commit failed (${commitErr?.message ?? commitErr}); economic inconsistency`,
                'RESERVATION_COMMIT_FAILED'
              );
            }
          } else if (record.reservationStatus === 'RESERVED' || record.reservationStatus === undefined) {
            try {
              await this.inventory.commit(record.reservationId);
            } catch (commitErr: any) {
              return this.markRecoveryRequired(
                executionId,
                `CRITICAL_INVARIANT_VIOLATION: Base HTLC is LOCKED but reservation commit failed (${commitErr?.message ?? commitErr}); economic inconsistency`,
                'RESERVATION_COMMIT_FAILED'
              );
            }
          }
          return this.updateRecord(
            executionId,
            {
              state: SovereignAtomicState.EVM_FUNDED,
              reservationStatus: 'COMMITTED',
              recoveryRequired: false,
              failureReason: undefined,
              holdInvoice: observedInvoice ?? record.holdInvoice,
            },
            { reason: 'RECONCILED_EVM_LOCKED_WAITING' }
          );
        }
      }

      // CASE 5: A successful authoritative EVM read proves no HTLC exists.
      if (evmObservation.kind === 'NOT_FUNDED_PROVEN') {
        if (record.state === SovereignAtomicState.EVM_FUNDING_PENDING) {
          const intent = record.evmSwapKey ? this.persistence.getEvmIntentBySwapKey(record.evmSwapKey, 'FUND') : null;
          if (!intent) {
            return this.markRecoveryRequired(
              executionId,
              `EVM_FUNDING_PENDING swap ${executionId} has no durable FUND intent; cannot safely confirm or retry funding; reservation retained`,
              'MISSING_DURABLE_FUND_INTENT'
            );
          }
          if (['FAILED', 'REVERTED', 'NONCE_CONFLICT', 'PENDING', 'CREATED', 'NONCE_RESERVED', 'DISPATCHING'].includes(intent.status)) {
            return this.markRecoveryRequired(
              executionId,
              `Base FUND intent ${intent.id} is in status ${intent.status}; recovery pass retains reservation with zero blind retry`,
              `BASE_FUNDING_${intent.status}_CROSS_RAIL_RESERVED`
            );
          }
        }

        if (
          record.state === SovereignAtomicState.PLAN_PREPARED ||
          record.state === SovereignAtomicState.INVOICE_CREATED ||
          record.state === SovereignAtomicState.RECOVERY_REQUIRED
        ) {
          if (lnState === 'OPEN') {
            return this.updateRecord(
              executionId,
              {
                state: SovereignAtomicState.INVOICE_CREATED,
                holdInvoice: observedInvoice,
                recoveryRequired: false,
                failureReason: undefined,
              },
              { reason: 'RECONCILED_FROM_OPEN_INVOICE_AND_EVM_ABSENCE' }
            );
          }
          if (lnState === 'ACCEPTED' && record.state !== SovereignAtomicState.RECOVERY_REQUIRED) {
            record = this.updateRecord(
              executionId,
              {
                state: SovereignAtomicState.LIGHTNING_HELD,
                holdInvoice: observedInvoice,
                recoveryRequired: false,
                failureReason: undefined,
              },
              { reason: 'RECONCILED_FROM_ACCEPTED_INVOICE_AND_EVM_ABSENCE' }
            );
            const currentRetries = record.fundRetryCount ?? 0;
            if (currentRetries >= this.maxRetries) {
              return this.markRecoveryRequired(
                executionId,
                `EVM funding retry limit (${this.maxRetries}) exceeded`,
                'MAX_RETRIES_EXCEEDED'
              );
            }
            this.updateRecord(executionId, {
              fundRetryCount: currentRetries + 1,
              retryCount: (record.retryCount ?? 0) + 1,
            });
            try {
              return await this.fundEvmHtlc(executionId, workerId);
            } catch {
              return this.mustGetRecord(executionId);
            }
          }
        }

        if (lnState === 'ACCEPTED') {
          // Only the pristine held state may begin funding. Pending/recovery
          // states require durable intent recovery and are never blindly retried.
          if (record.state === SovereignAtomicState.LIGHTNING_HELD) {
            const currentRetries = record.fundRetryCount ?? 0;
            if (currentRetries >= this.maxRetries) {
              return this.markRecoveryRequired(
                executionId,
                `EVM funding retry limit (${this.maxRetries}) exceeded`,
                'MAX_RETRIES_EXCEEDED'
              );
            }
            this.updateRecord(executionId, {
              fundRetryCount: currentRetries + 1,
              retryCount: (record.retryCount ?? 0) + 1,
            });
            try {
              return await this.fundEvmHtlc(executionId, workerId);
            } catch {
              return this.mustGetRecord(executionId);
            }
          }
          return this.markRecoveryRequired(
            executionId,
            'Lightning remains ACCEPTED while Base funding is unresolved',
            'CROSS_RAIL_OBLIGATION_REMAINS_HELD'
          );
        } else if (lnState === 'CANCELED' || lightningObservation.kind === 'NOT_FOUND') {
          if (record.reservationId && record.reservationStatus === 'RESERVED') {
            await this.inventory.release(record.reservationId);
          }
          const holdInvoice = observedInvoice
            ? { ...observedInvoice, state: 'CANCELED' as const, canceledAt: observedInvoice.canceledAt ?? new Date() }
            : undefined;
          return this.updateRecord(
            executionId,
            {
              state: SovereignAtomicState.INVOICE_CANCELED,
              reservationStatus: 'RELEASED',
              ...(holdInvoice ? { holdInvoice } : {}),
              recoveryRequired: false,
              failureReason: undefined,
            },
            { reason: lightningObservation.kind === 'NOT_FOUND'
                ? 'RECONCILED_FROM_AUTHORITATIVE_LND_ABSENCE_AND_EVM_ABSENCE'
                : 'RECONCILED_FROM_LND_CANCELED_AND_EVM_ABSENCE' }
          );
        }
      }

      return this.mustGetRecord(executionId);
    } finally {
      this.persistence.releaseSovereignAction(executionId, workerId);
    }
  }

  /**
   * Authoritative Restart Reconciliation: Enumerates all non-terminal swaps in SQLite
   * and reconciles them against external chains.
   */
  async reconcileAll(workerId: string = this.defaultWorkerId): Promise<SovereignExecutionRecord[]> {
    const nonTerminal = this.persistence.listNonTerminalSovereignSwaps();
    const results: SovereignExecutionRecord[] = [];

    for (const swap of nonTerminal) {
      try {
        const reconciled = await this.reconcileSwap(swap.id, workerId);
        results.push(reconciled);
      } catch (err: any) {
        const current = this.persistence.getSovereignSwap(swap.id);
        if (current) results.push(current);
      }
    }

    return results;
  }

  public getExecution(executionId: string): SovereignExecutionRecord | undefined {
    const cached = this.records.get(executionId);
    if (cached) return cached;
    const fromDb = this.persistence.getSovereignSwap(executionId);
    if (fromDb) {
      this.syncCache(fromDb);
      return fromDb;
    }
    return undefined;
  }

  public getExecutionByIdempotencyKey(idempotencyKey: string): SovereignExecutionRecord | undefined {
    const fromDb = this.persistence.getSovereignSwapByIdempotencyKey(idempotencyKey);
    if (fromDb) {
      this.syncCache(fromDb);
      return fromDb;
    }
    return undefined;
  }

  public getTransitions(executionId: string): SovereignSwapTransition[] {
    return this.persistence.getSovereignTransitions(executionId);
  }

  private mustGetRecord(executionId: string): SovereignExecutionRecord {
    // Always read authoritative state from SQLite; in-memory cache is warmed after
    const fromDb = this.persistence.getSovereignSwap(executionId);
    if (fromDb) {
      return this.syncCache(fromDb);
    }
    const cached = this.records.get(executionId);
    if (cached) return cached;
    throw new Error(`Execution record not found: ${executionId}`);
  }

  private syncCache(record: SovereignExecutionRecord): SovereignExecutionRecord {
    const existing = this.records.get(record.id);
    if (existing) {
      const degradedCltv = existing.holdInvoice?.cltvExpiryBlocks;
      Object.assign(existing, record);
      if (degradedCltv !== undefined && record.holdInvoice) {
        existing.holdInvoice = {
          ...record.holdInvoice,
          cltvExpiryBlocks: Math.min(degradedCltv, record.holdInvoice.cltvExpiryBlocks),
        };
      }
      return existing;
    } else {
      this.records.set(record.id, record);
      this.idempotencyIndex.set(record.idempotencyKey, record.id);
      return record;
    }
  }

  private markRecoveryRequired(
    executionId: string,
    failureReason: string,
    transitionReason: string
  ): SovereignExecutionRecord {
    return this.syncCache(
      this.persistence.markSovereignRecoveryRequired(
        executionId,
        failureReason,
        transitionReason
      )
    );
  }

  private async observeLightningForRecovery(
    record: SovereignExecutionRecord
  ): Promise<LightningRecoveryObservation> {
    const paymentHash = (record.holdInvoice?.paymentHash ?? record.hashLock.replace(/^0x/, '')).toLowerCase();
    try {
      return {
        kind: 'FOUND',
        invoice: await this.lightning.observeHoldInvoice(paymentHash),
      };
    } catch (err: unknown) {
      if (err instanceof LightningInvoiceNotFoundError) return { kind: 'NOT_FOUND' };
      return {
        kind: 'UNKNOWN',
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async observeEvmForRecovery(
    record: SovereignExecutionRecord
  ): Promise<EvmRecoveryObservation> {
    const swapKey = record.evmSwapKey ?? `swap_${record.id}`;
    try {
      const state = await this.evm.observeHtlc(swapKey);
      if (!state || typeof state.funded !== 'boolean') {
        return { kind: 'UNKNOWN', reason: 'Malformed EVM HTLC observation' };
      }
      if (state.refunded === true) return { kind: 'REFUNDED', state };
      if (state.completed === true) return { kind: 'CLAIMED', state };
      if (state.funded === true) return { kind: 'FUNDED', state };
      if (state.funded === false && state.completed === false && state.refunded === false) {
        return { kind: 'NOT_FUNDED_PROVEN', state };
      }
      return { kind: 'PENDING', state };
    } catch (err: unknown) {
      return {
        kind: 'UNKNOWN',
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private updateRecord(
    executionId: string,
    updates: Partial<SovereignExecutionRecord>,
    transition?: { reason: string; evidenceId?: string; metadataJson?: string }
  ): SovereignExecutionRecord {
    // Stale-worker split-brain guard: check authoritative SQLite state before applying non-terminal update
    const current = this.persistence.getSovereignSwap(executionId);
    if (current) {
      const isTerminal =
        current.state === SovereignAtomicState.COMPLETED ||
        current.state === SovereignAtomicState.REFUNDED ||
        current.state === SovereignAtomicState.INVOICE_CANCELED;

      if (isTerminal && updates.state && updates.state !== current.state) {
        // Authoritative state is already terminal; stale worker must converge and not revert
        return this.syncCache(current);
      }
    }

    const updated = this.persistence.updateSovereignSwap(executionId, updates, transition);
    return this.syncCache(updated);
  }

  private async assertLightningCltvSafety(
    record: SovereignExecutionRecord,
    stage: 'FUND' | 'SETTLE'
  ): Promise<void> {
    const config = this.timeSafetyConfig;

    // 1. Determine remaining Base timelock in seconds
    let remainingBaseSeconds: number;
    if (record.refundLocktime) {
      const currentEvmTs = await this.evm.getBlockTimestamp();
      remainingBaseSeconds = Math.max(0, record.refundLocktime - currentEvmTs);
    } else {
      remainingBaseSeconds = record.timelockSeconds ?? 43200;
    }

    // 2. Compute total Base resolution budget in seconds:
    //    remainingBaseTimelock + dispatch/replacement budget + finality budget + LND resolution budget + conservative margin
    const totalBaseResolutionSeconds =
      remainingBaseSeconds +
      config.baseDispatchBudgetSeconds +
      config.baseFinalityBudgetSeconds +
      config.lndResolutionBudgetSeconds +
      config.safetyMarginSeconds;

    // 3. Compute required Lightning blocks under verified Poisson fast-block planning bound (P(N >= K | mu) < tailRiskTarget)
    const requiredBlocks = computeRequiredBtcBlocksForBudget(
      totalBaseResolutionSeconds,
      config.tailRiskTarget ?? CROSS_RAIL_FAST_BLOCK_TAIL_TARGET
    );

    // 4. Authoritative query of current Bitcoin block height (fail-closed if unavailable or malformed)
    if (typeof this.lightning.getBlockHeight !== 'function') {
      throw new Error(
        `AUTHORITATIVE_BLOCK_HEIGHT_UNAVAILABLE: Lightning backend does not provide authoritative getBlockHeight(); cannot verify cross-rail CLTV safety window before ${stage}. Refusing to proceed fail-closed.`
      );
    }

    let currentBtcHeight: number;
    try {
      currentBtcHeight = await this.lightning.getBlockHeight();
    } catch (err: any) {
      throw new Error(
        `AUTHORITATIVE_BLOCK_HEIGHT_UNAVAILABLE: Failed to query authoritative Bitcoin block height (${err?.message}); cannot verify cross-rail CLTV safety window before ${stage}. Refusing to proceed fail-closed.`
      );
    }

    if (
      typeof currentBtcHeight !== 'number' ||
      !Number.isFinite(currentBtcHeight) ||
      currentBtcHeight <= 0
    ) {
      throw new Error(
        `AUTHORITATIVE_BLOCK_HEIGHT_UNAVAILABLE: Authoritative Bitcoin block height is invalid or non-positive (${currentBtcHeight}); refusing to proceed fail-closed.`
      );
    }

    // 5. Determine accepted HTLC expiry height from authoritative inputs
    // If multiple accepted HTLCs exist, use the earliest/minimum accepted HTLC expiry
    let expiryHeight = record.holdInvoice?.expiryHeight;
    const htlcs = (record.holdInvoice as any)?.htlcs;
    if (Array.isArray(htlcs) && htlcs.length > 0) {
      const validExpiries = htlcs
        .map((h: any) => h?.expiry_height ?? h?.expiryHeight)
        .filter((h: any) => typeof h === 'number' && h > 0);
      if (validExpiries.length > 0) {
        const minExpiry = Math.min(...validExpiries);
        expiryHeight = expiryHeight !== undefined ? Math.min(expiryHeight, minExpiry) : minExpiry;
      }
    }

    if (expiryHeight === undefined || expiryHeight === null || typeof expiryHeight !== 'number' || expiryHeight <= 0) {
      throw new Error(
        `AUTHORITATIVE_EXPIRY_HEIGHT_UNAVAILABLE: Accepted Lightning HTLC expiry height is missing or invalid (${expiryHeight}); cannot calculate remaining blocks from authoritative source before ${stage}. Refusing to proceed fail-closed.`
      );
    }

    // Strictly derived: accepted HTLC expiry height - freshly queried authoritative current Bitcoin block height
    // ABSOLUTELY NO FALLBACK TO INVOICE CLTV DELTA OR INITIAL BLOCKS!
    const heightRemaining = Math.max(0, expiryHeight - currentBtcHeight);
    const remainingBlocks =
      record.holdInvoice?.cltvExpiryBlocks !== undefined
        ? Math.min(heightRemaining, record.holdInvoice.cltvExpiryBlocks)
        : heightRemaining;

    // 6. Invariant check: Remaining Lightning window MUST strictly meet the verified Poisson fast-block threshold
    if (remainingBlocks < requiredBlocks) {
      throw new Error(
        `CLTV_SAFETY_MARGIN_VIOLATION: Remaining Lightning HTLC window (${remainingBlocks} blocks) ` +
        `is below safety buffer (18 blocks) / required Base resolution budget (${totalBaseResolutionSeconds}s / required ${requiredBlocks} blocks under conservative Poisson fast-block planning bound P(N>=K | mu=${totalBaseResolutionSeconds / NOMINAL_BITCOIN_BLOCK_TIME_SECONDS}) < ${config.tailRiskTarget ?? CROSS_RAIL_FAST_BLOCK_TAIL_TARGET}) ` +
        `before ${stage}. Refusing to proceed fail-closed.`
      );
    }
  }
}
