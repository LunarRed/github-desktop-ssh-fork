import { homedir } from 'os'
import { join } from 'path'
import { readFile } from 'fs/promises'

/**
 * An SSH config `Host` alias that can be used as `ssh <alias>`.
 *
 * Wildcard hosts (`*`, `?`) are omitted because they are not concrete
 * destinations.
 */
export type SshConfigHost = {
  readonly alias: string
  readonly hostName?: string
  readonly user?: string
  readonly port?: number
}

const wildcardHostRe = /[?*]/

/**
 * Parse `Host` entries from an OpenSSH config file.
 *
 * Only the main keywords we need for a host picker are recorded. `Include`
 * directives are ignored.
 */
export function parseSshConfigHosts(
  content: string
): ReadonlyArray<SshConfigHost> {
  const hosts = new Array<SshConfigHost>()
  let pendingAliases: string[] = []
  let current: {
    hostName?: string
    user?: string
    port?: number
  } = {}

  const flush = () => {
    for (const alias of pendingAliases) {
      if (wildcardHostRe.test(alias)) {
        continue
      }

      hosts.push({
        alias,
        hostName: current.hostName,
        user: current.user,
        port: current.port,
      })
    }

    pendingAliases = []
    current = {}
  }

  const lines = content.split(/\r?\n/)
  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (line.length === 0) {
      continue
    }

    const match = /^(Host|Hostname|HostName|User|Port)\s+(.+)$/i.exec(line)
    if (match === null) {
      continue
    }

    const keyword = match[1].toLowerCase()
    const value = match[2].trim().replace(/^"(.*)"$/, '$1')

    if (keyword === 'host') {
      flush()
      pendingAliases = value.split(/\s+/).filter(alias => alias.length > 0)
      continue
    }

    if (pendingAliases.length === 0) {
      continue
    }

    if (keyword === 'hostname') {
      current.hostName = value
    } else if (keyword === 'user') {
      current.user = value
    } else if (keyword === 'port') {
      const port = parseInt(value, 10)
      if (!isNaN(port)) {
        current.port = port
      }
    }
  }

  flush()
  return hosts
}

/** Load concrete `Host` aliases from `~/.ssh/config`. */
export async function getSshConfigHosts(): Promise<
  ReadonlyArray<SshConfigHost>
> {
  const configPath = join(homedir(), '.ssh', 'config')

  try {
    const content = await readFile(configPath, 'utf8')
    return parseSshConfigHosts(content)
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return []
    }

    log.warn('Could not read SSH config for repository host list', error)
    return []
  }
}
