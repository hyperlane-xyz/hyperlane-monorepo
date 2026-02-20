import {expect} from "chai";
import hre from "hardhat";
import {stringToHex} from "viem";

import {addressToBytes32} from "@hyperlane-xyz/utils";

import {getSigner} from "./signer";

const testData = stringToHex("test");
describe("TestRecipient", () => {
    let recipient: any;
    let signerAddress: string;

    before(async () => {
        const signer = await getSigner();
        signerAddress = await signer.getAddress();
        const recipientFactory = await hre.ethers.getContractFactory(
            "TestRecipient",
            signer,
        );
        recipient = await recipientFactory.deploy();
    });

    it("handles a message", async () => {
        const tx = await recipient.handle(
            0,
            addressToBytes32(signerAddress),
            testData,
        );
        await tx.wait();
        expect(await recipient.lastSender()).to.eql(
            addressToBytes32(signerAddress),
        );
        expect(await recipient.lastData()).to.eql(testData);
    });

    it("handles a call", async () => {
        const tx = await recipient.fooBar(1, "test");
        await tx.wait();

        expect(await recipient.lastCaller()).to.eql(signerAddress);
        expect(await recipient.lastCallMessage()).to.eql("test");
    });
});
