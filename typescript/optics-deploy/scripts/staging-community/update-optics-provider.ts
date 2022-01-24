import * as alfajores from '../../config/testnets/alfajores';
import * as kovan from '../../config/testnets/kovan';
import * as gorli from '../../config/testnets/gorli';
import * as ropsten from '../../config/testnets/ropsten';
import { updateProviderDomain } from '../../src/provider';
import { makeAllConfigs } from '../../src/config';


const configPath = '../../rust/config/staging-community';
updateProviderDomain('stagingCommunity', configPath, [
  makeAllConfigs(alfajores, (_) => _.devConfig),
  makeAllConfigs(ropsten, (_) => _.devConfig),
  makeAllConfigs(kovan, (_) => _.devConfig),
  makeAllConfigs(gorli, (_) => _.devConfig),
]);

