import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { IsmType } from '@hyperlane-xyz/provider-sdk/ism';

export function altVMIsmTypeToProviderSdkType(
  altVMType: AltVM.IsmType,
): IsmType {
  switch (altVMType) {
    case AltVM.IsmType.TEST_ISM:
      return AltVM.IsmType.TEST_ISM;
    case AltVM.IsmType.MERKLE_ROOT_MULTISIG:
      return AltVM.IsmType.MERKLE_ROOT_MULTISIG;
    case AltVM.IsmType.MESSAGE_ID_MULTISIG:
      return AltVM.IsmType.MESSAGE_ID_MULTISIG;
    case AltVM.IsmType.ROUTING:
      return AltVM.IsmType.ROUTING;
    default:
      throw new Error(
        `Unsupported ISM type: AltVM ISM type ${altVMType} is not supported by the provider sdk`,
      );
  }
}
