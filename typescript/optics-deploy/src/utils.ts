import { exec } from 'child_process'

/*
 * Converts address to Bytes32
 *
 * @param address - the address
 * @return The address as bytes32
 */
export function toBytes32(address: string): string {
  return '0x' + '00'.repeat(12) + address.slice(2);
}

/**
 * Map an async function over a list xs with a given concurrency level
 *
 * @param concurrency number of `mapFn` concurrent executions
 * @param xs list of value
 * @param mapFn mapping function
 */
 export async function concurrentMap<A, B>(
  concurrency: number,
  xs: A[],
  mapFn: (val: A, idx: number) => Promise<B>
): Promise<B[]> {
  let res: B[] = []
  for (let i = 0; i < xs.length; i += concurrency) {
    const remaining = xs.length - i
    const sliceSize = Math.min(remaining, concurrency)
    const slice = xs.slice(i, i + sliceSize)
    res = res.concat(await Promise.all(slice.map((elem, index) => mapFn(elem, i + index))))
  }
  return res
}



export function execCmd(
  cmd: string,
  execOptions: any = {},
  rejectWithOutput = false,
  pipeOutput = false
): Promise<[string, string]> {
  return new Promise((resolve, reject) => {
    if (process.env.VERBOSE === 'true') {
      console.debug('$ ' + cmd)
      pipeOutput = true
    }

    const execProcess = exec(
      cmd,
      { maxBuffer: 1024 * 10000, ...execOptions },
      (err, stdout, stderr) => {
        if (process.env.VERBOSE === 'true') {
          console.debug(stdout.toString())
        }
        if (err || process.env.VERBOSE === 'true') {
          console.error(stderr.toString())
        }
        if (err) {
          if (rejectWithOutput) {
            reject([err, stdout.toString(), stderr.toString()])
          } else {
            reject(err)
          }
        } else {
          resolve([stdout.toString(), stderr.toString()])
        }
      }
    )

    if (pipeOutput) {
      if (execProcess.stdout) {
        execProcess.stdout.pipe(process.stdout)
      }
      if (execProcess.stderr) {
        execProcess.stderr.pipe(process.stderr)
      }
    }
  })
}

export const ensure0x = (hexstr: string) => (hexstr.startsWith('0x') ? hexstr : '0x' + hexstr)
export const strip0x = (hexstr: string) => (hexstr.startsWith('0x') ? hexstr.slice(2) : hexstr)
export function includeConditionally(condition: boolean, data: any) {
  return condition ? data : {};
}

function log(isTest: boolean, str: string) {
  if (!isTest) {
    console.log(str);
  }
}

function warn(text: string, padded: boolean = false) {
  if (padded) {
    const padding = '*'.repeat(text.length + 8);
    console.log(
      `
      ${padding}
      *** ${text.toUpperCase()} ***
      ${padding}
      `,
    );
  } else {
    console.log(`**** ${text.toUpperCase()} ****`);
  }
}
