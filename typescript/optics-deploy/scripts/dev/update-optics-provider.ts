import * as alfajores from '../../config/testnets/alfajores';
import * as kovan from '../../config/testnets/kovan';
import * as gorli from '../../config/testnets/gorli';
import * as fuji from '../../config/testnets/fuji';
import * as mumbai from '../../config/testnets/mumbai';
import { updateProviderDomain } from '../../src/provider';
import { configPath } from './agentConfig';
import { makeAllConfigs } from '../../src/config';


updateProviderDomain('dev', configPath, [
  makeAllConfigs(alfajores, (_) => _.devConfig),
  makeAllConfigs(kovan, (_) => _.devConfig),
  makeAllConfigs(gorli, (_) => _.devConfig),
  makeAllConfigs(fuji, (_) => _.devConfig),
  makeAllConfigs(mumbai, (_) => _.devConfig),
]);

