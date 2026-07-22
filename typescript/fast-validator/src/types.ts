import { z } from 'zod';

const HEX32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 32-byte 0x-prefixed hex string');

export const SignRequestSchema = z.object({
  /** Chain name as defined in the validator config */
  origin: z.string().min(1),
  /** Transaction hash where the Dispatch happened */
  txHash: HEX32,
  /** Hyperlane message id (keccak256 of the formatted message) */
  messageId: HEX32,
  /** Index of the message in the merkle tree */
  leafIndex: z.number().int().nonnegative(),
  /** Merkle root the relayer is asking the validator to sign */
  claimedRoot: HEX32,
  /** TREE_DEPTH (=32) sibling hashes, ordered leaf-to-root */
  proof: z.array(HEX32).length(32),
});
export type SignRequest = z.infer<typeof SignRequestSchema>;

export interface SignResponse {
  validator: string;
  signature: string;
  checkpoint: {
    root: string;
    index: number;
    mailbox_domain: number;
    merkle_tree_hook_address: string;
  };
  message_id: string;
}
