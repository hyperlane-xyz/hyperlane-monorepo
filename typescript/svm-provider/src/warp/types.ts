import { Address } from '@solana/kit';

export type SvmWarpTokenConfig = Readonly<{
  programBytes: Uint8Array;
  igpProgramId: Address;
}>;
