/** Physical core-package identity across installation and profile dependency graphs. */

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { assertSharedCorePackages, DuplicateCorePackageError } from '../src/profile-resolution/core-packages.ts'
import { createProfileResolutionGeneration, initProfile, loadProfileDirectory } from '../src/profile.ts'
import { readProfilePatches } from '../src/profile-context.ts'

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-core-packages-')))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const install = join(root, 'installation')
  const profile = join(root, 'home', 'profiles', 'test')
  initProfile(profile, [])
  const pkg = (dir: string, name: string, dependencies: Record<string, string> = {}, version = '1.0.0') => {
    mkdirSync(dir, { recursive: true })
    const anchor = join(dir, 'package.json')
    writeFileSync(anchor, JSON.stringify({ name, version, dependencies }))
    return anchor
  }
  const anchor = pkg(install, 'installation')
  return { root, install, profile, anchor, pkg }
}

it.each(['@deepseek-ai/cordis', '@deepseek-ai/dsh-scope', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-tools'])(
  'rejects a second physical %s even when its version matches', (name) => {
    const { install, profile, anchor, pkg } = fixture()
    pkg(install, 'installation', { [name]: '1.0.0' })
    const first = join(install, 'node_modules', name)
    pkg(first, name)
    pkg(profile, 'profile', { addon: '1.0.0' })
    const plugin = join(profile, 'node_modules', 'addon')
    const introducedBy = pkg(plugin, 'addon', { [name]: '1.0.0' })
    const second = join(plugin, 'node_modules', name)
    pkg(second, name)
    expect(() => { assertSharedCorePackages(anchor, profile) }).toThrow(DuplicateCorePackageError)
    try {
      assertSharedCorePackages(anchor, profile)
    } catch (error) {
      expect(error).toMatchObject({
        code: 'DSH_DUPLICATE_CORE_PACKAGE', packageName: name,
        first: { packageDir: first, version: '1.0.0', introducedBy: anchor },
        second: { packageDir: second, version: '1.0.0', introducedBy },
      })
      expect((error as Error).message).toContain('Equal versions at different paths')
      expect((error as Error).message).toContain('reinstall or deduplicate')
    }
  },
)

it('accepts links and package aliases resolving to the same physical core package', () => {
  const { install, profile, anchor, pkg } = fixture()
  const name = '@deepseek-ai/dsh-tools'
  pkg(install, 'installation', { [name]: '1' })
  const core = join(install, 'node_modules', name)
  pkg(core, name)
  pkg(profile, 'profile', { alias: 'npm:@deepseek-ai/dsh-tools@1' })
  const link = join(profile, 'node_modules', 'alias')
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(core, link, process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => { assertSharedCorePackages(anchor, profile, [join(link, 'package.json')]) }).not.toThrow()
})

it('reports undeclared versions without treating a builtin dependency as another package', () => {
  const { install, profile, anchor, pkg } = fixture()
  const name = '@deepseek-ai/dsh-tools'
  pkg(install, 'installation', { [name]: '*' })
  const first = join(install, 'node_modules', name)
  pkg(first, name)
  writeFileSync(join(first, 'package.json'), JSON.stringify({ name, dependencies: { 'node:fs': '*' } }))
  pkg(profile, 'profile', { [name]: '*' })
  const second = join(profile, 'node_modules', name)
  pkg(second, name)
  writeFileSync(join(second, 'package.json'), JSON.stringify({ name }))
  expect(() => { assertSharedCorePackages(anchor, profile) })
    .toThrow(`  ${second} (version undeclared; introduced by ${join(profile, 'package.json')})`)
})

it('ignores stale Harness-owned fallback projections before their next reconciliation', () => {
  const { root, install, profile, anchor, pkg } = fixture()
  const name = '@deepseek-ai/dsh-tools'
  pkg(install, 'installation', { [name]: '1' })
  pkg(join(install, 'node_modules', name), name)
  pkg(profile, 'profile', { addon: '1' })
  pkg(join(profile, 'node_modules', 'addon'), 'addon', { [name]: '1' })
  const stale = join(root, 'stale-tools')
  pkg(stale, name)
  const shared = join(dirname(profile), 'node_modules', name)
  mkdirSync(dirname(shared), { recursive: true })
  symlinkSync(stale, shared, process.platform === 'win32' ? 'junction' : 'dir')
  const owned = join(profile, '.dsh-module-fallback', 'node_modules', name)
  mkdirSync(dirname(owned), { recursive: true })
  symlinkSync(stale, owned, process.platform === 'win32' ? 'junction' : 'dir')
  const projected = join(profile, 'node_modules', name)
  mkdirSync(dirname(projected), { recursive: true })
  symlinkSync(owned, projected, process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => { assertSharedCorePackages(anchor, profile) }).not.toThrow()
})

it('visits both ordinary dependency versions and finds nested peer copies', () => {
  const { install, profile, anchor, pkg } = fixture()
  pkg(install, 'installation', { library: '1' })
  pkg(join(install, 'node_modules', 'library'), 'library', { '@deepseek-ai/dsh-scope': '1' })
  pkg(join(install, 'node_modules', '@deepseek-ai/dsh-scope'), '@deepseek-ai/dsh-scope')
  pkg(profile, 'profile', { library: '2' })
  const library = join(profile, 'node_modules', 'library')
  const localAnchor = pkg(library, 'library', {}, '2.0.0')
  expect(() => { assertSharedCorePackages(anchor, profile) }).not.toThrow()
  writeFileSync(localAnchor, JSON.stringify({ name: 'library', peerDependencies: { '@deepseek-ai/dsh-scope': '2' } }))
  const duplicate = join(library, 'node_modules', '@deepseek-ai/dsh-scope')
  pkg(duplicate, '@deepseek-ai/dsh-scope', {}, '2.0.0')
  expect(() => { assertSharedCorePackages(anchor, profile) }).toThrow(expect.objectContaining({
    second: { packageDir: duplicate, version: '2.0.0', introducedBy: localAnchor },
  }))
})

it('checks selected bundle anchors, missing optional dependencies and dependency cycles without importing code', () => {
  const { root, install, anchor, pkg } = fixture()
  const name = '@deepseek-ai/dsh-tools'
  pkg(install, 'installation', { [name]: '1' })
  const core = join(install, 'node_modules', name)
  pkg(core, name, { '@deepseek-ai/dsh-tools': '1' })
  const bundle = join(root, 'bundle')
  const bundleAnchor = pkg(bundle, 'bundle')
  writeFileSync(bundleAnchor, JSON.stringify({ name: 'bundle', optionalDependencies: { 'absent-core-audit-fixture': '1' } }))
  expect(() => { assertSharedCorePackages(anchor, join(root, 'absent'), [bundleAnchor]) }).not.toThrow()
  writeFileSync(bundleAnchor, JSON.stringify({ name: 'bundle', optionalDependencies: { [name]: '1' } }))
  pkg(join(bundle, 'node_modules', name), name)
  writeFileSync(join(bundle, 'node_modules', name, 'index.js'), 'throw new Error("must not import during audit")\n')
  expect(() => { assertSharedCorePackages(anchor, undefined, [bundleAnchor]) }).toThrow(DuplicateCorePackageError)
})

it('rejects before creating a generation or returning reload patches', async () => {
  const { root, install, profile, anchor, pkg } = fixture()
  const name = '@deepseek-ai/dsh-session'
  pkg(install, 'installation', { [name]: '1' })
  pkg(join(install, 'node_modules', name), name)
  pkg(profile, 'profile', { [name]: '2' })
  pkg(join(profile, 'node_modules', name), name, {}, '2.0.0')
  const loaded = loadProfileDirectory('test', profile, anchor)
  await expect(createProfileResolutionGeneration({ installAnchor: anchor, profile: loaded, home: join(root, 'home') }))
    .rejects.toThrow(DuplicateCorePackageError)
  expect(existsSync(join(root, 'home', 'profiles', 'node_modules'))).toBe(false)
  expect(() => readProfilePatches('test', {
    name: 'test', dir: profile, patchPath: loaded.patchPath, installAnchor: anchor, cwd: root,
    home: join(root, 'home'), startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
  })).toThrow(DuplicateCorePackageError)
})
