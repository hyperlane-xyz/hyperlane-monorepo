import type { ethers } from 'ethers';

import type { IChainConnection } from '../provider';
import type { ChainName } from '../types';

export const addSignerToConnection =
  <Chain extends ChainName>(signer: ethers.Signer) =>
  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
  (_chain: Chain, connection: IChainConnection) => ({
    ...connection,
    signer,
  });
