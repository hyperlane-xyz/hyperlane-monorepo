import type {SignerWithAddress} from "@nomiclabs/hardhat-ethers/signers";
import hre from "hardhat";

export async function getSigners(): Promise<SignerWithAddress[]> {
    // @ts-ignore Hardhat type overrides from @nomiclabs/hardhat-ethers don't work
    return hre.ethers.getSigners();
}

export async function getSigner(): Promise<SignerWithAddress> {
    const [signer] = await getSigners();
    return signer;
}
