import type {
  Address,
  Instruction,
  ProgramDerivedAddress,
  Rpc,
  SolanaRpcApi,
  TransactionSigner,
} from '@solana/kit';

export type SvmInstruction = Instruction;

export type SvmRpc = Rpc<SolanaRpcApi>;

export interface SvmTransaction {
  instructions: SvmInstruction[];
  computeUnits?: number;
  additionalSigners?: TransactionSigner[];
}

export interface SvmReceipt {
  signature: string;
  slot?: bigint;
}

export type AnnotatedSvmTransaction = SvmTransaction & {
  annotation?: string;
};

export interface SvmProgramAddresses {
  mailbox: Address;
  igp: Address;
  multisigIsmMessageId: Address;
  testIsm: Address;
  token: Address;
  tokenCollateral: Address;
  tokenNative: Address;
  validatorAnnounce?: Address;
}

export interface PdaWithBump {
  pda: ProgramDerivedAddress;
  address: Address;
  bump: number;
}
