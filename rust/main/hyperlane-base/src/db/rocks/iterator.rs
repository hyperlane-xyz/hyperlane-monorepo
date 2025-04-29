use std::marker::PhantomData;

use rocksdb::DBIterator;

use hyperlane_core::{Decode, Encode};

/// An iterator over a prefix that deserializes values
pub struct PrefixIterator<'a, V> {
    iter: DBIterator<'a>,
    prefix: &'a [u8],
    _phantom: PhantomData<*const V>,
}

impl<V> Iterator for PrefixIterator<'_, V>
where
    V: Encode + Decode,
{
    type Item = V;

    fn next(&mut self) -> Option<Self::Item> {
        let prefix = self.prefix;
        self.iter.find_map(|r| {
            let (k, v) = r.expect("Database error when iterating prefixed keys");
            if k.strip_prefix(prefix).is_some() {
                Some(V::read_from(&mut &v[..]).expect("!corrupt"))
            } else {
                None
            }
        })
    }
}
