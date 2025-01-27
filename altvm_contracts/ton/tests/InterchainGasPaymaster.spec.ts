import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, Dictionary, toNano } from '@ton/core';
import { InterchainGasPaymaster, InterchainGasPaymasterConfig } from '../wrappers/InterchainGasPaymaster';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { TGasConfig } from '../wrappers/utils/types';
import { randomBytes } from 'crypto';
import { Errors, OpCodes } from '../wrappers/utils/constants';
import { makeRandomBigint } from './utils/generators';

const TOKEN_EXCHANGE_RATE_SCALE = 10000000000n;

describe('InterchainGasPaymaster', () => {
    let code: Cell;

    beforeAll(async () => {
        code = await compile('InterchainGasPaymaster');
    });

    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let beneficiary: SandboxContract<TreasuryContract>;
    let interchainGasPaymaster: SandboxContract<InterchainGasPaymaster>;
    let config: InterchainGasPaymasterConfig;
    let intialGasConfig: TGasConfig;
    const gasLimit = 100000n;
    beforeEach(async () => {
        blockchain = await Blockchain.create();
        deployer = await blockchain.treasury('deployer');
        beneficiary = await blockchain.treasury('beneficiary');

        intialGasConfig = {
            gasOracle: makeRandomBigint(),
            gasOverhead: 0n,
            exchangeRate: 1n,
            gasPrice: 1000000000n,
        };

        const dictDestGasConfig = Dictionary.empty(
            InterchainGasPaymaster.GasConfigKey,
            InterchainGasPaymaster.GasConfigValue,
        );
        dictDestGasConfig.set(0, intialGasConfig);

        config = {
            owner: deployer.address,
            beneficiary: beneficiary.address,
            hookType: 0,
            hookMetadata: Cell.EMPTY,
            destGasConfig: dictDestGasConfig,
        };

        interchainGasPaymaster = blockchain.openContract(InterchainGasPaymaster.createFromConfig(config, code));

        const deployResult = await interchainGasPaymaster.sendDeploy(deployer.getSender(), toNano('100'));

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: interchainGasPaymaster.address,
            deploy: true,
            success: true,
        });
    });

    it('should post dispatch', async () => {
        const postDispatchBody = {
            messageId: makeRandomBigint(),
            destDomain: 0,
            hookMetadata: {
                variant: 0,
                msgValue: toNano('0.1'),
                gasLimit: gasLimit,
                refundAddress: deployer.address,
            },
            refundAddr: deployer.address,
        };
        const res = await interchainGasPaymaster.sendPostDispatch(
            deployer.getSender(),
            toNano('0.1'),
            postDispatchBody,
        );

        expect(res.transactions).toHaveTransaction({
            from: deployer.address,
            to: interchainGasPaymaster.address,
            op: OpCodes.POST_DISPATCH,
            success: true,
        });
        expect(res.externals).toHaveLength(1);
    });

    it('should claim', async () => {
        const minimalBalance = toNano('0.5');
        const res = await interchainGasPaymaster.sendClaim(deployer.getSender(), toNano('0.1'));

        expect(res.transactions).toHaveTransaction({
            from: deployer.address,
            to: interchainGasPaymaster.address,
            op: OpCodes.CLAIM,
            success: true,
        });

        const balanceAfter = await beneficiary.getBalance();
        const paymasterBalanceAfter = await interchainGasPaymaster.getBalance();
        expect(paymasterBalanceAfter).toStrictEqual(minimalBalance);
    });

    it('should set destitation gas config', async () => {
        const destGasConfig = await interchainGasPaymaster.getDestGasConfig();
        expect(destGasConfig.get(0)).toStrictEqual(intialGasConfig);
        expect(destGasConfig.size).toStrictEqual(1);

        const gasConfigNew: TGasConfig = {
            gasOracle: makeRandomBigint(),
            gasOverhead: 10n,
            exchangeRate: 2n,
            gasPrice: 100n,
        };

        const res = await interchainGasPaymaster.sendSetDestGasConfig(deployer.getSender(), toNano('0.1'), {
            destDomain: 1,
            gasConfig: gasConfigNew,
        });

        expect(res.transactions).toHaveTransaction({
            from: deployer.address,
            to: interchainGasPaymaster.address,
            op: OpCodes.SET_DEST_GAS_CONFIG,
            success: true,
        });

        destGasConfig.set(1, gasConfigNew);

        const updDestGasConfig = await interchainGasPaymaster.getDestGasConfig();
        expect(updDestGasConfig).toStrictEqual(destGasConfig);
    });

    it('should transfer ownership', async () => {
        const owner = await interchainGasPaymaster.getOwner();
        expect(owner.toString()).toStrictEqual(deployer.address.toString());
        const res = await interchainGasPaymaster.sendTransferOwnership(deployer.getSender(), toNano('0.1'), {
            ownerAddr: beneficiary.address,
        });
        expect(res.transactions).toHaveTransaction({
            from: deployer.address,
            to: interchainGasPaymaster.address,
            op: OpCodes.TRANSFER_OWNERSHIP,
            success: true,
        });

        const updatedOwner = await interchainGasPaymaster.getOwner();
        expect(updatedOwner.toString()).toStrictEqual(beneficiary.address.toString());
    });

    it('should set beneficiary', async () => {
        const beneficaryAddr = await interchainGasPaymaster.getBeneficiary();
        expect(beneficaryAddr.toString()).toStrictEqual(config.beneficiary.toString());
        const res = await interchainGasPaymaster.sendSetBeneficiary(deployer.getSender(), toNano('0.1'), {
            beneficiaryAddr: deployer.address,
        });
        expect(res.transactions).toHaveTransaction({
            from: deployer.address,
            to: interchainGasPaymaster.address,
            op: OpCodes.SET_BENEFICIARY,
            success: true,
        });
        const updatedAddr = await interchainGasPaymaster.getBeneficiary();
        expect(updatedAddr.toString()).toStrictEqual(deployer.address.toString());
    });

    it('should not claim if sender is not owner', async () => {
        const res = await interchainGasPaymaster.sendClaim(beneficiary.getSender(), toNano('0.1'));

        expect(res.transactions).toHaveTransaction({
            from: beneficiary.address,
            to: interchainGasPaymaster.address,
            op: OpCodes.CLAIM,
            success: false,
            exitCode: Errors.UNAUTHORIZED_SENDER,
        });
    });

    it('should not transfer ownership if sender not owner', async () => {
        const owner = await interchainGasPaymaster.getOwner();
        expect(owner.toString()).toStrictEqual(deployer.address.toString());
        const res = await interchainGasPaymaster.sendTransferOwnership(beneficiary.getSender(), toNano('0.1'), {
            ownerAddr: beneficiary.address,
        });
        expect(res.transactions).toHaveTransaction({
            from: beneficiary.address,
            to: interchainGasPaymaster.address,
            op: OpCodes.TRANSFER_OWNERSHIP,
            success: false,
            exitCode: Errors.UNAUTHORIZED_SENDER,
        });

        const updatedOwner = await interchainGasPaymaster.getOwner();
        expect(updatedOwner.toString()).toStrictEqual(deployer.address.toString());
    });

    it('should not set beneficiary if sender not owner', async () => {
        const beneficiaryAddr = await interchainGasPaymaster.getBeneficiary();
        expect(beneficiaryAddr.toString()).toStrictEqual(config.beneficiary.toString());
        const res = await interchainGasPaymaster.sendSetBeneficiary(beneficiary.getSender(), toNano('0.1'), {
            beneficiaryAddr: deployer.address,
        });
        expect(res.transactions).toHaveTransaction({
            from: beneficiary.address,
            to: interchainGasPaymaster.address,
            op: OpCodes.SET_BENEFICIARY,
            success: false,
            exitCode: Errors.UNAUTHORIZED_SENDER,
        });
        const updatedAddr = await interchainGasPaymaster.getBeneficiary();
        expect(updatedAddr.toString()).toStrictEqual(beneficiary.address.toString());
    });

    it('should get exchange rate and gas price', async () => {
        const { exchangeRate, gasPrice } = await interchainGasPaymaster.getExchangeRateAndGasPrice(0);
        expect(exchangeRate).toStrictEqual(intialGasConfig.exchangeRate);
        expect(gasPrice).toStrictEqual(intialGasConfig.gasPrice);
    });

    it('should get beneficary', async () => {
        const beneficaryAddr = await interchainGasPaymaster.getBeneficiary();
        expect(beneficaryAddr.toString()).toStrictEqual(config.beneficiary.toString());
    });

    it('should get dest gas config', async () => {
        const gasConfig = await interchainGasPaymaster.getDestGasConfig();
        expect(gasConfig).toStrictEqual(config.destGasConfig);
    });

    it('should get hook type', async () => {
        const hookType = await interchainGasPaymaster.getHookType();
        expect(hookType).toStrictEqual(config.hookType);
    });

    it('should get quote dispatch', async () => {
        const expectedQuoteDispatch = 10000n;
        const quoteDispatch = await interchainGasPaymaster.getQuoteDispatch(0, {
            variant: 0,
            msgValue: toNano('0.1'),
            gasLimit: gasLimit,
            refundAddress: deployer.address,
        });
        expect(quoteDispatch).toStrictEqual(expectedQuoteDispatch);
    });
});
