// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.19;

import {CoreBridgeSignature, CoreBridgeVM, ICoreBridge} from "../interfaces/wormhole/ICoreBridge.sol";

/**
 * @title MockWormholeCore
 * @notice Deterministic stand-in for the Wormhole Core contract.
 * @dev It reproduces Core's publication accounting, fee, sequence, and
 * verification *interface*, not Guardian cryptography. Real signature checking
 * belongs in fork tests against the official deployments.
 *
 * A mock VAA is `abi.encode(MockVaa)`. `parseAndVerifyVM` reverts on input that
 * is not a valid encoding, matching Core's behaviour for malformed input, and
 * returns `valid == false` when the referenced Guardian set is not live.
 */
contract MockWormholeCore is ICoreBridge {
    /// @dev Wire form of a mock VAA. Kept ABI-encodable so tests and offchain
    /// fixtures can build one with a standard ABI coder.
    struct MockVaa {
        uint16 emitterChainId;
        bytes32 emitterAddress;
        uint64 sequence;
        uint32 nonce;
        uint8 consistencyLevel;
        uint32 guardianSetIndex;
        bytes payload;
    }

    event LogMessagePublished(
        address indexed sender,
        uint64 sequence,
        uint32 nonce,
        bytes payload,
        uint8 consistencyLevel
    );

    uint16 public immutable chainId;
    uint256 public evmChainId;

    uint256 public messageFee;
    mapping(address emitter => uint64 sequence) public nextSequence;
    mapping(uint32 guardianSetIndex => bool live) public liveGuardianSets;

    /// @dev Test override forcing `publishMessage` to return a sequence other
    /// than the one `nextSequence` predicted.
    bool public overrideSequence;
    uint64 public overriddenSequence;

    constructor(uint16 chainId_, uint256 messageFee_) {
        chainId = chainId_;
        evmChainId = block.chainid;
        messageFee = messageFee_;
        liveGuardianSets[0] = true;
    }

    // ============ Test configuration ============

    function setMessageFee(uint256 messageFee_) external {
        messageFee = messageFee_;
    }

    function setEvmChainId(uint256 evmChainId_) external {
        evmChainId = evmChainId_;
    }

    function setGuardianSetLive(uint32 index, bool live) external {
        liveGuardianSets[index] = live;
    }

    function setSequenceOverride(bool enabled, uint64 sequence) external {
        overrideSequence = enabled;
        overriddenSequence = sequence;
    }

    function encodeVaa(
        MockVaa memory vaa
    ) external pure returns (bytes memory) {
        return abi.encode(vaa);
    }

    // ============ ICoreBridge ============

    function publishMessage(
        uint32 nonce,
        bytes memory payload,
        uint8 consistencyLevel
    ) external payable returns (uint64 sequence) {
        require(msg.value == messageFee, "MockWormholeCore: invalid fee");
        sequence = nextSequence[msg.sender];
        nextSequence[msg.sender] = sequence + 1;
        if (overrideSequence) sequence = overriddenSequence;
        emit LogMessagePublished(
            msg.sender,
            sequence,
            nonce,
            payload,
            consistencyLevel
        );
    }

    function parseAndVerifyVM(
        bytes calldata encodedVaa
    )
        external
        view
        returns (CoreBridgeVM memory vm_, bool valid, string memory reason)
    {
        // Unit tests use the convenient ABI tuple returned by `encodeVaa`.
        // Integration tests use the real v1 VAA wire shape so the offchain
        // fetcher and matcher exercise production parsing before this mock.
        MockVaa memory vaa = encodedVaa.length > 0 && encodedVaa[0] == 0x01
            ? _decodeWireVaa(encodedVaa)
            : abi.decode(encodedVaa, (MockVaa));

        vm_.version = 1;
        vm_.timestamp = uint32(block.timestamp);
        vm_.nonce = vaa.nonce;
        vm_.emitterChainId = vaa.emitterChainId;
        vm_.emitterAddress = vaa.emitterAddress;
        vm_.sequence = vaa.sequence;
        vm_.consistencyLevel = vaa.consistencyLevel;
        vm_.payload = vaa.payload;
        vm_.guardianSetIndex = vaa.guardianSetIndex;
        vm_.signatures = new CoreBridgeSignature[](0);
        // Core's digest covers the VAA body only, never the signatures.
        vm_.hash = keccak256(
            abi.encode(
                vaa.emitterChainId,
                vaa.emitterAddress,
                vaa.sequence,
                vaa.nonce,
                vaa.consistencyLevel,
                vaa.payload
            )
        );

        if (!liveGuardianSets[vaa.guardianSetIndex]) {
            return (vm_, false, "guardian set has expired");
        }
        return (vm_, true, "");
    }

    function _decodeWireVaa(
        bytes calldata encodedVaa
    ) private pure returns (MockVaa memory vaa) {
        require(encodedVaa.length >= 6, "MockWormholeCore: short header");

        uint256 bodyOffset = 6 + uint8(encodedVaa[5]) * 66;
        require(
            encodedVaa.length >= bodyOffset + 51,
            "MockWormholeCore: short body"
        );

        uint256 offset;
        assembly {
            offset := encodedVaa.offset
        }
        assembly {
            mstore(vaa, shr(240, calldataload(add(offset, add(bodyOffset, 8)))))
            mstore(
                add(vaa, 0x20),
                calldataload(add(offset, add(bodyOffset, 10)))
            )
            mstore(
                add(vaa, 0x40),
                shr(192, calldataload(add(offset, add(bodyOffset, 42))))
            )
            mstore(
                add(vaa, 0x60),
                shr(224, calldataload(add(offset, add(bodyOffset, 4))))
            )
            mstore(
                add(vaa, 0x80),
                shr(248, calldataload(add(offset, add(bodyOffset, 50))))
            )
            mstore(add(vaa, 0xa0), shr(224, calldataload(add(offset, 1))))
        }
        vaa.payload = encodedVaa[bodyOffset + 51:];
    }
}
