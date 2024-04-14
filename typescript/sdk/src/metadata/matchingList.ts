/**
 * The types defined here are the source of truth for chain metadata.
 * ANY CHANGES HERE NEED TO BE REFLECTED IN HYPERLANE-BASE CONFIG PARSING.
 */
import { z } from 'zod';

import { ZHash, ZNzUint } from './customZodTypes.js';

const DomainSchema = z.union([
  z.literal('*'),
  ZNzUint,
  z.array(ZNzUint).nonempty(),
]);

const AddressSchema = z.union([z.literal('*'), ZHash, z.array(ZHash)]);

const MatchingListElementSchema = z.object({
  originDomain: DomainSchema.optional(),
  senderAddress: AddressSchema.optional(),
  destinationDomain: DomainSchema.optional(),
  recipientAddress: AddressSchema.optional(),
});

export const MatchingListSchema = z.array(MatchingListElementSchema);

export type MatchingListElement = z.infer<typeof MatchingListElementSchema>;
export type MatchingList = z.infer<typeof MatchingListSchema>;
