import { useEffect, useState } from 'react'
import type { Choice, PokemonGender, PokemonPatch, PokemonSummary, StatValues } from '@pkhex-everywhere/engine'
import { PixelButton } from '../../components/PixelButton'
import {
  applyPokemonPatch, readPokemonEditorDetails,
  type EditorSnapshot, type PokemonEditorDetails,
} from '../../core/save-editor/pkhexEditor'

const stats = [
  ['health', 'HP'], ['attack', 'ATK'], ['defense', 'DEF'],
  ['specialAttack', 'SP.ATK'], ['specialDefense', 'SP.DEF'], ['speed', 'SPEED'],
] as const
type StatKey = keyof StatValues

interface Form {
  species: number
  form: number
  gender: PokemonGender
  isShiny: boolean
  ball: number
  originalTrainerName: string
  trainerId: string
  secretId: string
  metLevel: string
  metLocation: number
  metDate: string
  nickname: string
  level: string
  nature: number
  ability: number
  heldItem: number
  friendship: string
  moves: number[]
  ivs: Record<StatKey, string>
  evs: Record<StatKey, string>
}

interface Props {
  pokemon: PokemonSummary
  generation: number
  onSaved: (snapshot: EditorSnapshot) => void
  onClose: () => void
}

function statForm(values: StatValues): Record<StatKey, string> {
  return {
    health: String(values.health),
    attack: String(values.attack),
    defense: String(values.defense),
    specialAttack: String(values.specialAttack),
    specialDefense: String(values.specialDefense),
    speed: String(values.speed),
  }
}

function makeForm(info: PokemonEditorDetails): Form {
  const p = info.details
  return {
    species: p.species ?? 0,
    form: p.form,
    gender: p.gender,
    isShiny: p.isShiny,
    ball: p.ball,
    originalTrainerName: p.originalTrainerName,
    trainerId: String(p.trainerId),
    secretId: String(p.secretId),
    metLevel: String(p.metLevel),
    metLocation: p.metLocation,
    metDate: p.metDate ?? '',
    nickname: p.nickname,
    level: String(p.level),
    nature: p.nature,
    ability: p.ability,
    heldItem: p.heldItem,
    friendship: String(p.friendship),
    moves: p.moves.map(move => move.id),
    ivs: statForm(p.ivs),
    evs: statForm(p.evs),
  }
}

function chooseNumber(options: Choice[], id: number) {
  if (options.some(choice => choice.id === id)) return options
  return [{ id, name: 'Current value (' + id + ')' }, ...options]
}

function changedStats(form: Record<StatKey, string>, original: StatValues, max: number): Partial<StatValues> | null {
  const patch: Partial<StatValues> = {}
  for (const [key] of stats) {
    const raw = form[key].trim()
    const amount = Number(raw)
    if (!raw || !Number.isSafeInteger(amount) || amount < 0 || amount > max) {
      throw new Error(key + ' must be a whole number between 0 and ' + max + '.')
    }
    if (amount !== original[key]) patch[key] = amount
  }
  return Object.keys(patch).length ? patch : null
}

export function PokemonDetailPanel({ pokemon, generation, onSaved, onClose }: Props) {
  const [info, setInfo] = useState<PokemonEditorDetails | null>(null)
  const [form, setForm] = useState<Form | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let disposed = false
    setLoading(true)
    setError('')
    void readPokemonEditorDetails(pokemon.at, generation).then(result => {
      if (disposed) return
      setInfo(result)
      setForm(makeForm(result))
      setLoading(false)
    }).catch(reason => {
      if (disposed) return
      setError(reason instanceof Error ? reason.message : 'Unable to read this Pokémon.')
      setLoading(false)
    })
    return () => { disposed = true }
  }, [pokemon, generation])

  function update<K extends keyof Form>(key: K, value: Form[K]) {
    setForm(previous => previous ? { ...previous, [key]: value } : previous)
  }

  async function apply() {
    if (!info || !form || saving) return
    setSaving(true)
    setError('')
    try {
      const p = info.details
      const locked = new Set<string>(info.options.locked)
      const patch: PokemonPatch = {}
      const speciesChanged = form.species !== p.species
      if (speciesChanged && !locked.has('species')) patch.species = form.species
      // Forms/abilities and met locations are species-dependent; apply these
      // only after the species change has been committed and options refreshed.
      if (!speciesChanged && form.form !== p.form && !locked.has('form')) patch.form = form.form
      if (form.gender !== p.gender && !locked.has('gender')) patch.gender = form.gender
      if (form.isShiny !== p.isShiny && !locked.has('isShiny')) patch.isShiny = form.isShiny
      if (form.ball !== p.ball && !locked.has('ball')) patch.ball = form.ball
      if (form.originalTrainerName !== p.originalTrainerName && !locked.has('originalTrainerName')) {
        patch.originalTrainerName = form.originalTrainerName
      }
      const trainerId = Number(form.trainerId)
      const secretId = Number(form.secretId)
      if (trainerId !== p.trainerId && !locked.has('trainerId')) patch.trainerId = trainerId
      if (secretId !== p.secretId && !locked.has('secretId')) patch.secretId = secretId
      const metLevel = Number(form.metLevel)
      if (metLevel !== p.metLevel && !locked.has('metLevel')) patch.metLevel = metLevel
      if (form.metLocation !== p.metLocation && !locked.has('metLocation')) patch.metLocation = form.metLocation
      if (p.metDate !== null && form.metDate !== p.metDate && !locked.has('metDate')) {
        patch.metDate = form.metDate
      }
      const level = Number(form.level)
      const friendship = Number(form.friendship)
      if (form.nickname !== p.nickname && !locked.has('nickname')) patch.nickname = form.nickname
      if (level !== p.level && !locked.has('level')) patch.level = level
      if (friendship !== p.friendship && !locked.has('friendship')) patch.friendship = friendship
      if (generation >= 3 && form.nature !== p.nature && !locked.has('nature')) patch.nature = form.nature
      if (!speciesChanged && generation >= 3 && form.ability !== p.ability && !locked.has('ability')) patch.ability = form.ability
      if (generation >= 2 && form.heldItem !== p.heldItem && !locked.has('heldItem')) patch.heldItem = form.heldItem
      if (form.moves.some((id, index) => id !== p.moves[index]?.id) && !locked.has('moves')) {
        patch.moves = form.moves
      }
      if (!locked.has('ivs')) {
        const ivs = changedStats(form.ivs, p.ivs, generation <= 2 ? 15 : 31)
        if (ivs) patch.ivs = ivs
      }
      if (!locked.has('evs')) {
        const evs = changedStats(form.evs, p.evs, generation <= 2 ? 65535 : 255)
        if (evs) patch.evs = evs
      }
      if (!Object.keys(patch).length) {
        onClose()
        return
      }
      // High-impact changes can produce nonlegal Pokémon. Require an explicit
      // one-time confirmation before touching the in-memory save.
      const impactful = ['species', 'isShiny', 'gender', 'trainerId', 'secretId', 'originalTrainerName', 'metLevel', 'metLocation', 'metDate', 'ball']
      if (Object.keys(patch).some(key => impactful.includes(key)) &&
          !window.confirm('These changes can alter Pokémon legality or encounter details. Apply them to the in-memory copy?')) {
        return
      }
      const next = await applyPokemonPatch(pokemon.at, patch)
      onSaved(next)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not apply Pokémon changes.')
    } finally {
      setSaving(false)
    }
  }

  const locked = new Set<string>(info?.options.locked ?? [])
  const editable = info?.details.editable && !info.details.isUnknown
  const noChanges = info && form && JSON.stringify(form) === JSON.stringify(makeForm(info))
  const availableMoves = info?.options.moves ?? []

  return (
    <section className="save-editor-panel save-editor-selected pixel-border">
      <div className="save-detail-heading">
        <div>
          <span className="eyebrow">POKÉMON EDITOR</span>
          <h2>{pokemon.species.toUpperCase()} <small>LV {pokemon.level}</small></h2>
        </div>
        <PixelButton tone="ghost" onClick={onClose}>CLOSE</PixelButton>
      </div>

      {loading && <p>READING POKÉMON DATA...</p>}
      {error && <p className="save-editor-error" role="alert">{error}</p>}
      {!loading && !editable && <p>This Pokémon's save fields cannot safely be edited.</p>}
      {!loading && editable && info && form && (
        <>
          <div className="save-editor-detail-stats">
            <span>{info.details.isShiny ? '★ SHINY' : 'NORMAL'}</span>
            <span>{info.details.originalTrainerName || 'UNKNOWN OT'} · OT</span>
            <span>{info.details.legality === null ? 'LEGALITY UNAVAILABLE' :
              info.details.legality.valid ? 'PKHEX: LEGAL' : 'PKHEX: CHECK REQUIRED'}</span>
          </div>
          {info.details.legality && !info.details.legality.valid && (
            <details className="save-editor-legality">
              <summary>Legality concerns ({info.details.legality.messages.length})</summary>
              {info.details.legality.messages.map((message, i) => <p key={i}>{message}</p>)}
            </details>
          )}

          <div className="save-detail-group">
            <h3>SPECIES & APPEARANCE</h3>
            <div className="save-editor-fields">
              <label className="save-editor-field">SPECIES / EVOLUTION
                <select aria-label="Pokémon species" value={form.species}
                  disabled={saving || locked.has('species')}
                  onChange={event => {
                    update('species', Number(event.target.value))
                  }}>
                  {chooseNumber(info.options.species, form.species).map(choice =>
                    <option key={choice.id} value={choice.id}>{choice.name}</option>)}
                </select>
              </label>
              {info.options.forms.length > 0 && (
                <label className="save-editor-field">FORM
                  <select value={form.form} disabled={saving || locked.has('form') || form.species !== info.details.species}
                    onChange={event => update('form', Number(event.target.value))}>
                    {chooseNumber(info.options.forms, form.form).map(choice =>
                      <option key={choice.id} value={choice.id}>{choice.name || 'DEFAULT'}</option>)}
                  </select>
                </label>
              )}
              <label className="save-editor-field">GENDER
                <select value={form.gender} disabled={saving || locked.has('gender')}
                  onChange={event => update('gender', event.target.value as PokemonGender)}>
                  <option value="male">MALE</option><option value="female">FEMALE</option>
                  <option value="genderless">GENDERLESS</option>
                </select>
              </label>
              <label className="save-editor-field save-editor-toggle">SHINY
                <label className="save-editor-check">
                  <input type="checkbox" checked={form.isShiny} disabled={saving || locked.has('isShiny')}
                    onChange={event => update('isShiny', event.target.checked)}/>
                  <span>{form.isShiny ? 'SHINY ENABLED' : 'NOT SHINY'}</span>
                </label>
              </label>
            </div>
            <p className="save-editor-help">
              Species selection follows the Pokémon's evolution line. After changing species,
              reopen the Pokémon to adjust the new form or ability. Shiny and gender edits may affect PID legality.
            </p>
          </div>

          <div className="save-detail-group">
            <h3>IDENTITY</h3>
            <div className="save-editor-fields">
              <label className="save-editor-field">NICKNAME
                <input value={form.nickname} maxLength={10}
                  disabled={saving || locked.has('nickname')}
                  onChange={event => update('nickname', event.target.value)}/>
              </label>
              <label className="save-editor-field">LEVEL
                <input value={form.level} type="number" min="1" max="100"
                  disabled={saving || locked.has('level')}
                  onChange={event => update('level', event.target.value)}/>
              </label>
              <label className="save-editor-field">FRIENDSHIP
                <input value={form.friendship} type="number" min="0" max="255"
                  disabled={saving || locked.has('friendship')}
                  onChange={event => update('friendship', event.target.value)}/>
              </label>
            </div>
            <div className="save-editor-fields">
              {generation >= 3 && info.natures.length > 0 && (
                <label className="save-editor-field">NATURE
                  <select value={form.nature} disabled={saving || locked.has('nature')}
                    onChange={event => update('nature', Number(event.target.value))}>
                    {chooseNumber(info.natures, form.nature).map(choice =>
                      <option key={choice.id} value={choice.id}>{choice.name}</option>)}
                  </select>
                </label>
              )}
              {generation >= 3 && info.options.abilities.length > 0 && (
                <label className="save-editor-field">ABILITY
                  <select value={form.ability} disabled={saving || locked.has('ability')}
                    onChange={event => update('ability', Number(event.target.value))}>
                    {chooseNumber(info.options.abilities, form.ability).map(choice =>
                      <option key={choice.id} value={choice.id}>{choice.name}</option>)}
                  </select>
                </label>
              )}
              {generation >= 2 && info.options.heldItems.length > 0 && (
                <label className="save-editor-field">HELD ITEM
                  <select value={form.heldItem} disabled={saving || locked.has('heldItem')}
                    onChange={event => update('heldItem', Number(event.target.value))}>
                    {info.options.heldItems.map(item =>
                      <option key={item.id} value={item.id}>{item.name}</option>)}
                  </select>
                </label>
              )}
            </div>
          </div>

          <div className="save-detail-group">
            <h3>MOVES</h3>
            <div className="save-editor-move-grid">
              {form.moves.map((moveId, index) => (
                <label className="save-editor-field" key={index}>MOVE {index + 1}
                  <select value={moveId} disabled={saving || locked.has('moves')}
                    onChange={event => {
                      const next = [...form.moves]
                      next[index] = Number(event.target.value)
                      update('moves', next)
                    }}>
                    <option value={0}>— EMPTY —</option>
                    {chooseNumber(availableMoves, moveId).filter(move => move.id !== 0).map(move =>
                      <option value={move.id} key={move.id}>{move.name}</option>)}
                  </select>
                </label>
              ))}
            </div>
            <p className="save-editor-help">Available moves are based on the Pokémon and save's game, not a universal movelist.</p>
          </div>

          <div className="save-detail-group">
            <h3>ORIGINAL TRAINER & ENCOUNTER</h3>
            <div className="save-editor-fields">
              {info.balls.length > 0 && (
                <label className="save-editor-field">POKÉ BALL
                  <select value={form.ball} disabled={saving || locked.has('ball')}
                    onChange={event => update('ball', Number(event.target.value))}>
                    {chooseNumber(info.balls, form.ball).map(choice =>
                      <option key={choice.id} value={choice.id}>{choice.name}</option>)}
                  </select>
                </label>
              )}
              <label className="save-editor-field">ORIGINAL TRAINER
                <input maxLength={12} value={form.originalTrainerName}
                  disabled={saving || locked.has('originalTrainerName')}
                  onChange={event => update('originalTrainerName', event.target.value)}/>
              </label>
              <label className="save-editor-field">TRAINER ID
                <input type="number" min="0" max="65535" value={form.trainerId}
                  disabled={saving || locked.has('trainerId')}
                  onChange={event => update('trainerId', event.target.value)}/>
              </label>
              <label className="save-editor-field">SECRET ID
                <input type="number" min="0" max="65535" value={form.secretId}
                  disabled={saving || locked.has('secretId')}
                  onChange={event => update('secretId', event.target.value)}/>
              </label>
              {generation >= 2 && (
                <label className="save-editor-field">MET LEVEL
                  <input type="number" min="0" max="100" value={form.metLevel}
                    disabled={saving || locked.has('metLevel')}
                    onChange={event => update('metLevel', event.target.value)}/>
                </label>
              )}
              {info.options.metLocations.length > 0 && (
                <label className="save-editor-field">MET LOCATION
                  <select value={form.metLocation} disabled={saving || locked.has('metLocation')}
                    onChange={event => update('metLocation', Number(event.target.value))}>
                    {chooseNumber(info.options.metLocations, form.metLocation).map(choice =>
                      <option key={choice.id} value={choice.id}>{choice.name}</option>)}
                  </select>
                </label>
              )}
              {info.details.metDate !== null && (
                <label className="save-editor-field">MET DATE
                  <input type="date" min="2000-01-01" max="2099-12-31" value={form.metDate}
                    disabled={saving || locked.has('metDate')}
                    onChange={event => update('metDate', event.target.value)}/>
                </label>
              )}
            </div>
            <p className="save-editor-help">These fields can affect legality. PKHeX checks data structure, but gameplay and trading compatibility still need real-save testing.</p>
          </div>

          <div className="save-detail-group">
            <h3>STATS</h3>
            <div className="save-editor-detail-stats">
              <span>EXP: {info.details.experience.toLocaleString()}</span>
              <span>PID: {info.details.pid.toString(16).toUpperCase().padStart(8, '0')}</span>
              {info.details.hiddenPower && <span>HIDDEN POWER: {info.details.hiddenPower.type} {info.details.hiddenPower.power ?? ''}</span>}
            </div>
            <p className="save-editor-help">Generation {generation}: IV maximum {generation <= 2 ? 15 : 31},
              EV maximum {generation <= 2 ? 65535 : 255} per stat.</p>
            <div className="save-editor-stat-table">
              <span>STAT</span><span>IV</span><span>EV</span>
              {stats.map(([key, label]) => (
                <div className="save-editor-stat-row" key={key}>
                  <strong>{label}</strong>
                  <input aria-label={label + ' IV'} type="number" min="0" max={generation <= 2 ? 15 : 31}
                    value={form.ivs[key]} disabled={saving || locked.has('ivs')}
                    onChange={event => update('ivs', { ...form.ivs, [key]: event.target.value })}/>
                  <input aria-label={label + ' EV'} type="number" min="0" max={generation <= 2 ? 65535 : 255}
                    value={form.evs[key]} disabled={saving || locked.has('evs')}
                    onChange={event => update('evs', { ...form.evs, [key]: event.target.value })}/>
                </div>
              ))}
            </div>
          </div>

          <div className="save-editor-actions">
            <PixelButton disabled={saving || Boolean(noChanges)} onClick={() => void apply()}>
              {saving ? 'APPLYING...' : 'APPLY POKÉMON CHANGES'}
            </PixelButton>
            <PixelButton tone="ghost" disabled={saving}
              onClick={() => setForm(makeForm(info))}>RESET FIELDS</PixelButton>
          </div>
          <p className="save-editor-help">Changes remain in memory until you export an edited save. PKHeX legality findings are advisory; a successful edit does not guarantee a Pokémon is legal.</p>
        </>
      )}
    </section>
  )
}
