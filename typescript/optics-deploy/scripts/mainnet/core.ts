import { deployNChains } from '../../src/core';
import { CoreDeploy } from '../../src/core/CoreDeploy';
import { chains } from '../../config/environments/mainnet/chains';
import { core } from '../../config/environments/mainnet/core';

deployNChains(chains.map((c) => new CoreDeploy(c, core)))
