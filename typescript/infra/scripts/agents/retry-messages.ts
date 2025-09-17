import { spawn } from 'child_process';
import fetch from 'node-fetch';
import yargs from 'yargs';

import { assertCorrectKubeContext } from '../agent-utils.js';
import { getConfigsBasedOnArgs } from '../core-utils.js';

interface RetryOptions {
  environment: string;
  messageId?: string;
  originDomain?: number;
  destinationDomain?: number;
  sender?: string;
  recipient?: string;
  context?: string;
  namespace?: string;
  port?: number;
}

async function retryMessage(options: RetryOptions) {
  const {
    environment,
    messageId,
    originDomain,
    destinationDomain,
    sender,
    recipient,
    context = 'hyperlane',
    namespace,
    port = 9090,
  } = options;

  console.log(`🔄 Starting message retry for environment: ${environment}`);

  // Get environment config and ensure correct kube context
  const { envConfig } = await getConfigsBasedOnArgs({ environment, context });
  await assertCorrectKubeContext(envConfig);

  // Determine namespace - use provided or derive from environment
  const ns = namespace || environment;

  // Determine pod name - use omniscient relayer pattern
  const podName = `omniscient-relayer-hyperlane-agent-relayer-0`;

  console.log(`📡 Setting up port-forward to ${podName} in namespace ${ns}...`);

  // Start port-forward process
  const portForward = spawn('kubectl', [
    'port-forward',
    podName,
    `${port}:9090`,
    '-n',
    ns,
  ]);

  let isConnected = false;
  let retries = 0;
  const maxRetries = 30; // 30 seconds max wait

  // Wait for port-forward to be ready
  await new Promise<void>((resolve, reject) => {
    const checkConnection = async () => {
      try {
        await fetch(`http://localhost:${port}/health`, { timeout: 1000 });
        isConnected = true;
        console.log(`✅ Port-forward established on port ${port}`);
        resolve();
      } catch (error) {
        retries++;
        if (retries >= maxRetries) {
          reject(
            new Error('Port-forward failed to establish after 30 seconds'),
          );
          return;
        }
        // Wait 1 second and try again
        setTimeout(checkConnection, 1000);
      }
    };

    // Start checking after 2 seconds to let kubectl initialize
    setTimeout(checkConnection, 2000);
  });

  try {
    // Prepare request body based on retry method - API expects array of rules
    let requestBody: any[] = [];

    if (messageId) {
      requestBody = [{ message_id: messageId }];
      console.log(`🎯 Triggering retry for specific message: ${messageId}`);
    } else if (originDomain || destinationDomain || sender || recipient) {
      // Use Message whitelist format for domain/sender/recipient filtering
      requestBody = [
        {
          ...(originDomain && { origin_domain: originDomain }),
          ...(destinationDomain && { destination_domain: destinationDomain }),
          ...(sender && { sender }),
          ...(recipient && { recipient }),
        },
      ];

      console.log(`🎯 Triggering retry with filters:`, requestBody[0]);
    } else {
      requestBody = [];
      console.log(`🔄 Triggering retry for all eligible messages`);
    }

    console.log(`📤 Sending retry request to relayer API...`);

    // Make retry request
    const response = await fetch(`http://localhost:${port}/message_retry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const result = await response.json();
    console.log(`✅ Retry request successful:`, result);
    console.log(
      `📊 Messages evaluated: ${result.evaluated}, matched: ${result.matched}`,
    );

    if (result.matched > 0) {
      console.log(
        `🚀 ${result.matched} message(s) moved to front of processing queue`,
      );
    } else {
      console.log(`ℹ️  No messages matched the retry criteria`);
    }
  } catch (error) {
    console.error('❌ Error making retry request:', error);
    throw error;
  } finally {
    // Clean up port-forward
    console.log('🧹 Cleaning up port-forward...');
    portForward.kill('SIGTERM');

    // Give it a moment to clean up gracefully
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function main() {
  const argv = await yargs(process.argv.slice(2))
    .option('environment', {
      alias: 'e',
      describe: 'Deploy environment',
      type: 'string',
      default: 'mainnet3',
    })
    .option('message-id', {
      alias: 'm',
      describe: 'Specific message ID to retry',
      type: 'string',
    })
    .option('origin-domain', {
      alias: 'o',
      describe: 'Origin domain ID to filter messages',
      type: 'number',
    })
    .option('destination-domain', {
      alias: 'd',
      describe: 'Destination domain ID to filter messages',
      type: 'number',
    })
    .option('sender', {
      alias: 's',
      describe: 'Sender address to filter messages',
      type: 'string',
    })
    .option('recipient', {
      alias: 'r',
      describe: 'Recipient address to filter messages',
      type: 'string',
    })
    .option('context', {
      alias: 'c',
      describe: 'Context',
      type: 'string',
      default: 'hyperlane',
    })
    .option('namespace', {
      alias: 'n',
      describe: 'Kubernetes namespace (auto-detected if not provided)',
      type: 'string',
    })
    .option('port', {
      alias: 'p',
      describe: 'Local port for port-forward',
      type: 'number',
      default: 9090,
    })
    .conflicts('message-id', [
      'origin-domain',
      'destination-domain',
      'sender',
      'recipient',
    ])
    .help()
    .alias('h', 'help')
    .example([
      ['$0', 'Retry all eligible messages in mainnet3'],
      ['$0 -m 0xe202b08d...', 'Retry specific message by ID'],
      ['$0 -o 56 -d 1', 'Retry messages from BSC (56) to Ethereum (1)'],
      [
        '$0 -s 0x1234... -r 0x5678...',
        'Retry messages from sender to recipient',
      ],
      ['$0 -e testnet4 -c testnet', 'Retry messages in testnet4 environment'],
    ]).argv;

  // Validate that at least one filter method is provided when using whitelist
  if (
    !argv.messageId &&
    (argv.originDomain ||
      argv.destinationDomain ||
      argv.sender ||
      argv.recipient)
  ) {
    if (
      !argv.originDomain &&
      !argv.destinationDomain &&
      !argv.sender &&
      !argv.recipient
    ) {
      console.error(
        '❌ When using whitelist filtering, at least one filter must be specified',
      );
      process.exit(1);
    }
  }

  try {
    await retryMessage(argv);
  } catch (error) {
    console.error('💥 Message retry failed:', error);
    process.exit(1);
  }
}

main()
  .then(() => {
    console.log('🎉 Message retry completed successfully');
    process.exit(0);
  })
  .catch((err) => {
    console.error('💥 Error in message retry:', err);
    process.exit(1);
  });
