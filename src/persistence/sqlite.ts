import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { keccak256, type Hex } from 'viem';
import {
  type ExecutionRecord,
  ExecutionState,
  type StateTransitionRecord,
  type NormalizedIntent,
  type NormalizedQuote,
  type SourceSettlementEvidence,
  type DestinationSettlementEvidence,
  type ExecutionPlan,
  type ProviderRequestJournalEntry,
  areIntentsSemanticallyEqual,
  RouterError,
  DomainErrorCode,
} from '../domain/types.ts';
import {
  EvmLogicalIntentState,
  EvmPhysicalAttemptStatus,
  type EvmLogicalIntent,
  type EvmPhysicalAttempt,
  type CreateIntentParams,
  type PrepareAttemptParams,
} from '../atomic/evm/transaction-types.ts';
import {
  type SovereignExecutionRecord,
  SovereignAtomicState,
  type SovereignSwapTransition,
  type HoldInvoice,
  type LiquidityReservationStatus,
} from '../atomic/types.ts';

export interface LiquidityReservationRecord {
  id: string;
  executionId: string;
  tokenAddress: string;
  amountUnits: bigint;
  status: LiquidityReservationStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface SqliteDbOptions {
  filename?: string;
}

export class SqlitePersistence {
  private db: DatabaseSync;

  constructor(options: SqliteDbOptions = {}) {
    const filename = options.filename ?? ':memory:';

    if (filename !== ':memory:') {
      const dir = path.dirname(filename);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new DatabaseSync(filename);
    this.initPragmas();
    this.initSchema();
  }

  private initPragmas(): void {
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT UNIQUE NOT NULL,
        state TEXT NOT NULL,
        intent_json TEXT NOT NULL,
        quote_json TEXT,
        provider_id TEXT,
        provider_execution_id TEXT,
        order_token TEXT,
        deposit_address TEXT,
        source_evidence_json TEXT,
        destination_evidence_json TEXT,
        source_funds_moved INTEGER NOT NULL DEFAULT 0,
        destination_funds_arrived INTEGER NOT NULL DEFAULT 0,
        failure_reason TEXT,
        recovery_attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_executions_state ON executions(state);
      CREATE INDEX IF NOT EXISTS idx_executions_idempotency ON executions(idempotency_key);

      CREATE TABLE IF NOT EXISTS state_transitions (
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL,
        from_state TEXT,
        to_state TEXT NOT NULL,
        reason TEXT NOT NULL,
        trigger TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (execution_id) REFERENCES executions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS provider_request_journal (
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        request_started_at TEXT NOT NULL,
        request_completed_at TEXT,
        provider_execution_id TEXT,
        result_classification TEXT NOT NULL,
        response_persisted INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (execution_id) REFERENCES executions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_journal_exec ON provider_request_journal(execution_id);

      CREATE TABLE IF NOT EXISTS provider_dispatch_claims (
        execution_id TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        journal_id TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        FOREIGN KEY (execution_id) REFERENCES executions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS evm_transaction_intents (
        id TEXT PRIMARY KEY,
        swap_key TEXT NOT NULL,
        action_type TEXT NOT NULL,
        chain_id INTEGER NOT NULL,
        signer_address TEXT NOT NULL,
        target_contract TEXT NOT NULL,
        calldata_hash TEXT NOT NULL,
        calldata_bytes TEXT NOT NULL,
        value_wei TEXT NOT NULL,
        nonce INTEGER,
        status TEXT NOT NULL,
        canonical_tx_hash TEXT,
        failure_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (swap_key, action_type)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_evm_intents_unique_nonce
        ON evm_transaction_intents(chain_id, signer_address, nonce)
        WHERE nonce IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_evm_intents_status
        ON evm_transaction_intents(status);

      CREATE TABLE IF NOT EXISTS evm_transaction_attempts (
        id TEXT PRIMARY KEY,
        intent_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        chain_id INTEGER NOT NULL,
        signer_address TEXT NOT NULL,
        nonce INTEGER NOT NULL,
        tx_hash TEXT UNIQUE NOT NULL,
        to_address TEXT NOT NULL,
        value_wei TEXT NOT NULL,
        data TEXT NOT NULL,
        calldata_hash TEXT NOT NULL,
        gas_limit TEXT NOT NULL,
        max_fee_per_gas_wei TEXT NOT NULL,
        max_priority_fee_per_gas_wei TEXT NOT NULL,
        worst_case_cost_wei TEXT NOT NULL,
        status TEXT NOT NULL,
        mined_block_number INTEGER,
        receipt_status INTEGER,
        broadcast_at TEXT,
        reconciled_at TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (intent_id) REFERENCES evm_transaction_intents(id) ON DELETE CASCADE,
        UNIQUE (intent_id, attempt_number)
      );

      CREATE INDEX IF NOT EXISTS idx_evm_attempts_intent ON evm_transaction_attempts(intent_id);
      CREATE INDEX IF NOT EXISTS idx_evm_attempts_status ON evm_transaction_attempts(status);

      CREATE TABLE IF NOT EXISTS sovereign_swaps (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT UNIQUE NOT NULL,
        hash_lock TEXT UNIQUE NOT NULL,
        payment_hash TEXT UNIQUE NOT NULL,
        state TEXT NOT NULL,
        reservation_id TEXT,
        reserved_amount_units TEXT,
        reservation_status TEXT,
        amount_sats TEXT NOT NULL,
        expected_usdc_amount TEXT NOT NULL,
        claiming_address TEXT NOT NULL,
        target_destination_address TEXT NOT NULL,
        token_address TEXT NOT NULL,
        refund_address TEXT NOT NULL,
        cltv_expiry_blocks INTEGER NOT NULL,
        timelock_seconds INTEGER NOT NULL,
        refund_locktime INTEGER,
        economic_fingerprint TEXT NOT NULL,
        bolt11 TEXT,
        lightning_invoice_state TEXT,
        lightning_held_at TEXT,
        lightning_settled_at TEXT,
        lightning_canceled_at TEXT,
        lightning_expiry_height INTEGER,
        evm_swap_key TEXT,
        evm_htlc_id TEXT,
        evm_funding_tx_hash TEXT,
        evm_claim_tx_hash TEXT,
        evm_refund_tx_hash TEXT,
        destination_tx_hash TEXT,
        action_in_flight TEXT,
        action_claimed_by TEXT,
        action_claimed_at TEXT,
        action_lease_expires_at TEXT,
        action_generation INTEGER NOT NULL DEFAULT 0,
        recovery_required INTEGER NOT NULL DEFAULT 0,
        failure_reason TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sovereign_swaps_state ON sovereign_swaps(state);
      CREATE INDEX IF NOT EXISTS idx_sovereign_swaps_idempotency ON sovereign_swaps(idempotency_key);
      CREATE INDEX IF NOT EXISTS idx_sovereign_swaps_hash_lock ON sovereign_swaps(hash_lock);
      CREATE INDEX IF NOT EXISTS idx_sovereign_swaps_payment_hash ON sovereign_swaps(payment_hash);
      CREATE INDEX IF NOT EXISTS idx_sovereign_swaps_recovery ON sovereign_swaps(recovery_required);
      CREATE INDEX IF NOT EXISTS idx_sovereign_swaps_reservation ON sovereign_swaps(reservation_id);

      CREATE TABLE IF NOT EXISTS sovereign_swap_transitions (
        id TEXT PRIMARY KEY,
        swap_id TEXT NOT NULL,
        from_state TEXT,
        to_state TEXT NOT NULL,
        reason TEXT NOT NULL,
        evidence_id TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (swap_id) REFERENCES sovereign_swaps(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_sovereign_transitions_swap ON sovereign_swap_transitions(swap_id);

      CREATE TABLE IF NOT EXISTS operator_inventory (
        token_address TEXT PRIMARY KEY,
        confirmed_balance TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS liquidity_reservations (
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL,
        token_address TEXT NOT NULL,
        amount_units TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_liquidity_reservations_exec ON liquidity_reservations(execution_id);
      CREATE INDEX IF NOT EXISTS idx_liquidity_reservations_token_status ON liquidity_reservations(token_address, status);
    `);

    // Safe additive migrations for existing DB
    try {
      this.db.exec('ALTER TABLE executions ADD COLUMN order_token TEXT;');
    } catch {
      // Column already exists
    }

    try {
      this.db.exec('ALTER TABLE executions ADD COLUMN execution_plan_json TEXT;');
    } catch {
      // Column already exists
    }

    try {
      this.db.exec('ALTER TABLE sovereign_swaps ADD COLUMN action_generation INTEGER NOT NULL DEFAULT 0;');
    } catch {
      // Column already exists
    }

    try {
      this.db.exec('ALTER TABLE sovereign_swaps ADD COLUMN lightning_expiry_height INTEGER;');
    } catch {
      // Column already exists
    }

    try {
      this.db.exec('ALTER TABLE sovereign_swaps ADD COLUMN action_lease_expires_at TEXT;');
    } catch {
      // Column already exists
    }

    try {
      this.db.exec('ALTER TABLE sovereign_swaps ADD COLUMN reservation_id TEXT;');
    } catch {
      // Column already exists
    }

    try {
      this.db.exec('ALTER TABLE sovereign_swaps ADD COLUMN reserved_amount_units TEXT;');
    } catch {
      // Column already exists
    }

    try {
      this.db.exec('ALTER TABLE sovereign_swaps ADD COLUMN reservation_status TEXT;');
    } catch {
      // Column already exists
    }
  }

  public close(): void {
    this.db.close();
  }

  public findByIdempotencyKey(key: string): ExecutionRecord | null {
    const stmt = this.db.prepare('SELECT * FROM executions WHERE idempotency_key = ?');
    const row = stmt.get(key) as Record<string, unknown> | undefined;
    return row ? this.mapRowToExecution(row) : null;
  }

  public findById(id: string): ExecutionRecord | null {
    const stmt = this.db.prepare('SELECT * FROM executions WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRowToExecution(row) : null;
  }

  public findByStates(states: ExecutionState[]): ExecutionRecord[] {
    if (states.length === 0) return [];
    const placeholders = states.map(() => '?').join(',');
    const stmt = this.db.prepare(
      `SELECT * FROM executions WHERE state IN (${placeholders}) ORDER BY created_at ASC`
    );
    const rows = stmt.all(...states) as Record<string, unknown>[];
    return rows.map((r) => this.mapRowToExecution(r));
  }

  public createExecution(
    idempotencyKey: string,
    intent: NormalizedIntent,
    plan?: ExecutionPlan | null
  ): ExecutionRecord {
    const existing = this.findByIdempotencyKey(idempotencyKey);
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
      return existing;
    }

    const now = new Date().toISOString();
    const executionId = `exec_${randomUUID().replace(/-/g, '')}`;
    const transitionId = `tr_${randomUUID().replace(/-/g, '')}`;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Re-verify inside transaction boundary
      const raceExisting = this.findByIdempotencyKey(idempotencyKey);
      if (raceExisting) {
        this.db.exec('COMMIT');
        if (!areIntentsSemanticallyEqual(raceExisting.intent, intent)) {
          throw new RouterError(
            DomainErrorCode.IDEMPOTENCY_CONFLICT,
            `Idempotency key [${idempotencyKey}] was previously used with a different intent payload`,
            {
              idempotencyKey,
              existingIntent: raceExisting.intent,
              newIntent: intent,
            }
          );
        }
        return raceExisting;
      }

      const insertExec = this.db.prepare(`
        INSERT INTO executions (
          id, idempotency_key, state, intent_json, quote_json,
          provider_id, provider_execution_id, deposit_address,
          source_evidence_json, destination_evidence_json,
          source_funds_moved, destination_funds_arrived,
          failure_reason, recovery_attempts, created_at, updated_at,
          execution_plan_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      insertExec.run(
        executionId,
        idempotencyKey,
        ExecutionState.CREATED,
        JSON.stringify(intent),
        null,
        null,
        null,
        null,
        null,
        null,
        0,
        0,
        null,
        0,
        now,
        now,
        plan ? JSON.stringify(plan) : null
      );

      const insertTrans = this.db.prepare(`
        INSERT INTO state_transitions (
          id, execution_id, from_state, to_state, reason, trigger, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      insertTrans.run(
        transitionId,
        executionId,
        null,
        ExecutionState.CREATED,
        'Intent normalized and execution created',
        'API',
        null,
        now
      );

      this.db.exec('COMMIT');
    } catch (err: unknown) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Rollback if transaction was open
      }

      // Check if unique constraint was satisfied by another concurrent worker
      const raceExisting = this.findByIdempotencyKey(idempotencyKey);
      if (raceExisting) {
        if (!areIntentsSemanticallyEqual(raceExisting.intent, intent)) {
          throw new RouterError(
            DomainErrorCode.IDEMPOTENCY_CONFLICT,
            `Idempotency key [${idempotencyKey}] was previously used with a different intent payload`,
            {
              idempotencyKey,
              existingIntent: raceExisting.intent,
              newIntent: intent,
            }
          );
        }
        return raceExisting;
      }

      throw err;
    }

    return this.findById(executionId)!;
  }

  public transitionState(
    executionId: string,
    toState: ExecutionState,
    reason: string,
    trigger: 'API' | 'POLLING' | 'RECOVERY_WORKER' | 'RESTART' | 'CHAIN' | 'PROVIDER' | 'VERIFIER' | 'WORKER' | 'TEST' | string,
    metadata: Record<string, unknown> | null = null,
    partialUpdates: Partial<ExecutionRecord> = {}
  ): ExecutionRecord {
    const current = this.findById(executionId);
    if (!current) {
      throw new Error(`Execution [${executionId}] not found`);
    }

    const now = new Date().toISOString();
    const transitionId = `tr_${randomUUID().replace(/-/g, '')}`;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      // 1. Insert audit transition record
      const insertTrans = this.db.prepare(`
        INSERT INTO state_transitions (
          id, execution_id, from_state, to_state, reason, trigger, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      insertTrans.run(
        transitionId,
        executionId,
        current.state,
        toState,
        reason,
        trigger,
        metadata ? JSON.stringify(metadata) : null,
        now
      );

      // 2. Build update query
      const fields: string[] = ['state = ?', 'updated_at = ?'];
      const values: (string | number | bigint | null)[] = [toState, now];

      if (partialUpdates.selectedQuote !== undefined) {
        fields.push('quote_json = ?');
        values.push(
          partialUpdates.selectedQuote ? JSON.stringify(partialUpdates.selectedQuote) : null
        );
      }
      if (partialUpdates.providerId !== undefined) {
        fields.push('provider_id = ?');
        values.push(partialUpdates.providerId ?? null);
      }
      if (partialUpdates.providerExecutionId !== undefined) {
        fields.push('provider_execution_id = ?');
        values.push(partialUpdates.providerExecutionId ?? null);
      }
      if (partialUpdates.orderToken !== undefined) {
        fields.push('order_token = ?');
        values.push(partialUpdates.orderToken ?? null);
      }
      if (partialUpdates.depositAddress !== undefined) {
        fields.push('deposit_address = ?');
        values.push(partialUpdates.depositAddress ?? null);
      }
      if (partialUpdates.sourceEvidence !== undefined) {
        fields.push('source_evidence_json = ?');
        values.push(
          partialUpdates.sourceEvidence ? JSON.stringify(partialUpdates.sourceEvidence) : null
        );
      }
      if (partialUpdates.destinationEvidence !== undefined) {
        fields.push('destination_evidence_json = ?');
        values.push(
          partialUpdates.destinationEvidence
            ? JSON.stringify(partialUpdates.destinationEvidence)
            : null
        );
      }
      if (partialUpdates.sourceFundsMoved !== undefined) {
        fields.push('source_funds_moved = ?');
        values.push(partialUpdates.sourceFundsMoved ? 1 : 0);
      }
      if (partialUpdates.destinationFundsArrived !== undefined) {
        fields.push('destination_funds_arrived = ?');
        values.push(partialUpdates.destinationFundsArrived ? 1 : 0);
      }
      if (partialUpdates.plan !== undefined) {
        fields.push('execution_plan_json = ?');
        values.push(
          partialUpdates.plan ? JSON.stringify(partialUpdates.plan) : null
        );
      }
      if (partialUpdates.failureReason !== undefined) {
        fields.push('failure_reason = ?');
        values.push(partialUpdates.failureReason ?? null);
      }
      if (partialUpdates.recoveryAttempts !== undefined) {
        fields.push('recovery_attempts = ?');
        values.push(partialUpdates.recoveryAttempts ?? null);
      }

      values.push(executionId);
      const updateQuery = `UPDATE executions SET ${fields.join(', ')} WHERE id = ?`;
      this.db.prepare(updateQuery).run(...values);

      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return this.findById(executionId)!;
  }

  public logProviderRequest(entry: ProviderRequestJournalEntry): void {
    const stmt = this.db.prepare(`
      INSERT INTO provider_request_journal (
        id, execution_id, provider_id, operation, attempt_number,
        request_started_at, request_completed_at, provider_execution_id,
        result_classification, response_persisted, error_message, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      entry.id,
      entry.executionId,
      entry.providerId,
      entry.operation,
      entry.attemptNumber,
      entry.requestStartedAt,
      entry.requestCompletedAt ?? null,
      entry.providerExecutionId ?? null,
      entry.resultClassification,
      entry.responsePersisted ? 1 : 0,
      entry.errorMessage ?? null,
      entry.createdAt
    );
  }

  public updateProviderRequest(
    id: string,
    updates: Partial<ProviderRequestJournalEntry>
  ): void {
    const fields: string[] = [];
    const values: (string | number | null)[] = [];

    if (updates.requestCompletedAt !== undefined) {
      fields.push('request_completed_at = ?');
      values.push(updates.requestCompletedAt ?? null);
    }
    if (updates.providerExecutionId !== undefined) {
      fields.push('provider_execution_id = ?');
      values.push(updates.providerExecutionId ?? null);
    }
    if (updates.resultClassification !== undefined) {
      fields.push('result_classification = ?');
      values.push(updates.resultClassification);
    }
    if (updates.responsePersisted !== undefined) {
      fields.push('response_persisted = ?');
      values.push(updates.responsePersisted ? 1 : 0);
    }
    if (updates.errorMessage !== undefined) {
      fields.push('error_message = ?');
      values.push(updates.errorMessage ?? null);
    }

    if (fields.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE provider_request_journal SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  public getProviderRequests(executionId: string): ProviderRequestJournalEntry[] {
    const stmt = this.db.prepare(
      'SELECT * FROM provider_request_journal WHERE execution_id = ? ORDER BY request_started_at ASC'
    );
    const rows = stmt.all(executionId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      executionId: r.execution_id as string,
      providerId: r.provider_id as string,
      operation: r.operation as string,
      attemptNumber: Number(r.attempt_number),
      requestStartedAt: r.request_started_at as string,
      requestCompletedAt: (r.request_completed_at as string) || undefined,
      providerExecutionId: (r.provider_execution_id as string) || undefined,
      resultClassification: r.result_classification as ProviderRequestJournalEntry['resultClassification'],
      responsePersisted: Number(r.response_persisted) === 1,
      errorMessage: (r.error_message as string) || undefined,
      createdAt: r.created_at as string,
    }));
  }

  public acquireDispatchClaim(
    executionId: string,
    operation: string,
    journalId: string,
    providerId: string,
    startTime: string
  ): boolean {
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // 1. Check if a claim row already exists for this execution
      const stmtCheckClaim = this.db.prepare(
        'SELECT journal_id FROM provider_dispatch_claims WHERE execution_id = ?'
      );
      const existingClaim = stmtCheckClaim.get(executionId);
      if (existingClaim) {
        this.db.exec('COMMIT');
        return false;
      }

      // 2. Check current state in executions
      const stmtCheckState = this.db.prepare(
        'SELECT state FROM executions WHERE id = ?'
      );
      const row = stmtCheckState.get(executionId) as { state: string } | undefined;
      if (!row || row.state !== ExecutionState.EXECUTION_PENDING) {
        this.db.exec('COMMIT');
        return false;
      }

      // 3. Atomically claim dispatch right by inserting into provider_dispatch_claims
      const insertClaim = this.db.prepare(`
        INSERT INTO provider_dispatch_claims (
          execution_id, operation, journal_id, claimed_at
        ) VALUES (?, ?, ?, ?)
      `);
      insertClaim.run(executionId, operation, journalId, now);

      // 4. Atomically insert durable journal entry
      const insertJournal = this.db.prepare(`
        INSERT INTO provider_request_journal (
          id, execution_id, provider_id, operation, attempt_number,
          request_started_at, result_classification, response_persisted, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertJournal.run(
        journalId,
        executionId,
        providerId,
        operation,
        1,
        startTime,
        'AMBIGUOUS_TIMEOUT',
        0,
        startTime
      );

      // 5. Atomically transition state to EXECUTING with conditional update
      const updateExec = this.db.prepare(`
        UPDATE executions SET state = ?, updated_at = ? WHERE id = ? AND state = ?
      `);
      const result = updateExec.run(
        ExecutionState.EXECUTING,
        now,
        executionId,
        ExecutionState.EXECUTION_PENDING
      );

      if (Number(result.changes) === 0) {
        this.db.exec('ROLLBACK');
        return false;
      }

      // 6. Record state transition in audit table
      const transitionId = `tr_${randomUUID().replace(/-/g, '')}`;
      const insertTrans = this.db.prepare(`
        INSERT INTO state_transitions (
          id, execution_id, from_state, to_state, reason, trigger, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertTrans.run(
        transitionId,
        executionId,
        ExecutionState.EXECUTION_PENDING,
        ExecutionState.EXECUTING,
        'Durable dispatch claim acquired; dispatching to provider',
        'API',
        JSON.stringify({ journalId, operation }),
        now
      );

      this.db.exec('COMMIT');
      return true;
    } catch {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      return false;
    }
  }

  public getDispatchClaim(
    executionId: string
  ): { executionId: string; operation: string; journalId: string; claimedAt: string } | null {
    const stmt = this.db.prepare(
      'SELECT execution_id, operation, journal_id, claimed_at FROM provider_dispatch_claims WHERE execution_id = ?'
    );
    const row = stmt.get(executionId) as
      | { execution_id: string; operation: string; journal_id: string; claimed_at: string }
      | undefined;
    if (!row) return null;
    return {
      executionId: row.execution_id,
      operation: row.operation,
      journalId: row.journal_id,
      claimedAt: row.claimed_at,
    };
  }

  public getTransitions(executionId: string): StateTransitionRecord[] {
    const stmt = this.db.prepare(
      'SELECT * FROM state_transitions WHERE execution_id = ? ORDER BY created_at ASC'
    );
    const rows = stmt.all(executionId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      executionId: r.execution_id as string,
      fromState: (r.from_state as ExecutionState) || null,
      toState: r.to_state as ExecutionState,
      reason: r.reason as string,
      trigger: r.trigger as StateTransitionRecord['trigger'],
      metadata: r.metadata_json ? JSON.parse(r.metadata_json as string) : null,
      createdAt: r.created_at as string,
    }));
  }

  // ==========================================
  // PHASE 5A: EVM RELIABILITY TRANSACTION METHODS
  // ==========================================

  public getOrCreateEvmIntent(params: CreateIntentParams): EvmLogicalIntent {
    const existing = this.getEvmIntentBySwapKey(params.swapKey, params.actionType);
    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    const id = randomUUID();
    const calldataFingerprint = keccak256(params.calldata);
    const valueWei = (params.valueWei ?? 0n).toString();
    const signer = params.signerAddress.toLowerCase() as `0x${string}`;
    const target = params.targetAddress.toLowerCase() as `0x${string}`;

    try {
      const stmt = this.db.prepare(`
        INSERT INTO evm_transaction_intents (
          id, swap_key, action_type, chain_id, signer_address,
          target_contract, calldata_hash, calldata_bytes, value_wei,
          nonce, status, canonical_tx_hash, failure_reason,
          created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          NULL, ?, NULL, NULL,
          ?, ?
        )
      `);
      stmt.run(
        id,
        params.swapKey,
        params.actionType,
        params.chainId,
        signer,
        target,
        calldataFingerprint,
        params.calldata,
        valueWei,
        EvmLogicalIntentState.CREATED,
        now,
        now
      );

      return {
        id,
        swapKey: params.swapKey,
        chainId: params.chainId,
        signerAddress: signer,
        nonce: null,
        actionType: params.actionType,
        targetAddress: target,
        calldataFingerprint,
        valueWei: params.valueWei ?? 0n,
        status: EvmLogicalIntentState.CREATED,
        canonicalTxHash: null,
        failureReason: null,
        createdAt: now,
        updatedAt: now,
      };
    } catch (err) {
      const concurrent = this.getEvmIntentBySwapKey(params.swapKey, params.actionType);
      if (concurrent) {
        return concurrent;
      }
      throw err;
    }
  }

  public getEvmIntentById(id: string): EvmLogicalIntent | null {
    const stmt = this.db.prepare('SELECT * FROM evm_transaction_intents WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapRowToEvmIntent(row);
  }

  public getEvmIntentBySwapKey(
    swapKey: string,
    actionType: 'FUND' | 'REFUND' | 'APPROVE'
  ): EvmLogicalIntent | null {
    const stmt = this.db.prepare(
      'SELECT * FROM evm_transaction_intents WHERE swap_key = ? AND action_type = ?'
    );
    const row = stmt.get(swapKey, actionType) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapRowToEvmIntent(row);
  }

  public getUnresolvedNonceReservation(
    chainId: number,
    signerAddress: string,
    excludeIntentId?: string
  ): EvmLogicalIntent | null {
    const signer = signerAddress.toLowerCase();
    const query = excludeIntentId
      ? `SELECT * FROM evm_transaction_intents
         WHERE chain_id = ? AND signer_address = ? AND nonce IS NOT NULL
           AND id != ?
           AND status NOT IN ('REVERTED', 'FAILED', 'FEE_CAP_BLOCKED')
           AND NOT EXISTS (
             SELECT 1 FROM evm_transaction_attempts
             WHERE intent_id = evm_transaction_intents.id
           )
         ORDER BY nonce ASC
         LIMIT 1`
      : `SELECT * FROM evm_transaction_intents
         WHERE chain_id = ? AND signer_address = ? AND nonce IS NOT NULL
           AND status NOT IN ('REVERTED', 'FAILED', 'FEE_CAP_BLOCKED')
           AND NOT EXISTS (
             SELECT 1 FROM evm_transaction_attempts
             WHERE intent_id = evm_transaction_intents.id
           )
         ORDER BY nonce ASC
         LIMIT 1`;

    const stmt = this.db.prepare(query);
    const row = (excludeIntentId
      ? stmt.get(chainId, signer, excludeIntentId)
      : stmt.get(chainId, signer)) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.mapRowToEvmIntent(row);
  }

  public reserveEvmNonce(
    intentId: string,
    rpcPendingNonce: number,
    options?: { enforceNoUnresolvedReservations?: boolean }
  ): { intent: EvmLogicalIntent; nonce: number } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const intentRow = this.db
        .prepare('SELECT * FROM evm_transaction_intents WHERE id = ?')
        .get(intentId) as Record<string, unknown> | undefined;

      if (!intentRow) {
        throw new Error(`EVM intent ${intentId} not found`);
      }

      if (intentRow.nonce !== null && intentRow.nonce !== undefined) {
        this.db.exec('COMMIT');
        return {
          intent: this.mapRowToEvmIntent(intentRow),
          nonce: Number(intentRow.nonce),
        };
      }

      const chainId = Number(intentRow.chain_id);
      const signerAddress = (intentRow.signer_address as string).toLowerCase();

      if (options?.enforceNoUnresolvedReservations) {
        const unresolved = this.getUnresolvedNonceReservation(chainId, signerAddress, intentId);
        if (unresolved) {
          throw new Error(
            `UNRESOLVED_NONCE_RESERVATION: Intent ${unresolved.id} holds reserved nonce ${unresolved.nonce} with zero physical attempts. Recovery is required before allocating higher nonces.`
          );
        }
      }

      const maxRow = this.db
        .prepare(`
          SELECT MAX(i.nonce) as max_nonce
          FROM evm_transaction_intents i
          WHERE i.chain_id = ? AND i.signer_address = ? AND i.nonce IS NOT NULL
            AND (
              i.status NOT IN ('REVERTED', 'FAILED', 'FEE_CAP_BLOCKED')
              OR EXISTS (
                SELECT 1 FROM evm_transaction_attempts a
                WHERE a.intent_id = i.id
                  AND a.status IN ('BROADCAST', 'MINED_SUCCESS', 'MINED_REVERT', 'SUPERSEDED')
              )
            )
        `)
        .get(chainId, signerAddress) as { max_nonce: number | null } | undefined;

      const highestDbNonce = maxRow && maxRow.max_nonce !== null ? Number(maxRow.max_nonce) : -1;
      const candidateNonce = Math.max(rpcPendingNonce, highestDbNonce + 1);

      const now = new Date().toISOString();
      this.db
        .prepare(
          'UPDATE evm_transaction_intents SET nonce = ?, status = ?, updated_at = ? WHERE id = ?'
        )
        .run(candidateNonce, EvmLogicalIntentState.NONCE_RESERVED, now, intentId);

      const updatedRow = this.db
        .prepare('SELECT * FROM evm_transaction_intents WHERE id = ?')
        .get(intentId) as Record<string, unknown>;

      this.db.exec('COMMIT');
      return {
        intent: this.mapRowToEvmIntent(updatedRow),
        nonce: candidateNonce,
      };
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      throw err;
    }
  }

  public recordEvmAttempt(params: PrepareAttemptParams): EvmPhysicalAttempt {
    const id = randomUUID();
    const now = new Date().toISOString();
    const worstCaseCostWei = (params.gasLimit * params.maxFeePerGas + params.valueWei).toString();
    const calldataFingerprint = keccak256(params.data);
    const signer = params.signerAddress.toLowerCase() as `0x${string}`;
    const to = params.toAddress.toLowerCase() as `0x${string}`;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db
        .prepare(
          'SELECT * FROM evm_transaction_attempts WHERE intent_id = ? AND attempt_number = ?'
        )
        .get(params.intentId, params.attemptNumber) as Record<string, unknown> | undefined;

      if (existing) {
        this.db.exec('COMMIT');
        return this.mapRowToEvmAttempt(existing);
      }

      this.db
        .prepare(`
          INSERT INTO evm_transaction_attempts (
            id, intent_id, attempt_number, chain_id, signer_address,
            nonce, tx_hash, to_address, value_wei, data,
            calldata_hash, gas_limit, max_fee_per_gas_wei,
            max_priority_fee_per_gas_wei, worst_case_cost_wei,
            status, mined_block_number, receipt_status,
            broadcast_at, reconciled_at, error_message, created_at
          ) VALUES (
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?,
            ?, NULL, NULL,
            NULL, NULL, NULL, ?
          )
        `)
        .run(
          id,
          params.intentId,
          params.attemptNumber,
          params.chainId,
          signer,
          params.nonce,
          params.txHash.toLowerCase(),
          to,
          params.valueWei.toString(),
          params.data,
          calldataFingerprint,
          params.gasLimit.toString(),
          params.maxFeePerGas.toString(),
          params.maxPriorityFeePerGas.toString(),
          worstCaseCostWei,
          EvmPhysicalAttemptStatus.PREPARED,
          now
        );

      this.db
        .prepare('UPDATE evm_transaction_intents SET status = ?, updated_at = ? WHERE id = ?')
        .run(EvmLogicalIntentState.DISPATCHING, now, params.intentId);

      const inserted = this.db
        .prepare('SELECT * FROM evm_transaction_attempts WHERE id = ?')
        .get(id) as Record<string, unknown>;

      this.db.exec('COMMIT');
      return this.mapRowToEvmAttempt(inserted);
    } catch (err: any) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      if (err?.message?.includes('UNIQUE constraint failed')) {
        const existing = this.db
          .prepare(
            'SELECT * FROM evm_transaction_attempts WHERE intent_id = ? AND attempt_number = ?'
          )
          .get(params.intentId, params.attemptNumber) as Record<string, unknown> | undefined;
        if (existing) {
          return this.mapRowToEvmAttempt(existing);
        }
      }
      throw err;
    }
  }

  public markEvmAttemptBroadcast(attemptId: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const attemptRow = this.db
        .prepare('SELECT intent_id FROM evm_transaction_attempts WHERE id = ?')
        .get(attemptId) as { intent_id: string } | undefined;

      if (!attemptRow) {
        throw new Error(`EVM attempt ${attemptId} not found`);
      }

      const now = new Date().toISOString();
      this.db
        .prepare('UPDATE evm_transaction_attempts SET status = ?, broadcast_at = ? WHERE id = ?')
        .run(EvmPhysicalAttemptStatus.BROADCAST, now, attemptId);

      this.db
        .prepare(`
          UPDATE evm_transaction_intents
          SET status = ?, updated_at = ?
          WHERE id = ? AND status IN (?, ?, ?)
        `)
        .run(
          EvmLogicalIntentState.PENDING,
          now,
          attemptRow.intent_id,
          EvmLogicalIntentState.CREATED,
          EvmLogicalIntentState.NONCE_RESERVED,
          EvmLogicalIntentState.DISPATCHING
        );

      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      throw err;
    }
  }

  public getEvmAttemptsForIntent(intentId: string): EvmPhysicalAttempt[] {
    const stmt = this.db.prepare(
      'SELECT * FROM evm_transaction_attempts WHERE intent_id = ? ORDER BY attempt_number ASC'
    );
    const rows = stmt.all(intentId) as Record<string, unknown>[];
    return rows.map((r) => this.mapRowToEvmAttempt(r));
  }

  public getLatestEvmAttempt(intentId: string): EvmPhysicalAttempt | null {
    const stmt = this.db.prepare(
      'SELECT * FROM evm_transaction_attempts WHERE intent_id = ? ORDER BY attempt_number DESC LIMIT 1'
    );
    const row = stmt.get(intentId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapRowToEvmAttempt(row);
  }

  public getEvmAttemptByTxHash(txHash: Hex): EvmPhysicalAttempt | null {
    const stmt = this.db.prepare(
      'SELECT * FROM evm_transaction_attempts WHERE tx_hash = ?'
    );
    const row = stmt.get(txHash.toLowerCase()) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapRowToEvmAttempt(row);
  }

  public markEvmMinedSuccess(
    intentId: string,
    winningAttemptId: string,
    txHash: Hex,
    blockNumber: number
  ): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const now = new Date().toISOString();

      this.db
        .prepare(`
          UPDATE evm_transaction_attempts
          SET status = ?, mined_block_number = ?, receipt_status = 1, reconciled_at = ?
          WHERE id = ?
        `)
        .run(EvmPhysicalAttemptStatus.MINED_SUCCESS, blockNumber, now, winningAttemptId);

      this.db
        .prepare(`
          UPDATE evm_transaction_attempts
          SET status = ?, reconciled_at = ?
          WHERE intent_id = ? AND id != ? AND status IN (?, ?)
        `)
        .run(
          EvmPhysicalAttemptStatus.SUPERSEDED,
          now,
          intentId,
          winningAttemptId,
          EvmPhysicalAttemptStatus.BROADCAST,
          EvmPhysicalAttemptStatus.PREPARED
        );

      this.db
        .prepare(`
          UPDATE evm_transaction_intents
          SET status = ?, canonical_tx_hash = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(EvmLogicalIntentState.CONFIRMED, txHash.toLowerCase(), now, intentId);

      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      throw err;
    }
  }

  public markEvmMinedRevert(
    intentId: string,
    attemptId: string,
    blockNumber: number,
    errorMessage?: string
  ): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const now = new Date().toISOString();

      this.db
        .prepare(`
          UPDATE evm_transaction_attempts
          SET status = ?, mined_block_number = ?, receipt_status = 0, reconciled_at = ?, error_message = ?
          WHERE id = ?
        `)
        .run(
          EvmPhysicalAttemptStatus.MINED_REVERT,
          blockNumber,
          now,
          errorMessage ?? 'Transaction reverted on-chain',
          attemptId
        );

      this.db
        .prepare(`
          UPDATE evm_transaction_intents
          SET status = ?, failure_reason = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(
          EvmLogicalIntentState.REVERTED,
          errorMessage ?? 'Transaction reverted on-chain',
          now,
          intentId
        );

      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      throw err;
    }
  }

  public markEvmFeeCapBlocked(intentId: string, reason: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const broadcastAttempt = this.db
        .prepare(`
          SELECT 1 FROM evm_transaction_attempts
          WHERE intent_id = ? AND status IN ('BROADCAST', 'MINED_SUCCESS', 'MINED_REVERT', 'SUPERSEDED')
          LIMIT 1
        `)
        .get(intentId);

      const now = new Date().toISOString();
      if (!broadcastAttempt) {
        this.db
          .prepare(`
            UPDATE evm_transaction_intents
            SET status = ?, failure_reason = ?, nonce = NULL, updated_at = ?
            WHERE id = ?
          `)
          .run(EvmLogicalIntentState.FEE_CAP_BLOCKED, reason, now, intentId);
      } else {
        this.db
          .prepare(`
            UPDATE evm_transaction_intents
            SET status = ?, failure_reason = ?, updated_at = ?
            WHERE id = ?
          `)
          .run(EvmLogicalIntentState.FEE_CAP_BLOCKED, reason, now, intentId);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      throw err;
    }
  }

  public markEvmNonceConflict(intentId: string, reason: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`
        UPDATE evm_transaction_intents
        SET status = ?, failure_reason = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(EvmLogicalIntentState.NONCE_CONFLICT, reason, now, intentId);
  }

  public markEvmIntentFailed(intentId: string, reason: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const broadcastAttempt = this.db
        .prepare(`
          SELECT 1 FROM evm_transaction_attempts
          WHERE intent_id = ? AND status IN ('BROADCAST', 'MINED_SUCCESS', 'MINED_REVERT', 'SUPERSEDED')
          LIMIT 1
        `)
        .get(intentId);

      const now = new Date().toISOString();
      if (!broadcastAttempt) {
        this.db
          .prepare(`
            UPDATE evm_transaction_intents
            SET status = ?, failure_reason = ?, nonce = NULL, updated_at = ?
            WHERE id = ?
          `)
          .run(EvmLogicalIntentState.FAILED, reason, now, intentId);
      } else {
        this.db
          .prepare(`
            UPDATE evm_transaction_intents
            SET status = ?, failure_reason = ?, updated_at = ?
            WHERE id = ?
          `)
          .run(EvmLogicalIntentState.FAILED, reason, now, intentId);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      throw err;
    }
  }

  public markEvmSimulationReverted(intentId: string, reason: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const broadcastAttempt = this.db
        .prepare(`
          SELECT 1 FROM evm_transaction_attempts
          WHERE intent_id = ? AND status IN ('BROADCAST', 'MINED_SUCCESS', 'MINED_REVERT', 'SUPERSEDED')
          LIMIT 1
        `)
        .get(intentId);

      const now = new Date().toISOString();
      if (!broadcastAttempt) {
        this.db
          .prepare(`
            UPDATE evm_transaction_intents
            SET status = ?, failure_reason = ?, nonce = NULL, updated_at = ?
            WHERE id = ?
          `)
          .run(EvmLogicalIntentState.REVERTED, reason, now, intentId);
      } else {
        this.db
          .prepare(`
            UPDATE evm_transaction_intents
            SET status = ?, failure_reason = ?, updated_at = ?
            WHERE id = ?
          `)
          .run(EvmLogicalIntentState.REVERTED, reason, now, intentId);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      throw err;
    }
  }

  public getActiveEvmIntents(chainId?: number): EvmLogicalIntent[] {
    const query =
      chainId !== undefined
        ? 'SELECT * FROM evm_transaction_intents WHERE chain_id = ? AND status IN (?, ?, ?, ?) ORDER BY created_at ASC'
        : 'SELECT * FROM evm_transaction_intents WHERE status IN (?, ?, ?, ?) ORDER BY created_at ASC';
    const params =
      chainId !== undefined
        ? [
            chainId,
            EvmLogicalIntentState.CREATED,
            EvmLogicalIntentState.NONCE_RESERVED,
            EvmLogicalIntentState.DISPATCHING,
            EvmLogicalIntentState.PENDING,
          ]
        : [
            EvmLogicalIntentState.CREATED,
            EvmLogicalIntentState.NONCE_RESERVED,
            EvmLogicalIntentState.DISPATCHING,
            EvmLogicalIntentState.PENDING,
          ];
    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.mapRowToEvmIntent(r));
  }

  private mapRowToEvmIntent(row: Record<string, unknown>): EvmLogicalIntent {
    return {
      id: row.id as string,
      swapKey: row.swap_key as string,
      chainId: Number(row.chain_id),
      signerAddress: row.signer_address as `0x${string}`,
      nonce: row.nonce !== null && row.nonce !== undefined ? Number(row.nonce) : null,
      actionType: row.action_type as 'FUND' | 'REFUND' | 'APPROVE',
      targetAddress: row.target_contract as `0x${string}`,
      calldataFingerprint: row.calldata_hash as Hex,
      calldata: (row.calldata_bytes as Hex) || undefined,
      valueWei: BigInt(row.value_wei as string),
      status: row.status as EvmLogicalIntentState,
      canonicalTxHash: (row.canonical_tx_hash as Hex) || null,
      failureReason: (row.failure_reason as string) || null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  private mapRowToEvmAttempt(row: Record<string, unknown>): EvmPhysicalAttempt {
    return {
      id: row.id as string,
      intentId: row.intent_id as string,
      attemptNumber: Number(row.attempt_number),
      chainId: Number(row.chain_id),
      signerAddress: row.signer_address as `0x${string}`,
      nonce: Number(row.nonce),
      txHash: row.tx_hash as Hex,
      toAddress: row.to_address as `0x${string}`,
      valueWei: BigInt(row.value_wei as string),
      data: row.data as Hex,
      calldataFingerprint: row.calldata_hash as Hex,
      gasLimit: BigInt(row.gas_limit as string),
      maxFeePerGas: BigInt(row.max_fee_per_gas_wei as string),
      maxPriorityFeePerGas: BigInt(row.max_priority_fee_per_gas_wei as string),
      status: row.status as EvmPhysicalAttemptStatus,
      minedBlockNumber:
        row.mined_block_number !== null && row.mined_block_number !== undefined
          ? Number(row.mined_block_number)
          : null,
      receiptStatus:
        row.receipt_status !== null && row.receipt_status !== undefined
          ? Number(row.receipt_status)
          : null,
      broadcastAt: (row.broadcast_at as string) || '',
      reconciledAt: (row.reconciled_at as string) || null,
      errorMessage: (row.error_message as string) || null,
      createdAt: row.created_at as string,
    };
  }

  private mapRowToExecution(row: Record<string, unknown>): ExecutionRecord {
    return {
      id: row.id as string,
      idempotencyKey: row.idempotency_key as string,
      state: row.state as ExecutionState,
      intent: JSON.parse(row.intent_json as string) as NormalizedIntent,
      selectedQuote: row.quote_json
        ? (JSON.parse(row.quote_json as string) as NormalizedQuote)
        : null,
      plan: row.execution_plan_json
        ? (JSON.parse(row.execution_plan_json as string) as ExecutionPlan)
        : null,
      providerId: (row.provider_id as string) || null,
      providerExecutionId: (row.provider_execution_id as string) || null,
      orderToken: (row.order_token as string) || null,
      depositAddress: (row.deposit_address as string) || null,
      sourceEvidence: row.source_evidence_json
        ? (JSON.parse(row.source_evidence_json as string) as SourceSettlementEvidence)
        : null,
      destinationEvidence: row.destination_evidence_json
        ? (JSON.parse(row.destination_evidence_json as string) as DestinationSettlementEvidence)
        : null,
      sourceFundsMoved: Number(row.source_funds_moved || 0) === 1,
      destinationFundsArrived: Number(row.destination_funds_arrived || 0) === 1,
      failureReason: (row.failure_reason as string) || null,
      recoveryAttempts: Number(row.recovery_attempts || 0),
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  // =========================================================================
  // SOVEREIGN ATOMIC COORDINATOR PERSISTENCE (PHASE 5B)
  // =========================================================================

  public createSovereignSwap(
    record: SovereignExecutionRecord,
    fingerprint: string
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO sovereign_swaps (
        id, idempotency_key, hash_lock, payment_hash, state,
        reservation_id, reserved_amount_units, reservation_status,
        amount_sats, expected_usdc_amount, claiming_address, target_destination_address,
        token_address, refund_address, cltv_expiry_blocks, timelock_seconds, refund_locktime,
        economic_fingerprint, bolt11, lightning_invoice_state, lightning_held_at,
        lightning_settled_at, lightning_canceled_at, lightning_expiry_height, evm_swap_key, evm_htlc_id,
        evm_funding_tx_hash, evm_claim_tx_hash, evm_refund_tx_hash, destination_tx_hash,
        action_in_flight, action_claimed_by, action_claimed_at, recovery_required,
        failure_reason, retry_count, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?
      )
    `);

    const nowIso = record.createdAt.toISOString();
    const updatedIso = record.updatedAt.toISOString();

    stmt.run(
      record.id,
      record.idempotencyKey,
      record.hashLock.toLowerCase(),
      (record.holdInvoice?.paymentHash ?? record.hashLock.replace(/^0x/, '')).toLowerCase(),
      record.state,
      record.reservationId ?? null,
      record.reservedAmountUnits !== undefined ? record.reservedAmountUnits.toString() : null,
      record.reservationStatus ?? null,
      record.amountSats.toString(),
      record.expectedUsdcAmount.toString(),
      record.claimingAddress.toLowerCase(),
      record.targetDestinationAddress.toLowerCase(),
      (record.tokenAddress ?? '').toLowerCase(),
      (record.refundAddress ?? '').toLowerCase(),
      record.cltvExpiryBlocks ?? 144,
      record.timelockSeconds ?? 43200,
      record.refundLocktime ?? null,
      fingerprint,
      record.holdInvoice?.bolt11 ?? null,
      record.holdInvoice?.state ?? null,
      record.holdInvoice?.acceptedAt?.toISOString() ?? null,
      record.holdInvoice?.settledAt?.toISOString() ?? null,
      record.holdInvoice?.canceledAt?.toISOString() ?? null,
      record.holdInvoice?.expiryHeight ?? null,
      record.evmSwapKey ?? null,
      record.evmHtlcId ?? null,
      record.evmFundingTxHash ?? null,
      record.evmClaimTxHash ?? null,
      record.evmRefundTxHash ?? null,
      record.destinationTxHash ?? null,
      record.actionInFlight ?? null,
      record.actionClaimedBy ?? null,
      record.actionClaimedAt?.toISOString() ?? null,
      record.recoveryRequired ? 1 : 0,
      record.failureReason ?? null,
      record.retryCount ?? 0,
      nowIso,
      updatedIso
    );

    this.recordSovereignTransition(
      record.id,
      undefined,
      record.state,
      'INITIAL_CREATION',
      undefined,
      JSON.stringify({ idempotencyKey: record.idempotencyKey, fingerprint })
    );
  }

  public getSovereignSwap(id: string): SovereignExecutionRecord | null {
    const stmt = this.db.prepare('SELECT * FROM sovereign_swaps WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRowToSovereignRecord(row) : null;
  }

  public getSovereignSwapByIdempotencyKey(key: string): SovereignExecutionRecord | null {
    const stmt = this.db.prepare('SELECT * FROM sovereign_swaps WHERE idempotency_key = ?');
    const row = stmt.get(key) as Record<string, unknown> | undefined;
    return row ? this.mapRowToSovereignRecord(row) : null;
  }

  public getSovereignSwapByPaymentHash(paymentHash: string): SovereignExecutionRecord | null {
    const clean = paymentHash.replace(/^0x/, '').toLowerCase();
    const stmt = this.db.prepare('SELECT * FROM sovereign_swaps WHERE payment_hash = ?');
    const row = stmt.get(clean) as Record<string, unknown> | undefined;
    return row ? this.mapRowToSovereignRecord(row) : null;
  }

  public listNonTerminalSovereignSwaps(): SovereignExecutionRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM sovereign_swaps
      WHERE state NOT IN ('COMPLETED', 'REFUNDED', 'INVOICE_CANCELED', 'EXPIRED')
      ORDER BY created_at ASC
    `);
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map((r) => this.mapRowToSovereignRecord(r));
  }

  public updateSovereignSwap(
    id: string,
    updates: Partial<SovereignExecutionRecord>,
    transition?: { reason: string; evidenceId?: string; metadataJson?: string }
  ): SovereignExecutionRecord {
    const existing = this.getSovereignSwap(id);
    if (!existing) {
      throw new Error(`Sovereign swap ${id} not found for update`);
    }

    const now = new Date();
    const updatedRecord: SovereignExecutionRecord = {
      ...existing,
      ...updates,
      updatedAt: now,
    };

    if (updates.holdInvoice) {
      updatedRecord.holdInvoice = {
        ...existing.holdInvoice!,
        ...updates.holdInvoice,
      };
    }

    const setClauses: string[] = ['updated_at = ?'];
    const values: any[] = [now.toISOString()];

    if (updates.state !== undefined) {
      setClauses.push('state = ?');
      values.push(updates.state);
    }
    if (updates.reservationId !== undefined) {
      setClauses.push('reservation_id = ?');
      values.push(updates.reservationId);
    }
    if (updates.reservedAmountUnits !== undefined) {
      setClauses.push('reserved_amount_units = ?');
      values.push(updates.reservedAmountUnits.toString());
    }
    if (updates.reservationStatus !== undefined) {
      setClauses.push('reservation_status = ?');
      values.push(updates.reservationStatus);
    }
    if (updates.holdInvoice?.bolt11 !== undefined) {
      setClauses.push('bolt11 = ?');
      values.push(updates.holdInvoice.bolt11);
    }
    if (updates.holdInvoice?.state !== undefined) {
      setClauses.push('lightning_invoice_state = ?');
      values.push(updates.holdInvoice.state);
    }
    if (updates.holdInvoice?.acceptedAt !== undefined) {
      setClauses.push('lightning_held_at = ?');
      values.push(updates.holdInvoice.acceptedAt?.toISOString() ?? null);
    }
    if (updates.holdInvoice?.settledAt !== undefined) {
      setClauses.push('lightning_settled_at = ?');
      values.push(updates.holdInvoice.settledAt?.toISOString() ?? null);
    }
    if (updates.holdInvoice?.canceledAt !== undefined) {
      setClauses.push('lightning_canceled_at = ?');
      values.push(updates.holdInvoice.canceledAt?.toISOString() ?? null);
    }
    if (updates.holdInvoice?.expiryHeight !== undefined) {
      setClauses.push('lightning_expiry_height = ?');
      values.push(updates.holdInvoice.expiryHeight ?? null);
    }
    if (updates.evmSwapKey !== undefined) {
      setClauses.push('evm_swap_key = ?');
      values.push(updates.evmSwapKey);
    }
    if (updates.evmHtlcId !== undefined) {
      setClauses.push('evm_htlc_id = ?');
      values.push(updates.evmHtlcId);
    }
    if (updates.evmFundingTxHash !== undefined) {
      setClauses.push('evm_funding_tx_hash = ?');
      values.push(updates.evmFundingTxHash);
    }
    if (updates.evmClaimTxHash !== undefined) {
      setClauses.push('evm_claim_tx_hash = ?');
      values.push(updates.evmClaimTxHash);
    }
    if (updates.evmRefundTxHash !== undefined) {
      setClauses.push('evm_refund_tx_hash = ?');
      values.push(updates.evmRefundTxHash);
    }
    if (updates.destinationTxHash !== undefined) {
      setClauses.push('destination_tx_hash = ?');
      values.push(updates.destinationTxHash);
    }
    if (updates.refundLocktime !== undefined) {
      setClauses.push('refund_locktime = ?');
      values.push(updates.refundLocktime);
    }
    if ('actionInFlight' in updates) {
      setClauses.push('action_in_flight = ?');
      values.push(updates.actionInFlight ?? null);
    }
    if ('actionClaimedBy' in updates) {
      setClauses.push('action_claimed_by = ?');
      values.push(updates.actionClaimedBy ?? null);
    }
    if ('actionClaimedAt' in updates) {
      setClauses.push('action_claimed_at = ?');
      values.push(updates.actionClaimedAt?.toISOString() ?? null);
    }
    if (updates.recoveryRequired !== undefined) {
      setClauses.push('recovery_required = ?');
      values.push(updates.recoveryRequired ? 1 : 0);
    }
    if (updates.failureReason !== undefined) {
      setClauses.push('failure_reason = ?');
      values.push(updates.failureReason);
    }
    if (updates.retryCount !== undefined) {
      setClauses.push('retry_count = ?');
      values.push(updates.retryCount);
    }

    values.push(id);
    const sql = `UPDATE sovereign_swaps SET ${setClauses.join(', ')} WHERE id = ?`;
    this.db.prepare(sql).run(...values);

    if (transition && updates.state && updates.state !== existing.state) {
      this.recordSovereignTransition(
        id,
        existing.state,
        updates.state,
        transition.reason,
        transition.evidenceId,
        transition.metadataJson
      );
    }

    return updatedRecord;
  }

  public claimSovereignAction(
    id: string,
    action: string,
    workerId: string,
    leaseMs: number = 60000
  ): boolean {
    const now = new Date();
    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();

    const stmt = this.db.prepare(`
      UPDATE sovereign_swaps
      SET action_in_flight = ?,
          action_claimed_by = ?,
          action_claimed_at = ?,
          action_lease_expires_at = ?,
          action_generation = action_generation + 1,
          updated_at = ?
      WHERE id = ?
        AND (
          action_in_flight IS NULL
          OR action_claimed_by = ?
          OR action_lease_expires_at < ?
        )
    `);

    const result = stmt.run(action, workerId, nowIso, leaseExpiresAt, nowIso, id, workerId, nowIso);
    return result.changes === 1;
  }

  public releaseSovereignAction(id: string, workerId?: string): void {
    const nowIso = new Date().toISOString();
    let sql = `
      UPDATE sovereign_swaps
      SET action_in_flight = NULL,
          action_claimed_by = NULL,
          action_claimed_at = NULL,
          action_lease_expires_at = NULL,
          updated_at = ?
      WHERE id = ?
    `;
    const params: any[] = [nowIso, id];
    if (workerId) {
      sql += ' AND action_claimed_by = ?';
      params.push(workerId);
    }
    this.db.prepare(sql).run(...params);
  }

  public recordSovereignTransition(
    swapId: string,
    fromState: SovereignAtomicState | undefined,
    toState: SovereignAtomicState,
    reason: string,
    evidenceId?: string,
    metadataJson?: string
  ): void {
    const id = randomUUID();
    const stmt = this.db.prepare(`
      INSERT INTO sovereign_swap_transitions (
        id, swap_id, from_state, to_state, reason, evidence_id, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      swapId,
      fromState ?? null,
      toState,
      reason,
      evidenceId ?? null,
      metadataJson ?? null,
      new Date().toISOString()
    );
  }

  public getSovereignTransitions(swapId: string): SovereignSwapTransition[] {
    const stmt = this.db.prepare(`
      SELECT * FROM sovereign_swap_transitions
      WHERE swap_id = ?
      ORDER BY created_at ASC
    `);
    const rows = stmt.all(swapId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      swapId: r.swap_id as string,
      fromState: (r.from_state as SovereignAtomicState) || undefined,
      toState: r.to_state as SovereignAtomicState,
      reason: r.reason as string,
      evidenceId: (r.evidence_id as string) || undefined,
      metadataJson: (r.metadata_json as string) || undefined,
      createdAt: new Date(r.created_at as string),
    }));
  }

  private mapRowToSovereignRecord(row: Record<string, unknown>): SovereignExecutionRecord {
    let holdInvoice: HoldInvoice | undefined;
    if (row.bolt11) {
      holdInvoice = {
        paymentHash: (row.payment_hash as string) || (row.hash_lock as string).replace(/^0x/, ''),
        bolt11: row.bolt11 as string,
        amountSats: BigInt(row.amount_sats as string),
        cltvExpiryBlocks: Number(row.cltv_expiry_blocks || 144),
        expiryHeight: row.lightning_expiry_height ? Number(row.lightning_expiry_height) : undefined,
        state: (row.lightning_invoice_state as any) || 'OPEN',
        createdAt: new Date(row.created_at as string),
        acceptedAt: row.lightning_held_at ? new Date(row.lightning_held_at as string) : undefined,
        settledAt: row.lightning_settled_at ? new Date(row.lightning_settled_at as string) : undefined,
        canceledAt: row.lightning_canceled_at ? new Date(row.lightning_canceled_at as string) : undefined,
      };
    }

    return {
      id: row.id as string,
      idempotencyKey: row.idempotency_key as string,
      hashLock: row.hash_lock as string,
      claimingAddress: row.claiming_address as string,
      targetDestinationAddress: row.target_destination_address as string,
      amountSats: BigInt(row.amount_sats as string),
      expectedUsdcAmount: BigInt(row.expected_usdc_amount as string),
      state: row.state as SovereignAtomicState,
      reservationId: (row.reservation_id as string) || undefined,
      reservedAmountUnits: row.reserved_amount_units ? BigInt(row.reserved_amount_units as string) : undefined,
      reservationStatus: (row.reservation_status as LiquidityReservationStatus) || undefined,
      holdInvoice,
      evmSwapKey: (row.evm_swap_key as string) || undefined,
      evmHtlcId: (row.evm_htlc_id as string) || undefined,
      evmFundingTxHash: (row.evm_funding_tx_hash as string) || undefined,
      evmClaimTxHash: (row.evm_claim_tx_hash as string) || undefined,
      evmRefundTxHash: (row.evm_refund_tx_hash as string) || undefined,
      destinationTxHash: (row.destination_tx_hash as string) || undefined,
      tokenAddress: (row.token_address as string) || undefined,
      refundAddress: (row.refund_address as string) || undefined,
      cltvExpiryBlocks: row.cltv_expiry_blocks ? Number(row.cltv_expiry_blocks) : undefined,
      timelockSeconds: row.timelock_seconds ? Number(row.timelock_seconds) : undefined,
      refundLocktime: row.refund_locktime ? Number(row.refund_locktime) : undefined,
      economicFingerprint: (row.economic_fingerprint as string) || undefined,
      actionInFlight: (row.action_in_flight as string) || undefined,
      actionClaimedBy: (row.action_claimed_by as string) || undefined,
      actionClaimedAt: row.action_claimed_at ? new Date(row.action_claimed_at as string) : undefined,
      actionGeneration: row.action_generation !== undefined && row.action_generation !== null ? Number(row.action_generation) : undefined,
      recoveryRequired: Number(row.recovery_required || 0) === 1,
      failureReason: (row.failure_reason as string) || undefined,
      retryCount: Number(row.retry_count || 0),
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }

  // =========================================================================
  // DURABLE LIQUIDITY INVENTORY PERSISTENCE (PHASE LIQUIDITY ACCOUNTING SAFETY)
  // =========================================================================

  public setConfirmedOperatorBalance(tokenAddress: string, balance: bigint): void {
    const token = tokenAddress.toLowerCase();
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO operator_inventory (token_address, confirmed_balance, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(token_address) DO UPDATE SET
        confirmed_balance = excluded.confirmed_balance,
        updated_at = excluded.updated_at
    `);
    stmt.run(token, balance.toString(), now);
  }

  public getConfirmedOperatorBalance(tokenAddress: string): bigint {
    const token = tokenAddress.toLowerCase();
    const row = this.db
      .prepare('SELECT confirmed_balance FROM operator_inventory WHERE token_address = ?')
      .get(token) as { confirmed_balance: string } | undefined;
    return row ? BigInt(row.confirmed_balance) : 0n;
  }

  public getReservedOperatorBalance(tokenAddress: string): bigint {
    const token = tokenAddress.toLowerCase();
    const rows = this.db
      .prepare('SELECT amount_units FROM liquidity_reservations WHERE token_address = ? AND status = ?')
      .all(token, 'RESERVED') as { amount_units: string }[];
    let sum = 0n;
    for (const r of rows) {
      sum += BigInt(r.amount_units);
    }
    return sum;
  }

  public getCommittedOperatorBalance(tokenAddress: string): bigint {
    const token = tokenAddress.toLowerCase();
    const rows = this.db
      .prepare('SELECT amount_units FROM liquidity_reservations WHERE token_address = ? AND status = ?')
      .all(token, 'COMMITTED') as { amount_units: string }[];
    let sum = 0n;
    for (const r of rows) {
      sum += BigInt(r.amount_units);
    }
    return sum;
  }

  public getAvailableOperatorBalance(tokenAddress: string): bigint {
    const confirmed = this.getConfirmedOperatorBalance(tokenAddress);
    const reserved = this.getReservedOperatorBalance(tokenAddress);
    const committed = this.getCommittedOperatorBalance(tokenAddress);
    const available = confirmed - reserved - committed;
    return available > 0n ? available : 0n;
  }

  public reserveLiquidity(
    executionId: string,
    tokenAddress: string,
    amountUnits: bigint
  ): { reservationId: string; reserved: boolean } {
    if (amountUnits <= 0n) {
      throw new Error(
        `RESERVE_INVALID_AMOUNT: Reservation amount must be strictly positive integer units, got ${amountUnits}`
      );
    }
    const token = tokenAddress.toLowerCase();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // 1. Idempotency check: if this execution already owns an active or committed reservation, return it
      const existing = this.db
        .prepare('SELECT * FROM liquidity_reservations WHERE execution_id = ?')
        .get(executionId) as Record<string, unknown> | undefined;
      if (existing) {
        const status = existing.status as string;
        if (status === 'RESERVED' || status === 'COMMITTED') {
          this.db.exec('COMMIT');
          return {
            reservationId: existing.id as string,
            reserved: true,
          };
        }
      }

      // 2. Compute available balance: CONFIRMED - ACTIVE_RESERVED - COMMITTED
      const confirmedRow = this.db
        .prepare('SELECT confirmed_balance FROM operator_inventory WHERE token_address = ?')
        .get(token) as { confirmed_balance: string } | undefined;
      const confirmed = confirmedRow ? BigInt(confirmedRow.confirmed_balance) : 0n;

      const reservedRows = this.db
        .prepare('SELECT amount_units FROM liquidity_reservations WHERE token_address = ? AND status = ?')
        .all(token, 'RESERVED') as { amount_units: string }[];
      let activeReserved = 0n;
      for (const r of reservedRows) {
        activeReserved += BigInt(r.amount_units);
      }

      const committedRows = this.db
        .prepare('SELECT amount_units FROM liquidity_reservations WHERE token_address = ? AND status = ?')
        .all(token, 'COMMITTED') as { amount_units: string }[];
      let committed = 0n;
      for (const r of committedRows) {
        committed += BigInt(r.amount_units);
      }

      const available = confirmed - activeReserved - committed;

      if (available < amountUnits) {
        this.db.exec('COMMIT');
        return {
          reservationId: '',
          reserved: false,
        };
      }

      const reservationId = randomUUID();
      const now = new Date().toISOString();
      this.db
        .prepare(`
          INSERT INTO liquidity_reservations (id, execution_id, token_address, amount_units, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'RESERVED', ?, ?)
        `)
        .run(reservationId, executionId, token, amountUnits.toString(), now, now);

      this.db.exec('COMMIT');
      return {
        reservationId,
        reserved: true,
      };
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      throw err;
    }
  }

  public commitLiquidityReservation(reservationId: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db
        .prepare('SELECT status FROM liquidity_reservations WHERE id = ?')
        .get(reservationId) as { status: string } | undefined;
      if (row && row.status === 'RESERVED') {
        const now = new Date().toISOString();
        this.db
          .prepare('UPDATE liquidity_reservations SET status = ?, updated_at = ? WHERE id = ?')
          .run('COMMITTED', now, reservationId);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      throw err;
    }
  }

  public releaseLiquidityReservation(reservationId: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db
        .prepare('SELECT status FROM liquidity_reservations WHERE id = ?')
        .get(reservationId) as { status: string } | undefined;
      if (row && row.status === 'RESERVED') {
        const now = new Date().toISOString();
        this.db
          .prepare('UPDATE liquidity_reservations SET status = ?, updated_at = ? WHERE id = ?')
          .run('RELEASED', now, reservationId);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      throw err;
    }
  }

  public restoreRefundLiquidityReservation(reservationId: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db
        .prepare('SELECT status FROM liquidity_reservations WHERE id = ?')
        .get(reservationId) as { status: string } | undefined;
      if (row && row.status === 'COMMITTED') {
        const now = new Date().toISOString();
        this.db
          .prepare('UPDATE liquidity_reservations SET status = ?, updated_at = ? WHERE id = ?')
          .run('RELEASED', now, reservationId);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      throw err;
    }
  }

  public getLiquidityReservation(reservationId: string): LiquidityReservationRecord | null {
    const row = this.db
      .prepare('SELECT * FROM liquidity_reservations WHERE id = ?')
      .get(reservationId) as Record<string, unknown> | undefined;
    return row ? this.mapRowToLiquidityReservation(row) : null;
  }

  public getLiquidityReservationByExecutionId(executionId: string): LiquidityReservationRecord | null {
    const row = this.db
      .prepare('SELECT * FROM liquidity_reservations WHERE execution_id = ?')
      .get(executionId) as Record<string, unknown> | undefined;
    return row ? this.mapRowToLiquidityReservation(row) : null;
  }

  public listLiquidityReservations(tokenAddress?: string): LiquidityReservationRecord[] {
    let rows: Record<string, unknown>[];
    if (tokenAddress) {
      rows = this.db
        .prepare('SELECT * FROM liquidity_reservations WHERE token_address = ? ORDER BY created_at ASC')
        .all(tokenAddress.toLowerCase()) as Record<string, unknown>[];
    } else {
      rows = this.db
        .prepare('SELECT * FROM liquidity_reservations ORDER BY created_at ASC')
        .all() as Record<string, unknown>[];
    }
    return rows.map((r) => this.mapRowToLiquidityReservation(r));
  }

  private mapRowToLiquidityReservation(row: Record<string, unknown>): LiquidityReservationRecord {
    return {
      id: row.id as string,
      executionId: row.execution_id as string,
      tokenAddress: row.token_address as string,
      amountUnits: BigInt(row.amount_units as string),
      status: row.status as LiquidityReservationStatus,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }
}
