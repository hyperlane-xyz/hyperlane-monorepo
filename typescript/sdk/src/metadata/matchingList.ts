import { z } from 'zod';

import { ZHash, ZNzUint } from './chainMetadataTypes';

const DomainSchema = z.union([
  z.literal('*'),
  ZNzUint,
  z.array(ZNzUint).nonempty(),
]);

const AddressSchema = z.union([
  z.literal('*'),
  ZHash,
  z.array(ZHash).nonempty(),
]);

const MatchingListElementSchema = z.object({
  originDomain: DomainSchema.optional(),
  senderAddress: AddressSchema.optional(),
  destinationDomain: DomainSchema.optional(),
  recipientAddress: AddressSchema.optional(),
});

export const MatchingListSchema = z.array(MatchingListElementSchema).nonempty();

export type MatchingListElement = z.infer<typeof MatchingListElementSchema>;
export type MatchingList = z.infer<typeof MatchingListSchema>;
