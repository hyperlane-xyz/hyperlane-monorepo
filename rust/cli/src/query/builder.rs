use std::{mem, rc::Rc, sync::Arc};

use crate::contracts::Mailbox;
use color_eyre::Result;
use ethers::{prelude::Event, providers::Middleware};
use hyperlane_core::H256;
use relayer::settings::matching_list::{Filter, MatchItem};

use super::{LogItemMap, MailboxLog, MailboxLogType};

pub async fn build_log<M: Middleware + 'static, F>(
    mailbox: &Mailbox<M>,
    event: Event<Arc<M>, M, F>,
    log_type: MailboxLogType,
    match_element: &MatchItem,
    starting_block: u64,
    ending_block: u64,
) -> Result<MailboxLog> {
    let mut builder = MailboxLogBuilder::new(mailbox.clone(), event, log_type);
    builder
        .start_block(starting_block)
        .end_block(ending_block)
        .senders(&match_element.sender_address)
        .recipients(&match_element.recipient_address)
        .domains(&match_element.destination_domain);

    builder.build().await
}

struct MailboxLogBuilder<M, F> {
    mailbox: Mailbox<M>,
    event: Event<Arc<M>, M, F>,
    map: Rc<LogItemMap>,
}

impl<M: Middleware + 'static, F> MailboxLogBuilder<M, F> {
    pub fn new(mailbox: Mailbox<M>, event: Event<Arc<M>, M, F>, log_type: MailboxLogType) -> Self {
        let map = LogItemMap::new(log_type);

        Self {
            mailbox,
            event,
            map: Rc::new(map),
        }
    }

    pub fn start_block(&mut self, block: u64) -> &mut Self {
        self.event.filter = mem::take(&mut self.event.filter).from_block(block);
        self
    }

    pub fn end_block(&mut self, block: u64) -> &mut Self {
        self.event.filter = mem::take(&mut self.event.filter).to_block(block);
        self
    }

    pub fn senders(&mut self, senders: &Filter<H256>) -> &mut Self {
        self.set_hash_topic_filter(self.map.sender_topic_idx, senders);
        self
    }

    pub fn recipients(&mut self, recipients: &Filter<H256>) -> &mut Self {
        self.set_hash_topic_filter(self.map.recipient_topic_idx, recipients);
        self
    }

    pub fn domains(&mut self, domains: &Filter<u32>) -> &mut Self {
        self.set_uint_topic_filter(self.map.domain_topic_idx, domains);
        self
    }

    pub fn set_hash_topic_filter<T: Into<H256> + Copy>(
        &mut self,
        topic_index: usize,
        filter: &Filter<T>,
    ) {
        if let Filter::Enumerated(items) = filter {
            if !items.is_empty() {
                let items: Vec<H256> = items.iter().map(|item| (*item).into()).collect();
                self.event.filter.topics[topic_index] = Some(items.into());
            }
        };
    }

    pub fn set_uint_topic_filter<T: Into<u64> + Copy>(
        &mut self,
        topic_index: usize,
        filter: &Filter<T>,
    ) {
        if let Filter::Enumerated(items) = filter {
            if !items.is_empty() {
                let items: Vec<H256> = items
                    .iter()
                    .map(|item| H256::from_low_u64_be((*item).into()))
                    .collect();

                self.event.filter.topics[topic_index] = Some(items.into());
            }
        };
    }

    pub async fn build(self) -> Result<MailboxLog> {
        // println!("Event filter: {:#?}", self.event.filter);
        let logs = self.mailbox.client().get_logs(&self.event.filter).await?;
        Ok(MailboxLog {
            logs,
            map: Rc::clone(&self.map),
        })
    }
}

// impl MailboxLog {
//     fn new<M: Middleware, F>(
//         mailbox_contract: Mailbox<M>,
//         log_type: MailboxLogType,
//         event: Event<Arc<M>, M, F>,
//         match_element: ListElement,
//     ) -> Self {
//         let senders: Option<Vec<H256>> = match match_element.sender_address {
//             matching_list::Filter::Wildcard => None,
//             matching_list::Filter::Enumerated(list) => Some(list.into()),
//         };

//         let destinations: Option<Vec<H256>> = match match_element.destination_domain {
//             matching_list::Filter::Wildcard => None,
//             matching_list::Filter::Enumerated(list) => Some(list.into()),
//         };

//         let recipients = match match_element.recipient_address {
//             matching_list::Filter::Wildcard => None,
//             matching_list::Filter::Enumerated(list) => Some(list.into()),
//         };

//         Self { logs, log_type }
//     }

//     fn sender(&self) -> H160;
//     fn recipient(&self) -> H160;
//     fn destination_domain(&self) -> u32;
//     fn block_number(&self) -> u64;
//     fn log(&self) -> Log;
// }
