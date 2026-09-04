import {
  ExecutionState,
  TERMINAL_STATES,
  SOURCE_FUNDS_MOVED_STATES,
  type DestinationSettlementEvidence,
} from '../domain/types.ts';

export class IllegalStateTransitionError extends Error {
  public readonly fromState: ExecutionState | null;
  public readonly toState: ExecutionState;
  public readonly reason: string;

  constructor(
    fromState: ExecutionState | null,
    toState: ExecutionState,
    reason: string
  ) {
    super(
      `Illegal state transition from [${fromState ?? 'NONE'}] to [${toState}]: ${reason}`
    );
    this.name = 'IllegalStateTransitionError';
    this.fromState = fromState;
    this.toState = toState;
    this.reason = reason;
  }
}

/**
 * Refined legal transitions graph
 */
const LEGAL_TRANSITIONS: Record<ExecutionState, ReadonlySet<ExecutionState>> = {
  [ExecutionState.CREATED]: new Set([
    ExecutionState.QUOTING,
    ExecutionState.QUOTED,
    ExecutionState.FAILED,
  ]),
  [ExecutionState.QUOTING]: new Set([
    ExecutionState.QUOTED,
    ExecutionState.FAILED,
  ]),
  [ExecutionState.QUOTED]: new Set([
    ExecutionState.EXECUTION_PENDING,
    ExecutionState.QUOTING, // Re-quote upon expiry
    ExecutionState.FAILED,
  ]),
  [ExecutionState.EXECUTION_PENDING]: new Set([
    ExecutionState.EXECUTING,
    ExecutionState.RECOVERY_REQUIRED,
  ]),
  [ExecutionState.EXECUTING]: new Set([
    ExecutionState.DEPOSIT_INSTRUCTION_READY, // Provider order created, awaiting deposit
    ExecutionState.RECOVERY_REQUIRED,        // Network dropped / timeout on POST
    ExecutionState.FAILED,                   // Definitive 4xx rejection before order creation
  ]),
  [ExecutionState.DEPOSIT_INSTRUCTION_READY]: new Set([
    ExecutionState.SOURCE_FUNDS_DETECTED,   // Inbound mempool / 0-conf seen
    ExecutionState.SOURCE_FUNDS_CONFIRMED,  // Inbound 1-conf directly observed
    ExecutionState.FAILED,                  // Expired with verified ZERO deposit
    ExecutionState.RECOVERY_REQUIRED,       // Ambiguity / discrepancy
  ]),
  [ExecutionState.SOURCE_FUNDS_DETECTED]: new Set([
    ExecutionState.SOURCE_FUNDS_CONFIRMED,  // Source funds confirmed on-chain
    ExecutionState.SWAP_IN_PROGRESS,        // Provider accepted 0-conf and started swap
    ExecutionState.RECOVERY_REQUIRED,       // Reorg or delayed confirmation
  ]),
  [ExecutionState.SOURCE_FUNDS_CONFIRMED]: new Set([
    ExecutionState.SWAP_IN_PROGRESS,        // Provider accepted funds, converting
    ExecutionState.DESTINATION_TX_DETECTED, // Fast-path: provider already broadcast payout
    ExecutionState.RECOVERY_REQUIRED,
  ]),
  [ExecutionState.SWAP_IN_PROGRESS]: new Set([
    ExecutionState.DESTINATION_TX_DETECTED, // Payout tx broadcast on Base
    ExecutionState.RECOVERY_REQUIRED,       // Provider paused / stuck
  ]),
  [ExecutionState.DESTINATION_TX_DETECTED]: new Set([
    ExecutionState.COMPLETED,               // Independently verified on Base RPC
    ExecutionState.RECOVERY_REQUIRED,       // Chain verification failed / reverted / discrepancy
  ]),
  [ExecutionState.RECOVERY_REQUIRED]: new Set([
    ExecutionState.RECOVERING,
  ]),
  [ExecutionState.RECOVERING]: new Set([
    ExecutionState.DEPOSIT_INSTRUCTION_READY, // Recovered active order
    ExecutionState.SOURCE_FUNDS_DETECTED,
    ExecutionState.SOURCE_FUNDS_CONFIRMED,
    ExecutionState.SWAP_IN_PROGRESS,
    ExecutionState.DESTINATION_TX_DETECTED,
    ExecutionState.COMPLETED,                 // Verified completion discovered during recovery
    ExecutionState.REFUNDED,                  // Verified refund discovered
    ExecutionState.FAILED,                    // Proven safe failure (zero funds moved)
    ExecutionState.RECOVERY_REQUIRED,         // Retry recovery
    ExecutionState.MANUAL_REVIEW,             // Recovery exhausted / circuit breaker
  ]),
  // Terminal states have NO legal outgoing transitions
  [ExecutionState.COMPLETED]: new Set(),
  [ExecutionState.FAILED]: new Set(),
  [ExecutionState.REFUNDED]: new Set(),
  [ExecutionState.MANUAL_REVIEW]: new Set(),
};

export interface TransitionOptions {
  zeroDepositConfirmed?: boolean;
}

export class ExecutionStateMachine {
  public static validateTransition(
    fromState: ExecutionState | null,
    toState: ExecutionState,
    options: TransitionOptions = {}
  ): void {
    if (fromState === null) {
      if (toState !== ExecutionState.CREATED) {
        throw new IllegalStateTransitionError(
          fromState,
          toState,
          'Initial state must always be CREATED'
        );
      }
      return;
    }

    if (TERMINAL_STATES.has(fromState)) {
      throw new IllegalStateTransitionError(
        fromState,
        toState,
        `Cannot transition out of terminal state [${fromState}]`
      );
    }

    const allowed = LEGAL_TRANSITIONS[fromState];
    if (!allowed || !allowed.has(toState)) {
      throw new IllegalStateTransitionError(
        fromState,
        toState,
        `Direct transition from [${fromState}] to [${toState}] is not permitted by state machine`
      );
    }

    // STRICT INVARIANT 1: Cannot mark FAILED if source funds have moved!
    if (toState === ExecutionState.FAILED) {
      if (this.haveSourceFundsMoved(fromState)) {
        throw new IllegalStateTransitionError(
          fromState,
          toState,
          `CRITICAL SAFETY VIOLATION: Cannot transition to FAILED from state [${fromState}] because source funds have moved or were detected. Must transition to RECOVERY_REQUIRED -> REFUNDED or MANUAL_REVIEW.`
        );
      }

      // If from DEPOSIT_INSTRUCTION_READY to FAILED: must certify zero deposits
      if (fromState === ExecutionState.DEPOSIT_INSTRUCTION_READY) {
        if (!options.zeroDepositConfirmed) {
          throw new IllegalStateTransitionError(
            fromState,
            toState,
            'Cannot mark DEPOSIT_INSTRUCTION_READY as FAILED without verified confirmation that zero funds were deposited. Transition to RECOVERY_REQUIRED instead.'
          );
        }
      }
    }
  }

  public static isTerminal(state: ExecutionState): boolean {
    return TERMINAL_STATES.has(state);
  }

  /**
   * Evaluates definitively whether source funds have left the client/agent domain.
   */
  public static haveSourceFundsMoved(state: ExecutionState): boolean {
    return SOURCE_FUNDS_MOVED_STATES.has(state);
  }

  /**
   * Evaluates definitively whether destination funds have arrived and been verified.
   */
  public static haveDestinationFundsArrived(state: ExecutionState): boolean {
    return state === ExecutionState.COMPLETED;
  }

  /**
   * Evaluates whether execution can transition to FAILED without financial loss.
   */
  public static canSafelyFail(
    fromState: ExecutionState,
    sourceFundsMoved: boolean,
    zeroDepositConfirmed: boolean
  ): boolean {
    if (sourceFundsMoved) return false;
    if (fromState === ExecutionState.DEPOSIT_INSTRUCTION_READY && !zeroDepositConfirmed) return false;
    if (this.haveSourceFundsMoved(fromState)) return false;
    return true;
  }

  /**
   * Evaluates whether destination settlement is conclusively evidenced on-chain.
   */
  public static isDestinationSettlementEvidenced(
    evidence: DestinationSettlementEvidence | null
  ): boolean {
    if (!evidence) return false;
    if (!evidence.verifiedOnChain) return false;
    if (evidence.onChainStatus !== 'CONFIRMED') return false;
    if (evidence.evidenceSource !== 'BASE_RPC') return false;
    return true;
  }
}
