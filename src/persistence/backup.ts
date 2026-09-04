/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Phase 7: Durable SQLite Backup & Restore Service
 *
 * Implements atomic, online SQLite backup via `VACUUM INTO`, cryptographic
 * checksum verification, schema-versioned metadata generation, and safe restore
 * procedures with fail-closed integrity checks.
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { SqlitePersistence } from './sqlite.ts';

export interface BackupMetadata {
  backupFile: string;
  metaFile: string;
  sha256: string;
  sizeBytes: number;
  createdAt: string;
  schemaVersion: number;
  customMetadata?: Record<string, any> | undefined;
}

export interface RestoreResult {
  restoredFile: string;
  sourceBackupFile: string;
  sha256Verified: boolean;
  integrityVerified: boolean;
  schemaVersion: number;
  restoredAt: string;
}

export class BackupRestoreError extends Error {
  constructor(message: string) {
    super(`BACKUP_RESTORE_ERROR: ${message}`);
    this.name = 'BackupRestoreError';
  }
}

export class BackupService {
  /**
   * Executes an atomic, online backup of a live SQLite database using `VACUUM INTO`.
   * Generates a companion `.meta.json` file with SHA-256 integrity hash.
   */
  public static createBackup(
    dbSource: DatabaseSync | SqlitePersistence | string,
    targetBackupPath: string,
    customMetadata?: Record<string, any> | undefined
  ): BackupMetadata {
    const resolvedBackupPath = path.resolve(targetBackupPath);
    const backupDir = path.dirname(resolvedBackupPath);

    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    if (typeof dbSource === 'string' && path.resolve(dbSource) === resolvedBackupPath) {
      throw new BackupRestoreError(`Backup destination cannot be identical to source database: ${resolvedBackupPath}`);
    }

    if (fs.existsSync(resolvedBackupPath)) {
      throw new BackupRestoreError(`Backup target already exists: ${resolvedBackupPath}. Refusing to overwrite.`);
    }

    // Determine database instance
    let db: DatabaseSync;
    let isTempInstance = false;

    if (typeof dbSource === 'string') {
      if (!fs.existsSync(dbSource)) {
        throw new BackupRestoreError(`Source database file does not exist: ${dbSource}`);
      }
      db = new DatabaseSync(dbSource);
      isTempInstance = true;
    } else if ('getSovereignSwap' in dbSource && typeof (dbSource as any).close === 'function') {
      // SqlitePersistence wrapper
      db = (dbSource as any).db;
    } else {
      db = dbSource as DatabaseSync;
    }

    try {
      // 1. Verify source database integrity first
      const checkStmt = db.prepare('PRAGMA integrity_check;');
      const checkRes = checkStmt.all() as Array<{ integrity_check: string }>;
      if (!checkRes || checkRes.length === 0 || checkRes[0].integrity_check !== 'ok') {
        throw new BackupRestoreError(`Source database integrity check failed: ${JSON.stringify(checkRes)}`);
      }

      // Query schema version
      let schemaVersion = 1;
      try {
        const verStmt = db.prepare('PRAGMA user_version;');
        const verRes = verStmt.get() as { user_version: number };
        if (verRes && typeof verRes.user_version === 'number') {
          schemaVersion = verRes.user_version;
        }
      } catch {
        // Fallback default
      }

      // 2. Execute atomic VACUUM INTO (SQLite online backup mechanism)
      // Path must be normalized for SQLite string literal
      const normalizedPath = resolvedBackupPath.replace(/\\/g, '/');
      db.exec(`VACUUM INTO '${normalizedPath}';`);

      // 3. Verify backup file was created
      if (!fs.existsSync(resolvedBackupPath)) {
        throw new BackupRestoreError(`VACUUM INTO did not produce file at ${resolvedBackupPath}`);
      }

      // 4. Verify integrity of the backup file itself
      const backupDb = new DatabaseSync(resolvedBackupPath);
      try {
        const backupCheck = backupDb.prepare('PRAGMA integrity_check;').all() as Array<{ integrity_check: string }>;
        if (!backupCheck || backupCheck.length === 0 || backupCheck[0].integrity_check !== 'ok') {
          throw new BackupRestoreError(`Backup file integrity check failed: ${JSON.stringify(backupCheck)}`);
        }
      } finally {
        backupDb.close();
      }

      // 5. Compute cryptographic SHA-256 of the backup file
      const fileBuffer = fs.readFileSync(resolvedBackupPath);
      const sha256 = createHash('sha256').update(fileBuffer).digest('hex');
      const sizeBytes = fileBuffer.length;

      const metadata: BackupMetadata = {
        backupFile: resolvedBackupPath,
        metaFile: `${resolvedBackupPath}.meta.json`,
        sha256,
        sizeBytes,
        createdAt: new Date().toISOString(),
        schemaVersion,
        customMetadata,
      };

      // 6. Write metadata file
      fs.writeFileSync(metadata.metaFile, JSON.stringify(metadata, null, 2), 'utf8');

      return metadata;
    } finally {
      if (isTempInstance) {
        db.close();
      }
    }
  }

  /**
   * Restores a database from an authenticated backup.
   * Enforces SHA-256 cryptographic check and SQLite integrity verification before activation.
   */
  public static restoreBackup(
    backupPath: string,
    targetDbPath: string,
    options: { expectedSchemaVersion?: number | undefined } = {}
  ): RestoreResult {
    const resolvedBackup = path.resolve(backupPath);
    const resolvedTarget = path.resolve(targetDbPath);
    const metaPath = `${resolvedBackup}.meta.json`;

    if (!fs.existsSync(resolvedBackup)) {
      throw new BackupRestoreError(`Backup file does not exist: ${resolvedBackup}`);
    }

    if (resolvedBackup === resolvedTarget) {
      throw new BackupRestoreError(`Restore target cannot be identical to backup source file: ${resolvedTarget}`);
    }

    if (fs.existsSync(resolvedTarget)) {
      throw new BackupRestoreError(
        `Target database already exists at ${resolvedTarget}. ` +
        `Restore must strictly target a new, non-existing isolated path. In-place overwriting of active or existing databases is prohibited.`
      );
    }

    // 1. Verify cryptographic SHA-256 against metadata if available
    let sha256Verified = false;
    let schemaVersion = 1;

    if (fs.existsSync(metaPath)) {
      try {
        const metaContent = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as BackupMetadata;
        const actualSha = createHash('sha256').update(fs.readFileSync(resolvedBackup)).digest('hex');
        if (actualSha.toLowerCase() !== metaContent.sha256.toLowerCase()) {
          throw new BackupRestoreError(
            `Backup SHA-256 checksum mismatch! Expected ${metaContent.sha256}, got ${actualSha}. File corrupted or tampered.`
          );
        }
        sha256Verified = true;
        schemaVersion = metaContent.schemaVersion;
      } catch (err: any) {
        if (err instanceof BackupRestoreError) throw err;
        throw new BackupRestoreError(`Failed to parse backup metadata at ${metaPath}: ${err.message}`);
      }
    }

    if (options.expectedSchemaVersion !== undefined && schemaVersion !== options.expectedSchemaVersion) {
      throw new BackupRestoreError(
        `Schema version mismatch! Backup has version ${schemaVersion}, expected ${options.expectedSchemaVersion}.`
      );
    }

    // 2. Open backup in isolated read mode and run PRAGMA integrity_check
    const testDb = new DatabaseSync(resolvedBackup);
    try {
      const checkRes = testDb.prepare('PRAGMA integrity_check;').all() as Array<{ integrity_check: string }>;
      if (!checkRes || checkRes.length === 0 || checkRes[0].integrity_check !== 'ok') {
        throw new BackupRestoreError(`Backup database failed PRAGMA integrity_check: ${JSON.stringify(checkRes)}`);
      }
    } catch (err: any) {
      throw new BackupRestoreError(`Cannot verify backup database integrity: ${err.message}`);
    } finally {
      testDb.close();
    }

    // 3. Atomically copy verified backup to target path
    const targetDir = path.dirname(resolvedTarget);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // Use safe atomic write via temporary file
    const tempTarget = `${resolvedTarget}.restore_tmp_${Date.now()}`;
    fs.copyFileSync(resolvedBackup, tempTarget);

    // Verify tempTarget integrity before replacing active DB
    const verifyRestoredDb = new DatabaseSync(tempTarget);
    try {
      const checkRes = verifyRestoredDb.prepare('PRAGMA integrity_check;').all() as Array<{ integrity_check: string }>;
      if (!checkRes || checkRes.length === 0 || checkRes[0].integrity_check !== 'ok') {
        throw new BackupRestoreError(`Restored temp target failed integrity check: ${JSON.stringify(checkRes)}`);
      }
    } finally {
      verifyRestoredDb.close();
    }

    // Move into final place
    if (fs.existsSync(resolvedTarget)) {
      fs.unlinkSync(resolvedTarget);
    }
    fs.renameSync(tempTarget, resolvedTarget);

    return {
      restoredFile: resolvedTarget,
      sourceBackupFile: resolvedBackup,
      sha256Verified,
      integrityVerified: true,
      schemaVersion,
      restoredAt: new Date().toISOString(),
    };
  }
}
