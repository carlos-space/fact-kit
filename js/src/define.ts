import type { FactsModule } from './types.ts'

/** Identity helper that gives a `facts/<entry>/index.ts` default export its type. */
export const defineFacts = (module: FactsModule): FactsModule => module
