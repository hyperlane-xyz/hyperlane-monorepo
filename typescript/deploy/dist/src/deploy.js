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
exports.AbacusAppDeployer = exports.ProxiedContract = void 0;
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const sdk_1 = require("@abacus-network/sdk");
const core_1 = require("@abacus-network/core");
const verify_1 = require("./verify");
class ProxiedContract {
    constructor(contract, addresses) {
        this.contract = contract;
        this.addresses = addresses;
    }
    get address() {
        return this.contract.address;
    }
}
exports.ProxiedContract = ProxiedContract;
class AbacusAppDeployer extends sdk_1.MultiProvider {
    constructor() {
        super();
        this.addresses = new Map();
        this.verification = new Map();
    }
    getAddresses(nameOrDomain) {
        return this.getFromMap(nameOrDomain, this.addresses);
    }
    mustGetAddresses(nameOrDomain) {
        return this.mustGetFromMap(nameOrDomain, this.addresses, 'Addresses');
    }
    getVerification(nameOrDomain) {
        return this.getFromMap(nameOrDomain, this.verification);
    }
    mustGetVerification(nameOrDomain) {
        return this.mustGetFromMap(nameOrDomain, this.verification, 'Verification');
    }
    get addressesRecord() {
        const addresses = {};
        this.domainNumbers.map((domain) => {
            addresses[this.mustResolveDomainName(domain)] =
                this.mustGetAddresses(domain);
        });
        return addresses;
    }
    addVerificationInput(nameOrDomain, input) {
        const domain = this.resolveDomain(nameOrDomain);
        const verification = this.verification.get(domain) || [];
        this.verification.set(domain, verification.concat(input));
    }
    deploy(config) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.ready();
            for (const domain of this.domainNumbers) {
                if (this.addresses.has(domain))
                    throw new Error('cannot deploy twice');
                this.addresses.set(domain, yield this.deployContracts(domain, config));
            }
        });
    }
    deployContract(nameOrDomain, contractName, factory, ...args) {
        return __awaiter(this, void 0, void 0, function* () {
            const overrides = this.getOverrides(nameOrDomain);
            const contract = (yield factory.deploy(...args, overrides));
            yield contract.deployTransaction.wait(this.getConfirmations(nameOrDomain));
            this.addVerificationInput(nameOrDomain, [
                (0, verify_1.getContractVerificationInput)(contractName, contract, factory.bytecode, contractName.includes(' Proxy')),
            ]);
            return contract;
        });
    }
    /**
     * Deploys the UpgradeBeacon, Implementation and Proxy for a given contract
     *
     * @param T - The contract
     */
    deployProxiedContract(nameOrDomain, contractName, factory, ubcAddress, deployArgs, initArgs) {
        return __awaiter(this, void 0, void 0, function* () {
            const signer = this.mustGetSigner(nameOrDomain);
            const implementation = yield this.deployContract(nameOrDomain, `${contractName} Implementation`, factory, ...deployArgs);
            const beacon = yield this.deployContract(nameOrDomain, `${contractName} UpgradeBeacon`, new core_1.UpgradeBeacon__factory(signer), implementation.address, ubcAddress);
            const initData = implementation.interface.encodeFunctionData('initialize', initArgs);
            const proxy = yield this.deployContract(nameOrDomain, `${contractName} Proxy`, new core_1.UpgradeBeaconProxy__factory(signer), beacon.address, initData);
            // proxy wait(x) implies implementation and beacon wait(>=x)
            // due to nonce ordering
            yield proxy.deployTransaction.wait(this.getConfirmations(nameOrDomain));
            return new ProxiedContract(factory.attach(proxy.address), {
                proxy: proxy.address,
                implementation: implementation.address,
                beacon: beacon.address,
            });
        });
    }
    /**
     * Sets up a new proxy with the same beacon and implementation
     *
     * @param T - The contract
     */
    duplicateProxiedContract(nameOrDomain, contractName, contract, initArgs) {
        return __awaiter(this, void 0, void 0, function* () {
            const initData = contract.contract.interface.encodeFunctionData('initialize', initArgs);
            const proxy = yield this.deployContract(nameOrDomain, `${contractName} Proxy`, new core_1.UpgradeBeaconProxy__factory(this.mustGetSigner(nameOrDomain)), contract.addresses.beacon, initData);
            return new ProxiedContract(contract.contract.attach(proxy.address), Object.assign(Object.assign({}, contract.addresses), { proxy: proxy.address }));
        });
    }
    ready() {
        return __awaiter(this, void 0, void 0, function* () {
            yield Promise.all(this.domainNumbers.map((domain) => this.mustGetProvider(domain)
                .ready));
        });
    }
    writeContracts(filepath) {
        const contents = `export const addresses = ${AbacusAppDeployer.stringify(this.addressesRecord)}`;
        AbacusAppDeployer.write(filepath, contents);
    }
    writeVerification(directory) {
        for (const name of this.domainNames) {
            AbacusAppDeployer.writeJson(path_1.default.join(directory, `${name}.json`), this.mustGetVerification(name));
        }
    }
    static stringify(obj) {
        return JSON.stringify(obj, null, 2);
    }
    static write(filepath, contents) {
        const dir = path_1.default.dirname(filepath);
        fs_1.default.mkdirSync(dir, { recursive: true });
        fs_1.default.writeFileSync(filepath, contents);
    }
    static writeJson(filepath, obj) {
        AbacusAppDeployer.write(filepath, AbacusAppDeployer.stringify(obj));
    }
}
exports.AbacusAppDeployer = AbacusAppDeployer;
//# sourceMappingURL=deploy.js.map