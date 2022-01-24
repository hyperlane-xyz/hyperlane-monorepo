import * as alfajores from '../../config/testnets/alfajores';
import * as kovan from '../../config/testnets/kovan';
import * as rinkeby from '../../config/testnets/rinkeby';
import { updateProviderDomain } from '../../src/provider';
import { makeAllConfigs } from '../../src/config';


const configPath = '../../rust/config/staging';
updateProviderDomain('staging', configPath, [
  makeAllConfigs(alfajores, (_) => _.devConfig),
  makeAllConfigs(kovan, (_) => _.devConfig),
  makeAllConfigs(rinkeby, (_) => _.devConfig),
]);

