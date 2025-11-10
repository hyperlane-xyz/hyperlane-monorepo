// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.22;

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

import {IEverclearAdapter, IEverclear, IEverclearSpoke} from "../../contracts/interfaces/IEverclearAdapter.sol";

/**
 * @notice Mock implementation of IEverclearAdapter for testing
 */
contract MockEverclearAdapter is IEverclearAdapter {
    uint256 public constant INTENT_FEE = 1000; // 0.001 ETH
    bool public shouldRevert = false;
    bytes32 public lastIntentId;
    IEverclear.Intent public lastIntent;

    // Track calls for verification
    uint256 public newIntentCallCount;
    uint32[] public lastDestinations;
    bytes32 public lastReceiver;
    address public lastInputAsset;
    bytes32 public lastOutputAsset;
    uint256 public lastAmount;
    uint24 public lastMaxFee;
    uint48 public lastTtl;
    bytes public lastData;
    FeeParams public lastFeeParams;

    function setRevert(bool _shouldRevert) external {
        shouldRevert = _shouldRevert;
    }

    function newIntent(
        uint32[] memory _destinations,
        bytes32 _receiver,
        address _inputAsset,
        bytes32 _outputAsset,
        uint256 _amount,
        uint24 _maxFee,
        uint48 _ttl,
        bytes calldata _data,
        FeeParams calldata _feeParams
    ) external payable override returns (bytes32, IEverclear.Intent memory) {
        if (shouldRevert) {
            revert("MockEverclearAdapter: reverted");
        }

        // Store call data for verification
        newIntentCallCount++;
        lastDestinations = _destinations;
        lastReceiver = _receiver;
        lastInputAsset = _inputAsset;
        lastOutputAsset = _outputAsset;
        lastAmount = _amount;
        lastMaxFee = _maxFee;
        lastTtl = _ttl;
        lastData = _data;
        lastFeeParams = _feeParams;

        // Generate mock intent ID
        lastIntentId = keccak256(
            abi.encodePacked(block.timestamp, _receiver, _amount)
        );

        // Create mock intent
        lastIntent = IEverclear.Intent({
            initiator: bytes32(uint256(uint160(msg.sender))),
            receiver: _receiver,
            inputAsset: bytes32(uint256(uint160(_inputAsset))),
            outputAsset: _outputAsset,
            maxFee: _maxFee,
            origin: uint32(block.chainid),
            destinations: _destinations,
            nonce: uint64(newIntentCallCount),
            timestamp: uint48(block.timestamp),
            ttl: _ttl,
            amount: _amount,
            data: _data
        });

        return (lastIntentId, lastIntent);
    }

    function feeSigner() external view returns (address) {
        return address(0x222);
    }

    function owner() external view returns (address) {
        return address(0x1);
    }

    function updateFeeSigner(address _feeSigner) external {
        // Do nothing
    }

    function spoke() external view returns (IEverclearSpoke) {
        return IEverclearSpoke(address(0x333));
    }
}
