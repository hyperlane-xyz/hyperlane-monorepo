"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getContractVerificationInput = void 0;
const ethers_1 = require("ethers");
function getConstructorArguments(contract, bytecode) {
    const tx = contract.deployTransaction;
    if (tx === undefined)
        throw new Error('deploy transaction not found');
    const abi = contract.interface.deploy.inputs;
    const encodedArguments = `0x${tx.data.replace(bytecode, '')}`;
    const coerce = (t, value) => {
        if (t.startsWith('uint')) {
            return value.toNumber();
        }
        return value;
    };
    const decoder = new ethers_1.ethers.utils.AbiCoder(coerce);
    const decoded = decoder.decode(abi, encodedArguments);
    return decoded;
}
function getContractVerificationInput(name, contract, bytecode, isProxy) {
    return {
        name,
        address: contract.address,
        constructorArguments: getConstructorArguments(contract, bytecode),
        isProxy,
    };
}
exports.getContractVerificationInput = getContractVerificationInput;
//# sourceMappingURL=utils.js.map