// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

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

// ============ Internal Imports ============
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";

// ============ External Imports ============
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title StaticProtocolFee
 * @notice Collects a static protocol fee from the sender.
 * @dev V3 WIP
 */
contract StaticProtocolFee is IPostDispatchHook, Ownable {
    using Address for address payable;

    // ============ Constants ============
    uint256 public constant MAX_PROTOCOL_FEE = 1e16;

    // ============ Public Storage ============
    uint256 public protocolFee;

    // ============ Constructor ============

    constructor(uint256 _protocolFee, address _owner) {
        require(_protocolFee <= MAX_PROTOCOL_FEE, "protocol fee too high");
        protocolFee = _protocolFee;
        _transferOwnership(_owner);
    }

    // ============ External Functions ============

    /**
     * @notice Collects the protocol fee from the sender.
     */
    function postDispatch(bytes calldata, bytes calldata)
        external
        payable
        override
    {
        require(msg.value >= protocolFee, "insufficient protocol fee");

        uint256 refund = msg.value - protocolFee;
        if (refund > 0) {
            payable(msg.sender).sendValue(refund);
        }
    }

    /**
     * @notice Sets the protocol fee.
     * @param _protocolFee The new protocol fee.
     */
    function setProtocolFee(uint256 _protocolFee) external onlyOwner {
        require(_protocolFee <= MAX_PROTOCOL_FEE, "protocol fee too high");
        protocolFee = _protocolFee;
    }

    /**
     * @notice Collects protocol fees from the contract.
     * @param amount The amount of protocol fees to collect. If 0, collects the entire balance.
     */
    function collectProtocolFees(uint256 amount) external onlyOwner {
        uint256 amountCollected = (amount == 0)
            ? address(this).balance
            : amount;
        payable(msg.sender).sendValue(amountCollected);
    }
}
