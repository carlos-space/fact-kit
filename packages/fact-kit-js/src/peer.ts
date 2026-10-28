/** What to install when an optional peer dependency is missing, by package name. */
const PEER_INSTALL: Record<string, string> = { typescript: 'typescript@7.1.0-beta', prettier: 'prettier@3' }

/**
 * Loads an optional peer dependency on demand. When the package is not installed, throws an error that
 * names the package to install, so a reader that only uses `readFacts` or `check` never needs it.
 */
export async function loadPeer<T>(specifier: string, packageName: string, usedBy: string): Promise<T> {
  try {
    return (await import(specifier)) as T
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      throw new Error(
        `${usedBy} needs the optional peer dependency ${packageName}. Install it with: pnpm add -D ${PEER_INSTALL[packageName] ?? packageName}`,
        { cause: error },
      )
    }
    throw error
  }
}
