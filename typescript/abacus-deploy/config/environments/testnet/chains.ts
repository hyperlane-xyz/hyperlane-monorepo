import { chainConfigsGetterForEnvironment } from '../../../src/config/chain';
import { getChain as alfajores } from '../../../config/networks/testnets/alfajores';
import { getChain as gorli } from '../../../config/networks/testnets/gorli';
import { getChain as kovan } from '../../../config/networks/testnets/kovan';
import { getChain as ropsten } from '../../../config/networks/testnets/ropsten';

const environment = 'testnet';
const deployerKeySecretName = 'staging-community-deployer-key';

export const getChains = chainConfigsGetterForEnvironment(
    [alfajores, ropsten, kovan, gorli],
    environment,
    deployerKeySecretName
);
