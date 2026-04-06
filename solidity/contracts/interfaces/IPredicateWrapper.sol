// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

interface IPredicateWrapper {
    error PredicateRouterWrapper__UnauthorizedTransfer();
    error PredicateRouterWrapper__InvalidRouter();
    error PredicateRouterWrapper__NativeTokenUnsupported();
    error PredicateRouterWrapper__InvalidRegistry();
    error PredicateRouterWrapper__InvalidPolicy();
    error PredicateRouterWrapper__WithdrawFailed();
    error PredicateRouterWrapper__AttestationInvalid();
    error PredicateRouterWrapper__InsufficientValue();
    error PredicateRouterWrapper__PostDispatchNotExecuted();
    error PredicateRouterWrapper__RefundFailed();
    error PredicateRouterWrapper__ReentryDetected();
}
