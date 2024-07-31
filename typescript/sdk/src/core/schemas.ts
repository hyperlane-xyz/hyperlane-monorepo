import { z } from 'zod';

import { ProxyFactoryFactoriesSchema } from '../deploy/schemas.js';
import { HookConfigSchema } from '../hook/schemas.js';
import { IsmConfigSchema } from '../ism/schemas.js';
import { OwnableSchema } from '../schemas.js';

export const CoreConfigSchema = OwnableSchema.extend({
  defaultIsm: IsmConfigSchema,
  defaultHook: HookConfigSchema,
  requiredHook: HookConfigSchema,
});

export const CoreArtifactsSchema = ProxyFactoryFactoriesSchema.extend({
  mailbox: z.string(),
});

export type CoreArtifacts = z.infer<typeof CoreArtifactsSchema>;
