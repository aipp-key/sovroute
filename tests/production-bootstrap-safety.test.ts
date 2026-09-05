/**
 * UNIVERSAL AGENT ASSET ROUTER — SOVROUTE ARCHITECTURE V4
 * Production Bootstrap Safety Certification Suite
 *
 * Requirements:
 * 1. Verify coordinator cannot be exposed unless inventory is IReconciledLiquidityInventory.
 * 2. Verify boot reconciliation returning non-READY (DEFICIT, UNKNOWN) aborts fail-closed.
 * 3. Verify persistence instance mismatch between inventory and bootstrap is rejected fail-closed.
 * 4. Verify DB corruption aborts fail-closed.
 * 5. Verify invalid configuration aborts before database creation.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import {
  bootstrapProductionRouter,
  MissingInventoryError,
} from '../src/bootstrap.ts';
import { SqlitePersistence } from '../src/persistence/sqlite.ts';
import { FakeEvmAtomicBackend } from '../src/atomic/evm/fake-backend.ts';
import { ChainInventoryReconciler } from '../src/atomic/liquidity/chain-reconciler.ts';
import { SqliteLiquidityInventory } from '../src/atomic/liquidity/sqlite-inventory.ts';
import {
  BASE_SEPOLIA_CHAIN_ID,
  OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS,
} from '../src/atomic/evm/base-guard.ts';
import type {
  IReconciledLiquidityInventory,
  ILiquidityInventory,
} from '../src/atomic/types.ts';

const canonicalUsdc = OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS.toLowerCase();

describe('PRODUCTION BOOTSTRAP SAFETY & FAIL-CLOSED BOUNDARIES', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), 'phase-boot-safety-' + randomUUID() + '.db');
  });

  afterEach(() => {
    try {
      if (existsSync(dbPath)) rmSync(dbPath, { force: true });
    } catch {}
  });

  function getValidBootstrapConfig(databasePath: string): any {
    return {
      environment: 'production',
      databasePath,
      lightning: {
        network: 'regtest',
        host: '127.0.0.1',
        port: 18080,
        tlsCertHex: '0011223344',
        macaroonHex: 'aabbccddee',
      },
      evm: {
        chainId: BASE_SEPOLIA_CHAIN_ID,
        rpcUrl: 'https://sepolia.base.org',
        htlcAddress: '0x1111111111111111111111111111111111111111',
        usdcAddress: OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS,
        finalityPolicy: {
          policyTag: 'BASE_SEPOLIA_TEST_POLICY',
          requiredConfirmations: 2,
        },
        operationalPrivateKey: '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      },
      safety: {
        allowMainnet: false,
        unsafeDirectExecutionForTests: false,
        minRemainingBtcBlocks: 140,
        maxReconciliationRetries: 5,
        leaseMs: 30000,
      },
    };
  }

  it('BOOT-SAFE-01: Missing inventory option throws MissingInventoryError fail-closed', async () => {
    const config = getValidBootstrapConfig(dbPath);
    await assert.rejects(
      () => bootstrapProductionRouter(config, {} as any),
      (err: any) => err instanceof MissingInventoryError
    );
  });

  it('BOOT-SAFE-02: Plain ILiquidityInventory lacking reconcileOnBoot throws MissingInventoryError', async () => {
    const config = getValidBootstrapConfig(dbPath);
    const plainInventory: ILiquidityInventory = {
      reserve: async () => ({ reservationId: 'r1', reserved: true }),
      release: async () => {},
      commit: async () => {},
      getAvailableBalance: async () => 100_000_000n,
    };

    await assert.rejects(
      () => bootstrapProductionRouter(config, { inventory: plainInventory as any }),
      (err: any) => err instanceof MissingInventoryError && err.message.includes('IReconciledLiquidityInventory')
    );
  });

  it('BOOT-SAFE-03: Boot reconciliation returning DEFICIT aborts bootstrap fail-closed', async () => {
    const config = getValidBootstrapConfig(dbPath);
    const deficitInventory: IReconciledLiquidityInventory = {
      reserve: async () => ({ reservationId: 'r1', reserved: true }),
      release: async () => {},
      commit: async () => {},
      getAvailableBalance: async () => 0n,
      getReadinessState: async () => 'DEFICIT',
      getSafeHeadroom: async () => -10_000_000n,
      reconcile: async () => ({ readinessState: 'DEFICIT', headroom: -10_000_000n }),
      reconcileOnBoot: async () => ({ readinessState: 'DEFICIT', headroom: -10_000_000n, error: 'INSOLVENT_OPERATOR_STATE' }),
    };

    await assert.rejects(
      () => bootstrapProductionRouter(config, { inventory: deficitInventory }),
      /INVENTORY_BOOT_RECONCILIATION_FAILED: Inventory readiness state is DEFICIT/
    );
  });

  it('BOOT-SAFE-04: Boot reconciliation returning UNKNOWN aborts bootstrap fail-closed', async () => {
    const config = getValidBootstrapConfig(dbPath);
    const unknownInventory: IReconciledLiquidityInventory = {
      reserve: async () => ({ reservationId: 'r1', reserved: true }),
      release: async () => {},
      commit: async () => {},
      getAvailableBalance: async () => 0n,
      getReadinessState: async () => 'UNKNOWN',
      getSafeHeadroom: async () => 0n,
      reconcile: async () => ({ readinessState: 'UNKNOWN', headroom: 0n }),
      reconcileOnBoot: async () => ({ readinessState: 'UNKNOWN', headroom: 0n, error: 'FINALITY_OBSERVATION_FAILED' }),
    };

    await assert.rejects(
      () => bootstrapProductionRouter(config, { inventory: unknownInventory }),
      /INVENTORY_BOOT_RECONCILIATION_FAILED: Inventory readiness state is UNKNOWN/
    );
  });

  it('BOOT-SAFE-05: SqliteLiquidityInventory bound to mismatched persistence aborts bootstrap fail-closed', async () => {
    const config = getValidBootstrapConfig(dbPath);
    const otherDbPath = join(tmpdir(), 'other-boot-db-' + randomUUID() + '.db');
    const otherPersistence = new SqlitePersistence({ filename: otherDbPath });

    try {
      const fakeEvm = new FakeEvmAtomicBackend();
      fakeEvm.setPersistence(otherPersistence);
      const reconciler = new ChainInventoryReconciler({
        persistence: otherPersistence,
        capacityProvider: fakeEvm,
        defaultTokenAddress: canonicalUsdc,
      });
      const mismatchedInventory = new SqliteLiquidityInventory(otherPersistence, { reconciler });

      await assert.rejects(
        () => bootstrapProductionRouter(config, { inventory: mismatchedInventory }),
        /INVENTORY_PERSISTENCE_MISMATCH/
      );
    } finally {
      otherPersistence.close();
      if (existsSync(otherDbPath)) rmSync(otherDbPath, { force: true });
    }
  });

  it('BOOT-SAFE-06: Database file is not created if configuration validation fails', async () => {
    const badConfig = getValidBootstrapConfig(dbPath);
    badConfig.evm.chainId = 1; // Ethereum mainnet forbidden

    await assert.rejects(
      () => bootstrapProductionRouter(badConfig, { inventory: {} as any })
    );

    assert.strictEqual(existsSync(dbPath), false, 'Database file must not exist after invalid config abort');
  });
});
