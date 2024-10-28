import {
  ChainName,
  S3Validator,
  defaultMultisigConfigs,
} from '@hyperlane-xyz/sdk';

import { isEthereumProtocolChain } from '../../src/utils/utils.js';
import { getArgs, withChains } from '../agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from '../core-utils.js';

const acceptableValidatorVersions = [
  'a64af8be9a76120d0cfc727bb70660fa07e70cce', // pre-1.0.0
  'ffbe1dd82e2452dbc111b6fb469a34fb870da8f1', // 1.0.0
];

// TODO: refactor multisigIsm.ts to include mappings of addresses to aliases as part of the config
// This will also allow us to programmatically generate the default ISM docs page.
const KNOWN_VALIDATOR_ADDRESSES: Record<string, string> = {
  '0x5450447aee7b544c462c9352bef7cad049b0c2dc': 'zeeprime',
  '0xb3ac35d3988bca8c2ffd195b1c6bee18536b317b': 'staked',
  '0x38c7a4ca1273ead2e867d096adbcdd0e2acb21d8': 'everstake',
  '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f': 'merkly',
  '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36': 'mitosis',
  '0xec68258a7c882ac2fc46b81ce80380054ffb4ef2': 'dsrv', // from arbitrum
  '0x402e0f8c6e4210d408b6ac00d197d4a099fcd25a': 'dsrv', // from avalanche
  '0xcff391b4e516452d424db66beb9052b041a9ed79': 'dsrv', // from base
  '0x8292b1a53907ece0f76af8a50724e9492bcdc8a3': 'dsrv', // from bsc
  '0x622e43baf06ad808ca8399360d9a2d9a1a12688b': 'dsrv', // from celo
  '0xcc9a0b6de7fe314bd99223687d784730a75bb957': 'dsrv', // from mantapacific
  '0x008f24cbb1cc30ad0f19f2516ca75730e37efb5f': 'dsrv', // from polygon
  '0x865818fe1db986036d5fd0466dcd462562436d1a': 'dsrv', // from polygonzkevm
  '0xd90ea26ff731d967c5ea660851f7d63cb04ab820': 'dsrv', // from solanamainnet
  '0x19fb7e04a1be6b39b6966a0b0c60b929a93ed672': 'dsrv', // from gnosis
  '0x94438a7de38d4548ae54df5c6010c4ebc5239eae': 'dsrv', // from ethereum
  '0x5b7d47b76c69740462432f6a5a0ca5005e014157': 'dsrv', // from optimism
  '0xbac4ac39f1d8b5ef15f26fdb1294a7c9aba3f948': 'dsrv', // from scroll
  '0x47aa126e05933b95c5eb90b26e6b668d84f4b25a': 'dsrv', // from neutron
  '0xa3eaa1216827ad63dd9db43f6168258a89177990': 'dsrv', // from stride
  '0x645428d198d2e76cbd9c1647f5c80740bb750b97': 'dsrv', // from moonbeam
  '0x0180444c9342bd672867df1432eb3da354413a6e': 'hashkey cloud',
  '0x0230505530b80186f8cdccfaf9993eb97aebe98a': 'mint',
  '0x032de4f94676bf9314331e7d83e8db4ac74c9e21': 'oort',
  '0x1da9176c2ce5cc7115340496fa7d1800a98911ce': 'renzo',
  '0x25b9a0961c51e74fd83295293bc029131bf1e05a': 'neutron',
  '0x42b6de2edbaa62c2ea2309ad85d20b3e37d38acf': 'sg-1',
  '0x4e53da92cd5bf0a032b6b4614b986926456756a7': 'blockpi',
  '0x521a3e6bf8d24809fde1c1fd3494a859a16f132c': 'cosmostation',
  '0x6760226b34213d262d41d5291ed57e81a68b4e0b': 'fuse',
  '0x6b1d09a97b813d53e9d4b7523da36604c0b52242': 'caldera',
  '0x7419021c0de2772b763e554480158a82a291c1f2': 'fusionist',
  '0x7e29608c6e5792bbf9128599ca309be0728af7b4': 'renzo',
  '0x95c7bf235837cb5a609fe6c95870410b9f68bcff': 'ancient8',
  '0xa0ee95e280d46c14921e524b075d0c341e7ad1c8': 'cosmos spaces',
  '0xa3f93fe365bf99f431d8fde740b140615e24f99b': 'rockx',
  '0xa5a56e97fb46f0ac3a3d261e404acb998d9a6969': 'coin98',
  '0xae53467a5c2a9d9420c188d10fef5e1d9b9a5b80': 'superform',
  '0xbf1023eff3dba21263bf2db2add67a0d6bcda2de': 'pier two',
  '0xd79dfbf56ee2268f061cc613027a44a880f61ba2': 'everclear',
  '0xe271ef9a6e312540f099a378865432fa73f26689': 'tangle',
};

async function main() {
  const { environment, chains } = await withChains(getArgs()).argv;

  const config = getEnvironmentConfig(environment);
  const { core } = await getHyperlaneCore(environment);

  const targetNetworks = (
    chains && chains.length > 0 ? chains : config.supportedChainNames
  ).filter(isEthereumProtocolChain);

  const mismatchedValidators: {
    chain: ChainName;
    validator: string;
    alias?: string;
    actual: string;
  }[] = [];

  await Promise.all(
    targetNetworks.map(async (chain) => {
      const validatorAnnounce = core.getContracts(chain).validatorAnnounce;
      const expectedValidators = defaultMultisigConfigs[chain].validators || [];
      const storageLocations = await validatorAnnounce[
        'getAnnouncedStorageLocations(address[])'
      ](expectedValidators);

      // For each validator on this chain
      for (let i = 0; i < expectedValidators.length; i++) {
        const validator = expectedValidators[i];
        const location = storageLocations[i][0];
        const alias = KNOWN_VALIDATOR_ADDRESSES[validator.toLowerCase()]
          ? { alias: KNOWN_VALIDATOR_ADDRESSES[validator.toLowerCase()] }
          : {};

        // Get metadata from each storage location
        try {
          const s3Validator = await S3Validator.fromStorageLocation(location);
          const metadata = await s3Validator.getMetadata();
          const gitSha = metadata?.git_sha;

          if (!acceptableValidatorVersions.includes(gitSha)) {
            mismatchedValidators.push({
              chain,
              validator,
              actual: gitSha || 'missing',
              ...alias,
            });
          }
        } catch (error) {
          console.warn(
            `Error getting metadata for validator ${validator} on chain ${chain}: ${error}`,
          );
          mismatchedValidators.push({
            chain,
            validator,
            actual: `UNKNOWN`,
            ...alias,
          });
        }
      }
    }),
  );

  if (mismatchedValidators.length > 0) {
    console.log(
      'Expecting validators to have one of the following git SHA:',
      acceptableValidatorVersions,
    );
    console.log('\n⚠️ Validators with mismatched git SHA:');
    console.table(
      mismatchedValidators.sort((a, b) => {
        // First sort by alias
        if (a.alias && !b.alias) return -1;
        if (!a.alias && b.alias) return 1;
        if (a.alias && b.alias) {
          const aliasCompare = a.alias.localeCompare(b.alias);
          if (aliasCompare !== 0) return aliasCompare;
        }
        // Then sort by validator address
        return a.validator
          .toLowerCase()
          .localeCompare(b.validator.toLowerCase());
      }),
      ['chain', 'validator', 'alias', 'actual'],
    );
    process.exit(1);
  } else {
    console.log('\n✅ All validators running expected git SHA!');
  }
}

main().catch(console.error);
