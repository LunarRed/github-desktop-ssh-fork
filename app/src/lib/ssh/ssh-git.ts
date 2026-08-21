import { ChildProcess } from 'child_process'
import {
  IGitExecutionOptions as DugiteExecutionOptions,
  IGitResult as DugiteResult,
} from 'dugite'
import { execSsh, quotePosix, requireSshLocation, spawnSsh } from './ssh-exec'
import { withResolvedSshLocation } from './ssh-fs'

function buildRemoteGitCommand(
  remotePath: string,
  gitArgs: ReadonlyArray<string>
) {
  return ['git', '-C', remotePath, ...gitArgs].map(quotePosix).join(' ')
}

/**
 * Run git on the remote host. Trampoline env (credential helper, local
 * askpass paths) is not forwarded — remote git uses the remote's own
 * credentials and hooks.
 */
export async function execGitOverSsh(
  args: string[],
  path: string,
  options?: DugiteExecutionOptions
): Promise<DugiteResult> {
  const location = await withResolvedSshLocation(requireSshLocation(path))
  const batchMode =
    options !== undefined &&
    'isBackgroundTask' in options &&
    (options as { isBackgroundTask?: boolean }).isBackgroundTask === true
  const result = await execSsh(
    location,
    buildRemoteGitCommand(location.path, args),
    {
      stdin: options?.stdin,
      encoding: options?.encoding,
      maxBuffer: options?.maxBuffer,
      processCallback: options?.processCallback,
      batchMode,
      env: {
        // Keep TERM dumb on the remote as well so git does not emit
        // interactive progress sequences we cannot render.
        TERM: 'dumb',
      },
    }
  )

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  }
}

export async function spawnGitOverSsh(
  args: string[],
  path: string,
  options?: DugiteExecutionOptions
): Promise<ChildProcess> {
  const location = await withResolvedSshLocation(requireSshLocation(path))
  return spawnSsh(location, buildRemoteGitCommand(location.path, args), {
    encoding: options?.encoding,
    processCallback: options?.processCallback,
    env: { TERM: 'dumb' },
  })
}
