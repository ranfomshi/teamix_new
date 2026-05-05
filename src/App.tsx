import { Auth0Provider, useAuth0 } from '@auth0/auth0-react'
import {
  Activity,
  CalendarDays,
  ChevronRight,
  ChevronDown,
  CircleUserRound,
  ClipboardList,
  LogOut,
  Plus,
  Shield,
  Shirt,
  Trophy,
  UsersRound,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { BrowserRouter } from 'react-router-dom'

type Room = {
  roomId: number
  playerId: number
  isActive: boolean
  isAdmin: boolean
  name: string
  code: string
  sportId?: number
  teamAColor?: string
  teamBColor?: string
  sportName?: string
}

type Player = {
  id: number
  name: string
  rating: string
  profilePicture?: string | null
  isAdmin?: boolean
}

type Gameweek = {
  id: number
  date: string
  location?: string | null
  startTime?: string | null
  maxPlayers?: number | null
  gameResult?: {
    teamA_score: number
    teamB_score: number
  } | null
}

type Sport = {
  id: number
  name: string
  positions: string[]
}

type ApiState = {
  activeRoom: Room | null
  memberships: Room[]
}

const auth0Domain = import.meta.env.VITE_AUTH0_DOMAIN
const auth0ClientId = import.meta.env.VITE_AUTH0_CLIENT_ID
const auth0Audience = import.meta.env.VITE_AUTH0_AUDIENCE

function App() {
  if (!auth0Domain || !auth0ClientId) {
    return <SetupMissing />
  }

  return (
    <Auth0Provider
      domain={auth0Domain}
      clientId={auth0ClientId}
      authorizationParams={{
        redirect_uri: window.location.origin,
        audience: auth0Audience,
      }}
      cacheLocation="localstorage"
      useRefreshTokens
    >
      <BrowserRouter>
        <AppFrame />
      </BrowserRouter>
    </Auth0Provider>
  )
}

function AppFrame() {
  const { isAuthenticated, isLoading, loginWithRedirect } = useAuth0()
  const location = useLocation()

  if (isLoading) {
    return <Splash label="Lacing up Teamix..." />
  }

  if (!isAuthenticated) {
    return <Welcome onLogin={() => loginWithRedirect()} />
  }

  return (
    <AuthenticatedShell key={location.pathname} />
  )
}

function AuthenticatedShell() {
  const { getAccessTokenSilently, user, logout } = useAuth0()
  const [apiState, setApiState] = useState<ApiState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let mounted = true

    async function loadRoom() {
      try {
        const data = await apiFetch<ApiState>('/api/check-room-membership', getAccessTokenSilently)
        if (mounted) setApiState(data)
      } catch (error) {
        if (mounted) setLoadError(error instanceof Error ? error.message : 'Unable to load room')
      }
    }

    loadRoom()

    return () => {
      mounted = false
    }
  }, [getAccessTokenSilently, reloadKey])

  if (loadError) {
    return (
      <ErrorState
        title="Could not load your squad"
        detail={loadError}
        actionLabel="Sign out"
        onAction={() => logout({ logoutParams: { returnTo: window.location.origin } })}
      />
    )
  }

  if (!apiState) {
    return <Splash label="Finding your active room..." />
  }

  if (!apiState.activeRoom) {
    return <RoomGate memberships={apiState.memberships} onRoomChanged={() => setReloadKey((key) => key + 1)} />
  }

  return (
    <div className="app-shell">
      <TopBar room={apiState.activeRoom} userName={user?.name ?? 'Player'} />
      <main className="app-content">
        <Routes>
          <Route path="/players" element={<PlayersView room={apiState.activeRoom} />} />
          <Route path="/fixtures" element={<FixturesView room={apiState.activeRoom} />} />
          <Route
            path="/account"
            element={
              <AccountView
                room={apiState.activeRoom}
                memberships={apiState.memberships}
                onLogout={() => logout({ logoutParams: { returnTo: window.location.origin } })}
              />
            }
          />
          <Route path="*" element={<Navigate to="/players" replace />} />
        </Routes>
      </main>
      <BottomNav />
    </div>
  )
}

function Welcome({ onLogin }: { onLogin: () => void }) {
  return (
    <main className="welcome">
      <section className="welcome-hero">
        <div className="brand-lockup">
          <img src="/fp_logo.png" alt="Teamix" />
          <div>
            <p>Teamix</p>
            <span>Pick competitive teams faster</span>
          </div>
        </div>
        <h1>Pick fair teams. Track form. Keep everyone match-ready.</h1>
        <p className="welcome-copy">
          A mobile-first team hub for fixtures, availability, player ratings, and
          post-match momentum.
        </p>
        <button className="primary-action" type="button" onClick={onLogin}>
          Get started
          <ChevronRight size={18} />
        </button>
      </section>

    </main>
  )
}

type JoinRoomResponse = {
  status: 'unlinked' | 'already-member' | 'error'
  message?: string
  room?: { id: number; name: string; code: string; sportName?: string }
  unlinkedPlayers?: Player[]
}

function RoomGate({ memberships, onRoomChanged }: { memberships: Room[]; onRoomChanged: () => void }) {
  const { getAccessTokenSilently, logout, user } = useAuth0()
  const { data: sports } = useApi<Sport[]>('/api/sports', getAccessTokenSilently, false)
  const [mode, setMode] = useState<'join' | 'create'>('join')
  const [roomCode, setRoomCode] = useState('')
  const [playerName, setPlayerName] = useState(user?.name ?? '')
  const [roomName, setRoomName] = useState('')
  const [sportId, setSportId] = useState<number | ''>('')
  const [skillLevel, setSkillLevel] = useState('average')
  const [joinResult, setJoinResult] = useState<JoinRoomResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function activateRoom(roomId: number) {
    setBusy(true)
    setError(null)
    try {
      await apiSend('/api/set-active-room', getAccessTokenSilently, { roomId })
      onRoomChanged()
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Could not activate room')
    } finally {
      setBusy(false)
    }
  }

  async function joinRoom() {
    setBusy(true)
    setError(null)
    try {
      const response = await apiSend<JoinRoomResponse>('/api/join-room', getAccessTokenSilently, { code: roomCode })
      setJoinResult(response)
      if (response.status === 'already-member' && response.room) {
        await activateRoom(response.room.id)
      }
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Could not find room')
    } finally {
      setBusy(false)
    }
  }

  async function finalizeJoin(playerId?: number) {
    setBusy(true)
    setError(null)
    try {
      await apiSend('/api/finalize-join-room', getAccessTokenSilently, {
        roomCode,
        playerId,
        newPlayerName: playerId ? undefined : playerName,
        skillLevel,
        profilePicture: user?.picture ?? null,
      })
      onRoomChanged()
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Could not join room')
    } finally {
      setBusy(false)
    }
  }

  async function createRoom() {
    setBusy(true)
    setError(null)
    try {
      await apiSend('/api/create-room', getAccessTokenSilently, {
        name: roomName,
        playerName,
        sportId: Number(sportId),
        skillLevel,
        profilePicture: user?.picture ?? null,
      })
      onRoomChanged()
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Could not create room')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="room-gate">
      <img src="/fp_logo.png" alt="" />
      <h1>Choose or join a squad</h1>
      <p>Your account is signed in, but there is no active room yet.</p>
      {error ? <InlineError message={error} /> : null}
      {memberships.length > 0 ? (
        <div className="room-list">
          {memberships.map((room) => (
            <div className="room-card" key={room.roomId}>
              <div>
                <strong>{room.name}</strong>
                <span>{room.code}</span>
              </div>
              <button type="button" disabled={busy} onClick={() => activateRoom(room.roomId)}>Activate</button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="mode-tabs">
        <button className={mode === 'join' ? 'active' : ''} type="button" onClick={() => setMode('join')}>Join</button>
        <button className={mode === 'create' ? 'active' : ''} type="button" onClick={() => setMode('create')}>Create</button>
      </div>

      {mode === 'join' ? (
        <div className="form-panel">
          <label>
            Room code
            <input value={roomCode} onChange={(event) => setRoomCode(event.target.value.trim())} placeholder="ABC12" />
          </label>
          <button className="primary-action compact" type="button" disabled={busy || !roomCode} onClick={joinRoom}>
            Find room
          </button>
          {joinResult?.room ? (
            <div className="join-result">
              <strong>{joinResult.room.name}</strong>
              <span>{joinResult.room.sportName ?? 'Team sport'} · {joinResult.room.code}</span>
              {joinResult.unlinkedPlayers && joinResult.unlinkedPlayers.length > 0 ? (
                <>
                  <p>Link to an existing player profile</p>
                  {joinResult.unlinkedPlayers.map((player) => (
                    <button type="button" key={player.id} onClick={() => finalizeJoin(player.id)} disabled={busy}>
                      {player.name}
                    </button>
                  ))}
                </>
              ) : null}
              <label>
                Or create your player profile
                <input value={playerName} onChange={(event) => setPlayerName(event.target.value)} placeholder="Your name" />
              </label>
              <select value={skillLevel} onChange={(event) => setSkillLevel(event.target.value)}>
                <option value="beginner">Beginner</option>
                <option value="below_average">Below average</option>
                <option value="average">Average</option>
                <option value="better_than_average">Better than average</option>
                <option value="experienced">Experienced</option>
              </select>
              <button className="primary-action compact" type="button" onClick={() => finalizeJoin()} disabled={busy || !playerName}>
                Join as new player
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="form-panel">
          <label>
            Room name
            <input value={roomName} onChange={(event) => setRoomName(event.target.value)} placeholder="Thursday 6-a-side" />
          </label>
          <label>
            Your player name
            <input value={playerName} onChange={(event) => setPlayerName(event.target.value)} placeholder="Your name" />
          </label>
          <label>
            Sport
            <select value={sportId} onChange={(event) => setSportId(Number(event.target.value))}>
              <option value="">Choose sport</option>
              {sports?.map((sport) => (
                <option key={sport.id} value={sport.id}>{sport.name}</option>
              ))}
            </select>
          </label>
          <select value={skillLevel} onChange={(event) => setSkillLevel(event.target.value)}>
            <option value="beginner">Beginner</option>
            <option value="below_average">Below average</option>
            <option value="average">Average</option>
            <option value="better_than_average">Better than average</option>
            <option value="experienced">Experienced</option>
          </select>
          <button className="primary-action compact" type="button" onClick={createRoom} disabled={busy || !roomName || !playerName || !sportId}>
            Create squad
          </button>
        </div>
      )}
      <button className="secondary-action" type="button" onClick={() => logout({ logoutParams: { returnTo: window.location.origin } })}>
        Sign out
      </button>
    </main>
  )
}

function TopBar({ room, userName }: { room: Room; userName: string }) {
  return (
    <header className="top-bar">
      <div className="room-mark">
        <img src="/fp_logo.png" alt="" />
        <div>
          <strong>{room.name}</strong>
          <span>{room.sportName ?? 'Team sport'} · {userName}</span>
        </div>
      </div>
      <div className="room-code">{room.code}</div>
    </header>
  )
}

function PlayersView({ room }: { room: Room }) {
  const { getAccessTokenSilently } = useAuth0()
  const { data: players, error } = useApi<Player[]>('/api/players', getAccessTokenSilently)
  const squadPlayers = players ?? []
  const averageRating = players?.length
    ? Math.round(players.reduce((total, player) => total + Number(player.rating), 0) / players.length)
    : 0

  return (
    <section className="screen">
      <ScreenHeader
        eyebrow="Squad"
        title="Player form"
        actionLabel="Add"
        icon={<Plus size={17} />}
      />

      <div className="stat-grid">
        <StatCard label="Squad size" value={players?.length ?? '--'} />
        <StatCard label="Avg rating" value={averageRating || '--'} />
      </div>

      {error ? <InlineError message={error} /> : null}
      {!players && !error ? <SkeletonList /> : null}

      <div className="list-stack">
        {squadPlayers.map((player, index) => (
          <PlayerRow key={player.id} player={player} rank={index + 1} room={room} />
        ))}
      </div>
    </section>
  )
}

type FixtureDetail = {
  availability?: Array<{ playerId: number; status: boolean | null; Player: Player }>
  assignments?: Array<{ id: number; team: string; Player: Player }>
}

function FixturesView({ room }: { room: Room }) {
  const { getAccessTokenSilently } = useAuth0()
  const [refreshKey, setRefreshKey] = useState(0)
  const { data: fixtures, error } = useApi<Gameweek[]>(`/api/gameweeks?refresh=${refreshKey}`, getAccessTokenSilently)
  const [showNewFixture, setShowNewFixture] = useState(false)
  const upcoming = fixtures?.filter((fixture) => new Date(fixture.date).getTime() >= Date.now()).slice(-3) ?? []
  const recent = fixtures?.slice(0, 6) ?? []

  return (
    <section className="screen">
      <ScreenHeader
        eyebrow="Fixtures"
        title="Match centre"
        actionLabel="New"
        icon={<Plus size={17} />}
        onAction={() => setShowNewFixture((shown) => !shown)}
      />

      {showNewFixture ? (
        <NewFixtureForm
          onCreated={() => {
            setShowNewFixture(false)
            setRefreshKey((key) => key + 1)
          }}
        />
      ) : null}

      <div className="pitch-card">
        <div>
          <span>Next up</span>
          <strong>{upcoming[0] ? formatFixtureDate(upcoming[0]) : 'No upcoming fixture'}</strong>
          <p>{upcoming[0]?.location ?? 'Set a venue when creating the fixture.'}</p>
        </div>
        <div className="versus">
          <span style={{ background: room.teamAColor ?? '#1cb36b' }} />
          <Shirt size={34} />
          <span style={{ background: room.teamBColor ?? '#e5b931' }} />
        </div>
      </div>

      {error ? <InlineError message={error} /> : null}
      {!fixtures && !error ? <SkeletonList /> : null}

      <div className="fixture-list">
        {recent.map((fixture) => (
          <FixtureCard key={fixture.id} fixture={fixture} room={room} />
        ))}
      </div>
    </section>
  )
}

function NewFixtureForm({ onCreated }: { onCreated: () => void }) {
  const { getAccessTokenSilently } = useAuth0()
  const [date, setDate] = useState('')
  const [startTime, setStartTime] = useState('')
  const [location, setLocation] = useState('')
  const [maxPlayers, setMaxPlayers] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      await apiSend('/api/gameweeks', getAccessTokenSilently, {
        date,
        startTime: startTime || null,
        location: location || null,
        maxPlayers: maxPlayers ? Number(maxPlayers) : null,
      })
      onCreated()
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Could not create fixture')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="form-panel">
      {error ? <InlineError message={error} /> : null}
      <label>
        Date
        <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
      </label>
      <label>
        Start time
        <input type="time" value={startTime} onChange={(event) => setStartTime(event.target.value)} />
      </label>
      <label>
        Location
        <input value={location} onChange={(event) => setLocation(event.target.value)} placeholder="Powerleague, pitch 3" />
      </label>
      <label>
        Max players
        <input inputMode="numeric" value={maxPlayers} onChange={(event) => setMaxPlayers(event.target.value)} placeholder="10" />
      </label>
      <button className="primary-action compact" type="button" onClick={submit} disabled={busy || !date}>
        Add fixture
      </button>
    </div>
  )
}

function FixtureCard({ fixture, room }: { fixture: Gameweek; room: Room }) {
  const { getAccessTokenSilently } = useAuth0()
  const [expanded, setExpanded] = useState(false)
  const [detail, setDetail] = useState<FixtureDetail>({})
  const [detailKey, setDetailKey] = useState(0)
  const [gameResult, setGameResult] = useState(fixture.gameResult)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setGameResult(fixture.gameResult)
  }, [fixture.gameResult])

  useEffect(() => {
    if (!expanded) return

    let mounted = true
    async function loadDetail() {
      setLoading(true)
      setError(null)
      try {
        const [availability, assignments] = await Promise.all([
          apiFetch<Array<{ playerId: number; status: boolean | null; Player: Player }>>(`/api/availability?gameweekId=${fixture.id}`, getAccessTokenSilently),
          apiFetch<Array<{ id: number; team: string; Player: Player }>>(`/api/teamassignments?gameweekId=${fixture.id}`, getAccessTokenSilently),
        ])
        if (mounted) setDetail({ availability, assignments })
      } catch (caughtError) {
        if (mounted) setError(caughtError instanceof Error ? caughtError.message : 'Could not load fixture')
      } finally {
        if (mounted) setLoading(false)
      }
    }

    loadDetail()

    return () => {
      mounted = false
    }
  }, [detailKey, expanded, fixture.id, getAccessTokenSilently])

  async function assignPlayer(playerId: number, team: 'A' | 'B' | 'bench') {
    setError(null)
    try {
      await apiSend('/api/manual-teamassignment', getAccessTokenSilently, {
        gameweekId: fixture.id,
        playerId,
        team,
      })
      setDetailKey((key) => key + 1)
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Could not update team')
    }
  }

  const available = detail.availability?.filter((row) => row.status === true) ?? []
  const unavailable = detail.availability?.filter((row) => row.status === false) ?? []
  const waiting = detail.availability?.filter((row) => row.status === null) ?? []

  return (
    <article className={`fixture-card ${expanded ? 'expanded' : ''}`}>
      <button className="fixture-row fixture-toggle" type="button" onClick={() => setExpanded((value) => !value)}>
        <div className="fixture-date">
          <strong>{new Date(fixture.date).toLocaleDateString(undefined, { day: '2-digit' })}</strong>
          <span>{new Date(fixture.date).toLocaleDateString(undefined, { month: 'short' })}</span>
        </div>
        <div>
          <h3>{fixture.location ?? 'Fixture'}</h3>
          <p>{fixture.startTime ?? 'Time TBC'} - max {fixture.maxPlayers ?? 'open'}</p>
        </div>
        <ResultBadge fixture={{ ...fixture, gameResult }} />
        <ChevronDown className="expand-icon" size={18} />
      </button>

      {expanded ? (
        <div className="fixture-detail">
          {loading ? <p>Loading fixture detail...</p> : null}
          {error ? <InlineError message={error} /> : null}
          {detail.availability ? (
            <div className="detail-stats">
              <StatCard label="Available" value={available.length} />
              <StatCard label="Out" value={unavailable.length} />
              <StatCard label="Waiting" value={waiting.length} />
            </div>
          ) : null}
          {detail.assignments && detail.assignments.length > 0 ? (
            <div className="team-columns">
              <TeamList title="Team A" color={room.teamAColor ?? '#28d17c'} players={detail.assignments.filter((item) => item.team === 'A').map((item) => item.Player)} />
              <TeamList title="Team B" color={room.teamBColor ?? '#f5c84b'} players={detail.assignments.filter((item) => item.team === 'B').map((item) => item.Player)} />
            </div>
          ) : (
            detail.availability ? <p className="muted-note">Teams have not been picked for this fixture yet.</p> : null
          )}
          {room.isAdmin && detail.availability ? (
            <ManualAssignmentPanel
              availability={detail.availability}
              assignments={detail.assignments ?? []}
              onAssign={assignPlayer}
            />
          ) : null}
          {room.isAdmin ? (
            <ResultForm
              fixture={{ ...fixture, gameResult }}
              onSaved={(savedResult) => {
                setGameResult(savedResult)
                setDetailKey((key) => key + 1)
              }}
            />
          ) : null}
          {available.length > 0 ? (
            <div className="mini-player-list">
              <strong>Available players</strong>
              {available.slice(0, 8).map((row) => <span key={row.playerId}>{row.Player.name}</span>)}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}

function TeamList({ title, color, players }: { title: string; color: string; players: Player[] }) {
  return (
    <div className="team-list" style={{ borderColor: color }}>
      <strong>{title}</strong>
      {players.map((player) => <span key={player.id}>{player.name}</span>)}
    </div>
  )
}

function ManualAssignmentPanel({
  availability,
  assignments,
  onAssign,
}: {
  availability: Array<{ playerId: number; status: boolean | null; Player: Player }>
  assignments: Array<{ id: number; team: string; Player: Player }>
  onAssign: (playerId: number, team: 'A' | 'B' | 'bench') => void
}) {
  const assignmentMap = new Map(assignments.map((assignment) => [assignment.Player.id, assignment.team]))
  const available = availability.filter((row) => row.status === true)

  return (
    <div className="manual-panel">
      <strong>Manual override</strong>
      {available.length === 0 ? <p className="muted-note">No available players to assign yet.</p> : null}
      {available.map((row) => (
        <div className="assignment-row" key={row.playerId}>
          <span>{row.Player.name}</span>
          <div>
            <button className={assignmentMap.get(row.playerId) === 'A' ? 'active' : ''} type="button" onClick={() => onAssign(row.playerId, 'A')}>A</button>
            <button className={assignmentMap.get(row.playerId) === 'B' ? 'active' : ''} type="button" onClick={() => onAssign(row.playerId, 'B')}>B</button>
            <button type="button" onClick={() => onAssign(row.playerId, 'bench')}>Bench</button>
          </div>
        </div>
      ))}
    </div>
  )
}

function ResultForm({
  fixture,
  onSaved,
}: {
  fixture: Gameweek
  onSaved: (result: NonNullable<Gameweek['gameResult']>) => void
}) {
  const { getAccessTokenSilently } = useAuth0()
  const [teamA, setTeamA] = useState(fixture.gameResult?.teamA_score?.toString() ?? '')
  const [teamB, setTeamB] = useState(fixture.gameResult?.teamB_score?.toString() ?? '')
  const [message, setMessage] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    setMessage(null)
    try {
      const savedResult = await apiSend<NonNullable<Gameweek['gameResult']>>('/api/gameresults', getAccessTokenSilently, {
        gameweekId: fixture.id,
        teamA_score: Number(teamA),
        teamB_score: Number(teamB),
      })
      setMessage('Result saved')
      onSaved(savedResult)
    } catch (caughtError) {
      setMessage(caughtError instanceof Error ? caughtError.message : 'Could not save result')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="result-form">
      <strong>Record result</strong>
      {message ? <span>{message}</span> : null}
      <div>
        <input inputMode="numeric" value={teamA} onChange={(event) => setTeamA(event.target.value)} placeholder="A" />
        <input inputMode="numeric" value={teamB} onChange={(event) => setTeamB(event.target.value)} placeholder="B" />
        <button type="button" onClick={save} disabled={saving || teamA === '' || teamB === ''}>Save</button>
      </div>
    </div>
  )
}

function AccountView({
  room,
  memberships,
  onLogout,
}: {
  room: Room
  memberships: Room[]
  onLogout: () => void
}) {
  const { getAccessTokenSilently, user } = useAuth0()
  const { data: sports } = useApi<Sport[]>('/api/sports', getAccessTokenSilently, false)
  const [roomName, setRoomName] = useState(room.name)
  const [sportId, setSportId] = useState<number | ''>(room.sportId ?? '')
  const [teamAColor, setTeamAColor] = useState(room.teamAColor ?? '#28d17c')
  const [teamBColor, setTeamBColor] = useState(room.teamBColor ?? '#f5c84b')
  const [saveState, setSaveState] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function saveRoom() {
    setSaving(true)
    setSaveState(null)
    try {
      await apiRequest(`/api/rooms/${room.roomId}`, getAccessTokenSilently, {
        method: 'PUT',
        body: {
          name: roomName,
          sportId: sportId ? Number(sportId) : undefined,
          teamAColor,
          teamBColor,
        },
      })
      setSaveState('Room updated. Reload to refresh the top bar.')
    } catch (caughtError) {
      setSaveState(caughtError instanceof Error ? caughtError.message : 'Could not update room')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="screen">
      <ScreenHeader eyebrow="Account" title="Clubhouse" />

      <div className="profile-panel">
        <img src={user?.picture ?? '/fp_logo.png'} alt="" />
        <div>
          <h2>{user?.name ?? 'Teamix player'}</h2>
          <p>{user?.email ?? room.code}</p>
        </div>
      </div>

      <div className="settings-list">
        <SettingsRow icon={<Shield size={20} />} label="Active room" value={`${room.name} · ${room.code}`} />
        <SettingsRow icon={<UsersRound size={20} />} label="Memberships" value={`${memberships.length} room${memberships.length === 1 ? '' : 's'}`} />
        <SettingsRow icon={<Trophy size={20} />} label="Sports library" value={`${sports?.length ?? '--'} sports`} />
      </div>

      {room.isAdmin ? (
        <div className="form-panel wide">
          <h2>Room management</h2>
          {saveState ? <p className="muted-note">{saveState}</p> : null}
          <label>
            Room name
            <input value={roomName} onChange={(event) => setRoomName(event.target.value)} />
          </label>
          <label>
            Sport
            <select value={sportId} onChange={(event) => setSportId(Number(event.target.value))}>
              <option value="">Choose sport</option>
              {sports?.map((sport) => (
                <option key={sport.id} value={sport.id}>{sport.name}</option>
              ))}
            </select>
          </label>
          <div className="color-grid">
            <label>
              Team A
              <input type="color" value={teamAColor} onChange={(event) => setTeamAColor(event.target.value)} />
            </label>
            <label>
              Team B
              <input type="color" value={teamBColor} onChange={(event) => setTeamBColor(event.target.value)} />
            </label>
          </div>
          <button className="primary-action compact" type="button" onClick={saveRoom} disabled={saving || !roomName}>
            Save room
          </button>
        </div>
      ) : null}

      <button className="logout-button" type="button" onClick={onLogout}>
        <LogOut size={18} />
        Sign out
      </button>
    </section>
  )
}

function BottomNav() {
  return (
    <nav className="bottom-nav" aria-label="Primary">
      <NavLink to="/players">
        <UsersRound size={21} />
        <span>Players</span>
      </NavLink>
      <NavLink to="/fixtures">
        <CalendarDays size={21} />
        <span>Fixtures</span>
      </NavLink>
      <NavLink to="/account">
        <CircleUserRound size={21} />
        <span>Account</span>
      </NavLink>
    </nav>
  )
}

function ScreenHeader({
  eyebrow,
  title,
  actionLabel,
  icon,
  onAction,
}: {
  eyebrow: string
  title: string
  actionLabel?: string
  icon?: React.ReactNode
  onAction?: () => void
}) {
  return (
    <div className="screen-header">
      <div>
        <span>{eyebrow}</span>
        <h1>{title}</h1>
      </div>
      {actionLabel ? (
        <button type="button" onClick={onAction}>
          {icon}
          {actionLabel}
        </button>
      ) : null}
    </div>
  )
}

function PlayerRow({ player, rank, room }: { player: Player; rank: number; room: Room }) {
  return (
    <article className="player-row">
      <div className="rank">{rank}</div>
      <div className="avatar" style={{ borderColor: rank % 2 ? room.teamAColor : room.teamBColor }}>
        {player.profilePicture ? <img src={player.profilePicture} alt="" /> : initials(player.name)}
      </div>
      <div className="player-main">
        <strong>{player.name}</strong>
        <span>{player.isAdmin ? 'Room admin' : 'Squad player'}</span>
      </div>
      <div className="rating-pill">
        <Activity size={14} />
        {Math.round(Number(player.rating))}
      </div>
    </article>
  )
}

function ResultBadge({ fixture }: { fixture: Gameweek }) {
  if (!fixture.gameResult) {
    return <span className="pending-badge">Open</span>
  }

  return (
    <span className="score-badge">
      {fixture.gameResult.teamA_score}-{fixture.gameResult.teamB_score}
    </span>
  )
}

function SettingsRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="settings-row">
      <div>{icon}</div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="stat-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function Splash({ label }: { label: string }) {
  return (
    <main className="splash">
      <img src="/fp_logo.png" alt="" />
      <p>{label}</p>
    </main>
  )
}

function SetupMissing() {
  return (
    <ErrorState
      title="Auth0 is not configured"
      detail="Add VITE_AUTH0_DOMAIN and VITE_AUTH0_CLIENT_ID to the environment."
    />
  )
}

function ErrorState({
  title,
  detail,
  actionLabel,
  onAction,
}: {
  title: string
  detail: string
  actionLabel?: string
  onAction?: () => void
}) {
  return (
    <main className="error-state">
      <ClipboardList size={34} />
      <h1>{title}</h1>
      <p>{detail}</p>
      {actionLabel && onAction ? (
        <button className="secondary-action" type="button" onClick={onAction}>
          <LogOut size={18} />
          {actionLabel}
        </button>
      ) : null}
    </main>
  )
}

function InlineError({ message }: { message: string }) {
  return <div className="inline-error">{message}</div>
}

function SkeletonList() {
  return (
    <div className="skeleton-list">
      <span />
      <span />
      <span />
    </div>
  )
}

function useApi<T>(
  path: string,
  getAccessTokenSilently: () => Promise<string>,
  authenticated = true,
) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const memoPath = useMemo(() => path, [path])

  useEffect(() => {
    let mounted = true

    async function load() {
      try {
        const response = authenticated
          ? await apiFetch<T>(memoPath, getAccessTokenSilently)
          : await fetch(memoPath).then(async (res) => {
            if (!res.ok) throw new Error(await res.text())
            return res.json() as Promise<T>
          })

        if (mounted) setData(response)
      } catch (caughtError) {
        if (mounted) setError(caughtError instanceof Error ? caughtError.message : 'Request failed')
      }
    }

    load()

    return () => {
      mounted = false
    }
  }, [authenticated, getAccessTokenSilently, memoPath])

  return { data, error }
}

async function apiFetch<T>(path: string, getAccessTokenSilently: () => Promise<string>) {
  const token = await getAccessTokenSilently()
  const response = await fetch(path, {
    headers: {
      authorization: `Bearer ${token}`,
    },
  })

  if (!response.ok) {
    throw new Error(await response.text())
  }

  return response.json() as Promise<T>
}

async function apiSend<T = unknown>(
  path: string,
  getAccessTokenSilently: () => Promise<string>,
  body: Record<string, unknown>,
) {
  return apiRequest<T>(path, getAccessTokenSilently, { method: 'POST', body })
}

async function apiRequest<T = unknown>(
  path: string,
  getAccessTokenSilently: () => Promise<string>,
  options: { method: 'POST' | 'PUT' | 'DELETE'; body?: Record<string, unknown> },
) {
  const token = await getAccessTokenSilently()
  const response = await fetch(path, {
    method: options.method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })

  if (!response.ok) {
    throw new Error(await response.text())
  }

  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

function initials(name: string) {
  return name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

function formatFixtureDate(fixture: Gameweek) {
  return new Date(fixture.date).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
}

export default App
