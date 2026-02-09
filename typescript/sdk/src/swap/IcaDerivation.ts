import { OwnableMulticall__factory } from '@hyperlane-xyz/core';
import { addressToBytes32 } from '@hyperlane-xyz/utils';
import { constants, utils } from 'ethers';

import { IcaConfig } from './types.js';

const MINIMAL_PROXY_PREFIX = '0x3d602d80600a3d3981f3363d3d373d3d3d363d73';
const MINIMAL_PROXY_SUFFIX = '0x5af43d82803e903d91602b57fd5bf3';

function normalizeSalt(userSalt?: string): string {
  if (!userSalt) return constants.HashZero;
  if (utils.isHexString(userSalt, 32)) return userSalt;
  return utils.keccak256(utils.toUtf8Bytes(userSalt));
}

function getSalt(config: IcaConfig): string {
  return utils.keccak256(
    utils.solidityPack(
      ['uint32', 'bytes32', 'bytes32', 'bytes32', 'bytes32'],
      [
        config.origin,
        addressToBytes32(config.owner),
        addressToBytes32(config.routerAddress),
        addressToBytes32(config.ismAddress),
        normalizeSalt(config.userSalt),
      ],
    ),
  );
}

function getImplementationAddress(routerAddress: string): string {
  const implementationInitCode = utils.hexConcat([
    OwnableMulticall__factory.bytecode,
    utils.defaultAbiCoder.encode(['address'], [routerAddress]),
  ]);
  return utils.getCreate2Address(
    routerAddress,
    constants.HashZero,
    utils.keccak256(implementationInitCode),
  );
}

function getProxyBytecodeHash(implementationAddress: string): string {
  const proxyBytecode = utils.hexConcat([
    MINIMAL_PROXY_PREFIX,
    implementationAddress,
    MINIMAL_PROXY_SUFFIX,
  ]);
  return utils.keccak256(proxyBytecode);
}

export function deriveIcaAddress(config: IcaConfig): string {
  const implementationAddress = getImplementationAddress(config.routerAddress);
  const bytecodeHash = getProxyBytecodeHash(implementationAddress);
  return utils.getCreate2Address(
    config.routerAddress,
    getSalt(config),
    bytecodeHash,
  );
}
