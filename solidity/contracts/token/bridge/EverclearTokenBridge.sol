// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.22;

import {ITokenBridge, Quote} from "contracts/interfaces/ITokenBridge.sol";
import {HypERC20Collateral} from "contracts/token/HypERC20Collateral.sol";
import {IEverclearAdapter} from "contracts/interfaces/IEverclearAdapter.sol";

contract EverclearTokenBridge is HypERC20Collateral {
    /// @notice Fee parameters for transfers to a given destination.
    /// @param assetAddress The address of the destination asset. Note that the fees are charged in `wrappedToken` on the origin chain.
    /// @param fee The fee amount
    /// @param deadline The deadline for the fee
    /// @param sig The signature of the fee
    struct EverclearFeeParams {
        bytes32 assetAddress;
        uint256 fee;
        uint256 deadline;
        bytes sig;
    }

    /// @notice Fee parameters for the bridge.
    /// @dev The signatures are produced by everclear and stored here for re-use. We use the same fee for all transfers to a given destination.
    mapping(uint32 destination => EverclearFeeParams feeParams)
        public feeParams;

    /// @notice The everclear `FeeAdapter` contract
    IEverclearAdapter public immutable everclearAdapter;

    function setFeeParams(
        uint32 _destination,
        bytes32 _assetAddress,
        uint256 _fee,
        uint256 _deadline,
        bytes calldata _sig
    ) external onlyOwner {
        feeParams[_destination] = EverclearFeeParams({
            assetAddress: _assetAddress,
            fee: _fee,
            deadline: _deadline,
            sig: _sig
        });
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
            amount: _amount + feeParams[_destination].fee // if feeParams is not set, this still works
        });
    }

    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external payable override returns (bytes32) {
        // Create everclear intent
        uint256 amount = _createIntent(_destination, _recipient, _amount);

        // Do regular transferRemote stuff, e.g. take funds from user and send message to mailbox
        return _transferRemote(_destination, _recipient, amount, msg.value);
    }

    function _createIntent(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) internal returns (uint256 amountToTransfer) {
        // Create everclear intent
        uint32[] memory destinations = new uint32[](1);
        destinations[0] = _destination;

        everclearAdapter.newIntent({
            _destinations: destinations,
            _receiver: _recipient,
            _inputAsset: address(wrappedToken),
            _outputAsset: feeParams[_destination].assetAddress,
            _amount: _amount,
            _maxFee: 0,
            _ttl: 0,
            _data: "",
            _feeParams: getFeeParams(_destination)
        });

        return _amount + feeParams[_destination].fee;
    }

    function getFeeParams(
        uint32 _destination
    ) public view returns (IEverclearAdapter.FeeParams memory) {
        return
            IEverclearAdapter.FeeParams({
                fee: feeParams[_destination].fee,
                deadline: feeParams[_destination].deadline,
                sig: feeParams[_destination].sig
            });
    }
}
