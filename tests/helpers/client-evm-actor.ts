/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * External Client EVM Actor (Test-Side Component)
 *
 * CRITICAL ARCHITECTURAL BOUNDARY:
 * This component represents the external sovereign client/agent.
 * It lives strictly OUTSIDE Router core.
 *
 * Responsibilities:
 * - Owns disposable client EVM private key (Account 1 on Hardhat devnet)
 * - Generates and securely holds preimage S
 * - Constructs, signs, and broadcasts claim transactions directly to the EVM RPC node
 * - NEVER shares private keys or S with the Router prior to on-chain confirmation
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  createPublicClient,
  createWalletClient,
  http,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { hardhat } from 'viem/chains';

export interface GeneratedSwapSecret {
  preimage: Buffer;
  preimageHex: `0x${string}`;
  preimageRawHex: string;
  hashLock: `0x${string}`;
}

export class ClientEvmActor {
  private readonly walletClient: WalletClient;
  private readonly publicClient: PublicClient;
  public readonly accountAddress: `0x${string}`;

  constructor(
    privateKey: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    rpcUrl: string = 'http://127.0.0.1:8545'
  ) {
    const account = privateKeyToAccount(privateKey);
    this.accountAddress = account.address;

    this.publicClient = createPublicClient({
      chain: hardhat,
      transport: http(rpcUrl),
    });

    this.walletClient = createWalletClient({
      account,
      chain: hardhat,
      transport: http(rpcUrl),
    });
  }

  /**
   * Generates a cryptographically secure 32-byte secret preimage S and its SHA-256 hash H.
   * Client retains S privately. Only H is shared with Router for hold invoice creation.
   */
  public generateSecret(): GeneratedSwapSecret {
    const preimage = randomBytes(32);
    const hash = createHash('sha256').update(preimage).digest('hex');
    return {
      preimage,
      preimageHex: `0x${preimage.toString('hex')}` as `0x${string}`,
      preimageRawHex: preimage.toString('hex'),
      hashLock: `0x${hash}` as `0x${string}`,
    };
  }

  /**
   * Client signs and broadcasts the claim transaction directly to the EVM node.
   * Router has zero involvement in this submission.
   */
  public async claimHtlc(params: {
    htlcAddress: `0x${string}`;
    htlcAbi: any;
    htlcId: `0x${string}`;
    preimage: `0x${string}`;
  }): Promise<{ txHash: `0x${string}`; blockNumber: number; status: 'success' | 'reverted' }> {
    const txHash = await this.walletClient.writeContract({
      account: this.walletClient.account!,
      chain: hardhat,
      address: params.htlcAddress,
      abi: params.htlcAbi,
      functionName: 'claim',
      args: [params.htlcId, params.preimage],
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    return {
      txHash,
      blockNumber: Number(receipt.blockNumber),
      status: receipt.status,
    };
  }

  /**
   * Intentionally submits an invalid claim to test adversarial / mempool conditions.
   * E.g. targets wrong HTLC ID or wrong preimage, causing contract revert.
   * Calldata with preimage S is broadcast, but on-chain state does NOT transition to CLAIMED.
   */
  public async submitFailingClaim(params: {
    htlcAddress: `0x${string}`;
    htlcAbi: any;
    htlcId: `0x${string}`;
    preimage: `0x${string}`;
  }): Promise<{ txHash: `0x${string}`; status: 'reverted' }> {
    // Send raw transaction directly to bypass client-side simulation so the tx is included in block as reverted
    const { encodeFunctionData } = await import('viem');
    const data = encodeFunctionData({
      abi: params.htlcAbi,
      functionName: 'claim',
      args: [params.htlcId, params.preimage],
    });

    try {
      const txHash = await this.walletClient.sendTransaction({
        account: this.walletClient.account!,
        chain: hardhat,
        to: params.htlcAddress,
        data,
        gas: 200_000n,
      });
      await this.publicClient.waitForTransactionReceipt({ hash: txHash });
      return { txHash, status: 'reverted' };
    } catch (err: any) {
      // If Hardhat rejects before mining in automine mode, derive the attempted tx or simulation error
      throw err;
    }
  }
}
