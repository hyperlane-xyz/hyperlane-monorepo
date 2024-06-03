import { z } from 'zod';

export const OwnerSchema = z.string();

export const OwnableConfigSchema = z.object({
  owner: OwnerSchema,
});
