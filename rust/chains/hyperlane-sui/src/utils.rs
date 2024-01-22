pub async fn get_filtered_events<T, S>(
    sui_client: &SuiRpcClient,
    account_address: SuiAddress,
    struct_tag: &str,
    field_name: &str,
    range: RangeInclusive<u32>,
) -> ChainResult<Vec<(T, LogMeta)>> 
where
    S: TryFrom<VersionedEvent> + TxSpecificData + TryInto<T> + Clone,
    ChainCommunicationError:
        From<<S as TryFrom<VersionEvent>>::Error> + From<<S as TryInto<T>>::Error>,
{

}