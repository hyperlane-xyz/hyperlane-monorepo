// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.22;

// Taken from https://github.com/everclearorg/monorepo/blob/7651d2aa1d4909b35b5cb0829dea47eee1c2595a/packages/contracts/src/interfaces/intent/IFeeAdapter.sol#L1
interface IEverclear {
    /**
     * @notice The structure of an intent
     * @param initiator The address of the intent initiator
     * @param receiver The address of the intent receiver
     * @param inputAsset The address of the intent asset on origin
     * @param outputAsset The address of the intent asset on destination
     * @param maxFee The maximum fee that can be taken by solvers
     * @param origin The origin chain of the intent
     * @param destinations The possible destination chains of the intent
     * @param nonce The nonce of the intent
     * @param timestamp The timestamp of the intent
     * @param ttl The time to live of the intent
     * @param amount The amount of the intent asset normalized to 18 decimals
     * @param data The data of the intent
     */
    struct Intent {
        bytes32 initiator;
        bytes32 receiver;
        bytes32 inputAsset;
        bytes32 outputAsset;
        uint24 maxFee;
        uint32 origin;
        uint64 nonce;
        uint48 timestamp;
        uint48 ttl;
        uint256 amount;
        uint32[] destinations;
        bytes data;
    }
}
interface IEverclearAdapter {
    struct FeeParams {
        uint256 fee;
        uint256 deadline;
        bytes sig;
    }

    /**
     * @notice Creates a new intent with fees
     * @param _destinations Array of destination domains, preference ordered
     * @param _receiver Address of the receiver on the destination chain
     * @param _inputAsset Address of the input asset
     * @param _outputAsset Address of the output asset
     * @param _amount Amount of input asset to use for the intent
     * @param _maxFee Maximum fee percentage allowed for the intent
     * @param _ttl Time-to-live for the intent in seconds
     * @param _data Additional data for the intent
     * @param _feeParams Fee parameters including fee amount, deadline, and signature
     * @return _intentId The ID of the created intent
     * @return _intent The created intent object
     */
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
    ) external payable returns (bytes32, IEverclear.Intent memory);
}
