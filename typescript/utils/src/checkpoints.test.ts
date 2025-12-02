import { expect } from 'chai';

import {
  isCheckpoint,
  isS3Checkpoint,
  isS3CheckpointWithId,
  isValidSignature,
} from './checkpoints.js';
import { Checkpoint, S3Checkpoint, S3CheckpointWithId } from './types.js';

describe('Checkpoints', () => {
  describe('isValidSignature', () => {
    it('should return true for valid string signature', () => {
      const signature = '0x' + 'a'.repeat(130); // Example of a valid hex string
      expect(isValidSignature(signature)).to.be.true;
    });

    it('should return true for valid object signature', () => {
      const signature = {
        r: '0x' + 'a'.repeat(64),
        s: '0x' + 'b'.repeat(64),
        v: 27,
      };
      expect(isValidSignature(signature)).to.be.true;
    });

    it('should return false for invalid signature', () => {
      const signature = {
        r: '0x' + 'a'.repeat(64),
        s: '0x' + 'b'.repeat(64),
        v: 'invalid',
      };
      expect(isValidSignature(signature)).to.be.false;
    });
  });

  describe('isCheckpoint', () => {
    it('should return true for valid checkpoint', () => {
      const checkpoint: Checkpoint = {
        root: '0x' + 'a'.repeat(64),
        index: 1,
        merkle_tree_hook_address: '0x' + 'b'.repeat(40),
        mailbox_domain: 123,
      };
      expect(isCheckpoint(checkpoint)).to.be.true;
    });

    it('should return false for invalid checkpoint', () => {
      const checkpoint = {
        root: 'invalid',
        index: 'invalid',
        merkle_tree_hook_address: 'invalid',
        mailbox_domain: 'invalid',
      };
      expect(isCheckpoint(checkpoint)).to.be.false;
    });
  });

  describe('isS3Checkpoint', () => {
    it('should return true for valid S3Checkpoint', () => {
      const s3Checkpoint: S3Checkpoint = {
        signature: '0x' + 'a'.repeat(130),
        value: {
          root: '0x' + 'a'.repeat(64),
          index: 1,
          merkle_tree_hook_address: '0x' + 'b'.repeat(40),
          mailbox_domain: 123,
        },
      };
      expect(isS3Checkpoint(s3Checkpoint)).to.be.true;
    });

    it('should return false for invalid S3Checkpoint', () => {
      const s3Checkpoint = {
        signature: 'invalid',
        value: {
          root: 'invalid',
          index: 'invalid',
          merkle_tree_hook_address: 'invalid',
          mailbox_domain: 'invalid',
        },
      };
      expect(isS3Checkpoint(s3Checkpoint)).to.be.false;
    });
  });

  describe('isS3CheckpointWithId', () => {
    it('should return true for valid S3CheckpointWithId', () => {
      const s3CheckpointWithId: S3CheckpointWithId = {
        signature: '0x' + 'a'.repeat(130),
        value: {
          checkpoint: {
            root: '0x' + 'a'.repeat(64),
            index: 1,
            merkle_tree_hook_address: '0x' + 'b'.repeat(40),
            mailbox_domain: 123,
          },
          message_id: '0x' + 'c'.repeat(64),
        },
      };
      expect(isS3CheckpointWithId(s3CheckpointWithId)).to.be.true;
    });

    it('should return false for invalid S3CheckpointWithId', () => {
      const s3CheckpointWithId = {
        signature: 'invalid',
        value: {
          checkpoint: {
            root: 'invalid',
            index: 'invalid',
            merkle_tree_hook_address: 'invalid',
            mailbox_domain: 'invalid',
          },
          message_id: 'invalid',
        },
      };
      expect(isS3CheckpointWithId(s3CheckpointWithId)).to.be.false;
    });
  });
});
