// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Quote} from "../../interfaces/ITokenBridge.sol";

interface ICrossCollateralFee {
    function quoteTransferRemoteTo(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        bytes32 _targetRouter
    ) external view returns (Quote[] memory);

    /**
     * @notice Router-aware exact-in quote: largest deliverable amount whose
     *         amount + fee fits within `_maxSpend`.
     * @dev Inverse of `quoteTransferRemoteTo` on the fee (token) leg.
     */
    function quoteTransferRemoteFromTo(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _maxSpend,
        bytes32 _targetRouter
    ) external view returns (uint256 _amount);
}
