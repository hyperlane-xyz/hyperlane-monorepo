// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.22;

import {ITokenBridge, Quote} from "contracts/interfaces/ITokenBridge.sol";
import {HypERC20Collateral} from "contracts/token/HypERC20Collateral.sol";
import {IEverclearAdapter} from "contracts/interfaces/IEverclearAdapter.sol";

contract EverclearTokenBridge is HypERC20Collateral {
    /// @notice The output asset for a given destination.
    /// @dev Everclear needs to know the output asset address to create intents.
    mapping(uint32 destination => bytes32 outputAsset) public outputAssets;

    /// @notice Fee parameters for the bridge.
    /// @dev The signatures are produced by everclear and stored here for re-use. We use the same fee for all transfers to all destinations.
    IEverclearAdapter.FeeParams public feeParams;

    /// @notice The everclear `FeeAdapter` contract
    IEverclearAdapter public immutable everclearAdapter;

    function setFeeParams(
        uint256 _fee,
        uint256 _deadline,
        bytes calldata _sig
    ) external onlyOwner {
        feeParams = IEverclearAdapter.FeeParams({
            fee: _fee,
            deadline: _deadline,
            sig: _sig
        });
    }

    function setOutputAsset(
        uint32 _destination,
        bytes32 _outputAsset
    ) external onlyOwner {
        outputAssets[_destination] = _outputAsset;
    }

    constructor(
        address erc20,
        uint256 _scale,
        address _mailbox,
        IEverclearAdapter _everclearAdapter
    ) HypERC20Collateral(erc20, _scale, _mailbox) {
        everclearAdapter = _everclearAdapter;
    }

    function quoteTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) public view virtual override returns (Quote[] memory quotes) {
        quotes = new Quote[](2);
        quotes[0] = Quote({
            token: address(0),
            amount: _quoteGasPayment(_destination, _recipient, _amount)
        });

        quotes[1] = Quote({
            token: address(wrappedToken),
            amount: _amount + feeParams.fee
        });
    }

    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external payable override returns (bytes32) {
        // Charge sender for the fee
        _transferFromSender(_amount + feeParams.fee);

        // Create everclear intent
        _createIntent(_destination, _recipient, _amount);

        // A hyperlane message will be sent by everclear internally.
        return bytes32(0);
    }

    /// @dev Mainly exists to avoid stack too deep error.
    function _createIntent(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) internal {
        bytes32 outputAsset = outputAssets[_destination];
        require(outputAsset != bytes32(0), "ETB: Output asset not set");

        // Check that the fee params are still valid
        // This will also revert if the feeParams are not set
        require(
            feeParams.deadline > block.timestamp,
            "ETB: Fee params deadline expired"
        );

        // Create everclear intent
        uint32[] memory destinations = new uint32[](1);
        destinations[0] = _destination;

        everclearAdapter.newIntent({
            _destinations: destinations,
            _receiver: _recipient,
            _inputAsset: address(wrappedToken),
            _outputAsset: outputAsset,
            _amount: _amount,
            _maxFee: 0,
            _ttl: 0,
            _data: "",
            _feeParams: feeParams
        });
    }
}
