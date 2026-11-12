import { useEffect, useState } from 'react'
import type { Badge, GameProgress } from '@pkhex-everywhere/engine'
import { PixelButton } from '../../components/PixelButton'
import { readSaveProgress, readTrainerBadges, setTrainerBadges } from '../../core/save-editor/pkhexEditor'

interface Props {
  onChanged: () => void
}

export function TrainerProgressPanel({ onChanged }: Props) {
  const [progress, setProgress] = useState<GameProgress | null>(null)
  const [badges, setBadges] = useState<Badge[] | null>(null)
  const [earned, setEarned] = useState<boolean[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  useEffect(() => {
    let active = true
    void Promise.allSettled([readSaveProgress(), readTrainerBadges()]).then(results => {
      if (!active) return
      if (results[0].status === 'fulfilled') setProgress(results[0].value)
      if (results[1].status === 'fulfilled' && results[1].value) {
        setBadges(results[1].value)
        setEarned(results[1].value.map(badge => badge.earned))
      }
    })
    return () => { active = false }
  }, [])

  async function apply() {
    if (!badges || saving) return
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const next = await setTrainerBadges(earned)
      setBadges(next)
      setEarned(next.map(badge => badge.earned))
      onChanged()
      setMessage('Badges updated in memory. Export to keep the changes.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not update badges.')
    } finally {
      setSaving(false)
    }
  }

  const changes = badges && badges.some((badge, i) => badge.earned !== earned[i])

  return (
    <section className="save-editor-panel save-editor-progress pixel-border">
      <span className="eyebrow">GAME PROGRESS</span>
      {progress && (
        <div className="save-editor-progress-summary">
          {progress.playTime && (
            <div><span>PLAY TIME</span><strong>{progress.playTime.hours}:{String(progress.playTime.minutes).padStart(2, '0')}</strong></div>
          )}
          {progress.badges && (
            <div><span>GYM BADGES</span><strong>{progress.badges.earned} / {progress.badges.total}</strong></div>
          )}
          {progress.pokedex && (
            <div><span>POKÉDEX</span><strong>{JSON.stringify(progress.pokedex)}</strong></div>
          )}
        </div>
      )}
      {badges && badges.length > 0 && (
        <>
          <h3>BADGES</h3>
          <div className="save-editor-badges">
            {badges.map((badge, index) => (
              <label key={index} className={earned[index] ? 'earned' : ''}>
                <input type="checkbox" checked={earned[index]} disabled={saving} onChange={event => {
                  setEarned(old => old.map((value, at) => at === index ? event.target.checked : value))
                  setMessage('')
                }}/>
                <span>{badge.name.toUpperCase()}</span>
              </label>
            ))}
          </div>
          <PixelButton disabled={!changes || saving} onClick={() => void apply()}>
            {saving ? 'APPLYING...' : 'APPLY BADGES'}
          </PixelButton>
          <p className="save-editor-help">Badge editing is available when the game-specific save format supports it. Other progression flags are not modified.</p>
        </>
      )}
      {error && <p role="alert" className="save-editor-error">{error}</p>}
      {message && <p role="status" className="save-editor-success">{message}</p>}
      {!progress && !badges && <p>Detailed progression data is unavailable for this save.</p>}
    </section>
  )
}
