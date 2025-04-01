// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {HypERC20} from "../HypERC20.sol";
import {FungibleTokenRouter} from "../libs/FungibleTokenRouter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract HypERC20Memo is FungibleTokenRouter {
    using SafeERC20 for IERC20;
    mapping(address => mapping(uint256 => bytes)) private _memos;
    mapping(address => uint256) private _nonces;

    IERC20 public immutable wrappedToken;

    /**
     * @notice Constructor
     * @param erc20 Address of the token to keep as collateral
     */
    constructor(
        address erc20,
        uint256 _scale,
        address _mailbox
    ) FungibleTokenRouter(_scale, _mailbox) {
        require(Address.isContract(erc20), "HypERC20: invalid token");
        wrappedToken = IERC20(erc20);
    }

    function initialize(
        address _hook,
        address _interchainSecurityModule,
        address _owner
    ) public virtual initializer {
        _MailboxClient_initialize(_hook, _interchainSecurityModule, _owner);
    }

    function balanceOf(
        address _account
    ) external view override returns (uint256) {
        return wrappedToken.balanceOf(_account);
    }

    function setMemoForNextTransfer(bytes calldata memo) external {
        _memos[msg.sender][_nonces[msg.sender]] = memo;
    }

    function _transferFromSender(
        uint256 _amount
    ) internal virtual override returns (bytes memory) {
        wrappedToken.safeTransferFrom(msg.sender, address(this), _amount);
        bytes memory memo = _memos[msg.sender][_nonces[msg.sender]];

        delete _memos[msg.sender][_nonces[msg.sender]];
        _nonces[msg.sender]++;

        return memo;
    }

    function _transferTo(
        address _recipient,
        uint256 _amount,
        bytes calldata // no metadata
    ) internal virtual override {
        wrappedToken.safeTransfer(_recipient, _amount);
    }
}
