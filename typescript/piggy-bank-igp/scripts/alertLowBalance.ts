import { ethers, BigNumber } from "ethers";
import { PiggyBankIGPAdapter } from "../src/PiggyBankIGP";

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL);
  const contractAddress = process.env.PIGGY_BANK_IGP_ADDRESS!;
  const sponsorAddress = process.env.SPONSOR_ADDRESS!;
  const threshold = BigNumber.from(process.env.LOW_BALANCE_THRESHOLD || ethers.utils.parseEther("0.1"));

  const adapter = new PiggyBankIGPAdapter(contractAddress, provider);
  const balance = await adapter.getSponsorBalance(sponsorAddress);

  if (balance.lt(threshold)) {
    console.error(`[ALERT] Sponsor balance for ${sponsorAddress} is critically low: ${ethers.utils.formatEther(balance)} ETH`);
    console.error(`Please top up immediately!`);
    process.exit(1);
  } else {
    console.log(`[OK] Sponsor balance is sufficient: ${ethers.utils.formatEther(balance)} ETH`);
  }
}

main().catch(console.error);
