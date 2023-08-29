use derive_new::new;
use rocksdb::{DBAccess, DBRawIteratorWithThreadMode};

/// An raw iterator over a prefix that return the key and value as bytes.
#[derive(new)]
pub struct RawPrefixIterator<'a, D: DBAccess> {
    iter: DBRawIteratorWithThreadMode<'a, D>,
    prefix: &'a [u8],
    #[new(default)]
    seeked: bool,
    #[new(default)]
    previous_key: Option<Vec<u8>>,
}

impl<'a, D: DBAccess> Iterator for RawPrefixIterator<'a, D> {
    type Item = (Vec<u8>, Vec<u8>);

    fn next(&mut self) -> Option<Self::Item> {
        let prefix = self.previous_key.unwrap_or_default(self.prefix.to_vec()
        if !self.seeked {
            self.iter.seek(self.prefix);
            self.seeked = true;
        } else {
            self.iter.next();
        }
        let (k, v) = self.iter.item()?;
        println!("Found entry in rocksdb {:?}, for prefix: {:?}", k, self.prefix);
        
        // Is the prefix contained in this key? Otherwise we have finished iterating
        let (k, v) = if k.windows(self.prefix.len()).any(|window| window == self.prefix) {
        // if k.find(self.prefix) {
            println!("{:?} {:?}", k, v);
            Some((k.to_vec(), v.to_vec()))
        } else {
            None
        };
        self.previous_key = k.clone().into();
    }
}
