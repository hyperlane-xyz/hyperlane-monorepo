import { RpcProvider, shortString, } from 'starknet';
import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { ContractType } from '@hyperlane-xyz/starknet-core';
import { ZERO_ADDRESS_HEX_32, addressToBytes32, assert, ensure0x, isZeroishAddress, } from '@hyperlane-xyz/utils';
import { StarknetContractName, addressToEvmAddress, callContract, extractEnumVariant, getFeeTokenAddress, getStarknetContract, normalizeRoutersAddress, normalizeStarknetAddress, populateInvokeTx, toBigInt, toNumber, } from '../contracts.js';
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
                const asString = value.toString();
                if (asString) {
                    return asString;
                }
            }
            if ('value' in value) {
                return this.parseString(value.value);
            }
        }
        return '';
    }
    async determineTokenType(tokenAddress) {
        const address = normalizeStarknetAddress(tokenAddress);
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
            ? normalizeStarknetAddress(req.denom)
            : this.feeTokenAddress;
        const token = this.withContract(StarknetContractName.ETHER, tokenAddress, this.provider, ContractType.TOKEN);
        const balance = await callContract(token, 'balanceOf', [
            normalizeStarknetAddress(req.address),
        ]);
        return toBigInt(balance?.balance ?? balance);
    }
    async getTotalSupply(req) {
        const tokenAddress = req.denom
            ? normalizeStarknetAddress(req.denom)
            : this.feeTokenAddress;
        const token = this.withContract(StarknetContractName.ETHER, tokenAddress, this.provider, ContractType.TOKEN);
        const totalSupply = await callContract(token, 'total_supply');
        return toBigInt(totalSupply);
    }
    async estimateTransactionFee(_req) {
        return {
            gasUnits: 0n,
            gasPrice: 0,
            fee: 0n,
        };
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
            address: normalizeStarknetAddress(req.mailboxAddress),
            owner: normalizeStarknetAddress(owner),
            localDomain: toNumber(localDomain),
            defaultIsm: normalizeStarknetAddress(defaultIsm),
            defaultHook: normalizeStarknetAddress(defaultHook),
            requiredHook: normalizeStarknetAddress(requiredHook),
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
            address: normalizeStarknetAddress(req.ismAddress),
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
            address: normalizeStarknetAddress(req.ismAddress),
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
                ismAddress: normalizeStarknetAddress(routeAddress),
            };
        }));
        return {
            address: normalizeStarknetAddress(req.ismAddress),
            owner: normalizeStarknetAddress(owner),
            routes,
        };
    }
    async getNoopIsm(req) {
        return {
            address: normalizeStarknetAddress(req.ismAddress),
        };
    }
    async getHookType(req) {
        try {
            const hook = this.withContract(StarknetContractName.PROTOCOL_FEE, req.hookAddress);
            const hookType = await callContract(hook, 'hook_type');
            return this.parseHookVariant(extractEnumVariant(hookType));
        }
        catch {
            // fallback detection by introspection
        }
        try {
            const hook = this.withContract(StarknetContractName.PROTOCOL_FEE, req.hookAddress);
            await callContract(hook, 'get_protocol_fee');
            return AltVM.HookType.PROTOCOL_FEE;
        }
        catch {
            return AltVM.HookType.MERKLE_TREE;
        }
    }
    async getInterchainGasPaymasterHook(_req) {
        throw new Error('Interchain gas paymaster hook unsupported on Starknet');
    }
    async getMerkleTreeHook(req) {
        return {
            address: normalizeStarknetAddress(req.hookAddress),
        };
    }
    async getNoopHook(req) {
        return { address: normalizeStarknetAddress(req.hookAddress) };
    }
    // ### QUERY WARP ###
    async getToken(req) {
        const tokenAddress = normalizeStarknetAddress(req.tokenAddress);
        const token = this.withContract(StarknetContractName.HYP_ERC20, tokenAddress, this.provider, ContractType.TOKEN);
        const tokenType = await this.determineTokenType(tokenAddress);
        const [owner, mailboxAddress, ismAddress, hookAddress] = await Promise.all([
            callContract(token, 'owner'),
            callContract(token, 'mailbox'),
            callContract(token, 'interchain_security_module'),
            callContract(token, 'get_hook'),
        ]);
        let denom = tokenAddress;
        let metadata = await this.getTokenMetadata(tokenAddress);
        if (tokenType === AltVM.TokenType.collateral) {
            const collateral = this.withContract(StarknetContractName.HYP_ERC20_COLLATERAL, tokenAddress, this.provider, ContractType.TOKEN);
            const wrapped = await callContract(collateral, 'get_wrapped_token');
            denom = normalizeStarknetAddress(wrapped);
            metadata = await this.getTokenMetadata(denom);
        }
        else if (tokenType === AltVM.TokenType.native) {
            const native = this.withContract(StarknetContractName.HYP_NATIVE, tokenAddress, this.provider, ContractType.TOKEN);
            const nativeTokenAddress = await callContract(native, 'native_token');
            denom = normalizeStarknetAddress(nativeTokenAddress);
            metadata = {
                name: this.metadata.nativeToken?.name ?? metadata.name,
                symbol: this.metadata.nativeToken?.symbol ?? metadata.symbol,
                decimals: this.metadata.nativeToken?.decimals ?? metadata.decimals,
            };
        }
        return {
            address: tokenAddress,
            owner: normalizeStarknetAddress(owner),
            tokenType,
            mailboxAddress: normalizeStarknetAddress(mailboxAddress),
            ismAddress: normalizeStarknetAddress(ismAddress),
            hookAddress: normalizeStarknetAddress(hookAddress),
            denom,
            name: metadata.name,
            symbol: metadata.symbol,
            decimals: metadata.decimals,
        };
    }
    async getRemoteRouters(req) {
        const token = this.withContract(StarknetContractName.HYP_ERC20, req.tokenAddress, this.provider, ContractType.TOKEN);
        const domains = (await callContract(token, 'domains'));
        const remoteRouters = await Promise.all(domains.map(async (domainId) => {
            const [router, gas] = await Promise.all([
                callContract(token, 'routers', [domainId]),
                callContract(token, 'destination_gas', [domainId]).catch(() => 0),
            ]);
            return {
                receiverDomainId: toNumber(domainId),
                receiverAddress: normalizeRoutersAddress(router),
                gas: toBigInt(gas).toString(),
            };
        }));
        return {
            address: normalizeStarknetAddress(req.tokenAddress),
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
            normalizeStarknetAddress(req.tokenAddress),
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
                normalizeStarknetAddress(req.signer),
                normalizeStarknetAddress(req.defaultIsmAddress ?? ZERO_ADDRESS_HEX_32),
                ZERO_ADDRESS_HEX_32,
                ZERO_ADDRESS_HEX_32,
            ],
        };
    }
    async getSetDefaultIsmTransaction(req) {
        const mailbox = this.withContract(StarknetContractName.MAILBOX, req.mailboxAddress);
        return populateInvokeTx(mailbox, 'set_default_ism', [
            normalizeStarknetAddress(req.ismAddress),
        ]);
    }
    async getSetDefaultHookTransaction(req) {
        const mailbox = this.withContract(StarknetContractName.MAILBOX, req.mailboxAddress);
        return populateInvokeTx(mailbox, 'set_default_hook', [
            normalizeStarknetAddress(req.hookAddress),
        ]);
    }
    async getSetRequiredHookTransaction(req) {
        const mailbox = this.withContract(StarknetContractName.MAILBOX, req.mailboxAddress);
        return populateInvokeTx(mailbox, 'set_required_hook', [
            normalizeStarknetAddress(req.hookAddress),
        ]);
    }
    async getSetMailboxOwnerTransaction(req) {
        const mailbox = this.withContract(StarknetContractName.MAILBOX, req.mailboxAddress);
        return populateInvokeTx(mailbox, 'transfer_ownership', [
            normalizeStarknetAddress(req.newOwner),
        ]);
    }
    async getCreateMerkleRootMultisigIsmTransaction(req) {
        return {
            kind: 'deploy',
            contractName: StarknetContractName.MERKLE_ROOT_MULTISIG_ISM,
            constructorArgs: [
                normalizeStarknetAddress(req.signer),
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
                normalizeStarknetAddress(req.signer),
                req.validators.map((validator) => addressToBytes32(validator)),
                req.threshold,
            ],
        };
    }
    async getCreateRoutingIsmTransaction(req) {
        return {
            kind: 'deploy',
            contractName: StarknetContractName.ROUTING_ISM,
            constructorArgs: [normalizeStarknetAddress(req.signer)],
        };
    }
    async getSetRoutingIsmRouteTransaction(req) {
        const routing = this.withContract(StarknetContractName.ROUTING_ISM, req.ismAddress);
        return populateInvokeTx(routing, 'set', [
            [req.route.domainId],
            [normalizeStarknetAddress(req.route.ismAddress)],
        ]);
    }
    async getRemoveRoutingIsmRouteTransaction(req) {
        const routing = this.withContract(StarknetContractName.ROUTING_ISM, req.ismAddress);
        return populateInvokeTx(routing, 'remove', [[req.domainId]]);
    }
    async getSetRoutingIsmOwnerTransaction(req) {
        const routing = this.withContract(StarknetContractName.ROUTING_ISM, req.ismAddress);
        return populateInvokeTx(routing, 'transfer_ownership', [
            normalizeStarknetAddress(req.newOwner),
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
                normalizeStarknetAddress(req.mailboxAddress),
                normalizeStarknetAddress(req.signer),
            ],
        };
    }
    async getCreateInterchainGasPaymasterHookTransaction(_req) {
        throw new Error('Interchain gas paymaster hook unsupported on Starknet');
    }
    async getSetInterchainGasPaymasterHookOwnerTransaction(_req) {
        throw new Error('Interchain gas paymaster hook unsupported on Starknet');
    }
    async getSetDestinationGasConfigTransaction(_req) {
        throw new Error('IGP destination gas config unsupported on Starknet');
    }
    async getRemoveDestinationGasConfigTransaction(_req) {
        throw new Error('IGP destination gas config unsupported on Starknet');
    }
    async getCreateNoopHookTransaction(_req) {
        return {
            kind: 'deploy',
            contractName: 'hook',
            constructorArgs: [],
        };
    }
    async getCreateValidatorAnnounceTransaction(req) {
        return {
            kind: 'deploy',
            contractName: StarknetContractName.VALIDATOR_ANNOUNCE,
            constructorArgs: [
                normalizeStarknetAddress(req.mailboxAddress),
                normalizeStarknetAddress(req.signer),
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
                normalizeStarknetAddress(req.mailboxAddress),
                this.feeTokenAddress,
                ZERO_ADDRESS_HEX_32,
                ZERO_ADDRESS_HEX_32,
                normalizeStarknetAddress(req.signer),
            ],
        };
    }
    async getCreateCollateralTokenTransaction(req) {
        return {
            kind: 'deploy',
            contractName: StarknetContractName.HYP_ERC20_COLLATERAL,
            contractType: ContractType.TOKEN,
            constructorArgs: [
                normalizeStarknetAddress(req.mailboxAddress),
                normalizeStarknetAddress(req.collateralDenom),
                normalizeStarknetAddress(req.signer),
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
                normalizeStarknetAddress(req.mailboxAddress),
                0,
                req.name,
                req.denom,
                ZERO_ADDRESS_HEX_32,
                ZERO_ADDRESS_HEX_32,
                normalizeStarknetAddress(req.signer),
            ],
        };
    }
    async getSetTokenOwnerTransaction(req) {
        const token = this.withContract(StarknetContractName.HYP_ERC20, req.tokenAddress, this.provider, ContractType.TOKEN);
        return populateInvokeTx(token, 'transfer_ownership', [
            normalizeStarknetAddress(req.newOwner),
        ]);
    }
    async getSetTokenIsmTransaction(req) {
        const token = this.withContract(StarknetContractName.HYP_ERC20, req.tokenAddress, this.provider, ContractType.TOKEN);
        return populateInvokeTx(token, 'set_interchain_security_module', [
            normalizeStarknetAddress(req.ismAddress ?? ZERO_ADDRESS_HEX_32),
        ]);
    }
    async getSetTokenHookTransaction(req) {
        const token = this.withContract(StarknetContractName.HYP_ERC20, req.tokenAddress, this.provider, ContractType.TOKEN);
        return populateInvokeTx(token, 'set_hook', [
            normalizeStarknetAddress(req.hookAddress ?? ZERO_ADDRESS_HEX_32),
        ]);
    }
    async getEnrollRemoteRouterTransaction(req) {
        const token = this.withContract(StarknetContractName.HYP_ERC20, req.tokenAddress, this.provider, ContractType.TOKEN);
        const receiverAddress = isZeroishAddress(req.remoteRouter.receiverAddress)
            ? ZERO_ADDRESS_HEX_32
            : ensure0x(req.remoteRouter.receiverAddress);
        return populateInvokeTx(token, 'enroll_remote_routers', [
            [req.remoteRouter.receiverDomainId],
            [receiverAddress],
            [req.remoteRouter.gas],
        ]);
    }
    async getUnenrollRemoteRouterTransaction(req) {
        const token = this.withContract(StarknetContractName.HYP_ERC20, req.tokenAddress, this.provider, ContractType.TOKEN);
        return populateInvokeTx(token, 'unenroll_remote_routers', [
            [req.receiverDomainId],
        ]);
    }
    async getTransferTransaction(req) {
        const denom = req.denom ? normalizeStarknetAddress(req.denom) : this.feeTokenAddress;
        const token = this.withContract(StarknetContractName.ETHER, denom, this.provider, ContractType.TOKEN);
        return populateInvokeTx(token, 'transfer', [
            normalizeStarknetAddress(req.recipient),
            req.amount,
        ]);
    }
    async getRemoteTransferTransaction(req) {
        const token = this.withContract(StarknetContractName.HYP_ERC20, req.tokenAddress, this.provider, ContractType.TOKEN);
        return populateInvokeTx(token, 'transfer_remote', [
            req.destinationDomainId,
            addressToBytes32(req.recipient),
            req.amount,
            req.maxFee.amount,
            req.customHookMetadata ?? [],
            req.customHookAddress ? normalizeStarknetAddress(req.customHookAddress) : [],
        ]);
    }
}
//# sourceMappingURL=provider.js.map