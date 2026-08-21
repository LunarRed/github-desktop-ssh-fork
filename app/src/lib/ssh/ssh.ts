import memoizeOne from 'memoize-one'
import { access } from 'fs/promises'
import { resolve } from 'path'
import { getBoolean } from '../local-storage'
import { getDesktopAskpassTrampolineFilename } from 'desktop-trampoline'

const WindowsOpenSSHPath = 'C:/Windows/System32/OpenSSH/ssh.exe'

/** Returns the path of the desktop-askpass-trampoline binary. */
export function getDesktopAskpassTrampolinePath(): string {
  return resolve(__dirname, 'desktop-trampoline', getDesktopAskpassTrampolineFilename())
}

/** Returns the path of the ssh-wrapper binary. */
export function getSSHWrapperPath(): string {
  return resolve(__dirname, 'desktop-trampoline', 'ssh-wrapper')
}

export const UseWindowsOpenSSHKey: string = 'useWindowsOpenSSH'

const localPathExists = (path: string) =>
  access(path).then(
    () => true,
    () => false
  )

export const isWindowsOpenSSHAvailable = memoizeOne(
  async (): Promise<boolean> => {
    if (!__WIN32__) {
      return false
    }

    // FIXME: for now, seems like we can't use Windows' OpenSSH binary on Windows
    // for ARM.
    if (process.arch === 'arm64') {
      return false
    }

    return await localPathExists(WindowsOpenSSHPath)
  }
)

/**
 * Path to the ssh executable used to open a working copy on another host.
 *
 * Prefers Windows OpenSSH when it is present so we do not depend on Git's
 * bundled ssh being on PATH. Falls back to `ssh`.
 */
export const getSshBinaryPath = memoizeOne(async (): Promise<string> => {
  if (__WIN32__ && (await localPathExists(WindowsOpenSSHPath))) {
    return WindowsOpenSSHPath
  }

  return 'ssh'
})

// HACK: The purpose of this function is to wrap `getBoolean` inside a try/catch
// block, because for some reason, accessing localStorage from tests sometimes
// fails.
function isWindowsOpenSSHUseEnabled() {
  try {
    return getBoolean(UseWindowsOpenSSHKey, false)
  } catch (e) {
    return false
  }
}

/**
 * Returns the git environment variables related to SSH depending on the current
 * context (OS and user settings).
 */
export async function getSSHEnvironment() {
  const baseEnv = {
    SSH_ASKPASS: getDesktopAskpassTrampolinePath(),
    // DISPLAY needs to be set to _something_ so ssh actually uses SSH_ASKPASS
    DISPLAY: '.',
  }

  const canUseWindowsSSH = await isWindowsOpenSSHAvailable()
  if (canUseWindowsSSH && isWindowsOpenSSHUseEnabled()) {
    // Replace git ssh command with Windows' OpenSSH executable path
    return {
      ...baseEnv,
      GIT_SSH_COMMAND: WindowsOpenSSHPath,
    }
  }

  if (__DARWIN__ && __DEV__) {
    // Replace git ssh command with our wrapper in dev builds, since they are
    // launched from a command line.
    return {
      ...baseEnv,
      GIT_SSH_COMMAND: `"${getSSHWrapperPath()}"`,
    }
  }

  return baseEnv
}

export function parseAddSSHHostPrompt(prompt: string) {
  const promptRegex =
    /^The authenticity of host '([^ ]+) \(([^\)]+)\)' can't be established[^.]*\.\n([^ ]+) key fingerprint is ([^.]+)\./

  const matches = promptRegex.exec(prompt)
  if (matches === null || matches.length < 5) {
    return null
  }

  return {
    host: matches[1],
    ip: matches[2],
    keyType: matches[3],
    fingerprint: matches[4],
  }
}
