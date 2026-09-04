import {
  type IExecutionProvider,
  type NormalizedIntent,
  type NormalizedQuote,
  type CreateExecutionRequest,
  type ProviderExecutionResult,
  type NormalizedProviderStatus,
  ProviderNormalizedStatus,
  type ProviderCapabilities,
  ExecutionClass,
} from '../domain/types.ts';

export interface SideShiftConfig {
  baseUrl?: string | undefined;
  secret?: string | undefined; // Optional for read-only quotes
  affiliateId?: string | undefined;
  timeoutMs?: number | undefined;
}

export class SideShiftAdapter implements IExecutionProvider {
  public readonly id = 'sideshift';
  public readonly name = 'SideShift.ai V2';

  private baseUrl: string;
  private secret?: string | undefined;
  private affiliateId?: string | undefined;
  private timeoutMs: number;

  constructor(config: SideShiftConfig = {}) {
    this.baseUrl = config.baseUrl ?? 'https://sideshift.ai/api/v2';
    this.secret = config.secret;
    this.affiliateId = config.affiliateId;
    this.timeoutMs = config.timeoutMs ?? 10000;
  }

  public async capabilities(): Promise<ProviderCapabilities> {
    return {
      supportedPairs: [
        {
          sourceAsset: 'BTC',
          sourceNetwork: 'bitcoin',
          targetAsset: 'USDC',
          targetNetwork: 'base',
          minAmountAtomic: '3844', // ~0.00003844 BTC
          maxAmountAtomic: '27000000', // ~0.27 BTC
        },
        {
          sourceAsset: 'BTC',
          sourceNetwork: 'liquid',
          targetAsset: 'USDC',
          targetNetwork: 'base',
          minAmountAtomic: '3844',
          maxAmountAtomic: '27000000',
        },
      ],
      supportsLightning: false, // Currently disabled/periodically available in V2 coins
      supportsRefunds: true, // SideShift supports refund to on-chain BTC address
      supportsStrongIdempotency: false, // SideShift does not support lookup by externalId/idempotencyKey
      executionClass: ExecutionClass.PASSIVE_DEPOSIT,
    };
  }

  /**
   * Fetches real-time quote from SideShift without requiring API key
   */
  public async getQuote(intent: NormalizedIntent): Promise<NormalizedQuote> {
    const depositMethod = `${intent.sourceAsset.toLowerCase()}-${intent.sourceNetwork.toLowerCase()}`;
    const settleMethod = `${intent.targetAsset.toLowerCase()}-${intent.targetNetwork.toLowerCase()}`;
    const url = `${this.baseUrl}/pair/${depositMethod}/${settleMethod}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'UniversalAgentAssetRouter/0.1.0',
          Accept: 'application/json',
        },
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(
          `SideShift pair query failed HTTP ${res.status}: ${errorText}`
        );
      }

      const data = (await res.json()) as {
        min: string;
        max: string;
        rate: string;
        depositCoin: string;
        settleCoin: string;
        depositNetwork: string;
        settleNetwork: string;
      };

      // Calculate settle amount based on atomic units
      // BTC has 8 decimals (1 BTC = 100,000,000 sats)
      // USDC on Base has 6 decimals (1 USDC = 1,000,000 micro-units)
      const sats = BigInt(intent.sourceAmountAtomic);
      const rateFloat = parseFloat(data.rate);
      // microUSDC = (sats / 100,000,000) * rateFloat * 1,000,000 = (sats * rateFloat) / 100
      const estimatedSettleMicroUsdc = BigInt(
        Math.floor((Number(sats) * rateFloat) / 100)
      );

      const minSats = BigInt(Math.ceil(parseFloat(data.min) * 1e8));
      const maxSats = BigInt(Math.floor(parseFloat(data.max) * 1e8));

      return {
        quoteId: `ss_pair_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        providerId: this.id,
        sourceAsset: data.depositCoin,
        sourceNetwork: data.depositNetwork,
        targetAsset: data.settleCoin,
        targetNetwork: data.settleNetwork,
        depositAmountAtomic: intent.sourceAmountAtomic,
        settleAmountAtomic: estimatedSettleMicroUsdc.toString(),
        rate: data.rate,
        networkFeeEstimatedAtomic: '0', // SideShift embeds network fee in the rate
        minDepositAtomic: minSats.toString(),
        maxDepositAtomic: maxSats.toString(),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        rawQuote: data as unknown as Record<string, unknown>,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Creates execution order with SideShift (requires x-sideshift-secret for partner execution)
   */
  public async createExecution(
    request: CreateExecutionRequest
  ): Promise<ProviderExecutionResult> {
    const url = `${this.baseUrl}/shifts/variable`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'UniversalAgentAssetRouter/0.1.0',
    };

    if (this.secret) {
      headers['x-sideshift-secret'] = this.secret;
    }

    const body = {
      depositCoin: request.intent.sourceAsset,
      depositNetwork: request.intent.sourceNetwork,
      settleCoin: request.intent.targetAsset,
      settleNetwork: request.intent.targetNetwork,
      settleAddress: request.intent.destinationAddress,
      refundAddress: request.intent.refundAddress,
      affiliateId: this.affiliateId,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`SideShift create shift failed HTTP ${res.status}: ${errText}`);
      }

      const data = (await res.json()) as {
        id: string;
        depositAddress: { address: string };
        settleAddress: { address: string };
        status: string;
        expiresAt: string;
      };

      return {
        providerExecutionId: data.id,
        depositAddress: data.depositAddress.address,
        depositAmountAtomic: request.intent.sourceAmountAtomic,
        settleAddress: data.settleAddress.address,
        status: data.status,
        expiresAt: data.expiresAt,
        rawResponse: data as unknown as Record<string, unknown>,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Query status of an existing SideShift order
   */
  public async getStatus(
    providerExecutionId: string
  ): Promise<NormalizedProviderStatus> {
    const url = `${this.baseUrl}/shifts/${providerExecutionId}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'UniversalAgentAssetRouter/0.1.0',
        },
      });

      if (!res.ok) {
        if (res.status === 404) {
          return {
            status: ProviderNormalizedStatus.UNKNOWN,
            depositTxId: null,
            settleTxId: null,
            settleAmountActualAtomic: null,
            failureReason: 'Shift not found on SideShift',
            raw: {},
          };
        }
        const err = await res.text();
        throw new Error(`SideShift getStatus HTTP ${res.status}: ${err}`);
      }

      const data = (await res.json()) as {
        id: string;
        status: string;
        depositHash?: string;
        settleHash?: string;
        settleAmount?: string;
        reason?: string;
      };

      const normalizedStatus = this.mapStatus(data.status);
      const settleAmountAtomic = data.settleAmount
        ? BigInt(Math.floor(parseFloat(data.settleAmount) * 1e6)).toString()
        : null;

      return {
        status: normalizedStatus,
        depositTxId: data.depositHash ?? null,
        settleTxId: data.settleHash ?? null,
        settleAmountActualAtomic: settleAmountAtomic,
        failureReason: data.reason ?? null,
        raw: data as unknown as Record<string, unknown>,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private mapStatus(status: string): ProviderNormalizedStatus {
    switch (status.toLowerCase()) {
      case 'waiting':
        return ProviderNormalizedStatus.WAITING_FOR_DEPOSIT;
      case 'pending':
        return ProviderNormalizedStatus.DEPOSIT_RECEIVED;
      case 'processing':
        return ProviderNormalizedStatus.PROCESSING;
      case 'settling':
        return ProviderNormalizedStatus.SETTLING;
      case 'settled':
        return ProviderNormalizedStatus.COMPLETED;
      case 'refund':
      case 'refunded':
        return ProviderNormalizedStatus.REFUNDED;
      case 'expired':
        return ProviderNormalizedStatus.EXPIRED;
      default:
        return ProviderNormalizedStatus.UNKNOWN;
    }
  }
}
