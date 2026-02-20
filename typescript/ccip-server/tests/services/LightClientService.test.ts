import {describe, expect, jest, test} from "@jest/globals";
import {zeroAddress, zeroHash} from "viem";

import {TelepathyCcipReadIsmAbi} from "../../src/abis/TelepathyCcipReadIsmAbi";
import {LightClientService} from "../../src/services/LightClientService";
import {RPCService} from "../../src/services/RPCService";

describe("LightClientService", () => {
    let lightClientService: LightClientService;
    beforeEach(() => {
        const lightClientContract = {
            address: "lightClientAddress",
            abi: TelepathyCcipReadIsmAbi,
            provider: new RPCService("http://localhost:8545").provider,
        };
        lightClientService = new LightClientService(lightClientContract, {
            lightClientAddress: zeroAddress,
            stepFunctionId: zeroHash,
            platformUrl: "http://localhost:8080",
            apiKey: "apiKey",
        });

        jest.resetModules();
    });
    test("should return the correct proof status", () => {
        expect(lightClientService.calculateSlot(1n)).toBeGreaterThan(0);
    });
});
