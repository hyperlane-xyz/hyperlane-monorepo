import { z } from 'zod';

import { Address, isAddressEvm } from '@hyperlane-xyz/utils';

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

const MAX_UINT128 = (1n << 128n) - 1n;
export const LayerZeroV2CallbackGasLimitSchema = ZBigNumberish.refine(
  (value) => value > 0n && value <= MAX_UINT128,
  'callbackGasLimit must fit a nonzero uint128',
);

export const LayerZeroV2ConfigParamSchema = z.object({
  configType: z.union([z.literal(1), z.literal(2)]),
  config: z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/),
});

const LayerZeroV2ConfigParamsSchema = z
  .array(LayerZeroV2ConfigParamSchema)
  .default([])
  .superRefine((params, ctx) => {
    const seen = new Set<number>();
    params.forEach((param, index) => {
      if (seen.has(param.configType)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'configType'],
          message: `Duplicate LayerZero config type ${param.configType}`,
        });
      }
      seen.add(param.configType);
    });
  })
  .transform((params) =>
    [...params].sort((a, b) => a.configType - b.configType),
  );

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
  sendConfig: LayerZeroV2ConfigParamsSchema,
  receiveConfig: LayerZeroV2ConfigParamsSchema,
});

function validateLayerZeroV2Pathway(
  pathway: z.infer<typeof LayerZeroV2PathwayBaseSchema>,
  ctx: z.RefinementCtx,
): void {
  pathway.receiveConfig.forEach((param, index) => {
    if (param.configType !== 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['receiveConfig', index, 'configType'],
        message: 'LayerZero receive config only supports ULN config type 2',
      });
    }
  });
}

export const LayerZeroV2PathwaySchema =
  LayerZeroV2PathwayBaseSchema.superRefine(validateLayerZeroV2Pathway);

export const LayerZeroV2RemoteRouterSchema =
  LayerZeroV2PathwayBaseSchema.extend({
    router: LayerZeroV2AddressSchema,
    callbackGasLimit: LayerZeroV2CallbackGasLimitSchema.optional(),
  }).superRefine(validateLayerZeroV2Pathway);

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
