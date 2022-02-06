import { ChainConfig } from '../../../src/config/chain';
import { chain as celo } from '../../../config/networks/mainnets/celo';
import { chain as ethereum } from '../../../config/networks/mainnets/ethereum';
import { chain as polygon } from '../../../config/networks/mainnets/polygon';
import { chain as avalanche } from '../../../config/networks/mainnets/avalanche';

export const chains: ChainConfig[] = [celo, ethereum, avalanche, polygon];
