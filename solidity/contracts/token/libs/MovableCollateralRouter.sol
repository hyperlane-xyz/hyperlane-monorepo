// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {FungibleTokenRouter} from "./FungibleTokenRouter.sol";
import {ValueTransferBridge} from "./ValueTransferBridge.sol";

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

    mapping(uint32 destinationDomain => bytes32 recipient)
        public allowedDestinations;
    mapping(uint32 destinationDomain => mapping(ValueTransferBridge bridge => bool isValidBridge))
        public allowedBridges;

    event CollateralMoved(
        uint32 indexed domain,
        bytes32 recipient,
        uint256 amount,
        address indexed rebalancer
    );

    error BadDestination(address rebalancer, uint32 domain);
    error BadBridge(address rebalancer, ValueTransferBridge bridge);

    function moveCollateral(
        uint32 domain,
        bytes32 recipient,
        uint256 amount
    ) external payable onlyRole(REBALANCER_ROLE) {
        _moveCollateral(
            domain,
            recipient,
            amount,
            ValueTransferBridge(address(this))
        );
    }

    function moveCollateral(
        uint32 domain,
        bytes32 recipient,
        uint256 amount,
        ValueTransferBridge bridge
    ) external payable onlyRole(REBALANCER_ROLE) {
        _moveCollateral(domain, recipient, amount, bridge);
    }

    function _moveCollateral(
        uint32 domain,
        bytes32 recipient,
        uint256 amount,
        ValueTransferBridge bridge
    ) internal virtual {
        address rebalancer = _msgSender();
        if (allowedDestinations[domain] != recipient) {
            revert BadDestination({rebalancer: rebalancer, domain: domain});
        }

        if (!(allowedBridges[domain][bridge])) {
            revert BadBridge({rebalancer: rebalancer, bridge: bridge});
        }

        if (address(bridge) == address(this)) {
            _transferRemote({
                _destination: domain,
                _recipient: recipient,
                _amountOrId: amount,
                _value: msg.value
            });
        } else {
            bridge.transferRemote{value: msg.value}({
                destinationDomain: domain,
                recipient: recipient,
                amountOut: amount
            });
        }

        emit CollateralMoved({
            domain: domain,
            recipient: recipient,
            amount: amount,
            rebalancer: rebalancer
        });
    }

    function addRecipient(uint32 domain, bytes32 recipient) external onlyOwner {
        allowedDestinations[domain] = recipient;
    }

    function addBridge(
        ValueTransferBridge bridge,
        uint32 destinationDomain
    ) external onlyOwner {
        allowedBridges[destinationDomain][bridge] = true;
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
