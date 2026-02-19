import { Contract, addAddressPadding, num, uint256, } from 'starknet';
import { ContractType, getCompiledContract, } from '@hyperlane-xyz/starknet-core';
import { ZERO_ADDRESS_HEX_32, assert, bytes32ToAddress, ensure0x, isZeroishAddress, } from '@hyperlane-xyz/utils';
export var StarknetContractName;
(function (StarknetContractName) {
    StarknetContractName["MAILBOX"] = "mailbox";
    StarknetContractName["MESSAGE_ID_MULTISIG_ISM"] = "messageid_multisig_ism";
    StarknetContractName["MERKLE_ROOT_MULTISIG_ISM"] = "merkleroot_multisig_ism";
    StarknetContractName["ROUTING_ISM"] = "domain_routing_ism";
    StarknetContractName["NOOP_ISM"] = "noop_ism";
    StarknetContractName["MERKLE_TREE_HOOK"] = "merkle_tree_hook";
    StarknetContractName["PROTOCOL_FEE"] = "protocol_fee";
    StarknetContractName["VALIDATOR_ANNOUNCE"] = "validator_announce";
    StarknetContractName["HYP_ERC20"] = "HypErc20";
    StarknetContractName["HYP_ERC20_COLLATERAL"] = "HypErc20Collateral";
    StarknetContractName["HYP_NATIVE"] = "HypNative";
    StarknetContractName["ETHER"] = "Ether";
})(StarknetContractName || (StarknetContractName = {}));
export const STARKNET_DEFAULT_FEE_TOKEN_ADDRESSES = {
    starknet: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
    starknetsepolia: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
    paradex: '0x7348407ebad690fec0cc8597e87dc16ef7b269a655ff72587dafff83d462be2',
    paradexsepolia: '0x06f373b346561036d98ea10fb3e60d2f459c872b1933b50b21fe6ef4fda3b75e',
};
export function getStarknetContract(contractName, address, providerOrAccount, contractType = ContractType.CONTRACT) {
    const { abi } = getCompiledContract(contractName, contractType);
    return new Contract(abi, normalizeStarknetAddress(address), providerOrAccount);
}
export function normalizeStarknetAddress(value) {
    if (typeof value === 'string') {
        if (isZeroishAddress(value)) {
            return ZERO_ADDRESS_HEX_32;
        }
        return addAddressPadding(ensure0x(value));
    }
    if (typeof value === 'number' || typeof value === 'bigint') {
        return addAddressPadding(ensure0x(BigInt(value).toString(16)));
    }
    if (value && typeof value === 'object') {
        if ('low' in value || 'high' in value) {
            return addAddressPadding(ensure0x(uint256.uint256ToBN(value).toString(16)));
        }
        if ('value' in value) {
            return normalizeStarknetAddress(value.value);
        }
        if ('toString' in value && typeof value.toString === 'function') {
            return normalizeStarknetAddress(value.toString());
        }
    }
    throw new Error(`Unable to normalize Starknet address: ${String(value)}`);
}
export function addressToEvmAddress(value) {
    const bytes32 = normalizeStarknetAddress(value);
    return bytes32ToAddress(bytes32);
}
export async function callContract(contract, method, args = []) {
    const fn = contract[method];
    if (typeof fn === 'function') {
        return fn(...args);
    }
    const call = contract.call;
    if (typeof call === 'function') {
        return call(method, args);
    }
    throw new Error(`Unable to call ${method} on contract ${contract.address}`);
}
export async function populateInvokeTx(contract, method, args = []) {
    const populated = contract.populateTransaction?.[method];
    if (typeof populated === 'function') {
        const tx = await populated(...args);
        return {
            kind: 'invoke',
            ...tx,
        };
    }
    return {
        kind: 'invoke',
        contractAddress: normalizeStarknetAddress(contract.address),
        entrypoint: method,
        calldata: args,
    };
}
export function extractEnumVariant(value) {
    if (!value)
        return '';
    if (typeof value === 'object' &&
        'activeVariant' in value &&
        typeof value.activeVariant === 'function') {
        return value.activeVariant();
    }
    if (typeof value === 'string') {
        return value;
    }
    if (typeof value === 'number') {
        return value.toString();
    }
    if (typeof value === 'object') {
        for (const [key, nested] of Object.entries(value)) {
            if (nested !== undefined && nested !== null && nested !== false) {
                return key;
            }
        }
    }
    return String(value);
}
export function toNumber(value) {
    if (typeof value === 'number')
        return value;
    if (typeof value === 'bigint')
        return Number(value);
    if (typeof value === 'string')
        return Number(value);
    if (value && typeof value === 'object') {
        if ('toString' in value && typeof value.toString === 'function') {
            return Number(value.toString());
        }
    }
    throw new Error(`Unable to coerce value to number: ${String(value)}`);
}
export function toBigInt(value) {
    if (typeof value === 'bigint')
        return value;
    if (typeof value === 'number')
        return BigInt(value);
    if (typeof value === 'string')
        return BigInt(value);
    if (value && typeof value === 'object') {
        if ('low' in value || 'high' in value) {
            return uint256.uint256ToBN(value);
        }
        if ('toString' in value && typeof value.toString === 'function') {
            return BigInt(value.toString());
        }
    }
    throw new Error(`Unable to coerce value to bigint: ${String(value)}`);
}
export function getFeeTokenAddress(params) {
    if (params.nativeDenom && !isZeroishAddress(params.nativeDenom)) {
        return normalizeStarknetAddress(params.nativeDenom);
    }
    const token = STARKNET_DEFAULT_FEE_TOKEN_ADDRESSES[params.chainName];
    assert(token, `Missing Starknet fee token for chain ${params.chainName}`);
    return normalizeStarknetAddress(token);
}
export function normalizeRoutersAddress(value) {
    if (value &&
        typeof value === 'object' &&
        ('low' in value || 'high' in value)) {
        return normalizeStarknetAddress(num.toHex(uint256.uint256ToBN(value)));
    }
    return normalizeStarknetAddress(value);
}
//# sourceMappingURL=contracts.js.map