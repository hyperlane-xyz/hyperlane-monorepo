import { CairoOption, CairoOptionVariant, RpcProvider, shortString, } from 'starknet';
import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { ContractType } from '@hyperlane-xyz/starknet-core';
import { ZERO_ADDRESS_HEX_32, addressToBytes32, assert, ensure0x, isZeroishAddress, } from '@hyperlane-xyz/utils';
import { StarknetContractName, addressToEvmAddress, callContract, extractEnumVariant, getFeeTokenAddress, getStarknetContract, normalizeRoutersAddress, normalizeStarknetAddressSafe, populateInvokeTx, toBigInt, toNumber, } from '../contracts.js';
export class StarknetProvider {
    provider;
    metadata;
    rpcUrls;
    static connect(rpcUrls, _chainId, extraParams) {
        assert(extraParams?.metadata, 'metadata missing for Starknet provider');
        const metadata = extraParams.metadata;
        assert(rpcUrls.length > 0, 'at least one rpc url is required');
        const provider = new RpcProvider({ nodeUrl: rpcUrls[0] });
        return new StarknetProvider(provider, metadata, rpcUrls);
    }
    constructor(provider, metadata, rpcUrls) {
        this.provider = provider;
        this.metadata = metadata;
        this.rpcUrls = rpcUrls;
    }
    withContract(name, address, providerOrAccount, contractType) {
        return getStarknetContract(name, address, providerOrAccount ?? this.provider, contractType);
    }
    get accountAddress() {
        throw new Error('StarknetProvider has no signer account');
    }
    get feeTokenAddress() {
        return getFeeTokenAddress({
            chainName: this.metadata.name,
            nativeDenom: this.metadata.nativeToken?.denom,
        });
    }
    parseString(value) {
        if (typeof value === 'string')
            return value;
        if (typeof value === 'number' || typeof value === 'bigint') {
            try {
                return shortString.decodeShortString(ensure0x(BigInt(value).toString(16)));
            }
            catch {
                return value.toString();
            }
        }
        if (value && typeof value === 'object') {
            if ('toString' in value && typeof value.toString === 'function') {
                const parsed = value.toString();
                if (parsed)
                    return parsed;
            }
            if ('value' in value)
                return this.parseString(value.value);
        }
        return '';
    }
    async populateInvokeCall(contract, method, args = []) {
        const populated = contract.populateTransaction?.[method];
        if (typeof populated === 'function') {
            const tx = await populated(...args);
            return {
                contractAddress: normalizeStarknetAddressSafe(tx.contractAddress),
                entrypoint: tx.entrypoint,
                calldata: tx.calldata ?? [],
            };
        }
        return {
            contractAddress: normalizeStarknetAddressSafe(contract.address),
            entrypoint: method,
            calldata: args,
        };
    }
    async determineTokenType(tokenAddress) {
        const address = normalizeStarknetAddressSafe(tokenAddress);
        try {
            const collateral = this.withContract(StarknetContractName.HYP_ERC20_COLLATERAL, address, this.provider, ContractType.TOKEN);
            await callContract(collateral, 'get_wrapped_token');
            return AltVM.TokenType.collateral;
        }
        catch {
            // noop
        }
        try {
            const native = this.withContract(StarknetContractName.HYP_NATIVE, address, this.provider, ContractType.TOKEN);
            await callContract(native, 'native_token');
            return AltVM.TokenType.native;
        }
        catch {
            // noop
        }
        return AltVM.TokenType.synthetic;
    }
    async getTokenMetadata(tokenAddress) {
        const token = this.withContract(StarknetContractName.HYP_ERC20, tokenAddress, this.provider, ContractType.TOKEN);
        const [name, symbol, decimals] = await Promise.all([
            callContract(token, 'name'),
            callContract(token, 'symbol'),
            callContract(token, 'decimals'),
        ]);
        return {
            name: this.parseString(name),
            symbol: this.parseString(symbol),
            decimals: toNumber(decimals),
        };
    }
    parseHookVariant(variant) {
        const upper = variant.toUpperCase();
        if (upper.includes('MERKLE_TREE'))
            return AltVM.HookType.MERKLE_TREE;
        if (upper.includes('PROTOCOL_FEE'))
            return AltVM.HookType.PROTOCOL_FEE;
        if (upper.includes('INTERCHAIN_GAS_PAYMASTER')) {
            return AltVM.HookType.INTERCHAIN_GAS_PAYMASTER;
        }
        return AltVM.HookType.CUSTOM;
    }
    parseIsmVariant(variant) {
        const upper = variant.toUpperCase();
        if (upper.includes('MERKLE_ROOT_MULTISIG')) {
            return AltVM.IsmType.MERKLE_ROOT_MULTISIG;
        }
        if (upper.includes('MESSAGE_ID_MULTISIG')) {
            return AltVM.IsmType.MESSAGE_ID_MULTISIG;
        }
        if (upper.includes('ROUTING')) {
            return AltVM.IsmType.ROUTING;
        }
        return AltVM.IsmType.TEST_ISM;
    }
    // ### QUERY BASE ###
    async isHealthy() {
        try {
            await this.provider.getBlockNumber();
            return true;
        }
        catch {
            return false;
        }
    }
    getRpcUrls() {
        return this.rpcUrls;
    }
    async getHeight() {
        return this.provider.getBlockNumber();
    }
    async getBalance(req) {
        const tokenAddress = req.denom
            ? normalizeStarknetAddressSafe(req.denom)
            : this.feeTokenAddress;
        const token = this.withContract(StarknetContractName.ETHER, tokenAddress, this.provider, ContractType.TOKEN);
        let balance;
        try {
            balance = await callContract(token, 'balanceOf', [
                normalizeStarknetAddressSafe(req.address),
            ]);
        }
        catch {
            balance = await callContract(token, 'balance_of', [
                normalizeStarknetAddressSafe(req.address),
            ]);
        }
        return toBigInt(balance?.balance ?? balance);
    }
    async getTotalSupply(req) {
        const tokenAddress = req.denom
            ? normalizeStarknetAddressSafe(req.denom)
            : this.feeTokenAddress;
        const token = this.withContract(StarknetContractName.ETHER, tokenAddress, this.provider, ContractType.TOKEN);
        return toBigInt(await callContract(token, 'total_supply'));
    }
    async estimateTransactionFee(_req) {
        return { gasUnits: 0n, gasPrice: 0, fee: 0n };
    }
    // ### QUERY CORE ###
    async getMailbox(req) {
        const mailbox = this.withContract(StarknetContractName.MAILBOX, req.mailboxAddress);
        const [owner, localDomain, defaultIsm, defaultHook, requiredHook, nonce] = await Promise.all([
            callContract(mailbox, 'owner'),
            callContract(mailbox, 'get_local_domain'),
            callContract(mailbox, 'get_default_ism'),
            callContract(mailbox, 'get_default_hook'),
            callContract(mailbox, 'get_required_hook'),
            callContract(mailbox, 'nonce'),
        ]);
        return {
            address: normalizeStarknetAddressSafe(req.mailboxAddress),
            owner: normalizeStarknetAddressSafe(owner),
            localDomain: toNumber(localDomain),
            defaultIsm: normalizeStarknetAddressSafe(defaultIsm),
            defaultHook: normalizeStarknetAddressSafe(defaultHook),
            requiredHook: normalizeStarknetAddressSafe(requiredHook),
            nonce: toNumber(nonce),
        };
    }
    async isMessageDelivered(req) {
        const mailbox = this.withContract(StarknetContractName.MAILBOX, req.mailboxAddress);
        const delivered = await callContract(mailbox, 'delivered', [req.messageId]);
        return Boolean(delivered);
    }
    async getIsmType(req) {
        const ism = this.withContract(StarknetContractName.MERKLE_ROOT_MULTISIG_ISM, req.ismAddress);
        const moduleType = await callContract(ism, 'module_type');
        return this.parseIsmVariant(extractEnumVariant(moduleType));
    }
    async getMessageIdMultisigIsm(req) {
        const ism = this.withContract(StarknetContractName.MESSAGE_ID_MULTISIG_ISM, req.ismAddress);
        const [validators, threshold] = await Promise.all([
            callContract(ism, 'get_validators'),
            callContract(ism, 'get_threshold'),
        ]);
        return {
            address: normalizeStarknetAddressSafe(req.ismAddress),
            threshold: toNumber(threshold),
            validators: validators.map((v) => addressToEvmAddress(v)),
        };
    }
    async getMerkleRootMultisigIsm(req) {
        const ism = this.withContract(StarknetContractName.MERKLE_ROOT_MULTISIG_ISM, req.ismAddress);
        const [validators, threshold] = await Promise.all([
            callContract(ism, 'get_validators'),
            callContract(ism, 'get_threshold'),
        ]);
        return {
            address: normalizeStarknetAddressSafe(req.ismAddress),
            threshold: toNumber(threshold),
            validators: validators.map((v) => addressToEvmAddress(v)),
        };
    }
    async getRoutingIsm(req) {
        const ism = this.withContract(StarknetContractName.ROUTING_ISM, req.ismAddress);
        const [owner, domains] = await Promise.all([
            callContract(ism, 'owner'),
            callContract(ism, 'domains'),
        ]);
        const routes = await Promise.all(domains.map(async (domainId) => {
            const routeAddress = await callContract(ism, 'module', [domainId]);
            return {
                domainId: toNumber(domainId),
                ismAddress: normalizeStarknetAddressSafe(routeAddress),
            };
        }));
        return {
            address: normalizeStarknetAddressSafe(req.ismAddress),
            owner: normalizeStarknetAddressSafe(owner),
            routes,
        };
    }
    async getNoopIsm(req) {
        return { address: normalizeStarknetAddressSafe(req.ismAddress) };
    }
    async getHookType(req) {
        try {
            const hook = this.withContract(StarknetContractName.PROTOCOL_FEE, req.hookAddress);
            const hookType = await callContract(hook, 'hook_type');
            return this.parseHookVariant(extractEnumVariant(hookType));
        }
        catch {
            // noop
        }
        try {
            const hook = this.withContract(StarknetContractName.MERKLE_TREE_HOOK, req.hookAddress);
            const hookType = await callContract(hook, 'hook_type');
            return this.parseHookVariant(extractEnumVariant(hookType));
        }
        catch {
            // noop
        }
        return AltVM.HookType.CUSTOM;
    }
    async getInterchainGasPaymasterHook(req) {
        const hook = this.withContract(StarknetContractName.PROTOCOL_FEE, req.hookAddress);
        const owner = await callContract(hook, 'owner');
        return {
            address: normalizeStarknetAddressSafe(req.hookAddress),
            owner: normalizeStarknetAddressSafe(owner),
            destinationGasConfigs: {
            // Starknet protocol fee hook does not expose per-domain gas settings.
            },
        };
    }
    async getMerkleTreeHook(req) {
        return { address: normalizeStarknetAddressSafe(req.hookAddress) };
    }
    async getNoopHook(req) {
        return { address: normalizeStarknetAddressSafe(req.hookAddress) };
    }
    // ### QUERY WARP ###
    async getToken(req) {
        const tokenAddress = normalizeStarknetAddressSafe(req.tokenAddress);
        const token = this.withContract(StarknetContractName.HYP_ERC20, tokenAddress, this.provider, ContractType.TOKEN);
        const tokenType = await this.determineTokenType(tokenAddress);
        const [owner, mailboxAddress, ismAddress, hookAddress] = await Promise.all([
            callContract(token, 'owner'),
            callContract(token, 'mailbox'),
            callContract(token, 'interchain_security_module'),
            callContract(token, 'get_hook'),
        ]);
        let denom = tokenAddress;
        let name = '';
        let symbol = '';
        let decimals = this.metadata.nativeToken?.decimals ?? 18;
        try {
            const metadata = await this.getTokenMetadata(tokenAddress);
            name = metadata.name;
            symbol = metadata.symbol;
            decimals = metadata.decimals;
        }
        catch {
            // noop
        }
        if (tokenType === AltVM.TokenType.collateral) {
            const collateral = this.withContract(StarknetContractName.HYP_ERC20_COLLATERAL, tokenAddress, this.provider, ContractType.TOKEN);
            const wrapped = await callContract(collateral, 'get_wrapped_token');
            denom = normalizeStarknetAddressSafe(wrapped);
            try {
                const wrappedMeta = await this.getTokenMetadata(denom);
                name = wrappedMeta.name;
                symbol = wrappedMeta.symbol;
                decimals = wrappedMeta.decimals;
            }
            catch {
                // noop
            }
        }
        else if (tokenType === AltVM.TokenType.native) {
            const native = this.withContract(StarknetContractName.HYP_NATIVE, tokenAddress, this.provider, ContractType.TOKEN);
            try {
                const nativeTokenAddress = await callContract(native, 'native_token');
                denom = normalizeStarknetAddressSafe(nativeTokenAddress);
            }
            catch {
                denom = this.metadata.nativeToken?.denom || this.feeTokenAddress;
            }
            name = this.metadata.nativeToken?.name || name;
            symbol = this.metadata.nativeToken?.symbol || symbol;
            decimals = this.metadata.nativeToken?.decimals ?? decimals;
        }
        return {
            address: tokenAddress,
            owner: normalizeStarknetAddressSafe(owner),
            tokenType,
            mailboxAddress: normalizeStarknetAddressSafe(mailboxAddress),
            ismAddress: normalizeStarknetAddressSafe(ismAddress),
            hookAddress: normalizeStarknetAddressSafe(hookAddress),
            denom,
            name,
            symbol,
            decimals,
        };
    }
    async getRemoteRouters(req) {
        const token = this.withContract(StarknetContractName.HYP_ERC20, req.tokenAddress, this.provider, ContractType.TOKEN);
        const domains = (await callContract(token, 'domains'));
        const remoteRouters = await Promise.all(domains.map(async (domainId) => {
            const domain = toNumber(domainId);
            const [routerAddress, gas] = await Promise.all([
                callContract(token, 'routers', [domainId]),
                callContract(token, 'destination_gas', [domainId]).catch(() => 0),
            ]);
            return {
                receiverDomainId: domain,
                receiverAddress: normalizeRoutersAddress(routerAddress),
                gas: toBigInt(gas).toString(),
            };
        }));
        return {
            address: normalizeStarknetAddressSafe(req.tokenAddress),
            remoteRouters,
        };
    }
    async getBridgedSupply(req) {
        const tokenInfo = await this.getToken({ tokenAddress: req.tokenAddress });
        const token = this.withContract(StarknetContractName.HYP_ERC20, req.tokenAddress, this.provider, ContractType.TOKEN);
        if (tokenInfo.tokenType === AltVM.TokenType.synthetic) {
            return toBigInt(await callContract(token, 'total_supply'));
        }
        const balance = await callContract(token, 'balance_of', [
            normalizeStarknetAddressSafe(req.tokenAddress),
        ]);
        return toBigInt(balance?.balance ?? balance);
    }
    async quoteRemoteTransfer(req) {
        const token = this.withContract(StarknetContractName.HYP_ERC20, req.tokenAddress, this.provider, ContractType.TOKEN);
        try {
            const quote = await callContract(token, 'quote_gas_payment', [
                req.destinationDomainId,
            ]);
            return {
                denom: this.feeTokenAddress,
                amount: toBigInt(quote),
            };
        }
        catch {
            return {
                denom: this.feeTokenAddress,
                amount: 0n,
            };
        }
    }
    // ### GET CORE TXS ###
    async getCreateMailboxTransaction(req) {
        return {
            kind: 'deploy',
            contractName: StarknetContractName.MAILBOX,
            constructorArgs: [
                req.domainId,
                normalizeStarknetAddressSafe(req.signer),
                normalizeStarknetAddressSafe(req.defaultIsmAddress ?? ZERO_ADDRESS_HEX_32),
                ZERO_ADDRESS_HEX_32,
                ZERO_ADDRESS_HEX_32,
            ],
        };
    }
    async getSetDefaultIsmTransaction(req) {
        const mailbox = this.withContract(StarknetContractName.MAILBOX, req.mailboxAddress);
        return populateInvokeTx(mailbox, 'set_default_ism', [
            normalizeStarknetAddressSafe(req.ismAddress),
        ]);
    }
    async getSetDefaultHookTransaction(req) {
        const mailbox = this.withContract(StarknetContractName.MAILBOX, req.mailboxAddress);
        return populateInvokeTx(mailbox, 'set_default_hook', [
            normalizeStarknetAddressSafe(req.hookAddress),
        ]);
    }
    async getSetRequiredHookTransaction(req) {
        const mailbox = this.withContract(StarknetContractName.MAILBOX, req.mailboxAddress);
        return populateInvokeTx(mailbox, 'set_required_hook', [
            normalizeStarknetAddressSafe(req.hookAddress),
        ]);
    }
    async getSetMailboxOwnerTransaction(req) {
        const mailbox = this.withContract(StarknetContractName.MAILBOX, req.mailboxAddress);
        return populateInvokeTx(mailbox, 'transfer_ownership', [
            normalizeStarknetAddressSafe(req.newOwner),
        ]);
    }
    async getCreateMerkleRootMultisigIsmTransaction(req) {
        return {
            kind: 'deploy',
            contractName: StarknetContractName.MERKLE_ROOT_MULTISIG_ISM,
            constructorArgs: [
                normalizeStarknetAddressSafe(req.signer),
                req.validators.map((validator) => addressToBytes32(validator)),
                req.threshold,
            ],
        };
    }
    async getCreateMessageIdMultisigIsmTransaction(req) {
        return {
            kind: 'deploy',
            contractName: StarknetContractName.MESSAGE_ID_MULTISIG_ISM,
            constructorArgs: [
                normalizeStarknetAddressSafe(req.signer),
                req.validators.map((validator) => addressToBytes32(validator)),
                req.threshold,
            ],
        };
    }
    async getCreateRoutingIsmTransaction(req) {
        return {
            kind: 'deploy',
            contractName: StarknetContractName.ROUTING_ISM,
            constructorArgs: [normalizeStarknetAddressSafe(req.signer)],
        };
    }
    async getSetRoutingIsmRouteTransaction(req) {
        const routing = this.withContract(StarknetContractName.ROUTING_ISM, req.ismAddress);
        return populateInvokeTx(routing, 'set', [
            req.route.domainId,
            normalizeStarknetAddressSafe(req.route.ismAddress),
        ]);
    }
    async getRemoveRoutingIsmRouteTransaction(req) {
        const routing = this.withContract(StarknetContractName.ROUTING_ISM, req.ismAddress);
        return populateInvokeTx(routing, 'remove', [req.domainId]);
    }
    async getSetRoutingIsmOwnerTransaction(req) {
        const routing = this.withContract(StarknetContractName.ROUTING_ISM, req.ismAddress);
        return populateInvokeTx(routing, 'transfer_ownership', [
            normalizeStarknetAddressSafe(req.newOwner),
        ]);
    }
    async getCreateNoopIsmTransaction(_req) {
        return {
            kind: 'deploy',
            contractName: StarknetContractName.NOOP_ISM,
            constructorArgs: [],
        };
    }
    async getCreateMerkleTreeHookTransaction(req) {
        return {
            kind: 'deploy',
            contractName: StarknetContractName.MERKLE_TREE_HOOK,
            constructorArgs: [
                normalizeStarknetAddressSafe(req.mailboxAddress),
                normalizeStarknetAddressSafe(req.signer),
            ],
        };
    }
    async getCreateInterchainGasPaymasterHookTransaction(req) {
        return {
            kind: 'deploy',
            contractName: StarknetContractName.PROTOCOL_FEE,
            constructorArgs: [
                0,
                0,
                normalizeStarknetAddressSafe(req.signer),
                normalizeStarknetAddressSafe(req.signer),
                normalizeStarknetAddressSafe(req.denom ?? this.feeTokenAddress),
            ],
        };
    }
    async getSetInterchainGasPaymasterHookOwnerTransaction(req) {
        const hook = this.withContract(StarknetContractName.PROTOCOL_FEE, req.hookAddress);
        return populateInvokeTx(hook, 'transfer_ownership', [
            normalizeStarknetAddressSafe(req.newOwner),
        ]);
    }
    async getSetDestinationGasConfigTransaction(_req) {
        throw new Error('Interchain gas paymaster destination gas config unsupported on Starknet protocol_fee hook');
    }
    async getRemoveDestinationGasConfigTransaction(_req) {
        throw new Error('Interchain gas paymaster destination gas config unsupported on Starknet protocol_fee hook');
    }
    async getCreateNoopHookTransaction(_req) {
        return {
            kind: 'deploy',
            contractName: StarknetContractName.HOOK,
            constructorArgs: [],
        };
    }
    async getCreateValidatorAnnounceTransaction(req) {
        return {
            kind: 'deploy',
            contractName: StarknetContractName.VALIDATOR_ANNOUNCE,
            constructorArgs: [
                normalizeStarknetAddressSafe(req.mailboxAddress),
                normalizeStarknetAddressSafe(req.signer),
            ],
        };
    }
    async getCreateProxyAdminTransaction(_req) {
        throw new Error('Proxy admin unsupported on Starknet');
    }
    async getSetProxyAdminOwnerTransaction(_req) {
        throw new Error('Proxy admin unsupported on Starknet');
    }
    // ### GET WARP TXS ###
    async getCreateNativeTokenTransaction(req) {
        return {
            kind: 'deploy',
            contractName: StarknetContractName.HYP_NATIVE,
            contractType: ContractType.TOKEN,
            constructorArgs: [
                normalizeStarknetAddressSafe(req.mailboxAddress),
                this.feeTokenAddress,
                ZERO_ADDRESS_HEX_32,
                ZERO_ADDRESS_HEX_32,
                normalizeStarknetAddressSafe(req.signer),
            ],
        };
    }
    async getCreateCollateralTokenTransaction(req) {
        return {
            kind: 'deploy',
            contractName: StarknetContractName.HYP_ERC20_COLLATERAL,
            contractType: ContractType.TOKEN,
            constructorArgs: [
                normalizeStarknetAddressSafe(req.mailboxAddress),
                normalizeStarknetAddressSafe(req.collateralDenom),
                normalizeStarknetAddressSafe(req.signer),
                ZERO_ADDRESS_HEX_32,
                ZERO_ADDRESS_HEX_32,
            ],
        };
    }
    async getCreateSyntheticTokenTransaction(req) {
        return {
            kind: 'deploy',
            contractName: StarknetContractName.HYP_ERC20,
            contractType: ContractType.TOKEN,
            constructorArgs: [
                req.decimals,
                normalizeStarknetAddressSafe(req.mailboxAddress),
                0,
                req.name,
                req.denom,
                ZERO_ADDRESS_HEX_32,
                ZERO_ADDRESS_HEX_32,
                normalizeStarknetAddressSafe(req.signer),
            ],
        };
    }
    async getSetTokenOwnerTransaction(req) {
        const token = this.withContract(StarknetContractName.HYP_ERC20, req.tokenAddress, this.provider, ContractType.TOKEN);
        return populateInvokeTx(token, 'transfer_ownership', [
            normalizeStarknetAddressSafe(req.newOwner),
        ]);
    }
    async getSetTokenIsmTransaction(req) {
        const token = this.withContract(StarknetContractName.HYP_ERC20, req.tokenAddress, this.provider, ContractType.TOKEN);
        return populateInvokeTx(token, 'set_interchain_security_module', [
            normalizeStarknetAddressSafe(req.ismAddress ?? ZERO_ADDRESS_HEX_32),
        ]);
    }
    async getSetTokenHookTransaction(req) {
        const token = this.withContract(StarknetContractName.HYP_ERC20, req.tokenAddress, this.provider, ContractType.TOKEN);
        return populateInvokeTx(token, 'set_hook', [
            normalizeStarknetAddressSafe(req.hookAddress ?? ZERO_ADDRESS_HEX_32),
        ]);
    }
    async getEnrollRemoteRouterTransaction(req) {
        const token = this.withContract(StarknetContractName.HYP_ERC20, req.tokenAddress, this.provider, ContractType.TOKEN);
        const receiverAddress = isZeroishAddress(req.remoteRouter.receiverAddress)
            ? ZERO_ADDRESS_HEX_32
            : ensure0x(req.remoteRouter.receiverAddress);
        const noneOption = new CairoOption(CairoOptionVariant.None);
        const domainOption = new CairoOption(CairoOptionVariant.Some, req.remoteRouter.receiverDomainId);
        const gasOption = new CairoOption(CairoOptionVariant.Some, req.remoteRouter.gas);
        const [enrollCall, gasCall] = await Promise.all([
            this.populateInvokeCall(token, 'enroll_remote_router', [
                req.remoteRouter.receiverDomainId,
                receiverAddress,
            ]),
            this.populateInvokeCall(token, 'set_destination_gas', [
                noneOption,
                domainOption,
                gasOption,
            ]),
        ]);
        return {
            kind: 'invoke',
            contractAddress: enrollCall.contractAddress,
            entrypoint: enrollCall.entrypoint,
            calldata: enrollCall.calldata,
            calls: [enrollCall, gasCall],
        };
    }
    async getUnenrollRemoteRouterTransaction(req) {
        const token = this.withContract(StarknetContractName.HYP_ERC20, req.tokenAddress, this.provider, ContractType.TOKEN);
        return populateInvokeTx(token, 'unenroll_remote_router', [
            req.receiverDomainId,
        ]);
    }
    async getTransferTransaction(req) {
        const denom = req.denom
            ? normalizeStarknetAddressSafe(req.denom)
            : this.feeTokenAddress;
        const token = this.withContract(StarknetContractName.ETHER, denom, this.provider, ContractType.TOKEN);
        return populateInvokeTx(token, 'transfer', [
            normalizeStarknetAddressSafe(req.recipient),
            req.amount,
        ]);
    }
    async getRemoteTransferTransaction(req) {
        if (req.customHookAddress || req.customHookMetadata) {
            throw new Error('Custom hook metadata/addresses are unsupported for Starknet transfer_remote in provider-sdk');
        }
        const token = this.withContract(StarknetContractName.HYP_ERC20, req.tokenAddress, this.provider, ContractType.TOKEN);
        const noneOption = new CairoOption(CairoOptionVariant.None);
        return populateInvokeTx(token, 'transfer_remote', [
            req.destinationDomainId,
            addressToBytes32(req.recipient),
            req.amount,
            req.maxFee.amount,
            noneOption,
            noneOption,
        ]);
    }
}
//# sourceMappingURL=provider.js.map