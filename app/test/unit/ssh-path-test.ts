import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  canonicalizeSshRepositoryPath,
  formatSshRepositoryPath,
  formatSshRepositoryPathForDisplay,
  isSshRepositoryPath,
  joinRepositoryPath,
  parseSshRepositoryPath,
  resolveRepositoryPath,
} from '../../src/lib/ssh/ssh-path'
import { parseSshConfigHosts } from '../../src/lib/ssh/ssh-config'

describe('ssh repository paths', () => {
  it('parses ssh:// URLs with a host alias', () => {
    const parsed = parseSshRepositoryPath('ssh://host/path/to/repo')
    assert.deepEqual(parsed, {
      host: 'host',
      user: undefined,
      port: undefined,
      path: '/path/to/repo',
    })
  })

  it('treats ssh://host/path/to/repo as a working copy URL', () => {
    const url = 'ssh://host/path/to/repo'
    assert.equal(isSshRepositoryPath(url), true)
    assert.deepEqual(parseSshRepositoryPath(url), {
      host: 'host',
      user: undefined,
      port: undefined,
      path: '/path/to/repo',
    })
    assert.equal(canonicalizeSshRepositoryPath(url), url)
  })

  it('parses ssh:// URLs with user and port', () => {
    const parsed = parseSshRepositoryPath('ssh://user@host:2222/path/to/repo')
    assert.deepEqual(parsed, {
      host: 'host',
      user: 'user',
      port: 2222,
      path: '/path/to/repo',
    })
  })

  it('parses scp-style host:path aliases', () => {
    const parsed = parseSshRepositoryPath('host:/path/to/repo')
    assert.deepEqual(parsed, {
      host: 'host',
      user: undefined,
      path: '/path/to/repo',
    })
  })

  it('parses user@host:path', () => {
    const parsed = parseSshRepositoryPath('user@host:~/path/to/repo')
    assert.deepEqual(parsed, {
      host: 'host',
      user: 'user',
      path: '~/path/to/repo',
    })
  })

  it('treats ~/ in ssh:// URLs as home-relative, not a literal /~ folder', () => {
    const parsed = parseSshRepositoryPath('ssh://user@host/~/path/to/repo')
    assert.deepEqual(parsed, {
      host: 'host',
      user: 'user',
      port: undefined,
      path: '~/path/to/repo',
    })
    assert.equal(
      canonicalizeSshRepositoryPath('ssh://user@host/~/path/to/repo'),
      'ssh://user@host/~/path/to/repo'
    )
  })

  it('does not treat Windows drive letters as SSH hosts', () => {
    assert.equal(parseSshRepositoryPath('C:\\Users\\name\\repo'), null)
    assert.equal(parseSshRepositoryPath('C:/Users/name/repo'), null)
  })

  it('restores win32-mangled ssh:// paths', () => {
    const parsed = parseSshRepositoryPath('ssh:\\host\\path\\to\\repo')
    assert.deepEqual(parsed, {
      host: 'host',
      user: undefined,
      port: undefined,
      path: '/path/to/repo',
    })
  })

  it('round-trips through the canonical ssh:// form', () => {
    const parsed = parseSshRepositoryPath('host:/path/to/repo')
    assert(parsed !== null)
    const formatted = formatSshRepositoryPath(parsed)
    assert.equal(formatted, 'ssh://host/path/to/repo')
    assert.equal(isSshRepositoryPath(formatted), true)
    assert.deepEqual(parseSshRepositoryPath(formatted), {
      ...parsed,
      user: undefined,
      port: undefined,
    })
  })

  it('round-trips home-relative paths through the canonical ssh:// form', () => {
    const parsed = parseSshRepositoryPath('host:~/path/to/repo')
    assert(parsed !== null)
    const formatted = formatSshRepositoryPath(parsed)
    assert.equal(formatted, 'ssh://host/~/path/to/repo')
    assert.equal(isSshRepositoryPath(formatted), true)
    assert.equal(parseSshRepositoryPath(formatted)?.path, '~/path/to/repo')
  })

  it('preserves literal #, ?, and % in remote filenames', () => {
    const location = {
      host: 'build-box',
      user: 'darren',
      port: 2222,
      path: '/srv/worktree #?%name',
    }
    const formatted = formatSshRepositoryPath(location)
    assert.equal(
      formatted,
      'ssh://darren@build-box:2222/srv/worktree %23%3F%25name'
    )
    assert.deepEqual(parseSshRepositoryPath(formatted), location)
    assert.equal(canonicalizeSshRepositoryPath(formatted), formatted)
    assert.equal(
      parseSshRepositoryPath(joinRepositoryPath(formatted, '.git'))?.path,
      `${location.path}/.git`
    )
    assert.equal(
      parseSshRepositoryPath(resolveRepositoryPath(formatted, '.git'))?.path,
      `${location.path}/.git`
    )
  })

  it('joins and resolves remote POSIX paths without using win32 separators', () => {
    const root = 'ssh://host/path/to/repo'
    assert.equal(
      joinRepositoryPath(root, '.gitignore'),
      'ssh://host/path/to/repo/.gitignore'
    )
    assert.equal(
      resolveRepositoryPath(root, '..', 'other'),
      'ssh://host/path/to/other'
    )
    assert.equal(formatSshRepositoryPathForDisplay(root), 'host:/path/to/repo')
  })

  it('joins and resolves home-relative paths without consulting the local cwd', () => {
    const root = 'ssh://host/~/path/to/repo'
    assert.equal(
      joinRepositoryPath(root, '.gitignore'),
      'ssh://host/~/path/to/repo/.gitignore'
    )
    assert.equal(
      resolveRepositoryPath(root, '..', 'other'),
      'ssh://host/~/path/to/other'
    )
    assert.equal(formatSshRepositoryPathForDisplay(root), 'host:~/path/to/repo')
  })

  it('leaves local paths to the platform path module', () => {
    assert.equal(isSshRepositoryPath('/home/user/repo'), false)
    assert.equal(isSshRepositoryPath('C:\\Users\\name\\repo'), false)
  })
})

describe('ssh config hosts', () => {
  it('reads concrete Host aliases and skips wildcards', () => {
    const hosts = parseSshConfigHosts(`
Host server
  HostName 192.168.1.20
  User user

Host github.com *.github.com
  User git

Host *
  IdentitiesOnly yes

Host work-laptop
  Port 2222
`)

    assert.deepEqual(
      hosts.map(h => h.alias),
      ['server', 'github.com', 'work-laptop']
    )
    assert.equal(hosts[0].hostName, '192.168.1.20')
    assert.equal(hosts[0].user, 'user')
    assert.equal(hosts[2].port, 2222)
  })
})
