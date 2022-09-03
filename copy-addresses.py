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
    return url(network + ':' + address[:6] + '...', explorers[network] + '/address/' + address)

def any_table(addresses, key):
    header_label = h(3, key)
    headers = ['Network', 'Address', 'Explorer']
    rows = []
    for [network, struct] in addresses.items():
        addressOrStruct = struct[key]
        address = addressOrStruct if isinstance(addressOrStruct, str) else addressOrStruct['proxy']
        rows.append([
            capitalize(network),
            codeline(address),
            address_url(network, address)
        ])
    return header_label + '\n' + table(headers, rows)

def inboxes_table(addresses):
    headers = ['Network', 'Origin', 'Address', 'Explorer']
    rows = []
    for [network, struct] in addresses.items():
        for [inboxNetwork, inboxStruct] in struct['inboxes'].items():
            address = inboxStruct['inbox']['proxy']
            rows.append([
                capitalize(network),
                capitalize(inboxNetwork),
                codeline(address),
                address_url(network, address)
            ])
    return h(2, 'Inboxes') + '\n' + table(headers, rows)

def print_environment(env):
    addresses = readJson('typescript/sdk/src/consts/environments/' + env + '.json')
    print(h(2, env))
    print('\n')
    print(any_table(addresses, 'outbox'))
    print('\n')
    print(inboxes_table(addresses))
    print('\n')
    print(any_table(addresses, 'interchainGasPaymaster'))
    print('\n')
    print(any_table(addresses, 'abacusConnectionManager'))
    print('\n')

print('---\ndescription: Abacus core contract addresses\n---\n');
print(h(1, 'Contract addresses') + '\n');
print_environment('mainnet')
print_environment('testnet2')
