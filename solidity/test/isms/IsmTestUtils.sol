// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;
import {Message} from "../../contracts/libs/Message.sol";
import {IInterchainSecurityModule} from "../../contracts/interfaces/IInterchainSecurityModule.sol";

library MessageUtils {
    function build(uint32 origin) internal pure returns (bytes memory) {
        bytes memory body = "";
        return formatMessage(0, 0, origin, bytes32(0), 0, bytes32(0), body);
    }

    function formatMessage(
        uint8 _version,
        uint32 _nonce,
        uint32 _originDomain,
        bytes32 _sender,
        uint32 _destinationDomain,
        bytes32 _recipient,
        bytes memory _messageBody
    ) private pure returns (bytes memory) {
        return
            abi.encodePacked(
                _version,
                _nonce,
                _originDomain,
                _sender,
                _destinationDomain,
                _recipient,
                _messageBody
            );
    }
}

contract TestIsm is IInterchainSecurityModule {
    bytes public requiredMetadata;

    function moduleType() external override virtual view returns (uint8) {
        return uint8(IInterchainSecurityModule.Types.NULL);
    }

    constructor(bytes memory _requiredMetadata) {
        setRequiredMetadata(_requiredMetadata);
    }

    function setRequiredMetadata(bytes memory _requiredMetadata) public {
        requiredMetadata = _requiredMetadata;
    }

    function verify(bytes calldata _metadata, bytes calldata)
        external
        view
        returns (bool)
    {
        return keccak256(_metadata) == keccak256(requiredMetadata);
    }
}

library MOfNTestUtils {
    function choose(
        uint8 m,
        uint256[] memory choices,
        bytes32 seed
    ) internal pure returns (uint256[] memory) {
        uint256 bitmask = _bitmask(m, uint8(choices.length), seed);
        uint256[] memory ret = new uint256[](m);
        uint256 j = 0;
        for (uint256 i = 0; i < choices.length; i++) {
            bool chosen = (bitmask & (1 << i)) > 0;
            if (chosen) {
                ret[j] = choices[i];
                j += 1;
            }
        }
        return ret;
    }

    function choose(
        uint8 m,
        address[] memory choices,
        bytes32 seed
    ) internal pure returns (address[] memory) {
        uint256 bitmask = _bitmask(m, uint8(choices.length), seed);
        address[] memory ret = new address[](m);
        uint256 j = 0;
        for (uint256 i = 0; i < choices.length; i++) {
            bool chosen = (bitmask & (1 << i)) > 0;
            if (chosen) {
                ret[j] = choices[i];
                j += 1;
            }
        }
        return ret;
    }

    function _bitmask(
        uint8 m,
        uint8 n,
        bytes32 seed
    ) private pure returns (uint256) {
        uint8 chosen = 0;
        uint256 bitmask = 0;
        bytes32 randomness = seed;
        while (chosen < m) {
            randomness = keccak256(abi.encodePacked(randomness));
            uint256 choice = (1 << (uint256(randomness) % n));
            if ((bitmask & choice) == 0) {
                bitmask = bitmask | choice;
                chosen += 1;
            }
        }
        return bitmask;
    }
}
