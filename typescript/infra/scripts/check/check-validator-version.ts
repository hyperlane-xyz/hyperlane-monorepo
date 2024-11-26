import { execSync } from 'child_process';

import { ValidatorAnnounce__factory } from '@hyperlane-xyz/core';
import {
  ChainMap,
  ChainName,
  S3Validator,
  defaultMultisigConfigs,
} from '@hyperlane-xyz/sdk';
import { eqAddress } from '@hyperlane-xyz/utils';

import mainnet3validators from '../../config/environments/mainnet3/aw-validators/hyperlane.json';
import testnet4validators from '../../config/environments/testnet4/aw-validators/hyperlane.json';
import { isEthereumProtocolChain } from '../../src/utils/utils.js';
import { getArgs, withChains } from '../agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from '../core-utils.js';

// prettier-ignore
const acceptableValidatorVersions: Record<string, string> = {
  '72d498fa984750b9137c1211fef6c80a3e594ce7': 'aug-27-batch', // Aug 27 deploy
  'd71dd4e5ed7eb69cc4041813ef444e37d881cdda': 'sep-9-batch', // Sep 9 deploy
  '45399a314cec85723bbb5d2360531c96a3aa261e': 'oct-27-batch', // Oct 27 deploy
  '75d62ae7bbdeb77730c6d343c4fc1df97a08abe4': 'nov-7-batch', // Nov 7 deploy
  'a64af8be9a76120d0cfc727bb70660fa07e70cce': 'pre-1.0.0', // pre-1.0.0
  'ffbe1dd82e2452dbc111b6fb469a34fb870da8f1': '1.0.0', // 1.0.0
  '79453fcd972a1e62ba8ee604f0a4999c7b938582': 'tesselated-special-build', // Tessellated's Own Build
};

// TODO: refactor multisigIsm.ts to include mappings of addresses to aliases as part of the config
// This will also allow us to programmatically generate the default ISM docs page.
const KNOWN_VALIDATOR_ADDRESSES: Record<string, string> = {
  '0x5450447aee7b544c462c9352bef7cad049b0c2dc': 'Zee Prime',
  '0xb3ac35d3988bca8c2ffd195b1c6bee18536b317b': 'Staked',
  '0x38c7a4ca1273ead2e867d096adbcdd0e2acb21d8': 'Everstake',
  '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f': 'Merkly',
  '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36': 'Mitosis',
  '0xec68258a7c882ac2fc46b81ce80380054ffb4ef2': 'DSRV', // from arbitrum
  '0x402e0f8c6e4210d408b6ac00d197d4a099fcd25a': 'DSRV', // from avalanche
  '0xcff391b4e516452d424db66beb9052b041a9ed79': 'DSRV', // from base
  '0x8292b1a53907ece0f76af8a50724e9492bcdc8a3': 'DSRV', // from bsc
  '0x622e43baf06ad808ca8399360d9a2d9a1a12688b': 'DSRV', // from celo
  '0xcc9a0b6de7fe314bd99223687d784730a75bb957': 'DSRV', // from mantapacific
  '0x008f24cbb1cc30ad0f19f2516ca75730e37efb5f': 'DSRV', // from polygon
  '0x865818fe1db986036d5fd0466dcd462562436d1a': 'DSRV', // from polygonzkevm
  '0xd90ea26ff731d967c5ea660851f7d63cb04ab820': 'DSRV', // from solanamainnet
  '0x19fb7e04a1be6b39b6966a0b0c60b929a93ed672': 'DSRV', // from gnosis
  '0x94438a7de38d4548ae54df5c6010c4ebc5239eae': 'DSRV', // from ethereum
  '0x5b7d47b76c69740462432f6a5a0ca5005e014157': 'DSRV', // from optimism
  '0xbac4ac39f1d8b5ef15f26fdb1294a7c9aba3f948': 'DSRV', // from scroll
  '0x47aa126e05933b95c5eb90b26e6b668d84f4b25a': 'DSRV', // from neutron
  '0xa3eaa1216827ad63dd9db43f6168258a89177990': 'DSRV', // from stride
  '0x645428d198d2e76cbd9c1647f5c80740bb750b97': 'DSRV', // from moonbeam
  '0x0180444c9342bd672867df1432eb3da354413a6e': 'Hashkey Cloud',
  '0x0230505530b80186f8cdccfaf9993eb97aebe98a': 'Mint',
  '0x032de4f94676bf9314331e7d83e8db4ac74c9e21': 'Oort',
  '0x1da9176c2ce5cc7115340496fa7d1800a98911ce': 'Renzo',
  '0x25b9a0961c51e74fd83295293bc029131bf1e05a': 'Neutron',
  '0x42b6de2edbaa62c2ea2309ad85d20b3e37d38acf': 'SG-1',
  '0x4e53da92cd5bf0a032b6b4614b986926456756a7': 'BlockPi',
  '0x521a3e6bf8d24809fde1c1fd3494a859a16f132c': 'Cosmostation',
  '0x6760226b34213d262d41d5291ed57e81a68b4e0b': 'Fuse',
  '0x6b1d09a97b813d53e9d4b7523da36604c0b52242': 'Caldera',
  '0x7419021c0de2772b763e554480158a82a291c1f2': 'Fusionist',
  '0x7e29608c6e5792bbf9128599ca309be0728af7b4': 'Renzo',
  '0x95c7bf235837cb5a609fe6c95870410b9f68bcff': 'Ancient8',
  '0xa0ee95e280d46c14921e524b075d0c341e7ad1c8': 'Cosmos Spaces',
  '0xa3f93fe365bf99f431d8fde740b140615e24f99b': 'RockX',
  '0xa5a56e97fb46f0ac3a3d261e404acb998d9a6969': 'Coin98',
  '0xae53467a5c2a9d9420c188d10fef5e1d9b9a5b80': 'Superform',
  '0xbf1023eff3dba21263bf2db2add67a0d6bcda2de': 'Pier Two',
  '0xd79dfbf56ee2268f061cc613027a44a880f61ba2': 'Everclear',
  '0xe271ef9a6e312540f099a378865432fa73f26689': 'Tangle',
  '0x101ce77261245140a0871f9407d6233c8230ec47': 'Blockhunters',
  '0x7ac6584c068eb2a72d4db82a7b7cd5ab34044061': 'Luganodes',
  '0x2f007c82672f2bb97227d4e3f80ac481bfb40a2a': 'Luganodes',
  '0x25b3a88f7cfd3c9f7d7e32b295673a16a6ddbd91': 'Luganodes',
  '0xb683b742b378632a5f73a2a5a45801b3489bba44': 'Luganodes',
  '0x11e2a683e83617f186614071e422b857256a9aae': 'Imperator',
  '0x7089b6352d37d23fb05a7fee4229c78e038fba09': 'imperator',
  '0xfed056cc0967f5bc9c6350f6c42ee97d3983394d': 'imperator',
  '0x9ab11f38a609940153850df611c9a2175dcffe0f': 'imperator',
  '0x75237d42ce8ea27349a0254ada265db94157e0c1': 'imperator',
  '0x14025fe092f5f8a401dd9819704d9072196d2125': 'P2P',
  '0x14d0b24d3a8f3aad17db4b62cbcec12821c98cb3': 'Bware',
  '0x0d4e7e64f3a032db30b75fe7acae4d2c877883bc': 'Decentrio',
  '0x0d4c1394a255568ec0ecd11795b28d1bda183ca4': 'Tessellated',
  '0x3da4ee2801ec6cc5fad73dbb94b10a203adb3d9e': 'Enigma',
  '0x4df6e8878992c300e7bfe98cac6bf7d3408b9cbf': 'Imperator',
  '0x14adb9e3598c395fe3290f3ba706c3816aa78f59': 'Flow Foundation',
};

type ValidatorInfo = {
  chain: ChainName;
  validator: string;
  alias: string;
  version: string;
};

function sortValidatorInfo(a: ValidatorInfo, b: ValidatorInfo) {
  // First sort by alias
  if (a.alias && !b.alias) return -1;
  if (!a.alias && b.alias) return 1;
  if (a.alias && b.alias) {
    const aliasCompare = a.alias.localeCompare(b.alias);
    if (aliasCompare !== 0) return aliasCompare;
  }
  // Then sort by validator address
  return a.chain.localeCompare(b.chain);
}

function _getCommitDate(sha: string): string | undefined {
  try {
    // Try to fetch the commit first if we don't have it
    try {
      execSync(`git fetch origin ${sha}`, { stdio: 'ignore' });
    } catch {
      // Ignore fetch errors - commit might be local or unreachable
    }

    const date = execSync(`git show -s --format=%ci ${sha}`, {
      encoding: 'utf-8',
    }).trim();
    return date;
  } catch {
    return undefined;
  }
}

async function main() {
  const { environment, chains, showUpdated } = await withChains(getArgs())
    .describe(
      'show-updated',
      'If enabled, prints a table with all updated validators',
    )
    .boolean('show-updated')
    .default('show-updated', false).argv;

  const config = getEnvironmentConfig(environment);
  const { core } = await getHyperlaneCore(environment);

  const awValidators: ChainMap<{ validators: string[] }> =
    environment === 'mainnet3' ? mainnet3validators : testnet4validators;

  const targetNetworks = (
    chains && chains.length > 0 ? chains : config.supportedChainNames
  ).filter(isEthereumProtocolChain);

  const mismatchedValidators: ValidatorInfo[] = [];
  const upgradedValidators: ValidatorInfo[] = [];

  // Manually add validator announce for OG Lumia chain deployment
  const lumiaValidatorAnnounce = ValidatorAnnounce__factory.connect(
    '0x989B7307d266151BE763935C856493D968b2affF',
    core.multiProvider.getProvider('lumia'),
  );

  await Promise.all(
    targetNetworks.map(async (chain) => {
      const validatorAnnounce =
        chain === 'lumia'
          ? lumiaValidatorAnnounce
          : core.getContracts(chain).validatorAnnounce;
      const expectedValidators = defaultMultisigConfigs[chain].validators || [];
      const storageLocations =
        await validatorAnnounce.getAnnouncedStorageLocations(
          expectedValidators,
        );

      // For each validator on this chain
      for (let i = 0; i < expectedValidators.length; i++) {
        const validator = expectedValidators[i];
        const location = storageLocations[i][0];
        let alias =
          KNOWN_VALIDATOR_ADDRESSES[validator.toLowerCase()] ?? 'UNKNOWN';

        if (chain in awValidators) {
          for (const v of awValidators[chain].validators) {
            if (eqAddress(v, validator)) {
              alias = 'Abacus Works';
              break;
            }
          }
        }

        // Get metadata from each storage location
        try {
          const validatorInstance = await S3Validator.fromStorageLocation(
            location,
          );

          const metadata = await validatorInstance.getMetadata();
          const gitSha = metadata?.git_sha;

          if (Object.keys(acceptableValidatorVersions).includes(gitSha)) {
            upgradedValidators.push({
              chain,
              validator,
              alias,
              version: acceptableValidatorVersions[gitSha],
            });
          } else {
            mismatchedValidators.push({
              chain,
              validator,
              alias,
              version: gitSha || 'missing',
            });
          }
        } catch (error) {
          console.warn(
            `Error getting metadata for validator ${validator} on chain ${chain}: ${error}`,
          );
          mismatchedValidators.push({
            chain,
            validator,
            alias,
            version: `UNKNOWN`,
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
    console.table(mismatchedValidators.sort(sortValidatorInfo));

    if (showUpdated) {
      console.log('\n✅ Validators with expected git SHA:');
      console.table(upgradedValidators.sort(sortValidatorInfo));
    }
    process.exit(1);
  }

  if (showUpdated) {
    console.log('\n✅ Validators with expected git SHA:');
    console.table(upgradedValidators.sort(sortValidatorInfo));
  }
  console.log('\n✅ All validators running expected git SHA!');
  process.exit(0);
}

main().catch(console.error);
