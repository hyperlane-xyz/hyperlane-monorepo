// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.22;

import {EverclearTokenBridge, Quote} from "./EverclearTokenBridge.sol";
import {IEverclearAdapter, IEverclear} from "../../interfaces/IEverclearAdapter.sol";
import {IWETH} from "../interfaces/IWETH.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {HypERC20Collateral} from "../HypERC20Collateral.sol";
import {TokenMessage} from "../libs/TokenMessage.sol";
import {InterchainAccountRouter} from "../../middleware/InterchainAccountRouter.sol";
import {CallLib} from "../../middleware/libs/Call.sol";
import {DecimalScaleable} from "../libs/mixins/DecimalScaleable.sol";

/**
 * @title EverclearEthBridge
 * @author Hyperlane Team
 * @notice A specialized ETH bridge that integrates with Everclear's intent-based architecture
 * @dev Extends EverclearTokenBridge to handle ETH by wrapping to WETH for transfers and unwrapping on destination
 */
contract EverclearEthBridge is EverclearTokenBridge {
    using TokenMessage for bytes;
    using SafeERC20 for IERC20;
    using Address for address payable;
    using TypeCasts for bytes32;

    InterchainAccountRouter public immutable icaRouter;

    /**
     * @notice Constructor to initialize the Everclear ETH bridge
     * @param _everclearAdapter The address of the Everclear adapter contract
     */
    constructor(
        IWETH _weth,
        InterchainAccountRouter _icaRouter,
        IEverclearAdapter _everclearAdapter
    )
        EverclearTokenBridge(
            address(_weth),
            _icaRouter.mailbox(),
            _everclearAdapter
        )
    {
        icaRouter = _icaRouter;
    }

    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) public payable override returns (bytes32) {
        uint256 fee = feeParams.fee;
        require(msg.value >= _amount + fee);
        IWETH(wrappedToken).deposit{value: _amount + fee}();
        uint256 dispatchValue = msg.value - (_amount + fee);

        bytes32 outputWeth = outputAssets[_destination];
        require(outputWeth != bytes32(0), "ETB: Output asset not set");

        // Create everclear intent
        uint32[] memory destinations = new uint32[](1);
        destinations[0] = _destination;

        bytes32 ica = icaRouter.getRemoteInterchainAccount(
            _destination,
            address(this)
        );

        (, IEverclear.Intent memory intent) = everclearAdapter.newIntent({
            _destinations: destinations,
            // send weth to ICA for unwrapping and forwarding to recipient
            _receiver: ica,
            _inputAsset: address(wrappedToken),
            _outputAsset: outputWeth,
            _amount: _amount,
            _maxFee: 0,
            _ttl: 0,
            _data: bytes(""),
            _feeParams: feeParams
        });

        uint256 scaledAmount = DecimalScaleable.scaleOutbound(_amount, scale);

        CallLib.Call[] memory calls = new CallLib.Call[](2);
        // unwrap weth to native eth
        calls[0] = CallLib.build(
            outputWeth,
            abi.encodeWithSelector(IWETH.withdraw.selector, scaledAmount)
        );
        // eth transfer to recipient
        calls[1] = CallLib.build(_recipient, scaledAmount, bytes(""));

        return icaRouter.callRemote{value: dispatchValue}(_destination, calls);
    }

    function _handle(
        uint32 _origin,
        bytes32,
        bytes calldata _message
    ) internal override {
        revert();
    }
}
