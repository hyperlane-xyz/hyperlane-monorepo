import { ethers } from 'ethers';

import { DomainIdToChainName, VerificationInput } from '@abacus-network/sdk';

import { readJSON } from '../src/utils/utils';

import {
  getCoreContractsSdkFilepath,
  getCoreVerificationDirectory,
  getEnvironment,
} from './utils';

async function main() {
  const environment = await getEnvironment();

  let simulatedVerification = readJSON(
    getCoreVerificationDirectory(environment),
    'verification.json',
  );
  const coreAddresses = readJSON(
    getCoreContractsSdkFilepath(),
    `${environment}.json`,
  );

  for (const chain of Object.keys(coreAddresses)) {
    console.group(chain);
    const verification = simulatedVerification[chain] as VerificationInput;
    const addresses = coreAddresses[chain];

    // @ts-ignore
    const arbitraryInbox = Object.values(addresses.inboxes)[0].inbox;

    let beacons: any = {};

    for (const input of verification) {
      let actual = ethers.constants.AddressZero;
      switch (input.name) {
        case 'upgradeBeaconController':
        case 'abacusConnectionManager':
        case 'outboxValidatorManager':
        case 'interchainGasPaymaster':
          actual = addresses[input.name];
          break;
        case 'outbox':
          actual = addresses.outbox.implementation;
          break;
        case 'inbox':
          actual = arbitraryInbox.implementation;
          break;
        case 'inboxValidatorManager':
          const remoteDomainId = input.constructorArguments[0];
          const remoteChain = DomainIdToChainName[remoteDomainId];
          actual = addresses.inboxes[remoteChain].inboxValidatorManager;
          break;
        case 'UpgradeBeacon':
          const [implementation, _controller] = input.constructorArguments;
          // match implementation with outbox or inbox
          const outboxVerificationInput = verification.find(
            (v) => v.name === 'outbox',
          )!;
          const inboxVerificationInput = verification.find(
            (v) => v.name === 'inbox',
          )!;
          if (outboxVerificationInput.address === implementation) {
            beacons['outbox'] = input.address;
            actual = addresses.outbox.beacon;
          } else if (inboxVerificationInput.address === implementation) {
            beacons['inbox'] = input.address;
            actual = arbitraryInbox.beacon;
          } else {
            beacons['interchainGasPaymaster'] = input.address;
            actual = ethers.constants.AddressZero;
          }
          break;
        case 'UpgradeBeaconProxy':
          const [beacon, initData] = input.constructorArguments;
          // match beacon with outbox or inbox
          if (beacon === beacons['inbox']) {
            // decode init data
            const abiCoder = new ethers.utils.AbiCoder();
            const inboxInitializeTypes = ['uint32', 'address'];
            const [remoteDomainId, _validatorManager] = abiCoder.decode(
              inboxInitializeTypes,
              `0x${initData.slice(10)}`,
            );
            const remoteChain = DomainIdToChainName[remoteDomainId];

            actual = addresses.inboxes[remoteChain].inbox.proxy;
          } else if (beacon === beacons['outbox']) {
            actual = addresses.outbox.proxy;
          } else {
            // interchainGasPaymaster
            actual = ethers.constants.AddressZero;
          }
          break;
        default:
          throw new Error(`Unknown contract ${input.name}`);
      }
      console.log(`${input.address} ${actual} ${input.name}`);
    }

    console.groupEnd();
  }
  // writeJSON(
  //   getCoreVerificationDirectory(environment),
  //   'patched_verification.json',
  //   simulatedVerification
  // );
}

main().then().catch();
