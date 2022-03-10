import { getChainsForEnvironment } from '../../../src/config/chain';
import {
  alfajores,
  goerli,
  kovan,
  mumbai,
  fuji,
} from '../../../config/networks/testnets';

const environment = 'dev';
const deployerKeySecretName = 'optics-key-dev-deployer';

export const getChains = getChainsForEnvironment(
  [alfajores, kovan, goerli, fuji, mumbai],
  environment,
  deployerKeySecretName,
);
