"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ContractVerifier = void 0;
const axios_1 = __importDefault(require("axios"));
const etherscanChains = [
    'ethereum',
    'kovan',
    'goerli',
    'ropsten',
    'rinkeby',
    'polygon',
];
class ContractVerifier {
    constructor(key) {
        this.key = key;
    }
    static etherscanLink(network, address) {
        if (network === 'polygon') {
            return `https://polygonscan.com/address/${address}`;
        }
        const prefix = network === 'ethereum' ? '' : `${network}.`;
        return `https://${prefix}etherscan.io/address/${address}`;
    }
    verify(hre) {
        return __awaiter(this, void 0, void 0, function* () {
            let network = hre.network.name;
            if (network === 'mainnet') {
                network = 'ethereum';
            }
            const envError = (network) => `pass --network tag to hardhat task (current network=${network})`;
            // assert that network from .env is supported by Etherscan
            if (!etherscanChains.includes(network)) {
                throw new Error(`Network not supported by Etherscan; ${envError(network)}`);
            }
            // get the JSON verification inputs for the given network
            // from the latest contract deploy; throw if not found
            const verificationInputs = this.getVerificationInput(network);
            // loop through each verification input for each contract in the file
            for (const verificationInput of verificationInputs) {
                // attempt to verify contract on etherscan
                // (await one-by-one so that Etherscan doesn't rate limit)
                yield this.verifyContract(network, verificationInput, hre);
            }
        });
    }
    verifyContract(network, input, hre) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                console.log(`   Attempt to verify ${input.name}   -  ${ContractVerifier.etherscanLink(network, input.address)}`);
                yield hre.run('verify:verify', {
                    network,
                    address: input.address,
                    constructorArguments: input.constructorArguments,
                });
                console.log(`   SUCCESS verifying ${input.name}`);
                if (input.isProxy) {
                    console.log(`   Attempt to verify as proxy`);
                    yield this.verifyProxy(network, input.address);
                    console.log(`   SUCCESS submitting proxy verification`);
                }
            }
            catch (e) {
                console.log(`   ERROR verifying ${input.name}`);
                console.error(e);
            }
            console.log('\n\n'); // add space after each attempt
        });
    }
    verifyProxy(network, address) {
        return __awaiter(this, void 0, void 0, function* () {
            const suffix = network === 'ethereum' ? '' : `-${network}`;
            console.log(`   Submit ${address} for proxy verification on ${network}`);
            // Submit contract for verification
            const verifyResponse = yield axios_1.default.post(`https://api${suffix}.etherscan.io/api`, `address=${address}`, {
                params: {
                    module: 'contract',
                    action: 'verifyproxycontract',
                    apikey: this.key,
                },
            });
            // Validate that submission worked
            if (verifyResponse.status !== 200) {
                throw new Error('Verify POST failed');
            }
            else if (verifyResponse.data.status != '1') {
                throw new Error(verifyResponse.data.result);
            }
            console.log(`   Submitted.`);
        });
    }
}
exports.ContractVerifier = ContractVerifier;
//# sourceMappingURL=ContractVerifier.js.map