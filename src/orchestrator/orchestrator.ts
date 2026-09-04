import { randomUUID } from 'node:crypto';
import {
  type ExecutionRecord,
  ExecutionState,
  type NormalizedIntent,
  type NormalizedQuote,
  type IExecutionProvider,
  type IExecutionEdge,
  ProviderNormalizedStatus,
  AMBIGUOUS_STATES,
  type SourceSettlementEvidence,
  type DestinationSettlementEvidence,
  ExecutionClass,
  EdgeClass,
  type ExecutionPlan,
  createAssetNode,
  areIntentsSemanticallyEqual,
  RouterError,
  DomainErrorCode,
} from '../domain/types.ts';
import { SqlitePersistence } from '../persistence/sqlite.ts';
import { ExecutionStateMachine } from '../state-machine/engine.ts';
import { type IChainVerifier, MockChainVerifier } from '../verification/verifier.ts';
import { RoutePlanner } from '../routing/planner.ts';

export interface OrchestratorOptions {
  persistence: SqlitePersistence;
  providers: Map<string, IExecutionProvider>;
  routePlanner?: RoutePlanner | undefined;
  chainVerifier?: IChainVerifier | undefined;
  maxRecoveryAttempts?: number | undefined;
  nowFn?: (() => number) | undefined;
}

export class ExecutionOrchestrator {
  private persistence: SqlitePersistence;
  private providers: Map<string, IExecutionProvider>;
  private routePlanner?: RoutePlanner | undefined;
  private chainVerifier: IChainVerifier;
  private maxRecoveryAttempts: number;
  private nowFn: () => number;
  private inFlightExecutions: Map<string, Promise<ExecutionRecord>> = new Map();

  constructor(options: OrchestratorOptions) {
    this.persistence = options.persistence;
    this.providers = options.providers;
    this.routePlanner = options.routePlanner;
    this.chainVerifier = options.chainVerifier ?? new MockChainVerifier();
    this.maxRecoveryAttempts = options.maxRecoveryAttempts ?? 5;
    this.nowFn = options.nowFn ?? (() => Date.now());
  }

  public now(): number {
    return this.nowFn();
  }

  public getPlanner(): RoutePlanner | undefined {
    return this.routePlanner;
  }

  public async getQuote(
    intent: NormalizedIntent,
    preferredProviderId?: string
  ): Promise<NormalizedQuote> {
    const providerId = preferredProviderId ?? this.providers.keys().next().value;
    if (!providerId) {
      throw new Error('No providers registered in orchestrator');
    }

    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Provider [${providerId}] not found`);
    }

    return await provider.getQuote(intent);
  }

  public async initiateExecution(
    idempotencyKey: string,
    intent: NormalizedIntent,
    quote: NormalizedQuote,
    plan?: ExecutionPlan
  ): Promise<ExecutionRecord> {
    // 1. In-flight concurrency deduplication: return shared promise if already dispatching
    if (this.inFlightExecutions.has(idempotencyKey)) {
      return await this.inFlightExecutions.get(idempotencyKey)!;
    }

    // 2. Strict Local Idempotency & Conflict Check
    const existing = this.persistence.findByIdempotencyKey(idempotencyKey);
    if (existing) {
      if (!areIntentsSemanticallyEqual(existing.intent, intent)) {
        throw new RouterError(
          DomainErrorCode.IDEMPOTENCY_CONFLICT,
          `Idempotency key [${idempotencyKey}] was previously used with a different intent payload`,
          {
            idempotencyKey,
            existingIntent: existing.intent,
            newIntent: intent,
          }
        );
      }
      if (existing.depositAddress) {
        return existing;
      }
      if (
        existing.state === ExecutionState.QUOTED ||
        existing.state === ExecutionState.EXECUTION_PENDING ||
        existing.state === ExecutionState.EXECUTING
      ) {
        return await this.awaitOrReconcileExecution(existing.id);
      }
      return existing;
    }

    const execPromise = this.executeInternal(idempotencyKey, intent, quote, plan);
    this.inFlightExecutions.set(idempotencyKey, execPromise);
    try {
      return await execPromise;
    } finally {
      this.inFlightExecutions.delete(idempotencyKey);
    }
  }

  private async executeInternal(
    idempotencyKey: string,
    intent: NormalizedIntent,
    quote: NormalizedQuote,
    plan?: ExecutionPlan
  ): Promise<ExecutionRecord> {
    // 2. Validate Quote Expiry
    if (new Date(quote.expiresAt).getTime() <= this.now()) {
      const expiredRecord = this.persistence.createExecution(idempotencyKey, intent);
      return this.persistence.transitionState(
        expiredRecord.id,
        ExecutionState.FAILED,
        `Cannot initiate execution: Quote [${quote.quoteId}] has already expired at ${quote.expiresAt}`,
        'API',
        { quoteExpiresAt: quote.expiresAt },
        { failureReason: 'Quote expired prior to execution dispatch' }
      );
    }

    // Construct immutable ExecutionPlan snapshot if not provided
    const executionPlan: ExecutionPlan = plan ?? {
      planId: `plan_${randomUUID().replace(/-/g, '')}`,
      edgeId: quote.providerId,
      routeId: `route_${quote.quoteId}`,
      quoteSnapshot: {
        quoteId: quote.quoteId,
        edgeId: quote.providerId,
        sourceNode: createAssetNode(quote.sourceAsset, quote.sourceNetwork),
        destinationNode: createAssetNode(quote.targetAsset, quote.targetNetwork),
        inputAmountAtomic: quote.depositAmountAtomic,
        estimatedOutputAmountAtomic: quote.settleAmountAtomic,
        rate: quote.rate,
        networkFeeEstimatedAtomic: quote.networkFeeEstimatedAtomic,
        minAmountAtomic: quote.minDepositAtomic,
        maxAmountAtomic: quote.maxDepositAtomic,
        expiresAt: quote.expiresAt,
        edgeClass: EdgeClass.TRUSTED_PROVIDER_EDGE,
        executionClass: ExecutionClass.PASSIVE_DEPOSIT,
        rawQuote: quote.rawQuote,
      },
      destinationAddress: intent.destinationAddress,
      refundAddress: intent.refundAddress,
      createdAt: new Date().toISOString(),
    };

    // 3. Atomically create CREATED record with snapshot
    const record = this.persistence.createExecution(idempotencyKey, intent, executionPlan);
    if (record.state !== ExecutionState.CREATED) {
      if (record.depositAddress) {
        return record;
      }
      if (
        record.state === ExecutionState.QUOTED ||
        record.state === ExecutionState.EXECUTION_PENDING ||
        record.state === ExecutionState.EXECUTING
      ) {
        return await this.awaitOrReconcileExecution(record.id);
      }
      return record;
    }

    // 4. Attach quote -> QUOTED
    ExecutionStateMachine.validateTransition(record.state, ExecutionState.QUOTED);
    this.persistence.transitionState(
      record.id,
      ExecutionState.QUOTED,
      `Quote secured from provider [${quote.providerId}]`,
      'API',
      { quoteId: quote.quoteId },
      { selectedQuote: quote, providerId: quote.providerId, plan: executionPlan }
    );

    // 5. Lock for execution -> EXECUTION_PENDING
    ExecutionStateMachine.validateTransition(
      ExecutionState.QUOTED,
      ExecutionState.EXECUTION_PENDING
    );
    this.persistence.transitionState(
      record.id,
      ExecutionState.EXECUTION_PENDING,
      'Execution authorized by client; locked against duplicate dispatches',
      'API'
    );

    const provider = this.providers.get(quote.providerId);
    if (!provider) {
      return this.persistence.transitionState(
        record.id,
        ExecutionState.RECOVERY_REQUIRED,
        `Configured provider [${quote.providerId}] missing from registry`,
        'API',
        null,
        { failureReason: 'Missing provider adapter' }
      );
    }

    // 6. Durable DB Dispatch Claim (Guarantees AT-MOST-ONE provider CREATE across all workers)
    const journalId = `jnl_${randomUUID().replace(/-/g, '')}`;
    const startTime = new Date().toISOString();

    const dispatchClaimed = this.persistence.acquireDispatchClaim(
      record.id,
      'createExecution',
      journalId,
      quote.providerId,
      startTime
    );

    if (!dispatchClaimed) {
      // Another worker/process already claimed dispatch right or progressed state!
      // This worker MUST NOT dispatch to provider.
      return await this.awaitOrReconcileExecution(record.id);
    }

    try {
      // Dispatch order to provider
      const result = await provider.createExecution({
        quoteId: quote.quoteId,
        idempotencyKey,
        intent,
        quote,
      });

      // Provider succeeded: transition to DEPOSIT_INSTRUCTION_READY with deposit address
      ExecutionStateMachine.validateTransition(
        ExecutionState.EXECUTING,
        ExecutionState.DEPOSIT_INSTRUCTION_READY
      );

      const updatedRecord = this.persistence.transitionState(
        record.id,
        ExecutionState.DEPOSIT_INSTRUCTION_READY,
        'Deposit instructions generated by provider; awaiting inbound asset transfer',
        'API',
        { providerExecutionId: result.providerExecutionId },
        {
          providerExecutionId: result.providerExecutionId,
          orderToken: result.orderToken ?? null,
          depositAddress: result.depositAddress,
          sourceFundsMoved: false,
          destinationFundsArrived: false,
        }
      );

      // Journal persistence succeeded
      this.persistence.updateProviderRequest(journalId, {
        requestCompletedAt: new Date().toISOString(),
        providerExecutionId: result.providerExecutionId,
        resultClassification: 'SUCCESS',
        responsePersisted: true,
      });

      return updatedRecord;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const isDefinitiveError =
        errorMessage.includes('400') ||
        errorMessage.includes('Invalid') ||
        errorMessage.includes('BAD_USER_INPUT') ||
        errorMessage.includes('LIMIT_MIN') ||
        errorMessage.includes('MAINTENANCE');

      this.persistence.updateProviderRequest(journalId, {
        requestCompletedAt: new Date().toISOString(),
        resultClassification: isDefinitiveError ? 'ERROR' : 'AMBIGUOUS_TIMEOUT',
        errorMessage: errorMessage.slice(0, 500),
      });

      // Safe rejection before order creation
      if (isDefinitiveError) {
        ExecutionStateMachine.validateTransition(
          ExecutionState.EXECUTING,
          ExecutionState.FAILED
        );
        return this.persistence.transitionState(
          record.id,
          ExecutionState.FAILED,
          `Definitively rejected by provider before order creation: ${errorMessage}`,
          'API',
          null,
          { failureReason: errorMessage, sourceFundsMoved: false }
        );
      }

      // CRITICAL P0 SCENARIO: Network timeout / dropped connection on POST
      ExecutionStateMachine.validateTransition(
        ExecutionState.EXECUTING,
        ExecutionState.RECOVERY_REQUIRED
      );
      const recoveryRecord = this.persistence.transitionState(
        record.id,
        ExecutionState.RECOVERY_REQUIRED,
        `Ambiguous response during provider dispatch: ${errorMessage}. Automated reconciliation required.`,
        'API',
        { error: errorMessage },
        { failureReason: errorMessage }
      );

      // Attempt immediate reconciliation
      return await this.reconcileExecution(recoveryRecord.id);
    }
  }

  private async awaitOrReconcileExecution(
    executionId: string,
    maxWaitMs: number = 2000
  ): Promise<ExecutionRecord> {
    const startTime = Date.now();
    while (Date.now() - startTime < maxWaitMs) {
      const current = this.persistence.findById(executionId);
      if (!current) {
        throw new Error(`Execution [${executionId}] not found`);
      }

      // If winning worker exposed deposit instructions:
      if (current.depositAddress) {
        return current;
      }

      // If execution progressed to terminal or recovery state:
      if (
        current.state !== ExecutionState.EXECUTING &&
        current.state !== ExecutionState.EXECUTION_PENDING
      ) {
        return current;
      }

      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    // Timed out waiting for winning worker -> run reconciliation
    return await this.reconcileExecution(executionId);
  }

  /**
   * Directly executes an immutable ExecutionPlan
   */
  public async executePlan(
    plan: ExecutionPlan,
    idempotencyKey: string
  ): Promise<ExecutionRecord> {
    // 1. Locate registered edge or provider
    const edge =
      this.routePlanner?.getEdge(plan.edgeId) ??
      (this.providers.get(plan.edgeId) as unknown as IExecutionEdge);
    if (!edge) {
      throw new RouterError(
        DomainErrorCode.ROUTE_NOT_FOUND,
        `Execution edge [${plan.edgeId}] is not registered in orchestrator`,
        { edgeId: plan.edgeId }
      );
    }

    // 2. Validate quote expiry against clock
    if (new Date(plan.quoteSnapshot.expiresAt).getTime() <= this.now()) {
      throw new RouterError(
        DomainErrorCode.QUOTE_EXPIRED,
        `ExecutionPlan quote [${plan.quoteSnapshot.quoteId}] has already expired at ${plan.quoteSnapshot.expiresAt}`,
        { quoteExpiresAt: plan.quoteSnapshot.expiresAt }
      );
    }

    // 3. Revalidate live runtime availability and minimums immediately before dispatch
    if ('getRuntimeAvailability' in edge && typeof edge.getRuntimeAvailability === 'function') {
      const availability = await edge.getRuntimeAvailability();

      if (availability.isMaintenance) {
        throw new RouterError(
          DomainErrorCode.PROVIDER_MAINTENANCE,
          availability.reason ?? `Edge [${plan.edgeId}] is currently under maintenance`,
          { edgeId: plan.edgeId, reason: availability.reason }
        );
      }

      if (!availability.isAvailable || !availability.recvEnabled) {
        throw new RouterError(
          DomainErrorCode.ROUTE_UNAVAILABLE,
          availability.reason ?? `Edge [${plan.edgeId}] is currently unavailable for execution`,
          { edgeId: plan.edgeId, reason: availability.reason }
        );
      }

      const inputAmount = BigInt(plan.quoteSnapshot.inputAmountAtomic);
      const minAmount = BigInt(availability.minAmountAtomic);
      if (inputAmount < minAmount) {
        throw new RouterError(
          DomainErrorCode.AMOUNT_BELOW_MINIMUM,
          `Amount ${plan.quoteSnapshot.inputAmountAtomic} is below live edge minimum ${availability.minAmountAtomic}`,
          {
            requestedAmountAtomic: plan.quoteSnapshot.inputAmountAtomic,
            minimumAmountAtomic: availability.minAmountAtomic,
            edgeId: plan.edgeId,
          }
        );
      }

      if (availability.maxAmountAtomic) {
        const maxAmount = BigInt(availability.maxAmountAtomic);
        if (inputAmount > maxAmount) {
          throw new RouterError(
            DomainErrorCode.AMOUNT_ABOVE_MAXIMUM,
            `Amount ${plan.quoteSnapshot.inputAmountAtomic} exceeds live edge maximum ${availability.maxAmountAtomic}`,
            {
              requestedAmountAtomic: plan.quoteSnapshot.inputAmountAtomic,
              maximumAmountAtomic: availability.maxAmountAtomic,
              edgeId: plan.edgeId,
            }
          );
        }
      }
    }

    const intent: NormalizedIntent = {
      sourceAsset: plan.quoteSnapshot.sourceNode.asset,
      sourceNetwork: plan.quoteSnapshot.sourceNode.network,
      targetAsset: plan.quoteSnapshot.destinationNode.asset,
      targetNetwork: plan.quoteSnapshot.destinationNode.network,
      sourceAmountAtomic: plan.quoteSnapshot.inputAmountAtomic,
      destinationAddress: plan.destinationAddress,
      refundAddress: plan.refundAddress,
    };

    const quote: NormalizedQuote = {
      quoteId: plan.quoteSnapshot.quoteId,
      providerId: plan.edgeId,
      sourceAsset: intent.sourceAsset,
      sourceNetwork: intent.sourceNetwork,
      targetAsset: intent.targetAsset,
      targetNetwork: intent.targetNetwork,
      depositAmountAtomic: plan.quoteSnapshot.inputAmountAtomic,
      settleAmountAtomic: plan.quoteSnapshot.estimatedOutputAmountAtomic,
      rate: plan.quoteSnapshot.rate,
      networkFeeEstimatedAtomic: plan.quoteSnapshot.networkFeeEstimatedAtomic,
      minDepositAtomic: plan.quoteSnapshot.minAmountAtomic,
      maxDepositAtomic: plan.quoteSnapshot.maxAmountAtomic,
      expiresAt: plan.quoteSnapshot.expiresAt,
      rawQuote: plan.quoteSnapshot.rawQuote,
    };

    return await this.initiateExecution(idempotencyKey, intent, quote, plan);
  }

  public async reconcileExecution(executionId: string): Promise<ExecutionRecord> {
    const record = this.persistence.findById(executionId);
    if (!record) {
      throw new Error(`Execution [${executionId}] not found`);
    }

    if (ExecutionStateMachine.isTerminal(record.state)) {
      return record;
    }

    const providerId = record.providerId;
    if (!providerId) {
      return record;
    }

    const provider = this.providers.get(providerId);
    if (!provider) {
      return record;
    }

    // AUDIT CHECK: Does providerExecutionId exist?
    if (!record.providerExecutionId) {
      const caps =
        typeof provider.capabilities === 'function'
          ? await provider.capabilities()
          : {
              executionClass:
                (provider as any).executionClass ?? ExecutionClass.PASSIVE_DEPOSIT,
              supportsStrongIdempotency: false,
            };

      // INVARIANT 1: ACTIVE_EXECUTION providers
      // An ambiguous create response must NEVER be interpreted as safe failure merely because no provider ID was returned!
      if (caps.executionClass === ExecutionClass.ACTIVE_EXECUTION) {
        return this.persistence.transitionState(
          record.id,
          ExecutionState.MANUAL_REVIEW,
          'ACTIVE_EXECUTION_AMBIGUITY: Outbound execution timed out before confirmation. Provider is Class B (Active Execution); funds may have moved. Escalating to MANUAL_REVIEW.',
          'RECOVERY_WORKER',
          null,
          {
            failureReason:
              'ACTIVE_EXECUTION_AMBIGUITY: Active execution provider cannot safely fail without deterministic proof.',
          }
        );
      }

      // INVARIANT 2: PASSIVE_DEPOSIT providers
      if (!caps.supportsStrongIdempotency) {
        if (record.depositAddress === null) {
          // Zero funds were moved, and no deposit address was ever exposed.
          return this.persistence.transitionState(
            record.id,
            ExecutionState.FAILED,
            'PASSIVE_DEPOSIT_AMBIGUITY_ABORT: PROVIDER_DOES_NOT_SUPPORT_STRONG_EXECUTION_IDEMPOTENCY: Outbound order creation timed out before providerExecutionId was received. Verified zero deposit address was issued; safe failure enforced.',
            'RECOVERY_WORKER',
            null,
            {
              failureReason:
                'PASSIVE_DEPOSIT_AMBIGUITY_ABORT: PROVIDER_DOES_NOT_SUPPORT_STRONG_EXECUTION_IDEMPOTENCY: Ambiguous create on passive deposit provider aborted safely.',
              sourceFundsMoved: false,
            }
          );
        } else {
          // Deposit address was somehow issued but providerExecutionId missing: Escalate to MANUAL_REVIEW!
          return this.persistence.transitionState(
            record.id,
            ExecutionState.MANUAL_REVIEW,
            'Deposit address exists but providerExecutionId is missing and provider does not support client idempotency lookup.',
            'RECOVERY_WORKER',
            null,
            { failureReason: 'Missing provider ID with active deposit address' }
          );
        }
      }
    }

    const providerExecutionId = record.providerExecutionId!;

    if (record.state === ExecutionState.RECOVERY_REQUIRED) {
      this.persistence.transitionState(
        record.id,
        ExecutionState.RECOVERING,
        'Starting automated provider status query',
        'RECOVERY_WORKER'
      );
    }

    try {
      const status = await provider.getStatus(
        providerExecutionId,
        record.orderToken ?? undefined
      );

      switch (status.status) {
        case ProviderNormalizedStatus.WAITING_FOR_DEPOSIT: {
          const current = this.persistence.findById(record.id)!;
          if (current.state === ExecutionState.RECOVERING) {
            return this.persistence.transitionState(
              record.id,
              ExecutionState.DEPOSIT_INSTRUCTION_READY,
              'Reconciled: Provider order verified active; awaiting inbound deposit',
              'RECOVERY_WORKER',
              { providerExecutionId },
              { sourceFundsMoved: false }
            );
          }
          return current;
        }

        case ProviderNormalizedStatus.DEPOSIT_RECEIVED: {
          const sourceEvidence: SourceSettlementEvidence = {
            network: record.intent.sourceNetwork,
            asset: record.intent.sourceAsset,
            amountAtomic: record.intent.sourceAmountAtomic,
            depositAddressOrInvoice: record.depositAddress ?? 'unknown',
            txIdOrPaymentHash: status.depositTxId,
            confirmations: 0,
            detectedAt: new Date().toISOString(),
            confirmedAt: null,
            evidenceSource: 'PROVIDER_STATUS',
            rawEvidence: status.raw,
          };

          return this.persistence.transitionState(
            record.id,
            ExecutionState.SOURCE_FUNDS_DETECTED,
            'Inbound deposit recognized by provider (0-conf)',
            'POLLING',
            { depositTxId: status.depositTxId },
            {
              sourceEvidence,
              sourceFundsMoved: true, // Funds have entered network/provider domain!
            }
          );
        }

        case ProviderNormalizedStatus.PROCESSING: {
          const sourceEvidence: SourceSettlementEvidence = {
            network: record.intent.sourceNetwork,
            asset: record.intent.sourceAsset,
            amountAtomic: record.intent.sourceAmountAtomic,
            depositAddressOrInvoice: record.depositAddress ?? 'unknown',
            txIdOrPaymentHash: status.depositTxId,
            confirmations: 1,
            detectedAt: record.sourceEvidence?.detectedAt ?? new Date().toISOString(),
            confirmedAt: new Date().toISOString(),
            evidenceSource: 'PROVIDER_STATUS',
            rawEvidence: status.raw,
          };

          // Transition through SOURCE_FUNDS_CONFIRMED to SWAP_IN_PROGRESS
          if (
            record.state === ExecutionState.DEPOSIT_INSTRUCTION_READY ||
            record.state === ExecutionState.SOURCE_FUNDS_DETECTED ||
            record.state === ExecutionState.RECOVERING
          ) {
            this.persistence.transitionState(
              record.id,
              ExecutionState.SOURCE_FUNDS_CONFIRMED,
              'Inbound deposit confirmed; source funds securely locked',
              'POLLING',
              { depositTxId: status.depositTxId },
              { sourceEvidence, sourceFundsMoved: true }
            );
          }

          return this.persistence.transitionState(
            record.id,
            ExecutionState.SWAP_IN_PROGRESS,
            'Provider accepted deposit and is executing the asset transformation',
            'POLLING',
            null,
            { sourceFundsMoved: true }
          );
        }

        case ProviderNormalizedStatus.SETTLING: {
          return this.persistence.transitionState(
            record.id,
            ExecutionState.SWAP_IN_PROGRESS,
            'Conversion complete; provider is broadcasting payout transaction',
            'POLLING',
            null,
            { sourceFundsMoved: true }
          );
        }

        case ProviderNormalizedStatus.COMPLETED: {
          const settleTxId = status.settleTxId;
          if (!settleTxId) {
            return this.persistence.transitionState(
              record.id,
              ExecutionState.MANUAL_REVIEW,
              'Provider reported COMPLETED but provided no settlement tx hash',
              'RECOVERY_WORKER',
              null,
              { failureReason: 'Missing settlement tx hash from provider' }
            );
          }

          // Advance to DESTINATION_TX_DETECTED first
          this.persistence.transitionState(
            record.id,
            ExecutionState.DESTINATION_TX_DETECTED,
            `Provider reported settlement broadcast with txHash: ${settleTxId}`,
            'POLLING',
            { settleTxId }
          );

          // INDEPENDENT ON-CHAIN VERIFICATION
          const verification = await this.chainVerifier.verifySettlement({
            txHash: settleTxId,
            network: record.intent.targetNetwork,
            expectedRecipient: record.intent.destinationAddress,
            expectedToken: record.intent.targetAsset,
            expectedMinAmountAtomic: record.selectedQuote?.settleAmountAtomic ?? '0',
          });

          if (!verification.verified) {
            const reason = `Chain verification discrepancy [${verification.status}]: ${verification.reason}`;
            return this.persistence.transitionState(
              record.id,
              ExecutionState.MANUAL_REVIEW,
              reason,
              'RECOVERY_WORKER',
              { settleTxId, verification },
              {
                failureReason: reason,
                destinationEvidence: verification.evidence ?? null,
                destinationFundsArrived: false,
              }
            );
          }

          const destinationEvidence: DestinationSettlementEvidence = verification.evidence ?? {
            network: record.intent.targetNetwork,
            asset: record.intent.targetAsset,
            amountAtomic: status.settleAmountActualAtomic ?? record.selectedQuote!.settleAmountAtomic,
            destinationAddress: record.intent.destinationAddress,
            txHash: settleTxId,
            blockNumber: verification.blockNumber ?? null,
            tokenContract: verification.confirmedTokenContract ?? null,
            verifiedOnChain: true,
            onChainStatus: 'CONFIRMED',
            verifiedAt: new Date().toISOString(),
            evidenceSource: 'BASE_RPC',
            rawEvidence: { verified: true },
          };

          return this.persistence.transitionState(
            record.id,
            ExecutionState.COMPLETED,
            `Settlement independently verified on Base blockchain (Receipt Status 1, Token & Recipient Verified)`,
            'RECOVERY_WORKER',
            { settleTxId, blockNumber: verification.blockNumber },
            {
              destinationEvidence,
              destinationFundsArrived: true,
              sourceFundsMoved: true,
            }
          );
        }

        case ProviderNormalizedStatus.REFUNDED: {
          // Verify refund evidence exists!
          if (!status.settleTxId) {
            const reason =
              'Provider reported REFUNDED but provided zero refund transaction evidence or hash';
            return this.persistence.transitionState(
              record.id,
              ExecutionState.MANUAL_REVIEW,
              reason,
              'RECOVERY_WORKER',
              null,
              { failureReason: reason }
            );
          }

          return this.persistence.transitionState(
            record.id,
            ExecutionState.REFUNDED,
            `Provider verified funds refunded to caller refund address with tx: ${status.settleTxId}`,
            'RECOVERY_WORKER',
            { refundTxId: status.settleTxId },
            { sourceFundsMoved: true }
          );
        }

        case ProviderNormalizedStatus.EXPIRED: {
          const current = this.persistence.findById(record.id)!;
          if (
            current.state === ExecutionState.DEPOSIT_INSTRUCTION_READY ||
            current.state === ExecutionState.RECOVERING
          ) {
            return this.persistence.transitionState(
              record.id,
              ExecutionState.FAILED,
              'Provider order expired with zero funds deposited',
              'RECOVERY_WORKER',
              null,
              {
                failureReason: 'Deposit window expired with zero deposit',
                sourceFundsMoved: false,
              }
            );
          }
          return current;
        }

        case ProviderNormalizedStatus.FAILED: {
          const current = this.persistence.findById(record.id)!;
          if (
            current.sourceFundsMoved ||
            ExecutionStateMachine.haveSourceFundsMoved(current.state)
          ) {
            return this.persistence.transitionState(
              record.id,
              ExecutionState.MANUAL_REVIEW,
              `CRITICAL DISCREPANCY: Provider reported FAILED, but source funds have already moved (${current.state}). Manual intervention required.`,
              'RECOVERY_WORKER',
              null,
              {
                failureReason:
                  status.failureReason ??
                  'Provider reported FAILED after source deposit',
              }
            );
          }

          if (
            current.state === ExecutionState.DEPOSIT_INSTRUCTION_READY ||
            current.state === ExecutionState.RECOVERING
          ) {
            return this.persistence.transitionState(
              record.id,
              ExecutionState.FAILED,
              `Provider order cancelled/failed with verified zero deposit: ${status.failureReason ?? 'Cancelled by provider'}`,
              'RECOVERY_WORKER',
              null,
              {
                failureReason:
                  status.failureReason ??
                  'Provider reported FAILED with zero deposit',
                sourceFundsMoved: false,
              }
            );
          }
          return current;
        }

        case ProviderNormalizedStatus.UNKNOWN:
        default: {
          return this.handleRecoveryRetry(
            record,
            `Provider returned unhandled status: ${status.status}`
          );
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return this.handleRecoveryRetry(record, `Status query failed: ${msg}`);
    }
  }

  private handleRecoveryRetry(
    record: ExecutionRecord,
    reason: string
  ): ExecutionRecord {
    const attempts = record.recoveryAttempts + 1;
    if (attempts >= this.maxRecoveryAttempts) {
      const fullReason = `Exceeded max recovery attempts (${this.maxRecoveryAttempts}). Human inspection required: ${reason}`;
      return this.persistence.transitionState(
        record.id,
        ExecutionState.MANUAL_REVIEW,
        fullReason,
        'RECOVERY_WORKER',
        { attempts },
        { recoveryAttempts: attempts, failureReason: fullReason }
      );
    }

    return this.persistence.transitionState(
      record.id,
      ExecutionState.RECOVERY_REQUIRED,
      `Recovery attempt ${attempts}/${this.maxRecoveryAttempts} failed: ${reason}`,
      'RECOVERY_WORKER',
      { attempts },
      { recoveryAttempts: attempts }
    );
  }

  public async reconcileAllInFlight(): Promise<ExecutionRecord[]> {
    const inFlight = this.persistence.findByStates(Array.from(AMBIGUOUS_STATES));
    const results: ExecutionRecord[] = [];

    for (const record of inFlight) {
      const reconciled = await this.reconcileExecution(record.id);
      results.push(reconciled);
    }

    return results;
  }
}
