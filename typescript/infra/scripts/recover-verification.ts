import { ethers } from 'ethers';

import {
  UpgradeBeaconProxy__factory,
  UpgradeBeacon__factory,
} from '@abacus-network/core';
import { VerificationInput, coreFactories } from '@abacus-network/sdk';

import { readJSON, writeJSON } from '../src/utils/utils';

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
    // const addresses = coreAddresses[chain];

    // @ts-ignore
    // const arbitraryInbox = Object.values(addresses.inboxes)[0].inbox;

    // let beacons: any = {};
    // let replaceMap: any = {};

    // populate address replacement map
    verification.forEach((input, i) => {
      // for (const input of verification) {
      //   let actual = ethers.constants.AddressZero;
      //   switch (input.name) {
      //     case 'UpgradeBeaconController':
      //     case 'AbacusConnectionManager':
      //     case 'OutboxValidatorManager':
      //       actual = addresses[input.name];
      //       break;
      //     case 'InterchainGasPaymaster':
      //       actual = ethers.constants.AddressZero;
      //       break;
      //     case 'Outbox':
      //       actual = addresses.outbox.implementation;
      //       break;
      //     case 'Inbox':
      //       actual = arbitraryInbox.implementation;
      //       break;
      //     case 'InboxValidatorManager':
      //       const remoteDomainId = input.constructorArguments[0];
      //       const remoteChain = DomainIdToChainName[remoteDomainId];
      //       actual = addresses.inboxes[remoteChain].inboxValidatorManager;
      //       break;
      //     case 'UpgradeBeacon':
      //       const [implementation, _controller] = input.constructorArguments;
      //       // match implementation with outbox or inbox
      //       const outboxVerificationInput = verification.find(
      //         (v) => v.name === 'outbox',
      //       )!;
      //       const inboxVerificationInput = verification.find(
      //         (v) => v.name === 'inbox',
      //       )!;
      //       if (outboxVerificationInput.address === implementation) {
      //         beacons['outbox'] = input.address;
      //         actual = addresses.outbox.beacon;
      //       } else if (inboxVerificationInput.address === implementation) {
      //         beacons['inbox'] = input.address;
      //         actual = arbitraryInbox.beacon;
      //       } else {
      //         beacons['interchainGasPaymaster'] = input.address;
      //         actual = ethers.constants.AddressZero;
      //       }
      //       break;
      //     case 'UpgradeBeaconProxy':
      //       const [beacon, initData] = input.constructorArguments;
      //       // match beacon with outbox or inbox
      //       if (beacon === beacons['inbox']) {
      //         // decode init data
      //         const abiCoder = new ethers.utils.AbiCoder();
      //         const inboxInitializeTypes = ['uint32', 'address'];
      //         const [remoteDomainId, _validatorManager] = abiCoder.decode(
      //           inboxInitializeTypes,
      //           `0x${initData.slice(10)}`,
      //         );
      //         const remoteChain = DomainIdToChainName[remoteDomainId];

      //         actual = addresses.inboxes[remoteChain].inbox.proxy;
      //       } else if (beacon === beacons['outbox']) {
      //         actual = addresses.outbox.proxy;
      //       } else {
      //         // interchainGasPaymaster
      //         actual = ethers.constants.AddressZero;
      //       }
      //       break;
      //     default:
      //       throw new Error(`Unknown contract ${input.name}`);
      //   }

      let ethersInterface: ethers.utils.Interface;
      if (input.name === 'UpgradeBeacon') {
        ethersInterface = UpgradeBeacon__factory.createInterface();
      } else if (input.name === 'UpgradeBeaconProxy') {
        ethersInterface = UpgradeBeaconProxy__factory.createInterface();
      } else {
        const name = input.name[0].toLowerCase() + input.name.slice(1);
        // @ts-ignore
        ethersInterface = coreFactories[name].interface;
      }

      simulatedVerification[chain][i].constructorArguments =
        ethersInterface.encodeDeploy(input.constructorArguments);

      // console.log(input.name);
      // console.log(encodedConstructorArguments);

      // console.log(`${input.address} ${actual} (${input.name})`);
      // replaceMap[input.address.slice(2)] = actual.slice(2);
    });

    console.groupEnd();
    // replace addresses
    // for (const [key, val] of Object.entries(replaceMap)) {
    //   const searchRegExp = new RegExp(key, 'ig');
    //   simulatedVerificationRaw = simulatedVerificationRaw.replace(
    //     searchRegExp,
    //     val as string,
    //   );
    // }
  }

  // const replaced = JSON.parse(simulatedVerificationRaw);
  writeJSON(
    getCoreVerificationDirectory(environment),
    'verification.json',
    simulatedVerification,
  );
}

main().then().catch();
