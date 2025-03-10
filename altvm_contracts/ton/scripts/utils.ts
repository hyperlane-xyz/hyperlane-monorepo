import { NetworkProvider } from '@ton/blueprint';
import { Address } from '@ton/core';
import * as fs from 'fs';
import * as path from 'path';

import { JettonMinterContract } from '../wrappers/JettonMinter';
import { TokenRouter } from '../wrappers/TokenRouter';

import { Route } from './types';

export function loadDeployedContracts(domain: number) {
  const filePath = path.join(__dirname, `../deployedContracts_${domain}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Deployed contracts file not found: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}
