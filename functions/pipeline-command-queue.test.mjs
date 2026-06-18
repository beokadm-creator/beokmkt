import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { selectClaimablePipelineCommand } from './pipeline-command-queue.mjs'

const baseTime = new Date('2026-06-18T00:00:00.000Z')

function command(overrides = {}) {
  return {
    id: overrides.id ?? 'cmd',
    active: overrides.active ?? true,
    batch_id: overrides.batch_id ?? 'batch-1',
    sequence: overrides.sequence ?? 0,
    status: overrides.status ?? 'pending',
    created_at: overrides.created_at ?? baseTime,
    ...overrides,
  }
}

describe('selectClaimablePipelineCommand', () => {
  it('claims the first pending command in a runbook batch', () => {
    const selected = selectClaimablePipelineCommand([
      command({ id: 'generate', sequence: 1, created_at: new Date(baseTime.getTime() + 1000) }),
      command({ id: 'reset', sequence: 0 }),
    ], baseTime)

    assert.equal(selected?.id, 'reset')
  })

  it('does not claim later batch commands while an earlier command is running', () => {
    const selected = selectClaimablePipelineCommand([
      command({
        id: 'generate',
        sequence: 1,
        status: 'running',
        lease_until: new Date(baseTime.getTime() + 30 * 60 * 1000),
      }),
      command({ id: 'factcheck', sequence: 2, created_at: new Date(baseTime.getTime() + 1000) }),
      command({ id: 'review', sequence: 3, created_at: new Date(baseTime.getTime() + 2000) }),
    ], baseTime)

    assert.equal(selected, null)
  })

  it('claims the next command after all earlier batch commands succeeded', () => {
    const selected = selectClaimablePipelineCommand([
      command({ id: 'reset', sequence: 0, status: 'succeeded', active: false }),
      command({ id: 'generate', sequence: 1, status: 'succeeded', active: false }),
      command({ id: 'factcheck', sequence: 2 }),
    ], baseTime)

    assert.equal(selected?.id, 'factcheck')
  })

  it('reclaims an expired running command before moving to later commands', () => {
    const selected = selectClaimablePipelineCommand([
      command({ id: 'reset', sequence: 0, status: 'succeeded', active: false }),
      command({
        id: 'generate',
        sequence: 1,
        status: 'running',
        lease_until: new Date(baseTime.getTime() - 1000),
      }),
      command({ id: 'factcheck', sequence: 2, created_at: new Date(baseTime.getTime() + 1000) }),
    ], baseTime)

    assert.equal(selected?.id, 'generate')
  })

  it('blocks later commands after an earlier batch command failed', () => {
    const selected = selectClaimablePipelineCommand([
      command({ id: 'generate', sequence: 1, status: 'failed', active: false }),
      command({ id: 'factcheck', sequence: 2 }),
    ], baseTime)

    assert.equal(selected, null)
  })
})
