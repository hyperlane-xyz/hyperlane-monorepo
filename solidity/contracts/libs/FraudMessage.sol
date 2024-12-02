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
    function encode(
        bytes32 signer,
        bytes32 merkleTree,
        bytes32 digest,
        Attribution memory attribution
    ) internal pure returns (bytes memory) {
        return
            abi.encode(
                signer,
                merkleTree,
                digest,
                attribution.fraudType,
                attribution.timestamp
            );
    }

    function decode(
        bytes memory _message
    ) internal pure returns (bytes32, bytes32, bytes32, Attribution memory) {
        return abi.decode(_message, (bytes32, bytes32, bytes32, Attribution));
    }
}
