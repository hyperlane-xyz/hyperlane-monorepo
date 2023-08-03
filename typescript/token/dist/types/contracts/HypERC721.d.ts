import type {
  EventFragment,
  FunctionFragment,
  Result,
} from '@ethersproject/abi';
import type { Listener, Provider } from '@ethersproject/providers';
import type {
  BaseContract,
  BigNumber,
  BigNumberish,
  BytesLike,
  CallOverrides,
  ContractTransaction,
  Overrides,
  PayableOverrides,
  PopulatedTransaction,
  Signer,
  utils,
} from 'ethers';

import type {
  OnEvent,
  TypedEvent,
  TypedEventFilter,
  TypedListener,
} from '../common';

export declare namespace GasRouter {
  type GasRouterConfigStruct = {
    domain: BigNumberish;
    gas: BigNumberish;
  };
  type GasRouterConfigStructOutput = [number, BigNumber] & {
    domain: number;
    gas: BigNumber;
  };
}
export interface HypERC721Interface extends utils.Interface {
  functions: {
    'approve(address,uint256)': FunctionFragment;
    'balanceOf(address)': FunctionFragment;
    'destinationGas(uint32)': FunctionFragment;
    'domains()': FunctionFragment;
    'enrollRemoteRouter(uint32,bytes32)': FunctionFragment;
    'enrollRemoteRouters(uint32[],bytes32[])': FunctionFragment;
    'getApproved(uint256)': FunctionFragment;
    'handle(uint32,bytes32,bytes)': FunctionFragment;
    'initialize(address,address,uint256,string,string)': FunctionFragment;
    'interchainGasPaymaster()': FunctionFragment;
    'interchainSecurityModule()': FunctionFragment;
    'isApprovedForAll(address,address)': FunctionFragment;
    'mailbox()': FunctionFragment;
    'name()': FunctionFragment;
    'owner()': FunctionFragment;
    'ownerOf(uint256)': FunctionFragment;
    'quoteGasPayment(uint32)': FunctionFragment;
    'renounceOwnership()': FunctionFragment;
    'routers(uint32)': FunctionFragment;
    'safeTransferFrom(address,address,uint256)': FunctionFragment;
    'safeTransferFrom(address,address,uint256,bytes)': FunctionFragment;
    'setApprovalForAll(address,bool)': FunctionFragment;
    'setDestinationGas((uint32,uint256)[])': FunctionFragment;
    'setInterchainGasPaymaster(address)': FunctionFragment;
    'setInterchainSecurityModule(address)': FunctionFragment;
    'setMailbox(address)': FunctionFragment;
    'supportsInterface(bytes4)': FunctionFragment;
    'symbol()': FunctionFragment;
    'tokenByIndex(uint256)': FunctionFragment;
    'tokenOfOwnerByIndex(address,uint256)': FunctionFragment;
    'tokenURI(uint256)': FunctionFragment;
    'totalSupply()': FunctionFragment;
    'transferFrom(address,address,uint256)': FunctionFragment;
    'transferOwnership(address)': FunctionFragment;
    'transferRemote(uint32,bytes32,uint256)': FunctionFragment;
  };
  getFunction(
    nameOrSignatureOrTopic:
      | 'approve'
      | 'balanceOf'
      | 'destinationGas'
      | 'domains'
      | 'enrollRemoteRouter'
      | 'enrollRemoteRouters'
      | 'getApproved'
      | 'handle'
      | 'initialize'
      | 'interchainGasPaymaster'
      | 'interchainSecurityModule'
      | 'isApprovedForAll'
      | 'mailbox'
      | 'name'
      | 'owner'
      | 'ownerOf'
      | 'quoteGasPayment'
      | 'renounceOwnership'
      | 'routers'
      | 'safeTransferFrom(address,address,uint256)'
      | 'safeTransferFrom(address,address,uint256,bytes)'
      | 'setApprovalForAll'
      | 'setDestinationGas'
      | 'setInterchainGasPaymaster'
      | 'setInterchainSecurityModule'
      | 'setMailbox'
      | 'supportsInterface'
      | 'symbol'
      | 'tokenByIndex'
      | 'tokenOfOwnerByIndex'
      | 'tokenURI'
      | 'totalSupply'
      | 'transferFrom'
      | 'transferOwnership'
      | 'transferRemote',
  ): FunctionFragment;
  encodeFunctionData(
    functionFragment: 'approve',
    values: [string, BigNumberish],
  ): string;
  encodeFunctionData(functionFragment: 'balanceOf', values: [string]): string;
  encodeFunctionData(
    functionFragment: 'destinationGas',
    values: [BigNumberish],
  ): string;
  encodeFunctionData(functionFragment: 'domains', values?: undefined): string;
  encodeFunctionData(
    functionFragment: 'enrollRemoteRouter',
    values: [BigNumberish, BytesLike],
  ): string;
  encodeFunctionData(
    functionFragment: 'enrollRemoteRouters',
    values: [BigNumberish[], BytesLike[]],
  ): string;
  encodeFunctionData(
    functionFragment: 'getApproved',
    values: [BigNumberish],
  ): string;
  encodeFunctionData(
    functionFragment: 'handle',
    values: [BigNumberish, BytesLike, BytesLike],
  ): string;
  encodeFunctionData(
    functionFragment: 'initialize',
    values: [string, string, BigNumberish, string, string],
  ): string;
  encodeFunctionData(
    functionFragment: 'interchainGasPaymaster',
    values?: undefined,
  ): string;
  encodeFunctionData(
    functionFragment: 'interchainSecurityModule',
    values?: undefined,
  ): string;
  encodeFunctionData(
    functionFragment: 'isApprovedForAll',
    values: [string, string],
  ): string;
  encodeFunctionData(functionFragment: 'mailbox', values?: undefined): string;
  encodeFunctionData(functionFragment: 'name', values?: undefined): string;
  encodeFunctionData(functionFragment: 'owner', values?: undefined): string;
  encodeFunctionData(
    functionFragment: 'ownerOf',
    values: [BigNumberish],
  ): string;
  encodeFunctionData(
    functionFragment: 'quoteGasPayment',
    values: [BigNumberish],
  ): string;
  encodeFunctionData(
    functionFragment: 'renounceOwnership',
    values?: undefined,
  ): string;
  encodeFunctionData(
    functionFragment: 'routers',
    values: [BigNumberish],
  ): string;
  encodeFunctionData(
    functionFragment: 'safeTransferFrom(address,address,uint256)',
    values: [string, string, BigNumberish],
  ): string;
  encodeFunctionData(
    functionFragment: 'safeTransferFrom(address,address,uint256,bytes)',
    values: [string, string, BigNumberish, BytesLike],
  ): string;
  encodeFunctionData(
    functionFragment: 'setApprovalForAll',
    values: [string, boolean],
  ): string;
  encodeFunctionData(
    functionFragment: 'setDestinationGas',
    values: [GasRouter.GasRouterConfigStruct[]],
  ): string;
  encodeFunctionData(
    functionFragment: 'setInterchainGasPaymaster',
    values: [string],
  ): string;
  encodeFunctionData(
    functionFragment: 'setInterchainSecurityModule',
    values: [string],
  ): string;
  encodeFunctionData(functionFragment: 'setMailbox', values: [string]): string;
  encodeFunctionData(
    functionFragment: 'supportsInterface',
    values: [BytesLike],
  ): string;
  encodeFunctionData(functionFragment: 'symbol', values?: undefined): string;
  encodeFunctionData(
    functionFragment: 'tokenByIndex',
    values: [BigNumberish],
  ): string;
  encodeFunctionData(
    functionFragment: 'tokenOfOwnerByIndex',
    values: [string, BigNumberish],
  ): string;
  encodeFunctionData(
    functionFragment: 'tokenURI',
    values: [BigNumberish],
  ): string;
  encodeFunctionData(
    functionFragment: 'totalSupply',
    values?: undefined,
  ): string;
  encodeFunctionData(
    functionFragment: 'transferFrom',
    values: [string, string, BigNumberish],
  ): string;
  encodeFunctionData(
    functionFragment: 'transferOwnership',
    values: [string],
  ): string;
  encodeFunctionData(
    functionFragment: 'transferRemote',
    values: [BigNumberish, BytesLike, BigNumberish],
  ): string;
  decodeFunctionResult(functionFragment: 'approve', data: BytesLike): Result;
  decodeFunctionResult(functionFragment: 'balanceOf', data: BytesLike): Result;
  decodeFunctionResult(
    functionFragment: 'destinationGas',
    data: BytesLike,
  ): Result;
  decodeFunctionResult(functionFragment: 'domains', data: BytesLike): Result;
  decodeFunctionResult(
    functionFragment: 'enrollRemoteRouter',
    data: BytesLike,
  ): Result;
  decodeFunctionResult(
    functionFragment: 'enrollRemoteRouters',
    data: BytesLike,
  ): Result;
  decodeFunctionResult(
    functionFragment: 'getApproved',
    data: BytesLike,
  ): Result;
  decodeFunctionResult(functionFragment: 'handle', data: BytesLike): Result;
  decodeFunctionResult(functionFragment: 'initialize', data: BytesLike): Result;
  decodeFunctionResult(
    functionFragment: 'interchainGasPaymaster',
    data: BytesLike,
  ): Result;
  decodeFunctionResult(
    functionFragment: 'interchainSecurityModule',
    data: BytesLike,
  ): Result;
  decodeFunctionResult(
    functionFragment: 'isApprovedForAll',
    data: BytesLike,
  ): Result;
  decodeFunctionResult(functionFragment: 'mailbox', data: BytesLike): Result;
  decodeFunctionResult(functionFragment: 'name', data: BytesLike): Result;
  decodeFunctionResult(functionFragment: 'owner', data: BytesLike): Result;
  decodeFunctionResult(functionFragment: 'ownerOf', data: BytesLike): Result;
  decodeFunctionResult(
    functionFragment: 'quoteGasPayment',
    data: BytesLike,
  ): Result;
  decodeFunctionResult(
    functionFragment: 'renounceOwnership',
    data: BytesLike,
  ): Result;
  decodeFunctionResult(functionFragment: 'routers', data: BytesLike): Result;
  decodeFunctionResult(
    functionFragment: 'safeTransferFrom(address,address,uint256)',
    data: BytesLike,
  ): Result;
  decodeFunctionResult(
    functionFragment: 'safeTransferFrom(address,address,uint256,bytes)',
    data: BytesLike,
  ): Result;
  decodeFunctionResult(
    functionFragment: 'setApprovalForAll',
    data: BytesLike,
  ): Result;
  decodeFunctionResult(
    functionFragment: 'setDestinationGas',
    data: BytesLike,
  ): Result;
  decodeFunctionResult(
    functionFragment: 'setInterchainGasPaymaster',
    data: BytesLike,
  ): Result;
  decodeFunctionResult(
    functionFragment: 'setInterchainSecurityModule',
    data: BytesLike,
  ): Result;
  decodeFunctionResult(functionFragment: 'setMailbox', data: BytesLike): Result;
  decodeFunctionResult(
    functionFragment: 'supportsInterface',
    data: BytesLike,
  ): Result;
  decodeFunctionResult(functionFragment: 'symbol', data: BytesLike): Result;
  decodeFunctionResult(
    functionFragment: 'tokenByIndex',
    data: BytesLike,
  ): Result;
  decodeFunctionResult(
    functionFragment: 'tokenOfOwnerByIndex',
    data: BytesLike,
  ): Result;
  decodeFunctionResult(functionFragment: 'tokenURI', data: BytesLike): Result;
  decodeFunctionResult(
    functionFragment: 'totalSupply',
    data: BytesLike,
  ): Result;
  decodeFunctionResult(
    functionFragment: 'transferFrom',
    data: BytesLike,
  ): Result;
  decodeFunctionResult(
    functionFragment: 'transferOwnership',
    data: BytesLike,
  ): Result;
  decodeFunctionResult(
    functionFragment: 'transferRemote',
    data: BytesLike,
  ): Result;
  events: {
    'Approval(address,address,uint256)': EventFragment;
    'ApprovalForAll(address,address,bool)': EventFragment;
    'DestinationGasSet(uint32,uint256)': EventFragment;
    'Initialized(uint8)': EventFragment;
    'InterchainGasPaymasterSet(address)': EventFragment;
    'InterchainSecurityModuleSet(address)': EventFragment;
    'MailboxSet(address)': EventFragment;
    'OwnershipTransferred(address,address)': EventFragment;
    'ReceivedTransferRemote(uint32,bytes32,uint256)': EventFragment;
    'RemoteRouterEnrolled(uint32,bytes32)': EventFragment;
    'SentTransferRemote(uint32,bytes32,uint256)': EventFragment;
    'Transfer(address,address,uint256)': EventFragment;
  };
  getEvent(nameOrSignatureOrTopic: 'Approval'): EventFragment;
  getEvent(nameOrSignatureOrTopic: 'ApprovalForAll'): EventFragment;
  getEvent(nameOrSignatureOrTopic: 'DestinationGasSet'): EventFragment;
  getEvent(nameOrSignatureOrTopic: 'Initialized'): EventFragment;
  getEvent(nameOrSignatureOrTopic: 'InterchainGasPaymasterSet'): EventFragment;
  getEvent(
    nameOrSignatureOrTopic: 'InterchainSecurityModuleSet',
  ): EventFragment;
  getEvent(nameOrSignatureOrTopic: 'MailboxSet'): EventFragment;
  getEvent(nameOrSignatureOrTopic: 'OwnershipTransferred'): EventFragment;
  getEvent(nameOrSignatureOrTopic: 'ReceivedTransferRemote'): EventFragment;
  getEvent(nameOrSignatureOrTopic: 'RemoteRouterEnrolled'): EventFragment;
  getEvent(nameOrSignatureOrTopic: 'SentTransferRemote'): EventFragment;
  getEvent(nameOrSignatureOrTopic: 'Transfer'): EventFragment;
}
export interface ApprovalEventObject {
  owner: string;
  approved: string;
  tokenId: BigNumber;
}
export declare type ApprovalEvent = TypedEvent<
  [string, string, BigNumber],
  ApprovalEventObject
>;
export declare type ApprovalEventFilter = TypedEventFilter<ApprovalEvent>;
export interface ApprovalForAllEventObject {
  owner: string;
  operator: string;
  approved: boolean;
}
export declare type ApprovalForAllEvent = TypedEvent<
  [string, string, boolean],
  ApprovalForAllEventObject
>;
export declare type ApprovalForAllEventFilter =
  TypedEventFilter<ApprovalForAllEvent>;
export interface DestinationGasSetEventObject {
  domain: number;
  gas: BigNumber;
}
export declare type DestinationGasSetEvent = TypedEvent<
  [number, BigNumber],
  DestinationGasSetEventObject
>;
export declare type DestinationGasSetEventFilter =
  TypedEventFilter<DestinationGasSetEvent>;
export interface InitializedEventObject {
  version: number;
}
export declare type InitializedEvent = TypedEvent<
  [number],
  InitializedEventObject
>;
export declare type InitializedEventFilter = TypedEventFilter<InitializedEvent>;
export interface InterchainGasPaymasterSetEventObject {
  interchainGasPaymaster: string;
}
export declare type InterchainGasPaymasterSetEvent = TypedEvent<
  [string],
  InterchainGasPaymasterSetEventObject
>;
export declare type InterchainGasPaymasterSetEventFilter =
  TypedEventFilter<InterchainGasPaymasterSetEvent>;
export interface InterchainSecurityModuleSetEventObject {
  module: string;
}
export declare type InterchainSecurityModuleSetEvent = TypedEvent<
  [string],
  InterchainSecurityModuleSetEventObject
>;
export declare type InterchainSecurityModuleSetEventFilter =
  TypedEventFilter<InterchainSecurityModuleSetEvent>;
export interface MailboxSetEventObject {
  mailbox: string;
}
export declare type MailboxSetEvent = TypedEvent<
  [string],
  MailboxSetEventObject
>;
export declare type MailboxSetEventFilter = TypedEventFilter<MailboxSetEvent>;
export interface OwnershipTransferredEventObject {
  previousOwner: string;
  newOwner: string;
}
export declare type OwnershipTransferredEvent = TypedEvent<
  [string, string],
  OwnershipTransferredEventObject
>;
export declare type OwnershipTransferredEventFilter =
  TypedEventFilter<OwnershipTransferredEvent>;
export interface ReceivedTransferRemoteEventObject {
  origin: number;
  recipient: string;
  amount: BigNumber;
}
export declare type ReceivedTransferRemoteEvent = TypedEvent<
  [number, string, BigNumber],
  ReceivedTransferRemoteEventObject
>;
export declare type ReceivedTransferRemoteEventFilter =
  TypedEventFilter<ReceivedTransferRemoteEvent>;
export interface RemoteRouterEnrolledEventObject {
  domain: number;
  router: string;
}
export declare type RemoteRouterEnrolledEvent = TypedEvent<
  [number, string],
  RemoteRouterEnrolledEventObject
>;
export declare type RemoteRouterEnrolledEventFilter =
  TypedEventFilter<RemoteRouterEnrolledEvent>;
export interface SentTransferRemoteEventObject {
  destination: number;
  recipient: string;
  amount: BigNumber;
}
export declare type SentTransferRemoteEvent = TypedEvent<
  [number, string, BigNumber],
  SentTransferRemoteEventObject
>;
export declare type SentTransferRemoteEventFilter =
  TypedEventFilter<SentTransferRemoteEvent>;
export interface TransferEventObject {
  from: string;
  to: string;
  tokenId: BigNumber;
}
export declare type TransferEvent = TypedEvent<
  [string, string, BigNumber],
  TransferEventObject
>;
export declare type TransferEventFilter = TypedEventFilter<TransferEvent>;
export interface HypERC721 extends BaseContract {
  connect(signerOrProvider: Signer | Provider | string): this;
  attach(addressOrName: string): this;
  deployed(): Promise<this>;
  interface: HypERC721Interface;
  queryFilter<TEvent extends TypedEvent>(
    event: TypedEventFilter<TEvent>,
    fromBlockOrBlockhash?: string | number | undefined,
    toBlock?: string | number | undefined,
  ): Promise<Array<TEvent>>;
  listeners<TEvent extends TypedEvent>(
    eventFilter?: TypedEventFilter<TEvent>,
  ): Array<TypedListener<TEvent>>;
  listeners(eventName?: string): Array<Listener>;
  removeAllListeners<TEvent extends TypedEvent>(
    eventFilter: TypedEventFilter<TEvent>,
  ): this;
  removeAllListeners(eventName?: string): this;
  off: OnEvent<this>;
  on: OnEvent<this>;
  once: OnEvent<this>;
  removeListener: OnEvent<this>;
  functions: {
    approve(
      to: string,
      tokenId: BigNumberish,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<ContractTransaction>;
    balanceOf(owner: string, overrides?: CallOverrides): Promise<[BigNumber]>;
    destinationGas(
      arg0: BigNumberish,
      overrides?: CallOverrides,
    ): Promise<[BigNumber]>;
    domains(overrides?: CallOverrides): Promise<[number[]]>;
    enrollRemoteRouter(
      _domain: BigNumberish,
      _router: BytesLike,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<ContractTransaction>;
    enrollRemoteRouters(
      _domains: BigNumberish[],
      _addresses: BytesLike[],
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<ContractTransaction>;
    getApproved(
      tokenId: BigNumberish,
      overrides?: CallOverrides,
    ): Promise<[string]>;
    handle(
      _origin: BigNumberish,
      _sender: BytesLike,
      _message: BytesLike,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<ContractTransaction>;
    initialize(
      _mailbox: string,
      _interchainGasPaymaster: string,
      _mintAmount: BigNumberish,
      _name: string,
      _symbol: string,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<ContractTransaction>;
    interchainGasPaymaster(overrides?: CallOverrides): Promise<[string]>;
    interchainSecurityModule(overrides?: CallOverrides): Promise<[string]>;
    isApprovedForAll(
      owner: string,
      operator: string,
      overrides?: CallOverrides,
    ): Promise<[boolean]>;
    mailbox(overrides?: CallOverrides): Promise<[string]>;
    name(overrides?: CallOverrides): Promise<[string]>;
    owner(overrides?: CallOverrides): Promise<[string]>;
    ownerOf(
      tokenId: BigNumberish,
      overrides?: CallOverrides,
    ): Promise<[string]>;
    quoteGasPayment(
      _destinationDomain: BigNumberish,
      overrides?: CallOverrides,
    ): Promise<
      [BigNumber] & {
        _gasPayment: BigNumber;
      }
    >;
    renounceOwnership(
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<ContractTransaction>;
    routers(
      _domain: BigNumberish,
      overrides?: CallOverrides,
    ): Promise<[string]>;
    'safeTransferFrom(address,address,uint256)'(
      from: string,
      to: string,
      tokenId: BigNumberish,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<ContractTransaction>;
    'safeTransferFrom(address,address,uint256,bytes)'(
      from: string,
      to: string,
      tokenId: BigNumberish,
      data: BytesLike,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<ContractTransaction>;
    setApprovalForAll(
      operator: string,
      approved: boolean,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<ContractTransaction>;
    setDestinationGas(
      gasConfigs: GasRouter.GasRouterConfigStruct[],
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<ContractTransaction>;
    setInterchainGasPaymaster(
      _interchainGasPaymaster: string,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<ContractTransaction>;
    setInterchainSecurityModule(
      _module: string,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<ContractTransaction>;
    setMailbox(
      _mailbox: string,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<ContractTransaction>;
    supportsInterface(
      interfaceId: BytesLike,
      overrides?: CallOverrides,
    ): Promise<[boolean]>;
    symbol(overrides?: CallOverrides): Promise<[string]>;
    tokenByIndex(
      index: BigNumberish,
      overrides?: CallOverrides,
    ): Promise<[BigNumber]>;
    tokenOfOwnerByIndex(
      owner: string,
      index: BigNumberish,
      overrides?: CallOverrides,
    ): Promise<[BigNumber]>;
    tokenURI(
      tokenId: BigNumberish,
      overrides?: CallOverrides,
    ): Promise<[string]>;
    totalSupply(overrides?: CallOverrides): Promise<[BigNumber]>;
    transferFrom(
      from: string,
      to: string,
      tokenId: BigNumberish,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<ContractTransaction>;
    transferOwnership(
      newOwner: string,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<ContractTransaction>;
    transferRemote(
      _destination: BigNumberish,
      _recipient: BytesLike,
      _amountOrId: BigNumberish,
      overrides?: PayableOverrides & {
        from?: string | Promise<string>;
      },
    ): Promise<ContractTransaction>;
  };
  approve(
    to: string,
    tokenId: BigNumberish,
    overrides?: Overrides & {
      from?: string | Promise<string>;
    },
  ): Promise<ContractTransaction>;
  balanceOf(owner: string, overrides?: CallOverrides): Promise<BigNumber>;
  destinationGas(
    arg0: BigNumberish,
    overrides?: CallOverrides,
  ): Promise<BigNumber>;
  domains(overrides?: CallOverrides): Promise<number[]>;
  enrollRemoteRouter(
    _domain: BigNumberish,
    _router: BytesLike,
    overrides?: Overrides & {
      from?: string | Promise<string>;
    },
  ): Promise<ContractTransaction>;
  enrollRemoteRouters(
    _domains: BigNumberish[],
    _addresses: BytesLike[],
    overrides?: Overrides & {
      from?: string | Promise<string>;
    },
  ): Promise<ContractTransaction>;
  getApproved(
    tokenId: BigNumberish,
    overrides?: CallOverrides,
  ): Promise<string>;
  handle(
    _origin: BigNumberish,
    _sender: BytesLike,
    _message: BytesLike,
    overrides?: Overrides & {
      from?: string | Promise<string>;
    },
  ): Promise<ContractTransaction>;
  initialize(
    _mailbox: string,
    _interchainGasPaymaster: string,
    _mintAmount: BigNumberish,
    _name: string,
    _symbol: string,
    overrides?: Overrides & {
      from?: string | Promise<string>;
    },
  ): Promise<ContractTransaction>;
  interchainGasPaymaster(overrides?: CallOverrides): Promise<string>;
  interchainSecurityModule(overrides?: CallOverrides): Promise<string>;
  isApprovedForAll(
    owner: string,
    operator: string,
    overrides?: CallOverrides,
  ): Promise<boolean>;
  mailbox(overrides?: CallOverrides): Promise<string>;
  name(overrides?: CallOverrides): Promise<string>;
  owner(overrides?: CallOverrides): Promise<string>;
  ownerOf(tokenId: BigNumberish, overrides?: CallOverrides): Promise<string>;
  quoteGasPayment(
    _destinationDomain: BigNumberish,
    overrides?: CallOverrides,
  ): Promise<BigNumber>;
  renounceOwnership(
    overrides?: Overrides & {
      from?: string | Promise<string>;
    },
  ): Promise<ContractTransaction>;
  routers(_domain: BigNumberish, overrides?: CallOverrides): Promise<string>;
  'safeTransferFrom(address,address,uint256)'(
    from: string,
    to: string,
    tokenId: BigNumberish,
    overrides?: Overrides & {
      from?: string | Promise<string>;
    },
  ): Promise<ContractTransaction>;
  'safeTransferFrom(address,address,uint256,bytes)'(
    from: string,
    to: string,
    tokenId: BigNumberish,
    data: BytesLike,
    overrides?: Overrides & {
      from?: string | Promise<string>;
    },
  ): Promise<ContractTransaction>;
  setApprovalForAll(
    operator: string,
    approved: boolean,
    overrides?: Overrides & {
      from?: string | Promise<string>;
    },
  ): Promise<ContractTransaction>;
  setDestinationGas(
    gasConfigs: GasRouter.GasRouterConfigStruct[],
    overrides?: Overrides & {
      from?: string | Promise<string>;
    },
  ): Promise<ContractTransaction>;
  setInterchainGasPaymaster(
    _interchainGasPaymaster: string,
    overrides?: Overrides & {
      from?: string | Promise<string>;
    },
  ): Promise<ContractTransaction>;
  setInterchainSecurityModule(
    _module: string,
    overrides?: Overrides & {
      from?: string | Promise<string>;
    },
  ): Promise<ContractTransaction>;
  setMailbox(
    _mailbox: string,
    overrides?: Overrides & {
      from?: string | Promise<string>;
    },
  ): Promise<ContractTransaction>;
  supportsInterface(
    interfaceId: BytesLike,
    overrides?: CallOverrides,
  ): Promise<boolean>;
  symbol(overrides?: CallOverrides): Promise<string>;
  tokenByIndex(
    index: BigNumberish,
    overrides?: CallOverrides,
  ): Promise<BigNumber>;
  tokenOfOwnerByIndex(
    owner: string,
    index: BigNumberish,
    overrides?: CallOverrides,
  ): Promise<BigNumber>;
  tokenURI(tokenId: BigNumberish, overrides?: CallOverrides): Promise<string>;
  totalSupply(overrides?: CallOverrides): Promise<BigNumber>;
  transferFrom(
    from: string,
    to: string,
    tokenId: BigNumberish,
    overrides?: Overrides & {
      from?: string | Promise<string>;
    },
  ): Promise<ContractTransaction>;
  transferOwnership(
    newOwner: string,
    overrides?: Overrides & {
      from?: string | Promise<string>;
    },
  ): Promise<ContractTransaction>;
  transferRemote(
    _destination: BigNumberish,
    _recipient: BytesLike,
    _amountOrId: BigNumberish,
    overrides?: PayableOverrides & {
      from?: string | Promise<string>;
    },
  ): Promise<ContractTransaction>;
  callStatic: {
    approve(
      to: string,
      tokenId: BigNumberish,
      overrides?: CallOverrides,
    ): Promise<void>;
    balanceOf(owner: string, overrides?: CallOverrides): Promise<BigNumber>;
    destinationGas(
      arg0: BigNumberish,
      overrides?: CallOverrides,
    ): Promise<BigNumber>;
    domains(overrides?: CallOverrides): Promise<number[]>;
    enrollRemoteRouter(
      _domain: BigNumberish,
      _router: BytesLike,
      overrides?: CallOverrides,
    ): Promise<void>;
    enrollRemoteRouters(
      _domains: BigNumberish[],
      _addresses: BytesLike[],
      overrides?: CallOverrides,
    ): Promise<void>;
    getApproved(
      tokenId: BigNumberish,
      overrides?: CallOverrides,
    ): Promise<string>;
    handle(
      _origin: BigNumberish,
      _sender: BytesLike,
      _message: BytesLike,
      overrides?: CallOverrides,
    ): Promise<void>;
    initialize(
      _mailbox: string,
      _interchainGasPaymaster: string,
      _mintAmount: BigNumberish,
      _name: string,
      _symbol: string,
      overrides?: CallOverrides,
    ): Promise<void>;
    interchainGasPaymaster(overrides?: CallOverrides): Promise<string>;
    interchainSecurityModule(overrides?: CallOverrides): Promise<string>;
    isApprovedForAll(
      owner: string,
      operator: string,
      overrides?: CallOverrides,
    ): Promise<boolean>;
    mailbox(overrides?: CallOverrides): Promise<string>;
    name(overrides?: CallOverrides): Promise<string>;
    owner(overrides?: CallOverrides): Promise<string>;
    ownerOf(tokenId: BigNumberish, overrides?: CallOverrides): Promise<string>;
    quoteGasPayment(
      _destinationDomain: BigNumberish,
      overrides?: CallOverrides,
    ): Promise<BigNumber>;
    renounceOwnership(overrides?: CallOverrides): Promise<void>;
    routers(_domain: BigNumberish, overrides?: CallOverrides): Promise<string>;
    'safeTransferFrom(address,address,uint256)'(
      from: string,
      to: string,
      tokenId: BigNumberish,
      overrides?: CallOverrides,
    ): Promise<void>;
    'safeTransferFrom(address,address,uint256,bytes)'(
      from: string,
      to: string,
      tokenId: BigNumberish,
      data: BytesLike,
      overrides?: CallOverrides,
    ): Promise<void>;
    setApprovalForAll(
      operator: string,
      approved: boolean,
      overrides?: CallOverrides,
    ): Promise<void>;
    setDestinationGas(
      gasConfigs: GasRouter.GasRouterConfigStruct[],
      overrides?: CallOverrides,
    ): Promise<void>;
    setInterchainGasPaymaster(
      _interchainGasPaymaster: string,
      overrides?: CallOverrides,
    ): Promise<void>;
    setInterchainSecurityModule(
      _module: string,
      overrides?: CallOverrides,
    ): Promise<void>;
    setMailbox(_mailbox: string, overrides?: CallOverrides): Promise<void>;
    supportsInterface(
      interfaceId: BytesLike,
      overrides?: CallOverrides,
    ): Promise<boolean>;
    symbol(overrides?: CallOverrides): Promise<string>;
    tokenByIndex(
      index: BigNumberish,
      overrides?: CallOverrides,
    ): Promise<BigNumber>;
    tokenOfOwnerByIndex(
      owner: string,
      index: BigNumberish,
      overrides?: CallOverrides,
    ): Promise<BigNumber>;
    tokenURI(tokenId: BigNumberish, overrides?: CallOverrides): Promise<string>;
    totalSupply(overrides?: CallOverrides): Promise<BigNumber>;
    transferFrom(
      from: string,
      to: string,
      tokenId: BigNumberish,
      overrides?: CallOverrides,
    ): Promise<void>;
    transferOwnership(
      newOwner: string,
      overrides?: CallOverrides,
    ): Promise<void>;
    transferRemote(
      _destination: BigNumberish,
      _recipient: BytesLike,
      _amountOrId: BigNumberish,
      overrides?: CallOverrides,
    ): Promise<string>;
  };
  filters: {
    'Approval(address,address,uint256)'(
      owner?: string | null,
      approved?: string | null,
      tokenId?: BigNumberish | null,
    ): ApprovalEventFilter;
    Approval(
      owner?: string | null,
      approved?: string | null,
      tokenId?: BigNumberish | null,
    ): ApprovalEventFilter;
    'ApprovalForAll(address,address,bool)'(
      owner?: string | null,
      operator?: string | null,
      approved?: null,
    ): ApprovalForAllEventFilter;
    ApprovalForAll(
      owner?: string | null,
      operator?: string | null,
      approved?: null,
    ): ApprovalForAllEventFilter;
    'DestinationGasSet(uint32,uint256)'(
      domain?: BigNumberish | null,
      gas?: null,
    ): DestinationGasSetEventFilter;
    DestinationGasSet(
      domain?: BigNumberish | null,
      gas?: null,
    ): DestinationGasSetEventFilter;
    'Initialized(uint8)'(version?: null): InitializedEventFilter;
    Initialized(version?: null): InitializedEventFilter;
    'InterchainGasPaymasterSet(address)'(
      interchainGasPaymaster?: string | null,
    ): InterchainGasPaymasterSetEventFilter;
    InterchainGasPaymasterSet(
      interchainGasPaymaster?: string | null,
    ): InterchainGasPaymasterSetEventFilter;
    'InterchainSecurityModuleSet(address)'(
      module?: string | null,
    ): InterchainSecurityModuleSetEventFilter;
    InterchainSecurityModuleSet(
      module?: string | null,
    ): InterchainSecurityModuleSetEventFilter;
    'MailboxSet(address)'(mailbox?: string | null): MailboxSetEventFilter;
    MailboxSet(mailbox?: string | null): MailboxSetEventFilter;
    'OwnershipTransferred(address,address)'(
      previousOwner?: string | null,
      newOwner?: string | null,
    ): OwnershipTransferredEventFilter;
    OwnershipTransferred(
      previousOwner?: string | null,
      newOwner?: string | null,
    ): OwnershipTransferredEventFilter;
    'ReceivedTransferRemote(uint32,bytes32,uint256)'(
      origin?: BigNumberish | null,
      recipient?: BytesLike | null,
      amount?: null,
    ): ReceivedTransferRemoteEventFilter;
    ReceivedTransferRemote(
      origin?: BigNumberish | null,
      recipient?: BytesLike | null,
      amount?: null,
    ): ReceivedTransferRemoteEventFilter;
    'RemoteRouterEnrolled(uint32,bytes32)'(
      domain?: BigNumberish | null,
      router?: null,
    ): RemoteRouterEnrolledEventFilter;
    RemoteRouterEnrolled(
      domain?: BigNumberish | null,
      router?: null,
    ): RemoteRouterEnrolledEventFilter;
    'SentTransferRemote(uint32,bytes32,uint256)'(
      destination?: BigNumberish | null,
      recipient?: BytesLike | null,
      amount?: null,
    ): SentTransferRemoteEventFilter;
    SentTransferRemote(
      destination?: BigNumberish | null,
      recipient?: BytesLike | null,
      amount?: null,
    ): SentTransferRemoteEventFilter;
    'Transfer(address,address,uint256)'(
      from?: string | null,
      to?: string | null,
      tokenId?: BigNumberish | null,
    ): TransferEventFilter;
    Transfer(
      from?: string | null,
      to?: string | null,
      tokenId?: BigNumberish | null,
    ): TransferEventFilter;
  };
  estimateGas: {
    approve(
      to: string,
      tokenId: BigNumberish,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<BigNumber>;
    balanceOf(owner: string, overrides?: CallOverrides): Promise<BigNumber>;
    destinationGas(
      arg0: BigNumberish,
      overrides?: CallOverrides,
    ): Promise<BigNumber>;
    domains(overrides?: CallOverrides): Promise<BigNumber>;
    enrollRemoteRouter(
      _domain: BigNumberish,
      _router: BytesLike,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<BigNumber>;
    enrollRemoteRouters(
      _domains: BigNumberish[],
      _addresses: BytesLike[],
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<BigNumber>;
    getApproved(
      tokenId: BigNumberish,
      overrides?: CallOverrides,
    ): Promise<BigNumber>;
    handle(
      _origin: BigNumberish,
      _sender: BytesLike,
      _message: BytesLike,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<BigNumber>;
    initialize(
      _mailbox: string,
      _interchainGasPaymaster: string,
      _mintAmount: BigNumberish,
      _name: string,
      _symbol: string,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<BigNumber>;
    interchainGasPaymaster(overrides?: CallOverrides): Promise<BigNumber>;
    interchainSecurityModule(overrides?: CallOverrides): Promise<BigNumber>;
    isApprovedForAll(
      owner: string,
      operator: string,
      overrides?: CallOverrides,
    ): Promise<BigNumber>;
    mailbox(overrides?: CallOverrides): Promise<BigNumber>;
    name(overrides?: CallOverrides): Promise<BigNumber>;
    owner(overrides?: CallOverrides): Promise<BigNumber>;
    ownerOf(
      tokenId: BigNumberish,
      overrides?: CallOverrides,
    ): Promise<BigNumber>;
    quoteGasPayment(
      _destinationDomain: BigNumberish,
      overrides?: CallOverrides,
    ): Promise<BigNumber>;
    renounceOwnership(
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<BigNumber>;
    routers(
      _domain: BigNumberish,
      overrides?: CallOverrides,
    ): Promise<BigNumber>;
    'safeTransferFrom(address,address,uint256)'(
      from: string,
      to: string,
      tokenId: BigNumberish,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<BigNumber>;
    'safeTransferFrom(address,address,uint256,bytes)'(
      from: string,
      to: string,
      tokenId: BigNumberish,
      data: BytesLike,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<BigNumber>;
    setApprovalForAll(
      operator: string,
      approved: boolean,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<BigNumber>;
    setDestinationGas(
      gasConfigs: GasRouter.GasRouterConfigStruct[],
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<BigNumber>;
    setInterchainGasPaymaster(
      _interchainGasPaymaster: string,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<BigNumber>;
    setInterchainSecurityModule(
      _module: string,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<BigNumber>;
    setMailbox(
      _mailbox: string,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<BigNumber>;
    supportsInterface(
      interfaceId: BytesLike,
      overrides?: CallOverrides,
    ): Promise<BigNumber>;
    symbol(overrides?: CallOverrides): Promise<BigNumber>;
    tokenByIndex(
      index: BigNumberish,
      overrides?: CallOverrides,
    ): Promise<BigNumber>;
    tokenOfOwnerByIndex(
      owner: string,
      index: BigNumberish,
      overrides?: CallOverrides,
    ): Promise<BigNumber>;
    tokenURI(
      tokenId: BigNumberish,
      overrides?: CallOverrides,
    ): Promise<BigNumber>;
    totalSupply(overrides?: CallOverrides): Promise<BigNumber>;
    transferFrom(
      from: string,
      to: string,
      tokenId: BigNumberish,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<BigNumber>;
    transferOwnership(
      newOwner: string,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<BigNumber>;
    transferRemote(
      _destination: BigNumberish,
      _recipient: BytesLike,
      _amountOrId: BigNumberish,
      overrides?: PayableOverrides & {
        from?: string | Promise<string>;
      },
    ): Promise<BigNumber>;
  };
  populateTransaction: {
    approve(
      to: string,
      tokenId: BigNumberish,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<PopulatedTransaction>;
    balanceOf(
      owner: string,
      overrides?: CallOverrides,
    ): Promise<PopulatedTransaction>;
    destinationGas(
      arg0: BigNumberish,
      overrides?: CallOverrides,
    ): Promise<PopulatedTransaction>;
    domains(overrides?: CallOverrides): Promise<PopulatedTransaction>;
    enrollRemoteRouter(
      _domain: BigNumberish,
      _router: BytesLike,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<PopulatedTransaction>;
    enrollRemoteRouters(
      _domains: BigNumberish[],
      _addresses: BytesLike[],
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<PopulatedTransaction>;
    getApproved(
      tokenId: BigNumberish,
      overrides?: CallOverrides,
    ): Promise<PopulatedTransaction>;
    handle(
      _origin: BigNumberish,
      _sender: BytesLike,
      _message: BytesLike,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<PopulatedTransaction>;
    initialize(
      _mailbox: string,
      _interchainGasPaymaster: string,
      _mintAmount: BigNumberish,
      _name: string,
      _symbol: string,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<PopulatedTransaction>;
    interchainGasPaymaster(
      overrides?: CallOverrides,
    ): Promise<PopulatedTransaction>;
    interchainSecurityModule(
      overrides?: CallOverrides,
    ): Promise<PopulatedTransaction>;
    isApprovedForAll(
      owner: string,
      operator: string,
      overrides?: CallOverrides,
    ): Promise<PopulatedTransaction>;
    mailbox(overrides?: CallOverrides): Promise<PopulatedTransaction>;
    name(overrides?: CallOverrides): Promise<PopulatedTransaction>;
    owner(overrides?: CallOverrides): Promise<PopulatedTransaction>;
    ownerOf(
      tokenId: BigNumberish,
      overrides?: CallOverrides,
    ): Promise<PopulatedTransaction>;
    quoteGasPayment(
      _destinationDomain: BigNumberish,
      overrides?: CallOverrides,
    ): Promise<PopulatedTransaction>;
    renounceOwnership(
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<PopulatedTransaction>;
    routers(
      _domain: BigNumberish,
      overrides?: CallOverrides,
    ): Promise<PopulatedTransaction>;
    'safeTransferFrom(address,address,uint256)'(
      from: string,
      to: string,
      tokenId: BigNumberish,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<PopulatedTransaction>;
    'safeTransferFrom(address,address,uint256,bytes)'(
      from: string,
      to: string,
      tokenId: BigNumberish,
      data: BytesLike,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<PopulatedTransaction>;
    setApprovalForAll(
      operator: string,
      approved: boolean,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<PopulatedTransaction>;
    setDestinationGas(
      gasConfigs: GasRouter.GasRouterConfigStruct[],
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<PopulatedTransaction>;
    setInterchainGasPaymaster(
      _interchainGasPaymaster: string,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<PopulatedTransaction>;
    setInterchainSecurityModule(
      _module: string,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<PopulatedTransaction>;
    setMailbox(
      _mailbox: string,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<PopulatedTransaction>;
    supportsInterface(
      interfaceId: BytesLike,
      overrides?: CallOverrides,
    ): Promise<PopulatedTransaction>;
    symbol(overrides?: CallOverrides): Promise<PopulatedTransaction>;
    tokenByIndex(
      index: BigNumberish,
      overrides?: CallOverrides,
    ): Promise<PopulatedTransaction>;
    tokenOfOwnerByIndex(
      owner: string,
      index: BigNumberish,
      overrides?: CallOverrides,
    ): Promise<PopulatedTransaction>;
    tokenURI(
      tokenId: BigNumberish,
      overrides?: CallOverrides,
    ): Promise<PopulatedTransaction>;
    totalSupply(overrides?: CallOverrides): Promise<PopulatedTransaction>;
    transferFrom(
      from: string,
      to: string,
      tokenId: BigNumberish,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<PopulatedTransaction>;
    transferOwnership(
      newOwner: string,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<PopulatedTransaction>;
    transferRemote(
      _destination: BigNumberish,
      _recipient: BytesLike,
      _amountOrId: BigNumberish,
      overrides?: PayableOverrides & {
        from?: string | Promise<string>;
      },
    ): Promise<PopulatedTransaction>;
  };
}
//# sourceMappingURL=HypERC721.d.ts.map
