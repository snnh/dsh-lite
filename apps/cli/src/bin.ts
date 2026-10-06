#!/usr/bin/env node
/**
 * Command-line entry for dsh.
 * @module @deepseek-ai/dsh/bin
 */

/* v8 ignore file -- built-bin acceptance exercises this self-executing dispatch. */

// Imported first: every module below it is compiled after the cache is enabled.
import './compile-cache.ts'
import { getDshRuntimeVersion, loadLayeredEnv, StartupError } from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { parseDshArgs } from './args.ts'
import { reportStartupFailure } from './startup-diagnostics.ts'
import type { RunProfileOptions } from './profile-boot.ts'

/** Installation-owned dependencies supplied by a packaged CLI launcher. */
export type RunCliOptions = Pick<RunProfileOptions, 'packageManager'> & {
  /** Permit plugin commands for Desktop's existing profile; reserved for its installed carrier. */
  manageDesktopProfile?: boolean
}

/**
 * Run the public dsh command-line interface.
 * @param options - Package runtime and Desktop profile access supplied by the installation.
 * @returns a promise that settles when the selected command mode finishes.
 */
export async function runCli(options: RunCliOptions = {}): Promise<void> {
  const version = getDshRuntimeVersion()
  const { manageDesktopProfile, ...profileOptions } = options
  const invocation = parseDshArgs(process.argv.slice(2), version, manageDesktopProfile)

  switch (invocation.mode) {
    case 'profile': {
      const { runProfile } = await import('./profile-boot.ts')
      const { policyOptionsFromEnv, startMemoryPolicy } = await import('@deepseek-ai/dsh-memory')
      // Sampling starts before the host binds, and it outlives `runProfile`,
      // which resolves once the profile is composed rather than at shutdown.
      // Both timers are unref'd, so the policy never holds the process open.
      // `DSH_GC=0` starts nothing and says nothing: an operator who turned the
      // policy off asked for a quiet stderr, and a line about it would be the
      // one report they did not ask for — the profile's own output is a channel
      // its callers read.
      const policyOptions = policyOptionsFromEnv()
      if (policyOptions !== undefined) {
        startMemoryPolicy({ ...policyOptions, log: (line) => { process.stderr.write(`${line}\n`) } })
      }
      try {
        await runProfile({
          environment: loadLayeredEnv('dsh'),
          profile: invocation.profile,
          fromDefaultProfile: invocation.fromDefaultProfile,
          patchFiles: invocation.patches,
          args: invocation.args,
          ...profileOptions,
        })
      } catch (error) {
        if (!(error instanceof StartupError)) throw error
        await reportStartupFailure(error, { home: resolveDshHome(), version, profile: invocation.profile })
        process.exit(1)
      }
      break
    }
    case 'plugin': {
      const { runPlugin } = await import('./plugin.ts')
      process.exit(await runPlugin(invocation.profile, invocation.args, options.packageManager))
      break
    }
    case 'dump-config': {
      const { runDumpConfig } = await import('./dump-config.ts')
      runDumpConfig(
        invocation.profile,
        invocation.defaultOnly,
        invocation.patches,
        invocation.fromDefaultProfile,
      )
      break
    }
    case 'dump-config-schema': {
      const { runDumpConfigSchema } = await import('./dump-config-schema.ts')
      await runDumpConfigSchema(invocation.profile, invocation.patches, invocation.fromDefaultProfile)
      break
    }
    default:
      invocation satisfies never
      throw new Error(`dsh: unhandled invocation mode ${JSON.stringify(invocation)}`)
  }
}

if (import.meta.main) {
  await runCli()
}
