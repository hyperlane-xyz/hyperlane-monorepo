import * as alfajores from '../../config/testnets/alfajores';
import * as kovan from '../../config/testnets/kovan';
import * as gorli from '../../config/testnets/gorli';
import * as fuji from '../../config/testnets/fuji';
import * as mumbai from '../../config/testnets/mumbai';
import { updateProviderDomain } from '../../src/provider';

const path = '../../rust/config/1640049457801';

updateProviderDomain('dev', path, [
  accessedConfig(alfajores, (_) => _.devConfig),
  accessedConfig(kovan, (_) => _.devConfig),
  accessedConfig(gorli, (_) => _.devConfig),
  accessedConfig(fuji, (_) => _.devConfig),
  accessedConfig(mumbai, (_) => _.devConfig),
]);

function accessedConfig<T, V>(data: V, accessor: (data: V) => T) {
  return { ...data, coreConfig: accessor(data) };
}
