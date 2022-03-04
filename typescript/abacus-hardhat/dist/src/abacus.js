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
Object.defineProperty(exports, "__esModule", { value: true });
exports.abc = void 0;
const abacus_deploy_1 = require("@abacus-network/abacus-deploy");
function deploy(domains, signer) {
    return __awaiter(this, void 0, void 0, function* () {
        const chains = {};
        const validators = {};
        const overrides = {};
        for (const domain of domains) {
            chains[domain] = { name: domain.toString(), domain, signer, overrides };
            validators[domain] = yield signer.getAddress();
        }
        const config = {
            processGas: 850000,
            reserveGas: 15000,
            validators,
        };
        return abacus_deploy_1.abacus.CoreDeploy.deploy(chains, config);
    });
}
exports.abc = {
    deploy,
};
//# sourceMappingURL=abacus.js.map