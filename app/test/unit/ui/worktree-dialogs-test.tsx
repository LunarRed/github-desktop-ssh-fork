import assert from 'node:assert'
import * as Path from 'path'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import * as React from 'react'

import { Repository } from '../../../src/models/repository'
import type { WorktreeEntry } from '../../../src/models/worktree'
import type { Dispatcher } from '../../../src/ui/dispatcher'
import { fireEvent, render, screen, waitFor } from '../../helpers/ui/render'

const addWorktree = mock.fn(
  async (_repository: Repository, _path: string) => {}
)
let listedWorktrees: ReadonlyArray<WorktreeEntry> = []

mock.module('../../../src/lib/git/worktree', {
  namedExports: {
    addWorktree,
    listWorktrees: async () => listedWorktrees,
  },
})

mock.module('../../../src/ui/lib/default-dir', {
  namedExports: {
    getDefaultDir: async () => '/srv/worktrees',
    setDefaultDir: () => {},
  },
})

let restoreIpcSend: (() => void) | null = null

function worktree(path: string, type: 'main' | 'linked'): WorktreeEntry {
  return {
    path,
    type,
    head: 'abc1234',
    branch: type === 'main' ? 'refs/heads/main' : 'refs/heads/topic',
    isDetached: false,
    isLocked: false,
    isPrunable: false,
  }
}

describe('worktree dialogs', () => {
  beforeEach(async () => {
    addWorktree.mock.resetCalls()
    listedWorktrees = []

    const electron = await import('electron')
    const previousSend = electron.ipcRenderer.send
    electron.ipcRenderer.send = () => {}
    restoreIpcSend = () => {
      electron.ipcRenderer.send = previousSend
    }
  })

  afterEach(() => {
    restoreIpcSend?.()
    restoreIpcSend = null
  })

  for (const isSsh of [true, false]) {
    it(`selects the newly created ${
      isSsh ? 'SSH' : 'local'
    } worktree after submitting a directory path`, async () => {
      const { AddWorktreeDialog } = await import(
        '../../../src/ui/worktrees/add-worktree-dialog'
      )
      const repository = new Repository(
        isSsh ? 'ssh://dlu@host:2222/srv/project' : '/srv/project',
        1,
        null,
        false
      )
      const targetPath = isSsh
        ? 'ssh://dlu@host:2222/srv/worktrees/topic'
        : Path.join('/srv/worktrees', 'topic')
      const createdWorktree = worktree(targetPath, 'linked')
      listedWorktrees = [worktree(repository.path, 'main'), createdWorktree]
      const dispatcher = {
        switchWorktree: mock.fn(async () => {}),
        incrementMetric: mock.fn(),
        postError: mock.fn(),
      }
      const onDismissed = mock.fn()

      render(
        <AddWorktreeDialog
          repository={repository}
          dispatcher={dispatcher as unknown as Dispatcher}
          onDismissed={onDismissed}
          initialWorktreeName="topic"
          initialBranchName="topic"
          allBranches={[]}
        />
      )

      const createButton = screen.getByRole('button', {
        name: /Create worktree/i,
        hidden: true,
      }) as HTMLButtonElement
      const pathInput = screen.getByPlaceholderText(
        'worktree path'
      ) as HTMLInputElement
      await waitFor(() => assert.equal(pathInput.disabled, false))
      fireEvent.change(pathInput, { target: { value: '/srv/worktrees' } })
      await waitFor(() => assert.equal(createButton.disabled, false))
      fireEvent.click(createButton)

      await waitFor(() => {
        assert.equal(dispatcher.switchWorktree.mock.callCount(), 1)
        assert.deepEqual(dispatcher.switchWorktree.mock.calls[0].arguments, [
          repository,
          createdWorktree,
        ])
        assert.equal(dispatcher.postError.mock.callCount(), 0)
        assert.equal(onDismissed.mock.callCount(), 1)
      })
      assert.equal(addWorktree.mock.callCount(), 1)
      if (!isSsh) {
        assert.equal(addWorktree.mock.calls[0].arguments[1], targetPath)
      }
    })

    it(`renames an ${
      isSsh ? 'SSH' : 'local'
    } worktree without changing its path protocol`, async () => {
      const { RenameWorktreeDialog } = await import(
        '../../../src/ui/worktrees/rename-worktree-dialog'
      )
      const repository = new Repository(
        isSsh ? 'ssh://dlu@host:2222/srv/project' : '/srv/project',
        1,
        null,
        false
      )
      const sourcePath = isSsh
        ? 'ssh://dlu@host:2222/srv/worktrees/topic'
        : Path.join('/srv/worktrees', 'topic')
      const targetPath = isSsh
        ? 'ssh://dlu@host:2222/srv/worktrees/renamed'
        : Path.join('/srv/worktrees', 'renamed')
      const dispatcher = { moveWorktree: mock.fn(async () => true) }
      const onDismissed = mock.fn()

      render(
        <RenameWorktreeDialog
          repository={repository}
          worktreePath={sourcePath}
          dispatcher={dispatcher as unknown as Dispatcher}
          onDismissed={onDismissed}
        />
      )

      fireEvent.change(screen.getByRole('textbox', { hidden: true }), {
        target: { value: 'renamed' },
      })
      fireEvent.click(
        screen.getByRole('button', { name: 'Rename topic', hidden: true })
      )

      await waitFor(() => {
        assert.equal(dispatcher.moveWorktree.mock.callCount(), 1)
        assert.deepEqual(dispatcher.moveWorktree.mock.calls[0].arguments, [
          repository,
          sourcePath,
          targetPath,
        ])
        assert.equal(onDismissed.mock.callCount(), 1)
      })
    })
  }

  it('shows literal URL characters in an SSH worktree name and escapes the renamed target', async () => {
    const { RenameWorktreeDialog } = await import(
      '../../../src/ui/worktrees/rename-worktree-dialog'
    )
    const repository = new Repository(
      'ssh://dlu@host:2222/srv/project',
      1,
      null,
      false
    )
    const sourcePath = 'ssh://dlu@host:2222/srv/worktrees/topic%252F%3F%23'
    const dispatcher = { moveWorktree: mock.fn(async () => true) }
    const onDismissed = mock.fn()

    render(
      <RenameWorktreeDialog
        repository={repository}
        worktreePath={sourcePath}
        dispatcher={dispatcher as unknown as Dispatcher}
        onDismissed={onDismissed}
      />
    )

    const nameInput = screen.getByRole('textbox', {
      hidden: true,
    }) as HTMLInputElement
    assert.equal(nameInput.value, 'topic%2F?#')
    fireEvent.change(nameInput, { target: { value: 'renamed%2F?#' } })
    fireEvent.click(
      screen.getByRole('button', { name: 'Rename topic%2F?#', hidden: true })
    )

    await waitFor(() => {
      assert.equal(dispatcher.moveWorktree.mock.callCount(), 1)
      assert.deepEqual(dispatcher.moveWorktree.mock.calls[0].arguments, [
        repository,
        sourcePath,
        'ssh://dlu@host:2222/srv/worktrees/renamed%252F%3F%23',
      ])
      assert.equal(onDismissed.mock.callCount(), 1)
    })
  })
})
