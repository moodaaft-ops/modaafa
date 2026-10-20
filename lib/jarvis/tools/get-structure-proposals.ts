import type { JarvisReadTool, EvidenceRow } from './types';
import { okResult, refCounter } from './shared';
import { readStructureProposals, structureProposalsEnabled } from '@/lib/structure/proposals';
import { readReadiness } from '@/lib/growth/readiness';
export const getStructureProposalsTool: JarvisReadTool = {
 name: 'get_structure_proposals',
 description: 'Read eligible structure suggestions: shared budgets, portfolio strategies, placement exclusions and AI Max. Use returned sp_ refs with prepare_change apply_structure_proposal. No account change.',
 input_schema: { type: 'object', properties: {}, additionalProperties: false },
 async run(_input, ctx) {
   if (!structureProposalsEnabled()) throw new Error('disabled');
   const readiness = await readReadiness(ctx.customer as any);
   const proposals = await readStructureProposals(ctx.customer, ctx.customerId, readiness.verdict === 'healthy');
   const next = refCounter(); const evidence: EvidenceRow[] = [];
   const result = proposals.map((p) => { const ref = next('sp'); evidence.push({ ref, kind: 'structure_proposal', data: { ...p } }); return { ref, operation: p.operation, reason_ar: p.reason_ar }; });
   return okResult({ proposals: result }, evidence);
 },
};
