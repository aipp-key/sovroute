import {
  type AssetNode,
  type IExecutionEdge,
  type RouteQuote,
  type ExecutionPlan,
  type EdgeRuntimeAvailability,
  DomainErrorCode,
  RouterError,
  assetNodeToString,
  EdgeClass,
} from '../domain/types.ts';
import { randomUUID } from 'node:crypto';

export type RoutingPolicy = 'FASTEST' | 'CHEAPEST' | 'TRUST_MINIMIZED' | 'BALANCED';

export interface RouteCandidate {
  routeId: string;
  edges: IExecutionEdge[];
  sourceNode: AssetNode;
  destinationNode: AssetNode;
  availability: EdgeRuntimeAvailability;
}

export class RoutePlanner {
  private edges: Map<string, IExecutionEdge> = new Map();

  constructor(initialEdges: IExecutionEdge[] = []) {
    for (const edge of initialEdges) {
      this.registerEdge(edge);
    }
  }

  public registerEdge(edge: IExecutionEdge): void {
    this.edges.set(edge.id, edge);
  }

  public getEdge(id: string): IExecutionEdge | undefined {
    return this.edges.get(id);
  }

  public getAllEdges(): IExecutionEdge[] {
    return Array.from(this.edges.values());
  }

  /**
   * Discovers and evaluates candidate routes.
   * Deterministic filtering:
   * 1. Static route compatibility
   * 2. Runtime availability & maintenance check
   * 3. Dynamic minimum and maximum amount bounds
   *
   * NEVER returns an unavailable or out-of-bounds edge as executable.
   */
  public async findRoutes(
    source: AssetNode,
    destination: AssetNode,
    amountAtomic: string,
    policy: RoutingPolicy = 'BALANCED'
  ): Promise<RouteCandidate[]> {
    const amount = BigInt(amountAtomic);

    // 1. Static eligibility filter
    const matchingEdges = Array.from(this.edges.values()).filter((edge) =>
      edge.supportsRoute(source, destination)
    );

    if (matchingEdges.length === 0) {
      throw new RouterError(
        DomainErrorCode.ROUTE_NOT_FOUND,
        `No route found from ${assetNodeToString(source)} to ${assetNodeToString(destination)}`,
        { source: assetNodeToString(source), destination: assetNodeToString(destination) }
      );
    }

    // 2. Query dynamic runtime availability for candidate edges
    const candidates: RouteCandidate[] = [];
    let lastMaintenanceReason: string | undefined;
    let lastUnavailableReason: string | undefined;
    let lastMinAmount: string | undefined;
    let lastMaxAmount: string | undefined;

    for (const edge of matchingEdges) {
      const availability = await edge.getRuntimeAvailability();

      // Check maintenance
      if (availability.isMaintenance) {
        lastMaintenanceReason = availability.reason ?? 'Route edge is currently under maintenance';
        continue;
      }

      // Check general availability and recv capability
      if (!availability.isAvailable || !availability.recvEnabled) {
        lastUnavailableReason = availability.reason ?? 'Route edge is currently unavailable';
        continue;
      }

      // Check dynamic minimum
      const minAmount = BigInt(availability.minAmountAtomic);
      if (amount < minAmount) {
        lastMinAmount = availability.minAmountAtomic;
        continue;
      }

      // Check dynamic maximum (if defined)
      if (availability.maxAmountAtomic) {
        const maxAmount = BigInt(availability.maxAmountAtomic);
        if (amount > maxAmount) {
          lastMaxAmount = availability.maxAmountAtomic;
          continue;
        }
      }

      candidates.push({
        routeId: `route_${randomUUID().replace(/-/g, '')}`,
        edges: [edge],
        sourceNode: source,
        destinationNode: destination,
        availability,
      });
    }

    // If all candidates were disqualified, report specific deterministic domain errors
    if (candidates.length === 0) {
      if (lastMaintenanceReason) {
        throw new RouterError(
          DomainErrorCode.PROVIDER_MAINTENANCE,
          lastMaintenanceReason,
          { source: assetNodeToString(source), destination: assetNodeToString(destination), reason: lastMaintenanceReason }
        );
      }

      if (lastUnavailableReason) {
        throw new RouterError(
          DomainErrorCode.ROUTE_UNAVAILABLE,
          lastUnavailableReason,
          { source: assetNodeToString(source), destination: assetNodeToString(destination), reason: lastUnavailableReason }
        );
      }

      if (lastMinAmount) {
        throw new RouterError(
          DomainErrorCode.AMOUNT_BELOW_MINIMUM,
          `Amount ${amountAtomic} is below live minimum ${lastMinAmount}`,
          {
            requestedAmountAtomic: amountAtomic,
            minimumAmountAtomic: lastMinAmount,
            asset: source.asset,
            network: source.network,
          }
        );
      }

      if (lastMaxAmount) {
        throw new RouterError(
          DomainErrorCode.AMOUNT_ABOVE_MAXIMUM,
          `Amount ${amountAtomic} exceeds live maximum ${lastMaxAmount}`,
          {
            requestedAmountAtomic: amountAtomic,
            maximumAmountAtomic: lastMaxAmount,
            asset: source.asset,
            network: source.network,
          }
        );
      }

      throw new RouterError(
        DomainErrorCode.ROUTE_UNAVAILABLE,
        'No eligible route candidates currently available for requested parameters'
      );
    }

    // Deterministic ranking by policy
    return this.rankCandidates(candidates, policy);
  }

  /**
   * Deterministic candidate ranking
   */
  private rankCandidates(
    candidates: RouteCandidate[],
    policy: RoutingPolicy
  ): RouteCandidate[] {
    if (candidates.length <= 1) {
      return candidates;
    }

    return [...candidates].sort((a, b) => {
      const edgeA = a.edges[0];
      const edgeB = b.edges[0];

      if (policy === 'TRUST_MINIMIZED') {
        const trustRank: Record<EdgeClass, number> = {
          [EdgeClass.SELF_CUSTODY_EDGE]: 1,
          [EdgeClass.ATOMIC_EDGE]: 2,
          [EdgeClass.PROTOCOL_EDGE]: 3,
          [EdgeClass.TRUSTED_PROVIDER_EDGE]: 4,
        };
        return trustRank[edgeA.edgeClass] - trustRank[edgeB.edgeClass];
      }

      if (policy === 'FASTEST') {
        const latA = a.availability.estimatedLatencyMs ?? 60000;
        const latB = b.availability.estimatedLatencyMs ?? 60000;
        return latA - latB;
      }

      // Default deterministic ordering by edge ID
      return edgeA.id.localeCompare(edgeB.id);
    });
  }

  /**
   * Creates an immutable ExecutionPlan snapshot from a RouteQuote
   */
  public createExecutionPlan(
    candidate: RouteCandidate,
    quote: RouteQuote,
    destinationAddress: string,
    refundAddress: string
  ): ExecutionPlan {
    return {
      planId: `plan_${randomUUID().replace(/-/g, '')}`,
      edgeId: candidate.edges[0].id,
      routeId: candidate.routeId,
      quoteSnapshot: Object.freeze({ ...quote }),
      destinationAddress,
      refundAddress,
      createdAt: new Date().toISOString(),
    };
  }
}
