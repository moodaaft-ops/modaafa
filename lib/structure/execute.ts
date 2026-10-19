import type { OptimizerAction } from '../ai/optimizer-agent';
import { buildStructureRollbackOperations, finalizeStructureRollback, planStructure, type MutateOp } from './plan';
import { isStructureRollback } from './types';

/**
 * Operations and rollback for the account-structure actions. Thin wrappers
 * over planStructure so validateOnly and the live call send the same thing.
 */

export function buildStructureOperations(action: OptimizerAction): MutateOp[] {
  const params = action.params as Record<string, any>;
  const resolved = params.resolved;
  if (!resolved || typeof resolved !== 'object') {
    throw new Error('Structure action was not prepared: run prepareActionForExecution first');
  }
  return planStructure(action.type, params, resolved).operations;
}

export function finalizeStructureRollbackPayload(payload: Record<string, any>, result: unknown) {
  return finalizeStructureRollback(payload, result);
}

export { buildStructureRollbackOperations, isStructureRollback };
