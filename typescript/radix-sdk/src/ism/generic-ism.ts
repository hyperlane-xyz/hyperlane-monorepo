import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import {
  ArtifactDeployed,
  ArtifactReader,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedIsmAddresses,
  IsmType,
  RawIsmArtifactConfig,
  RawIsmArtifactConfigs,
  altVMIsmTypeToProviderSdkType,
} from '@hyperlane-xyz/provider-sdk/ism';

import { RadixIsmTypes } from '../utils/types.js';

import { getIsmType } from './ism-query.js';
import {
  RadixMerkleRootMultisigIsmReader,
  RadixMessageIdMultisigIsmReader,
} from './multisig-ism.js';
import { RadixRoutingIsmRawReader } from './routing-ism.js';
import { RadixTestIsmReader } from './test-ism.js';

function radixIsmTypeToAltVmType(radixType: RadixIsmTypes): AltVM.IsmType {
  switch (radixType) {
    case RadixIsmTypes.MERKLE_ROOT_MULTISIG:
      return AltVM.IsmType.MERKLE_ROOT_MULTISIG;
    case RadixIsmTypes.MESSAGE_ID_MULTISIG:
      return AltVM.IsmType.MESSAGE_ID_MULTISIG;
    case RadixIsmTypes.ROUTING_ISM:
      return AltVM.IsmType.ROUTING;
    case RadixIsmTypes.NOOP_ISM:
      return AltVM.IsmType.TEST_ISM;
    default:
      throw new Error(`Unsupported Radix ISM type: ${radixType}`);
  }
}

export function createRadixIsmReader<T extends IsmType>(
  gateway: Readonly<GatewayApiClient>,
  type: T,
): ArtifactReader<RawIsmArtifactConfigs[T], DeployedIsmAddresses> {
  switch (type) {
    case AltVM.IsmType.TEST_ISM:
      return new RadixTestIsmReader(gateway) as unknown as ArtifactReader<
        RawIsmArtifactConfigs[T],
        DeployedIsmAddresses
      >;
    case AltVM.IsmType.MERKLE_ROOT_MULTISIG:
      return new RadixMerkleRootMultisigIsmReader(
        gateway,
      ) as unknown as ArtifactReader<
        RawIsmArtifactConfigs[T],
        DeployedIsmAddresses
      >;
    case AltVM.IsmType.MESSAGE_ID_MULTISIG:
      return new RadixMessageIdMultisigIsmReader(
        gateway,
      ) as unknown as ArtifactReader<
        RawIsmArtifactConfigs[T],
        DeployedIsmAddresses
      >;
    case AltVM.IsmType.ROUTING:
      return new RadixRoutingIsmRawReader(gateway) as unknown as ArtifactReader<
        RawIsmArtifactConfigs[T],
        DeployedIsmAddresses
      >;
    default:
      throw new Error(`Unsupported ISM type: ${type}`);
  }
}

export class RadixGenericIsmReader
  implements ArtifactReader<RawIsmArtifactConfig, DeployedIsmAddresses>
{
  constructor(private readonly gateway: Readonly<GatewayApiClient>) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<RawIsmArtifactConfig, DeployedIsmAddresses>> {
    const radixType = await getIsmType(this.gateway, address);
    const altVmType = radixIsmTypeToAltVmType(radixType);
    const ismType = altVMIsmTypeToProviderSdkType(altVmType);

    const reader = createRadixIsmReader(this.gateway, ismType);
    const result = await reader.read(address);
    // Explicit cast since TS might not infer union subtype automatically for Promise result
    return result as ArtifactDeployed<
      RawIsmArtifactConfig,
      DeployedIsmAddresses
    >;
  }
}
