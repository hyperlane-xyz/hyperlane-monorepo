// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {console} from "forge-std/console.sol";

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
        address signer,
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
    ) internal view returns (address, bytes32, bytes32, Attribution memory) {
        require(_message.length == 91, "Invalid message length");
        console.logBytes(_message);

        address signer = address(uint160(uint256(bytes32(_message[0:20]))));
        bytes32 merkleTree = bytes32(_message[20:52]);
        bytes32 digest = bytes32(_message[52:84]);
        FraudType fraudType = FraudType(uint8(_message[84]));
        console.log("fraudType", uint8(fraudType));
        uint48 timestamp = uint48(bytes6(_message[85:91]));
        console.log("timestamp", timestamp);

        return (signer, merkleTree, digest, Attribution(fraudType, timestamp));
    }
}
