import type {
  EventFragment,
  FunctionFragment,
  Result,
} from '@ethersproject/abi';
import type { Listener, Provider } from '@ethersproject/providers';
import type {
  BaseContract,
  BigNumber,
  BytesLike,
  CallOverrides,
  ContractTransaction,
  Overrides,
  PopulatedTransaction,
  Signer,
  utils,
} from 'ethers';

import type {
  OnEvent,
  TypedEvent,
  TypedEventFilter,
  TypedListener,
} from '../../../common';

export interface HyperlaneConnectionClientInterface extends utils.Interface {
  functions: {
    'interchainGasPaymaster()': FunctionFragment;
    'interchainSecurityModule()': FunctionFragment;
    'mailbox()': FunctionFragment;
    'owner()': FunctionFragment;
    'renounceOwnership()': FunctionFragment;
    'setInterchainGasPaymaster(address)': FunctionFragment;
    'setInterchainSecurityModule(address)': FunctionFragment;
    'setMailbox(address)': FunctionFragment;
    'transferOwnership(address)': FunctionFragment;
  };
  getFunction(
    nameOrSignatureOrTopic:
      | 'interchainGasPaymaster'
      | 'interchainSecurityModule'
      | 'mailbox'
      | 'owner'
      | 'renounceOwnership'
      | 'setInterchainGasPaymaster'
      | 'setInterchainSecurityModule'
      | 'setMailbox'
      | 'transferOwnership',
  ): FunctionFragment;
  encodeFunctionData(
    functionFragment: 'interchainGasPaymaster',
    values?: undefined,
  ): string;
  encodeFunctionData(
    functionFragment: 'interchainSecurityModule',
    values?: undefined,
  ): string;
  encodeFunctionData(functionFragment: 'mailbox', values?: undefined): string;
  encodeFunctionData(functionFragment: 'owner', values?: undefined): string;
  encodeFunctionData(
    functionFragment: 'renounceOwnership',
    values?: undefined,
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
    functionFragment: 'transferOwnership',
    values: [string],
  ): string;
  decodeFunctionResult(
    functionFragment: 'interchainGasPaymaster',
    data: BytesLike,
  ): Result;
  decodeFunctionResult(
    functionFragment: 'interchainSecurityModule',
    data: BytesLike,
  ): Result;
  decodeFunctionResult(functionFragment: 'mailbox', data: BytesLike): Result;
  decodeFunctionResult(functionFragment: 'owner', data: BytesLike): Result;
  decodeFunctionResult(
    functionFragment: 'renounceOwnership',
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
    functionFragment: 'transferOwnership',
    data: BytesLike,
  ): Result;
  events: {
    'Initialized(uint8)': EventFragment;
    'InterchainGasPaymasterSet(address)': EventFragment;
    'InterchainSecurityModuleSet(address)': EventFragment;
    'MailboxSet(address)': EventFragment;
    'OwnershipTransferred(address,address)': EventFragment;
  };
  getEvent(nameOrSignatureOrTopic: 'Initialized'): EventFragment;
  getEvent(nameOrSignatureOrTopic: 'InterchainGasPaymasterSet'): EventFragment;
  getEvent(
    nameOrSignatureOrTopic: 'InterchainSecurityModuleSet',
  ): EventFragment;
  getEvent(nameOrSignatureOrTopic: 'MailboxSet'): EventFragment;
  getEvent(nameOrSignatureOrTopic: 'OwnershipTransferred'): EventFragment;
}
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
export interface HyperlaneConnectionClient extends BaseContract {
  connect(signerOrProvider: Signer | Provider | string): this;
  attach(addressOrName: string): this;
  deployed(): Promise<this>;
  interface: HyperlaneConnectionClientInterface;
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
    interchainGasPaymaster(overrides?: CallOverrides): Promise<[string]>;
    interchainSecurityModule(overrides?: CallOverrides): Promise<[string]>;
    mailbox(overrides?: CallOverrides): Promise<[string]>;
    owner(overrides?: CallOverrides): Promise<[string]>;
    renounceOwnership(
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
    transferOwnership(
      newOwner: string,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<ContractTransaction>;
  };
  interchainGasPaymaster(overrides?: CallOverrides): Promise<string>;
  interchainSecurityModule(overrides?: CallOverrides): Promise<string>;
  mailbox(overrides?: CallOverrides): Promise<string>;
  owner(overrides?: CallOverrides): Promise<string>;
  renounceOwnership(
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
  transferOwnership(
    newOwner: string,
    overrides?: Overrides & {
      from?: string | Promise<string>;
    },
  ): Promise<ContractTransaction>;
  callStatic: {
    interchainGasPaymaster(overrides?: CallOverrides): Promise<string>;
    interchainSecurityModule(overrides?: CallOverrides): Promise<string>;
    mailbox(overrides?: CallOverrides): Promise<string>;
    owner(overrides?: CallOverrides): Promise<string>;
    renounceOwnership(overrides?: CallOverrides): Promise<void>;
    setInterchainGasPaymaster(
      _interchainGasPaymaster: string,
      overrides?: CallOverrides,
    ): Promise<void>;
    setInterchainSecurityModule(
      _module: string,
      overrides?: CallOverrides,
    ): Promise<void>;
    setMailbox(_mailbox: string, overrides?: CallOverrides): Promise<void>;
    transferOwnership(
      newOwner: string,
      overrides?: CallOverrides,
    ): Promise<void>;
  };
  filters: {
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
  };
  estimateGas: {
    interchainGasPaymaster(overrides?: CallOverrides): Promise<BigNumber>;
    interchainSecurityModule(overrides?: CallOverrides): Promise<BigNumber>;
    mailbox(overrides?: CallOverrides): Promise<BigNumber>;
    owner(overrides?: CallOverrides): Promise<BigNumber>;
    renounceOwnership(
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
    transferOwnership(
      newOwner: string,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<BigNumber>;
  };
  populateTransaction: {
    interchainGasPaymaster(
      overrides?: CallOverrides,
    ): Promise<PopulatedTransaction>;
    interchainSecurityModule(
      overrides?: CallOverrides,
    ): Promise<PopulatedTransaction>;
    mailbox(overrides?: CallOverrides): Promise<PopulatedTransaction>;
    owner(overrides?: CallOverrides): Promise<PopulatedTransaction>;
    renounceOwnership(
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
    transferOwnership(
      newOwner: string,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<PopulatedTransaction>;
  };
}
//# sourceMappingURL=HyperlaneConnectionClient.d.ts.map
