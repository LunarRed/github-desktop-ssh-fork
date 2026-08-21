import * as Path from 'path'

/**
 * A Git working copy reached over SSH, e.g. `ssh host` plus a folder on
 * that host.
 */
export type SshRepositoryLocation = {
  readonly host: string
  readonly user?: string
  readonly port?: number
  /** POSIX path on the remote host. */
  readonly path: string
}

const windowsDriveRe = /^[a-zA-Z]:[\\/]/
const windowsUncRe = /^\\\\/

/**
 * Restore `ssh://` URLs that Node's win32 path helpers have rewritten, e.g.
 * `ssh:\host\path\to\repo` → `ssh://host/path/to/repo`.
 */
function coerceSshUrl(input: string): string {
  if (input.startsWith('ssh://')) {
    return input
  }

  if (/^ssh:[\\/]/.test(input)) {
    return input.replace(/^ssh:[\\/]+/, 'ssh://').replace(/\\/g, '/')
  }

  return input
}

/**
 * Parse a stored or typed SSH repository location.
 *
 * Accepts:
 *  - Canonical `ssh://[user@]host[:port]/abs/path`
 *  - SCP-style `[user@]host:path` (not a Windows drive letter)
 *  - Win32-mangled `ssh:\host\path` forms
 */
export function parseSshRepositoryPath(
  input: string
): SshRepositoryLocation | null {
  const trimmed = coerceSshUrl(input.trim())
  if (trimmed.length === 0) {
    return null
  }

  if (windowsDriveRe.test(trimmed) || windowsUncRe.test(trimmed)) {
    return null
  }

  if (trimmed.startsWith('ssh://')) {
    try {
      const url = new URL(trimmed)
      if (url.protocol !== 'ssh:') {
        return null
      }

      const host = url.hostname
      if (host.length === 0) {
        return null
      }

      const user =
        url.username.length > 0 ? decodeURIComponent(url.username) : undefined
      const port = url.port.length > 0 ? parseInt(url.port, 10) : undefined
      let path =
        url.pathname.length > 0 ? decodeURIComponent(url.pathname) : '/'

      // `ssh://host/~/path` means the home directory, not a literal `/~`
      // folder at the root.
      if (path === '/~' || path.startsWith('/~/')) {
        path = path.slice(1)
      }

      return {
        host,
        user,
        port: port !== undefined && !isNaN(port) ? port : undefined,
        path,
      }
    } catch {
      return null
    }
  }

  // SCP-like: [user@]host:path — reject single-letter hosts with a relative
  // path so `C:foo` is not treated as SSH.
  const scp = /^(?:([^@/\\]+)@)?([^/\\:]+):(.+)$/.exec(trimmed)
  if (scp === null) {
    return null
  }

  const user = scp[1]
  const host = scp[2]
  const path = scp[3]

  if (
    host.length === 1 &&
    /[a-zA-Z]/.test(host) &&
    !path.startsWith('/') &&
    !path.startsWith('~')
  ) {
    return null
  }

  return {
    host,
    user,
    path,
  }
}

/** Whether `path` identifies an SSH-hosted working copy. */
export function isSshRepositoryPath(path: string): boolean {
  return (
    parseSshRepositoryPath(path) !== null &&
    coerceSshUrl(path).startsWith('ssh://')
  )
}

/**
 * Return the canonical `ssh://host/path` form, or null if this is not an SSH
 * working-copy URL.
 *
 * `ssh://host/path/to/repo` is stored as-is (host `host`, path
 * `/path/to/repo`).
 */
export function canonicalizeSshRepositoryPath(input: string): string | null {
  if (!isSshRepositoryPath(input)) {
    return null
  }

  const parsed = parseSshRepositoryPath(input)
  return parsed === null ? null : formatSshRepositoryPath(parsed)
}

/**
 * Canonical storage form: `ssh://[user@]host[:port]/abs/path` or the
 * home-relative `ssh://[user@]host[:port]/~/path`.
 *
 * The remote path is stored as a URL path so `ssh://host/path/to/repo` means
 * host `host` and path `/path/to/repo`, while `ssh://host/~/path/to/repo`
 * means `~/path/to/repo` on the remote host.
 */
export function formatSshRepositoryPath(
  location: SshRepositoryLocation
): string {
  const user =
    location.user !== undefined && location.user.length > 0
      ? `${encodeURIComponent(location.user)}@`
      : ''
  const port = location.port !== undefined ? `:${location.port}` : ''
  // Home-relative paths are stored as `/~/...` in the URL and restored to
  // `~/...` when parsed; other relative paths are anchored at the root.
  const path = location.path.startsWith('/')
    ? location.path
    : `/${location.path}`

  return `ssh://${user}${location.host}${port}${path}`
}

/** Human-readable `host:/path` (or `user@host:/path`) form. */
export function formatSshRepositoryPathForDisplay(
  locationOrPath: SshRepositoryLocation | string
): string {
  const parsed =
    typeof locationOrPath === 'string'
      ? parseSshRepositoryPath(locationOrPath)
      : locationOrPath

  if (parsed === null) {
    return typeof locationOrPath === 'string'
      ? locationOrPath
      : formatSshRepositoryPath(locationOrPath)
  }

  const user =
    parsed.user !== undefined && parsed.user.length > 0 ? `${parsed.user}@` : ''
  const port = parsed.port !== undefined ? `:${parsed.port}` : ''
  return `${user}${parsed.host}${port}:${parsed.path}`
}

function posixParts(parts: ReadonlyArray<string>): ReadonlyArray<string> {
  return parts.map(part => part.replace(/\\/g, '/'))
}

/**
 * Join path segments onto a repository root. SSH locations keep their host
 * metadata; local paths use the platform path module.
 */
export function joinRepositoryPath(base: string, ...parts: string[]): string {
  const parsed = parseSshRepositoryPath(base)
  if (parsed !== null) {
    return formatSshRepositoryPath({
      ...parsed,
      path: Path.posix.join(parsed.path, ...posixParts(parts)),
    })
  }

  return Path.join(base, ...parts)
}

/**
 * Resolve path segments against a repository root. SSH locations use POSIX
 * resolution on the remote path; home-relative (`~`) paths are normalized
 * lexically without consulting the local working directory.
 */
export function resolveRepositoryPath(
  base: string,
  ...parts: string[]
): string {
  const parsed = parseSshRepositoryPath(base)
  if (parsed !== null) {
    return formatSshRepositoryPath({
      ...parsed,
      path: parsed.path.startsWith('~')
        ? Path.posix.join(parsed.path, ...posixParts(parts))
        : Path.posix.resolve(parsed.path, ...posixParts(parts)),
    })
  }

  return Path.resolve(base, ...parts)
}

/**
 * SSH destination string for the OpenSSH client (`user@host` or `host`).
 */
export function getSshDestination(location: SshRepositoryLocation): string {
  return location.user !== undefined && location.user.length > 0
    ? `${location.user}@${location.host}`
    : location.host
}
