// Found by running:
import { ChainMap } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

// REGISTRY_URI=/Users/pbio/work/tmpauditq2/hyperlane-registry \
// yarn tsx scripts/keys/get-owner-ica.ts -e mainnet3 --ownerChain ethereum --deploy \
// --governanceType abacusWorks
// -c <chain1> <chain2> ... \
export const dymensionIcas: ChainMap<Address> = {
} as const;
