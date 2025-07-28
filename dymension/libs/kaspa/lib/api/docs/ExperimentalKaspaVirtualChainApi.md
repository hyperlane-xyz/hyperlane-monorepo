# \ExperimentalKaspaVirtualChainApi

All URIs are relative to _http://localhost_

| Method                                                                                                                                       | HTTP request           | Description                    |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------ |
| [**get_virtual_chain_transactions_virtual_chain_get**](ExperimentalKaspaVirtualChainApi.md#get_virtual_chain_transactions_virtual_chain_get) | **GET** /virtual-chain | Get Virtual Chain Transactions |

## get_virtual_chain_transactions_virtual_chain_get

> Vec<models::VcBlockModel> get_virtual_chain_transactions_virtual_chain_get(blue_score_gte, limit, resolve_inputs, include_coinbase)
> Get Virtual Chain Transactions

EXPERIMENTAL - EXPECT BREAKING CHANGES: Get virtual chain transactions by blue score.

### Parameters

| Name                 | Type             | Description        | Required   | Notes              |
| -------------------- | ---------------- | ------------------ | ---------- | ------------------ |
| **blue_score_gte**   | **i32**          | Divisible by limit | [required] |
| **limit**            | Option<**i32**>  |                    |            | [default to 10]    |
| **resolve_inputs**   | Option<**bool**> |                    |            | [default to false] |
| **include_coinbase** | Option<**bool**> |                    |            | [default to true]  |

### Return type

[**Vec<models::VcBlockModel>**](VcBlockModel.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)
