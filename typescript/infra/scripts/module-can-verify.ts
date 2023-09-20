import {
  ChainMap,
  HyperlaneCore,
  moduleCanCertainlyVerify,
} from '@hyperlane-xyz/sdk';
import { Address, ProtocolType } from '@hyperlane-xyz/utils';

import { deployEnvToSdkEnv } from '../src/config/environment';

import { getArgs, getEnvironmentConfig } from './utils';

const mainnetHyperlaneDefaultIsmCache: ChainMap<Address> = {
  ethereum: '0x3Ef03aEf1392E5e0C16fd4D22C3c3b4f81C8AF0C',
  optimism: '0xA7a0f9CB7d3bc3520A82ECF009F8f3949a926237',
  arbitrum: '0xD629aB5353D6B11f52eD80EFb26a28e5E347B52F',
  avalanche: '0x143A34E3Eaf1E77a8c994EcADb5268d717183150',
  polygon: '0xE1403b9d64185f715414A4a7BEcec124Bd9198A7',
  bsc: '0x307c66E1E2E9f20b6ED3c4561398215CF9b633c4',
  celo: '0xAC0246a09f1FEaF4CEe32e43792eE12d6B277332',
  moonbeam: '0xB32d147334AF9C15A65716Ab254a2460307648D1',
  gnosis: '0xF6c174AcC399eD8407663387857f30f92B0db958',
};

// Hacky temporary script just to make sure that default ISMs are correct.
// Testnet3 has already been updated, mainnet2 hasn't, so the above cache
// is used for mainnet2.

async function main() {
  const args = await getArgs().argv;

  const { environment } = args;

  const config = getEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  const core = HyperlaneCore.fromEnvironment(
    deployEnvToSdkEnv[environment],
    multiProvider,
  );

  for (const local of core.chains()) {
    if (
      multiProvider.getChainMetadata(local).protocol !== ProtocolType.Ethereum
    ) {
      continue;
    }

    let ismToCheck = '';
    if (environment === 'testnet3') {
      ismToCheck = await core.getContracts(local).mailbox.defaultIsm();
    } else if (environment === 'mainnet2') {
      ismToCheck = mainnetHyperlaneDefaultIsmCache[local]!;
    } else {
      throw new Error(`Unsupported environment ${environment}`);
    }

    const remotes = multiProvider.getRemoteChains(local);
    for (const remote of remotes) {
      console.log(`Checking chain ${local} can receive from ${remote}...`);
      const canVerify = await moduleCanCertainlyVerify(
        ismToCheck,
        multiProvider,
        remote,
        local,
      );
      if (canVerify) {
        console.log('All good!');
      } else {
        console.error(`Chain ${local} cannot receive from ${remote}!!!!`);
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
