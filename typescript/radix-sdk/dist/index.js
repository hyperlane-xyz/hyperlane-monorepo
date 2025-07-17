import { GatewayApiClient, } from '@radixdlt/babylon-gateway-api-sdk';
import { LTSRadixEngineToolkit, ManifestBuilder, NetworkId, PrivateKey, RadixEngineToolkit, SimpleTransactionBuilder, TransactionBuilder, ValueKind, address, array, bucket, decimal, enumeration, expression, generateRandomNonce, str, tuple, u8, u32, u64, } from '@radixdlt/radix-engine-toolkit';
import { getRandomValues } from 'crypto';
import { Decimal } from 'decimal.js';
import { assert, ensure0x, strip0x } from '@hyperlane-xyz/utils';
import { bytes } from './utils.js';
const applicationName = 'hyperlane';
const packageAddress = 'package_tdx_2_1p4faa3cx72v0gwguntycgewxnlun34kpkpezf7m7arqyh9crr0v3f3';
export { NetworkId };
export class RadixSDK {
    networkId;
    gateway;
    constructor(options) {
        this.networkId = options?.networkId ?? NetworkId.Mainnet;
        this.gateway = GatewayApiClient.initialize({
            applicationName,
            networkId: this.networkId,
        });
    }
    async getXrdAddress() {
        const knownAddresses = await LTSRadixEngineToolkit.Derive.knownAddresses(this.networkId);
        return knownAddresses.resources.xrdResource;
    }
    async getBalance(address, resource) {
        const details = await this.gateway.state.getEntityDetailsVaultAggregated(address);
        const fungibleResource = details.fungible_resources.items.find((r) => r.resource_address === resource);
        if (!fungibleResource || fungibleResource.vaults.items.length !== 1) {
            return '0';
        }
        return fungibleResource.vaults.items[0].amount;
    }
    async getXrdBalance(address) {
        const xrdAddress = await this.getXrdAddress();
        return this.getBalance(address, xrdAddress);
    }
    async queryMailbox(mailbox) {
        const details = await this.gateway.state.getEntityDetailsVaultAggregated(mailbox);
        const fields = details.details.state.fields;
        const ownerResource = details.details.role_assignments.owner.rule
            .access_rule.proof_rule.requirement.resource;
        const { items } = await this.gateway.extensions.getResourceHolders(ownerResource);
        const resourceHolders = [
            ...new Set(items.map((item) => item.holder_address)),
        ];
        assert(resourceHolders.length === 1, `expected token holders of resource ${ownerResource} to be one, found ${resourceHolders.length} holders instead`);
        const result = {
            address: mailbox,
            owner: resourceHolders[0],
            localDomain: parseInt(fields.find((f) => f.field_name === 'local_domain').value),
            nonce: parseInt(fields.find((f) => f.field_name === 'nonce').value),
            defaultIsm: fields.find((f) => f.field_name === 'default_ism')
                .fields[0].value,
            defaultHook: fields.find((f) => f.field_name === 'default_hook')
                .fields[0].value,
            requiredHook: fields.find((f) => f.field_name === 'required_hook')
                .fields[0].value,
        };
        return result;
    }
    async queryIsm(ism) {
        const details = await this.gateway.state.getEntityDetailsVaultAggregated(ism);
        const fields = details.details.state.fields;
        const result = {
            address: ism,
            type: details.details.blueprint_name,
            validators: (fields.find((f) => f.field_name === 'validators')?.elements ?? []).map((v) => ensure0x(v.hex)),
            threshold: parseInt(fields.find((f) => f.field_name === 'threshold')?.value ?? '0'),
        };
        return result;
    }
    async queryIgpHook(hook) {
        const details = await this.gateway.state.getEntityDetailsVaultAggregated(hook);
        assert(details.details.blueprint_name === 'InterchainGasPaymaster', `Expected contract at address ${hook} to be "InterchainGasPaymaster" but got ${details.details.blueprint_name}`);
        const ownerResource = details.details.role_assignments.owner.rule
            .access_rule.proof_rule.requirement.resource;
        const { items } = await this.gateway.extensions.getResourceHolders(ownerResource);
        const resourceHolders = [
            ...new Set(items.map((item) => item.holder_address)),
        ];
        assert(resourceHolders.length === 1, `expected token holders of resource ${ownerResource} to be one, found ${resourceHolders.length} holders instead`);
        const fields = details.details.state.fields;
        const destinationGasConfigs = {};
        const entries = fields.find((f) => f.field_name === 'destination_gas_configs')
            ?.entries ?? [];
        for (const entry of entries) {
            const domainId = entry.key.value;
            const gasOverhead = entry.value.fields.find((f) => f.field_name === 'gas_overhead')
                ?.value ?? '0';
            const gasOracle = entry.value.fields.find((f) => f.field_name === 'gas_oracle')
                ?.fields ?? [];
            const tokenExchangeRate = gasOracle.find((f) => f.field_name === 'token_exchange_rate')
                ?.value ?? '0';
            const gasPrice = gasOracle.find((f) => f.field_name === 'gas_price')?.value ?? '0';
            Object.assign(destinationGasConfigs, {
                [domainId]: {
                    gasOracle: {
                        tokenExchangeRate,
                        gasPrice,
                    },
                    gasOverhead,
                },
            });
        }
        return {
            address: hook,
            owner: resourceHolders[0],
            destinationGasConfigs,
        };
    }
    async queryMerkleTreeHook(hook) {
        const details = await this.gateway.state.getEntityDetailsVaultAggregated(hook);
        assert(details.details.blueprint_name === 'MerkleTreeHook', `Expected contract at address ${hook} to be "MerkleTreeHook" but got ${details.details.blueprint_name}`);
        return {
            address: hook,
        };
    }
    async queryToken(token) {
        const details = await this.gateway.state.getEntityDetailsVaultAggregated(token);
        assert(details.details.blueprint_name === 'HypToken', `Expected contract at address ${token} to be "HypToken" but got ${details.details.blueprint_name}`);
        const fields = details.details.state.fields;
        const tokenType = fields.find((f) => f.field_name === 'token_type')?.variant_name ??
            '';
        assert(tokenType === 'COLLATERAL' || tokenType === 'SYNTHETIC', `unknown token type: ${tokenType}`);
        const ismFields = fields.find((f) => f.field_name === 'ism').fields;
        const result = {
            address: token,
            tokenType,
            mailbox: fields.find((f) => f.field_name === 'mailbox')?.value ?? '',
            ism: ismFields[0]?.value ?? '',
        };
        return result;
    }
    async queryEnrolledRouters(token, domainId) {
        const details = await this.gateway.state.getEntityDetailsVaultAggregated(token);
        assert(details.details.blueprint_name === 'HypToken', `Expected contract at address ${token} to be "HypToken" but got ${details.details.blueprint_name}`);
        const fields = details.details.state.fields;
        const enrolledRouters = fields.find((f) => f.field_name === 'enrolled_routers')?.value ?? '';
        assert(enrolledRouters, `found no enrolled routers on token ${token}`);
        const value = await this.gateway.state.innerClient.keyValueStoreData({
            stateKeyValueStoreDataRequest: {
                key_value_store_address: enrolledRouters,
                keys: [
                    {
                        key_hex: Buffer.from(`${domainId}`).toString('hex'),
                    },
                ],
            },
        });
        console.log('enrolledRouters value', value);
        const result = {
            address: token,
        };
        return result;
    }
}
export class RadixSigningSDK extends RadixSDK {
    gasAmount;
    account;
    constructor(account, options) {
        super(options);
        this.account = account;
        this.gasAmount = options?.gasAmount ?? 5000;
    }
    static async generateNewEd25519VirtualAccount(privateKey, networkId) {
        const pk = new PrivateKey.Ed25519(new Uint8Array(Buffer.from(privateKey, 'hex')));
        const publicKey = pk.publicKey();
        const address = await LTSRadixEngineToolkit.Derive.virtualAccountAddress(publicKey, networkId);
        return {
            privateKey: pk,
            publicKey,
            address,
        };
    }
    static async fromRandomPrivateKey(options) {
        const privateKey = Buffer.from(await this.generateSecureRandomBytes(32)).toString('hex');
        const account = await this.generateNewEd25519VirtualAccount(privateKey, options?.networkId ?? NetworkId.Mainnet);
        return new RadixSigningSDK(account, options);
    }
    static async fromPrivateKey(privateKey, options) {
        const account = await this.generateNewEd25519VirtualAccount(privateKey, options?.networkId ?? NetworkId.Mainnet);
        return new RadixSigningSDK(account, options);
    }
    getAddress() {
        return this.account.address;
    }
    async getTestnetXrd() {
        const constructionMetadata = await this.gateway.transaction.innerClient.transactionConstruction();
        const freeXrdForAccountTransaction = await SimpleTransactionBuilder.freeXrdFromFaucet({
            networkId: this.networkId,
            toAccount: this.account.address,
            validFromEpoch: constructionMetadata.ledger_state.epoch,
        });
        const intentHashTransactionId = freeXrdForAccountTransaction.transactionId.id;
        await this.gateway.transaction.innerClient.transactionSubmit({
            transactionSubmitRequest: {
                notarized_transaction_hex: freeXrdForAccountTransaction.toHex(),
            },
        });
        await this.pollForCommit(intentHashTransactionId);
        return intentHashTransactionId;
    }
    async getNewComponent(transaction) {
        const transactionReceipt = await this.gateway.transaction.getCommittedDetails(transaction.id);
        const receipt = transactionReceipt.transaction.receipt;
        assert(receipt, `found no receipt on transaction: ${transaction.id}`);
        const newGlobalGenericComponent = receipt.state_updates.new_global_entities.find((entity) => entity.entity_type === 'GlobalGenericComponent');
        assert(newGlobalGenericComponent, `found no newly created component on transaction: ${transaction.id}`);
        return newGlobalGenericComponent.entity_address;
    }
    static async generateSecureRandomBytes(count) {
        const byteArray = new Uint8Array(count);
        getRandomValues(byteArray);
        return byteArray;
    }
    signIntent = (hashToSign) => {
        return this.account.privateKey.signToSignatureWithPublicKey(hashToSign);
    };
    notarizeIntent = (hashToSign) => {
        return this.account.privateKey.signToSignature(hashToSign);
    };
    createCallFunctionManifest(packageAddress, blueprintName, functionName, args) {
        return new ManifestBuilder()
            .callMethod('component_sim1cptxxxxxxxxxfaucetxxxxxxxxx000527798379xxxxxxxxxhkrefh', 'lock_fee', [decimal(this.gasAmount)])
            .callFunction(packageAddress, blueprintName, functionName, args)
            .callMethod(this.account.address, 'try_deposit_batch_or_refund', [
            expression('EntireWorktop'),
            enumeration(0),
        ])
            .build();
    }
    createCallMethodManifest(address, methodName, args) {
        return new ManifestBuilder()
            .callMethod('component_sim1cptxxxxxxxxxfaucetxxxxxxxxx000527798379xxxxxxxxxhkrefh', 'lock_fee', [decimal(this.gasAmount)])
            .callMethod(address, methodName, args)
            .callMethod(this.account.address, 'try_deposit_batch_or_refund', [
            expression('EntireWorktop'),
            enumeration(0),
        ])
            .build();
    }
    async createCallMethodManifestWithOwner(addr, methodName, args) {
        const details = await this.gateway.state.getEntityDetailsVaultAggregated(addr);
        const ownerResource = details.details.role_assignments.owner.rule
            .access_rule.proof_rule.requirement.resource;
        return new ManifestBuilder()
            .callMethod('component_sim1cptxxxxxxxxxfaucetxxxxxxxxx000527798379xxxxxxxxxhkrefh', 'lock_fee', [decimal(this.gasAmount)])
            .callMethod(this.account.address, 'create_proof_of_amount', [
            address(ownerResource),
            decimal(1),
        ])
            .callMethod(addr, methodName, args)
            .callMethod(this.account.address, 'try_deposit_batch_or_refund', [
            expression('EntireWorktop'),
            enumeration(0),
        ])
            .build();
    }
    async signAndBroadcast(manifest) {
        const constructionMetadata = await this.gateway.transaction.innerClient.transactionConstruction();
        const transactionHeader = {
            networkId: this.networkId,
            startEpochInclusive: constructionMetadata.ledger_state.epoch,
            endEpochExclusive: constructionMetadata.ledger_state.epoch + 2,
            nonce: generateRandomNonce(),
            notaryPublicKey: this.account.publicKey,
            notaryIsSignatory: true,
            tipPercentage: 0,
        };
        const transaction = await TransactionBuilder.new().then((builder) => builder
            .header(transactionHeader)
            .manifest(manifest)
            .sign(this.signIntent)
            .notarize(this.notarizeIntent));
        const compiledNotarizedTransaction = await RadixEngineToolkit.NotarizedTransaction.compile(transaction);
        const intentHashTransactionId = await RadixEngineToolkit.NotarizedTransaction.intentHash(transaction);
        await this.gateway.transaction.innerClient.transactionSubmit({
            transactionSubmitRequest: {
                notarized_transaction_hex: Buffer.from(compiledNotarizedTransaction).toString('hex'),
            },
        });
        await this.pollForCommit(intentHashTransactionId.id);
        return intentHashTransactionId;
    }
    async pollForCommit(intentHashTransactionId) {
        const pollAttempts = 200;
        const pollDelayMs = 5000;
        for (let i = 0; i < pollAttempts; i++) {
            let statusOutput;
            try {
                statusOutput =
                    await this.gateway.transaction.innerClient.transactionStatus({
                        transactionStatusRequest: { intent_hash: intentHashTransactionId },
                    });
            }
            catch (err) {
                await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
                continue;
            }
            switch (statusOutput.intent_status) {
                case 'CommittedSuccess':
                    return;
                case 'CommittedFailure':
                    // You will typically wish to build a new transaction and try again.
                    throw new Error(`Transaction ${intentHashTransactionId} was not committed successfully - instead it resulted in: ${statusOutput.intent_status} with description: ${statusOutput.error_message}`);
                case 'CommitPendingOutcomeUnknown':
                    // We keep polling
                    if (i < pollAttempts) {
                        await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
                    }
                    else {
                        throw new Error(`Transaction ${intentHashTransactionId} was not committed successfully within ${pollAttempts} poll attempts over ${pollAttempts * pollDelayMs}ms - instead it resulted in STATUS: ${statusOutput.intent_status} DESCRIPTION: ${statusOutput.intent_status_description}`);
                    }
            }
        }
    }
    populateTransfer(toAddress, resourceAddress, amount) {
        return new ManifestBuilder()
            .callMethod('component_sim1cptxxxxxxxxxfaucetxxxxxxxxx000527798379xxxxxxxxxhkrefh', 'lock_fee', [decimal(this.gasAmount)])
            .callMethod(this.account.address, 'withdraw', [
            address(resourceAddress),
            decimal(amount),
        ])
            .takeFromWorktop(resourceAddress, new Decimal(amount), (builder, bucketId) => builder.callMethod(toAddress, 'try_deposit_or_abort', [
            bucket(bucketId),
        ]))
            .build();
    }
    async transfer(toAddress, resourceAddress, amount) {
        const transactionManifest = this.populateTransfer(toAddress, resourceAddress, amount);
        const intentHashTransactionId = await this.signAndBroadcast(transactionManifest);
        return await this.getNewComponent(intentHashTransactionId);
    }
    populateCreateMailbox(domainId) {
        return this.createCallFunctionManifest(packageAddress, 'Mailbox', 'mailbox_instantiate', [u32(domainId)]);
    }
    async createMailbox(domainId) {
        const transactionManifest = this.populateCreateMailbox(domainId);
        const intentHashTransactionId = await this.signAndBroadcast(transactionManifest);
        return await this.getNewComponent(intentHashTransactionId);
    }
    async populateSetIgpOwner(igp, newOwner) {
        const details = await this.gateway.state.getEntityDetailsVaultAggregated(igp);
        const resource = details.details.role_assignments.owner.rule
            .access_rule.proof_rule.requirement.resource;
        return this.populateTransfer(newOwner, resource, '1');
    }
    async setIgpOwner(igp, newOwner) {
        const transactionManifest = await this.populateSetIgpOwner(igp, newOwner);
        const intentHashTransactionId = await this.signAndBroadcast(transactionManifest);
        return await this.getNewComponent(intentHashTransactionId);
    }
    populateCreateMerkleTreeHook(mailbox) {
        return this.createCallFunctionManifest(packageAddress, 'MerkleTreeHook', 'instantiate', [address(mailbox)]);
    }
    async createMerkleTreeHook(mailbox) {
        const transactionManifest = this.populateCreateMerkleTreeHook(mailbox);
        const intentHashTransactionId = await this.signAndBroadcast(transactionManifest);
        return await this.getNewComponent(intentHashTransactionId);
    }
    populateCreateMerkleRootMultisigIsm(validators, threshold) {
        return this.createCallFunctionManifest(packageAddress, 'MerkleRootMultisigIsm', 'instantiate', [
            array(ValueKind.Array, ...validators.map((v) => bytes(strip0x(v)))),
            u64(threshold),
        ]);
    }
    async createMerkleRootMultisigIsm(validators, threshold) {
        const transactionManifest = this.populateCreateMerkleRootMultisigIsm(validators, threshold);
        const intentHashTransactionId = await this.signAndBroadcast(transactionManifest);
        return await this.getNewComponent(intentHashTransactionId);
    }
    populateCreateMessageIdMultisigIsm(validators, threshold) {
        return this.createCallFunctionManifest(packageAddress, 'MessageIdMultisigIsm', 'instantiate', [
            array(ValueKind.Array, ...validators.map((v) => bytes(strip0x(v)))),
            u64(threshold),
        ]);
    }
    async createMessageIdMultisigIsm(validators, threshold) {
        const transactionManifest = this.populateCreateMessageIdMultisigIsm(validators, threshold);
        const intentHashTransactionId = await this.signAndBroadcast(transactionManifest);
        return await this.getNewComponent(intentHashTransactionId);
    }
    populateCreateNoopIsm() {
        return this.createCallFunctionManifest(packageAddress, 'NoopIsm', 'instantiate', []);
    }
    async createNoopIsm() {
        const transactionManifest = this.populateCreateNoopIsm();
        const intentHashTransactionId = await this.signAndBroadcast(transactionManifest);
        return await this.getNewComponent(intentHashTransactionId);
    }
    populateCreateIgp(denom) {
        return this.createCallFunctionManifest(packageAddress, 'InterchainGasPaymaster', 'instantiate', [address(denom)]);
    }
    async createIgp(denom) {
        const transactionManifest = this.populateCreateIgp(denom);
        const intentHashTransactionId = await this.signAndBroadcast(transactionManifest);
        return await this.getNewComponent(intentHashTransactionId);
    }
    async populateSetMailboxOwner(mailbox, newOwner) {
        const details = await this.gateway.state.getEntityDetailsVaultAggregated(mailbox);
        const resource = details.details.role_assignments.owner.rule
            .access_rule.proof_rule.requirement.resource;
        return this.populateTransfer(newOwner, resource, '1');
    }
    async setMailboxOwner(mailbox, newOwner) {
        const transactionManifest = await this.populateSetMailboxOwner(mailbox, newOwner);
        const intentHashTransactionId = await this.signAndBroadcast(transactionManifest);
        return await this.getNewComponent(intentHashTransactionId);
    }
    populateCreateValidatorAnnounce(mailbox) {
        return this.createCallFunctionManifest(packageAddress, 'ValidatorAnnounce', 'instantiate', [address(mailbox)]);
    }
    async createValidatorAnnounce(mailbox) {
        const transactionManifest = this.populateCreateValidatorAnnounce(mailbox);
        const intentHashTransactionId = await this.signAndBroadcast(transactionManifest);
        return await this.getNewComponent(intentHashTransactionId);
    }
    populateSetRequiredHook(mailbox, hook) {
        return this.createCallMethodManifest(mailbox, 'set_required_hook', [
            address(hook),
        ]);
    }
    async setRequiredHook(mailbox, hook) {
        const transactionManifest = this.populateSetRequiredHook(mailbox, hook);
        await this.signAndBroadcast(transactionManifest);
    }
    populateSetDefaultHook(mailbox, hook) {
        return this.createCallMethodManifest(mailbox, 'set_default_hook', [
            address(hook),
        ]);
    }
    async setDefaultHook(mailbox, hook) {
        const transactionManifest = this.populateSetDefaultHook(mailbox, hook);
        await this.signAndBroadcast(transactionManifest);
    }
    populateSetDefaultIsm(mailbox, ism) {
        return this.createCallMethodManifest(mailbox, 'set_default_ism', [
            address(ism),
        ]);
    }
    async setDefaultIsm(mailbox, ism) {
        const transactionManifest = this.populateSetDefaultIsm(mailbox, ism);
        await this.signAndBroadcast(transactionManifest);
    }
    populateCreateCollateralToken(mailbox, originDenom) {
        return this.createCallFunctionManifest(packageAddress, 'HypToken', 'instantiate', [enumeration(0, address(originDenom)), address(mailbox)]);
    }
    async createCollateralToken(mailbox, originDenom) {
        const transactionManifest = this.populateCreateCollateralToken(mailbox, originDenom);
        const intentHashTransactionId = await this.signAndBroadcast(transactionManifest);
        return await this.getNewComponent(intentHashTransactionId);
    }
    populateCreateSyntheticToken(mailbox, name, symbol, description, divisibility) {
        return this.createCallFunctionManifest(packageAddress, 'HypToken', 'instantiate', [
            enumeration(1, tuple(str(name), str(symbol), str(description), u8(divisibility))),
            address(mailbox),
        ]);
    }
    async createSyntheticToken(mailbox, name, symbol, description, divisibility) {
        const transactionManifest = this.populateCreateSyntheticToken(mailbox, name, symbol, description, divisibility);
        const intentHashTransactionId = await this.signAndBroadcast(transactionManifest);
        return await this.getNewComponent(intentHashTransactionId);
    }
    async populateSetTokenIsm(token, ism) {
        return this.createCallMethodManifestWithOwner(token, 'set_ism', [
            enumeration(1, address(ism)),
        ]);
    }
    async setTokenIsm(token, ism) {
        const transactionManifest = await this.populateSetTokenIsm(token, ism);
        await this.signAndBroadcast(transactionManifest);
    }
}
// TODO: RADIX
// const main = async () => {
//   const sdk = await RadixSigningSDK.fromPrivateKey(
//     '4f61d7cd8c2bebd01ff86da87001cbe0a2349fa5ba43ef95eee5d0d817b035cc',
//     {
//       networkId: NetworkId.Stokenet,
//     },
//   );
//   const balance = await sdk.getXrdBalance(sdk.getAddress());
//   console.log('xrd balance', balance);
// await sdk.getTestnetXrd();
// const mailbox = await sdk.createMailbox(75898670);
// console.log('created mailbox with id', mailbox, '\n');
// const merkleTreeHook = await sdk.createMerkleTreeHook(mailbox);
// console.log('created merkleTreeHook with id', merkleTreeHook, '\n');
// const merkleRootMultisigIsm = await sdk.createMerkleRootMultisigIsm(
//   ['0x0c60e7eCd06429052223C78452F791AAb5C5CAc6'],
//   1,
// );
// console.log(
//   'created merkleRootMultisigIsm with id',
//   merkleRootMultisigIsm,
//   '\n',
// );
// const xrd = await sdk.getXrdAddress();
// const igp = await sdk.createIgp(xrd);
// console.log('created igp with id', igp, '\n');
// await sdk.setRequiredHook(mailbox, merkleTreeHook);
// console.log('set required hook\n');
// await sdk.setDefaultHook(mailbox, igp);
// console.log('set default hook\n');
// await sdk.setDefaultIsm(mailbox, merkleRootMultisigIsm);
// console.log('set default ism\n');
// const m = await sdk.queryMailbox(
//   'component_tdx_2_1cqaet9grt80sn9k07hqjtugfg974x2pzmc7k3kcndqqv7895a6v8ux',
// );
// console.log('mailbox state', m, '\n');
// const i = await sdk.queryIsm(merkleRootMultisigIsm);
// console.log('ism state', i, '\n');
//   const h = await sdk.queryIgpHook(
//     'component_tdx_2_1crrt89w8hd5jvvh49jcqgl9wmvmauw0k0wf7yafzahfc276xzu3ak2',
//   );
//   console.log('igp hook state', JSON.stringify(h), '\n');
// const xrd = await sdk.getXrdAddress();
// const collateral = await sdk.createCollateralToken(
//   'component_tdx_2_1cq2vyesapheluv2a796am85cdl7rcgnjkawwkp3axxetv4zcfjzl40',
//   xrd,
// );
// console.log('created collateral token with id', collateral);
// const c = await sdk.queryToken(
//   'component_tdx_2_1cz57khz7zqlppt4jwng5znvzur47yed474h5ck9mdudwdwh2ux8n80',
// );
// console.log('collateral token state', JSON.stringify(c), '\n');
// await sdk.setTokenIsm(
//   'component_tdx_2_1cz57khz7zqlppt4jwng5znvzur47yed474h5ck9mdudwdwh2ux8n80',
//   'component_tdx_2_1czefsgch7kvgvlw2ht5shkna00vjfaexr03xavlcuy73yka6rydr6g',
// );
// const synthetic = await sdk.createSyntheticToken(
//   'component_tdx_2_1cq2vyesapheluv2a796am85cdl7rcgnjkawwkp3axxetv4zcfjzl40',
//   '',
//   '',
//   '',
//   1,
// );
// console.log('created synthetic token with id', synthetic);
//   const s = await sdk.queryToken(
//     'component_tdx_2_1czxew56q0yglq62tvvapyr5gqp8vcswlwzh62999ahrr35gc5jxg32',
//   );
//   console.log('synthetic token state', JSON.stringify(s));
// };
// main();
//# sourceMappingURL=index.js.map