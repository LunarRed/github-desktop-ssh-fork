import * as Fs from 'fs/promises'
import * as Path from 'path'

import { readPartialFile } from './file-system'
import {
  sshDirectoryExists,
  sshPathExists,
  readFile as sshReadFile,
  rm as sshRm,
  stat as sshStat,
  unlink as sshUnlink,
  writeFile as sshWriteFile,
} from './ssh/ssh-fs'
import {
  isSshRepositoryPath,
  joinRepositoryPath,
  resolveRepositoryPath,
} from './ssh/ssh-path'

/** How the working copy is reached from this machine. */
export type GitDirProtocol = 'file' | 'ssh'

export interface IGitDirFileStat {
  readonly size: number
  readonly mtime: Date
  isDirectory(): boolean
  isFile(): boolean
}

/**
 * Operations that only make sense on the local machine. UI can use these to
 * hide or disable menu entries which cannot work for a given protocol.
 */
export interface IGitDirCapabilities {
  /** Reveal files or folders in the OS file manager. */
  readonly fileManager: boolean
  /**
   * Move items to the OS trash. When false, destructive flows must fall back
   * to a permanent delete (after confirmation).
   */
  readonly trash: boolean
  /** Open files with their default associated program. */
  readonly defaultProgram: boolean
  /** Open files in the configured external editor (e.g. VS Code over SSH). */
  readonly externalEditor: boolean
}

/**
 * What each protocol can do on this machine. Anything not listed for a
 * protocol is unsupported there and should be hidden or disabled in the UI.
 */
export const capabilitiesByProtocol: Record<
  GitDirProtocol,
  IGitDirCapabilities
> = {
  file: {
    fileManager: true,
    trash: true,
    defaultProgram: true,
    externalEditor: true,
  },
  ssh: {
    fileManager: false,
    // No local Recycle Bin for remote files — discarding permanently
    // removes them on the host after confirmation.
    trash: false,
    defaultProgram: false,
    // Editors with SSH remote support (VS Code, Cursor, VSCodium) can
    // open remote files, so opening files remains possible.
    externalEditor: true,
  },
}

/**
 * Filesystem access for a Git working copy. Implementations understand the
 * protocol of the git dir so callers never have to — a segment like
 * `.git/description` resolves against the working copy root whether it lives
 * on the local disk or on a remote SSH host.
 */
export interface IGitDirFileSystem {
  readonly protocol: GitDirProtocol
  /** What operations this protocol supports on this machine. */
  readonly capabilities: IGitDirCapabilities
  /** The working copy root, in canonical protocol-aware form. */
  readonly repositoryPath: string

  /** Absolute, protocol-aware path for segments relative to the root. */
  path(...segments: string[]): string

  /** Like `path`, but resolves `..`/`.` segments lexically. */
  resolve(...segments: string[]): string

  readFile(segment: string): Promise<Buffer>
  readFile(segment: string, encoding: BufferEncoding): Promise<string>

  writeFile(
    segment: string,
    contents: string | Buffer,
    encoding?: BufferEncoding
  ): Promise<void>

  unlink(segment: string): Promise<void>

  rm(
    segment: string,
    options?: { recursive?: boolean; force?: boolean }
  ): Promise<void>

  stat(segment: string): Promise<IGitDirFileStat>

  /** Read a byte range of a file (used for syntax highlighting probes). */
  readPartialFile(segment: string, start: number, end: number): Promise<Buffer>

  /** Whether a file or directory exists at the given segment. */
  exists(segment: string): Promise<boolean>

  /** Whether the given segment is an existing directory. */
  directoryExists(segment: string): Promise<boolean>
}

class LocalGitDirFileSystem implements IGitDirFileSystem {
  public readonly protocol: GitDirProtocol = 'file'
  public readonly capabilities: IGitDirCapabilities =
    capabilitiesByProtocol.file

  public constructor(public readonly repositoryPath: string) {}

  public path(...segments: string[]): string {
    return Path.join(this.repositoryPath, ...segments)
  }

  public resolve(...segments: string[]): string {
    return Path.resolve(this.repositoryPath, ...segments)
  }

  public readFile(segment: string): Promise<Buffer>
  public readFile(segment: string, encoding: BufferEncoding): Promise<string>
  public readFile(
    segment: string,
    encoding?: BufferEncoding
  ): Promise<string | Buffer> {
    return encoding !== undefined
      ? Fs.readFile(this.path(segment), encoding)
      : Fs.readFile(this.path(segment))
  }

  public writeFile(
    segment: string,
    contents: string | Buffer,
    encoding?: BufferEncoding
  ): Promise<void> {
    return sshWriteFile(this.path(segment), contents)
  }

  public async unlink(segment: string): Promise<void> {
    await Fs.unlink(this.path(segment))
  }

  public async rm(
    segment: string,
    options?: { recursive?: boolean; force?: boolean }
  ): Promise<void> {
    await Fs.rm(this.path(segment), options)
  }

  public async stat(segment: string): Promise<IGitDirFileStat> {
    return Fs.stat(this.path(segment))
  }

  public readPartialFile(
    segment: string,
    start: number,
    end: number
  ): Promise<Buffer> {
    return readPartialFile(this.path(segment), start, end)
  }

  public async exists(segment: string): Promise<boolean> {
    try {
      await Fs.access(this.path(segment))
      return true
    } catch {
      return false
    }
  }

  public async directoryExists(segment: string): Promise<boolean> {
    try {
      const s = await Fs.stat(this.path(segment))
      return s.isDirectory()
    } catch {
      return false
    }
  }
}

class SshGitDirFileSystem implements IGitDirFileSystem {
  public readonly protocol: GitDirProtocol = 'ssh'
  public readonly capabilities: IGitDirCapabilities = capabilitiesByProtocol.ssh

  public constructor(public readonly repositoryPath: string) {}

  public path(...segments: string[]): string {
    return joinRepositoryPath(this.repositoryPath, ...segments)
  }

  public resolve(...segments: string[]): string {
    return resolveRepositoryPath(this.repositoryPath, ...segments)
  }

  public readFile(segment: string): Promise<Buffer>
  public readFile(segment: string, encoding: BufferEncoding): Promise<string>
  public readFile(
    segment: string,
    encoding?: BufferEncoding
  ): Promise<string | Buffer> {
    return sshReadFile(this.path(segment), encoding as BufferEncoding)
  }

  public writeFile(segment: string, contents: string | Buffer): Promise<void> {
    return sshWriteFile(this.path(segment), contents)
  }

  public unlink(segment: string): Promise<void> {
    return sshUnlink(this.path(segment))
  }

  public rm(
    segment: string,
    options?: { recursive?: boolean; force?: boolean }
  ): Promise<void> {
    return sshRm(this.path(segment), options)
  }

  public stat(segment: string): Promise<IGitDirFileStat> {
    return sshStat(this.path(segment))
  }

  public async readPartialFile(
    segment: string,
    start: number,
    end: number
  ): Promise<Buffer> {
    const contents = await sshReadFile(this.path(segment))
    const buffer = Buffer.isBuffer(contents) ? contents : Buffer.from(contents)
    return buffer.subarray(start, end + 1)
  }

  public exists(segment: string): Promise<boolean> {
    return sshPathExists(this.path(segment))
  }

  public directoryExists(segment: string): Promise<boolean> {
    return sshDirectoryExists(this.path(segment))
  }
}

const cache = new Map<string, IGitDirFileSystem>()

/**
 * Get the filesystem for a working copy. The returned object understands the
 * protocol of the git dir; callers work in working-copy-relative segments and
 * never need to know how the working copy is reached.
 */
export function fileSystemFor(repositoryPath: string): IGitDirFileSystem {
  const cached = cache.get(repositoryPath)
  if (cached !== undefined) {
    return cached
  }

  const fs = isSshRepositoryPath(repositoryPath)
    ? new SshGitDirFileSystem(repositoryPath)
    : new LocalGitDirFileSystem(repositoryPath)

  cache.set(repositoryPath, fs)
  return fs
}

/**
 * Protocol-aware absolute path for a file inside a working copy. Convenience
 * for call sites that only need the path (clipboard, menus, launching apps)
 * rather than file contents.
 */
export const repositoryFilePath = (
  repositoryPath: string,
  ...segments: string[]
): string => fileSystemFor(repositoryPath).path(...segments)
