import { chainConfigsGetterForEnvironment } from '../../../src/config/chain';
import { getChain as alfajores } from '../../../config/networks/testnets/alfajores';
import { getChain as gorli } from '../../../config/networks/testnets/gorli';
import { getChain as kovan } from '../../../config/networks/testnets/kovan';
import { getChain as mumbai } from '../../../config/networks/testnets/mumbai';
import { getChain as fuji } from '../../../config/networks/testnets/fuji';

const environment = 'dev';
const deployerKeySecretName = 'optics-key-dev-deployer';

export const getChains = chainConfigsGetterForEnvironment(
  [alfajores, kovan, gorli, fuji, mumbai],
  environment,
  deployerKeySecretName,
);
