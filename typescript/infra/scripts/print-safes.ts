import { safes } from '../config/environments/mainnet3/owners';

async function main() {
  console.log(JSON.stringify(safes, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
