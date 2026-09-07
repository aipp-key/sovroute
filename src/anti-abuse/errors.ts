/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Anti-Abuse & Rate-Limiting Error Definitions
 */

export class WalletCooldownActiveError extends Error {
  public readonly remainingCooldownMs: number;

  constructor(walletAddress: string, remainingMs: number) {
    super(
      `WALLET_COOLDOWN_ACTIVE: Wallet '${walletAddress}' must wait ${Math.ceil(
        remainingMs / 1000
      )}s before submitting another swap (60s policy cooldown).`
    );
    this.name = 'WalletCooldownActiveError';
    this.remainingCooldownMs = remainingMs;
  }
}

export class RollingVolumeLimitExceededError extends Error {
  public readonly currentVolume: bigint;
  public readonly requestedVolume: bigint;
  public readonly limit: bigint;

  constructor(walletAddress: string, currentVolume: bigint, requestedVolume: bigint, limit: bigint) {
    super(
      `ROLLING_VOLUME_LIMIT_EXCEEDED: Wallet '${walletAddress}' rolling 24h volume (${currentVolume}) plus requested (${requestedVolume}) exceeds limit (${limit} atomic USDC = $500).`
    );
    this.name = 'RollingVolumeLimitExceededError';
    this.currentVolume = currentVolume;
    this.requestedVolume = requestedVolume;
    this.limit = limit;
  }
}

export class DestinationVolumeLimitExceededError extends Error {
  constructor(destinationAddress: string, currentVolume: bigint, requestedVolume: bigint, limit: bigint) {
    super(
      `DESTINATION_VOLUME_LIMIT_EXCEEDED: Destination '${destinationAddress}' rolling 24h volume (${currentVolume}) plus requested (${requestedVolume}) exceeds limit (${limit} atomic USDC).`
    );
    this.name = 'DestinationVolumeLimitExceededError';
  }
}

export class GlobalCapacityExceededError extends Error {
  constructor(globalVolume: bigint, limit: bigint) {
    super(
      `GLOBAL_CAPACITY_EXCEEDED: System-wide rolling 24h volume (${globalVolume}) exceeds daily beta cap (${limit} atomic USDC).`
    );
    this.name = 'GlobalCapacityExceededError';
  }
}

export class ConcurrentExposureLimitExceededError extends Error {
  constructor(inFlightVolume: bigint, limit: bigint) {
    super(
      `CONCURRENT_EXPOSURE_LIMIT_EXCEEDED: In-flight active swap exposure (${inFlightVolume}) exceeds concurrency ceiling (${limit} atomic USDC). Please wait for active swaps to settle.`
    );
    this.name = 'ConcurrentExposureLimitExceededError';
  }
}

export class IdempotencyConflictError extends Error {
  constructor(idempotencyKey: string, details: string) {
    super(`IDEMPOTENCY_CONFLICT: Key '${idempotencyKey}' was previously used with different parameters. Details: ${details}`);
    this.name = 'IdempotencyConflictError';
  }
}
