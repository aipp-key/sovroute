/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Phase 7: Production Configuration & Startup Fail-Closed Guard
 *
 * Enforces strict fail-closed startup validation, hard mainnet safety guards,
 * explicit Base finality policies, and secret-safe serialization.
 */

import path from 'node:path';
import fs from 'node:fs';
import {
  BASE_SEPOLIA_CHAIN_ID,
  BASE_MAINNET_CHAIN_ID,
  OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS,
  OFFICIAL_BASE_MAINNET_USDC_ADDRESS,
} from '../atomic/evm/base-guard.ts';
import type { BaseFinalityPolicy } from '../atomic/coordinator/coordinator.ts';
import type { BaseInventoryReconciliationPolicy } from '../atomic/types.ts';

export class ProductionConfigError extends Error {
  constructor(message: string) {
    super(`PRODUCTION_CONFIG_ERROR: ${message}`);
    this.name = 'ProductionConfigError';
  }
}

export class CriticalMainnetForbiddenError extends Error {
  constructor(message: string) {
    super(`CRITICAL_MAINNET_FORBIDDEN: ${message}`);
    this.name = 'CriticalMainnetForbiddenError';
  }
}

export interface LightningConfig {
  network: 'regtest' | 'testnet' | 'mainnet' | string;
  host: string;
  port: number;
  tlsCertPath?: string | undefined;
  tlsCertHex?: string | undefined;
  macaroonPath?: string | undefined;
  macaroonHex?: string | undefined;
}

export interface EvmConfig {
  chainId: number;
  rpcUrl: string;
  htlcAddress: string;
  usdcAddress: string;
  finalityPolicy: BaseFinalityPolicy;
  reconciliationPolicy: BaseInventoryReconciliationPolicy;
  operationalPrivateKey?: string | undefined;
}

export interface SafetyConfig {
  allowMainnet?: boolean | undefined;
  unsafeDirectExecutionForTests?: boolean | undefined;
  minRemainingBtcBlocks: number;
  maxReconciliationRetries: number;
  leaseMs: number;
}

export interface RouterProductionConfig {
  environment: 'production' | 'test' | 'development';
  databasePath: string;
  lightning: LightningConfig;
  evm: EvmConfig;
  safety: SafetyConfig;
}

export class ProductionConfigValidator {
  /**
   * Validates a complete Router configuration, enforcing all Phase 7 production
   * readiness rules and fail-closed safety guards.
   */
  public static validate(config: RouterProductionConfig): RouterProductionConfig {
    if (!config) {
      throw new ProductionConfigError('Configuration object is required and cannot be null or undefined.');
    }

    // 1. HARD MAINNET GUARDS (SEC-1, SEC-7, BASE-SEC-15)
    if (config.safety?.allowMainnet === true) {
      throw new CriticalMainnetForbiddenError(
        'Mainnet enablement is strictly prohibited in V4 Sovereign Core. ' +
        'No real funds or mainnet execution are authorized.'
      );
    }

    if (config.lightning?.network === 'mainnet' || config.lightning?.network === 'bitcoin') {
      throw new CriticalMainnetForbiddenError(
        'Lightning network cannot be configured for mainnet. Regtest is the only authorized network.'
      );
    }

    if (config.evm?.chainId === BASE_MAINNET_CHAIN_ID || config.evm?.chainId === 1) {
      throw new CriticalMainnetForbiddenError(
        `EVM chain ID ${config.evm?.chainId} is a mainnet network. Mainnet execution is strictly forbidden.`
      );
    }

    const usdcAddr = config.evm?.usdcAddress?.toLowerCase();
    if (usdcAddr === OFFICIAL_BASE_MAINNET_USDC_ADDRESS.toLowerCase()) {
      throw new CriticalMainnetForbiddenError(
        `EVM USDC address points to Base Mainnet canonical USDC (${OFFICIAL_BASE_MAINNET_USDC_ADDRESS}). ` +
        `Mainnet assets are strictly forbidden.`
      );
    }

    // 2. ENVIRONMENT & TEST-ONLY FLAG GUARDS
    if (config.environment === 'production') {
      if (config.safety?.unsafeDirectExecutionForTests) {
        throw new ProductionConfigError(
          'unsafeDirectExecutionForTests cannot be enabled when environment is "production".'
        );
      }
      if (config.databasePath === ':memory:') {
        throw new ProductionConfigError(
          'In-memory SQLite database (:memory:) is forbidden in production profile. Durable storage required.'
        );
      }
    }

    // 3. DATABASE PATH VALIDATION
    if (!config.databasePath || typeof config.databasePath !== 'string') {
      throw new ProductionConfigError('databasePath must be a non-empty string.');
    }
    if (config.databasePath !== ':memory:') {
      const dbDir = path.dirname(path.resolve(config.databasePath));
      if (!fs.existsSync(dbDir)) {
        try {
          fs.mkdirSync(dbDir, { recursive: true });
        } catch (err: any) {
          throw new ProductionConfigError(`Database directory ${dbDir} does not exist and cannot be created: ${err.message}`);
        }
      }
      // Verify DB path is not a directory
      if (fs.existsSync(config.databasePath) && fs.statSync(config.databasePath).isDirectory()) {
        throw new ProductionConfigError(`databasePath points to a directory, expected a file path: ${config.databasePath}`);
      }
    }

    // 4. EVM CONFIGURATION VALIDATION
    if (!config.evm) {
      throw new ProductionConfigError('EVM configuration is required.');
    }
    if (config.evm.chainId !== BASE_SEPOLIA_CHAIN_ID) {
      throw new ProductionConfigError(
        `EVM chain ID ${config.evm.chainId} is unsupported. Expected Base Sepolia chain ID ${BASE_SEPOLIA_CHAIN_ID}.`
      );
    }
    if (!config.evm.rpcUrl || !config.evm.rpcUrl.startsWith('http')) {
      throw new ProductionConfigError(`Invalid EVM RPC URL: "${config.evm.rpcUrl}". Must be a valid HTTP(S) endpoint.`);
    }
    if (!config.evm.htlcAddress || !/^0x[0-9a-fA-F]{40}$/.test(config.evm.htlcAddress)) {
      throw new ProductionConfigError(`Invalid EVM HTLC contract address: "${config.evm.htlcAddress}".`);
    }
    if (config.evm.htlcAddress.toLowerCase() === '0x0000000000000000000000000000000000000000') {
      throw new ProductionConfigError('Zero EVM HTLC contract address is forbidden.');
    }
    if (usdcAddr !== OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS.toLowerCase()) {
      throw new ProductionConfigError(
        `Invalid USDC token address: "${config.evm.usdcAddress}". Must match official Base Sepolia test USDC: ${OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS}.`
      );
    }

    // 5. EXPLICIT FINALITY POLICY ENFORCEMENT
    if (!config.evm.finalityPolicy) {
      throw new ProductionConfigError('Missing explicit Base finalityPolicy in EVM configuration.');
    }
    if (
      !Number.isInteger(config.evm.finalityPolicy.requiredConfirmations) ||
      config.evm.finalityPolicy.requiredConfirmations < 2
    ) {
      throw new ProductionConfigError(
        `Base Sepolia finality policy requires at least 2 confirmations. Got: ${config.evm.finalityPolicy.requiredConfirmations}`
      );
    }
    if (!config.evm.finalityPolicy.policyTag?.trim()) {
      throw new ProductionConfigError('Base finality policy requires a non-empty policyTag.');
    }

    // 5.5. EXPLICIT INVENTORY RECONCILIATION POLICY ENFORCEMENT (FB-4)
    if (!config.evm.reconciliationPolicy) {
      throw new ProductionConfigError('Missing explicit Base reconciliationPolicy in EVM configuration.');
    }
    const reconPolicy = config.evm.reconciliationPolicy;
    if (typeof reconPolicy !== 'object' || reconPolicy === null) {
      throw new ProductionConfigError('reconciliationPolicy must be an object.');
    }
    if (!Number.isFinite(reconPolicy.maxFreshnessMs) || reconPolicy.maxFreshnessMs <= 0) {
      throw new ProductionConfigError(
        `reconciliationPolicy.maxFreshnessMs must be a positive number. Got: ${reconPolicy.maxFreshnessMs}`
      );
    }
    if (!Number.isInteger(reconPolicy.requiredConfirmations) || reconPolicy.requiredConfirmations < 2) {
      throw new ProductionConfigError(
        `reconciliationPolicy.requiredConfirmations must be at least 2. Got: ${reconPolicy.requiredConfirmations}`
      );
    }
    if (!Number.isInteger(reconPolicy.reorgLagTolerance) || reconPolicy.reorgLagTolerance < 0) {
      throw new ProductionConfigError(
        `reconciliationPolicy.reorgLagTolerance must be a non-negative number. Got: ${reconPolicy.reorgLagTolerance}`
      );
    }
    if (reconPolicy.failClosedOnDeficit !== true) {
      throw new ProductionConfigError(
        'reconciliationPolicy.failClosedOnDeficit must be explicitly true.'
      );
    }
    if (reconPolicy.requiredConfirmations !== config.evm.finalityPolicy.requiredConfirmations) {
      throw new ProductionConfigError(
        'reconciliationPolicy.requiredConfirmations must equal finalityPolicy.requiredConfirmations.'
      );
    }

    // 6. LIGHTNING CONFIGURATION VALIDATION
    if (!config.lightning) {
      throw new ProductionConfigError('Lightning configuration is required.');
    }
    if (config.lightning.network !== 'regtest') {
      throw new ProductionConfigError(
        `Unsupported Lightning network: "${config.lightning.network}". Only "regtest" is authorized in current core.`
      );
    }
    if (!config.lightning.host) {
      throw new ProductionConfigError('Lightning host is required.');
    }
    if (!config.lightning.port || config.lightning.port <= 0 || config.lightning.port > 65535) {
      throw new ProductionConfigError(`Invalid Lightning port: ${config.lightning.port}`);
    }
    const hasTls = !!config.lightning.tlsCertHex || (!!config.lightning.tlsCertPath && fs.existsSync(config.lightning.tlsCertPath));
    const hasMacaroon = !!config.lightning.macaroonHex || (!!config.lightning.macaroonPath && fs.existsSync(config.lightning.macaroonPath));
    if (!hasTls && !config.safety?.unsafeDirectExecutionForTests) {
      throw new ProductionConfigError('Lightning TLS credentials (tlsCertHex or tlsCertPath) must be provided and valid.');
    }
    if (!hasMacaroon && !config.safety?.unsafeDirectExecutionForTests) {
      throw new ProductionConfigError('Lightning Macaroon credentials (macaroonHex or macaroonPath) must be provided and valid.');
    }

    // 7. TIMING & SAFETY BUDGETS
    if (!config.safety) {
      throw new ProductionConfigError('Safety configuration is required.');
    }
    if (config.safety.minRemainingBtcBlocks < 140) {
      throw new ProductionConfigError(
        `minRemainingBtcBlocks (${config.safety.minRemainingBtcBlocks}) cannot be less than the certified Poisson threshold of 140 blocks.`
      );
    }
    if (config.safety.maxReconciliationRetries < 1 || config.safety.maxReconciliationRetries > 20) {
      throw new ProductionConfigError(
        `maxReconciliationRetries (${config.safety.maxReconciliationRetries}) must be between 1 and 20.`
      );
    }
    if (config.safety.leaseMs < 5000 || config.safety.leaseMs > 300000) {
      throw new ProductionConfigError(`leaseMs (${config.safety.leaseMs}) must be between 5,000ms and 300,000ms.`);
    }

    return config;
  }

  /**
   * Serializes a configuration object safely, masking all sensitive secret material.
   */
  public static sanitize(config: RouterProductionConfig): Record<string, any> {
    const copy = JSON.parse(JSON.stringify(config));
    if (copy.evm?.operationalPrivateKey) {
      copy.evm.operationalPrivateKey = '[REDACTED]';
    }
    if (copy.lightning?.macaroonHex) {
      copy.lightning.macaroonHex = '[REDACTED]';
    }
    if (copy.lightning?.tlsCertHex) {
      copy.lightning.tlsCertHex = '[REDACTED]';
    }
    return copy;
  }
}
