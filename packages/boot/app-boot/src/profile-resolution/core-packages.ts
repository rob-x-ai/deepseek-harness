/** Reject distinct installations of packages whose process-local identities cross plugin calls. */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { isProfileModuleFallbackLink, realModuleDirectory } from './legacy-links.ts'

const SHARED_CORE_PACKAGES = new Set([
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-scope',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-tools',
])

interface PackageManifest {
  name?: string
  version?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

/** One physical core package and the manifest whose dependency introduced it. */
export interface CorePackageLocation {
  /** Canonical package directory after following filesystem links. */
  readonly packageDir: string
  /** Installed manifest version, when present. */
  readonly version: string | undefined
  /** Canonical dependency-declaring package.json path. */
  readonly introducedBy: string
}

/** Distinct physical core packages cannot share the profile's service and scope identities. */
export class DuplicateCorePackageError extends Error {
  /** Stable diagnostic code for package-install and profile-boot callers. */
  readonly code = 'DSH_DUPLICATE_CORE_PACKAGE'

  /**
   * @param packageName - identity-sensitive package found at two physical locations.
   * @param first - first resolved package and its declaring manifest.
   * @param second - conflicting package and its declaring manifest.
   */
  constructor(
    readonly packageName: string,
    readonly first: CorePackageLocation,
    readonly second: CorePackageLocation,
  ) {
    super(`dsh: duplicate core package ${packageName}:\n`
      + `  ${first.packageDir} (version ${first.version ?? 'undeclared'}; introduced by ${first.introducedBy})\n`
      + `  ${second.packageDir} (version ${second.version ?? 'undeclared'}; introduced by ${second.introducedBy})\n`
      + 'Remove the conflicting profile dependency or align the plugin peer dependencies with this dsh installation, '
      + 'then reinstall or deduplicate the profile dependencies and restart. Equal versions at different paths still create separate module instances.')
    this.name = 'DuplicateCorePackageError'
  }
}

/** Resolve a declared dependency without evaluating its JavaScript or requiring a manifest export. */
function dependencyDirectory(anchor: string, name: string, profileDir: string | undefined): string | undefined {
  for (const path of createRequire(anchor).resolve.paths(name) ?? []) {
    // Installation and selected-bundle anchors already supply the current fallback graph.
    if (profileDir !== undefined && path === join(dirname(profileDir), 'node_modules')) return undefined
    const candidate = join(path, name)
    if (profileDir !== undefined && path === join(profileDir, 'node_modules')
      && isProfileModuleFallbackLink(profileDir, name)) continue
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

/**
 * Check reachable installation, profile and bundle dependencies before plugin activation.
 * Only Cordis, scope, Session and tools require one physical package; other dependencies may coexist.
 * The check reads manifests and canonical paths, without evaluating modules or inferring source-loader behavior.
 * @param installAnchor - package.json of the running installation.
 * @param profileDir - optional profile whose installed dependencies participate; an absent manifest is ignored.
 * @param bundleAnchors - selected bundle manifests not necessarily declared by the profile.
 */
export function assertSharedCorePackages(
  installAnchor: string,
  profileDir?: string,
  bundleAnchors: readonly string[] = [],
): void {
  const profileAnchor = profileDir === undefined ? undefined : join(profileDir, 'package.json')
  const profileRoot = profileAnchor !== undefined && existsSync(profileAnchor) ? realModuleDirectory(dirname(profileAnchor)) : undefined
  const anchors = [installAnchor, ...bundleAnchors,
    ...profileAnchor !== undefined && existsSync(profileAnchor) ? [profileAnchor] : []]
  const queue = anchors.map(anchor => ({ anchor, introducedBy: anchor }))
  const visited = new Set<string>()
  const packages = new Map<string, CorePackageLocation>()
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const packageDir = realModuleDirectory(dirname(next.anchor))
    if (visited.has(packageDir)) continue
    visited.add(packageDir)
    const anchor = join(packageDir, 'package.json')
    const manifest = JSON.parse(readFileSync(anchor, 'utf8')) as PackageManifest
    if (manifest.name !== undefined && SHARED_CORE_PACKAGES.has(manifest.name)) {
      const location = {
        packageDir,
        version: manifest.version,
        introducedBy: join(realModuleDirectory(dirname(next.introducedBy)), 'package.json'),
      }
      const first = packages.get(manifest.name)
      if (first !== undefined) throw new DuplicateCorePackageError(manifest.name, first, location)
      packages.set(manifest.name, location)
    }
    const names = new Set([...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})])
    for (const name of names) {
      const dir = dependencyDirectory(anchor, name, profileRoot)
      // Uninstalled optional or peer dependencies do not introduce another module instance.
      if (dir !== undefined) queue.push({ anchor: join(dir, 'package.json'), introducedBy: anchor })
    }
  }
}
