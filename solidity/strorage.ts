import { execSync } from 'child_process';

// Checkout brand

async function checkLayout(contractName: string): Promise<void> {
  console.log('foo');
}

// Main execution
async function main() {
  try {
    await checkLayout('test');
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

main();
