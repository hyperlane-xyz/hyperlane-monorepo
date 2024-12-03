// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/*@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
     @@@@@  HYPERLANE  @@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
@@@@@@@@@       @@@@@@@@*/

enum FraudType {
    Whitelist,
    Premature,
    MessageId,
    Root
}

struct Attribution {
    FraudType fraudType;
    // for comparison with staking epoch
    uint48 timestamp;
}

library FraudMessage {
    uint8 public constant SIGNER_OFFSET = 0;
    uint8 public constant MERKLE_TREE_OFFSET = 32;
    uint8 public constant DIGEST_OFFSET = 64;
    uint8 public constant FRAUD_TYPE_OFFSET = 96;
    uint8 public constant TIMESTAMP_OFFSET = 97;
    uint8 public constant MESSAGE_LENGTH = 103;

    function encode(
        bytes32 signer,
        bytes32 merkleTree,
        bytes32 digest,
        Attribution memory attribution
    ) internal pure returns (bytes memory) {
        return
            abi.encodePacked(
                signer,
                merkleTree,
                digest,
                uint8(attribution.fraudType),
                attribution.timestamp
            );
    }

    function decode(
        bytes calldata _message
    ) internal pure returns (bytes32, bytes32, bytes32, Attribution memory) {
        require(_message.length == MESSAGE_LENGTH, "Invalid message length");

        bytes32 signer = bytes32(_message[SIGNER_OFFSET:MERKLE_TREE_OFFSET]);
        bytes32 merkleTree = bytes32(
            _message[MERKLE_TREE_OFFSET:DIGEST_OFFSET]
        );
        bytes32 digest = bytes32(_message[DIGEST_OFFSET:FRAUD_TYPE_OFFSET]);
        FraudType fraudType = FraudType(uint8(_message[FRAUD_TYPE_OFFSET]));
        uint48 timestamp = uint48(
            bytes6(_message[TIMESTAMP_OFFSET:MESSAGE_LENGTH])
        );

        return (signer, merkleTree, digest, Attribution(fraudType, timestamp));
    }
}
