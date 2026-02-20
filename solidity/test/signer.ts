import hre from "hardhat";

type EvmSigner = Awaited<ReturnType<typeof hre.ethers.getSigners>>[number];

export async function getSigners(): Promise<EvmSigner[]> {
    // @ts-ignore Hardhat type overrides from @nomiclabs/hardhat-ethers don't work
    return hre.ethers.getSigners();
}

export async function getSigner(): Promise<EvmSigner> {
    const [signer] = await getSigners();
    return signer;
}
