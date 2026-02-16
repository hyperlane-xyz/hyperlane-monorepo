- The Monitor is resposible for monitoring the router balances, we should consider changes the monitor interface so that we can enable inventory balance monitoring, we would need to pass in the inventory account address, we would need to extract the token address and see if there is an SDK abstraction for reading the token balance at an address, This would replace the inventoryMonitor, in many ways, we would combine these clases so we have one class for monitorin balances

- Why do we need InventoryRoute type? Can we not reuse Route?

- Can we replace the IInventoryRebalancer with IRebalancer? So that InventoryRebalancer implements IRebalancer. We can use RebalanceRoute instead of InventoryRoute. We can define a Base interface for result that incluse RebalanceRoute and a success bollena, both RebalanceExecutionResult and InventoryExecutionResult can extend, we can change the interface of rebalance method to returnt this base type instead RebalanceExecutionResult. We can then change. getAvailableAmount does not need to be in the interface

- Given that both rebalancers use the same interface, can we simplify the RebalancerOrchestrator, maybe to accept and array on IRebalancer instances

- the rebalancer config is tied too closely with lifi, the idea is that we should be able to use any IExternal Bridge, we need to come up with a design for this at the config level. I am thinking for each chain, we can configure the bridge that we use e.g. externalBridge: 'lifi' and then define a specific confi for each external bridge, for lifi, we would have a field called integrator. that way the external bridge is configurable.

- do we need originalDeficit in RebalanceIntent? is it used for anything?

- NATIVE_TOKEN_ADDRESS should be in the IExternal Bridge implementation, it is not a standard const
