import type { MultiplayerPlayerState } from '../multiplayer/core/protocol'

export type MultiplayerPartyMember = {
  species: string
  level?: number
  hp?: number
  maxHp?: number
}

type Props = {
  playerLabel: string
  roleLabel: string
  state: MultiplayerPlayerState | null
  badges?: number
  party?: MultiplayerPartyMember[]
  relation: 'together' | 'apart' | 'waiting'
  error?: string | null
}

function locationTitle(state: MultiplayerPlayerState | null) {
  return state ? `MAP ${state.location.mapId}` : 'LOCATION UNKNOWN'
}

function hpPercent(member: MultiplayerPartyMember) {
  if (!member.maxHp || member.hp === undefined) return null
  return Math.max(0, Math.min(100, Math.round(member.hp / member.maxHp * 100)))
}

export function MultiplayerPlayerPanel({ playerLabel, roleLabel, state, badges, party, relation, error }: Props) {
  const badgeCount = Math.max(0, Math.min(8, badges ?? 0))
  const members = party ?? []

  return (
    <aside className="multiplayer-player-panel pixel-border">
      <header className="multiplayer-player-heading">
        <span className="eyebrow">{roleLabel}</span>
        <h2>{playerLabel}</h2>
      </header>

      <section className="multiplayer-player-section">
        <span className="multiplayer-panel-label">LOCATION</span>
        <strong className="multiplayer-location-name">{locationTitle(state)}</strong>
        {state ? (
          <div className="multiplayer-location-meta">
            <span>X {state.x}</span>
            <span>Y {state.y}</span>
            <span>{state.direction.toUpperCase()}</span>
          </div>
        ) : error ? <small className="form-error">{error}</small> : <small>WAITING FOR LIVE POSITION</small>}
      </section>

      <section className="multiplayer-player-section">
        <div className="multiplayer-section-title">
          <span className="multiplayer-panel-label">GYM BADGES</span>
          <small>{badges === undefined ? 'READ PENDING' : `${badgeCount}/8`}</small>
        </div>
        <div className="multiplayer-badges" aria-label={badges === undefined ? 'Badge data not available yet' : `${badgeCount} of 8 badges`}>
          {Array.from({ length: 8 }, (_, index) => <span key={index} className={index < badgeCount ? 'earned' : ''}>{index + 1}</span>)}
        </div>
      </section>

      <section className="multiplayer-player-section multiplayer-party-section">
        <div className="multiplayer-section-title">
          <span className="multiplayer-panel-label">PARTY</span>
          <small>{party === undefined ? 'READ PENDING' : `${members.length}/6`}</small>
        </div>
        <div className="multiplayer-party-list">
          {Array.from({ length: 6 }, (_, index) => {
            const member = members[index]
            if (!member) return <div className="multiplayer-party-slot empty" key={index}><span>{index + 1}</span><strong>—</strong></div>
            const percent = hpPercent(member)
            return <div className="multiplayer-party-slot" key={`${member.species}-${index}`}><span>{index + 1}</span><div><strong>{member.species.toUpperCase()}</strong><small>{member.level ? `LV.${member.level}` : 'LEVEL —'}</small>{percent !== null && <div className="multiplayer-party-hp"><i style={{ width: `${percent}%` }}/></div>}</div></div>
          })}
        </div>
      </section>

      <footer className={`multiplayer-proximity ${relation}`}>
        <span className="multiplayer-proximity-dot" aria-hidden="true"/>
        <strong>{relation === 'together' ? 'SAME AREA' : relation === 'apart' ? 'DIFFERENT AREA' : 'WAITING FOR PARTNER'}</strong>
      </footer>
    </aside>
  )
}
