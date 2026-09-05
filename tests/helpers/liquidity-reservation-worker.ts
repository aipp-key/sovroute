import { SqlitePersistence } from '../../src/persistence/sqlite.ts';
import {
  AtomicCoordinator,
  BASE_SEPOLIA_FINALITY_POLICY,
} from '../../src/atomic/coordinator/coordinator.ts';
import { FakeLightningAtomicBackend } from '../../src/atomic/lightning/fake-backend.ts';
import { FakeEvmAtomicBackend } from '../../src/atomic/evm/fake-backend.ts';
import { SqliteLiquidityInventory } from '../../src/atomic/liquidity/sqlite-inventory.ts';

export interface WorkerInitMessage {
  type: 'INIT';
  dbPath: string;
  tokenAddress: string;
  executionId: string;
  amountUnits: string; // serialized bigint
  amountSats?: string; // serialized bigint
  hashLock?: string;
  mode: 'direct' | 'coordinator';
}

export interface WorkerStartMessage {
  type: 'START';
}

let config: WorkerInitMessage | null = null;
let persistence: SqlitePersistence | null = null;

process.on('message', async (msg: WorkerInitMessage | WorkerStartMessage) => {
  if (msg.type === 'INIT') {
    config = msg;
    persistence = new SqlitePersistence({ filename: config.dbPath });
    persistence.enableLegacyFallbackForTesting();
    if (process.send) {
      process.send({
        type: 'READY',
        pid: process.pid,
        executionId: config.executionId,
      });
    }
    return;
  }

  if (msg.type === 'START' && config && persistence) {
    const { mode, executionId, tokenAddress, amountUnits } = config;
    const requestedUnits = BigInt(amountUnits);

    if (mode === 'direct') {
      try {
        const result = persistence.reserveLiquidity(executionId, tokenAddress, requestedUnits);
        if (process.send) {
          process.send({
            type: 'RESULT',
            pid: process.pid,
            executionId,
            success: result.reserved,
            reservationId: result.reservationId || null,
            error: result.reserved ? null : 'INSUFFICIENT_OPERATOR_INVENTORY',
            invoiceCreated: false,
          });
        }
      } catch (err: any) {
        if (process.send) {
          process.send({
            type: 'RESULT',
            pid: process.pid,
            executionId,
            success: false,
            reservationId: null,
            error: err.message,
            invoiceCreated: false,
          });
        }
      } finally {
        persistence.close();
        process.exit(0);
      }
    } else if (mode === 'coordinator') {
      const lightning = new FakeLightningAtomicBackend();
      const evm = new FakeEvmAtomicBackend();
      const inventory = new SqliteLiquidityInventory(persistence);
      const coordinator = new AtomicCoordinator(lightning, evm, inventory, {
        persistence,
        finalityPolicy: BASE_SEPOLIA_FINALITY_POLICY,
      });

      const hashLock = config.hashLock || '0x' + '1'.repeat(64);
      const amountSats = BigInt(config.amountSats || '100000');
      let invoiceCreated = false;

      try {
        const prepared = await coordinator.prepareSwap({
          idempotencyKey: `cross_idem_${executionId}`,
          hashLock,
          amountSats,
          expectedUsdcAmount: requestedUnits,
          claimingAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
          targetDestinationAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        });

        invoiceCreated = !!prepared.holdInvoice;

        if (process.send) {
          process.send({
            type: 'RESULT',
            pid: process.pid,
            executionId: prepared.id,
            success: true,
            reservationId: prepared.reservationId,
            error: null,
            invoiceCreated,
          });
        }
      } catch (err: any) {
        // Check if invoice was created in lightning backend
        const pHash = hashLock.replace(/^0x/, '').toLowerCase();
        try {
          const inv = await lightning.getInvoiceState(pHash);
          invoiceCreated = inv === 'OPEN';
        } catch {
          invoiceCreated = false;
        }

        if (process.send) {
          process.send({
            type: 'RESULT',
            pid: process.pid,
            executionId,
            success: false,
            reservationId: null,
            error: err.message,
            invoiceCreated,
          });
        }
      } finally {
        persistence.close();
        process.exit(0);
      }
    }
  }
});
