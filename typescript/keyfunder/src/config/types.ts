import { z } from 'zod';

const AddressSchema = z
  .string()
  .regex(
    /^0x[a-fA-F0-9]{40}$/,
    'Must be a valid Ethereum address (0x-prefixed, 40 hex characters)',
  );

const BalanceStringSchema = z
  .string()
  .refine(
    (val) => !isNaN(parseFloat(val)) && parseFloat(val) >= 0,
    'Must be a valid non-negative number string',
  );

export const RoleConfigSchema = z.object({
  address: AddressSchema,
});

export const IgpConfigSchema = z.object({
  address: AddressSchema,
  claimThreshold: BalanceStringSchema,
});

const MIN_TRIGGER_DIFFERENCE = 0.05;
const MIN_TARGET = 1.05;
const MIN_TRIGGER = 1.1;
const MAX_TARGET = 10.0;
const MAX_TRIGGER = 200.0;

export const SweepConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    address: AddressSchema.optional(),
    targetMultiplier: z
      .number()
      .min(MIN_TARGET, `Target multiplier must be at least ${MIN_TARGET}`)
      .max(MAX_TARGET, `Target multiplier must be at most ${MAX_TARGET}`)
      .default(1.5),
    triggerMultiplier: z
      .number()
      .min(MIN_TRIGGER, `Trigger multiplier must be at least ${MIN_TRIGGER}`)
      .max(MAX_TRIGGER, `Trigger multiplier must be at most ${MAX_TRIGGER}`)
      .default(2.0),
    threshold: BalanceStringSchema.optional(),
  })
  .refine(
    (data) => {
      if (!data.enabled) return true;
      return (
        data.triggerMultiplier >= data.targetMultiplier + MIN_TRIGGER_DIFFERENCE
      );
    },
    {
      message: `Trigger multiplier must be at least ${MIN_TRIGGER_DIFFERENCE} greater than target multiplier`,
      path: ['triggerMultiplier'],
    },
  );

export const ChainConfigSchema = z.object({
  balances: z.record(z.string(), BalanceStringSchema).optional(),
  igp: IgpConfigSchema.optional(),
  sweep: SweepConfigSchema.optional(),
});

export const FunderConfigSchema = z.object({
  privateKeyEnvVar: z.string().default('FUNDER_PRIVATE_KEY'),
});

export const MetricsConfigSchema = z.object({
  pushGateway: z.string().optional(),
  jobName: z.string().default('keyfunder'),
  labels: z.record(z.string(), z.string()).optional(),
});

export const KeyFunderConfigSchema = z
  .object({
    version: z.literal('1'),
    roles: z.record(z.string(), RoleConfigSchema),
    chains: z.record(z.string(), ChainConfigSchema),
    funder: FunderConfigSchema.optional(),
    metrics: MetricsConfigSchema.optional(),
    chainsToSkip: z.array(z.string()).optional(),
  })
  .refine(
    (data) => {
      const definedRoles = new Set(Object.keys(data.roles));
      for (const chainConfig of Object.values(data.chains)) {
        if (!chainConfig.balances) continue;
        for (const roleName of Object.keys(chainConfig.balances)) {
          if (!definedRoles.has(roleName)) {
            return false;
          }
        }
      }
      return true;
    },
    {
      message:
        'Chain balances reference undefined roles. All roles must be defined in the roles section.',
    },
  );

export type RoleConfig = z.infer<typeof RoleConfigSchema>;
export type IgpConfig = z.infer<typeof IgpConfigSchema>;
export type SweepConfig = z.infer<typeof SweepConfigSchema>;
export type ChainConfig = z.infer<typeof ChainConfigSchema>;
export type FunderConfig = z.infer<typeof FunderConfigSchema>;
export type MetricsConfig = z.infer<typeof MetricsConfigSchema>;
export type KeyFunderConfig = z.infer<typeof KeyFunderConfigSchema>;
export type KeyFunderConfigInput = z.input<typeof KeyFunderConfigSchema>;

export interface ResolvedKeyConfig {
  address: string;
  role: string;
  desiredBalance: string;
}
