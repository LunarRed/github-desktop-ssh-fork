import * as Fs from 'fs/promises'
import { posix } from 'path'
import {
  execSsh,
  getRemoteShellKind,
  quoteCmd,
  quotePosix,
  requireSshLocation,
} from './ssh-exec'
import {
  formatSshRepositoryPath,
  isSshRepositoryPath,
  parseSshRepositoryPath,
  SshRepositoryLocation,
} from './ssh-path'

export type SshDirectoryEntry = {
  readonly name: string
  readonly path: string
}

const remoteTest = async (
  location: SshRepositoryLocation,
  flag: '-e' | '-d' | '-f'
): Promise<boolean> => {
  const resolved = await withResolvedSshLocation(location)
  const result = await execSsh(
    resolved,
    `test ${flag} ${quotePosix(resolved.path)}`
  )
  return result.exitCode === 0
}

export async function sshPathExists(path: string): Promise<boolean> {
  const location = parseSshRepositoryPath(path)
  if (location === null) {
    return false
  }

  try {
    return await remoteTest(location, '-e')
  } catch (error) {
    log.debug(`sshPathExists failed for ${path}`, error)
    return false
  }
}

export async function sshDirectoryExists(path: string): Promise<boolean> {
  const location = parseSshRepositoryPath(path)
  if (location === null) {
    return false
  }

  try {
    return await remoteTest(location, '-d')
  } catch (error) {
    log.debug(`sshDirectoryExists failed for ${path}`, error)
    return false
  }
}

async function sshReadFile(path: string): Promise<Buffer>
async function sshReadFile(
  path: string,
  encoding: BufferEncoding
): Promise<string>
async function sshReadFile(
  path: string,
  encoding?: BufferEncoding
): Promise<string | Buffer> {
  const resolved = await withResolvedSshLocation(requireSshLocation(path))
  const result = await execSsh(resolved, `cat ${quotePosix(resolved.path)}`, {
    encoding: 'buffer',
  })

  if (result.exitCode !== 0) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString('utf8')
      : result.stderr
    const error = new Error(
      stderr.trim() || `Failed to read ${path} over SSH`
    ) as NodeJS.ErrnoException
    error.code = 'ENOENT'
    throw error
  }

  const buffer = Buffer.isBuffer(result.stdout)
    ? result.stdout
    : Buffer.from(result.stdout)

  return encoding !== undefined ? buffer.toString(encoding) : buffer
}

async function sshWriteFile(
  path: string,
  contents: string | Buffer
): Promise<void> {
  const resolved = await withResolvedSshLocation(requireSshLocation(path))
  const result = await execSsh(resolved, `cat > ${quotePosix(resolved.path)}`, {
    stdin: contents,
  })

  if (result.exitCode !== 0) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString('utf8')
      : result.stderr
    throw new Error(stderr.trim() || `Failed to write ${path} over SSH`)
  }
}

async function sshUnlink(path: string): Promise<void> {
  const resolved = await withResolvedSshLocation(requireSshLocation(path))
  const command =
    (await getRemoteShellKind(resolved)) === 'posix'
      ? `rm -f ${quotePosix(resolved.path)}`
      : `del /f /q ${quoteCmd(resolved.path)}`
  const result = await execSsh(resolved, command)
  if (result.exitCode !== 0) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString('utf8')
      : result.stderr
    throw new Error(stderr.trim() || `Failed to remove ${path} over SSH`)
  }
}

async function sshRm(
  path: string,
  options?: { recursive?: boolean; force?: boolean }
): Promise<void> {
  const resolved = await withResolvedSshLocation(requireSshLocation(path))
  const command =
    (await getRemoteShellKind(resolved)) === 'posix'
      ? `rm -${options?.recursive === true ? 'r' : ''}f ${quotePosix(
          resolved.path
        )}`
      : options?.recursive === true
      ? `rd /s /q ${quoteCmd(resolved.path)}`
      : `del /f /q ${quoteCmd(resolved.path)}`
  const result = await execSsh(resolved, command)
  if (result.exitCode !== 0) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString('utf8')
      : result.stderr
    throw new Error(stderr.trim() || `Failed to remove ${path} over SSH`)
  }
}

async function sshStat(path: string): Promise<{
  size: number
  mtime: Date
  isDirectory(): boolean
  isFile(): boolean
}> {
  const resolved = await withResolvedSshLocation(requireSshLocation(path))
  const result = await execSsh(
    resolved,
    `if [ -d ${quotePosix(
      resolved.path
    )} ]; then printf 'd '; elif [ -f ${quotePosix(
      resolved.path
    )} ]; then printf 'f '; else printf 'u '; fi; date -r ${quotePosix(
      resolved.path
    )} +%s 2>/dev/null || printf '0'; printf ' '; wc -c < ${quotePosix(
      resolved.path
    )}`
  )

  if (result.exitCode !== 0) {
    const error = new Error(
      `Failed to stat ${path} over SSH`
    ) as NodeJS.ErrnoException
    error.code = 'ENOENT'
    throw error
  }

  const stdout = Buffer.isBuffer(result.stdout)
    ? result.stdout.toString('utf8')
    : result.stdout
  const [kind, mtimeStr, sizeStr] = stdout.trim().split(/\s+/)
  const size = parseInt(sizeStr, 10)
  const mtimeSeconds = parseInt(mtimeStr, 10)

  return {
    size: isNaN(size) ? 0 : size,
    mtime: isNaN(mtimeSeconds) ? new Date(0) : new Date(mtimeSeconds * 1000),
    isDirectory: () => kind === 'd',
    isFile: () => kind === 'f',
  }
}

/** Expand `~` and relative remote paths against `$HOME` on the host. */
export async function resolveSshLocation(
  location: SshRepositoryLocation
): Promise<SshRepositoryLocation> {
  let remotePath = location.path

  if (
    remotePath === '~' ||
    remotePath.startsWith('~/') ||
    !remotePath.startsWith('/')
  ) {
    const homeResult = await execSsh(location, `printf '%s\\n' "$HOME"`)
    const home =
      (Buffer.isBuffer(homeResult.stdout)
        ? homeResult.stdout.toString('utf8')
        : homeResult.stdout
      ).trim() || '/'

    if (remotePath === '~' || remotePath.length === 0) {
      remotePath = home
    } else if (remotePath.startsWith('~/')) {
      remotePath = posix.join(home, remotePath.slice(2))
    } else if (!remotePath.startsWith('/')) {
      remotePath = posix.join(home, remotePath)
    }
  }

  return { ...location, path: remotePath }
}

/**
 * Resolve a location only when needed, i.e. when its path is home-relative or
 * relative. Absolute paths are returned untouched so no extra SSH round trip
 * is made.
 */
export async function withResolvedSshLocation(
  location: SshRepositoryLocation
): Promise<SshRepositoryLocation> {
  return location.path.startsWith('/') || location.path.length === 0
    ? location
    : resolveSshLocation(location)
}

export async function getRemoteHomeDirectory(
  location: SshRepositoryLocation
): Promise<string> {
  const resolved = await resolveSshLocation({ ...location, path: '~' })
  return resolved.path
}

/**
 * List immediate subdirectories of a remote folder (for the SSH folder picker).
 */
export async function listSshDirectories(
  location: SshRepositoryLocation
): Promise<ReadonlyArray<SshDirectoryEntry>> {
  const resolved = await resolveSshLocation(location)
  const script = [
    `cd ${quotePosix(resolved.path)} || exit 1`,
    'for p in .[!.]* *; do',
    '  [ -e "$p" ] || continue',
    '  [ -d "$p" ] || continue',
    '  printf "%s\\n" "$p"',
    'done',
  ].join('\n')

  const result = await execSsh(resolved, script)
  if (result.exitCode !== 0) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString('utf8')
      : result.stderr
    throw new Error(
      stderr.trim() || `Could not list ${formatSshRepositoryPath(resolved)}`
    )
  }

  const stdout = Buffer.isBuffer(result.stdout)
    ? result.stdout.toString('utf8')
    : result.stdout

  return stdout
    .split('\n')
    .map(name => name.trim())
    .filter(name => name.length > 0 && name !== '.' && name !== '..')
    .sort((a, b) => a.localeCompare(b))
    .map(name => ({
      name,
      path: posix.join(resolved.path, name),
    }))
}

export async function readFile(path: string): Promise<Buffer>
export async function readFile(
  path: string,
  encoding: BufferEncoding
): Promise<string>
export async function readFile(
  path: string,
  encoding?: BufferEncoding
): Promise<string | Buffer> {
  if (isSshRepositoryPath(path)) {
    return encoding !== undefined
      ? sshReadFile(path, encoding)
      : sshReadFile(path)
  }

  return encoding !== undefined
    ? Fs.readFile(path, encoding)
    : Fs.readFile(path)
}

export async function writeFile(
  path: string,
  contents: string | Buffer
): Promise<void> {
  if (isSshRepositoryPath(path)) {
    return sshWriteFile(path, contents)
  }

  await Fs.writeFile(path, contents)
}

export async function unlink(path: string): Promise<void> {
  if (isSshRepositoryPath(path)) {
    return sshUnlink(path)
  }

  await Fs.unlink(path)
}

export async function rm(
  path: string,
  options?: { recursive?: boolean; force?: boolean }
): Promise<void> {
  if (isSshRepositoryPath(path)) {
    return sshRm(path, options)
  }

  await Fs.rm(path, options)
}

export async function stat(path: string) {
  if (isSshRepositoryPath(path)) {
    return sshStat(path)
  }

  return Fs.stat(path)
}
