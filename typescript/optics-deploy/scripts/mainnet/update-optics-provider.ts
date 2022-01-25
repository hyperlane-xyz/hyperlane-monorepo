import * as celo from '../../config/mainnets/celo';
import * as ethereum from '../../config/mainnets/ethereum';
import * as polygon from '../../config/mainnets/polygon';
import { updateProviderDomain } from '../../src/provider';
import { makeAllConfigs } from '../../src/config';


const configPath = '../../rust/config/mainnet';
updateProviderDomain('mainnet', configPath, [
  makeAllConfigs(ethereum, (_) => _.config),
  makeAllConfigs(polygon, (_) => _.config),
  makeAllConfigs(celo, (_) => _.config),
]);

