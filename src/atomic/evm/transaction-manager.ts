/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Phase 5A: Base Transaction Reliability Engine
 *
 * Implements crash-resilient, concurrency-safe, and deterministic EVM transaction execution:
 * - Pre-broadcast durability: Nonce reservation and signed attempt persisted to SQLite BEFORE broadcast.
 * - Monotonic EIP-1559 fee replacement: >=10% bump, identical nonce, identical calldata fingerprint.
 * - Strict financial safety: Hard caps on maxFeePerGas, maxPriorityFeePerGas, gasLimit, and worst-case spend.
 * - Non-custodial operator boundary: Router holds ZERO client private keys.
 * - Authoritative reconciliation: Multi-attempt tracking, winning attempt confirmation, superseded cleanup.
 */

import {
  type PublicClient,
  type Hex,
  type Account,
  type TransactionReceipt,
  keccak256,
} from 'viem';
import { SqlitePersistence } from '../../persistence/sqlite.ts';
import {
  EvmLogicalIntentState,
  EvmPhysicalAttemptStatus,
  type BaseTransactionPolicy,
  DEFAULT_BASE_TRANSACTION_POLICY,
  type EvmLogicalIntent,
  type EvmPhysicalAttempt,
  type CreateIntentParams,
  type ReconciliationOutcome,
} from './transaction-types.ts';

export function isExecutionRevertError(err: any): boolean {
  if (!err) return false;
  const msg = (err.message || '').toLowerCase();
  const shortMsg = (err.shortMessage || '').toLowerCase();
  const details = (err.details || '').toLowerCase();
  const name = (err.name || '').toLowerCase();
  const causeName = (err.cause?.name || '').toLowerCase();
  const causeMsg = (err.cause?.message || '').toLowerCase();

  if (
    name === 'estimategasexecutionerror' ||
    name === 'contractfunctionexecutionerror' ||
    causeName === 'callexecutionerror' ||
    causeName === 'contractfunctionrevertederror'
  ) {
    return true;
  }

  const combined = `${msg} ${shortMsg} ${details} ${causeMsg}`;
  return (
    combined.includes('execution reverted') ||
    combined.includes('transaction reverted') ||
    combined.includes('contract call: revert') ||
    combined.includes('call reverted') ||
    combined.includes('reverted with reason') ||
    combined.includes('reverted with custom error') ||
    combined.includes('always failing transaction') ||
    combined.includes('gas required exceeds allowance')
  );
}

export function isTransportFailure(err: any): boolean {
  if (!err) return false;
  const msg = (err.message || '').toLowerCase();
  const shortMsg = (err.shortMessage || '').toLowerCase();
  const details = (err.details || '').toLowerCase();
  const name = (err.name || '').toLowerCase();

  if (
    name === 'timeouterror' ||
    name === 'httprequesterror' ||
    name === 'rpcrequesterror' ||
    name === 'socketclosederror'
  ) {
    return true;
  }

  const combined = `${msg} ${shortMsg} ${details}`;
  return (
    combined.includes('timeout') ||
    combined.includes('econnrefused') ||
    combined.includes('econnreset') ||
    combined.includes('etimedout') ||
    combined.includes('network error') ||
    combined.includes('fetch failed') ||
    combined.includes('502') ||
    combined.includes('503') ||
    combined.includes('504') ||
    combined.includes('temporarily unavailable')
  );
}

export interface BaseTransactionManagerConfig {
  persistence: SqlitePersistence;
  publicClient: PublicClient;
  account: Account;
  chainId: number;
  policy?: Partial<BaseTransactionPolicy> | undefined;
}

export class BaseTransactionManager {
  readonly persistence: SqlitePersistence;
  readonly publicClient: PublicClient;
  readonly account: Account;
  readonly chainId: number;
  readonly policy: BaseTransactionPolicy;
  private activeReplacementLocks = new Map<string, Promise<{ attempt: EvmPhysicalAttempt; rawSignedTx: Hex }>>();

  constructor(config: BaseTransactionManagerConfig) {
    this.persistence = config.persistence;
    this.publicClient = config.publicClient;
    this.account = config.account;
    this.chainId = config.chainId;
    this.policy = {
      ...DEFAULT_BASE_TRANSACTION_POLICY,
      ...(config.policy ?? {}),
    };
  }

  /**
   * Execute an EVM logical intent end-to-end with crash-resilience and idempotency.
   */
  public async executeIntent(
    params: CreateIntentParams,
    options?: {
      timeoutMs?: number | undefined;
      pollIntervalMs?: number | undefined;
    } | undefined
  ): Promise<{
    intent: EvmLogicalIntent;
    winningAttempt: EvmPhysicalAttempt;
    receipt: TransactionReceipt;
  }> {
    // 1. Get or create logical intent (idempotent on swapKey + actionType)
    let intent = this.persistence.getOrCreateEvmIntent(params);

    // If intent has already reached terminal status, handle deterministically
    if (intent.status === EvmLogicalIntentState.CONFIRMED) {
      const attempts = this.persistence.getEvmAttemptsForIntent(intent.id);
      const winningAttempt = attempts.find(
        (a) => a.txHash.toLowerCase() === intent.canonicalTxHash?.toLowerCase()
      ) ?? attempts[0];
      const receipt = await this.publicClient.getTransactionReceipt({ hash: winningAttempt.txHash });
      return { intent, winningAttempt, receipt };
    }

    if (
      intent.status === EvmLogicalIntentState.REVERTED ||
      intent.status === EvmLogicalIntentState.FEE_CAP_BLOCKED ||
      intent.status === EvmLogicalIntentState.NONCE_CONFLICT ||
      intent.status === EvmLogicalIntentState.FAILED
    ) {
      throw new Error(`EVM intent ${intent.id} terminated with status: ${intent.status} (${intent.failureReason})`);
    }

    // 2. Check existing attempts for this intent
    let attempts = this.persistence.getEvmAttemptsForIntent(intent.id);

    // If attempts already exist, attempt to reconcile before creating new attempts
    if (attempts.length > 0) {
      const outcome = await this.reconcileIntent(intent.id);
      if (outcome.status === EvmLogicalIntentState.CONFIRMED && outcome.minedTxHash) {
        const winningAttempt = attempts.find(
          (a) => a.txHash.toLowerCase() === outcome.minedTxHash?.toLowerCase()
        ) ?? attempts[0];
        const receipt = await this.publicClient.getTransactionReceipt({ hash: outcome.minedTxHash });
        intent = this.persistence.getEvmIntentById(intent.id)!;
        return { intent, winningAttempt, receipt };
      }
    }

    // 4. If no attempts exist, prepare and broadcast attempt #1
    if (attempts.length === 0) {
      const { attempt, rawSignedTx } = await this.prepareAttempt(intent, params.calldata);
      await this.broadcastAttempt(attempt, rawSignedTx);
      attempts = [attempt];
    } else {
      // Check if the latest attempt was prepared but never broadcast
      const latest = attempts[attempts.length - 1];
      if (latest.status === EvmPhysicalAttemptStatus.PREPARED) {
        // Re-sign deterministically using operator account
        const { rawSignedTx } = await this.signAttemptTransaction(intent, latest, params.calldata);
        const computedHash = keccak256(rawSignedTx);
        if (computedHash.toLowerCase() !== latest.txHash.toLowerCase()) {
          throw new Error(
            `DETERMINISTIC_SIGNATURE_MISMATCH: Reconstructed transaction hash ${computedHash} does not match persisted hash ${latest.txHash}`
          );
        }
        await this.broadcastAttempt(latest, rawSignedTx);
      }
    }

    // 5. Wait for confirmation and handle replacements if stalled
    return await this.waitForConfirmation(
      intent.id,
      params.calldata,
      options?.timeoutMs,
      options?.pollIntervalMs
    );
  }

  /**
   * Prepares and records a new physical transaction attempt in SQLite before broadcast.
   */
  public async prepareAttempt(
    intentParam: EvmLogicalIntent,
    calldata: Hex,
    options?: {
      isReplacement?: boolean;
      previousAttempt?: EvmPhysicalAttempt;
      customFeeBumpPercent?: number | undefined;
      customGasLimit?: bigint | undefined;
    }
  ): Promise<{ attempt: EvmPhysicalAttempt; rawSignedTx: Hex }> {
    let intent = this.persistence.getEvmIntentById(intentParam.id) ?? intentParam;

    // Verify calldata fingerprint match
    const calldataFingerprint = keccak256(calldata);
    if (calldataFingerprint.toLowerCase() !== intent.calldataFingerprint.toLowerCase()) {
      throw new Error(`Calldata fingerprint mismatch for intent ${intent.id}`);
    }

    const existingAttempts = this.persistence.getEvmAttemptsForIntent(intent.id);
    const attemptNumber = existingAttempts.length + 1;

    if (attemptNumber > this.policy.maxReplacements + 1) {
      const reason = `Maximum replacement count (${this.policy.maxReplacements}) exceeded for intent ${intent.id}`;
      this.persistence.markEvmFeeCapBlocked(intent.id, reason);
      throw new Error(`MAX_REPLACEMENTS_EXCEEDED: ${reason}`);
    }

    // Estimate gas limit
    let gasLimit = options?.customGasLimit;
    if (!gasLimit) {
      try {
        const est = await this.publicClient.estimateGas({
          account: this.account,
          to: intent.targetAddress,
          data: calldata,
          value: intent.valueWei,
        });
        // 20% safety margin for gas limit
        gasLimit = (est * 120n) / 100n;
      } catch (err: any) {
        if (isExecutionRevertError(err)) {
          const reason = `SIMULATION_REVERTED: Contract simulation failed: ${err.shortMessage || err.message}`;
          this.persistence.markEvmSimulationReverted(intent.id, reason);
          throw new Error(reason);
        }
        // Transport/availability failure: Fallback gas limit for standard ERC-20 / HTLC if policy considers safe
        gasLimit = 350_000n;
      }
    }

    if (gasLimit > this.policy.maxGasLimitCap) {
      const reason = `Gas limit ${gasLimit} exceeds policy cap ${this.policy.maxGasLimitCap}`;
      this.persistence.markEvmFeeCapBlocked(intent.id, reason);
      throw new Error(`GAS_LIMIT_CAP_EXCEEDED: ${reason}`);
    }

    // Compute EIP-1559 fees
    let maxPriorityFeePerGas: bigint;
    let maxFeePerGas: bigint;

    const rpcFees = await this.getRpcFeeEstimates();

    if (options?.isReplacement && options.previousAttempt) {
      const prev = options.previousAttempt;
      const bumpPct = BigInt(
        Math.max(this.policy.minPriorityFeeBumpPercent, options.customFeeBumpPercent ?? 0)
      );

      // Monotonic >= 10% bump for priority fee and max fee
      const bumpedPriority = (prev.maxPriorityFeePerGas * (100n + bumpPct)) / 100n + 1n;
      const bumpedMaxFee = (prev.maxFeePerGas * (100n + bumpPct)) / 100n + 1n;

      maxPriorityFeePerGas = bumpedPriority > rpcFees.maxPriorityFeePerGas ? bumpedPriority : rpcFees.maxPriorityFeePerGas;
      maxFeePerGas = bumpedMaxFee > rpcFees.maxFeePerGas ? bumpedMaxFee : rpcFees.maxFeePerGas;
    } else {
      maxPriorityFeePerGas = rpcFees.maxPriorityFeePerGas;
      maxFeePerGas = rpcFees.maxFeePerGas;
    }

    // Verify fee caps
    if (maxPriorityFeePerGas > this.policy.maxPriorityFeePerGasCapWei) {
      const reason = `Priority fee ${maxPriorityFeePerGas} exceeds cap ${this.policy.maxPriorityFeePerGasCapWei}`;
      this.persistence.markEvmFeeCapBlocked(intent.id, reason);
      throw new Error(`PRIORITY_FEE_CAP_EXCEEDED: ${reason}`);
    }

    if (maxFeePerGas > this.policy.maxFeePerGasCapWei) {
      const reason = `Max fee ${maxFeePerGas} exceeds cap ${this.policy.maxFeePerGasCapWei}`;
      this.persistence.markEvmFeeCapBlocked(intent.id, reason);
      throw new Error(`MAX_FEE_CAP_EXCEEDED: ${reason}`);
    }

    // Verify worst-case cost cap: gasLimit * maxFeePerGas + value
    const worstCaseCost = gasLimit * maxFeePerGas + intent.valueWei;
    if (worstCaseCost > this.policy.maxWorstCaseCostWeiCap) {
      const reason = `Worst-case cost ${worstCaseCost} exceeds cap ${this.policy.maxWorstCaseCostWeiCap}`;
      this.persistence.markEvmFeeCapBlocked(intent.id, reason);
      throw new Error(`WORST_CASE_COST_CAP_EXCEEDED: ${reason}`);
    }

    // Durable nonce reservation occurs ONLY AFTER preflight, simulation, and all fee/gas caps pass
    let assignedNonce = intent.nonce;
    if (assignedNonce === null || assignedNonce === undefined) {
      // Enforce: no unresolved nonce reservations exist for this signer before allocating higher nonces
      const unresolved = this.persistence.getUnresolvedNonceReservation(
        this.chainId,
        intent.signerAddress,
        intent.id
      );
      if (unresolved) {
        throw new Error(
          `UNRESOLVED_NONCE_RESERVATION: Intent ${unresolved.id} holds reserved nonce ${unresolved.nonce} with zero physical attempts. Recovery is required before allocating higher nonces.`
        );
      }

      const rpcPendingNonce = await this.publicClient.getTransactionCount({
        address: intent.signerAddress,
        blockTag: 'pending',
      });
      const reservation = this.persistence.reserveEvmNonce(intent.id, rpcPendingNonce, {
        enforceNoUnresolvedReservations: true,
      });
      intent = reservation.intent;
      assignedNonce = reservation.nonce;
    }

    // Sign transaction locally using operator account (Router holds ZERO client keys)
    if (!this.account.signTransaction) {
      throw new Error('Operator account does not support signTransaction');
    }

    const rawSignedTx = await this.account.signTransaction({
      chainId: this.chainId,
      to: intent.targetAddress,
      data: calldata,
      value: intent.valueWei,
      nonce: assignedNonce,
      gas: gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });

    const txHash = keccak256(rawSignedTx);

    // Persist attempt to SQLite BEFORE broadcasting (PRE-BROADCAST DURABILITY)
    const attempt = this.persistence.recordEvmAttempt({
      intentId: intent.id,
      attemptNumber,
      chainId: this.chainId,
      signerAddress: intent.signerAddress,
      nonce: assignedNonce,
      txHash,
      toAddress: intent.targetAddress,
      valueWei: intent.valueWei,
      data: calldata,
      gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });

    // Check if another concurrent process/manager won the race and created this attempt generation
    if (attempt.txHash.toLowerCase() !== txHash.toLowerCase()) {
      // Reconstruct and re-sign using the winning attempt parameters so the returned rawSignedTx matches attempt.txHash
      const reconstructedSignedTx = await this.account.signTransaction({
        chainId: attempt.chainId,
        to: attempt.toAddress,
        data: attempt.data,
        value: attempt.valueWei,
        nonce: attempt.nonce,
        gas: attempt.gasLimit,
        maxFeePerGas: attempt.maxFeePerGas,
        maxPriorityFeePerGas: attempt.maxPriorityFeePerGas,
      });
      return { attempt, rawSignedTx: reconstructedSignedTx };
    }

    return { attempt, rawSignedTx };
  }

  /**
   * Broadcasts a prepared physical attempt to the network and marks it BROADCAST.
   * Strictly separates 'already known' (idempotent rebroadcast) from 'nonce too low'.
   */
  public async broadcastAttempt(attempt: EvmPhysicalAttempt, rawSignedTx: Hex): Promise<void> {
    try {
      await this.publicClient.sendRawTransaction({ serializedTransaction: rawSignedTx });
      this.persistence.markEvmAttemptBroadcast(attempt.id);
    } catch (err: any) {
      const msg = (err?.message || '').toLowerCase();

      // Case A: Exact transaction already received / in mempool -> Idempotent rebroadcast
      if (
        msg.includes('already known') ||
        msg.includes('alreadyknown') ||
        msg.includes('known transaction')
      ) {
        this.persistence.markEvmAttemptBroadcast(attempt.id);
        return;
      }

      // Case B: Nonce too low -> MUST NOT be treated as already known!
      // Must perform strict authoritative audit of nonce and known attempts.
      if (msg.includes('nonce too low') || msg.includes('noncetoolow')) {
        // 1. Reconcile all known attempts for this intent
        const outcome = await this.reconcileIntent(attempt.intentId);
        if (
          outcome.status === EvmLogicalIntentState.CONFIRMED ||
          outcome.status === EvmLogicalIntentState.REVERTED
        ) {
          // A known attempt for this intent mined on-chain! Converge to that known result.
          return;
        }

        // 2. Query authoritative on-chain mined nonce
        let onChainMinedNonce: number;
        try {
          onChainMinedNonce = await this.publicClient.getTransactionCount({
            address: attempt.signerAddress,
            blockTag: 'latest',
          });
        } catch (rpcErr: any) {
          throw new Error(
            `NONCE_TOO_LOW_RECONCILIATION_FAILED: Failed to fetch on-chain nonce: ${rpcErr.message}`
          );
        }

        // 3. Inspect if on-chain mined nonce has advanced past this intent's nonce
        if (onChainMinedNonce > attempt.nonce) {
          const reason = `NONCE_TOO_LOW: On-chain nonce (${onChainMinedNonce}) advanced past attempt nonce (${attempt.nonce}). Zero router attempts mined. External transaction consumed nonce.`;
          this.persistence.markEvmNonceConflict(attempt.intentId, reason);
          throw new Error(`NONCE_CONFLICT: ${reason}`);
        }

        // 4. If neither known attempt mined nor on-chain nonce advanced, unknown consumption -> fail closed
        const reason = `UNKNOWN_NONCE_CONSUMPTION: RPC rejected broadcast with nonce too low, but no router attempt mined and latest on-chain nonce is ${onChainMinedNonce}`;
        this.persistence.markEvmNonceConflict(attempt.intentId, reason);
        throw new Error(`UNKNOWN_NONCE_CONSUMPTION: ${reason}`);
      }

      throw err;
    }
  }

  /**
   * Performs an EIP-1559 fee replacement for a pending intent.
   * Concurrency-safe: coalesces concurrent replacement requests to produce exactly one next generation.
   */
  public async replacePendingTransaction(
    intentId: string,
    calldata: Hex,
    customFeeBumpPercent?: number
  ): Promise<{ attempt: EvmPhysicalAttempt; rawSignedTx: Hex }> {
    const existingLock = this.activeReplacementLocks.get(intentId);
    if (existingLock) {
      return await existingLock;
    }

    const replacementPromise = (async () => {
      try {
        const intent = this.persistence.getEvmIntentById(intentId);
        if (!intent) {
          throw new Error(`Intent ${intentId} not found`);
        }

        if (
          intent.status !== EvmLogicalIntentState.PENDING &&
          intent.status !== EvmLogicalIntentState.DISPATCHING
        ) {
          throw new Error(`Cannot replace transaction for intent in status: ${intent.status}`);
        }

        const attempts = this.persistence.getEvmAttemptsForIntent(intentId);
        if (attempts.length === 0) {
          throw new Error(`No previous attempts found for intent ${intentId}`);
        }

        const latest = attempts[attempts.length - 1];

        const { attempt, rawSignedTx } = await this.prepareAttempt(intent, calldata, {
          isReplacement: true,
          previousAttempt: latest,
          customFeeBumpPercent,
        });

        await this.broadcastAttempt(attempt, rawSignedTx);
        return { attempt, rawSignedTx };
      } finally {
        this.activeReplacementLocks.delete(intentId);
      }
    })();

    this.activeReplacementLocks.set(intentId, replacementPromise);
    return await replacementPromise;
  }

  /**
   * Reconciles on-chain status for an intent across all its physical attempts.
   */
  public async reconcileIntent(intentId: string): Promise<ReconciliationOutcome> {
    const intent = this.persistence.getEvmIntentById(intentId);
    if (!intent) {
      throw new Error(`Intent ${intentId} not found`);
    }

    if (intent.status === EvmLogicalIntentState.CONFIRMED) {
      return {
        intentId,
        status: EvmLogicalIntentState.CONFIRMED,
        minedTxHash: intent.canonicalTxHash ?? undefined,
      };
    }

    if (
      intent.status === EvmLogicalIntentState.REVERTED ||
      intent.status === EvmLogicalIntentState.FEE_CAP_BLOCKED ||
      intent.status === EvmLogicalIntentState.NONCE_CONFLICT ||
      intent.status === EvmLogicalIntentState.FAILED
    ) {
      return {
        intentId,
        status: intent.status,
        reason: intent.failureReason ?? undefined,
      };
    }

    const attempts = this.persistence.getEvmAttemptsForIntent(intentId);
    if (attempts.length === 0) {
      return { intentId, status: intent.status };
    }

    // Check receipts for each attempt
    for (const attempt of attempts) {
      try {
        const receipt = await this.publicClient.getTransactionReceipt({ hash: attempt.txHash });
        if (receipt) {
          const blockNumber = Number(receipt.blockNumber);
          const isSuccess = receipt.status === 'success' || Number(receipt.status) === 1;

          if (isSuccess) {
            this.persistence.markEvmMinedSuccess(intentId, attempt.id, attempt.txHash, blockNumber);
            return {
              intentId,
              status: EvmLogicalIntentState.CONFIRMED,
              minedTxHash: attempt.txHash,
              minedBlockNumber: blockNumber,
            };
          } else {
            this.persistence.markEvmMinedRevert(
              intentId,
              attempt.id,
              blockNumber,
              'Transaction reverted on-chain'
            );
            return {
              intentId,
              status: EvmLogicalIntentState.REVERTED,
              minedTxHash: attempt.txHash,
              minedBlockNumber: blockNumber,
              reason: 'Transaction reverted on-chain',
            };
          }
        }
      } catch (err: any) {
        // Receipt not found (still pending) is expected
      }
    }

    // No receipt found yet. Check if nonce was consumed by an external transaction!
    if (intent.nonce !== null && intent.nonce !== undefined) {
      try {
        const onChainMinedNonce = await this.publicClient.getTransactionCount({
          address: intent.signerAddress,
          blockTag: 'latest',
        });

        if (onChainMinedNonce > intent.nonce) {
          // On-chain nonce has advanced past this intent's nonce, but none of our attempts mined!
          const reason = `On-chain nonce (${onChainMinedNonce}) advanced past reserved nonce (${intent.nonce}) without our transaction mining`;
          this.persistence.markEvmNonceConflict(intentId, reason);
          return {
            intentId,
            status: EvmLogicalIntentState.NONCE_CONFLICT,
            reason,
          };
        }
      } catch {
        // Ignore RPC read error during reconciliation
      }
    }

    return {
      intentId,
      status: EvmLogicalIntentState.PENDING,
    };
  }

  /**
   * Reconciles all active intents.
   */
  public async reconcileAll(): Promise<ReconciliationOutcome[]> {
    const activeIntents = this.persistence.getActiveEvmIntents(this.chainId);
    const outcomes: ReconciliationOutcome[] = [];
    for (const intent of activeIntents) {
      try {
        const outcome = await this.reconcileIntent(intent.id);
        outcomes.push(outcome);
      } catch (err: any) {
        outcomes.push({
          intentId: intent.id,
          status: intent.status,
          reason: err.message,
        });
      }
    }
    return outcomes;
  }

  /**
   * Crash recovery on startup: reconciles active intents and re-broadcasts any prepared but unbroadcast attempts.
   */
  public async recoverOnStartup(): Promise<ReconciliationOutcome[]> {
    const activeIntents = this.persistence.getActiveEvmIntents(this.chainId);
    const outcomes: ReconciliationOutcome[] = [];

    for (const intent of activeIntents) {
      const attempts = this.persistence.getEvmAttemptsForIntent(intent.id);
      // Check for unbroadcast prepared attempt (Crash Point 4)
      const unbroadcast = attempts.find((a) => a.status === EvmPhysicalAttemptStatus.PREPARED);
      if (unbroadcast) {
        try {
          const { rawSignedTx } = await this.signAttemptTransaction(intent, unbroadcast, unbroadcast.data);
          const computedHash = keccak256(rawSignedTx);
          if (computedHash.toLowerCase() !== unbroadcast.txHash.toLowerCase()) {
            throw new Error(
              `DETERMINISTIC_SIGNATURE_MISMATCH: Reconstructed transaction hash ${computedHash} does not match persisted hash ${unbroadcast.txHash}`
            );
          }
          await this.broadcastAttempt(unbroadcast, rawSignedTx);
        } catch {
          // Reconciler will handle if already in mempool
        }
      }

      const outcome = await this.reconcileIntent(intent.id);
      outcomes.push(outcome);
    }

    return outcomes;
  }

  /**
   * Recovers an unresolved nonce reservation by constructing and broadcasting attempt #1.
   */
  public async recoverUnresolvedIntent(
    intentId: string,
    calldata?: Hex
  ): Promise<{ attempt: EvmPhysicalAttempt; rawSignedTx: Hex }> {
    const intent = this.persistence.getEvmIntentById(intentId);
    if (!intent) {
      throw new Error(`Intent ${intentId} not found for recovery`);
    }
    const data = calldata ?? intent.calldata ?? '0x';
    const { attempt, rawSignedTx } = await this.prepareAttempt(intent, data);
    await this.broadcastAttempt(attempt, rawSignedTx);
    return { attempt, rawSignedTx };
  }

  /**
   * Waits for transaction confirmation with optional fee replacement for stalled transactions.
   */
  public async waitForConfirmation(
    intentId: string,
    calldata: Hex,
    timeoutMs: number = 60_000,
    pollIntervalMs: number = 500
  ): Promise<{
    intent: EvmLogicalIntent;
    winningAttempt: EvmPhysicalAttempt;
    receipt: TransactionReceipt;
  }> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const outcome = await this.reconcileIntent(intentId);

      if (outcome.status === EvmLogicalIntentState.CONFIRMED && outcome.minedTxHash) {
        const receipt = await this.publicClient.getTransactionReceipt({ hash: outcome.minedTxHash });
        const currentBlock = await this.publicClient.getBlockNumber();
        const confirmations = Number(currentBlock - receipt.blockNumber + 1n);

        if (confirmations >= this.policy.requiredConfirmations) {
          const intent = this.persistence.getEvmIntentById(intentId)!;
          const attempts = this.persistence.getEvmAttemptsForIntent(intentId);
          const winningAttempt = attempts.find(
            (a) => a.txHash.toLowerCase() === outcome.minedTxHash?.toLowerCase()
          ) ?? attempts[attempts.length - 1];

          return { intent, winningAttempt, receipt };
        }
      }

      if (
        outcome.status === EvmLogicalIntentState.REVERTED ||
        outcome.status === EvmLogicalIntentState.FEE_CAP_BLOCKED ||
        outcome.status === EvmLogicalIntentState.NONCE_CONFLICT ||
        outcome.status === EvmLogicalIntentState.FAILED
      ) {
        throw new Error(`EVM intent ${intentId} terminated with status: ${outcome.status} (${outcome.reason})`);
      }

      // Check if transaction has stalled and can be replaced
      const attempts = this.persistence.getEvmAttemptsForIntent(intentId);
      if (attempts.length > 0 && attempts.length <= this.policy.maxReplacements) {
        const latest = attempts[attempts.length - 1];
        const ageMs = Date.now() - new Date(latest.createdAt).getTime();
        if (ageMs > this.policy.stalledAgeMs) {
          try {
            await this.replacePendingTransaction(intentId, calldata);
          } catch {
            // If replacement fails (e.g. fee cap or mined during replacement), continue polling
          }
        }
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    throw new Error(`Timeout waiting for EVM intent ${intentId} confirmation after ${timeoutMs}ms`);
  }

  /**
   * Helper to sign an existing attempt's transaction.
   */
  public async signAttemptTransaction(
    intent: EvmLogicalIntent,
    attempt: EvmPhysicalAttempt,
    calldata: Hex
  ): Promise<{ rawSignedTx: Hex }> {
    if (!this.account.signTransaction) {
      throw new Error('Operator account does not support signTransaction');
    }

    const rawSignedTx = await this.account.signTransaction({
      chainId: this.chainId,
      to: intent.targetAddress,
      data: calldata,
      value: intent.valueWei,
      nonce: attempt.nonce,
      gas: attempt.gasLimit,
      maxFeePerGas: attempt.maxFeePerGas,
      maxPriorityFeePerGas: attempt.maxPriorityFeePerGas,
    });

    return { rawSignedTx };
  }

  /**
   * Fetches current network fee estimates from RPC.
   */
  public async getRpcFeeEstimates(): Promise<{
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
  }> {
    try {
      const fees = await this.publicClient.estimateFeesPerGas();
      let priority = fees?.maxPriorityFeePerGas;
      let maxFee = fees?.maxFeePerGas;

      if (typeof priority !== 'bigint' || priority <= 0n) {
        priority = 1_000_000_000n;
      }
      if (typeof maxFee !== 'bigint' || maxFee <= 0n) {
        maxFee = priority + 1_000_000_000n;
      }

      return {
        maxPriorityFeePerGas: priority,
        maxFeePerGas: maxFee,
      };
    } catch {
      // Fallback fees if RPC estimation fails (e.g. 2 gwei max, 1 gwei tip)
      return {
        maxPriorityFeePerGas: 1_000_000_000n,
        maxFeePerGas: 2_000_000_000n,
      };
    }
  }
}
