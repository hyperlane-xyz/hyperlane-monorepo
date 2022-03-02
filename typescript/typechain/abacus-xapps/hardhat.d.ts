/* Autogenerated file. Do not edit manually. */
/* tslint:disable */
/* eslint-disable */

import { ethers } from "ethers";
import {
  FactoryOptions,
  HardhatEthersHelpers as HardhatEthersHelpersBase,
} from "@nomiclabs/hardhat-ethers/types";

import * as Contracts from ".";

declare module "hardhat/types/runtime" {
  interface HardhatEthersHelpers extends HardhatEthersHelpersBase {
    getContractFactory(
      name: "Common",
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<Contracts.Common__factory>;
    getContractFactory(
      name: "Inbox",
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<Contracts.Inbox__factory>;
    getContractFactory(
      name: "MerkleTreeManager",
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<Contracts.MerkleTreeManager__factory>;
    getContractFactory(
      name: "Outbox",
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<Contracts.Outbox__factory>;
    getContractFactory(
      name: "UpgradeBeaconProxy",
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<Contracts.UpgradeBeaconProxy__factory>;
    getContractFactory(
      name: "Version0",
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<Contracts.Version0__factory>;
    getContractFactory(
      name: "XAppConnectionManager",
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<Contracts.XAppConnectionManager__factory>;
    getContractFactory(
      name: "IMessageRecipient",
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<Contracts.IMessageRecipient__factory>;
    getContractFactory(
      name: "IValidatorManager",
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<Contracts.IValidatorManager__factory>;
    getContractFactory(
      name: "OwnableUpgradeable",
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<Contracts.OwnableUpgradeable__factory>;
    getContractFactory(
      name: "Ownable",
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<Contracts.Ownable__factory>;
    getContractFactory(
      name: "IERC20",
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<Contracts.IERC20__factory>;
    getContractFactory(
      name: "TypedMemView",
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<Contracts.TypedMemView__factory>;
    getContractFactory(
      name: "BridgeRouter",
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<Contracts.BridgeRouter__factory>;
    getContractFactory(
      name: "BridgeToken",
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<Contracts.BridgeToken__factory>;
    getContractFactory(
      name: "ETHHelper",
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<Contracts.ETHHelper__factory>;
    getContractFactory(
      name: "MockWeth",
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<Contracts.MockWeth__factory>;
    getContractFactory(
      name: "TestBridgeMessage",
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<Contracts.TestBridgeMessage__factory>;
    getContractFactory(
      name: "TestEncoding",
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<Contracts.TestEncoding__factory>;
    getContractFactory(
      name: "TokenRegistry",
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<Contracts.TokenRegistry__factory>;
    getContractFactory(
      name: "ERC20",
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<Contracts.ERC20__factory>;
    getContractFactory(
      name: "GovernanceRouter",
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<Contracts.GovernanceRouter__factory>;
    getContractFactory(
      name: "TestSet",
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<Contracts.TestSet__factory>;
    getContractFactory(
      name: "PingPongRouter",
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<Contracts.PingPongRouter__factory>;
    getContractFactory(
      name: "Router",
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<Contracts.Router__factory>;
    getContractFactory(
      name: "RouterTemplate",
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<Contracts.RouterTemplate__factory>;
    getContractFactory(
      name: "XAppConnectionClient",
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<Contracts.XAppConnectionClient__factory>;
    getContractFactory(
      name: "IBridgeToken",
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<Contracts.IBridgeToken__factory>;
    getContractFactory(
      name: "IWeth",
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<Contracts.IWeth__factory>;

    // default types
    getContractFactory(
      name: string,
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<ethers.ContractFactory>;
    getContractFactory(
      abi: any[],
      bytecode: ethers.utils.BytesLike,
      signer?: ethers.Signer
    ): Promise<ethers.ContractFactory>;
  }
}
