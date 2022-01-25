import * as celo from '../../config/mainnets/celo';
import * as ethereum from '../../config/mainnets/ethereum';
import * as avalanche from '../../config/mainnets/avalanche';
import * as polygon from '../../config/mainnets/polygon';
import { updateProviderDomain } from '../../src/provider';
import { makeAllConfigs } from '../../src/config';


const configPath = '../../rust/config/production-community';
updateProviderDomain('mainnetCommunity', configPath, [
  makeAllConfigs(celo, (_) => _.config),
  makeAllConfigs(ethereum, (_) => _.config),
  makeAllConfigs(avalanche, (_) => _.config),
  makeAllConfigs(polygon, (_) => _.config),
]);

