Let's port our Rust deployment CLI into TypeScript.

- original deployment CLI is in @rust/sealevel/client
- @rust/sealevel/client/src/main.rs is the entry point

- all new TypeScript code goes into @typescript/svm-provider
- the original CLI relies on the Solana CLI and the spl-token CLI to deploy and manage programs and tokens
- for our TypeScript port we should reimplement this part using the TypeScript clients for LoaderV3 and Token2022 programs
  (and maybe others as necessary, I list initial dependencies below)
- our own Solana programs now have IDLs generated, and we have TypeScript clients for them in @typescript/svm-provider/src/generated
- for now, assume that our program binaries are available in @rust/sealevel/target/release (later we'll package them)

- the port should implement the Artifact API interfaces (artifact readers and writers)
- do not reproduce the original CLI logic because we will rely on our existing TypeScript CLI to call to the Artifact API
- we currently have ISM and hook artifacts implemented for radix/cosmos/aleo (in radix-sdk, cosmos-sdk, aleo-sdk)
- thus we should start with porting the ISM and hook artifacts for Solana
- then we can try deploying tokens which would require the Token2022 client (instead of the spl-token CLI)

Solana system program dependencies:

- @solana-program/loader-v3 (we have source in ~/src/solana/loader-v3)
- @solana-program/token-2022 (we have source in ~/src/solana/token-2022)

Success criteria:

- end-to-end tests like the ones we have for Radix/Cosmos/Aleo that are based on testcontainers and spin up a test node in before/after
