import { AccountInterface, Contract, ProviderInterface } from 'starknet';
import { ContractType } from '@hyperlane-xyz/starknet-core';
import { StarknetAnnotatedTx } from './types.js';
export declare enum StarknetContractName {
    MAILBOX = "mailbox",
    MESSAGE_ID_MULTISIG_ISM = "messageid_multisig_ism",
    MERKLE_ROOT_MULTISIG_ISM = "merkleroot_multisig_ism",
    ROUTING_ISM = "domain_routing_ism",
    NOOP_ISM = "noop_ism",
    HOOK = "hook",
    MERKLE_TREE_HOOK = "merkle_tree_hook",
    PROTOCOL_FEE = "protocol_fee",
    VALIDATOR_ANNOUNCE = "validator_announce",
    HYP_ERC20 = "HypErc20",
    HYP_ERC20_COLLATERAL = "HypErc20Collateral",
    HYP_NATIVE = "HypNative",
    ETHER = "Ether"
}
export declare const STARKNET_DEFAULT_FEE_TOKEN_ADDRESSES: Record<string, string>;
export declare function getStarknetContract(contractName: string, address: string, providerOrAccount?: ProviderInterface | AccountInterface, contractType?: ContractType): Contract;
export declare function normalizeStarknetAddressSafe(value: unknown): string;
export declare function addressToEvmAddress(value: unknown): string;
export declare function callContract(contract: Contract, method: string, args?: unknown[]): Promise<any>;
export declare function populateInvokeTx(contract: Contract, method: string, args?: unknown[]): Promise<StarknetAnnotatedTx>;
export declare function extractEnumVariant(value: unknown): string;
export declare function toNumber(value: unknown): number;
export declare function toBigInt(value: unknown): bigint;
export declare function getFeeTokenAddress(params: {
    chainName: string;
    nativeDenom?: string;
}): string;
export declare function normalizeRoutersAddress(value: unknown): string;
//# sourceMappingURL=contracts.d.ts.map