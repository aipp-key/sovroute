/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Gasless Nonce & Replay Manager (Durable SQLite Persistence)
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { HexAddress, HexSignature } from './types.ts';
import {
  InvalidNonceError,
  QuoteAlreadyConsumedError,
  InvalidSignatureError,
} from './errors.ts';

export interface NonceManagerOptions {
  dbPath?: string;
  existingDb?: DatabaseSync;
}

export class NonceManager {
  private readonly db: DatabaseSync;

  constructor(options: NonceManagerOptions = {}) {
    if (options.existingDb) {
      this.db = options.existingDb;
    } else if (options.dbPath) {
      this.db = new DatabaseSync(options.dbPath);
    } else {
      this.db = new DatabaseSync(':memory:');
    }

    this.initializeSchema();
  }

  private initializeSchema(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS swapper_nonces (
        swapper_address TEXT PRIMARY KEY,
        current_nonce INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS consumed_quotes (
        quote_id TEXT PRIMARY KEY,
        swapper_address TEXT NOT NULL,
        nonce INTEGER NOT NULL,
        consumed_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS consumed_signatures (
        signature_hash TEXT PRIMARY KEY,
        consumed_at INTEGER NOT NULL
      );
    `);
  }

  public getNextNonce(swapper: HexAddress): bigint {
    const norm = swapper.toLowerCase();
    const row = this.db
      .prepare('SELECT current_nonce FROM swapper_nonces WHERE swapper_address = ?')
      .get(norm) as { current_nonce: number | bigint } | undefined;

    if (!row) {
      return 0n;
    }
    return BigInt(row.current_nonce) + 1n;
  }

  public isQuoteConsumed(quoteId: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM consumed_quotes WHERE quote_id = ?')
      .get(quoteId);
    return !!row;
  }

  public verifyAndConsume(
    swapper: HexAddress,
    nonce: bigint,
    quoteId: string,
    signature: HexSignature,
    nowMs = Date.now()
  ): void {
    const norm = swapper.toLowerCase();
    const sigHash = createHash('sha256').update(signature.toLowerCase()).digest('hex');

    this.db.exec('BEGIN IMMEDIATE');
    try {
      // 1. Check quote single-use
      const quoteRow = this.db
        .prepare('SELECT 1 FROM consumed_quotes WHERE quote_id = ?')
        .get(quoteId);
      if (quoteRow) {
        throw new QuoteAlreadyConsumedError(quoteId);
      }

      // 2. Check signature single-use
      const sigRow = this.db
        .prepare('SELECT 1 FROM consumed_signatures WHERE signature_hash = ?')
        .get(sigHash);
      if (sigRow) {
        throw new InvalidSignatureError('Signature has already been used.');
      }

      // 3. Check nonce
      const nonceRow = this.db
        .prepare('SELECT current_nonce FROM swapper_nonces WHERE swapper_address = ?')
        .get(norm) as { current_nonce: number | bigint } | undefined;

      const expectedNonce = nonceRow ? BigInt(nonceRow.current_nonce) + 1n : 0n;
      if (nonce !== expectedNonce) {
        throw new InvalidNonceError(expectedNonce, nonce);
      }

      // 4. Update swapper_nonces
      if (nonceRow) {
        this.db
          .prepare('UPDATE swapper_nonces SET current_nonce = ?, updated_at = ? WHERE swapper_address = ?')
          .run(Number(nonce), nowMs, norm);
      } else {
        this.db
          .prepare('INSERT INTO swapper_nonces (swapper_address, current_nonce, updated_at) VALUES (?, ?, ?)')
          .run(norm, Number(nonce), nowMs);
      }

      // 5. Record consumed quote and signature
      this.db
        .prepare('INSERT INTO consumed_quotes (quote_id, swapper_address, nonce, consumed_at) VALUES (?, ?, ?, ?)')
        .run(quoteId, norm, Number(nonce), nowMs);

      this.db
        .prepare('INSERT INTO consumed_signatures (signature_hash, consumed_at) VALUES (?, ?)')
        .run(sigHash, nowMs);

      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Rollback failed if transaction was already aborted
      }
      throw err;
    }
  }
}
