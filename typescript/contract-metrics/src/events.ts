import { readFileSync, writeFileSync } from 'fs';
import { getEvents } from 'optics-multi-provider-community/dist/optics/events/fetch';
import * as contexts from "./registerContext";



export async function getDispatchEvents() {
  const context = contexts.mainnetCommunity
  const origin = 'polygon'
  const home = context.mustGetCore(origin).home;

  home.suggestUpdate({  })
  const dispatchFilter = home.filters.Dispatch();
  const dispatchLogs = await getEvents(context, 'polygon', home, dispatchFilter )

  writeFileSync("logs.json", JSON.stringify(dispatchLogs))
}

async function getBlockNumbers() {
  const context = contexts.mainnetCommunity
  const origin = 'polygon'
  const home = context.mustGetCore(origin).home;

  const logs = JSON.parse(readFileSync("logs.json").toString())
  const filteredLogs = logs.filter((_: any) => _.blockNumber >= 23517424 && _.blockNumber <= 23539420)

  const suggestedUpdates = await Promise.all(filteredLogs.map(async (_: any) => {
    return home.suggestUpdate({ blockTag: _.blockNumber })
  }))

  writeFileSync("suggestedUpdates.json", JSON.stringify(suggestedUpdates))
}

getBlockNumbers().then(console.log).catch(console.error)