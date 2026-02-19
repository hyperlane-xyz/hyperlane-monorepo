import { Account, CallData, ContractFactory, } from 'starknet';
import { getCompiledContract, } from '@hyperlane-xyz/starknet-core';
import { ZERO_ADDRESS_HEX_32, assert } from '@hyperlane-xyz/utils';
import { normalizeStarknetAddressSafe } from '../contracts.js';
import { StarknetProvider } from './provider.js';
export class StarknetSigner extends StarknetProvider {
    signerAddress;
    static async connectWithSigner(rpcUrls, privateKey, extraParams) {
        assert(extraParams?.metadata, 'metadata missing for Starknet signer');
        const metadata = extraParams.metadata;
        const accountAddress = extraParams.accountAddress;
        assert(accountAddress, 'accountAddress missing for Starknet signer');
        assert(privateKey, 'private key missing for Starknet signer');
        const provider = StarknetProvider.connect(rpcUrls, metadata.chainId, {
            metadata,
        });
        return new StarknetSigner(provider.provider, metadata, rpcUrls, normalizeStarknetAddressSafe(accountAddress), privateKey);
    }
    account;
    constructor(provider, metadata, rpcUrls, signerAddress, privateKey) {
        super(provider, metadata, rpcUrls);
        this.signerAddress = signerAddress;
        this.account = new Account(provider, signerAddress, privateKey);
    }
    get accountAddress() {
        return this.signerAddress;
    }
    getSignerAddress() {
        return this.signerAddress;
    }
    supportsTransactionBatching() {
        return false;
    }
    async transactionToPrintableJson(transaction) {
        return transaction;
    }
    async deployContract(params) {
        const compiledContract = getCompiledContract(params.contractName, params.contractType);
        const constructorCalldata = CallData.compile(params.constructorArgs);
        const factory = new ContractFactory({
            compiledContract,
            account: this.account,
        });
        const deployment = await factory.deploy(constructorCalldata);
        const transactionHash = deployment.deployTransactionHash ||
            deployment.transaction_hash;
        assert(transactionHash, 'missing Starknet deploy transaction hash');
        const address = normalizeStarknetAddressSafe(deployment.address || deployment.contract_address);
        const receipt = await this.account.waitForTransaction(transactionHash);
        return {
            transactionHash,
            contractAddress: address,
            receipt,
        };
    }
    async sendAndConfirmTransaction(transaction) {
        if (transaction.kind === 'deploy') {
            const deployTx = transaction;
            const deployed = await this.deployContract({
                contractName: deployTx.contractName,
                constructorArgs: deployTx.constructorArgs,
                contractType: deployTx.contractType,
            });
            return {
                transactionHash: deployed.transactionHash,
                contractAddress: deployed.contractAddress,
                receipt: deployed.receipt,
            };
        }
        const invokeTx = transaction;
        const calls = invokeTx.calls ?? [
            {
                contractAddress: invokeTx.contractAddress,
                entrypoint: invokeTx.entrypoint,
                calldata: invokeTx.calldata,
            },
        ];
        const response = await this.account.execute(calls);
        const transactionHash = response.transaction_hash;
        const receipt = await this.account.waitForTransaction(transactionHash);
        return { transactionHash, receipt };
    }
    async sendAndConfirmBatchTransactions(transactions) {
        const hasDeploy = transactions.some((tx) => tx.kind === 'deploy');
        if (hasDeploy) {
            throw new Error('Batch transactions with deploy operations are unsupported on Starknet signer');
        }
        const calls = transactions.flatMap((tx) => {
            const invoke = tx;
            return (invoke.calls || [
                {
                    contractAddress: invoke.contractAddress,
                    entrypoint: invoke.entrypoint,
                    calldata: invoke.calldata,
                },
            ]);
        });
        const response = await this.account.execute(calls);
        const transactionHash = response.transaction_hash;
        const receipt = await this.account.waitForTransaction(transactionHash);
        return { transactionHash, receipt };
    }
    // ### TX CORE ###
    async createMailbox(req) {
        if (req.proxyAdminAddress) {
            throw new Error('Proxy admin unsupported on Starknet');
        }
        const tx = await this.getCreateMailboxTransaction({
            signer: this.signerAddress,
            ...req,
        });
        const receipt = await this.sendAndConfirmTransaction(tx);
        assert(receipt.contractAddress, 'failed to get Starknet mailbox address');
        return { mailboxAddress: receipt.contractAddress };
    }
    async setDefaultIsm(req) {
        const tx = await this.getSetDefaultIsmTransaction({
            signer: this.signerAddress,
            ...req,
        });
        await this.sendAndConfirmTransaction(tx);
        return { ismAddress: req.ismAddress };
    }
    async setDefaultHook(req) {
        const tx = await this.getSetDefaultHookTransaction({
            signer: this.signerAddress,
            ...req,
        });
        await this.sendAndConfirmTransaction(tx);
        return { hookAddress: req.hookAddress };
    }
    async setRequiredHook(req) {
        const tx = await this.getSetRequiredHookTransaction({
            signer: this.signerAddress,
            ...req,
        });
        await this.sendAndConfirmTransaction(tx);
        return { hookAddress: req.hookAddress };
    }
    async setMailboxOwner(req) {
        const tx = await this.getSetMailboxOwnerTransaction({
            signer: this.signerAddress,
            ...req,
        });
        await this.sendAndConfirmTransaction(tx);
        return { newOwner: req.newOwner };
    }
    async createMerkleRootMultisigIsm(req) {
        const tx = await this.getCreateMerkleRootMultisigIsmTransaction({
            signer: this.signerAddress,
            ...req,
        });
        const receipt = await this.sendAndConfirmTransaction(tx);
        assert(receipt.contractAddress, 'failed to get Starknet ISM address');
        return { ismAddress: receipt.contractAddress };
    }
    async createMessageIdMultisigIsm(req) {
        const tx = await this.getCreateMessageIdMultisigIsmTransaction({
            signer: this.signerAddress,
            ...req,
        });
        const receipt = await this.sendAndConfirmTransaction(tx);
        assert(receipt.contractAddress, 'failed to get Starknet ISM address');
        return { ismAddress: receipt.contractAddress };
    }
    async createRoutingIsm(req) {
        const tx = await this.getCreateRoutingIsmTransaction({
            signer: this.signerAddress,
            ...req,
        });
        const receipt = await this.sendAndConfirmTransaction(tx);
        const ismAddress = receipt.contractAddress;
        assert(ismAddress, 'failed to get Starknet routing ISM address');
        for (const route of req.routes) {
            await this.setRoutingIsmRoute({ ismAddress, route });
        }
        return { ismAddress };
    }
    async setRoutingIsmRoute(req) {
        const tx = await this.getSetRoutingIsmRouteTransaction({
            signer: this.signerAddress,
            ...req,
        });
        await this.sendAndConfirmTransaction(tx);
        return { route: req.route };
    }
    async removeRoutingIsmRoute(req) {
        const tx = await this.getRemoveRoutingIsmRouteTransaction({
            signer: this.signerAddress,
            ...req,
        });
        await this.sendAndConfirmTransaction(tx);
        return { domainId: req.domainId };
    }
    async setRoutingIsmOwner(req) {
        const tx = await this.getSetRoutingIsmOwnerTransaction({
            signer: this.signerAddress,
            ...req,
        });
        await this.sendAndConfirmTransaction(tx);
        return { newOwner: req.newOwner };
    }
    async createNoopIsm(req) {
        const tx = await this.getCreateNoopIsmTransaction({
            signer: this.signerAddress,
            ...req,
        });
        const receipt = await this.sendAndConfirmTransaction(tx);
        assert(receipt.contractAddress, 'failed to get Starknet noop ISM address');
        return { ismAddress: receipt.contractAddress };
    }
    async createMerkleTreeHook(req) {
        const tx = await this.getCreateMerkleTreeHookTransaction({
            signer: this.signerAddress,
            ...req,
        });
        const receipt = await this.sendAndConfirmTransaction(tx);
        assert(receipt.contractAddress, 'failed to get Starknet hook address');
        return { hookAddress: receipt.contractAddress };
    }
    async createInterchainGasPaymasterHook(req) {
        const tx = await this.getCreateInterchainGasPaymasterHookTransaction({
            signer: this.signerAddress,
            ...req,
        });
        const receipt = await this.sendAndConfirmTransaction(tx);
        assert(receipt.contractAddress, 'failed to get Starknet protocol_fee hook');
        return { hookAddress: receipt.contractAddress };
    }
    async setInterchainGasPaymasterHookOwner(req) {
        const tx = await this.getSetInterchainGasPaymasterHookOwnerTransaction({
            signer: this.signerAddress,
            ...req,
        });
        await this.sendAndConfirmTransaction(tx);
        return { newOwner: req.newOwner };
    }
    async setDestinationGasConfig(req) {
        const tx = await this.getSetDestinationGasConfigTransaction({
            signer: this.signerAddress,
            ...req,
        });
        await this.sendAndConfirmTransaction(tx);
        return { destinationGasConfig: req.destinationGasConfig };
    }
    async removeDestinationGasConfig(req) {
        const tx = await this.getRemoveDestinationGasConfigTransaction({
            signer: this.signerAddress,
            ...req,
        });
        await this.sendAndConfirmTransaction(tx);
        return { remoteDomainId: req.remoteDomainId };
    }
    async createNoopHook(req) {
        const tx = await this.getCreateNoopHookTransaction({
            signer: this.signerAddress,
            ...req,
        });
        const receipt = await this.sendAndConfirmTransaction(tx);
        assert(receipt.contractAddress, 'failed to get Starknet noop hook');
        return { hookAddress: receipt.contractAddress };
    }
    async createValidatorAnnounce(req) {
        const tx = await this.getCreateValidatorAnnounceTransaction({
            signer: this.signerAddress,
            ...req,
        });
        const receipt = await this.sendAndConfirmTransaction(tx);
        assert(receipt.contractAddress, 'failed to get Starknet validator announce address');
        return { validatorAnnounceId: receipt.contractAddress };
    }
    async createProxyAdmin(_req) {
        throw new Error('Proxy admin unsupported on Starknet');
    }
    async setProxyAdminOwner(_req) {
        throw new Error('Proxy admin unsupported on Starknet');
    }
    // ### TX WARP ###
    async createNativeToken(req) {
        if (req.proxyAdminAddress) {
            throw new Error('Proxy admin unsupported on Starknet');
        }
        const tx = await this.getCreateNativeTokenTransaction({
            signer: this.signerAddress,
            ...req,
        });
        const receipt = await this.sendAndConfirmTransaction(tx);
        assert(receipt.contractAddress, 'failed to get Starknet warp token');
        return { tokenAddress: receipt.contractAddress };
    }
    async createCollateralToken(req) {
        if (req.proxyAdminAddress) {
            throw new Error('Proxy admin unsupported on Starknet');
        }
        const tx = await this.getCreateCollateralTokenTransaction({
            signer: this.signerAddress,
            ...req,
        });
        const receipt = await this.sendAndConfirmTransaction(tx);
        assert(receipt.contractAddress, 'failed to get Starknet warp token');
        return { tokenAddress: receipt.contractAddress };
    }
    async createSyntheticToken(req) {
        if (req.proxyAdminAddress) {
            throw new Error('Proxy admin unsupported on Starknet');
        }
        const tx = await this.getCreateSyntheticTokenTransaction({
            signer: this.signerAddress,
            ...req,
        });
        const receipt = await this.sendAndConfirmTransaction(tx);
        assert(receipt.contractAddress, 'failed to get Starknet warp token');
        return { tokenAddress: receipt.contractAddress };
    }
    async setTokenOwner(req) {
        const tx = await this.getSetTokenOwnerTransaction({
            signer: this.signerAddress,
            ...req,
        });
        await this.sendAndConfirmTransaction(tx);
        return { newOwner: req.newOwner };
    }
    async setTokenIsm(req) {
        const tx = await this.getSetTokenIsmTransaction({
            signer: this.signerAddress,
            ...req,
        });
        await this.sendAndConfirmTransaction(tx);
        return { ismAddress: req.ismAddress ?? ZERO_ADDRESS_HEX_32 };
    }
    async setTokenHook(req) {
        const tx = await this.getSetTokenHookTransaction({
            signer: this.signerAddress,
            ...req,
        });
        await this.sendAndConfirmTransaction(tx);
        return { hookAddress: req.hookAddress ?? ZERO_ADDRESS_HEX_32 };
    }
    async enrollRemoteRouter(req) {
        const tx = await this.getEnrollRemoteRouterTransaction({
            signer: this.signerAddress,
            ...req,
        });
        await this.sendAndConfirmTransaction(tx);
        return { receiverDomainId: req.remoteRouter.receiverDomainId };
    }
    async unenrollRemoteRouter(req) {
        const tx = await this.getUnenrollRemoteRouterTransaction({
            signer: this.signerAddress,
            ...req,
        });
        await this.sendAndConfirmTransaction(tx);
        return { receiverDomainId: req.receiverDomainId };
    }
    async transfer(req) {
        const tx = await this.getTransferTransaction({
            signer: this.signerAddress,
            ...req,
        });
        await this.sendAndConfirmTransaction(tx);
        return { recipient: req.recipient };
    }
    async remoteTransfer(req) {
        const tx = await this.getRemoteTransferTransaction({
            signer: this.signerAddress,
            ...req,
        });
        await this.sendAndConfirmTransaction(tx);
        return { tokenAddress: req.tokenAddress };
    }
}
//# sourceMappingURL=signer.js.map