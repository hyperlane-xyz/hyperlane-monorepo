import json


f = open('typescript/sdk/src/consts/environments/testnet2.json')

data = json.load(f)

def h(n, s):
    return '#' * n + ' ' + s[0].upper() + s[1:]

def codeline(s):
    return '`' + s + '`'

def codeblock(s):
    return '```\n' + s + '\n```'

for [network, struct] in data.items():
    print(h(1, network))
    print(h(2, 'Outbox'))
    print(codeline(struct['outbox']['proxy']))
    print(h(2, 'Inboxes'))
    for [inboxNetwork, inboxStruct] in struct['inboxes'].items():
        print(h(3, inboxNetwork))
        print(codeline(inboxStruct['inbox']['proxy']))
    # outbox = addresses.outbox
