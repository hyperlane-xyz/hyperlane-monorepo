import { deleteKeysInGCP } from "../../src/agents"

deleteKeysInGCP('dev').then(console.log).catch(console.error)