// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {Message} from "../../libs/Message.sol";

interface IWormhole {
    struct Signature {
        bytes32 r;
        bytes32 s;
        uint8 v;
        uint8 guardianIndex;
    }
    struct VM {
        uint8 version;
        uint32 timestamp;
        uint32 nonce;
        uint16 emitterChainId;
        bytes32 emitterAddress;
        uint64 sequence;
        uint8 consistencyLevel;
        bytes payload;
        uint32 guardianSetIndex;
        Signature[] signatures;
        bytes32 hash;
    }

    function parseAndVerifyVM(
        bytes calldata encodedVM
    ) external view returns (VM memory vm, bool valid, string memory reason);
}

contract WormholeIsm is IInterchainSecurityModule, OwnableUpgradeable {
    using Message for bytes;

    IWormhole public WORMHOLE;
    uint16 public SOURCE_CHAIN_ID;
    bytes32 public SOURCE_ADDRESS;

    mapping(bytes32 => bool) public validated;

    constructor(address _wormhole) {
        WORMHOLE = IWormhole(_wormhole);
    }

    /**
     * @notice Initializes the hook with specific targets
     */
    function initializeSource(
        uint16 sourceChainId,
        bytes32 sourceAddress
    ) external onlyOwner initializer {
        SOURCE_CHAIN_ID = sourceChainId;
        SOURCE_ADDRESS = sourceAddress;
    }

    /**
     * @notice Returns an enum that represents the type of hook
     */
    function moduleType() external pure returns (uint8) {
        return uint8(IInterchainSecurityModule.Types.WORMHOLE);
    }

    /**
     * @notice Verifies that an encoded VM is validand marks the internal
     * payload as processed. the payload should be the hyperlane message ID.
     * @param encodedVM the wormhole encoded VMM
     */
    function execute(bytes calldata encodedVM) external {
        // parse and verify the Wormhole core message
        (
            IWormhole.VM memory verifiedMessage,
            bool valid,
            string memory reason
        ) = WORMHOLE.parseAndVerifyVM(encodedVM);
        //revert if the message cannot be varified
        require(valid, reason);
        // only accept calls from specific source chain and addresses
        require(
            verifiedMessage.emitterChainId == SOURCE_CHAIN_ID,
            "unexpectd source chain"
        );
        require(
            verifiedMessage.emitterAddress == SOURCE_ADDRESS,
            "unexpectd source address"
        );

        //TODO get hyperlane ID. verify wormhole gmp input.
        bytes32 hyperlaneid = bytes32(verifiedMessage.payload);

        validated[hyperlaneid] = true;
    }

    /**
     * @notice verifies interchain messages processed by Wormhole.
     * @param _message Hyperlane encoded interchain message
     * @return true if the message was verified. false otherwise
     */
    function verify(
        bytes calldata,
        bytes calldata _message
    ) external view returns (bool) {
        return validated[_message.id()];
    }
}
