export function sessionIsRunning(status) {
  return status?.type === 'busy' || status?.type === 'retry'
}

export function sessionAbortControl({ sessionID = '', status, pending = false, fallbackRunning = false }) {
  const visible = !!sessionID && (sessionIsRunning(status) || fallbackRunning)
  return {
    visible,
    disabled: !visible || pending,
    label: pending ? '中止中...' : '中止',
  }
}

export function sessionAbortUrl(sessionID, directory = '') {
  const query = directory ? `?directory=${encodeURIComponent(directory)}` : ''
  return `/session/${encodeURIComponent(sessionID)}/abort${query}`
}
