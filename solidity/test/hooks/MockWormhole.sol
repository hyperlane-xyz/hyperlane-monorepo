// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {IWormhole} from "../../contracts/interfaces/IWormhole.sol";

/**
 * @notice Minimal mock of the Wormhole Core Bridge for unit tests.
 * @dev `publishMessage` records its arguments. `parseAndVerifyVM` decodes the
 * supplied bytes as an abi-encoded `IWormhole.VM` and returns it together with
 * a configurable validity flag, so tests can exercise the ISM without a real
 * guardian set.
 */
contract MockWormhole is IWormhole {
    uint256 public immutable messageFeeValue;
    uint16 public immutable chainIdValue;

    uint64 public sequence;
    uint32 public lastNonce;
    bytes public lastPayload;
    uint8 public lastConsistencyLevel;
    uint256 public lastValue;

    bool public vmValid = true;
    string public vmReason = "";

    constructor(uint256 _messageFee, uint16 _chainId) {
        messageFeeValue = _messageFee;
        chainIdValue = _chainId;
    }

    function setVmValid(bool _valid, string memory _reason) external {
        vmValid = _valid;
        vmReason = _reason;
    }

    function publishMessage(
        uint32 _nonce,
        bytes memory _payload,
        uint8 _consistencyLevel
    ) external payable override returns (uint64) {
        lastNonce = _nonce;
        lastPayload = _payload;
        lastConsistencyLevel = _consistencyLevel;
        lastValue = msg.value;
        return sequence++;
    }

    function parseAndVerifyVM(
        bytes calldata _encodedVM
    ) external view override returns (VM memory vm, bool valid, string memory) {
        vm = abi.decode(_encodedVM, (VM));
        return (vm, vmValid, vmReason);
    }

    function messageFee() external view override returns (uint256) {
        return messageFeeValue;
    }

    function chainId() external view override returns (uint16) {
        return chainIdValue;
    }
}
