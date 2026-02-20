import {expect} from "chai";
import hre from "hardhat";
import {pad, stringToHex, toHex} from "viem";

import {addressToBytes32, formatMessage, messageId} from "@hyperlane-xyz/utils";

import testCases from "../../vectors/message.json" with {type: "json"};

import {getSigner, getSigners} from "./signer.js";

const remoteDomain = 1000;
const localDomain = 2000;
const nonce = 11;

describe("Message", async () => {
    let messageLib: any;
    let version: number;

    before(async () => {
        const signer = await getSigner();

        const Message = await hre.ethers.getContractFactory(
            "TestMessage",
            signer,
        );
        messageLib = await Message.deploy();

        // For consistency with the Mailbox version
        const Mailbox = await hre.ethers.getContractFactory("Mailbox", signer);
        const mailbox = await Mailbox.deploy(localDomain);
        version = await mailbox.VERSION();
    });

    it("Returns fields from a message", async () => {
        const [sender, recipient] = await getSigners();
        const body = pad(stringToHex("message"), {size: 32});

        const message = formatMessage(
            version,
            nonce,
            remoteDomain,
            sender.address,
            localDomain,
            recipient.address,
            body,
        );

        expect(BigInt((await messageLib.version(message)).toString())).to.equal(
            BigInt(version),
        );
        expect(BigInt((await messageLib.nonce(message)).toString())).to.equal(
            BigInt(nonce),
        );
        expect(BigInt((await messageLib.origin(message)).toString())).to.equal(
            BigInt(remoteDomain),
        );
        expect(await messageLib.sender(message)).to.equal(
            addressToBytes32(sender.address),
        );
        expect(
            BigInt((await messageLib.destination(message)).toString()),
        ).to.equal(BigInt(localDomain));
        expect(await messageLib.recipient(message)).to.equal(
            addressToBytes32(recipient.address),
        );
        expect(await messageLib.recipientAddress(message)).to.equal(
            recipient.address,
        );
        expect(await messageLib.body(message)).to.equal(body);
    });

    it("Matches Rust-output HyperlaneMessage and leaf", async () => {
        for (const test of testCases) {
            const {origin, sender, destination, recipient, body, nonce, id} =
                test;

            const hexBody = toHex(body as any);

            const hyperlaneMessage = formatMessage(
                version,
                nonce,
                origin,
                sender,
                destination,
                recipient,
                hexBody,
            );

            expect(
                BigInt((await messageLib.origin(hyperlaneMessage)).toString()),
            ).to.equal(BigInt(origin));
            expect(await messageLib.sender(hyperlaneMessage)).to.equal(sender);
            expect(
                BigInt(
                    (await messageLib.destination(hyperlaneMessage)).toString(),
                ),
            ).to.equal(BigInt(destination));
            expect(await messageLib.recipient(hyperlaneMessage)).to.equal(
                recipient,
            );
            expect(await messageLib.body(hyperlaneMessage)).to.equal(hexBody);
            expect(messageId(hyperlaneMessage)).to.equal(id);
        }
    });
});
