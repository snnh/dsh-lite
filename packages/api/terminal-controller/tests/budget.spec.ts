/** Host-wide buffer accounting refuses rather than reclaims, and refunds each admission once. */
import { describe, expect, it } from 'vitest'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { TerminalBudget } from '../src/budget.ts'

describe('TerminalBudget', () => {
  it('charges each reservation, refunds it once, and never reports a negative total', () => {
    const budget = new TerminalBudget(100)
    const screen = budget.reserve(60, 'terminal')
    expect(budget.reserved).toBe(60)
    const queue = budget.reserve(40, 'follower')
    expect(budget.reserved).toBe(100)
    queue.release()
    expect(budget.reserved).toBe(60)
    // A queue can be closed more than once by design; the second refund must not create room.
    queue.release()
    expect(budget.reserved).toBe(60)
    screen.release()
    expect(budget.reserved).toBe(0)
  })

  it('refuses the request that would cross the ceiling with typed diagnostics', () => {
    const budget = new TerminalBudget(100)
    budget.reserve(60, 'terminal')
    const failure = (() => { try { budget.reserve(41, 'follower'); return undefined } catch (error) { return remoteErrorOf(error) } })()
    expect(failure).toMatchObject({
      code: 'terminal/capacity-reached',
      details: { limit: 100, used: 60, requested: 41, purpose: 'follower' },
    })
    expect(failure?.message).toContain('while opening a new follower')
    // The refused request changed nothing, so the reservation it collided with stays intact.
    expect(budget.reserved).toBe(60)
    const admitted = budget.reserve(40, 'follower')
    expect(budget.reserved).toBe(100)
    admitted.release()
    expect(budget.reserved).toBe(60)
  })

  it('sizes a screen from the widest geometry it may reach', () => {
    expect(TerminalBudget.screen(1000, 500)).toBe(2_000_000)
    expect(TerminalBudget.screen(0, 500)).toBe(0)
  })
})
