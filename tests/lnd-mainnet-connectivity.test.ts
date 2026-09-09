/**
 * SOVROUTE — ARCHITECTURE V4
 * Phase 2I: Router ↔ LND Mainnet Connectivity Test Suite
 *
 * READ-ONLY integration tests against the production LND node.
 * ZERO financial side effects — no invoices created, no funds moved.
 *
 * Prerequisites:
 * - LND wallet must be unlocked before running
 * - Environment variables must be set (see .env.example)
 * - Run on server or with SSH tunnel to sovereign_router_net
 *
 * Guard: Only runs when SOVROUTE_LND_CONNECTIVITY_TEST=1 is set.
 * This prevents accidental CI execution which has no LND access.
 *
 * Run:
 *   SOVROUTE_LND_CONNECTIVITY_TEST=1 \
 *   LND_HOST=10.240.20.2 \
 *   LND_PORT=8080 \
 *   LND_NETWORK=mainnet \
 *   LND_MACAROON_PATH=/srv/sovereign-router/secrets/router-restricted.macaroon \
 *   LND_TLS_CERT_PATH=/srv/sovereign-router/secrets/lnd-tls.cert \
 *   node --import=tsx/esm --test tests/lnd-mainnet-connectivity.test.ts
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import fs from 'node:fs';
import { LndClient } from '../src/atomic/lightning/lnd-client.ts';
import { buildVerifiedLndClient, LndConnectionError } from '../src/config/lnd-connection.ts';
import type { LightningConfig } from '../src/config/production-config.ts';

// =========================================================================
// GUARD: Only runs when explicitly enabled
// =========================================================================
const ENABLED = process.env['SOVROUTE_LND_CONNECTIVITY_TEST'] === '1';

if (!ENABLED) {
  console.log(
    '[lnd-mainnet-connectivity] Skipped. Set SOVROUTE_LND_CONNECTIVITY_TEST=1 to run.'
  );
  process.exit(0);
}

// =========================================================================
// Config from environment
// =========================================================================
const lndHost = process.env['LND_HOST'] ?? '10.240.20.2';
const lndPort = parseInt(process.env['LND_PORT'] ?? '8080', 10);
const lndNetwork = (process.env['LND_NETWORK'] ?? 'mainnet') as 'mainnet' | 'testnet' | 'regtest';
const macaroonPath = process.env['LND_MACAROON_PATH'];
const macaroonHex = process.env['LND_MACAROON_HEX'];
const tlsCertPath = process.env['LND_TLS_CERT_PATH'];
const tlsCertHex = process.env['LND_TLS_CERT_HEX'];

// =========================================================================
// Helper: load macaroon hex for raw HTTP tests
// =========================================================================
function loadMacaroonHex(): string {
  if (macaroonHex) return macaroonHex.trim();
  if (macaroonPath && fs.existsSync(macaroonPath)) {
    return fs.readFileSync(macaroonPath).toString('hex').trim();
  }
  throw new Error('No macaroon configured for connectivity tests');
}

function loadTlsCert(): Buffer | string | undefined {
  if (tlsCertHex) return Buffer.from(tlsCertHex, 'hex');
  if (tlsCertPath && fs.existsSync(tlsCertPath)) return fs.readFileSync(tlsCertPath);
  return undefined;
}

// =========================================================================
// Suite
// =========================================================================
describe('PHASE 2I — LND MAINNET CONNECTIVITY SUITE (Read-Only)', () => {
  let client: LndClient;
  let macHex: string;
  let tlsCert: Buffer | string | undefined;

  before(async () => {
    const config: LightningConfig = {
      network: lndNetwork,
      host: lndHost,
      port: lndPort,
      macaroonPath,
      macaroonHex,
      tlsCertPath,
      tlsCertHex,
    };

    // buildVerifiedLndClient calls verifyNetworkSafety() internally
    client = (await buildVerifiedLndClient(config)) as LndClient;
    macHex = loadMacaroonHex();
    tlsCert = loadTlsCert();
  });

  // =========================================================================
  // 1. Basic connectivity
  // =========================================================================
  describe('1. Connectivity & Identity', () => {
    it('1. getInfo returns valid response', async () => {
      const info = await client.getInfo();
      assert.ok(info, 'getInfo must return a result');
      assert.ok(info.block_height >= 0, 'block_height must be non-negative');
      assert.ok(Array.isArray(info.chains), 'chains must be an array');
      assert.ok(info.chains.length > 0, 'chains must be non-empty');
    });

    it('2. Network is mainnet', async () => {
      const info = await client.getInfo();
      const network = info.chains?.[0]?.network?.toLowerCase();
      assert.equal(network, 'mainnet', `Expected mainnet, got: ${network}`);
    });

    it('3. verifyNetworkSafety passes for mainnet config', async () => {
      // Already called in before(), but verify it passes again idempotently.
      // We construct a fresh client to test the full flow.
      const freshConfig: LightningConfig = {
        network: lndNetwork,
        host: lndHost,
        port: lndPort,
        macaroonPath,
        macaroonHex,
        tlsCertPath,
        tlsCertHex,
      };
      // Must not throw
      const freshClient = await buildVerifiedLndClient(freshConfig);
      assert.ok(freshClient, 'Fresh verified client must be returned');
    });

    it('4. LND is synced to chain', async () => {
      const info = await client.getInfo();
      assert.equal(info.synced_to_chain, true, 'LND must be synced to chain');
    });

    it('5. block_height is near expected tip (> 900000 for mainnet Sept 2026)', async () => {
      const info = await client.getInfo();
      assert.ok(
        info.block_height > 900_000,
        `block_height ${info.block_height} is unexpectedly low for mainnet`
      );
    });
  });

  // =========================================================================
  // 2. Fail-closed: wrong network config is rejected
  // =========================================================================
  describe('2. Network Safety Guard', () => {
    it('6. verifyNetworkSafety fails if expectedNetwork is regtest against mainnet LND', async () => {
      const wrongConfig: LightningConfig = {
        network: 'regtest', // wrong
        host: lndHost,
        port: lndPort,
        macaroonPath,
        macaroonHex,
        tlsCertPath,
        tlsCertHex,
      };
      await assert.rejects(
        () => buildVerifiedLndClient(wrongConfig),
        /P0_NETWORK_SAFETY_VIOLATION|LND_CONNECTION_ERROR/,
        'Regtest config against mainnet LND must be rejected'
      );
    });

    it('7. LndConnectionError thrown when macaroon is missing', async () => {
      const noMacConfig: LightningConfig = {
        network: lndNetwork,
        host: lndHost,
        port: lndPort,
        // no macaroonPath, no macaroonHex
        tlsCertPath,
        tlsCertHex,
      };
      await assert.rejects(
        () => buildVerifiedLndClient(noMacConfig),
        (err: unknown) => {
          assert.ok(err instanceof LndConnectionError, 'Must throw LndConnectionError');
          assert.ok(
            err.message.includes('macaroon is required'),
            `Unexpected error message: ${(err as Error).message}`
          );
          return true;
        }
      );
    });

    it('8. LndConnectionError thrown when TLS cert is missing', async () => {
      const noCertConfig: LightningConfig = {
        network: lndNetwork,
        host: lndHost,
        port: lndPort,
        macaroonPath,
        macaroonHex,
        // no tlsCertPath, no tlsCertHex
      };
      await assert.rejects(
        () => buildVerifiedLndClient(noCertConfig),
        (err: unknown) => {
          assert.ok(err instanceof LndConnectionError, 'Must throw LndConnectionError');
          assert.ok(
            err.message.includes('TLS cert is required'),
            `Unexpected error message: ${(err as Error).message}`
          );
          return true;
        }
      );
    });
  });

  // =========================================================================
  // 3. Restricted macaroon permission boundaries
  // =========================================================================
  describe('3. Restricted Macaroon — Permission Boundaries', () => {
    function rawHttpRequest(
      path: string,
      method: string,
      body?: unknown
    ): Promise<{ statusCode: number; body: string }> {
      return new Promise((resolve, reject) => {
        const ca = tlsCert;
        const agent = new https.Agent({ ca, checkServerIdentity: () => undefined });
        const req = https.request(
          `https://${lndHost}:${lndPort}${path}`,
          {
            method,
            agent,
            headers: {
              'Content-Type': 'application/json',
              'Grpc-Metadata-macaroon': macHex,
            },
            timeout: 10000,
          },
          (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: data }));
          }
        );
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
        if (body) req.write(JSON.stringify(body));
        req.end();
      });
    }

    it('9. Restricted macaroon can call getinfo (info:read)', async () => {
      const res = await rawHttpRequest('/v1/getinfo', 'GET');
      assert.equal(res.statusCode, 200, `Expected 200, got ${res.statusCode}: ${res.body}`);
      const parsed = JSON.parse(res.body) as { block_height: number };
      assert.ok(parsed.block_height > 0, 'getinfo must return valid block_height');
    });

    it('10. Restricted macaroon cannot send on-chain BTC (onchain:write denied)', async () => {
      const res = await rawHttpRequest('/v1/transactions', 'POST', {
        addr: 'bc1qfakeaddress000000000000000000000000000',
        amount: 1000,
      });
      // LND returns 500 with "permission denied" for unauthorized macaroon operations
      assert.equal(res.statusCode, 500, `Expected 500 (permission denied), got ${res.statusCode}`);
      assert.ok(
        res.body.includes('permission denied'),
        `Expected "permission denied", got: ${res.body.slice(0, 200)}`
      );
    });

    it('11. Restricted macaroon cannot open a channel (channels:write denied)', async () => {
      const res = await rawHttpRequest('/v1/channels', 'POST', {
        node_pubkey_string: '02' + '0'.repeat(64),
        local_funding_amount: 50000,
      });
      assert.equal(res.statusCode, 500, `Expected 500 (permission denied), got ${res.statusCode}`);
      assert.ok(
        res.body.includes('permission denied'),
        `Expected "permission denied", got: ${res.body.slice(0, 200)}`
      );
    });

    it('12. Restricted macaroon cannot sign messages (signer denied)', async () => {
      const res = await rawHttpRequest('/v1/signmessage', 'POST', {
        msg: Buffer.from('unauthorized test').toString('base64'),
      });
      assert.equal(res.statusCode, 500, `Expected 500 (permission denied), got ${res.statusCode}`);
      assert.ok(
        res.body.includes('permission denied'),
        `Expected "permission denied", got: ${res.body.slice(0, 200)}`
      );
    });
  });
});
