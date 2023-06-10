use std::{iter::Peekable, sync::Arc};

use crate::contracts::Mailbox;
use color_eyre::Result;
use ethers::providers::Middleware;
use relayer::settings::MatchingList;

use super::{build_log, MailboxLog, MailboxLogItem, MailboxLogIter, MailboxLogType};

pub struct MailboxLogs {
    logs: Vec<MailboxLog>,
}

pub struct MailboxLogsIter<'a> {
    iters: Vec<Peekable<MailboxLogIter<'a>>>,
}

impl<'a> MailboxLogsIter<'a> {
    fn new(logs: &'a [MailboxLog]) -> Self {
        let iters = logs.iter().map(|log| log.into_iter().peekable()).collect();
        Self { iters }
    }
}

/// Iterates over all logs in the mailbox logs, returning items in order with duplicates removed.
///
/// This presumes that individual logs are returning items in order; otherwise, this will not work.
///
/// This is expected to be the case for executed transactions because the logs are stored in this order.
///
/// This would not be the case for pending transactions, but this should not cause a problem in practice.
/// The main consequence is that ordering can change until written to a block.
impl<'a> Iterator for MailboxLogsIter<'a> {
    type Item = MailboxLogItem<'a>;

    fn next(&mut self) -> Option<Self::Item> {
        // Find iterator with smallest next item
        let min_index = self
            .iters
            .iter_mut()
            .enumerate()
            .filter_map(|(i, iter)| Some((i, iter.peek()?)))
            .min_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))?
            .0;

        // Update iterator with smallest next item
        let next_item = self.iters[min_index].next();

        // Remove duplicate items
        if let Some(ref item) = next_item {
            self.iters.iter_mut().for_each(|iter| {
                while let Some(peeked) = iter.peek() {
                    if peeked == item {
                        iter.next();
                    } else {
                        break;
                    }
                }
            });
        }

        next_item
    }
}

impl<'a> IntoIterator for &'a MailboxLogs {
    type Item = MailboxLogItem<'a>;
    type IntoIter = MailboxLogsIter<'a>;

    fn into_iter(self) -> Self::IntoIter {
        MailboxLogsIter::new(&self.logs)
    }
}

impl MailboxLogs {
    pub async fn new<M: Middleware + 'static>(
        chain_id: u32,
        mailbox: Arc<Mailbox<M>>,
        matching_list: MatchingList,
        start_block: u64,
        end_block: u64,
    ) -> Result<Self> {
        // println!("start_block: {}", start_block);
        // println!("end_block: {}", end_block);

        let mut logs = vec![];

        if let Some(match_elements) = matching_list.0 {
            for match_element in match_elements {
                if match_element.origin_domain.matches(&chain_id) {
                    // We are looking at the origin mailbox, so look at dispatch events
                    logs.push(
                        build_log(
                            &mailbox,
                            mailbox.dispatch_filter(),
                            MailboxLogType::Dispatch,
                            &match_element,
                            start_block,
                            end_block,
                        )
                        .await?,
                    );
                }

                if match_element.destination_domain.matches(&chain_id) {
                    // We are looking at the destination mailbox, so look at process events
                    logs.push(
                        build_log(
                            &mailbox,
                            mailbox.process_filter(),
                            MailboxLogType::Process,
                            &match_element,
                            start_block,
                            end_block,
                        )
                        .await?,
                    );
                }
            }
        }

        // TODO: Change to first collecting all the futures and then awaiting them all?

        Ok(Self { logs })
    }
}
