import { z } from 'zod';

export const PlannedActionSchema = z.object({
  actionFingerprint: z.string(),
  executionType: z.enum(['movableCollateral', 'inventory']),
  routeId: z.string(),
  origin: z.string(),
  destination: z.string(),
  sourceRouter: z.string(),
  destinationRouter: z.string(),
  amount: z.string(),
  reason: z.string().optional(),
  bridge: z.literal('lifi').optional(),
});

export const PlannerOutputSchema = z.object({
  summary: z.string(),
  actions: z.array(PlannedActionSchema),
});
