<a name="0x0_mailbox"></a>

# Module `0x0::mailbox`

- [Function `inbox_process`](#0x0_mailbox_inbox_process)
- [Function `outbox_dispatch`](#0x0_mailbox_outbox_dispatch)
- [Function `inbox_set_default_ism`](#0x0_mailbox_inbox_set_default_ism)
- [Function `transfer_ownership`](#0x0_mailbox_transfer_ownership)
- [Function `get_recipient_ism`](#0x0_mailbox_get_recipient_ism)
- [Function `outbox_get_root`](#0x0_mailbox_outbox_get_root)
- [Function `outbox_get_count`](#0x0_mailbox_outbox_get_count)
- [Function `outbox_latest_checkpoint`](#0x0_mailbox_outbox_latest_checkpoint)
- [Function `owner`](#0x0_mailbox_owner)

<pre><code><b>use</b> <a href="">0x1::string</a>;
</code></pre>

<a name="0x0_mailbox_inbox_process"></a>

## Function `inbox_process`

NOTE - Attempts to deliver <code>message</code> to its recipient. Verifies
<code>message</code> via the recipient's ISM using the provided <code>metadata</code>.

<pre><code>entry <b>fun</b> <a href="mailbox.md#0x0_mailbox_inbox_process">inbox_process</a>(account: &signer, recipient_pkg: <b>address</b>, recipient_module: <a href="_String">string::String</a>, message: <a href="">vector</a>&lt;u8&gt;)
</code></pre>

<a name="0x0_mailbox_outbox_dispatch"></a>

## Function `outbox_dispatch`

NOTE - Dispatches a message to the destination domain & recipient.

<pre><code>entry <b>fun</b> <a href="mailbox.md#0x0_mailbox_outbox_dispatch">outbox_dispatch</a>(account: &signer, destination_domain: u64, recipient_pkg: <b>address</b>, recipient_module: <a href="_String">string::String</a>, message: <a href="">vector</a>&lt;u8&gt;)
</code></pre>

<a name="0x0_mailbox_inbox_set_default_ism"></a>

## Function `inbox_set_default_ism`

NOTE - Sets the default ISM for the Mailbox.

<pre><code>entry <b>fun</b> <a href="mailbox.md#0x0_mailbox_inbox_set_default_ism">inbox_set_default_ism</a>(account: &signer, new_ism: <b>address</b>)
</code></pre>

<a name="0x0_mailbox_transfer_ownership"></a>

## Function `transfer_ownership`

NOTE - Transfer ownership of MailBox

<pre><code><b>public</b> <b>fun</b> <a href="mailbox.md#0x0_mailbox_transfer_ownership">transfer_ownership</a>(account: &signer, new_owner_address: <b>address</b>)
</code></pre>

<a name="0x0_mailbox_get_recipient_ism"></a>

## Function `get_recipient_ism`

NOTE - Returns the ISM to use for the recipient, defaulting to the
default ISM if none is specified.

<pre><code>#[view]
<b>public</b> <b>fun</b> <a href="mailbox.md#0x0_mailbox_get_recipient_ism">get_recipient_ism</a>(recipient_address: <b>address</b>): <b>address</b>
</code></pre>

<a name="0x0_mailbox_outbox_get_root"></a>

## Function `outbox_get_root`

NOTE - Calculates and returns tree's current root

<pre><code>#[view]
<b>public</b> <b>fun</b> <a href="mailbox.md#0x0_mailbox_outbox_get_root">outbox_get_root</a>(): <a href="">vector</a>&lt;u8&gt;
</code></pre>

<a name="0x0_mailbox_outbox_get_count"></a>

## Function `outbox_get_count`

NOTE - Returns the number of inserted leaves in the tree

<pre><code>#[view]
<b>public</b> <b>fun</b> <a href="mailbox.md#0x0_mailbox_outbox_get_count">outbox_get_count</a>(): u64
</code></pre>

<a name="0x0_mailbox_outbox_latest_checkpoint"></a>

## Function `outbox_latest_checkpoint`

NOTE - Returns a checkpoint representing the current merkle tree.

<pre><code>#[view]
<b>public</b> <b>fun</b> <a href="mailbox.md#0x0_mailbox_outbox_latest_checkpoint">outbox_latest_checkpoint</a>(): (<a href="">vector</a>&lt;u8&gt;, u64)
</code></pre>

<a name="0x0_mailbox_owner"></a>

## Function `owner`

NOTE - Returns current owner

<pre><code>#[view]
<b>public</b> <b>fun</b> <a href="mailbox.md#0x0_mailbox_owner">owner</a>(): <b>address</b>
</code></pre>
