/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Phase 7: Supported Production Bootstrap & Runtime Factory
 *
 * Enforces:
 * - STEP 1: Strict ProductionConfigValidator.validate() BEFORE any backend or database construction.
 * - STEP 2: Strict requirement of explicit ILiquidityInventory (no fake inventory default).
 * - STEP 3: Authoritative persistence initialization with fail-closed integrity check.
 * - STEP 4: Canonical real LND backend construction with P0 verifyNetworkSafety() gate.
 * - STEP 5: Canonical real Base Sepolia backend construction with BaseNetworkGuard.
 * - STEP 6: Real read-only Base RPC probe and LND health check wiring.
 * - STEP 7: AtomicCoordinator production wiring.
 *
 * GUARANTEE: No mock backends, fake inventories, or unvalidated escape hatches exist in this surface.
 */

import { createPublicClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import {
  ProductionConfigValidator,
  type RouterProductionConfig,
} from './config/production-config.ts';
import { SqlitePersistence } from './persistence/sqlite.ts';
import { HealthService } from './health/health-service.ts';
import { AtomicCoordinator } from './atomic/coordinator/coordinator.ts';
import { LndClient, type LndClientConfig } from './atomic/lightning/lnd-client.ts';
import { LndLightningAtomicBackend } from './atomic/lightning/lnd-backend.ts';
import { BaseSepoliaAtomicBackend } from './atomic/evm/base-sepolia-backend.ts';
import type {
  ILightningAtomicBackend,
  IEvmAtomicBackend,
  IReconciledLiquidityInventory,
} from './atomic/types.ts';
import { SqliteLiquidityInventory } from './atomic/liquidity/sqlite-inventory.ts';
import { BASE_SEPOLIA_CHAIN_ID } from './atomic/evm/base-guard.ts';

export interface ProductionBootstrapOptions {
  /**
   * Explicit liquidity inventory instance provided by deployment layer.
   * REQUIRED: The production router never fabricates artificial liquidity balances.
   * Must implement IReconciledLiquidityInventory for fail-closed on-chain boot reconciliation (FF-1).
   */
  readonly inventory: IReconciledLiquidityInventory;
  readonly workerId?: string | undefined;
}

export interface ProductionBootstrapResult {
  readonly config: RouterProductionConfig;
  readonly persistence: SqlitePersistence;
  readonly lightningBackend: ILightningAtomicBackend;
  readonly evmBackend: IEvmAtomicBackend;
  readonly inventory: IReconciledLiquidityInventory;
  readonly coordinator: AtomicCoordinator;
  readonly healthService: HealthService;
}

export class MissingInventoryError extends Error {
  constructor(message: string) {
    super(`MISSING_INVENTORY: ${message}`);
    this.name = 'MissingInventoryError';
  }
}

/**
 * Supported, canonical production router bootstrap.
 *
 * GUARANTEE: NO economic backend, persistence instance, or coordinator
 * can be activated without first passing ProductionConfigValidator.validate().
 */
export async function bootstrapProductionRouter(
  rawConfig: RouterProductionConfig,
  options: ProductionBootstrapOptions
): Promise<ProductionBootstrapResult> {
  // =========================================================================
  // STEP 1: VALIDATE PRODUCTION CONFIG FIRST (BEFORE ANY RESOURCE ALLOCATION)
  // =========================================================================
  const validatedConfig = ProductionConfigValidator.validate(rawConfig);

  // =========================================================================
  // STEP 2: REQUIRE EXPLICIT RECONCILED INVENTORY (FAIL-CLOSED: NO SILENT FAKE DEFAULT)
  // =========================================================================
  if (!options || !options.inventory) {
    throw new MissingInventoryError(
      'Production bootstrap requires an explicit IReconciledLiquidityInventory instance. ' +
      'Silent fabrication of liquidity balances is strictly prohibited in production profile.'
    );
  }
  if (typeof options.inventory.reconcileOnBoot !== 'function') {
    throw new MissingInventoryError(
      'Production bootstrap requires an IReconciledLiquidityInventory instance with a reconcileOnBoot method.'
    );
  }

  // =========================================================================
  // STEP 3: INITIALIZE DURABLE PERSISTENCE WITH FAIL-CLOSED INTEGRITY CHECK
  // =========================================================================
  const persistence = new SqlitePersistence({ filename: validatedConfig.databasePath });
  const check = (persistence as any).db.prepare('PRAGMA integrity_check;').all();
  if (!check || check.length === 0 || check[0].integrity_check !== 'ok') {
    persistence.close();
    throw new Error(`DATABASE_INTEGRITY_FAILURE: Active database failed integrity_check: ${JSON.stringify(check)}`);
  }

  // =========================================================================
  // STEP 3.5: BASE ONCHAIN INVENTORY RECONCILIATION ON BOOT (REC-4, REC-5, FF-1)
  // =========================================================================
  if (options.inventory instanceof SqliteLiquidityInventory) {
    if (options.inventory.getPersistence() !== persistence) {
      persistence.close();
      throw new Error(
        'INVENTORY_PERSISTENCE_MISMATCH: Provided inventory persistence instance does not match bootstrap persistence.'
      );
    }
  }

  const bootResult = await options.inventory.reconcileOnBoot();
  if (bootResult.readinessState !== 'READY') {
    persistence.close();
    throw new Error(
      `INVENTORY_BOOT_RECONCILIATION_FAILED: Inventory readiness state is ${bootResult.readinessState}, expected READY (error: ${bootResult.error ?? 'none'})`
    );
  }

  // =========================================================================
  // STEP 4: INITIALIZE CANONICAL REAL LND LIGHTNING ATOMIC BACKEND
  // =========================================================================
  const lndConfig: LndClientConfig = {
    restEndpoint: `https://${validatedConfig.lightning.host}:${validatedConfig.lightning.port}`,
    expectedNetwork: 'regtest',
  };
  if (validatedConfig.lightning.macaroonHex) {
    lndConfig.macaroonHex = validatedConfig.lightning.macaroonHex;
  }
  if (validatedConfig.lightning.tlsCertHex) {
    lndConfig.tlsCertPem = Buffer.from(validatedConfig.lightning.tlsCertHex, 'hex').toString('utf8');
  }

  const lndClient = new LndClient(lndConfig);
  await lndClient.verifyNetworkSafety();
  const lightningBackend = new LndLightningAtomicBackend(lndClient);

  // =========================================================================
  // STEP 5: INITIALIZE CANONICAL REAL BASE SEPOLIA EVM ATOMIC BACKEND
  // =========================================================================
  const evmBackend = new BaseSepoliaAtomicBackend({
    rpcUrl: validatedConfig.evm.rpcUrl,
    operatorPrivateKey: validatedConfig.evm.operationalPrivateKey as `0x${string}`,
    persistence,
    requiredConfirmations: validatedConfig.evm.finalityPolicy.requiredConfirmations,
  });

  // =========================================================================
  // STEP 6: CONSTRUCT REAL READ-ONLY BASE RPC & LND HEALTH PROBES
  // =========================================================================
  const publicEvmClient = createPublicClient({
    chain: baseSepolia,
    transport: http(validatedConfig.evm.rpcUrl, { timeout: 5000 }),
  });

  const healthService = new HealthService(persistence, {
    checkLightning: async () => {
      try {
        const info = await lndClient.getInfo();
        return {
          available: true,
          details: { blockHeight: info.block_height, network: info.chains?.[0]?.network },
        };
      } catch (err: any) {
        return { available: false, details: { error: err.message } };
      }
    },
    checkEvm: async () => {
      try {
        // Read-only probe: verify RPC liveness, chain identity, and latest block
        const chainId = await publicEvmClient.getChainId();
        if (chainId !== BASE_SEPOLIA_CHAIN_ID) {
          return {
            available: false,
            message: `Wrong chain ID on Base RPC: expected ${BASE_SEPOLIA_CHAIN_ID}, got ${chainId}`,
            details: { chainId },
          };
        }
        const blockNumber = await publicEvmClient.getBlockNumber();
        return {
          available: true,
          details: { chainId, blockNumber: Number(blockNumber) },
        };
      } catch (err: any) {
        return {
          available: false,
          message: `Base RPC health probe failed: ${err.message}`,
          details: { error: err.message },
        };
      }
    },
  });

  // =========================================================================
  // STEP 7: WIRE ATOMIC COORDINATOR WITH VALIDATED POLICIES
  // =========================================================================
  const coordinator = new AtomicCoordinator(lightningBackend, evmBackend, options.inventory, {
    persistence,
    workerId: options.workerId ?? 'worker-production-primary',
    finalityPolicy: validatedConfig.evm.finalityPolicy,
    leaseMs: validatedConfig.safety.leaseMs,
    maxRetries: validatedConfig.safety.maxReconciliationRetries,
  });

  return {
    config: validatedConfig,
    persistence,
    lightningBackend,
    evmBackend,
    inventory: options.inventory,
    coordinator,
    healthService,
  };
}
