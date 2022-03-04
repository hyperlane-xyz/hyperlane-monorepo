import { ethers} from 'ethers';
import { abacus, types } from '@abacus-network/abacus-deploy'
import { HardhatAbacusHelpers } from './types';

async function deploy(domains: types.Domain[], signer: ethers.Signer) {
  const chains: Record<number, types.ChainConfig> = {};
  const validators: Record<number, types.Address> = {};
  const overrides = {};
  for (const domain of domains) {
    chains[domain] = { name: domain.toString(), domain, signer, overrides };
    validators[domain] = await signer.getAddress();
  }
  const config: abacus.types.CoreConfig = {
    processGas: 850_000,
    reserveGas: 15_000,
    validators,
  };
  return abacus.CoreDeploy.deploy(chains, config);
}


export const abc: HardhatAbacusHelpers = {
  deploy,
};

