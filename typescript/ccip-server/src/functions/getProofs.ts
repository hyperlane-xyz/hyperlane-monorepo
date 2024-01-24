import axios from 'axios';
import { utils } from 'ethers';

const RPC_ADDRESS = 'https://docs-demo.quiknode.pro/'; // TODO parameterize this

type ProofResultStorageProof = {
  key: string;
  proof: Array<string>;
  value: string;
};

type ProofResult = {
  accountProof: Array<string>;
  storageProof: Array<ProofResultStorageProof>;
  address: string;
  balance: string;
  codeHash: string;
  nonce: string;
  storageHash: string;
};
type Proof = {
  jsonrpc: string;
  id: number;
  result: ProofResult;
};

class SuccinctProver {
  // Gets Succinct proof, updates LightClient, returns account and storage proof
  async getProofs(address: string, storageKeys: string[], block: string): Promise<string> {
    // calls Succinct endpoint to get ZK proofs, then call LightClient.step

    // calls the RPC endpoint to get the proofs for a given address
    const { result } = await this.ethGetProof(address, storageKeys, block);

    // Abi encode the proofs
    return utils.defaultAbiCoder.encode(['string[]', 'string[]'], [result.accountProof, result.storageProof]);
  }

  async ethGetProof(address: string, storageKeys: string[], block = 'latest'): Promise<Proof> {
    const { data } = await axios.post(RPC_ADDRESS, {
      method: 'eth_getProof',
      params: [address, storageKeys, block],
      id: 1,
      jsonrpc: '2.0',
    });

    return data;
  }
}

export { SuccinctProver };
