import { spawn } from 'child_process'
import { getSshBinaryPath } from './ssh'
import {
  getSshDestination,
  parseSshRepositoryPath,
  SshRepositoryLocation,
} from './ssh-path'
import { quotePosix } from './ssh-exec'
import { withResolvedSshLocation } from './ssh-fs'

function buildInteractiveSshArgs(location: SshRepositoryLocation): string[] {
  const args = new Array<string>()
  if (location.port !== undefined) {
    args.push('-p', String(location.port))
  }
  args.push(
    '-t',
    getSshDestination(location),
    `cd ${quotePosix(location.path)} && exec \${SHELL:-/bin/bash} -l`
  )
  return args
}

/**
 * Open an interactive SSH session in a new terminal at the remote working copy.
 */
export async function launchSshSession(path: string): Promise<void> {
  const parsed = parseSshRepositoryPath(path)
  if (parsed === null) {
    throw new Error(`Not an SSH repository path: ${path}`)
  }

  const location = await withResolvedSshLocation(parsed)
  const sshPath = await getSshBinaryPath()
  const args = buildInteractiveSshArgs(location)

  if (__WIN32__) {
    spawn(
      process.env.COMSPEC ?? 'cmd.exe',
      ['/c', 'start', `"${getSshDestination(location)}"`, sshPath, ...args],
      { detached: true, windowsHide: false }
    ).unref()
    return
  }

  if (__DARWIN__) {
    const command = [sshPath, ...args]
      .map(part => part.replace(/"/g, '\\"'))
      .map(part => `"${part}"`)
      .join(' ')
    spawn(
      'osascript',
      [
        '-e',
        `tell application "Terminal" to do script ${JSON.stringify(command)}`,
      ],
      { detached: true }
    ).unref()
    return
  }

  spawn('x-terminal-emulator', ['-e', sshPath, ...args], {
    detached: true,
  }).unref()
}

const remoteEditorNameRe =
  /visual studio code|vscodium|cursor|windsurf|code - oss/i

export function editorSupportsSshRemote(editorName: string): boolean {
  return remoteEditorNameRe.test(editorName)
}

/** vscode-remote URI for a folder or file on an SSH host. */
export function getSshEditorUri(location: SshRepositoryLocation): string {
  return `vscode-remote://ssh-remote+${location.host}${location.path}`
}
