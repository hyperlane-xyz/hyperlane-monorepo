# \KaspaTransactionsApi

All URIs are relative to *http://localhost*

Method | HTTP request | Description
------------- | ------------- | -------------
[**calculate_transaction_mass_transactions_mass_post**](KaspaTransactionsApi.md#calculate_transaction_mass_transactions_mass_post) | **POST** /transactions/mass | Calculate Transaction Mass
[**get_transaction_acceptance_transactions_acceptance_post**](KaspaTransactionsApi.md#get_transaction_acceptance_transactions_acceptance_post) | **POST** /transactions/acceptance | Get Transaction Acceptance
[**get_transaction_transactions_transaction_id_get**](KaspaTransactionsApi.md#get_transaction_transactions_transaction_id_get) | **GET** /transactions/{transactionId} | Get Transaction
[**search_for_transactions_transactions_search_post**](KaspaTransactionsApi.md#search_for_transactions_transactions_search_post) | **POST** /transactions/search | Search For Transactions
[**submit_a_new_transaction_transactions_post**](KaspaTransactionsApi.md#submit_a_new_transaction_transactions_post) | **POST** /transactions | Submit A New Transaction



## calculate_transaction_mass_transactions_mass_post

> models::TxMass calculate_transaction_mass_transactions_mass_post(submit_tx_model)
Calculate Transaction Mass

This function calculates and returns the mass of a transaction, which is essential for determining the minimum fee. The mass calculation takes into account the storage mass as defined in KIP-0009.  Note: Be aware that if the transaction has a very low output amount or a high number of outputs, the mass can become significantly large.

### Parameters


Name | Type | Description  | Required | Notes
------------- | ------------- | ------------- | ------------- | -------------
**submit_tx_model** | [**SubmitTxModel**](SubmitTxModel.md) |  | [required] |

### Return type

[**models::TxMass**](TxMass.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## get_transaction_acceptance_transactions_acceptance_post

> Vec<models::TxAcceptanceResponse> get_transaction_acceptance_transactions_acceptance_post(tx_acceptance_request)
Get Transaction Acceptance

Given a list of transaction_ids, return whether each one is accepted

### Parameters


Name | Type | Description  | Required | Notes
------------- | ------------- | ------------- | ------------- | -------------
**tx_acceptance_request** | [**TxAcceptanceRequest**](TxAcceptanceRequest.md) |  | [required] |

### Return type

[**Vec<models::TxAcceptanceResponse>**](TxAcceptanceResponse.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## get_transaction_transactions_transaction_id_get

> models::TxModel get_transaction_transactions_transaction_id_get(transaction_id, block_hash, inputs, outputs, resolve_previous_outpoints)
Get Transaction

Get details for a given transaction id

### Parameters


Name | Type | Description  | Required | Notes
------------- | ------------- | ------------- | ------------- | -------------
**transaction_id** | **String** |  | [required] |
**block_hash** | Option<**String**> | Specify a containing block (if known) for faster lookup |  |
**inputs** | Option<**bool**> |  |  |[default to true]
**outputs** | Option<**bool**> |  |  |[default to true]
**resolve_previous_outpoints** | Option<**String**> | Use this parameter if you want to fetch the TransactionInput previous outpoint details. Light fetches only the address and amount. Full fetches the whole TransactionOutput and adds it into each TxInput. |  |[default to no]

### Return type

[**models::TxModel**](TxModel.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## search_for_transactions_transactions_search_post

> Vec<models::TxModel> search_for_transactions_transactions_search_post(tx_search, fields, resolve_previous_outpoints, acceptance)
Search For Transactions

Search for transactions by transaction_ids or blue_score

### Parameters


Name | Type | Description  | Required | Notes
------------- | ------------- | ------------- | ------------- | -------------
**tx_search** | [**TxSearch**](TxSearch.md) |  | [required] |
**fields** | Option<**String**> |  |  |[default to ]
**resolve_previous_outpoints** | Option<[**models::PreviousOutpointLookupMode**](.md)> | Use this parameter if you want to fetch the TransactionInput previous outpoint details. Light fetches only the address and amount. Full fetches the whole TransactionOutput and adds it into each TxInput. |  |[default to no]
**acceptance** | Option<[**models::AcceptanceMode**](.md)> | Only used when searching using transactionIds |  |

### Return type

[**Vec<models::TxModel>**](TxModel.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## submit_a_new_transaction_transactions_post

> models::SubmitTransactionResponse submit_a_new_transaction_transactions_post(submit_transaction_request, replace_by_fee)
Submit A New Transaction

### Parameters


Name | Type | Description  | Required | Notes
------------- | ------------- | ------------- | ------------- | -------------
**submit_transaction_request** | [**SubmitTransactionRequest**](SubmitTransactionRequest.md) |  | [required] |
**replace_by_fee** | Option<**bool**> | Replace an existing transaction in the mempool |  |[default to false]

### Return type

[**models::SubmitTransactionResponse**](SubmitTransactionResponse.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

