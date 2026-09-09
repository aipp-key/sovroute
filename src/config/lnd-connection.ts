/**
 * SOVROUTE — ARCHITECTURE V4
 * LND Connection Factory
 *
 * Builds a verified LndClient from RouterProductionConfig.lightning,
 * enforcing the P0 network safety guard (verifyNetworkSafety) before
 * returning an operational client.
 *
 * Enforces:
 * - LND-SEC-1: Network must match config.lightning.network
 * - LND-SEC-3: TLS cert is required; rejectUnauthorized enforced
 * - LND-SEC-4: Macaroon must be present (fail-closed if missing)
 */

import fs from 'node:fs';
import { LndClient, type ILndClient } from '../atomic/lightning/lnd-client.ts';
import type { LightningConfig } from './production-config.ts';

export class LndConnectionError extends Error {
  constructor(message: string) {
    super(`LND_CONNECTION_ERROR: ${message}`);
    this.name = 'LndConnectionError';
  }
}

/**
 * Builds a fully-verified LndClient from a LightningConfig.
 *
 * Fails closed if:
 * - No macaroon is provided (path or hex)
 * - No TLS cert is provided (path or hex)
 * - verifyNetworkSafety() fails (wrong network or unreachable)
 *
 * This function is async because it calls verifyNetworkSafety().
 * Callers MUST await it before using the returned client.
 */
export async function buildVerifiedLndClient(config: LightningConfig): Promise<ILndClient> {
  // 1. Resolve TLS cert (required)
  let tlsCertPem: string | undefined;
  if (config.tlsCertHex) {
    tlsCertPem = Buffer.from(config.tlsCertHex, 'hex').toString('utf8');
  } else if (config.tlsCertPath) {
    if (!fs.existsSync(config.tlsCertPath)) {
      throw new LndConnectionError(
        `TLS cert file not found at path: ${config.tlsCertPath}`
      );
    }
    tlsCertPem = fs.readFileSync(config.tlsCertPath, 'utf8');
  } else {
    throw new LndConnectionError(
      'LND TLS cert is required. Provide tlsCertPath or tlsCertHex in lightning config.'
    );
  }

  // 2. Resolve macaroon (required)
  let macaroonHex: string | undefined;
  if (config.macaroonHex) {
    macaroonHex = config.macaroonHex.trim();
  } else if (config.macaroonPath) {
    if (!fs.existsSync(config.macaroonPath)) {
      throw new LndConnectionError(
        `Macaroon file not found at path: ${config.macaroonPath}`
      );
    }
    macaroonHex = fs.readFileSync(config.macaroonPath).toString('hex').trim();
  } else {
    throw new LndConnectionError(
      'LND macaroon is required. Provide macaroonPath or macaroonHex in lightning config.'
    );
  }

  // 3. Validate network value
  const expectedNetwork = config.network;
  if (!['mainnet', 'testnet', 'regtest', 'signet', 'simnet'].includes(expectedNetwork)) {
    throw new LndConnectionError(
      `Invalid lightning.network value: "${expectedNetwork}". Must be one of: mainnet, testnet, regtest, signet, simnet.`
    );
  }

  // 4. Build client
  const client = new LndClient({
    restEndpoint: `https://${config.host}:${config.port}`,
    tlsCertPem,
    macaroonHex,
    // Type cast: LndClientConfig.expectedNetwork is a union, production-config uses string
    expectedNetwork: expectedNetwork as 'mainnet' | 'testnet' | 'regtest',
  });

  // 5. P0 Network Safety Guard — MUST pass before client is returned
  try {
    await client.verifyNetworkSafety();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new LndConnectionError(
      `Network safety verification failed: ${msg}`
    );
  }

  return client;
}
