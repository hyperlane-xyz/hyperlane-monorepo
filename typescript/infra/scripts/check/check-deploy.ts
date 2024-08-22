import { check } from './check-utils.js';

async function main() {
  await check();
}

main()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
