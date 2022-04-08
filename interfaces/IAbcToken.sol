// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.13;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IAbcToken is IERC20 {
    // Burns `amount` and calls TransferRouter.transferRemote(domain, recipient, amount)
    function transferRemote(
        uint32 domain,
        address recipient,
        uint256 amount
    ) external;

    // Burns `amount` and calls TransferRouter.transferRemote(domain, recipient, amount)
    function transferFromRemote(
        uint32 domain,
        address sender,
        address recipient,
        uint256 amount
    ) external;

    // Allows approved addresses to burn `sender`'s tokens. Needed for slashing.
    function burnFrom(address sender, uint256 amount) external;
}
