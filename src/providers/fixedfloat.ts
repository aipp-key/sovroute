import { createHmac } from 'node:crypto';
import {
  type IExecutionProvider,
  type IExecutionEdge,
  type NormalizedIntent,
  type NormalizedQuote,
  type CreateExecutionRequest,
  type ProviderExecutionResult,
  type NormalizedProviderStatus,
  ProviderNormalizedStatus,
  type ProviderCapabilities,
  type RefundResult,
  ExecutionClass,
  EdgeClass,
  CapabilityStatus,
  type EdgeCapabilities,
  type AssetNode,
  createAssetNode,
  type EdgeRuntimeAvailability,
  type RouteQuote,
  type ExecutionPlan,
  DomainErrorCode,
  RouterError,
} from '../domain/types.ts';

export interface FixedFloatConfig {
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  apiSecret?: string | undefined;
  timeoutMs?: number | undefined;
}

export interface FixedFloatCurrencyInfo {
  code: string;
  coin: string;
  network: string;
  name: string;
  recv: boolean;
  send: boolean;
  priority: number;
}

export class FixedFloatAdapter implements IExecutionProvider, IExecutionEdge {
  public readonly id = 'fixedfloat';
  public readonly name = 'FixedFloat V2';
  public readonly edgeClass = EdgeClass.TRUSTED_PROVIDER_EDGE;
  public readonly executionClass = ExecutionClass.PASSIVE_DEPOSIT;
  public readonly sourceNode: AssetNode = createAssetNode('BTC', 'lightning');
  public readonly destinationNode: AssetNode = createAssetNode(
    'USDC',
    'base',
    '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
  );

  public readonly edgeCapabilities: EdgeCapabilities = {
    discover: CapabilityStatus.SUPPORTED,
    quote: CapabilityStatus.SUPPORTED,
    prepare: CapabilityStatus.UNSUPPORTED,
    execute: CapabilityStatus.SUPPORTED,
    verify: CapabilityStatus.UNSUPPORTED, // FixedFloat is not settlement truth
    recover: CapabilityStatus.SUPPORTED,  // Programmatic emergency refund
  };

  private baseUrl: string;
  private apiKey?: string | undefined;
  private apiSecret?: string | undefined;
  private timeoutMs: number;

  constructor(config: FixedFloatConfig = {}) {
    this.baseUrl = (config.baseUrl ?? 'https://ff.io/api/v2').replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.apiSecret = config.apiSecret;
    this.timeoutMs = config.timeoutMs ?? 15000;
  }

  /**
   * Static route verification (Architecture V3)
   */
  public supportsRoute(source: AssetNode, destination: AssetNode): boolean {
    const isSourceValid =
      source.asset.toUpperCase() === 'BTC' &&
      (source.network.toLowerCase() === 'lightning' || source.network.toLowerCase() === 'bitcoin');

    const isDestValid =
      destination.asset.toUpperCase() === 'USDC' &&
      destination.network.toLowerCase() === 'base' &&
      (!destination.tokenContract ||
        destination.tokenContract.toLowerCase() === '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');

    return isSourceValid && isDestValid;
  }

  /**
   * Dynamic runtime availability verification (Architecture V3)
   * Evaluates live BTCLN recv status and live minimums
   */
  public async getRuntimeAvailability(): Promise<EdgeRuntimeAvailability> {
    const now = new Date().toISOString();
    try {
      const currencies = await this.getCurrencies();
      const btcln = currencies.find((c) => c.code === 'BTCLN');
      const usdcbase = currencies.find((c) => c.code === 'USDCBASE');

      if (!btcln || !usdcbase) {
        return {
          isAvailable: false,
          recvEnabled: false,
          sendEnabled: false,
          isMaintenance: true,
          minAmountAtomic: '0',
          lastCheckedAt: now,
          reason: 'PROVIDER_MAINTENANCE: Required currencies missing from FixedFloat catalog',
        };
      }

      const recvOk = Boolean(btcln.recv);
      const sendOk = Boolean(usdcbase.send);

      if (!recvOk) {
        return {
          isAvailable: false,
          recvEnabled: false,
          sendEnabled: sendOk,
          isMaintenance: true,
          minAmountAtomic: '1450',
          lastCheckedAt: now,
          reason: 'PROVIDER_MAINTENANCE: BTCLN currency is not available for receiving at the moment',
        };
      }

      if (!sendOk) {
        return {
          isAvailable: false,
          recvEnabled: recvOk,
          sendEnabled: false,
          isMaintenance: true,
          minAmountAtomic: '1450',
          lastCheckedAt: now,
          reason: 'PROVIDER_MAINTENANCE: USDCBASE withdrawal is temporarily disabled by provider',
        };
      }

      try {
        const priceInfo = await this.getPriceDetails('BTCLN', 'USDCBASE', 0.0001, 'float');
        const minAtomic = this.decimalToAtomic(priceInfo.from.min.toString(), 8);
        const maxAtomic = priceInfo.from.max ? this.decimalToAtomic(priceInfo.from.max.toString(), 8) : undefined;
        return {
          isAvailable: true,
          recvEnabled: true,
          sendEnabled: true,
          isMaintenance: false,
          minAmountAtomic: minAtomic,
          maxAmountAtomic: maxAtomic,
          estimatedLatencyMs: 180000,
          lastCheckedAt: now,
        };
      } catch {
        return {
          isAvailable: true,
          recvEnabled: true,
          sendEnabled: true,
          isMaintenance: false,
          minAmountAtomic: '1450',
          estimatedLatencyMs: 180000,
          lastCheckedAt: now,
        };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? this.sanitizeError(err.message) : String(err);
      return {
        isAvailable: false,
        recvEnabled: false,
        sendEnabled: false,
        isMaintenance: true,
        minAmountAtomic: '0',
        lastCheckedAt: now,
        reason: `ROUTE_UNAVAILABLE: ${msg}`,
      };
    }
  }

  public async capabilities(): Promise<ProviderCapabilities> {
    return {
      supportedPairs: [
        {
          sourceAsset: 'BTC',
          sourceNetwork: 'lightning',
          targetAsset: 'USDC',
          targetNetwork: 'base',
          minAmountAtomic: '2000', // ~0.00002 BTC (~$1.50)
          maxAmountAtomic: '50000000', // ~0.5 BTC
        },
        {
          sourceAsset: 'BTC',
          sourceNetwork: 'bitcoin',
          targetAsset: 'USDC',
          targetNetwork: 'base',
          minAmountAtomic: '5000',
          maxAmountAtomic: '100000000',
        },
      ],
      executionClass: ExecutionClass.PASSIVE_DEPOSIT,
      supportsLightning: true,
      supportsRefunds: true,
      supportsStrongIdempotency: false, // FixedFloat requires server-issued id + token
    };
  }

  /**
   * Translates normalized router asset + network into FixedFloat ccy code
   */
  public toFixedFloatCcy(asset: string, network: string): string {
    const a = asset.toUpperCase();
    const n = network.toLowerCase();

    if (a === 'BTC' && n === 'lightning') return 'BTCLN';
    if (a === 'BTC' && (n === 'bitcoin' || n === 'btc')) return 'BTC';
    if (a === 'USDC' && n === 'base') return 'USDCBASE';
    if (a === 'ETH' && n === 'base') return 'ETHBASE';

    throw new Error(
      `FixedFloatAdapter: Unsupported pair mapping for ${asset} on network ${network}`
    );
  }

  /**
   * Translates FixedFloat ccy code into normalized router asset + network
   */
  public fromFixedFloatCcy(ccy: string): { asset: string; network: string } {
    const c = ccy.toUpperCase();
    if (c === 'BTCLN') return { asset: 'BTC', network: 'lightning' };
    if (c === 'BTC') return { asset: 'BTC', network: 'bitcoin' };
    if (c === 'USDCBASE') return { asset: 'USDC', network: 'base' };
    if (c === 'ETHBASE') return { asset: 'ETH', network: 'base' };

    return { asset: ccy, network: 'unknown' };
  }

  /**
   * Queries list of all currencies and rails from FixedFloat
   */
  public async getCurrencies(): Promise<FixedFloatCurrencyInfo[]> {
    const data = await this.postRequest<FixedFloatCurrencyInfo[]>('/ccies', {});
    return data;
  }

  /**
   * Fetches real-time market quote from FixedFloat V2 API
   * Supports both NormalizedIntent and direct amount query
   */
  public async getQuote(
    intentOrAmount: NormalizedIntent | string,
    _destinationAddress?: string
  ): Promise<NormalizedQuote & RouteQuote> {
    const isIntent = typeof intentOrAmount === 'object';
    const sourceAsset = isIntent ? intentOrAmount.sourceAsset : 'BTC';
    const sourceNetwork = isIntent ? intentOrAmount.sourceNetwork : 'lightning';
    const targetAsset = isIntent ? intentOrAmount.targetAsset : 'USDC';
    const targetNetwork = isIntent ? intentOrAmount.targetNetwork : 'base';
    const sourceAmountAtomic = isIntent
      ? intentOrAmount.sourceAmountAtomic
      : intentOrAmount;

    const fromCcy = this.toFixedFloatCcy(sourceAsset, sourceNetwork);
    const toCcy = this.toFixedFloatCcy(targetAsset, targetNetwork);

    // Convert atomic satoshis to human decimal string
    const satoshis = BigInt(sourceAmountAtomic);
    const fromAmountDecimal = this.atomicToDecimal(satoshis, 8);

    const payload = {
      fromCcy,
      toCcy,
      amount: parseFloat(fromAmountDecimal),
      direction: 'from',
      type: 'float', // Floating rate with maximum tolerance
    };

    let response: {
      from: {
        ccy: string;
        coin: string;
        network: string;
        amount: number;
        rate: number;
        min: number;
        max: number;
      };
      to: {
        ccy: string;
        coin: string;
        network: string;
        amount: number;
        rate: number;
        min: number;
        max: number;
      };
      errors?: string[];
    };

    try {
      response = await this.postRequest('/price', payload);
    } catch (err: unknown) {
      const msg = err instanceof Error ? this.sanitizeError(err.message) : String(err);
      if (msg.includes('LIMIT_MIN')) {
        throw new RouterError(
          DomainErrorCode.AMOUNT_BELOW_MINIMUM,
          'Amount is below provider live minimum',
          { requestedAmountAtomic: sourceAmountAtomic, asset: sourceAsset, network: sourceNetwork }
        );
      }
      if (msg.includes('MAINTENANCE')) {
        throw new RouterError(
          DomainErrorCode.PROVIDER_MAINTENANCE,
          'Provider is under maintenance for this route',
          { asset: sourceAsset, network: sourceNetwork }
        );
      }
      throw err;
    }

    if (response.errors && response.errors.length > 0) {
      if (response.errors.includes('LIMIT_MIN')) {
        const minAtomic = this.decimalToAtomic(response.from.min.toString(), 8);
        throw new RouterError(
          DomainErrorCode.AMOUNT_BELOW_MINIMUM,
          `Amount ${sourceAmountAtomic} is below live minimum ${minAtomic}`,
          {
            requestedAmountAtomic: sourceAmountAtomic,
            minimumAmountAtomic: minAtomic,
            asset: sourceAsset,
            network: sourceNetwork,
          }
        );
      }
      if (
        response.errors.includes('MAINTENANCE_FROM') ||
        response.errors.includes('MAINTENANCE_TO')
      ) {
        throw new RouterError(
          DomainErrorCode.PROVIDER_MAINTENANCE,
          `Provider maintenance: ${response.errors.join(', ')}`,
          { asset: sourceAsset, network: sourceNetwork }
        );
      }
    }

    const settleAmountAtomic = this.decimalToAtomic(response.to.amount.toString(), 6);
    const minDepositAtomic = this.decimalToAtomic(response.from.min.toString(), 8);
    const maxDepositAtomic = this.decimalToAtomic(response.from.max.toString(), 8);

    const now = Date.now();
    const expiresAt = new Date(now + 10 * 60 * 1000).toISOString(); // FixedFloat quote valid ~10 min
    const quoteId = `ff_${now}_${Math.random().toString(36).slice(2, 7)}`;

    return {
      quoteId,
      providerId: this.id,
      edgeId: this.id,
      sourceAsset,
      sourceNetwork,
      targetAsset,
      targetNetwork,
      sourceNode: this.sourceNode,
      destinationNode: this.destinationNode,
      depositAmountAtomic: sourceAmountAtomic,
      inputAmountAtomic: sourceAmountAtomic,
      settleAmountAtomic,
      estimatedOutputAmountAtomic: settleAmountAtomic,
      rate: response.to.rate.toString(),
      networkFeeEstimatedAtomic: '0', // Embedded in FixedFloat rate
      minDepositAtomic,
      minAmountAtomic: minDepositAtomic,
      maxDepositAtomic,
      maxAmountAtomic: maxDepositAtomic,
      expiresAt,
      edgeClass: this.edgeClass,
      executionClass: this.executionClass,
      rawQuote: response as unknown as Record<string, unknown>,
    };
  }

  /**
   * Directly queries the /price endpoint with specific amount and rate type
   */
  public async getPriceDetails(
    fromCcy: string,
    toCcy: string,
    amountDecimal: number,
    type: 'float' | 'fixed' = 'float'
  ): Promise<{
    from: { ccy: string; coin: string; network: string; amount: number; rate: number; min: number; max: number };
    to: { ccy: string; coin: string; network: string; amount: number; rate: number; min: number; max: number };
    errors?: string[];
  }> {
    return await this.postRequest('/price', {
      fromCcy,
      toCcy,
      amount: amountDecimal,
      direction: 'from',
      type,
    });
  }

  /**
   * Creates an execution order on FixedFloat.
   * PASSIVE_DEPOSIT: Only returns a Lightning invoice or deposit address.
   * Zero funds move upon order creation.
   * Supports both legacy CreateExecutionRequest and Architecture V3 ExecutionPlan.
   */
  public async createExecution(
    requestOrPlan: CreateExecutionRequest | ExecutionPlan,
    _idempotencyKey?: string
  ): Promise<ProviderExecutionResult> {
    const isPlan = 'planId' in requestOrPlan;
    const destAddress = isPlan
      ? requestOrPlan.destinationAddress
      : requestOrPlan.intent.destinationAddress;
    const sourceAsset = isPlan
      ? requestOrPlan.quoteSnapshot.sourceNode.asset
      : requestOrPlan.intent.sourceAsset;
    const sourceNetwork = isPlan
      ? requestOrPlan.quoteSnapshot.sourceNode.network
      : requestOrPlan.intent.sourceNetwork;
    const targetAsset = isPlan
      ? requestOrPlan.quoteSnapshot.destinationNode.asset
      : requestOrPlan.intent.targetAsset;
    const targetNetwork = isPlan
      ? requestOrPlan.quoteSnapshot.destinationNode.network
      : requestOrPlan.intent.targetNetwork;
    const sourceAmountAtomic = isPlan
      ? requestOrPlan.quoteSnapshot.inputAmountAtomic
      : requestOrPlan.intent.sourceAmountAtomic;

    const fromCcy = this.toFixedFloatCcy(sourceAsset, sourceNetwork);
    const toCcy = this.toFixedFloatCcy(targetAsset, targetNetwork);

    const satoshis = BigInt(sourceAmountAtomic);
    const fromAmountDecimal = this.atomicToDecimal(satoshis, 8);

    const payload = {
      fromCcy,
      toCcy,
      toAddress: destAddress,
      amount: parseFloat(fromAmountDecimal),
      direction: 'from',
      type: 'float',
    };

    let response: {
      id: string;
      token: string;
      type: string;
      status: string;
      from: {
        address: string; // Lightning invoice (lnbc...) or BTC address
        tag: string | null;
        amount: number;
      };
      to: {
        address: string;
        amount: number;
      };
      errors?: string[];
    };

    try {
      response = await this.postRequest('/create', payload);
    } catch (err: unknown) {
      const msg = err instanceof Error ? this.sanitizeError(err.message) : String(err);
      if (msg.includes('LIMIT_MIN')) {
        throw new RouterError(
          DomainErrorCode.AMOUNT_BELOW_MINIMUM,
          'Amount is below provider live minimum',
          { requestedAmountAtomic: sourceAmountAtomic }
        );
      }
      if (msg.includes('MAINTENANCE')) {
        throw new RouterError(
          DomainErrorCode.PROVIDER_MAINTENANCE,
          'FixedFloat currency is temporarily under maintenance'
        );
      }
      throw err;
    }

    if (response.errors && response.errors.length > 0) {
      if (response.errors.includes('LIMIT_MIN')) {
        throw new RouterError(
          DomainErrorCode.AMOUNT_BELOW_MINIMUM,
          'Amount is below provider live minimum',
          { requestedAmountAtomic: sourceAmountAtomic }
        );
      }
      if (
        response.errors.includes('MAINTENANCE_FROM') ||
        response.errors.includes('MAINTENANCE_TO')
      ) {
        throw new RouterError(
          DomainErrorCode.PROVIDER_MAINTENANCE,
          `FixedFloat maintenance: ${response.errors.join(', ')}`
        );
      }
    }

    return {
      providerExecutionId: response.id,
      orderToken: response.token, // SENSITIVE: order token required for status queries
      depositAddress: response.from.address,
      depositAmountAtomic: sourceAmountAtomic,
      settleAddress: destAddress,
      status: response.status,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      rawResponse: {
        id: response.id,
        status: response.status,
        fromAddress: response.from.address,
      },
    };
  }

  /**
   * Queries status of an existing order.
   * Requires both order ID and secret order token.
   */
  public async getStatus(
    providerExecutionId: string,
    orderToken?: string
  ): Promise<NormalizedProviderStatus> {
    if (!orderToken) {
      return {
        status: ProviderNormalizedStatus.UNKNOWN,
        depositTxId: null,
        settleTxId: null,
        settleAmountActualAtomic: null,
        failureReason: 'FixedFloat order lookup requires both order ID and order token',
        raw: {},
      };
    }

    const payload = {
      id: providerExecutionId,
      token: orderToken,
    };

    const response = await this.postRequest<{
      id: string;
      token: string;
      status: string;
      from: {
        amount: number;
        tx?: { id?: string } | null;
      };
      to: {
        amount: number;
        tx?: { id?: string } | null;
      };
      errors?: string[];
    }>('/order', payload);

    const normalizedStatus = this.mapFixedFloatStatus(response.status);
    const depositTxId = response.from?.tx?.id ?? null;
    const settleTxId = response.to?.tx?.id ?? null;
    const settleAmountActualAtomic = response.to?.amount
      ? this.decimalToAtomic(response.to.amount.toString(), 6)
      : null;

    return {
      status: normalizedStatus,
      depositTxId,
      settleTxId,
      settleAmountActualAtomic,
      failureReason: null,
      raw: {
        id: response.id,
        status: response.status,
      },
    };
  }

  /**
   * Programmatic refund trigger via FixedFloat emergency endpoint
   */
  public async requestRefund(
    providerExecutionId: string,
    refundAddress: string,
    orderToken?: string
  ): Promise<RefundResult> {
    if (!orderToken) {
      return { success: false, reason: 'Missing secret orderToken for emergency action' };
    }

    const payload = {
      id: providerExecutionId,
      token: orderToken,
      choice: 'REFUND',
      address: refundAddress,
    };

    try {
      const result = await this.postRequest<{ id: string; status: string }>(
        '/emergency',
        payload
      );
      return { success: true, refundTxId: result.status };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, reason: msg };
    }
  }

  /**
   * Explicit status mapping from FixedFloat API statuses to normalized router statuses
   */
  public mapFixedFloatStatus(status: string): ProviderNormalizedStatus {
    const s = status.toUpperCase();
    switch (s) {
      case 'NEW':
        return ProviderNormalizedStatus.WAITING_FOR_DEPOSIT;
      case 'PENDING':
        return ProviderNormalizedStatus.DEPOSIT_RECEIVED;
      case 'EXCHANGE':
        return ProviderNormalizedStatus.PROCESSING;
      case 'WITHDRAW':
        return ProviderNormalizedStatus.SETTLING;
      case 'DONE':
        return ProviderNormalizedStatus.COMPLETED;
      case 'EXPIRED':
        return ProviderNormalizedStatus.EXPIRED;
      case 'EMERGENCY':
      case 'REFUND':
        return ProviderNormalizedStatus.REFUNDED;
      default:
        // Conservative mapping: unknown status never becomes FAILED automatically
        return ProviderNormalizedStatus.UNKNOWN;
    }
  }

  /**
   * Internal authenticated HTTP POST request with HMAC-SHA256 signing and secret redaction
   */
  private async postRequest<T>(
    endpoint: string,
    payload: Record<string, unknown>
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const bodyStr = JSON.stringify(payload);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json; charset=UTF-8',
      Accept: 'application/json',
      'User-Agent': 'UniversalAgentAssetRouter/0.2.0',
    };

    // If API credentials are provided, sign the payload
    if (this.apiKey && this.apiSecret) {
      const signature = createHmac('sha256', this.apiSecret)
        .update(bodyStr)
        .digest('hex');

      headers['X-API-KEY'] = this.apiKey;
      headers['X-API-SIGN'] = signature;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: bodyStr,
        signal: controller.signal,
      });

      const responseText = await response.text();

      if (!response.ok) {
        throw new Error(
          `FixedFloat HTTP ${response.status}: ${this.sanitizeError(responseText)}`
        );
      }

      let parsed: { code: number; msg: string; data: T };
      try {
        parsed = JSON.parse(responseText);
      } catch {
        throw new Error(`FixedFloat invalid JSON response: ${this.sanitizeError(responseText)}`);
      }

      if (parsed.code !== 0) {
        throw new Error(`FixedFloat API Error [${parsed.code}]: ${parsed.msg}`);
      }

      return parsed.data;
    } catch (err: unknown) {
      if (err instanceof Error) {
        if (err.name === 'AbortError') {
          throw new Error(`FixedFloat request timed out after ${this.timeoutMs}ms`);
        }
        throw new Error(this.sanitizeError(err.message));
      }
      throw new Error(this.sanitizeError(String(err)));
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Sanitizes all thrown errors to ensure API keys and secrets can never be leaked
   */
  public sanitizeError(message: string): string {
    let sanitized = message;
    if (this.apiSecret) {
      sanitized = sanitized.replaceAll(this.apiSecret, '[REDACTED_SECRET]');
    }
    if (this.apiKey) {
      sanitized = sanitized.replaceAll(this.apiKey, '[REDACTED_KEY]');
    }
    return sanitized;
  }

  public atomicToDecimal(amountAtomic: bigint, decimals: number): string {
    const factor = 10n ** BigInt(decimals);
    const whole = amountAtomic / factor;
    const frac = amountAtomic % factor;
    const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
    return fracStr.length > 0 ? `${whole}.${fracStr}` : whole.toString();
  }

  public decimalToAtomic(amountDecimal: string, decimals: number): string {
    const [wholeStr = '0', fracStr = ''] = amountDecimal.split('.');
    const paddedFrac = fracStr.padEnd(decimals, '0').slice(0, decimals);
    const whole = BigInt(wholeStr);
    const frac = BigInt(paddedFrac);
    return (whole * 10n ** BigInt(decimals) + frac).toString();
  }
}
