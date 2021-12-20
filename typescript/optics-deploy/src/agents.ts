import { ChainJson } from "./chain"
import { exec } from 'child_process'

export interface AgentConfig {
  namespace: string,
  runEnv: string,
  awsRegion: string,
  awsKeyId: string,
  awsSecretAccessKey: string,
  dockerImageRepo: string,
  dockerImageTag: string,
}

export interface AgentChainsConfig {
  [name: string]: ChainJson
}

function valuesForHome(home: string, agentConfig: AgentConfig, configs: any) {
  if (!agentConfig.awsRegion || !agentConfig.awsKeyId || !agentConfig.awsSecretAccessKey) {
    throw new Error('Some AgentConfig aws values are missing')
  }
  return {
    image: {
      repository: agentConfig.dockerImageRepo,
      tag: agentConfig.dockerImageTag,
    },
    optics: {
      runEnv: agentConfig.runEnv,
      baseConfig: `${home}_config.json`,
      homeChain: {
        name: home,
        connectionUrl: configs[home].rpc
      },
      aws: {
        accessKeyId: agentConfig.awsKeyId,
        secretAccessKey: agentConfig.awsSecretAccessKey
      },
      replicaChains: Object.keys(configs).filter(_ => _ !== home).map(replica => {
        const replicaConfig = configs[replica]
        return {
          name: replica,
          connectionUrl: replicaConfig.rpc
        }
      }),
      updater: {
        transactionSigners: Object.keys(configs).map((chain) => ({
          name: configs[chain].name,
          aws: {
            // Just on staging
            keyId: `alias/${agentConfig.runEnv}-${home}-updater-attestation`,
            region: agentConfig.awsRegion
          }
        })),
        attestationSigner: {
          aws: {
            keyId: `alias/${agentConfig.runEnv}-${home}-updater-signer`,
            region: agentConfig.awsRegion
          }
        }
      },
      relayer: {
        transactionSigners: Object.keys(configs).map((chain) => ({
          name: configs[chain].name,
          aws: {
            // Just on staging
            keyId: `alias/${agentConfig.runEnv}-${home}-relayer-signer`,
            region: agentConfig.awsRegion
          }
        }))
      },
      processor: {
        transactionSigners: Object.keys(configs).map((chain) => ({
          name: configs[chain].name,
          aws: {
            // Just on staging
            keyId: `alias/${agentConfig.runEnv}-${home}-processor-signer`,
            region: agentConfig.awsRegion
          }
        }))
      }
    },
  }
}

function helmifyValues(config: any, prefix?: string): string[] {
  if (typeof config !== 'object') {
    return [`--set ${prefix}=${JSON.stringify(config)}`]
  }

  if (config.flatMap) {
    return config.flatMap((value: any, index: number) => {
      return helmifyValues(value, `${prefix}[${index}]`)
    })
  }
  return Object.keys(config).flatMap((key) => {
    const value = config[key]
    return helmifyValues(value, prefix ? `${prefix}.${key}` : key)
  })
}

export function runHelmCommand(action: 'install' | 'upgrade', agentConfig: AgentConfig, homeConfig: ChainJson, configs: AgentChainsConfig) {
  const valueDict = valuesForHome(homeConfig.name, agentConfig, configs)
  const values = helmifyValues(valueDict)
  return execCmd(`helm ${action} ${homeConfig.name} ../../rust/helm/optics-agent/ --namespace ${agentConfig.namespace} ${values.join(' ')}`, {}, false, true)
}

function execCmd(
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