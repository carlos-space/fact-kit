import { factsOf, valueObject, entity, invariant, domainEvent, useCase, stateMachine, ref } from 'fact-kit'
import { tool, published } from '../_lib/product.ts'

const mf = factsOf({ tool, source: published, prefix: 'domain' })

export const criterion = mf.schema('criterion', valueObject({
  id: { type: 'string', pattern: '^r\\d{3}$' },
  text: { type: 'string' },
  done: { type: 'boolean' },
}))

export const mainlineStatus = mf.value('mainline.status', stateMachine({
  initial: 'planning',
  states: ['planning', 'active', 'blocked', 'done', 'dropped'],
  transitions: [
    { from: 'planning', to: 'active' },
    { from: 'active', to: 'done', guard: 'mainline.close-requires-criteria' },
  ],
}))

export const mainline = mf.schema('mainline', entity({
  identity: 'id',
  fields: {
    id: { type: 'string', pattern: '^m\\d{3}$' },
    status: { enum: mainlineStatus.states },
    criteria: { type: 'array', items: ref(criterion) },
  },
}))

export const closeRequiresCriteria = mf.statement('mainline.close-requires-criteria',
  invariant(mainline, { 'zh-TW': '解決條件全部勾選後，主脈絡才能標為 done' }))

export const mainlineClosed = mf.schema('mainline-closed', domainEvent({
  mainline: ref(mainline, 'id'),
  closedAt: { type: 'string', format: 'date-time' },
}))

export const closeMainline = mf.value('close-mainline', useCase({
  input: ref(mainline, 'id'),
  steps: [
    { layer: 'application', action: '讀取主脈絡' },
    { layer: 'domain', action: '檢查不變條件', rule: closeRequiresCriteria },
    { layer: 'domain', action: '發出事件', emits: mainlineClosed },
  ],
  errors: ['criteria-not-done', 'mainline-not-found'],
}))
