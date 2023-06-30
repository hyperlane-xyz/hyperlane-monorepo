import fs from 'fs';
import path from 'path';

interface Config {
  [network: string]: {
    [contract: string]: string;
  };
}

// running from tyepscript/infra
export async function getMainnetAddress(
  network: string,
  key: string,
): Promise<string | undefined> {
  const filePath = path.join(__dirname, '../consts/environments/mainnet.json');
  const rawData = await fs.promises.readFile(filePath, 'utf-8');
  const config: Config = JSON.parse(rawData);
  return config[network]?.[key];
}

export async function getHookAddress(
  network: string,
  key: string,
): Promise<string | undefined> {
  const filePath = path.join(
    __dirname,
    '../config/environments/test/hook/addresses.json',
  );
  const rawData = await fs.promises.readFile(filePath, 'utf-8');
  const config: Config = JSON.parse(rawData);
  return config[network]?.[key];
}

export async function changeTestAddress(
  chain: string,
  key: string,
  newAddress: string,
): Promise<void> {
  const filePath = path.join(__dirname, '../consts/environments/test.json');

  // Read the existing file
  const rawData = await fs.promises.readFile(filePath, 'utf-8');
  const config: Config = JSON.parse(rawData);

  // Change the address for the specified chain
  if (config[chain]) {
    config[chain][key] = newAddress;

    console.log('entry found!!');

    // Write the updated data back to the file
    const updatedData = JSON.stringify(config, null, 2); // The second and third parameters format the JSON data with 2 spaces indentation
    await fs.promises.writeFile(filePath, updatedData, 'utf-8');
  } else {
    throw new Error(`Chain ${chain} not found in config.`);
  }
}
