import { ChainConfig } from '../../../src/config/chain';
import { chain as alfajores } from '../../../config/networks/testnets/alfajores';
import { chain as gorli } from '../../../config/networks/testnets/gorli';
import { chain as kovan } from '../../../config/networks/testnets/kovan';
import { chain as ropsten } from '../../../config/networks/testnets/ropsten';

export const chains: ChainConfig[] = [alfajores, ropsten, kovan, gorli];
