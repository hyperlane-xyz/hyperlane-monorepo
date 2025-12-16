import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import {
  ArtifactDeployed,
  ArtifactReader,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedIsmAddresses,
  IRawIsmArtifactManager,
  RawIsmArtifactConfig,
  altVMIsmTypeToProviderSdkType,
} from '@hyperlane-xyz/provider-sdk/ism';

import { RadixIsmTypes } from '../utils/types.js';

import { getIsmType } from './ism-query.js';

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

export class RadixGenericIsmReader
  implements ArtifactReader<RawIsmArtifactConfig, DeployedIsmAddresses>
{
  constructor(
    private readonly gateway: Readonly<GatewayApiClient>,
    private readonly manager: IRawIsmArtifactManager,
  ) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<RawIsmArtifactConfig, DeployedIsmAddresses>> {
    const radixType = await getIsmType(this.gateway, address);
    const altVmType = radixIsmTypeToAltVmType(radixType);
    const ismType = altVMIsmTypeToProviderSdkType(altVmType);

    const reader = this.manager.createReader(ismType);
    const result = await reader.read(address);
    // Explicit cast since TS might not infer union subtype automatically for Promise result
    return result as ArtifactDeployed<
      RawIsmArtifactConfig,
      DeployedIsmAddresses
    >;
  }
}
