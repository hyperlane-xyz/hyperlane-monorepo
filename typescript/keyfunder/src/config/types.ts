import { ethers } from 'ethers';
import { z } from 'zod';

const AddressSchema = z
  .string()
  .regex(
    /^0x[a-fA-F0-9]{40}$/,
    'Must be a valid Ethereum address (0x-prefixed, 40 hex characters)',
  );

// Requires leading digit (e.g., "0.5" not ".5") for YAML readability
const BalanceStringSchema = z
  .string()
  .regex(
    /^(?:\d+)(?:\.\d{1,18})?$/,
    'Must be a valid non-negative decimal string with leading digit (e.g., "0.5" not ".5", up to 18 decimals)',
  );

const MAX_UINT32 = 0xffffffff;

function hasRepresentablePrecision(amount: string, decimals: number): boolean {
  const dotIndex = amount.indexOf('.');
  if (dotIndex === -1) {
    return true;
  }
  return amount.length - dotIndex - 1 <= decimals;
}

function validateBridgeAmountLimits(
  cfg: { minBridgeThreshold: string; maxBridgeAmount: string },
  decimals: number,
  ctx: z.RefinementCtx,
  pathPrefix: (string | number)[] = [],
): void {
  let minRepresentable = true;
  let maxRepresentable = true;

  if (!hasRepresentablePrecision(cfg.minBridgeThreshold, decimals)) {
    minRepresentable = false;
    ctx.addIssue({
      code: 'custom',
      path: [...pathPrefix, 'minBridgeThreshold'],
      message: `minBridgeThreshold ("${cfg.minBridgeThreshold}") exceeds token precision of ${decimals} decimals`,
    });
  }

  if (!hasRepresentablePrecision(cfg.maxBridgeAmount, decimals)) {
    maxRepresentable = false;
    ctx.addIssue({
      code: 'custom',
      path: [...pathPrefix, 'maxBridgeAmount'],
      message: `maxBridgeAmount ("${cfg.maxBridgeAmount}") exceeds token precision of ${decimals} decimals`,
    });
  }

  if (!minRepresentable || !maxRepresentable) {
    return;
  }

  const minUnits = ethers.utils.parseUnits(cfg.minBridgeThreshold, decimals);
  const maxUnits = ethers.utils.parseUnits(cfg.maxBridgeAmount, decimals);
  if (maxUnits.lt(minUnits)) {
    ctx.addIssue({
      code: 'custom',
      path: [...pathPrefix, 'maxBridgeAmount'],
      message:
        'maxBridgeAmount must be greater than or equal to minBridgeThreshold',
    });
  }
}

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
  .refine((data) => !data.enabled || !!data.address, {
    message: 'Sweep address is required when sweep is enabled',
    path: ['address'],
  })
  .refine((data) => !data.enabled || !!data.threshold, {
    message: 'Sweep threshold is required when sweep is enabled',
    path: ['threshold'],
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

export const HyperlaneHookBridgeDeliverySchema = z.object({
  mailboxAddress: AddressSchema,
  hookAddress: AddressSchema,
  recipientAddress: AddressSchema,
  destinationDomain: z
    .number()
    .int()
    .positive()
    .max(
      MAX_UINT32,
      `destinationDomain must not exceed uint32 maximum (${MAX_UINT32})`,
    ),
  gasLimit: z.number().int().min(50_000).max(5_000_000).default(250_000),
});

export const OpStackBridgeConfigSchema = z
  .object({
    stack: z.literal('opStack'),
    originChain: z.string().min(1),
    mode: z.enum(['optimismPortal', 'l1StandardBridge', 'hyperlaneHook']),
    bridgeContract: AddressSchema.optional(),
    l2GasLimit: z.number().int().min(21_000).max(10_000_000).default(200_000),
    minBridgeThreshold: BalanceStringSchema.default('0.01'),
    maxBridgeAmount: BalanceStringSchema.default('5'),
    originReserveBuffer: BalanceStringSchema.default('0.05'),
    hookDelivery: HyperlaneHookBridgeDeliverySchema.optional(),
  })
  .superRefine((cfg, ctx) => {
    const hasModeConfig =
      cfg.mode === 'hyperlaneHook' ? !!cfg.hookDelivery : !!cfg.bridgeContract;
    if (!hasModeConfig) {
      ctx.addIssue({
        code: 'custom',
        message:
          'OP Stack bridge requires bridgeContract for canonical modes or hookDelivery for hyperlaneHook mode',
      });
    }
    validateBridgeAmountLimits(cfg, 18, ctx);
  });

export const ArbitrumOrbitBridgeConfigSchema = z
  .object({
    stack: z.literal('arbitrumOrbit'),
    originChain: z.string().min(1),
    mode: z.enum([
      'ethInbox',
      'erc20Inbox',
      'retryableTicket',
      'hyperlaneHook',
    ]),
    inboxAddress: AddressSchema.optional(),
    originGasToken: z
      .object({
        address: AddressSchema,
        decimals: z.number().int().min(0).max(255).default(18),
      })
      .optional(),
    l2GasLimit: z.number().int().min(21_000).max(10_000_000).default(300_000),
    maxSubmissionCostWei: z.string().regex(/^\d+$/).default('100000000000000'),
    maxFeePerGasWei: z.string().regex(/^\d+$/).default('1000000000'),
    minBridgeThreshold: BalanceStringSchema.default('0.01'),
    maxBridgeAmount: BalanceStringSchema.default('5'),
    originReserveBuffer: BalanceStringSchema.default('0.05'),
    hookDelivery: HyperlaneHookBridgeDeliverySchema.optional(),
  })
  .superRefine((cfg, ctx) => {
    const hasModeConfig =
      cfg.mode === 'hyperlaneHook' ? !!cfg.hookDelivery : !!cfg.inboxAddress;
    if (!hasModeConfig) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Arbitrum Orbit bridge requires inboxAddress for canonical Inbox modes or hookDelivery for hyperlaneHook mode',
      });
    }

    if (cfg.mode === 'erc20Inbox' && !cfg.originGasToken) {
      ctx.addIssue({
        code: 'custom',
        path: ['originGasToken'],
        message:
          'originGasToken is required when Arbitrum Orbit mode is erc20Inbox',
      });
    }

    const decimals = cfg.originGasToken?.decimals ?? 18;
    validateBridgeAmountLimits(cfg, decimals, ctx);
  });

export const BridgeConfigSchema = z.union([
  OpStackBridgeConfigSchema,
  ArbitrumOrbitBridgeConfigSchema,
]);

export const ChainConfigSchema = z
  .object({
    // Explicit opt-in: some ERC20 native-token interfaces still support native sends.
    erc20GasToken: z
      .object({
        address: AddressSchema,
        decimals: z.number().int().min(0).max(255),
      })
      .optional(),
    balances: z.record(z.string(), BalanceStringSchema).optional(),
    igp: IgpConfigSchema.optional(),
    sweep: SweepConfigSchema.optional(),
    bridge: BridgeConfigSchema.optional(),
  })
  .superRefine((chainCfg, ctx) => {
    if (
      chainCfg.bridge &&
      chainCfg.erc20GasToken &&
      !(
        chainCfg.bridge.stack === 'arbitrumOrbit' &&
        chainCfg.bridge.mode === 'erc20Inbox'
      )
    ) {
      validateBridgeAmountLimits(
        chainCfg.bridge,
        chainCfg.erc20GasToken.decimals,
        ctx,
        ['bridge'],
      );
    }
  });

export const MetricsConfigSchema = z.object({
  jobName: z.string().default('keyfunder'),
  labels: z.record(z.string(), z.string()).optional(),
});

export const KeyFunderConfigSchema = z
  .object({
    version: z.literal('1'),
    roles: z.record(z.string(), RoleConfigSchema),
    chains: z.record(z.string(), ChainConfigSchema),
    metrics: MetricsConfigSchema.optional(),
    chainsToSkip: z.array(z.string()).optional(),
    bridgeStateFile: z.string().min(1).optional(),
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
  )
  .refine(
    (data) => {
      for (const [chainName, chainConfig] of Object.entries(data.chains)) {
        if (chainConfig.bridge?.originChain === chainName) {
          return false;
        }
      }
      return true;
    },
    {
      message: 'Chain bridge originChain cannot match the destination chain.',
    },
  );

export type RoleConfig = z.infer<typeof RoleConfigSchema>;
export type IgpConfig = z.infer<typeof IgpConfigSchema>;
export type SweepConfig = z.infer<typeof SweepConfigSchema>;
export type HyperlaneHookBridgeDelivery = z.infer<
  typeof HyperlaneHookBridgeDeliverySchema
>;
export type OpStackBridgeConfig = z.infer<typeof OpStackBridgeConfigSchema>;
export type ArbitrumOrbitBridgeConfig = z.infer<
  typeof ArbitrumOrbitBridgeConfigSchema
>;
export type BridgeConfig = z.infer<typeof BridgeConfigSchema>;
export type ChainConfig = z.infer<typeof ChainConfigSchema>;
export type MetricsConfig = z.infer<typeof MetricsConfigSchema>;
export type KeyFunderConfig = z.infer<typeof KeyFunderConfigSchema>;
export type KeyFunderConfigInput = z.input<typeof KeyFunderConfigSchema>;

export interface ResolvedKeyConfig {
  address: string;
  role: string;
  desiredBalance: string;
}
