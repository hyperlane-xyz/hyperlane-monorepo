// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {FungibleTokenRouter} from "./FungibleTokenRouter.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {Context} from "@openzeppelin/contracts/utils/Context.sol";
import {ContextUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ContextUpgradeable.sol";

abstract contract MovableCollateralRouter is
    FungibleTokenRouter,
    AccessControl
{
    constructor(
        uint256 _scale,
        address _mailbox
    ) FungibleTokenRouter(_scale, _mailbox) {
        _grantRole(DEFAULT_ADMIN_ROLE, owner());
    }

    bytes32 public constant REBALANCER_ROLE = keccak256("REBALANCER_ROLE");

    mapping(uint32 domain => bytes32 recipient) public allowedDestinations;

    event CollateralMoved(uint32 domain, bytes32 recipient, uint256 amount);

    error BadDestination(address rebalancer, uint32 domain);

    function moveCollateral(
        uint32 domain,
        bytes32 recipient,
        uint256 amount
    ) external payable onlyRole(REBALANCER_ROLE) {
        if (!(allowedDestinations[domain] == recipient)) {
            revert BadDestination(msg.sender, domain);
        }
        _transferRemote({
            _destination: domain,
            _recipient: recipient,
            _amountOrId: amount,
            _value: msg.value
        });
        emit CollateralMoved(domain, recipient, amount);
    }

    function addRecipient(uint32 domain, bytes32 recipient) external onlyOwner {
        allowedDestinations[domain] = recipient;
    }

    function _msgData()
        internal
        view
        virtual
        override(Context, ContextUpgradeable)
        returns (bytes calldata)
    {
        return ContextUpgradeable._msgData();
    }

    function _msgSender()
        internal
        view
        virtual
        override(Context, ContextUpgradeable)
        returns (address)
    {
        return ContextUpgradeable._msgSender();
    }
}
