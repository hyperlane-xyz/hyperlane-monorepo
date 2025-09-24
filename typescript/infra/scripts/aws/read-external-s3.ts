import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import chalk from 'chalk';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';

import { rootLogger } from '@hyperlane-xyz/utils';

import { fetchGCPSecret } from '../../src/utils/gcloud.js';
import { getArgs } from '../agent-utils.js';
import { stat } from 'fs/promises';

const logger = rootLogger.child({ module: 'read-external-s3' });

interface ExternalS3Config {
  bucketName: string;
  filePath: string;
  localFileName: string;
  accessKeySecretName: string;
  secretKeySecretName: string;
  region: string;
}

class ExternalS3Reader {
  private s3Client: S3Client | undefined;
  private stsClient: STSClient | undefined;
  private config: ExternalS3Config;
  private credentials:
    | { accessKeyId: string; secretAccessKey: string }
    | undefined;

  constructor(config: ExternalS3Config) {
    this.config = config;
  }

  private async getCredentials(): Promise<{
    accessKeyId: string;
    secretAccessKey: string;
  }> {
    if (this.credentials) {
      return this.credentials;
    }

    logger.info('🔑 Fetching AWS credentials from GCP secrets...');

    // Fetch AWS credentials from GCP Secret Manager (same pattern as reclaim-vanguard-funds.sh)
    const accessKeyId = (await fetchGCPSecret(
      this.config.accessKeySecretName,
      false,
    )) as string;
    const secretAccessKey = (await fetchGCPSecret(
      this.config.secretKeySecretName,
      false,
    )) as string;

    if (!accessKeyId || !secretAccessKey) {
      throw new Error(
        `Failed to fetch AWS credentials from GCP secrets:
   - ${this.config.accessKeySecretName}
   - ${this.config.secretKeySecretName}`,
      );
    }

    logger.info('✅ Successfully fetched AWS credentials from GCP secrets');

    this.credentials = { accessKeyId, secretAccessKey };
    return this.credentials;
  }

  private async getS3Client(): Promise<S3Client> {
    if (this.s3Client) {
      return this.s3Client;
    }

    const credentials = await this.getCredentials();

    this.s3Client = new S3Client({
      region: this.config.region,
      credentials,
    });

    return this.s3Client;
  }

  private async getSTSClient(): Promise<STSClient> {
    if (this.stsClient) {
      return this.stsClient;
    }

    const credentials = await this.getCredentials();

    this.stsClient = new STSClient({
      region: this.config.region,
      credentials,
    });

    return this.stsClient;
  }

  async verifyIdentity(): Promise<void> {
    logger.info('🔍 Verifying AWS identity...');

    try {
      const stsClient = await this.getSTSClient();
      const command = new GetCallerIdentityCommand({});
      const response = await stsClient.send(command);

      logger.info('📋 AWS Identity Details:');
      logger.info(`   Account ID: ${response.Account}`);
      logger.info(`   User ARN: ${response.Arn}`);
      logger.info(`   User ID: ${response.UserId}`);

      // Verify it's the expected user
      const expectedArn =
        'arn:aws:iam::625457692493:user/everclear-fee-param-reader';
      if (response.Arn === expectedArn) {
        logger.info(
          chalk.green('✅ Identity verified: Using correct IAM user'),
        );
      } else {
        logger.warn(chalk.yellow('⚠️  Identity mismatch:'));
        logger.warn(`   Expected: ${expectedArn}`);
        logger.warn(`   Actual:   ${response.Arn}`);
      }
    } catch (error) {
      logger.error(chalk.red('❌ Failed to verify identity:'), error);
      throw error;
    }
  }

  async downloadFile(): Promise<void> {
    logger.info('📥 Downloading from external S3 bucket...');
    logger.info(`   Bucket: ${this.config.bucketName}`);
    logger.info(`   Remote path: ${this.config.filePath}`);
    logger.info(`   Local path: ${this.config.localFileName}`);

    try {
      const s3Client = await this.getS3Client();

      const command = new GetObjectCommand({
        Bucket: this.config.bucketName,
        Key: this.config.filePath,
      });

      const response = await s3Client.send(command);

      if (!response.Body) {
        throw new Error('No data received from S3');
      }

      // Create a write stream for the local file
      const writeStream = createWriteStream(this.config.localFileName);

      // Pipeline the S3 response body to the file
      await pipeline(response.Body as NodeJS.ReadableStream, writeStream);

      logger.info(
        chalk.green(`✅ Successfully downloaded: ${this.config.localFileName}`),
      );

      // Show file info
      await this.showFileInfo();
    } catch (error) {
      logger.error(
        chalk.red('❌ Error: Failed to download file from S3'),
        error,
      );
      logger.error('   Check that:');
      logger.error(
        `   - The bucket name is correct: ${this.config.bucketName}`,
      );
      logger.error(`   - The file path exists: ${this.config.filePath}`);
      logger.error('   - The IAM user has the necessary permissions');
      throw error;
    }
  }

  private async showFileInfo(): Promise<void> {
    try {
      const stats = await stat(this.config.localFileName);
      logger.info('📊 File info:');
      logger.info(`   Size: ${this.formatBytes(stats.size)}`);

      // If it's a JSON file, validate and show preview
      if (this.config.localFileName.endsWith('.json')) {
        await this.validateAndPreviewJson();
      }
    } catch (error) {
      logger.warn('Could not get file info:', error);
    }
  }

  private async validateAndPreviewJson(): Promise<void> {
    try {
      const fs = await import('fs/promises');
      const content = await fs.readFile(this.config.localFileName, 'utf8');

      // Validate JSON
      const parsed = JSON.parse(content);
      logger.info('✅ Valid JSON file');

      // Show preview (first 10 lines)
      logger.info('📄 Preview:');
      const lines = JSON.stringify(parsed, null, 2).split('\n');
      const preview = lines.slice(0, 10).join('\n');
      console.log(preview);

      if (lines.length > 10) {
        logger.info(chalk.gray(`... (${lines.length - 10} more lines)`));
      }
    } catch (error) {
      logger.warn('⚠️  Invalid JSON file or could not preview:', error);
    }
  }

  async listFiles(prefix?: string): Promise<void> {
    logger.info('📁 Listing files in external S3 bucket...');
    logger.info(`   Bucket: ${this.config.bucketName}`);
    logger.info(`   Prefix: ${prefix || '(root)'}`);

    try {
      const s3Client = await this.getS3Client();

      const command = new ListObjectsV2Command({
        Bucket: this.config.bucketName,
        Prefix: prefix,
      });

      const response = await s3Client.send(command);

      if (!response.Contents || response.Contents.length === 0) {
        logger.info('📂 No files found');
        return;
      }

      logger.info(`📂 Found ${response.Contents.length} files:`);
      response.Contents.forEach((object) => {
        const size = this.formatBytes(object.Size || 0);
        const modified =
          object.LastModified?.toISOString().split('T')[0] || 'Unknown';
        logger.info(`   ${object.Key} (${size}, ${modified})`);
      });

      if (response.IsTruncated) {
        logger.info(
          '   ... (more files available, use pagination for complete list)',
        );
      }
    } catch (error) {
      logger.error(chalk.red('❌ Error listing files:'), error);
      throw error;
    }
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}

async function main() {
  const { bucketName, filePath, localFileName, region, list, prefix, verify } =
    await getArgs()
      .option('bucketName', {
        type: 'string',
        description: 'Name of the external S3 bucket',
        demandOption: true,
      })
      .option('filePath', {
        type: 'string',
        description:
          'Path to the file in the S3 bucket (required for download)',
      })
      .option('localFileName', {
        type: 'string',
        description: 'Local filename for the downloaded file',
      })
      .option('region', {
        type: 'string',
        description: 'AWS region',
        default: 'us-east-1',
      })
      .option('list', {
        type: 'boolean',
        description: 'List files in the bucket instead of downloading',
        default: false,
      })
      .option('prefix', {
        type: 'string',
        description: 'Prefix to filter files when listing',
      })
      .option('verify', {
        type: 'boolean',
        description: 'Verify AWS identity before performing operations',
        default: false,
      }).argv;

  // Validate arguments
  if (!list && !filePath) {
    logger.error(
      chalk.red('❌ Error: --filePath is required when not listing files'),
    );
    process.exit(1);
  }

  const config: ExternalS3Config = {
    bucketName,
    filePath: filePath || '',
    localFileName:
      localFileName || (filePath ? filePath.split('/').pop()! : ''),
    accessKeySecretName: 'everclear-fee-param-reader-aws-access-key-id',
    secretKeySecretName: 'everclear-fee-param-reader-aws-secret-access-key',
    region,
  };

  logger.info(chalk.blue.bold('🚀 External S3 File Reader'));
  logger.info('=========================');

  try {
    const reader = new ExternalS3Reader(config);

    // Always verify identity when requested, or when there's an access issue
    if (verify) {
      await reader.verifyIdentity();
      logger.info('');
    }

    if (list) {
      await reader.listFiles(prefix);
    } else {
      await reader.downloadFile();
      logger.info('');
      logger.info(chalk.green.bold('🎉 Download completed successfully!'));
      logger.info(`   File saved as: ${config.localFileName}`);
    }
  } catch (error) {
    logger.error(chalk.red.bold('💥 Operation failed!'), error);

    // Suggest identity verification on access errors
    if (
      (error as any)?.name === 'AccessDenied' ||
      (error as any)?.Code === 'AccessDenied'
    ) {
      logger.info('');
      logger.info(
        chalk.yellow('💡 Suggestion: Verify your AWS identity with:'),
      );
      logger.info(
        chalk.yellow(
          '   yarn tsx scripts/aws/read-external-s3.ts --verify --bucketName <bucket>',
        ),
      );
    }

    process.exit(1);
  }
}

main().catch((error) => {
  logger.error('Unhandled error:', error);
  process.exit(1);
});
