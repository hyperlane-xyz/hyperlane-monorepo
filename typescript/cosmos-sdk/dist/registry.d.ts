import * as types from '@hyperlane-xyz/cosmos-types';

type RawCosmosModuleMessageRegistry<T> = {
  [Key in keyof Omit<
    T,
    'protobufPackage' | 'MsgServiceName' | 'MsgClientImpl'
  >]: {
    proto: {
      type: string;
      converter: T[Key];
    };
    amino?: {
      type: string;
      converter?: T[Key];
    };
  };
};
type CoreCosmosModuleMesageRegistry = RawCosmosModuleMessageRegistry<
  typeof types.coreTx
>;
type IsmCosmosModuleMessafeRegistry = RawCosmosModuleMessageRegistry<
  typeof types.isTx
>;
type PostDispatchCosmosModuleMessageRegistry = RawCosmosModuleMessageRegistry<
  typeof types.pdTx
>;
type WarpTransactionCosmosModuleMessageRegistry =
  RawCosmosModuleMessageRegistry<typeof types.warpTx>;
type CosmosModuleMessageRegistry = CoreCosmosModuleMesageRegistry &
  IsmCosmosModuleMessafeRegistry &
  PostDispatchCosmosModuleMessageRegistry &
  WarpTransactionCosmosModuleMessageRegistry;
export declare const COSMOS_MODULE_MESSAGE_REGISTRY: CosmosModuleMessageRegistry;
export {};
//# sourceMappingURL=registry.d.ts.map
