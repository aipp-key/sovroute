import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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
}
