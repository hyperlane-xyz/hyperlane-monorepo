import {expect} from "chai";
import hre from "hardhat";
import {hashMessage} from "viem";

import merkleTestCases from "../../vectors/merkle.json" with {type: "json"};

import {getSigner} from "./signer.js";

describe("Merkle", async () => {
    for (const testCase of merkleTestCases) {
        const {testName, leaves, expectedRoot, proofs} = testCase;

        describe(testName, async () => {
            let merkle: any;

            before(async () => {
                const signer = await getSigner();

                const merkleFactory = await hre.ethers.getContractFactory(
                    "TestMerkle",
                    signer,
                );
                merkle = await merkleFactory.deploy();

                //insert the leaves
                for (const leaf of leaves) {
                    const leafHash = hashMessage(leaf);
                    await merkle.insert(leafHash);
                }
            });

            it("returns the correct leaf count", async () => {
                const leafCount = await merkle.count();
                expect(BigInt(leafCount.toString())).to.equal(
                    BigInt(leaves.length),
                );
            });

            it("produces the proper root", async () => {
                expect(await merkle.root()).to.equal(expectedRoot);
            });

            it("can verify the leaves' proofs", async () => {
                for (const proof of proofs) {
                    const {leaf, path, index} = proof;

                    const proofRoot = await merkle.branchRoot(
                        leaf,
                        path,
                        index,
                    );
                    expect(proofRoot).to.equal(expectedRoot);
                }
            });
        });
    }
});
