import { getArgs, getEnvironmentConfig } from './utils';

async function main() {
  const args = await getArgs().argv;

  const environmentConfig = getEnvironmentConfig(args.environment);

  console.log(JSON.stringify(environmentConfig.chainMetadataConfigs, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
