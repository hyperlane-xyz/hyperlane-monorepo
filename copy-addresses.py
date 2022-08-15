import json

def readJson(filename):
    with open(filename) as f:
        return json.load(f)

explorers = readJson('typescript/sdk/src/consts/explorers.json')

def capitalize(s):
    return s[0].upper() + s[1:]

def h(n, s):
    return '#' * n + ' ' + capitalize(s)

def codeline(s):
    return '`' + s + '`'

def url(label, link):
    return '[' + label + '](' + link + ')'

def codeblock(s):
    return '```\n' + s + '\n```'

def table(headers, rows):
    return '| ' + ' | '.join(headers) + ' |\n' + '| ' + ' | '.join(['---'] * len(headers)) + ' |\n' + '\n'.join(['| ' + ' | '.join(row) + ' |' for row in rows])

def address_url(network, address):
    return url(codeline(address), explorers[network] + '/address/' + address)

def any_table(addresses, key):
    header_label = h(2, key)
    headers = ['Network', 'Address']
    rows = []
    for [network, struct] in addresses.items():
        addressOrStruct = struct[key]
        address = addressOrStruct if isinstance(addressOrStruct, str) else addressOrStruct['proxy']
        rows.append([
            capitalize(network),
            address_url(network, address)
        ])
    return header_label + '\n' + table(headers, rows)

def inboxes_table(addresses):
    headers = ['Network', 'Origin', 'Address']
    rows = []
    for [network, struct] in addresses.items():
        for [inboxNetwork, inboxStruct] in struct['inboxes'].items():
            rows.append([
                capitalize(network),
                capitalize(inboxNetwork),
                address_url(inboxNetwork, inboxStruct['inbox']['proxy'])
            ])
    return h(2, 'Inboxes') + '\n' + table(headers, rows)

def print_environment(env):
    addresses = readJson('typescript/sdk/src/consts/environments/' + env + '.json')
    print(h(1, env))
    print(any_table(addresses, 'outbox'))
    print(inboxes_table(addresses))
    print(any_table(addresses, 'interchainGasPaymaster'))
    print(any_table(addresses, 'abacusConnectionManager'))

print_environment('mainnet')
print_environment('testnet2')
