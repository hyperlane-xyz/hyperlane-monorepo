import { ChainConfig } from '../../../src/config/chain';
import { chain as alfajores } from '../../../config/networks/testnets/alfajores';
import { chain as gorli } from '../../../config/networks/testnets/gorli';
import { chain as kovan } from '../../../config/networks/testnets/kovan';
import { chain as mumbai } from '../../../config/networks/testnets/mumbai';
import { chain as fuji } from '../../../config/networks/testnets/fuji';

export const chains: ChainConfig[] = [alfajores, mumbai, fuji, gorli, kovan];
