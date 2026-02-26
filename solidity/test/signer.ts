import hre from "hardhat";

export type EvmSigner = Awaited<
    ReturnType<typeof hre.viem.getWalletClients>
>[number];

export async function getSigners(): Promise<EvmSigner[]> {
    return hre.viem.getWalletClients();
}

export async function getSigner(): Promise<EvmSigner> {
    const [signer] = await getSigners();
    if (!signer) {
        throw new Error("No Hardhat viem wallet client available");
    }
    return signer;
}
