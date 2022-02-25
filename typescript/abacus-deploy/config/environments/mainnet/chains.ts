import { chainConfigsGetterForEnvironment } from '../../../src/config/chain';
import { getChain as celo } from '../../../config/networks/mainnets/celo';
import { getChain as ethereum } from '../../../config/networks/mainnets/ethereum';
import { getChain as polygon } from '../../../config/networks/mainnets/polygon';
import { getChain as avalanche } from '../../../config/networks/mainnets/avalanche';

const environment = 'mainnet';
const deployerKeySecretName = 'v2-deployer-key';

export const getChains = chainConfigsGetterForEnvironment(
    [celo, ethereum, avalanche, polygon],
    environment,
    deployerKeySecretName
);
