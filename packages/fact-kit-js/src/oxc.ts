import { InputError } from './load.ts'

/** The part of `oxc-parser` that fact-kit uses. */
export interface OxcModule {
  parseSync(file: string, source: string): { program: unknown; errors: { message: string }[] }
}

let loaded: Promise<OxcModule> | undefined

/**
 * Loads `oxc-parser` on first use. It is an optional peer dependency, so only the commands and rules that read
 * source code need it. A missing package is an {@link InputError} that names what to install.
 */
export function loadOxc(): Promise<OxcModule> {
  loaded ??= import('oxc-parser').then(
    (m) => m as unknown as OxcModule,
    (error: unknown) => {
      loaded = undefined
      throw new InputError(
        `reading TypeScript files needs the optional package oxc-parser, which could not be loaded. Install it: pnpm add -D oxc-parser (${(error as Error).message})`,
      )
    },
  )
  return loaded
}
