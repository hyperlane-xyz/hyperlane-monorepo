import { createKeysInGCP } from "../../src/agents"

createKeysInGCP('dev').then(console.log).catch(console.error)