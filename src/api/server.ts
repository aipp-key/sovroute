/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Minimal Native HTTP API Server (Zero External Dependencies)
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { SwapOrchestrator } from './orchestrator.ts';
import {
  WalletCooldownActiveError,
  RollingVolumeLimitExceededError,
  DestinationVolumeLimitExceededError,
  ConcurrentExposureLimitExceededError,
  IdempotencyConflictError,
} from '../anti-abuse/errors.ts';
import {
  InvalidSignatureError,
  SignatureExpiredError,
  AuthorizationParameterMismatchError,
  InvalidNonceError,
  QuoteAlreadyConsumedError,
  AmbiguousBroadcastError,
} from '../gasless/errors.ts';
import {
  QuoteExpiredError,
  QuoteTamperedError,
  QuoteOutputTooLowError,
  SwapAmountOutOfBoundsError,
} from '../pricing/errors.ts';

export interface ApiServerOptions {
  port?: number;
  host?: string;
  orchestrator: SwapOrchestrator;
}

export function serializeBigIntJson(data: unknown): string {
  return JSON.stringify(data, (_, value) =>
    typeof value === 'bigint' ? value.toString() : value
  );
}

export function parseJsonBody<T>(req: IncomingMessage, maxBytes = 1_000_000): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('PAYLOAD_TOO_LARGE: Request body exceeds 1MB limit.'));
        req.destroy();
        return;
      }
      body += chunk;
    });

    req.on('end', () => {
      try {
        if (!body.trim()) {
          resolve({} as T);
          return;
        }
        // Custom reviver for BigInt fields where appropriate
        const parsed = JSON.parse(body, (key, value) => {
          if (
            (key === 'amountSats' ||
              key === 'amountUsdcAtomic' ||
              key === 'grossUsdcAtomic' ||
              key === 'netUsdcAtomic' ||
              key === 'nonce' ||
              key === 'deadline') &&
            typeof value === 'string' &&
            /^\d+$/.test(value)
          ) {
            return BigInt(value);
          }
          return value;
        });
        resolve(parsed);
      } catch (err) {
        reject(new Error(`INVALID_JSON: ${(err as Error).message}`));
      }
    });

    req.on('error', reject);
  });
}

export function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  const payload = serializeBigIntJson(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Idempotency-Key',
  });
  res.end(payload);
}

export function sendError(res: ServerResponse, err: unknown): void {
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = (err as Error).message ?? 'An unexpected error occurred.';

  if (err instanceof WalletCooldownActiveError) {
    status = 429;
    code = 'WALLET_COOLDOWN_ACTIVE';
  } else if (
    err instanceof RollingVolumeLimitExceededError ||
    err instanceof DestinationVolumeLimitExceededError ||
    err instanceof ConcurrentExposureLimitExceededError
  ) {
    status = 429;
    code = 'VOLUME_LIMIT_EXCEEDED';
  } else if (err instanceof IdempotencyConflictError) {
    status = 409;
    code = 'IDEMPOTENCY_CONFLICT';
  } else if (
    err instanceof InvalidSignatureError ||
    err instanceof SignatureExpiredError ||
    err instanceof AuthorizationParameterMismatchError ||
    err instanceof InvalidNonceError ||
    err instanceof QuoteAlreadyConsumedError ||
    err instanceof QuoteExpiredError ||
    err instanceof QuoteTamperedError ||
    err instanceof QuoteOutputTooLowError ||
    err instanceof SwapAmountOutOfBoundsError
  ) {
    status = 400;
    code = (err as any).name ?? 'BAD_REQUEST';
  } else if (err instanceof AmbiguousBroadcastError) {
    status = 504;
    code = 'AMBIGUOUS_BROADCAST';
  } else if (message.startsWith('INVALID_JSON') || message.startsWith('PAYLOAD_TOO_LARGE')) {
    status = 400;
    code = 'MALFORMED_REQUEST';
  }

  sendJson(res, status, { error: code, message });
}

export function createApiServer(options: ApiServerOptions): Server {
  const { orchestrator } = options;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // 1. Handle CORS Preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, Idempotency-Key',
      });
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    try {
      // 2. Route: GET /api/health
      if (req.method === 'GET' && pathname === '/api/health') {
        const health = await orchestrator.getHealth();
        sendJson(res, 200, health);
        return;
      }

      // 3. Route: POST /api/quote
      if (req.method === 'POST' && pathname === '/api/quote') {
        const body = await parseJsonBody<any>(req);
        if (!body.amountSats || !body.targetDestinationAddress) {
          sendJson(res, 400, {
            error: 'MISSING_PARAMETERS',
            message: 'amountSats and targetDestinationAddress are required.',
          });
          return;
        }

        const quote = await orchestrator.getQuote({
          amountSats: BigInt(body.amountSats),
          targetDestinationAddress: body.targetDestinationAddress,
        });
        sendJson(res, 200, quote);
        return;
      }

      // 4. Route: GET /api/limits/:walletAddress
      if (req.method === 'GET' && pathname.startsWith('/api/limits/')) {
        const walletAddress = pathname.replace('/api/limits/', '').trim();
        if (!walletAddress) {
          sendJson(res, 400, { error: 'MISSING_WALLET', message: 'walletAddress is required in URL path.' });
          return;
        }
        const limits = orchestrator.getLimits(walletAddress);
        sendJson(res, 200, limits);
        return;
      }

      // 5. Route: POST /api/swap/submit
      if (req.method === 'POST' && pathname === '/api/swap/submit') {
        const body = await parseJsonBody<any>(req);
        if (!body.authorization || !body.quote || !body.idempotencyKey) {
          sendJson(res, 400, {
            error: 'MISSING_PARAMETERS',
            message: 'authorization, quote, and idempotencyKey are required.',
          });
          return;
        }

        const result = await orchestrator.submitGaslessSwap(body);
        sendJson(res, 200, result);
        return;
      }

      // 6. Route: GET /api/swap/:idempotencyKey
      if (req.method === 'GET' && pathname.startsWith('/api/swap/')) {
        const idempotencyKey = pathname.replace('/api/swap/', '').trim();
        if (!idempotencyKey) {
          sendJson(res, 400, { error: 'MISSING_KEY', message: 'idempotencyKey is required in URL path.' });
          return;
        }

        const status = orchestrator.getSwapStatus(idempotencyKey);
        if (!status) {
          sendJson(res, 404, { error: 'NOT_FOUND', message: `Swap with key '${idempotencyKey}' not found.` });
          return;
        }

        sendJson(res, 200, status);
        return;
      }

      // 7. Route Not Found
      sendJson(res, 404, { error: 'NOT_FOUND', message: `Route ${req.method} ${pathname} not found.` });
    } catch (err) {
      sendError(res, err);
    }
  });

  return server;
}
