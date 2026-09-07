/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Gasless Base UX Domain Errors (Fail-Closed)
 */

export class GaslessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GaslessError';
  }
}

export class InvalidSignatureError extends GaslessError {
  constructor(message: string) {
    super(`INVALID_SIGNATURE: ${message}`);
    this.name = 'InvalidSignatureError';
  }
}

export class SignatureExpiredError extends GaslessError {
  public readonly deadline: bigint;
  public readonly nowSeconds: bigint;

  constructor(deadline: bigint, nowSeconds: bigint) {
    super(`SIGNATURE_EXPIRED: Deadline ${deadline} has expired (current time: ${nowSeconds}).`);
    this.name = 'SignatureExpiredError';
    this.deadline = deadline;
    this.nowSeconds = nowSeconds;
  }
}

export class InvalidNonceError extends GaslessError {
  public readonly expectedNonce: bigint;
  public readonly receivedNonce: bigint;

  constructor(expectedNonce: bigint, receivedNonce: bigint) {
    super(`INVALID_NONCE: Expected nonce ${expectedNonce}, received ${receivedNonce}.`);
    this.name = 'InvalidNonceError';
    this.expectedNonce = expectedNonce;
    this.receivedNonce = receivedNonce;
  }
}

export class QuoteAlreadyConsumedError extends GaslessError {
  public readonly quoteId: string;

  constructor(quoteId: string) {
    super(`QUOTE_ALREADY_CONSUMED: Quote '${quoteId}' has already been consumed and cannot be reused.`);
    this.name = 'QuoteAlreadyConsumedError';
    this.quoteId = quoteId;
  }
}

export class AuthorizationParameterMismatchError extends GaslessError {
  public readonly field: string;
  public readonly expected: string;
  public readonly received: string;

  constructor(field: string, expected: string, received: string) {
    super(`PARAM_MISMATCH: Authorization field '${field}' mismatch. Expected ${expected}, got ${received}.`);
    this.name = 'AuthorizationParameterMismatchError';
    this.field = field;
    this.expected = expected;
    this.received = received;
  }
}

export class ChainIdMismatchError extends GaslessError {
  public readonly expectedChainId: number | bigint;
  public readonly receivedChainId: number | bigint;

  constructor(expectedChainId: number | bigint, receivedChainId: number | bigint) {
    super(`CHAIN_ID_MISMATCH: Expected chain ID ${expectedChainId}, got ${receivedChainId}.`);
    this.name = 'ChainIdMismatchError';
    this.expectedChainId = expectedChainId;
    this.receivedChainId = receivedChainId;
  }
}

export class VerifyingContractMismatchError extends GaslessError {
  public readonly expectedContract: string;
  public readonly receivedContract: string;

  constructor(expectedContract: string, receivedContract: string) {
    super(`VERIFYING_CONTRACT_MISMATCH: Expected ${expectedContract}, got ${receivedContract}.`);
    this.name = 'VerifyingContractMismatchError';
    this.expectedContract = expectedContract;
    this.receivedContract = receivedContract;
  }
}

export class AmbiguousBroadcastError extends GaslessError {
  public readonly txHash: string;
  public readonly reason: string;

  constructor(txHash: string, reason: string) {
    super(`AMBIGUOUS_BROADCAST: Transaction ${txHash} broadcasted but confirmation timed out (${reason}). Refusing blind retry.`);
    this.name = 'AmbiguousBroadcastError';
    this.txHash = txHash;
    this.reason = reason;
  }
}

export class RelayerExecutionRevertedError extends GaslessError {
  public readonly txHash: string;

  constructor(txHash: string) {
    super(`RELAYER_EXECUTION_REVERTED: Transaction ${txHash} reverted on-chain.`);
    this.name = 'RelayerExecutionRevertedError';
    this.txHash = txHash;
  }
}
