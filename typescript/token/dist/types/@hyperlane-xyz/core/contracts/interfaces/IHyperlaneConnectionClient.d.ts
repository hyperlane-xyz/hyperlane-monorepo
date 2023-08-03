import type { FunctionFragment, Result } from '@ethersproject/abi';
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
} from '../../../../common';

export interface IHyperlaneConnectionClientInterface extends utils.Interface {
  functions: {
    'interchainGasPaymaster()': FunctionFragment;
    'interchainSecurityModule()': FunctionFragment;
    'mailbox()': FunctionFragment;
    'setInterchainGasPaymaster(address)': FunctionFragment;
    'setInterchainSecurityModule(address)': FunctionFragment;
    'setMailbox(address)': FunctionFragment;
  };
  getFunction(
    nameOrSignatureOrTopic:
      | 'interchainGasPaymaster'
      | 'interchainSecurityModule'
      | 'mailbox'
      | 'setInterchainGasPaymaster'
      | 'setInterchainSecurityModule'
      | 'setMailbox',
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
  encodeFunctionData(
    functionFragment: 'setInterchainGasPaymaster',
    values: [string],
  ): string;
  encodeFunctionData(
    functionFragment: 'setInterchainSecurityModule',
    values: [string],
  ): string;
  encodeFunctionData(functionFragment: 'setMailbox', values: [string]): string;
  decodeFunctionResult(
    functionFragment: 'interchainGasPaymaster',
    data: BytesLike,
  ): Result;
  decodeFunctionResult(
    functionFragment: 'interchainSecurityModule',
    data: BytesLike,
  ): Result;
  decodeFunctionResult(functionFragment: 'mailbox', data: BytesLike): Result;
  decodeFunctionResult(
    functionFragment: 'setInterchainGasPaymaster',
    data: BytesLike,
  ): Result;
  decodeFunctionResult(
    functionFragment: 'setInterchainSecurityModule',
    data: BytesLike,
  ): Result;
  decodeFunctionResult(functionFragment: 'setMailbox', data: BytesLike): Result;
  events: {};
}
export interface IHyperlaneConnectionClient extends BaseContract {
  connect(signerOrProvider: Signer | Provider | string): this;
  attach(addressOrName: string): this;
  deployed(): Promise<this>;
  interface: IHyperlaneConnectionClientInterface;
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
    setInterchainGasPaymaster(
      arg0: string,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<ContractTransaction>;
    setInterchainSecurityModule(
      arg0: string,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<ContractTransaction>;
    setMailbox(
      arg0: string,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<ContractTransaction>;
  };
  interchainGasPaymaster(overrides?: CallOverrides): Promise<string>;
  interchainSecurityModule(overrides?: CallOverrides): Promise<string>;
  mailbox(overrides?: CallOverrides): Promise<string>;
  setInterchainGasPaymaster(
    arg0: string,
    overrides?: Overrides & {
      from?: string | Promise<string>;
    },
  ): Promise<ContractTransaction>;
  setInterchainSecurityModule(
    arg0: string,
    overrides?: Overrides & {
      from?: string | Promise<string>;
    },
  ): Promise<ContractTransaction>;
  setMailbox(
    arg0: string,
    overrides?: Overrides & {
      from?: string | Promise<string>;
    },
  ): Promise<ContractTransaction>;
  callStatic: {
    interchainGasPaymaster(overrides?: CallOverrides): Promise<string>;
    interchainSecurityModule(overrides?: CallOverrides): Promise<string>;
    mailbox(overrides?: CallOverrides): Promise<string>;
    setInterchainGasPaymaster(
      arg0: string,
      overrides?: CallOverrides,
    ): Promise<void>;
    setInterchainSecurityModule(
      arg0: string,
      overrides?: CallOverrides,
    ): Promise<void>;
    setMailbox(arg0: string, overrides?: CallOverrides): Promise<void>;
  };
  filters: {};
  estimateGas: {
    interchainGasPaymaster(overrides?: CallOverrides): Promise<BigNumber>;
    interchainSecurityModule(overrides?: CallOverrides): Promise<BigNumber>;
    mailbox(overrides?: CallOverrides): Promise<BigNumber>;
    setInterchainGasPaymaster(
      arg0: string,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<BigNumber>;
    setInterchainSecurityModule(
      arg0: string,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<BigNumber>;
    setMailbox(
      arg0: string,
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
    setInterchainGasPaymaster(
      arg0: string,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<PopulatedTransaction>;
    setInterchainSecurityModule(
      arg0: string,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<PopulatedTransaction>;
    setMailbox(
      arg0: string,
      overrides?: Overrides & {
        from?: string | Promise<string>;
      },
    ): Promise<PopulatedTransaction>;
  };
}
//# sourceMappingURL=IHyperlaneConnectionClient.d.ts.map
