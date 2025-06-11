import fetch from 'node-fetch'

export async function getWarpRouteBalances(): Promise<string[]> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 5000)

  try {
    const response = await fetch('https://warp.api/balances', {
      signal: controller.signal,
    })
    clearTimeout(timeoutId)

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
    }

    let data: any
    try {
      data = await response.json()
    } catch {
      throw new Error('Invalid response')
    }

    if (!data || !Array.isArray(data.balances)) {
      throw new Error('Invalid response')
    }

    return data.balances.map((b: { route: string; balance?: number }) => {
      const balance = typeof b.balance === 'number' ? b.balance : 0
      return `${b.route}: ${balance}`
    })
  } catch (error: any) {
    clearTimeout(timeoutId)
    if (error.name === 'AbortError') {
      throw new Error('timeout')
    }
    throw error
  }
}