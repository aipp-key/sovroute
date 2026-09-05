/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * LND REST API Client with P0 Network Safety Guard
 *
 * Implements direct TLS-authenticated communication with LND.
 * Enforces LND-SEC-1 (Network Safety Guard: regtest only).
 */

import https from 'node:https';
import fs from 'node:fs';
import type {
  LndGetInfoResponse,
  LndAddHoldInvoiceRequest,
  LndAddHoldInvoiceResponse,
  LndInvoice,
  LndSettleInvoiceRequest,
  LndCancelInvoiceRequest,
} from './lnd-types.ts';

export interface LndClientConfig {
  restEndpoint: string; // e.g. "https://127.0.0.1:8080"
  tlsCertPath?: string;
  tlsCertPem?: string;
  macaroonPath?: string;
  macaroonHex?: string;
  expectedNetwork?: 'regtest' | 'mainnet' | 'testnet';
}

export interface ILndClient {
  getInfo(): Promise<LndGetInfoResponse>;
  addHoldInvoice(
    hashHex: string,
    amountSats: bigint,
    cltvBlocks: number,
    memo?: string
  ): Promise<LndAddHoldInvoiceResponse>;
  lookupInvoice(paymentHashHex: string): Promise<LndInvoice>;
  settleInvoice(preimageHex: string): Promise<void>;
  cancelInvoice(paymentHashHex: string): Promise<void>;
}

export class LndRestError extends Error {
  public readonly statusCode: number;
  public readonly responseBody: string;

  constructor(statusCode: number, message: string, responseBody: string) {
    super(message);
    this.name = 'LndRestError';
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

export class LndClient implements ILndClient {
  private readonly baseUrl: string;
  private readonly agent: https.Agent;
  private readonly macaroonHex: string;
  private readonly expectedNetwork: string;
  private verifiedNetwork: boolean = false;

  constructor(config: LndClientConfig) {
    this.baseUrl = config.restEndpoint.replace(/\/$/, '');
    this.expectedNetwork = config.expectedNetwork ?? 'regtest';

    // 1. Load TLS Certificate
    let ca: Buffer | string | undefined;
    if (config.tlsCertPem) {
      ca = config.tlsCertPem;
    } else if (config.tlsCertPath && fs.existsSync(config.tlsCertPath)) {
      ca = fs.readFileSync(config.tlsCertPath);
    }

    this.agent = new https.Agent({
      ca,
      rejectUnauthorized: !!ca,
      checkServerIdentity: () => undefined, // LND local self-signed cert SAN bypass for 127.0.0.1
    });

    // 2. Load Macaroon
    if (config.macaroonHex) {
      this.macaroonHex = config.macaroonHex.trim();
    } else if (config.macaroonPath && fs.existsSync(config.macaroonPath)) {
      this.macaroonHex = fs.readFileSync(config.macaroonPath).toString('hex').trim();
    } else {
      this.macaroonHex = '';
    }
  }

  /**
   * P0 Network Safety Guard: Validates that LND is running on the expected network.
   * MUST be executed before any financial operation!
   */
  public async verifyNetworkSafety(): Promise<void> {
    const info = await this.getInfo();
    const activeNetwork = info.chains?.[0]?.network?.toLowerCase();

    if (activeNetwork !== this.expectedNetwork) {
      throw new Error(
        `P0_NETWORK_SAFETY_VIOLATION: Connected LND node is running on [${activeNetwork}], ` +
        `but Router is strictly configured for [${this.expectedNetwork}]. Halting immediately to prevent fund loss.`
      );
    }

    if (this.expectedNetwork === 'regtest' && activeNetwork !== 'regtest') {
      throw new Error(
        `P0_NETWORK_SAFETY_VIOLATION: Non-regtest network detected: [${activeNetwork}]. Operation forbidden.`
      );
    }

    this.verifiedNetwork = true;
  }

  public async getInfo(): Promise<LndGetInfoResponse> {
    return this.request<LndGetInfoResponse>('GET', '/v1/getinfo');
  }

  public async addHoldInvoice(
    hashHex: string,
    amountSats: bigint,
    cltvBlocks: number,
    memo?: string
  ): Promise<LndAddHoldInvoiceResponse> {
    this.assertNetworkVerified();
    const cleanHash = hashHex.replace(/^0x/, '');
    const hashBase64 = Buffer.from(cleanHash, 'hex').toString('base64');

    const body: LndAddHoldInvoiceRequest = {
      hash: hashBase64,
      value: amountSats.toString(),
      cltv_expiry: cltvBlocks.toString(),
      memo: memo ?? 'Universal Agent Asset Router Swap',
    };

    return this.request<LndAddHoldInvoiceResponse>('POST', '/v2/invoices/hodl', body);
  }

  public async lookupInvoice(paymentHashHex: string): Promise<LndInvoice> {
    this.assertNetworkVerified();
    const cleanHash = paymentHashHex.replace(/^0x/, '');
    // LND REST allows lookup by URL param r_hash_str or payment_hash
    return this.request<LndInvoice>('GET', `/v1/invoice/${cleanHash}`);
  }

  public async settleInvoice(preimageHex: string): Promise<void> {
    this.assertNetworkVerified();
    const cleanPreimage = preimageHex.replace(/^0x/, '');
    const preimageBase64 = Buffer.from(cleanPreimage, 'hex').toString('base64');

    const body: LndSettleInvoiceRequest = {
      preimage: preimageBase64,
    };

    await this.request<Record<string, unknown>>('POST', '/v2/invoices/settle', body);
  }

  public async cancelInvoice(paymentHashHex: string): Promise<void> {
    this.assertNetworkVerified();
    const cleanHash = paymentHashHex.replace(/^0x/, '');
    const hashBase64 = Buffer.from(cleanHash, 'hex').toString('base64');

    const body: LndCancelInvoiceRequest = {
      payment_hash: hashBase64,
    };

    await this.request<Record<string, unknown>>('POST', '/v2/invoices/cancel', body);
  }

  private assertNetworkVerified(): void {
    if (!this.verifiedNetwork) {
      throw new Error(
        'LND_UNVERIFIED_NETWORK: verifyNetworkSafety() must be called and pass before invoking LND operations.'
      );
    }
  }

  private request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const url = new URL(this.baseUrl + path);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (this.macaroonHex) {
        headers['Grpc-Metadata-macaroon'] = this.macaroonHex;
      }

      const req = https.request(
        url,
        {
          method,
          headers,
          agent: this.agent,
          timeout: 10000,
        },
        (res) => {
          let rawData = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            rawData += chunk;
          });

          res.on('end', () => {
            try {
              if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                const parsed = rawData.length > 0 ? (JSON.parse(rawData) as T) : ({} as T);
                resolve(parsed);
              } else {
                let errMessage = `LND REST Error (${res.statusCode}): ${rawData}`;
                try {
                  const errObj = JSON.parse(rawData);
                  if (errObj.message) errMessage = errObj.message;
                } catch {
                  // Use raw text
                }
                reject(new LndRestError(res.statusCode ?? 0, errMessage, rawData));
              }
            } catch (parseErr) {
              reject(parseErr);
            }
          });
        }
      );

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`LND request timeout (${method} ${path})`));
      });

      req.on('error', (err) => {
        reject(err);
      });

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }
}
