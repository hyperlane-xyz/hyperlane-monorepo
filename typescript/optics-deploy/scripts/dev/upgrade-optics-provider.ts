import * as alfajores from '../../config/testnets/alfajores';
import * as kovan from '../../config/testnets/kovan';
import * as gorli from '../../config/testnets/gorli';
import * as fuji from '../../config/testnets/fuji';
import * as mumbai from '../../config/testnets/mumbai';
import { updateProviderDomain } from '../../src/provider';
import { configPath } from './agentConfig';
import { makeExistingDeployConfig } from '../../src/config';


updateProviderDomain('dev', configPath, [
  makeExistingDeployConfig(alfajores, (_) => _.devConfig),
  makeExistingDeployConfig(kovan, (_) => _.devConfig),
  makeExistingDeployConfig(gorli, (_) => _.devConfig),
  makeExistingDeployConfig(fuji, (_) => _.devConfig),
  makeExistingDeployConfig(mumbai, (_) => _.devConfig),
]);

