import {expect} from "chai";
import hre from "hardhat";
import {bytesToHex, toBytes} from "viem";

import {addressToBytes32} from "@hyperlane-xyz/utils";

const ORIGIN_DOMAIN = 1000;
const DESTINATION_DOMAIN = 2000;

describe("MockMailbox", function () {
    it("should be able to mock sending and receiving a message", async function () {
        const publicClient = await hre.viem.getPublicClient();
        const originMailbox = await hre.viem.deployContract("MockMailbox", [
            ORIGIN_DOMAIN,
        ]);
        const destinationMailbox = await hre.viem.deployContract(
            "MockMailbox",
            [DESTINATION_DOMAIN],
        );
        await originMailbox.write.addRemoteMailbox([
            BigInt(DESTINATION_DOMAIN),
            destinationMailbox.address,
        ]);
        const recipient = await hre.viem.deployContract("TestRecipient");

        const body = toBytes("This is a test message");

        await originMailbox.write.dispatch([
            BigInt(DESTINATION_DOMAIN),
            addressToBytes32(recipient.address),
            bytesToHex(body),
        ]);
        const processTx =
            await destinationMailbox.write.processNextInboundMessage();
        await publicClient.waitForTransactionReceipt({hash: processTx});

        const dataReceived = await recipient.read.lastData();
        expect(dataReceived).to.eql(bytesToHex(body));
    });
});
