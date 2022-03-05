import { getChainsForEnvironment } from '../../../src/config/chain';
import {
  celo,
  ethereum,
  polygon,
  avalanche,
} from '../../../config/networks/mainnets';

const environment = 'mainnet';
const deployerKeySecretName = 'v2-deployer-key';

export const getChains = getChainsForEnvironment(
  [celo, ethereum, avalanche, polygon],
  environment,
  deployerKeySecretName,
);
