use std::rc::Rc;

use ethers::types::Log;

use super::{LogItemMap, MailboxLogItem};

/// Two types of events to query, Dispatch and Process.
#[derive(strum::Display, Copy, Clone, Debug, PartialEq, Eq)]
pub enum MailboxLogType {
    Dispatch,
    Process,
}

pub struct MailboxLog {
    pub logs: Vec<Log>,
    pub map: Rc<LogItemMap>,
}

pub struct MailboxLogIter<'a> {
    inner: std::slice::Iter<'a, Log>,
    map: Rc<LogItemMap>,
}

impl<'a> Iterator for MailboxLogIter<'a> {
    type Item = MailboxLogItem<'a>;

    fn next(&mut self) -> Option<Self::Item> {
        self.inner.next().map(|item| MailboxLogItem {
            log: item,
            map: Rc::clone(&self.map),
        })
    }
}

impl<'a> IntoIterator for &'a MailboxLog {
    type Item = MailboxLogItem<'a>;
    type IntoIter = MailboxLogIter<'a>;

    fn into_iter(self) -> Self::IntoIter {
        self.iter()
    }
}

impl MailboxLog {
    pub fn iter(&self) -> MailboxLogIter {
        MailboxLogIter {
            inner: self.logs.iter(),
            map: Rc::clone(&self.map),
        }
    }
}
