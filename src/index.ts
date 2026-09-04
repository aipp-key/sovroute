/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Core Library & Production Entrypoint
 */

export {
  bootstrapProductionRouter,
  type ProductionBootstrapOptions,
  type ProductionBootstrapResult,
  MissingInventoryError,
} from './bootstrap.ts';

export {
  ProductionConfigValidator,
  CriticalMainnetForbiddenError,
  ProductionConfigError,
  type RouterProductionConfig,
} from './config/production-config.ts';

export {
  HealthService,
  type HealthStatus,
  type HealthReport,
  type ComponentStatus,
} from './health/health-service.ts';

export {
  BackupService,
  BackupRestoreError,
  type BackupMetadata,
  type RestoreResult,
} from './persistence/backup.ts';

export { SqlitePersistence } from './persistence/sqlite.ts';
export { AtomicCoordinator } from './atomic/coordinator/coordinator.ts';
