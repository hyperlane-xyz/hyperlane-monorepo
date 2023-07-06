import { z } from 'zod';

import { ChainMetadataSchema } from './chainMetadataTypes';

/**
 * Extension of ChainMetadataSchema with additional properties for user interfaces
 */
export const UserInterfaceMetadataExtSchema = z.object({
  displayName: z
    .string()
    .optional()
    .describe('Human-readable name of the chain.'),
  displayNameShort: z
    .string()
    .optional()
    .describe('An optional shorter human-readable name of the chain.'),
  logoURI: z
    .string()
    .optional()
    .describe(
      'A URI to a logo image for this chain for use in user interfaces.',
    ),
});

export type UserInterfaceMetadataExtension = z.infer<
  typeof UserInterfaceMetadataExtSchema
>;

export const ChainMetadataWithUiExtSchema = ChainMetadataSchema.merge(
  UserInterfaceMetadataExtSchema,
);

export type ChainMetadataWithUiExt = z.infer<
  typeof ChainMetadataWithUiExtSchema
>;
