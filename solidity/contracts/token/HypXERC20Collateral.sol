pragma solidity >=0.8.0;

import {IXERC20} from "./IXERC20.sol";
import {TokenRouter} from "./libs/TokenRouter.sol";

contract HypXERC20Collateral is TokenRouter {
    IXERC20 public immutable xerc20;

    constructor(address _xerc20, address _mailbox) TokenRouter(_mailbox) {
        xerc20 = IXERC20(_xerc20);
    }

    function _transferFromSender(
        uint256 _amountOrId
    ) internal override returns (bytes memory metadata) {
        xerc20.burn(msg.sender, _amountOrId);
        return "";
    }

    function _transferTo(
        address _recipient,
        uint256 _amountOrId,
        bytes calldata /*metadata*/
    ) internal override {
        xerc20.mint(_recipient, _amountOrId);
    }

    function balanceOf(
        address _account
    ) external view override returns (uint256) {
        return xerc20.balanceOf(_account);
    }
}
