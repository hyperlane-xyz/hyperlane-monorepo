import { configs } from '../../networks/testnets';

export const devConfigs = {
  alfajores: configs.alfajores,
  kovan: configs.kovan,
};

export type DevChains = keyof typeof devConfigs;
export const chainNames = Object.keys(devConfigs) as DevChains[];
