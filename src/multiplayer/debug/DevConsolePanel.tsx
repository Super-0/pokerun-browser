import { useEffect, useMemo, useRef, useState } from 'react'

type ConsoleLevel = 'log' | 'info' | 'warn' | 'error'

type DevConsoleEntry = {
  id: number
  at: number
  level: ConsoleLevel
  text: string
}

type DevConsoleStore = {
  entries: DevConsoleEntry[]
  listeners: Set<() => void>
  nextId: number
  installed: boolean
}

const STORE_KEY = '__pokerunDevConsoleStore'
const MAX_ENTRIES = 1000
const LEVELS: ConsoleLevel[] = ['log', 'info', 'warn', 'error']

function store() {
  const root = globalThis as typeof globalThis & Record<string, unknown>
  let current = root[STORE_KEY] as DevConsoleStore | undefined
  if (!current) {
    current = { entries: [], listeners: new Set(), nextId: 1, installed: false }
    root[STORE_KEY] = current
  }
  return current
}

function stringify(value: unknown) {
  if (typeof value === 'string') return value
  if (value instanceof Error) return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ''}`
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'bigint') return `${value}n`

  const seen = new WeakSet<object>()
  try {
    return JSON.stringify(value, (_key, candidate) => {
      if (typeof candidate === 'bigint') return `${candidate}n`
      if (candidate && typeof candidate === 'object') {
        if (seen.has(candidate)) return '[Circular]'
        seen.add(candidate)
      }
      return candidate
    }, 2)
  } catch {
    return String(value)
  }
}

function append(level: ConsoleLevel, args: unknown[]) {
  const current = store()
  current.entries.push({
    id: current.nextId++,
    at: Date.now(),
    level,
    text: args.map(stringify).join(' '),
  })
  if (current.entries.length > MAX_ENTRIES) current.entries.splice(0, current.entries.length - MAX_ENTRIES)
  current.listeners.forEach(listener => listener())
}

function installConsoleCapture() {
  const current = store()
  if (current.installed || !import.meta.env.DEV) return
  current.installed = true

  const methods = console as unknown as Record<ConsoleLevel, (...args: unknown[]) => void>
  for (const level of LEVELS) {
    const original = methods[level].bind(console)
    methods[level] = (...args: unknown[]) => {
      original(...args)
      append(level, args)
    }
  }
}

function formatEntry(entry: DevConsoleEntry) {
  const time = new Date(entry.at).toLocaleTimeString([], { hour12: false, fractionalSecondDigits: 3 })
  return `[${time}] ${entry.level.toUpperCase()} ${entry.text}`
}

installConsoleCapture()

export function DevConsolePanel() {
  const [open, setOpen] = useState(false)
  const [pokerunOnly, setPokerunOnly] = useState(true)
  const [version, setVersion] = useState(0)
  const [copied, setCopied] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const current = store()

  useEffect(() => {
    const listener = () => setVersion(value => value + 1)
    current.listeners.add(listener)
    return () => { current.listeners.delete(listener) }
  }, [current])

  const entries = useMemo(() => {
    void version
    return current.entries.filter(entry => !pokerunOnly || entry.text.includes('PokéRun'))
  }, [current, pokerunOnly, version])

  useEffect(() => {
    if (!open) return
    const body = bodyRef.current
    if (body) body.scrollTop = body.scrollHeight
  }, [entries.length, open])

  async function copyVisible() {
    const text = entries.map(formatEntry).join('\n\n')
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      textarea.remove()
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  function clear() {
    current.entries.splice(0, current.entries.length)
    current.listeners.forEach(listener => listener())
  }

  if (!import.meta.env.DEV) return null

  return <div style={{
    position: 'fixed',
    left: 10,
    bottom: 10,
    zIndex: 2147483647,
    fontFamily: 'monospace',
  }}>
    {open && <section style={{
      width: 'min(760px, calc(100vw - 20px))',
      height: 'min(430px, 58vh)',
      display: 'flex',
      flexDirection: 'column',
      marginBottom: 8,
      background: 'rgba(8, 15, 20, 0.98)',
      border: '2px solid #78a7c2',
      boxShadow: '0 10px 36px rgba(0, 0, 0, 0.6)',
      color: '#e8f4fa',
    }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: '1px solid #35546b', flexWrap: 'wrap' }}>
        <strong style={{ marginRight: 'auto' }}>POKÉRUN DEV CONSOLE • {entries.length}</strong>
        <button onClick={() => setPokerunOnly(value => !value)}>{pokerunOnly ? 'POKÉRUN ONLY' : 'ALL LOGS'}</button>
        <button onClick={() => void copyVisible()} disabled={entries.length === 0}>{copied ? 'COPIED!' : 'COPY'}</button>
        <button onClick={clear} disabled={current.entries.length === 0}>CLEAR</button>
        <button onClick={() => setOpen(false)}>CLOSE</button>
      </header>
      <div ref={bodyRef} style={{ flex: 1, overflow: 'auto', padding: 10, fontSize: 11, lineHeight: 1.45, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {entries.length === 0
          ? <span style={{ opacity: 0.7 }}>NO {pokerunOnly ? 'POKÉRUN ' : ''}LOGS CAPTURED YET.</span>
          : entries.map(entry => <div key={entry.id} style={{ marginBottom: 8 }}>
            <span style={{ opacity: 0.55 }}>{new Date(entry.at).toLocaleTimeString([], { hour12: false, fractionalSecondDigits: 3 })}</span>{' '}
            <strong>{entry.level.toUpperCase()}</strong>{' '}
            <span>{entry.text}</span>
          </div>)}
      </div>
    </section>}
    <button onClick={() => setOpen(value => !value)} style={{
      padding: '8px 12px',
      fontWeight: 700,
      boxShadow: '0 4px 18px rgba(0, 0, 0, 0.5)',
    }}>
      {open ? 'HIDE CONSOLE' : `CONSOLE (${current.entries.length})`}
    </button>
  </div>
}
