import { getChainsForEnvironment } from '../../../src/config/chain';
import {
  alfajores,
  goerli,
  kovan,
  ropsten,
} from '../../../config/networks/testnets';

const environment = 'testnet';
const deployerKeySecretName = 'staging-community-deployer-key';

export const getChains = getChainsForEnvironment(
  [alfajores, ropsten, kovan, goerli],
  environment,
  deployerKeySecretName,
);
