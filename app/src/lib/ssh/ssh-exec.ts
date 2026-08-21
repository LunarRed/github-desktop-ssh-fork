import { spawn, ChildProcess } from 'child_process'
import { mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { ExecError } from 'dugite'
import { getSshBinaryPath, getSSHEnvironment } from './ssh'
import {
  getSshDestination,
  parseSshRepositoryPath,
  SshRepositoryLocation,
} from './ssh-path'

export type SshExecEncoding = BufferEncoding | 'buffer'

export type ISshExecOptions = {
  readonly env?: Record<string, string | undefined>
  readonly stdin?: string | Buffer
  readonly encoding?: SshExecEncoding
  readonly maxBuffer?: number
  readonly processCallback?: (process: ChildProcess) => void
  /**
   * Fail instead of prompting when a password or host-key confirmation would
   * be required. Used for background git status refreshes.
   */
  readonly batchMode?: boolean
  readonly requestTTY?: boolean
}

export type ISshExecResult = {
  readonly stdout: string | Buffer
  readonly stderr: string | Buffer
  readonly exitCode: number
}

/** Quote a single argument for a POSIX remote login shell. */
export function quotePosix(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

const controlDir = join(tmpdir(), 'github-desktop-ssh')
const controlPath = join(controlDir, '%C').replace(/\\/g, '/')

function buildSshArgs(
  location: SshRepositoryLocation,
  remoteCommand: string,
  options?: Pick<ISshExecOptions, 'batchMode' | 'requestTTY'>
): string[] {
  const args = ['-o', 'SendEnv=LANG', '-o', 'ConnectTimeout=15']

  // Windows OpenSSH does not support connection multiplexing, so the control
  // options are only used elsewhere.
  if (!__WIN32__) {
    args.push(
      '-o',
      'ControlMaster=auto',
      '-o',
      `ControlPath=${controlPath}`,
      '-o',
      'ControlPersist=600'
    )
  }

  if (options?.batchMode === true) {
    args.push('-o', 'BatchMode=yes')
  }

  if (options?.requestTTY === true) {
    args.push('-t')
  }

  if (location.port !== undefined) {
    args.push('-p', String(location.port))
  }

  args.push('--', getSshDestination(location), remoteCommand)
  return args
}

function decode(
  chunks: ReadonlyArray<Buffer>,
  encoding: SshExecEncoding | undefined
): string | Buffer {
  const buffer = Buffer.concat(chunks)
  if (encoding === 'buffer') {
    return buffer
  }

  return buffer.toString(encoding ?? 'utf8')
}

/**
 * Run a command on an SSH host using the user's OpenSSH client and config
 * (so `Host` aliases like `host` work).
 */
export async function execSsh(
  location: SshRepositoryLocation,
  remoteCommand: string,
  options?: ISshExecOptions
): Promise<ISshExecResult> {
  const sshPath = await getSshBinaryPath()
  const sshEnv = await getSSHEnvironment()
  await mkdir(controlDir, { recursive: true })
  const args = buildSshArgs(location, remoteCommand, options)
  const maxBuffer = options?.maxBuffer ?? 10 * 1024 * 1024

  return new Promise<ISshExecResult>((resolve, reject) => {
    const child = spawn(sshPath, args, {
      env: {
        ...process.env,
        ...sshEnv,
        ...options?.env,
        TERM: 'dumb',
      },
      windowsHide: true,
    })

    // When the caller wants to observe the process (e.g. progress parsers)
    // expose text streams like dugite does, so callbacks receive strings
    // instead of raw buffers. Collected chunks are converted back to buffers
    // below so the result semantics are unchanged.
    const exposeTextStreams = options?.processCallback !== undefined
    if (exposeTextStreams) {
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
    }

    options?.processCallback?.(child)

    const stdoutChunks = new Array<Buffer>()
    const stderrChunks = new Array<Buffer>()
    let stdoutLength = 0
    let stderrLength = 0
    let exceededMaxBuffer = false

    const toBuffer = (chunk: Buffer | string) =>
      typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk

    const onChunk = (target: Array<Buffer>, length: { n: number }) => {
      return (chunk: Buffer | string) => {
        const buffer = toBuffer(chunk)
        length.n += buffer.length
        if (length.n > maxBuffer) {
          exceededMaxBuffer = true
          child.kill()
          return
        }
        target.push(buffer)
      }
    }

    const stdoutLen = { n: 0 }
    const stderrLen = { n: 0 }

    child.stdout?.on('data', (chunk: Buffer | string) => {
      onChunk(stdoutChunks, stdoutLen)(chunk)
      stdoutLength = stdoutLen.n
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      onChunk(stderrChunks, stderrLen)(chunk)
      stderrLength = stderrLen.n
    })

    if (options?.stdin !== undefined) {
      child.stdin?.end(options.stdin)
    } else {
      child.stdin?.end()
    }

    child.on('error', reject)
    child.on('close', exitCode => {
      if (exceededMaxBuffer) {
        reject(
          new ExecError(
            `stdout or stderr maxBuffer length exceeded (${maxBuffer} bytes; stdout=${stdoutLength}, stderr=${stderrLength})`,
            Buffer.concat(stdoutChunks),
            Buffer.concat(stderrChunks)
          )
        )
        return
      }

      resolve({
        stdout: decode(stdoutChunks, options?.encoding),
        stderr: decode(stderrChunks, options?.encoding),
        exitCode: exitCode ?? 1,
      })
    })
  })
}

/**
 * Spawn SSH so callers can stream stdout/stderr (progress parsers).
 */
export async function spawnSsh(
  location: SshRepositoryLocation,
  remoteCommand: string,
  options?: ISshExecOptions
): Promise<ChildProcess> {
  const sshPath = await getSshBinaryPath()
  const sshEnv = await getSSHEnvironment()
  await mkdir(controlDir, { recursive: true })
  const args = buildSshArgs(location, remoteCommand, options)

  const child = spawn(sshPath, args, {
    env: {
      ...process.env,
      ...sshEnv,
      ...options?.env,
      TERM: 'dumb',
    },
    windowsHide: true,
  })

  // Mirror dugite's behaviour of exposing text streams so consumers such as
  // progress parsers receive strings instead of raw buffers.
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')

  options?.processCallback?.(child)
  return child
}

export function requireSshLocation(path: string): SshRepositoryLocation {
  const parsed = parseSshRepositoryPath(path)
  if (parsed === null) {
    throw new Error(`Expected an SSH repository path, got '${path}'`)
  }
  return parsed
}

/** The kind of shell the remote side runs our commands in. */
export type SshShellKind = 'posix' | 'windows'

const shellKindCache = new Map<string, SshShellKind>()

const shellKindCacheKey = (location: SshRepositoryLocation) =>
  `${location.user ?? ''}@${location.host}:${location.port ?? 22}`

/**
 * Detect which command dialect the remote host speaks. Probed with `uname`,
 * which exists on POSIX systems (and POSIX shells such as Git Bash on
 * Windows) and fails on cmd.exe/PowerShell. The result is cached per host.
 */
export async function getRemoteShellKind(
  location: SshRepositoryLocation
): Promise<SshShellKind> {
  const key = shellKindCacheKey(location)
  const cached = shellKindCache.get(key)
  if (cached !== undefined) {
    return cached
  }

  const result = await execSsh(location, 'uname')
  const kind: SshShellKind = result.exitCode === 0 ? 'posix' : 'windows'
  shellKindCache.set(key, kind)
  return kind
}

/** Quote a single argument for a Windows (cmd.exe) remote command line. */
export function quoteCmd(arg: string): string {
  return `"${arg.replace(/"/g, '""')}"`
}
