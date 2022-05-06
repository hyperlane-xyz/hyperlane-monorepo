import { configs } from '../../networks/testnets';

export const devConfigs = {
  alfajores: configs.alfajores,
  kovan: configs.kovan,
};

export type DevNetworks = keyof typeof devConfigs;
export const domainNames = Object.keys(devConfigs) as DevNetworks[];
