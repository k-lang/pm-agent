import { describe, expect, test } from 'bun:test'
import { sessionAbortControl, sessionAbortUrl, sessionIsRunning } from './session-abort-view.js'

describe('session abort controls', () => {
  test('shows the control only for a running session', () => {
    expect(sessionIsRunning({ type: 'busy' })).toBe(true)
    expect(sessionIsRunning({ type: 'retry' })).toBe(true)
    expect(sessionIsRunning({ type: 'idle' })).toBe(false)
    expect(sessionAbortControl({ sessionID: 'ses_1', status: { type: 'busy' } })).toEqual({
      visible: true,
      disabled: false,
      label: '中止',
    })
    expect(sessionAbortControl({ sessionID: 'ses_1', status: { type: 'idle' } }).visible).toBe(false)
    expect(sessionAbortControl({ status: { type: 'busy' } }).visible).toBe(false)
  })

  test('supports persisted-running fallback only when the caller opts in', () => {
    expect(sessionAbortControl({ sessionID: 'ses_1', fallbackRunning: true }).visible).toBe(true)
    expect(sessionAbortControl({ sessionID: 'ses_1' }).visible).toBe(false)
  })

  test('locks the control while abort is pending', () => {
    expect(sessionAbortControl({
      sessionID: 'ses_1',
      status: { type: 'busy' },
      pending: true,
    })).toEqual({
      visible: true,
      disabled: true,
      label: '中止中...',
    })
  })

  test('builds a project-scoped abort endpoint', () => {
    expect(sessionAbortUrl('ses/a', '/tmp/项目 data')).toBe(
      '/session/ses%2Fa/abort?directory=%2Ftmp%2F%E9%A1%B9%E7%9B%AE%20data',
    )
    expect(sessionAbortUrl('ses_1')).toBe('/session/ses_1/abort')
  })
})
