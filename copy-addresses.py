import json

f = open('typescript/sdk/src/consts/environments/mainnet.json')

data = json.load(f)

def capitalize(s):
    return s[0].upper() + s[1:]

def h(n, s):
    return '#' * n + ' ' + capitalize(s)

def codeline(s):
    return '`' + s + '`'

def codeblock(s):
    return '```\n' + s + '\n```'

def table(headers, rows):
    return '| ' + ' | '.join(headers) + ' |\n' + '| ' + ' | '.join(['---'] * len(headers)) + ' |\n' + '\n'.join(['| ' + ' | '.join(row) + ' |' for row in rows])

def outbox_table():
    headers = ['Network', 'Address']
    rows = []
    for [network, struct] in data.items():
        rows.append([capitalize(network), codeline(struct['outbox']['proxy'])])
    return table(headers, rows)

def inboxes_table():
    headers = ['Network', 'Origin', 'Address']
    rows = []
    for [network, struct] in data.items():
        for [inboxNetwork, inboxStruct] in struct['inboxes'].items():
            rows.append([capitalize(network), capitalize(inboxNetwork), codeline(inboxStruct['inbox']['proxy'])])
        # print(h(3, inboxNetwork))
        # print(codeline(inboxStruct['inbox']['proxy']))
    return table(headers, rows)

print(outbox_table())

print(inboxes_table())

