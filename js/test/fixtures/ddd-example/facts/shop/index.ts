// An aggregate sample (t005 c004): an order that owns its lines, a value object, an event and a use case.
import { aggregate, defineFacts, domainEvent, entity, factsOf, invariant, ref, useCase, valueObject } from 'fact-kit'
import { published, tool } from '../_lib/product.ts'

const mf = factsOf({ tool, source: published, prefix: 'shop' })

export const money = mf.schema(
  'money',
  valueObject({ amount: { type: 'integer' }, currency: { enum: ['TWD', 'USD'] } }, { required: ['amount', 'currency'] }),
)

export const orderLine = mf.schema(
  'order-line',
  entity({
    identity: ['order', 'no'],
    fields: { order: { type: 'string' }, no: { type: 'integer' }, price: ref(money) },
    required: ['order', 'no'],
  }),
)

export const order = mf.schema(
  'order',
  entity({
    identity: 'id',
    fields: { id: { type: 'string' }, lines: { type: 'array', items: ref(orderLine) } },
    required: ['id'],
  }),
)

export const orderBoundary = mf.value(
  'order-boundary',
  aggregate({ root: order, members: [{ entity: orderLine, cardinality: 'many' }] }),
)

export const orderNotEmpty = mf.statement(
  'order-not-empty',
  invariant(order, { 'zh-TW': '訂單至少要有一個明細才能送出' }),
)

export const orderPlaced = mf.schema('order-placed', domainEvent({ order: ref(order, 'id') }))

export const placeOrder = mf.value(
  'place-order',
  useCase({
    input: ref(order, 'id'),
    steps: [
      { layer: 'domain', action: 'check lines', rule: orderNotEmpty },
      { layer: 'domain', action: 'place', emits: orderPlaced },
      { layer: 'infrastructure', action: 'save', calls: order },
    ],
    errors: ['order-empty'],
  }),
)

export default defineFacts({
  describes: { mainflow: '0.1.0' },
  facts: [money, orderLine, order, orderBoundary, orderNotEmpty, orderPlaced, placeOrder],
})
