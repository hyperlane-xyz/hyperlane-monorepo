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
exports.AbacusRouterDeployer = void 0;
const utils_1 = require("@abacus-network/utils");
const deploy_1 = require("../deploy");
class AbacusRouterDeployer extends deploy_1.AbacusAppDeployer {
    deploy(config) {
        const _super = Object.create(null, {
            deploy: { get: () => super.deploy }
        });
        return __awaiter(this, void 0, void 0, function* () {
            yield _super.deploy.call(this, config);
            // Make all routers aware of eachother.
            for (const local of this.domainNumbers) {
                const router = this.mustGetRouter(local);
                for (const remote of this.remoteDomainNumbers(local)) {
                    const remoteRouter = this.mustGetRouter(remote);
                    yield router.enrollRemoteRouter(remote, utils_1.utils.addressToBytes32(remoteRouter.address));
                }
            }
        });
    }
    get routerAddresses() {
        const addresses = {};
        for (const domain of this.domainNumbers) {
            addresses[domain] = this.mustGetRouter(domain).address;
        }
        return addresses;
    }
}
exports.AbacusRouterDeployer = AbacusRouterDeployer;
//# sourceMappingURL=deploy.js.map