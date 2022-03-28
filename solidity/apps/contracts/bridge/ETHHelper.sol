// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

// ============ Internal Imports ============
import {BridgeRouter} from "./BridgeRouter.sol";
import {IWeth} from "../../interfaces/bridge/IWeth.sol";
// ============ External Imports ============
import {TypeCasts} from "@abacus-network/core/contracts/XAppConnectionManager.sol";
import {SafeMath} from "@openzeppelin/contracts/math/SafeMath.sol";

contract ETHHelper {
    // ============ Libraries ============

    using SafeMath for uint256;

    // ============ Immutables ============

    // wrapped Ether contract
    IWeth public immutable weth;
    // bridge router contract
    BridgeRouter public immutable bridge;

    // ============ Constructor ============

    constructor(address _weth, address _bridge) {
        weth = IWeth(_weth);
        bridge = BridgeRouter(_bridge);
        IWeth(_weth).approve(_bridge, uint256(-1));
    }

    // ============ External Functions ============

    /**
     * @notice Sends ETH over the Abacus Bridge. Sends to a full-width Abacus
     * identifer on the other side.
     * @dev As with all bridges, improper use may result in loss of funds.
     * @param _domain The domain to send funds to.
     * @param _to The 32-byte identifier of the recipient
     * @param _gasPayment The amount of value paid to this function to spend toward
     * message processing on the destination chain. All other value is sent over
     * the Abacus Bridge.
     */
    function sendTo(
        uint32 _domain,
        bytes32 _to,
        uint256 _gasPayment
    ) public payable {
        uint256 _ethAmount = msg.value.sub(_gasPayment);
        weth.deposit{value: _ethAmount}();
        bridge.send{value: _gasPayment}(
            address(weth),
            _ethAmount,
            _domain,
            _to
        );
    }

    /**
     * @notice Sends ETH over the Abacus Bridge. Sends to the same address on
     * the other side.
     * @dev WARNING: This function should only be used when sending TO an
     * EVM-like domain. As with all bridges, improper use may result in loss of
     * funds.
     * @param _domain The domain to send funds to
     * @param _gasPayment The amount of value paid to this function to spend toward
     * message processing on the destination chain. All other value is sent over
     * the Abacus Bridge.
     */
    function send(uint32 _domain, uint256 _gasPayment) external payable {
        sendTo(_domain, TypeCasts.addressToBytes32(msg.sender), _gasPayment);
    }

    /**
     * @notice Sends ETH over the Abacus Bridge. Sends to a specified EVM
     * address on the other side.
     * @dev This function should only be used when sending TO an EVM-like
     * domain. As with all bridges, improper use may result in loss of funds
     * @param _domain The domain to send funds to.
     * @param _to The EVM address of the recipient.
     * @param _gasPayment The amount of value paid to this function to spend toward
     * message processing on the destination chain. All other value is sent over
     * the Abacus Bridge.
     */
    function sendToEVMLike(
        uint32 _domain,
        address _to,
        uint256 _gasPayment
    ) external payable {
        sendTo(_domain, TypeCasts.addressToBytes32(_to), _gasPayment);
    }
}
