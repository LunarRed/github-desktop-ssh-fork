import assert from 'node:assert'
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test'
import {
  parseSshRepositoryPath,
  type SshRepositoryLocation,
} from '../../../src/lib/ssh/ssh-path'
import type { ISshExecResult } from '../../../src/lib/ssh/ssh-exec'
import type { TestRepositoriesDatabase } from '../../helpers/databases/test-repositories-database'
import type { RepositoriesStore } from '../../../src/lib/stores/repositories-store'

const mainPath = '/srv/desktop-remote-worktree-test/main repo'
const linkedPath = '/srv/desktop-remote-worktree-test/feature worktree'
const linkedGitDir = `${mainPath}/.git/worktrees/feature-worktree`
const porcelain =
  [
    [`worktree ${mainPath}`, 'HEAD abc123', 'branch refs/heads/main'].join(
      '\0'
    ),
    [`worktree ${linkedPath}`, 'HEAD def456', 'branch refs/heads/feature'].join(
      '\0'
    ),
  ].join('\0\0') + '\0'

let worktree: typeof import('../../../src/lib/git/worktree')
let getRepositoryType: typeof import('../../../src/lib/git/rev-parse').getRepositoryType
let Repository: typeof import('../../../src/models/repository').Repository
let Database: typeof import('../../helpers/databases/test-repositories-database').TestRepositoriesDatabase
let Store: typeof import('../../../src/lib/stores/repositories-store').RepositoriesStore
let db: TestRepositoriesDatabase
let store: RepositoriesStore
let calls: Array<{ location: SshRepositoryLocation; command: string }> = []
let missingPaths = new Set<string>()
let listingOutput = porcelain

describe('SSH worktrees', () => {
  before(async () => {
    const sshExec = await import('../../../src/lib/ssh/ssh-exec')
    // Only the SSH process is replaced. Listing, repository validation,
    // filesystem routing, path resolution, and persistence run normally.
    mock.module('../../../src/lib/ssh/ssh-exec', {
      namedExports: {
        ...sshExec,
        execSsh: async (
          location: SshRepositoryLocation,
          command: string
        ): Promise<ISshExecResult> => {
          calls.push({ location, command })
          if (command.startsWith('test ')) {
            return {
              stdout: '',
              stderr: '',
              exitCode: missingPaths.has(location.path) ? 1 : 0,
            }
          }
          if (command.endsWith("'worktree' 'list' '--porcelain' '-z'")) {
            return { stdout: listingOutput, stderr: '', exitCode: 0 }
          }
          if (
            command.endsWith(
              "'rev-parse' '--is-bare-repository' '--show-cdup' '--git-dir'"
            )
          ) {
            const gitDir =
              location.path === mainPath ? `${mainPath}/.git` : linkedGitDir
            return { stdout: `false\n\n${gitDir}\n`, stderr: '', exitCode: 0 }
          }
          assert.match(command, /'worktree' '(add|remove|move)'/)
          return { stdout: '', stderr: '', exitCode: 0 }
        },
      },
    })

    worktree = await import('../../../src/lib/git/worktree')
    ;({ getRepositoryType } = await import('../../../src/lib/git/rev-parse'))
    ;({ Repository } = await import('../../../src/models/repository'))
    ;({ TestRepositoriesDatabase: Database } = await import(
      '../../helpers/databases/test-repositories-database'
    ))
    ;({ RepositoriesStore: Store } = await import(
      '../../../src/lib/stores/repositories-store'
    ))
  })

  beforeEach(async () => {
    calls = []
    missingPaths = new Set()
    listingOutput = porcelain
    db = new Database()
    await db.reset()
    store = new Store(db)
  })

  afterEach(() => db.close())

  for (const authority of ['build-box', 'darren@build-box:2222']) {
    const mainUrl = `ssh://${authority}${mainPath}`
    const linkedUrl = `ssh://${authority}${linkedPath}`
    const gitDirUrl = `ssh://${authority}${linkedGitDir}`

    it(`selects a listed worktree and returns to main using ${authority}`, async () => {
      const main = await store.addRepository(mainUrl, `${mainUrl}/.git`)
      const entries = await worktree.listWorktrees(main)
      assert.deepStrictEqual(
        entries.map(entry => entry.path),
        [mainUrl, linkedUrl]
      )

      const type = await getRepositoryType(entries[1].path)
      assert.strictEqual(type.kind, 'regular')
      if (type.kind !== 'regular') {
        return
      }
      assert.strictEqual(type.topLevelWorkingDirectory, linkedUrl)
      assert.strictEqual(type.gitDir, gitDirUrl)

      await store.switchWorktree(
        main,
        type.topLevelWorkingDirectory,
        false,
        type.gitDir,
        entries[0].path
      )
      const [selected] = await store.getAll()
      assert.strictEqual(selected.path, linkedUrl)
      assert.strictEqual(selected.mainWorktreePath, mainUrl)

      const resolvedMain = await worktree.resolveMainWorktreePath(selected)
      assert.strictEqual(resolvedMain, mainUrl)
      const mainType = await getRepositoryType(resolvedMain!)
      assert.strictEqual(mainType.kind, 'regular')
      if (mainType.kind !== 'regular') {
        return
      }
      await store.switchWorktree(
        selected,
        mainType.topLevelWorkingDirectory,
        false,
        mainType.gitDir,
        resolvedMain!
      )
      const [returned] = await store.getAll()
      assert.strictEqual(returned.path, mainUrl)
      assert.strictEqual(returned.gitDir, `${mainUrl}/.git`)
      assert.strictEqual(await worktree.resolveMainWorktreePath(returned), null)
      assert(calls.every(call => call.location.host === 'build-box'))
      assert(
        calls.every(
          call =>
            call.location.user ===
              (authority.includes('@') ? 'darren' : undefined) &&
            call.location.port === (authority.includes(':') ? 2222 : undefined)
        )
      )
    })
  }

  const authority = 'darren@build-box:2222'
  const mainUrl = `ssh://${authority}${mainPath}`
  const linkedUrl = `ssh://${authority}${linkedPath}`
  const gitDirUrl = `ssh://${authority}${linkedGitDir}`

  for (const [name, physicalPath] of [
    ['backslash', '/srv/worktree\\literal'],
    ['newline', '/srv/worktree\nliteral'],
    ['tab', '/srv/worktree\tliteral'],
    ['carriage return', '/srv/worktree\rliteral'],
  ]) {
    it(`retains the exact remote folder with a literal ${name} in a listed filename`, () => {
      const entries = worktree.parseWorktreePorcelainOutput(
        [
          `worktree ${physicalPath}`,
          'HEAD abc123',
          'branch refs/heads/main',
        ].join('\0') + '\0',
        mainUrl
      )
      assert.strictEqual(
        parseSshRepositoryPath(entries[0].path)?.path,
        physicalPath
      )
    })
  }

  it('lists from a remote git dir using a server-local --git-dir argument', async () => {
    const entries = await worktree.listWorktreesFromGitDir(gitDirUrl)
    assert.strictEqual(
      calls[0].command,
      `'git' '-C' '${linkedGitDir}' '--git-dir' '${linkedGitDir}' 'worktree' 'list' '--porcelain' '-z'`
    )
    assert.deepStrictEqual(
      entries.map(entry => entry.path),
      [mainUrl, linkedUrl]
    )
  })

  it('uses the recorded remote main path after linked worktree metadata disappears', async () => {
    missingPaths.add(linkedPath)
    missingPaths.add(linkedGitDir)
    const selected = new Repository(
      linkedUrl,
      1,
      null,
      true,
      null,
      {},
      false,
      gitDirUrl,
      mainUrl
    )
    assert.strictEqual(
      await worktree.resolveMainWorktreePath(selected),
      mainUrl
    )
    assert.deepStrictEqual(
      calls.map(call => call.command),
      [`test -e '${mainPath}'`]
    )
  })

  for (const persistedMain of [undefined, `ssh://${authority}/stale main`]) {
    it(`recovers a remote main path with ${
      persistedMain === undefined ? 'no' : 'a stale'
    } recorded path`, async () => {
      missingPaths.add('/stale main')
      missingPaths.add(linkedPath)
      const selected = new Repository(
        linkedUrl,
        1,
        null,
        true,
        null,
        {},
        false,
        gitDirUrl,
        persistedMain
      )
      assert.strictEqual(
        await worktree.resolveMainWorktreePath(selected),
        mainUrl
      )
      assert(calls.some(call => call.location.path === linkedGitDir))
      assert(calls.every(call => call.location.host === 'build-box'))
    })
  }

  for (const persistedMain of [mainPath, undefined]) {
    it(`recovers a remote main path from legacy plain ${
      persistedMain === undefined ? 'git-dir' : 'main-path'
    } storage`, async () => {
      const selected = new Repository(
        linkedUrl,
        1,
        null,
        true,
        null,
        {},
        false,
        linkedGitDir,
        persistedMain
      )
      assert.strictEqual(
        await worktree.resolveMainWorktreePath(selected),
        mainUrl
      )
      assert(calls.every(call => call.location.host === 'build-box'))
      assert(
        calls.every(
          call => call.location.user === 'darren' && call.location.port === 2222
        )
      )
      assert.strictEqual(
        calls.at(-1)?.command,
        persistedMain === undefined
          ? `'git' '-C' '${linkedGitDir}' '--git-dir' '${linkedGitDir}' 'worktree' 'list' '--porcelain' '-z'`
          : `test -e '${mainPath}'`
      )
    })
  }

  it('adds a remote worktree using a server-local path argument', async () => {
    await worktree.addWorktree(
      new Repository(mainUrl, 1, null, false),
      linkedUrl,
      {
        createBranch: 'feature/new-worktree',
        commitish: 'main',
      }
    )
    assert.strictEqual(
      calls[0].command,
      `'git' '-C' '${mainPath}' 'worktree' 'add' '-b' 'feature/new-worktree' '${linkedPath}' 'main'`
    )
  })

  it('removes a remote worktree using a server-local path argument', async () => {
    await worktree.removeWorktree(mainUrl, linkedUrl, true)
    assert.strictEqual(
      calls[0].command,
      `'git' '-C' '${mainPath}' 'worktree' 'remove' '--force' '${linkedPath}'`
    )
  })

  it('removes the exact listed remote folder when its name contains #, ?, and %', async () => {
    const physicalPath = '/srv/worktree #?%name'
    listingOutput = porcelain.replace(linkedPath, physicalPath)
    const entries = await worktree.listWorktrees(mainUrl)
    await worktree.removeWorktree(mainUrl, entries[1].path, true)
    assert.strictEqual(
      calls[1].command,
      `'git' '-C' '${mainPath}' 'worktree' 'remove' '--force' '${physicalPath}'`
    )
  })

  it('moves a remote worktree using server-local old and new path arguments', async () => {
    const movedPath = '/srv/desktop-remote-worktree-test/renamed worktree'
    await worktree.moveWorktree(
      new Repository(mainUrl, 1, null, false),
      linkedUrl,
      `ssh://${authority}${movedPath}`
    )
    assert.strictEqual(
      calls[0].command,
      `'git' '-C' '${mainPath}' 'worktree' 'move' '${linkedPath}' '${movedPath}'`
    )
  })
})
