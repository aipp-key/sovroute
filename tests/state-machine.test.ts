import test from 'node:test';
import assert from 'node:assert';
import {
  ExecutionState,
  TERMINAL_STATES,
  SOURCE_FUNDS_MOVED_STATES,
} from '../src/domain/types.ts';
import {
  ExecutionStateMachine,
  IllegalStateTransitionError,
} from '../src/state-machine/engine.ts';

test('State Machine - Valid Refined Lifecycle Transitions', () => {
  assert.doesNotThrow(() => {
    ExecutionStateMachine.validateTransition(null, ExecutionState.CREATED);
    ExecutionStateMachine.validateTransition(
      ExecutionState.CREATED,
      ExecutionState.QUOTING
    );
    ExecutionStateMachine.validateTransition(
      ExecutionState.QUOTING,
      ExecutionState.QUOTED
    );
    ExecutionStateMachine.validateTransition(
      ExecutionState.QUOTED,
      ExecutionState.EXECUTION_PENDING
    );
    ExecutionStateMachine.validateTransition(
      ExecutionState.EXECUTION_PENDING,
      ExecutionState.EXECUTING
    );
    ExecutionStateMachine.validateTransition(
      ExecutionState.EXECUTING,
      ExecutionState.DEPOSIT_INSTRUCTION_READY
    );
    ExecutionStateMachine.validateTransition(
      ExecutionState.DEPOSIT_INSTRUCTION_READY,
      ExecutionState.SOURCE_FUNDS_DETECTED
    );
    ExecutionStateMachine.validateTransition(
      ExecutionState.SOURCE_FUNDS_DETECTED,
      ExecutionState.SOURCE_FUNDS_CONFIRMED
    );
    ExecutionStateMachine.validateTransition(
      ExecutionState.SOURCE_FUNDS_CONFIRMED,
      ExecutionState.SWAP_IN_PROGRESS
    );
    ExecutionStateMachine.validateTransition(
      ExecutionState.SWAP_IN_PROGRESS,
      ExecutionState.DESTINATION_TX_DETECTED
    );
    ExecutionStateMachine.validateTransition(
      ExecutionState.DESTINATION_TX_DETECTED,
      ExecutionState.COMPLETED
    );
  });
});

test('State Machine - Invariant: Cannot Transition to FAILED if Source Funds Have Moved', () => {
  for (const state of SOURCE_FUNDS_MOVED_STATES) {
    if (state === ExecutionState.COMPLETED || state === ExecutionState.REFUNDED) continue;
    assert.throws(
      () => {
        ExecutionStateMachine.validateTransition(state, ExecutionState.FAILED);
      },
      IllegalStateTransitionError,
      `State [${state}] must not transition to FAILED because source funds have moved`
    );
  }
});

test('State Machine - Invariant: DEPOSIT_INSTRUCTION_READY to FAILED requires zeroDepositConfirmed', () => {
  assert.throws(
    () => {
      ExecutionStateMachine.validateTransition(
        ExecutionState.DEPOSIT_INSTRUCTION_READY,
        ExecutionState.FAILED,
        { zeroDepositConfirmed: false }
      );
    },
    IllegalStateTransitionError
  );

  assert.doesNotThrow(() => {
    ExecutionStateMachine.validateTransition(
      ExecutionState.DEPOSIT_INSTRUCTION_READY,
      ExecutionState.FAILED,
      { zeroDepositConfirmed: true }
    );
  });
});

test('State Machine - Terminal States Cannot Transition Out', () => {
  for (const terminal of TERMINAL_STATES) {
    assert.strictEqual(ExecutionStateMachine.isTerminal(terminal), true);
    assert.throws(
      () => {
        ExecutionStateMachine.validateTransition(
          terminal,
          ExecutionState.QUOTING
        );
      },
      IllegalStateTransitionError
    );
  }
});

test('State Machine - Source vs Destination Evaluation Functions', () => {
  assert.strictEqual(
    ExecutionStateMachine.haveSourceFundsMoved(ExecutionState.DEPOSIT_INSTRUCTION_READY),
    false
  );
  assert.strictEqual(
    ExecutionStateMachine.haveSourceFundsMoved(ExecutionState.SOURCE_FUNDS_DETECTED),
    true
  );
  assert.strictEqual(
    ExecutionStateMachine.haveSourceFundsMoved(ExecutionState.SOURCE_FUNDS_CONFIRMED),
    true
  );
  assert.strictEqual(
    ExecutionStateMachine.haveDestinationFundsArrived(ExecutionState.DESTINATION_TX_DETECTED),
    false
  );
  assert.strictEqual(
    ExecutionStateMachine.haveDestinationFundsArrived(ExecutionState.COMPLETED),
    true
  );
});
