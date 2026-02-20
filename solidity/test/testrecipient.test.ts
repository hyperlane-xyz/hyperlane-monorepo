import {expect} from "chai";
import hre from "hardhat";
import {stringToHex} from "viem";

import {addressToBytes32} from "@hyperlane-xyz/utils";

import {getSigner} from "./signer";

const testData = stringToHex("test");
describe("TestRecipient", () => {
    let recipient: any;
    let signerAddress: string;
    let publicClient: any;

    before(async () => {
        const signer = await getSigner();
        if (!signer.account) {
            throw new Error("Expected configured hardhat wallet account");
        }
        signerAddress = signer.account.address;
        publicClient = await hre.viem.getPublicClient();
        recipient = await hre.viem.deployContract("TestRecipient");
    });

    it("handles a message", async () => {
        const tx = await recipient.write.handle([
            0n,
            addressToBytes32(signerAddress),
            testData,
        ]);
        await publicClient.waitForTransactionReceipt({hash: tx});
        expect(await recipient.read.lastSender()).to.eql(
            addressToBytes32(signerAddress),
        );
        expect(await recipient.read.lastData()).to.eql(testData);
    });

    it("handles a call", async () => {
        const tx = await recipient.write.fooBar([1n, "test"]);
        await publicClient.waitForTransactionReceipt({hash: tx});

        expect((await recipient.read.lastCaller()).toLowerCase()).to.eql(
            signerAddress.toLowerCase(),
        );
        expect(await recipient.read.lastCallMessage()).to.eql("test");
    });
});
