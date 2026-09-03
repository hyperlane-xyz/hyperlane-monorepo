import { z } from 'zod';

import { Address, isAddressEvm, isZeroishAddress } from '@hyperlane-xyz/utils';

import { ZBigNumberish, ZChainName } from '../metadata/customZodTypes.js';
import { ChainMap, OwnableSchema } from '../types.js';

export const LayerZeroV2Variant = {
  Callback: 'layerZeroV2Callback',
  CcipRead: 'layerZeroV2CcipRead',
} as const;
export type LayerZeroV2Variant =
  (typeof LayerZeroV2Variant)[keyof typeof LayerZeroV2Variant];

export const LayerZeroV2AddressSchema = z
  .string()
  .refine(isAddressEvm, 'must be a valid EVM address');

const LayerZeroV2ConfigAddressSchema = LayerZeroV2AddressSchema.refine(
  (address) => !isZeroishAddress(address),
  'must be a nonzero EVM address',
);

const MAX_UINT128 = (1n << 128n) - 1n;
const MAX_UINT64 = (1n << 64n) - 1n;
export const LayerZeroV2CallbackGasLimitSchema = ZBigNumberish.refine(
  (value) => value > 0n && value <= MAX_UINT128,
  'callbackGasLimit must fit a nonzero uint128',
);

export const LayerZeroV2ConfigMode = {
  Default: 'default',
  Override: 'override',
} as const;

const LayerZeroV2DefaultConfigSchema = z
  .object({
    type: z.literal(LayerZeroV2ConfigMode.Default),
  })
  .strict();

const LayerZeroV2ExecutorOverrideSchema = z
  .object({
    type: z.literal(LayerZeroV2ConfigMode.Override),
    maxMessageSize: z.number().int().positive().max(0xffffffff).optional(),
    executor: LayerZeroV2ConfigAddressSchema.optional(),
  })
  .strict()
  .refine(
    ({ maxMessageSize, executor }) =>
      maxMessageSize !== undefined || executor !== undefined,
    'Executor override must set maxMessageSize or executor',
  );

export const LayerZeroV2ExecutorConfigSchema = z.union([
  LayerZeroV2DefaultConfigSchema,
  LayerZeroV2ExecutorOverrideSchema,
]);

const LayerZeroV2DvnListSchema = z
  .array(LayerZeroV2ConfigAddressSchema)
  .max(127)
  .superRefine((dvns, ctx) => {
    const seen = new Set<string>();
    dvns.forEach((dvn, index) => {
      const normalized = dvn.toLowerCase();
      if (seen.has(normalized)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: `Duplicate LayerZero DVN ${dvn}`,
        });
      }
      seen.add(normalized);
    });
  })
  .transform((dvns) =>
    [...dvns].sort((a, b) => {
      const left = BigInt(a.toLowerCase());
      const right = BigInt(b.toLowerCase());
      return left < right ? -1 : left > right ? 1 : 0;
    }),
  );

const LayerZeroV2UlnOverrideSchema = z
  .object({
    type: z.literal(LayerZeroV2ConfigMode.Override),
    confirmations: ZBigNumberish.refine(
      (value) => value <= MAX_UINT64,
      'confirmations must fit uint64',
    ).optional(),
    requiredDVNs: LayerZeroV2DvnListSchema.optional(),
    optionalDVNs: LayerZeroV2DvnListSchema.optional(),
    optionalDVNThreshold: z.number().int().nonnegative().max(127).optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (
      config.confirmations === undefined &&
      config.requiredDVNs === undefined &&
      config.optionalDVNs === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'ULN override must configure at least one field',
      });
    }
    if (config.optionalDVNs === undefined) {
      if (config.optionalDVNThreshold !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['optionalDVNThreshold'],
          message: 'optionalDVNThreshold requires optionalDVNs',
        });
      }
      return;
    }
    const expectedThreshold = config.optionalDVNs.length === 0 ? 0 : undefined;
    if (
      expectedThreshold === 0 &&
      config.optionalDVNThreshold !== undefined &&
      config.optionalDVNThreshold !== 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['optionalDVNThreshold'],
        message: 'Empty optionalDVNs requires threshold 0',
      });
    }
    if (
      config.optionalDVNs.length > 0 &&
      (config.optionalDVNThreshold === undefined ||
        config.optionalDVNThreshold === 0 ||
        config.optionalDVNThreshold > config.optionalDVNs.length)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['optionalDVNThreshold'],
        message: 'Optional DVN threshold must be between 1 and the DVN count',
      });
    }
    if (config.requiredDVNs?.length === 0 && config.optionalDVNs.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'ULN config must retain at least one DVN',
      });
    }
  })
  .transform((config) =>
    config.optionalDVNs?.length === 0 &&
    config.optionalDVNThreshold === undefined
      ? { ...config, optionalDVNThreshold: 0 }
      : config,
  );

export const LayerZeroV2UlnConfigSchema = z.union([
  LayerZeroV2DefaultConfigSchema,
  LayerZeroV2UlnOverrideSchema,
]);

export const LayerZeroV2SendConfigSchema = z
  .object({
    executor: LayerZeroV2ExecutorConfigSchema.default(() => ({
      type: LayerZeroV2ConfigMode.Default,
    })),
    uln: LayerZeroV2UlnConfigSchema.default(() => ({
      type: LayerZeroV2ConfigMode.Default,
    })),
  })
  .default({});

export const LayerZeroV2ReceiveConfigSchema = z
  .object({
    uln: LayerZeroV2UlnConfigSchema.default(() => ({
      type: LayerZeroV2ConfigMode.Default,
    })),
  })
  .default({});

export const LayerZeroV2EffectiveExecutorConfigSchema = z.object({
  maxMessageSize: z.number().int().positive().max(0xffffffff),
  executor: LayerZeroV2AddressSchema,
});

export const LayerZeroV2EffectiveUlnConfigSchema = z.object({
  confirmations: ZBigNumberish.refine(
    (value) => value <= MAX_UINT64,
    'confirmations must fit uint64',
  ),
  requiredDVNs: LayerZeroV2DvnListSchema,
  optionalDVNs: LayerZeroV2DvnListSchema,
  optionalDVNThreshold: z.number().int().nonnegative().max(127),
});

export const LayerZeroV2EffectiveSendConfigSchema = z.object({
  executor: LayerZeroV2EffectiveExecutorConfigSchema,
  uln: LayerZeroV2EffectiveUlnConfigSchema,
});

export const LayerZeroV2EffectiveReceiveConfigSchema = z.object({
  uln: LayerZeroV2EffectiveUlnConfigSchema,
});

const LayerZeroV2PathwayBaseSchema = z.object({
  /** LayerZero calls this the remote Endpoint ID (EID). */
  layerZeroDomainId: z.number().int().positive().max(0xffffffff),
  sendLibrary: LayerZeroV2AddressSchema,
  receiveLibrary: LayerZeroV2AddressSchema,
  receiveLibraryGracePeriod: z.literal(0).default(0),
  receiveLibraryTimeout: z
    .object({
      library: LayerZeroV2AddressSchema,
      expiry: z.number().int().positive(),
    })
    .optional(),
  sendConfig: LayerZeroV2SendConfigSchema,
  receiveConfig: LayerZeroV2ReceiveConfigSchema,
  /** Effective values after LayerZero applies defaults; informational only. */
  effectiveSendConfig: LayerZeroV2EffectiveSendConfigSchema.optional(),
  /** Effective values after LayerZero applies defaults; informational only. */
  effectiveReceiveConfig: LayerZeroV2EffectiveReceiveConfigSchema.optional(),
});

export const LayerZeroV2PathwaySchema = LayerZeroV2PathwayBaseSchema;

export const LayerZeroV2RemoteRouterSchema =
  LayerZeroV2PathwayBaseSchema.extend({
    router: LayerZeroV2AddressSchema,
    callbackGasLimit: LayerZeroV2CallbackGasLimitSchema.optional(),
  });

export const LayerZeroV2HookIsmSchema = OwnableSchema.extend({
  type: z.union([
    z.literal(LayerZeroV2Variant.Callback),
    z.literal(LayerZeroV2Variant.CcipRead),
  ]),
  mailbox: LayerZeroV2AddressSchema,
  endpoint: LayerZeroV2AddressSchema,
  /** Optional deployment-time assertion against Endpoint.eid(). */
  layerZeroDomainId: z.number().int().positive().max(0xffffffff).optional(),
  urls: z.array(z.string().url()).min(1).optional(),
  remoteRouters: z.record(ZChainName, LayerZeroV2RemoteRouterSchema),
}).superRefine((config, ctx) => {
  if (config.type === LayerZeroV2Variant.CcipRead && !config.urls) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['urls'],
      message: 'layerZeroV2CcipRead requires at least one URL',
    });
  }
  if (config.type === LayerZeroV2Variant.Callback && config.urls) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['urls'],
      message: 'urls is a layerZeroV2CcipRead field',
    });
  }
  const layerZeroDomainIds = new Map<number, string>();
  for (const [chain, remote] of Object.entries(config.remoteRouters)) {
    const existing = layerZeroDomainIds.get(remote.layerZeroDomainId);
    if (existing) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['remoteRouters', chain, 'layerZeroDomainId'],
        message: `LayerZero domain ID ${remote.layerZeroDomainId} is already claimed by ${existing}`,
      });
    }
    layerZeroDomainIds.set(remote.layerZeroDomainId, chain);
    if (
      config.type === LayerZeroV2Variant.Callback &&
      (remote.callbackGasLimit === undefined ||
        BigInt(remote.callbackGasLimit) === 0n)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['remoteRouters', chain, 'callbackGasLimit'],
        message: 'callback variant requires a nonzero callbackGasLimit',
      });
    }
    if (
      config.type === LayerZeroV2Variant.CcipRead &&
      remote.callbackGasLimit !== undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['remoteRouters', chain, 'callbackGasLimit'],
        message: 'callbackGasLimit is a callback-only field',
      });
    }
  }
});

export type LayerZeroV2HookIsmConfig = z.infer<typeof LayerZeroV2HookIsmSchema>;
export type LayerZeroV2ExecutorConfig = z.infer<
  typeof LayerZeroV2ExecutorConfigSchema
>;
export type LayerZeroV2UlnConfig = z.infer<typeof LayerZeroV2UlnConfigSchema>;
export type LayerZeroV2SendConfig = z.infer<typeof LayerZeroV2SendConfigSchema>;
export type LayerZeroV2ReceiveConfig = z.infer<
  typeof LayerZeroV2ReceiveConfigSchema
>;
export type LayerZeroV2EffectiveExecutorConfig = z.infer<
  typeof LayerZeroV2EffectiveExecutorConfigSchema
>;
export type LayerZeroV2EffectiveUlnConfig = z.infer<
  typeof LayerZeroV2EffectiveUlnConfigSchema
>;
export type LayerZeroV2RemoteRouterConfig = z.infer<
  typeof LayerZeroV2RemoteRouterSchema
>;
export type LayerZeroV2MeshConfig = ChainMap<LayerZeroV2HookIsmConfig>;
export type DerivedLayerZeroV2HookIsmConfig = Omit<
  LayerZeroV2HookIsmConfig,
  'layerZeroDomainId' | 'remoteRouters'
> & {
  address: Address;
  layerZeroDomainId: number;
  remoteRouters: Record<string, LayerZeroV2RemoteRouterConfig>;
};
export type LayerZeroV2HookIsmAddresses = {
  deployedRouter: Address;
  mailbox: Address;
};

export function findAsymmetricLayerZeroV2Routes(
  mesh: LayerZeroV2MeshConfig,
): string[] {
  const problems: string[] = [];
  const chains = Object.keys(mesh);
  for (const origin of chains) {
    for (const destination of chains) {
      if (origin === destination) continue;
      if (!mesh[origin].remoteRouters[destination]) {
        problems.push(`${origin} does not enroll ${destination}`);
      }
      if (!mesh[destination].remoteRouters[origin]) {
        problems.push(`${destination} does not enroll ${origin}`);
      }
      if (mesh[origin].type !== mesh[destination].type) {
        problems.push(
          `${origin} is ${mesh[origin].type} but ${destination} is ${mesh[destination].type}`,
        );
      }
    }
  }
  return [...new Set(problems)];
}
