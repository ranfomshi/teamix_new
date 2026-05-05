import { Auth0Provider, useAuth0 } from '@auth0/auth0-react'
import {
  // Activity,
  ArrowDownUp,
  CalendarDays,
  ChevronRight,
  ChevronDown,
  CircleUserRound,
  ClipboardList,
  LogOut,
  Pencil,
  Plus,
  Search,
  Settings,
  Shield,
  Shirt,
  Trophy,
  Trash2,
  UsersRound,
  X,
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
  favoritePositions?: string[]
  wins?: number
  draws?: number
  losses?: number
  goalsFor?: number
  goalsAgainst?: number
  recentForm?: Array<'W' | 'D' | 'L'>
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
    createdAt?: string
  } | null
  votingCloseTime?: string | null
  playerOfTheMatch?: Array<{ id: number; name: string; votes: number }>
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

type RoomMember = {
  playerId: number
  name: string
  profilePicture?: string | null
  isAdmin: boolean
  isLinked: boolean
  favoritePositions?: string[]
}

type HasVotedResponse = {
  hasVoted: boolean
  player_id: number
  votedPlayerId?: number | null
}

type RatingSummary = {
  playerId: number
  playerName: string
  avgRating: number
  ratings: Array<{ id: number; date: string; rating: string | number; raterId: number | null }>
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
    return <LoadingShell userName={user?.name ?? 'Player'} />
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
                onRoomChanged={() => setReloadKey((key) => key + 1)}
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

function LoadingShell({ userName }: { userName: string }) {
  return (
    <div className="app-shell">
      <header className="top-bar">
        <div className="room-mark">
          <img src="/fp_logo.png" alt="" />
          <div>
            <strong>Loading Teamix</strong>
            <span>{userName}</span>
          </div>
        </div>
        <div className="room-code">...</div>
      </header>
      <main className="app-content">
        <div className="shell-loading">
          <img src="/fp_logo.png" alt="" />
          <p>Finding your active room...</p>
        </div>
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

const SKILL_OPTIONS = [
  { value: 'beginner', label: 'Beginner - below group average' },
  { value: 'below_average', label: 'Below average' },
  { value: 'average', label: 'Average - similar to group level' },
  { value: 'better_than_average', label: 'Better than average' },
  { value: 'experienced', label: 'Experienced - well above group average' },
]

function SkillLevelField({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  return (
    <label>
      Your starting skill level
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {SKILL_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      <span className="field-help">Used only to seed your starting rating for fair team selection.</span>
    </label>
  )
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
                  <p>Is this you? Link to an existing player profile:</p>
                  {joinResult.unlinkedPlayers.map((player) => (
                    <button type="button" key={player.id} onClick={() => finalizeJoin(player.id)} disabled={busy}>
                      {player.name}
                    </button>
                  ))}
                  <div className="join-divider"><span>or create a new profile</span></div>
                </>
              ) : null}
              <label>
                {joinResult.unlinkedPlayers && joinResult.unlinkedPlayers.length > 0 ? 'Your name' : 'Create your player profile'}
                <input value={playerName} onChange={(event) => setPlayerName(event.target.value)} placeholder="Your name" />
              </label>
              <SkillLevelField value={skillLevel} onChange={setSkillLevel} />
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
          <SkillLevelField value={skillLevel} onChange={setSkillLevel} />
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

type SortKey = 'wins' | 'winPct' | 'draws' | 'losses' | 'played' | 'goalsFor' | 'goalsAgainst' | 'goalDiff' | 'rating' | 'name'

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'wins', label: 'Wins' },
  { value: 'winPct', label: 'Win %' },
  { value: 'draws', label: 'Draws' },
  { value: 'losses', label: 'Losses' },
  { value: 'played', label: 'Games played' },
  { value: 'goalsFor', label: 'Goals for' },
  { value: 'goalsAgainst', label: 'Goals against' },
  { value: 'goalDiff', label: 'Goal difference' },
  { value: 'rating', label: 'Rating' },
  { value: 'name', label: 'Name (A–Z)' },
]

function sortPlayers(players: Player[], by: SortKey, dir: 'asc' | 'desc'): Player[] {
  return [...players].sort((a, b) => {
    const gd = (p: Player) => (p.goalsFor ?? 0) - (p.goalsAgainst ?? 0)
    const played = (p: Player) => (p.wins ?? 0) + (p.draws ?? 0) + (p.losses ?? 0)
    let diff = 0
    switch (by) {
      case 'wins': diff = (a.wins ?? 0) - (b.wins ?? 0); break
      case 'winPct': diff = ((a.wins ?? 0) / Math.max(played(a), 1)) - ((b.wins ?? 0) / Math.max(played(b), 1)); break
      case 'draws': diff = (a.draws ?? 0) - (b.draws ?? 0); break
      case 'losses': diff = (a.losses ?? 0) - (b.losses ?? 0); break
      case 'played': diff = played(a) - played(b); break
      case 'goalsFor': diff = (a.goalsFor ?? 0) - (b.goalsFor ?? 0); break
      case 'goalsAgainst': diff = (a.goalsAgainst ?? 0) - (b.goalsAgainst ?? 0); break
      case 'goalDiff': diff = gd(a) - gd(b); break
      case 'rating': diff = Number(a.rating) - Number(b.rating); break
      case 'name': diff = a.name.localeCompare(b.name); break
    }
    return dir === 'asc' ? diff : -diff
  })
}

function PlayersView({ room }: { room: Room }) {
  const { getAccessTokenSilently } = useAuth0()
  const [players, setPlayers] = useState<Player[] | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [showAddForm, setShowAddForm] = useState(false)
  const [editingPlayer, setEditingPlayer] = useState<Player | null>(null)
  const [deletingPlayer, setDeletingPlayer] = useState<Player | null>(null)
  const [sortBy, setSortBy] = useState<SortKey>('wins')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [search, setSearch] = useState('')
  const [showSearch, setShowSearch] = useState(false)

  useEffect(() => {
    let mounted = true
    setFetchError(null)
    async function load() {
      try {
        const data = await apiFetch<Player[]>('/api/players', getAccessTokenSilently)
        if (mounted) setPlayers(data)
      } catch (err) {
        if (mounted) setFetchError(err instanceof Error ? err.message : 'Could not load players')
      }
    }
    load()
    return () => { mounted = false }
  }, [getAccessTokenSilently, refreshKey])

  const averageRating = players?.length
    ? Math.round(players.reduce((total, player) => total + Number(player.rating), 0) / players.length)
    : 0

  function refresh() { setRefreshKey((key) => key + 1) }

  const sorted = sortPlayers(
    (players ?? []).filter((p) => !search || p.name.toLowerCase().includes(search.toLowerCase())),
    sortBy,
    sortDir,
  )

  return (
    <section className="screen">
      <ScreenHeader
        eyebrow="Squad"
        title="Player form"
        actionLabel={showAddForm ? 'Cancel' : 'Add'}
        icon={showAddForm ? <X size={17} /> : <Plus size={17} />}
        onAction={() => { setShowAddForm((show) => !show); setEditingPlayer(null); setDeletingPlayer(null) }}
      />

      {showAddForm ? (
        <AddPlayerForm onCreated={() => { setShowAddForm(false); refresh() }} />
      ) : null}

      {editingPlayer ? (
        <EditPlayerForm
          player={editingPlayer}
          onSaved={() => { setEditingPlayer(null); refresh() }}
          onCancel={() => setEditingPlayer(null)}
        />
      ) : null}

      {deletingPlayer ? (
        <DeletePlayerConfirm
          player={deletingPlayer}
          onDeleted={() => { setDeletingPlayer(null); refresh() }}
          onCancel={() => setDeletingPlayer(null)}
        />
      ) : null}

      <div className="stat-grid">
        <StatCard label="Squad size" value={players?.length ?? '--'} />
        <StatCard label="Avg rating" value={averageRating || '--'} />
      </div>

      <div className="sort-bar">
        <button
          type="button"
          className={`icon-btn${showSearch ? ' active' : ''}`}
          onClick={() => { setShowSearch((s) => !s); if (showSearch) setSearch('') }}
          title="Search players"
        >
          <Search size={15} />
        </button>
        <select
          className="sort-select"
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as SortKey)}
        >
          {SORT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <button
          type="button"
          className="icon-btn"
          onClick={() => setSortDir((d) => d === 'asc' ? 'desc' : 'asc')}
          title={sortDir === 'desc' ? 'Descending — click to flip' : 'Ascending — click to flip'}
        >
          <ArrowDownUp size={15} style={{ transform: sortDir === 'asc' ? 'scaleY(-1)' : 'none' }} />
        </button>
        {showSearch ? (
          <input
            className="search-input"
            placeholder="Find player…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
        ) : null}
      </div>

      {fetchError ? <InlineError message={fetchError} /> : null}
      {!players && !fetchError ? <SkeletonList /> : null}

      <div className="list-stack">
        {sorted.map((player, index) => (
          <PlayerRow
            key={player.id}
            player={player}
            rank={index + 1}
            room={room}
            onEdit={room.isAdmin ? () => { setEditingPlayer(player); setDeletingPlayer(null); setShowAddForm(false) } : undefined}
            onDelete={room.isAdmin ? () => { setDeletingPlayer(player); setEditingPlayer(null); setShowAddForm(false) } : undefined}
          />
        ))}
      </div>
    </section>
  )
}

function AddPlayerForm({ onCreated }: { onCreated: () => void }) {
  const { getAccessTokenSilently } = useAuth0()
  const [name, setName] = useState('')
  const [skillLevel, setSkillLevel] = useState('average')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (!name.trim()) return
    setBusy(true)
    setError(null)
    try {
      await apiSend('/api/players', getAccessTokenSilently, { name: name.trim(), skillLevel })
      onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add player')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="form-panel wide">
      <h2>Add player</h2>
      {error ? <InlineError message={error} /> : null}
      <label>
        Name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="Player name"
          autoFocus
        />
      </label>
      <SkillLevelField value={skillLevel} onChange={setSkillLevel} />
      <button className="primary-action compact" type="button" onClick={submit} disabled={busy || !name.trim()}>
        Add player
      </button>
    </div>
  )
}

function EditPlayerForm({ player, onSaved, onCancel }: { player: Player; onSaved: () => void; onCancel: () => void }) {
  const { getAccessTokenSilently } = useAuth0()
  const [name, setName] = useState(player.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (!name.trim()) return
    setBusy(true)
    setError(null)
    try {
      await apiRequest(`/api/players/${player.id}`, getAccessTokenSilently, { method: 'PUT', body: { name: name.trim() } })
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update player')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="form-panel wide">
      <h2>Edit player</h2>
      {error ? <InlineError message={error} /> : null}
      <label>
        Name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          autoFocus
        />
      </label>
      <div className="form-row">
        <button className="primary-action compact" type="button" onClick={submit} disabled={busy || !name.trim()}>Save</button>
        <button className="secondary-action" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

function DeletePlayerConfirm({ player, onDeleted, onCancel }: { player: Player; onDeleted: () => void; onCancel: () => void }) {
  const { getAccessTokenSilently } = useAuth0()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function confirm() {
    setBusy(true)
    setError(null)
    try {
      await apiRequest(`/api/players/${player.id}`, getAccessTokenSilently, { method: 'DELETE' })
      onDeleted()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete player')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="form-panel wide">
      <h2>Remove {player.name}?</h2>
      <p className="muted-note">This cannot be undone and will remove all their stats.</p>
      {error ? <InlineError message={error} /> : null}
      <div className="form-row">
        <button className="danger-button" type="button" onClick={confirm} disabled={busy}>Delete</button>
        <button className="secondary-action" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

type FixtureDetail = {
  availability?: Array<{ playerId: number; status: boolean | null; Player: Player }>
  assignments?: Array<{ id: number; team: string; Player: Player }>
  hasVoted?: HasVotedResponse
}

function FixturesView({ room }: { room: Room }) {
  const { getAccessTokenSilently } = useAuth0()
  const [refreshKey, setRefreshKey] = useState(0)
  const { data: fixtures, error } = useApi<Gameweek[]>(`/api/gameweeks?refresh=${refreshKey}`, getAccessTokenSilently)
  const [showNewFixture, setShowNewFixture] = useState(false)
  const nextFixture = (fixtures ?? [])
    .filter((fixture) => new Date(fixture.date).getTime() >= Date.now())
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())[0]

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
          <strong>{nextFixture ? formatFixtureDate(nextFixture) : 'No upcoming fixture'}</strong>
          <p>{nextFixture?.location ?? 'Set a venue when creating the fixture.'}</p>
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
        {fixtures?.map((fixture) => (
          <FixtureCard
            key={fixture.id}
            fixture={fixture}
            room={room}
            onDeleted={() => setRefreshKey((key) => key + 1)}
          />
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

type AdminAction = 'manual' | 'result' | 'delete' | null

function FixtureCard({
  fixture,
  room,
  onDeleted,
}: {
  fixture: Gameweek
  room: Room
  onDeleted: () => void
}) {
  const { getAccessTokenSilently } = useAuth0()
  const [expanded, setExpanded] = useState(false)
  const [detail, setDetail] = useState<FixtureDetail>({})
  const [detailKey, setDetailKey] = useState(0)
  const [gameResult, setGameResult] = useState(fixture.gameResult)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [adminAction, setAdminAction] = useState<AdminAction>(null)
  const [deleting, setDeleting] = useState(false)
  const [savingAvailability, setSavingAvailability] = useState(false)

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
        const [availability, assignments, hasVoted] = await Promise.all([
          apiFetch<Array<{ playerId: number; status: boolean | null; Player: Player }>>(`/api/availability?gameweekId=${fixture.id}`, getAccessTokenSilently),
          apiFetch<Array<{ id: number; team: string; Player: Player }>>(`/api/teamassignments?gameweekId=${fixture.id}`, getAccessTokenSilently),
          apiFetch<HasVotedResponse>(`/api/has-voted?gameweekId=${fixture.id}`, getAccessTokenSilently),
        ])
        if (mounted) setDetail({ availability, assignments, hasVoted })
      } catch (caughtError) {
        if (mounted) setError(caughtError instanceof Error ? caughtError.message : 'Could not load fixture')
      } finally {
        if (mounted) setLoading(false)
      }
    }

    loadDetail()
    return () => { mounted = false }
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

  async function deleteFixture() {
    setDeleting(true)
    setError(null)
    try {
      await apiRequest(`/api/gameweeks/${fixture.id}`, getAccessTokenSilently, { method: 'DELETE' })
      onDeleted()
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Could not delete fixture')
      setDeleting(false)
    }
  }

  function toggleAdmin(action: AdminAction) {
    setAdminAction((current) => current === action ? null : action)
  }

  async function setAvailability(status: boolean, playerId = room.playerId) {
    setSavingAvailability(true)
    setError(null)
    try {
      await apiSend('/api/availability', getAccessTokenSilently, {
        playerId,
        gameweekId: fixture.id,
        status,
      })
      setDetailKey((key) => key + 1)
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Could not update availability')
    } finally {
      setSavingAvailability(false)
    }
  }

  async function castVote(playerId: number) {
    setError(null)
    try {
      await apiSend('/api/votes', getAccessTokenSilently, {
        gameweekId: fixture.id,
        votedPlayerId: playerId,
      })
      setDetailKey((key) => key + 1)
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Could not cast vote')
    }
  }

  const isPast = isFixturePast(fixture)
  const available = detail.availability?.filter((row) => row.status === true) ?? []
  const unavailable = detail.availability?.filter((row) => row.status === false) ?? []
  const waiting = detail.availability?.filter((row) => row.status === null) ?? []
  const myAvailability = detail.availability?.find((row) => row.playerId === room.playerId)?.status ?? null
  const teamAPlayers = detail.assignments?.filter((item) => item.team === 'A').map((item) => item.Player) ?? []
  const teamBPlayers = detail.assignments?.filter((item) => item.team === 'B').map((item) => item.Player) ?? []
  const assignedPlayerIds = new Set(detail.assignments?.map((item) => item.Player.id) ?? [])
  const votingClosesAt = fixture.votingCloseTime ? new Date(fixture.votingCloseTime).getTime() : null
  const votingOpen = Boolean(gameResult && votingClosesAt && Date.now() <= votingClosesAt)
  const canVote = votingOpen && assignedPlayerIds.has(room.playerId) && detail.hasVoted?.hasVoted === false

  return (
    <article className={`fixture-card ${expanded ? 'expanded' : ''}`}>
      <button className="fixture-row fixture-toggle" type="button" onClick={() => setExpanded((value) => !value)}>
        <div className="fixture-date">
          <strong>{new Date(fixture.date).toLocaleDateString(undefined, { day: '2-digit' })}</strong>
          <span>{new Date(fixture.date).toLocaleDateString(undefined, { month: 'short' })}</span>
        </div>
        <div>
          <h3>{fixture.location ?? 'Fixture'}</h3>
          <p>{fixture.startTime ?? 'Time TBC'} · max {fixture.maxPlayers ?? 'open'}</p>
        </div>
        <ResultBadge fixture={{ ...fixture, gameResult }} />
        <ChevronDown className="expand-icon" size={18} />
      </button>

      {expanded ? (
        <div className="fixture-detail">
          {loading ? <p>Loading...</p> : null}
          {error ? <InlineError message={error} /> : null}

          {!isPast && detail.availability ? (
            <AvailabilityControl
              status={myAvailability}
              saving={savingAvailability}
              onSet={setAvailability}
            />
          ) : null}

          {!isPast && detail.availability ? (
            <div className="detail-stats">
              <StatCard label="Available" value={available.length} />
              <StatCard label="Out" value={unavailable.length} />
              <StatCard label="Waiting" value={waiting.length} />
            </div>
          ) : null}

          {detail.assignments && detail.assignments.length > 0 ? (
            <div className="draft-teams">
              <strong>{isPast ? 'Teams' : 'Draft teams'}</strong>
              <div className="team-columns">
                <TeamList title="Team A" color={room.teamAColor ?? '#28d17c'} players={teamAPlayers} />
                <TeamList title="Team B" color={room.teamBColor ?? '#f5c84b'} players={teamBPlayers} />
              </div>
            </div>
          ) : (
            detail.availability ? <p className="muted-note">{isPast ? 'Teams were not recorded for this fixture.' : 'Draft teams will update as availability changes.'}</p> : null
          )}

          {gameResult ? (
            <MatchAwards
              playerOfTheMatch={fixture.playerOfTheMatch ?? []}
              votingCloseTime={fixture.votingCloseTime ?? null}
            />
          ) : null}

          {canVote ? (
            <VotePanel
              players={[...teamAPlayers, ...teamBPlayers].filter((player) => player.id !== room.playerId)}
              onVote={castVote}
            />
          ) : null}

          {gameResult && detail.hasVoted?.hasVoted ? (
            <p className="muted-note">Your player-of-the-match vote has been recorded.</p>
          ) : null}

          {!isPast && room.isAdmin && detail.availability ? (
            <AdminAvailabilityPanel
              availability={detail.availability}
              saving={savingAvailability}
              onSet={setAvailability}
            />
          ) : null}

          {room.isAdmin ? (
            <div className="admin-panel">
              <div className="admin-actions">
                <button
                  type="button"
                  className={`admin-action-btn${adminAction === 'manual' ? ' active' : ''}`}
                  onClick={() => toggleAdmin('manual')}
                >
                  <Settings size={14} /> Manual teams
                </button>
                <button
                  type="button"
                  className={`admin-action-btn${adminAction === 'result' ? ' active' : ''}`}
                  onClick={() => toggleAdmin('result')}
                >
                  <Pencil size={14} /> {gameResult ? 'Edit result' : 'Record result'}
                </button>
                <button
                  type="button"
                  className="admin-action-btn danger"
                  onClick={() => toggleAdmin('delete')}
                >
                  <Trash2 size={14} /> Delete
                </button>
              </div>

              {adminAction === 'manual' && detail.availability ? (
                <ManualAssignmentPanel
                  availability={detail.availability}
                  assignments={detail.assignments ?? []}
                  onAssign={assignPlayer}
                />
              ) : null}

              {adminAction === 'result' ? (
                <ResultForm
                  fixture={{ ...fixture, gameResult }}
                  onSaved={(savedResult) => {
                    setGameResult(savedResult)
                    setDetailKey((key) => key + 1)
                    setAdminAction(null)
                  }}
                />
              ) : null}

              {adminAction === 'delete' ? (
                <div className="delete-confirm">
                  <p>Delete this fixture permanently?</p>
                  <div className="form-row">
                    <button className="danger-button" type="button" onClick={deleteFixture} disabled={deleting}>
                      Yes, delete
                    </button>
                    <button className="secondary-action" type="button" onClick={() => setAdminAction(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
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

function MatchAwards({
  playerOfTheMatch,
  votingCloseTime,
}: {
  playerOfTheMatch: Array<{ id: number; name: string; votes: number }>
  votingCloseTime: string | null
}) {
  const votingClosed = votingCloseTime ? Date.now() > new Date(votingCloseTime).getTime() : true

  return (
    <div className="awards-panel">
      <div>
        <Trophy size={17} />
        <strong>Player of the match</strong>
      </div>
      {playerOfTheMatch.length > 0 ? (
        <p>{playerOfTheMatch.map((player) => `${player.name} (${player.votes})`).join(', ')}</p>
      ) : (
        <p>No votes yet.</p>
      )}
      {votingCloseTime ? (
        <span>{votingClosed ? 'Voting closed' : `Voting closes ${new Date(votingCloseTime).toLocaleString()}`}</span>
      ) : null}
    </div>
  )
}

function VotePanel({ players, onVote }: { players: Player[]; onVote: (playerId: number) => void }) {
  const [selectedPlayerId, setSelectedPlayerId] = useState<number | ''>('')

  return (
    <div className="vote-panel">
      <strong>Vote for player of the match</strong>
      {players.length > 0 ? (
        <div>
          <select value={selectedPlayerId} onChange={(event) => setSelectedPlayerId(Number(event.target.value))}>
            <option value="">Choose a player</option>
            {players
              .slice()
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((player) => (
                <option key={player.id} value={player.id}>{player.name}</option>
              ))}
          </select>
          <button type="button" disabled={!selectedPlayerId} onClick={() => selectedPlayerId && onVote(Number(selectedPlayerId))}>
            Vote
          </button>
        </div>
      ) : (
        <p className="muted-note">No eligible players available.</p>
      )}
    </div>
  )
}

function AvailabilityControl({
  status,
  saving,
  onSet,
}: {
  status: boolean | null
  saving: boolean
  onSet: (status: boolean) => void
}) {
  return (
    <div className="availability-control">
      <strong>Your availability</strong>
      <div>
        <button
          type="button"
          className={status === true ? 'active available' : ''}
          disabled={saving}
          onClick={() => onSet(true)}
        >
          Available
        </button>
        <button
          type="button"
          className={status === false ? 'active unavailable' : ''}
          disabled={saving}
          onClick={() => onSet(false)}
        >
          Out
        </button>
      </div>
      {status === null ? <span>Not set yet</span> : null}
    </div>
  )
}

function AdminAvailabilityPanel({
  availability,
  saving,
  onSet,
}: {
  availability: Array<{ playerId: number; status: boolean | null; Player: Player }>
  saving: boolean
  onSet: (status: boolean, playerId?: number) => void
}) {
  const [search, setSearch] = useState('')
  const visibleRows = availability.filter((row) =>
    row.Player.name.toLowerCase().includes(search.trim().toLowerCase()),
  )

  return (
    <div className="admin-availability-panel">
      <strong>Set player availability</strong>
      <input
        className="availability-search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search players"
      />
      {visibleRows.map((row) => (
        <div className="availability-row" key={row.playerId}>
          <span>{row.Player.name}</span>
          <div>
            <button
              type="button"
              className={row.status === true ? 'active available' : ''}
              disabled={saving}
              onClick={() => onSet(true, row.playerId)}
            >
              In
            </button>
            <button
              type="button"
              className={row.status === false ? 'active unavailable' : ''}
              disabled={saving}
              onClick={() => onSet(false, row.playerId)}
            >
              Out
            </button>
          </div>
        </div>
      ))}
      {visibleRows.length === 0 ? <p className="muted-note">No players match that search.</p> : null}
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
  onRoomChanged,
  onLogout,
}: {
  room: Room
  memberships: Room[]
  onRoomChanged: () => void
  onLogout: () => void
}) {
  const { getAccessTokenSilently, user } = useAuth0()
  const { data: sports } = useApi<Sport[]>('/api/sports', getAccessTokenSilently, false)
  const { data: currentPlayer } = useApi<Player>('/api/current-player', getAccessTokenSilently)
  const [roomName, setRoomName] = useState(room.name)
  const [sportId, setSportId] = useState<number | ''>(room.sportId ?? '')
  const [teamAColor, setTeamAColor] = useState(room.teamAColor ?? '#28d17c')
  const [teamBColor, setTeamBColor] = useState(room.teamBColor ?? '#f5c84b')
  const [saveState, setSaveState] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [showRoomEdit, setShowRoomEdit] = useState(false)

  useEffect(() => {
    setRoomName(room.name)
    setSportId(room.sportId ?? '')
    setTeamAColor(room.teamAColor ?? '#28d17c')
    setTeamBColor(room.teamBColor ?? '#f5c84b')
  }, [room])

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
      setSaveState('Room updated.')
      onRoomChanged()
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
      </div>

      <RoomAccessPanel
        room={room}
        memberships={memberships}
        onRoomChanged={onRoomChanged}
      />

      {currentPlayer && sports ? (
        <FavoritePositionsPanel
          positions={sports.find((sport) => sport.id === room.sportId)?.positions ?? []}
          currentPositions={currentPlayer.favoritePositions ?? []}
        />
      ) : null}

      {room.isAdmin ? (
        <div className="collapsible-panel">
          <button className="advanced-toggle" type="button" onClick={() => setShowRoomEdit((value) => !value)}>
            <span>Room management</span>
            <ChevronDown className={showRoomEdit ? 'open' : ''} size={17} />
          </button>
          {showRoomEdit ? (
            <div className="form-panel wide embedded">
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
          {showRoomEdit ? <RoomMembersPanel room={room} onRoomChanged={onRoomChanged} /> : null}
        </div>
      ) : null}

      <AdvancedAccountActions
        room={room}
        onRoomChanged={onRoomChanged}
        onLogout={onLogout}
      />

      <button className="logout-button" type="button" onClick={onLogout}>
        <LogOut size={18} />
        Sign out
      </button>
    </section>
  )
}

function FavoritePositionsPanel({
  positions,
  currentPositions,
}: {
  positions: string[]
  currentPositions: string[]
}) {
  const { getAccessTokenSilently } = useAuth0()
  const [selected, setSelected] = useState<string[]>(currentPositions)
  const [message, setMessage] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setSelected(currentPositions)
  }, [currentPositions])

  function togglePosition(position: string) {
    setMessage(null)
    setSelected((current) => {
      if (current.includes(position)) return current.filter((item) => item !== position)
      return current.length >= 3 ? current : [...current, position]
    })
  }

  async function save() {
    setSaving(true)
    setMessage(null)
    try {
      await apiRequest('/api/favorite-positions', getAccessTokenSilently, {
        method: 'PUT',
        body: { favoritePositions: selected },
      })
      setMessage('Favorite positions saved.')
    } catch (caughtError) {
      setMessage(caughtError instanceof Error ? caughtError.message : 'Could not save positions')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="form-panel wide embedded positions-panel">
      <h2>Favorite positions</h2>
      {message ? <p className="muted-note">{message}</p> : null}
      {positions.length > 0 ? (
        <div className="position-grid">
          {positions.map((position) => (
            <button
              key={position}
              type="button"
              className={selected.includes(position) ? 'active' : ''}
              onClick={() => togglePosition(position)}
            >
              {position}
            </button>
          ))}
        </div>
      ) : (
        <p className="muted-note">This sport has no configured positions.</p>
      )}
      <button className="primary-action compact" type="button" onClick={save} disabled={saving}>
        Save positions
      </button>
    </div>
  )
}

function RoomMembersPanel({ room, onRoomChanged }: { room: Room; onRoomChanged: () => void }) {
  const { getAccessTokenSilently } = useAuth0()
  const [reloadKey, setReloadKey] = useState(0)
  const { data, error } = useApi<{ members: RoomMember[] }>(`/api/rooms/${room.roomId}/members?refresh=${reloadKey}`, getAccessTokenSilently)
  const [busyPlayerId, setBusyPlayerId] = useState<number | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  async function promote(playerId: number) {
    setBusyPlayerId(playerId)
    setMessage(null)
    try {
      await apiSend(`/api/rooms/${room.roomId}/members/${playerId}/admin`, getAccessTokenSilently, {})
      setMessage('Member promoted to admin.')
      setReloadKey((key) => key + 1)
      onRoomChanged()
    } catch (caughtError) {
      setMessage(caughtError instanceof Error ? caughtError.message : 'Could not promote member')
    } finally {
      setBusyPlayerId(null)
    }
  }

  return (
    <div className="form-panel wide embedded members-panel">
      <h2>Members</h2>
      {error ? <InlineError message={error} /> : null}
      {message ? <p className="muted-note">{message}</p> : null}
      {data?.members.map((member) => (
        <div className="member-row" key={member.playerId}>
          <div>
            <strong>{member.name}</strong>
            <span>
              {member.isAdmin ? 'Admin' : 'Player'} {member.isLinked ? ' - linked' : ' - unlinked'}
              {member.favoritePositions?.length ? ` - ${member.favoritePositions.join(', ')}` : ''}
            </span>
          </div>
          {!member.isAdmin ? (
            <button type="button" onClick={() => promote(member.playerId)} disabled={busyPlayerId === member.playerId}>
              Make admin
            </button>
          ) : null}
        </div>
      ))}
      {!data && !error ? <SkeletonList /> : null}
    </div>
  )
}

function RoomAccessPanel({
  room,
  memberships,
  onRoomChanged,
}: {
  room: Room
  memberships: Room[]
  onRoomChanged: () => void
}) {
  const { getAccessTokenSilently, user } = useAuth0()
  const [roomCode, setRoomCode] = useState('')
  const [playerName, setPlayerName] = useState(user?.name ?? '')
  const [skillLevel, setSkillLevel] = useState('average')
  const [joinResult, setJoinResult] = useState<JoinRoomResponse | null>(null)
  const { data: sports } = useApi<Sport[]>('/api/sports', getAccessTokenSilently, false)
  const [roomMode, setRoomMode] = useState<'join' | 'create'>('join')
  const [newRoomName, setNewRoomName] = useState('')
  const [newSportId, setNewSportId] = useState<number | ''>('')
  const [newTeamAColor, setNewTeamAColor] = useState('#28d17c')
  const [newTeamBColor, setNewTeamBColor] = useState('#f5c84b')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function activateRoom(roomId: number) {
    setBusy(true)
    setError(null)
    try {
      await apiSend('/api/set-active-room', getAccessTokenSilently, { roomId })
      onRoomChanged()
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Could not switch room')
    } finally {
      setBusy(false)
    }
  }

  async function joinRoom() {
    setBusy(true)
    setError(null)
    setJoinResult(null)
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
        name: newRoomName,
        playerName,
        sportId: Number(newSportId),
        teamAColor: newTeamAColor,
        teamBColor: newTeamBColor,
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
    <div className="form-panel wide room-access-panel">
      <h2>Rooms</h2>
      {error ? <InlineError message={error} /> : null}
      <div className="room-list compact">
        {memberships.map((membership) => (
          <div className="room-card" key={membership.roomId}>
            <div>
              <strong>{membership.name}</strong>
              <span>{membership.code}{membership.roomId === room.roomId ? ' - active' : ''}</span>
            </div>
            <button
              type="button"
              disabled={busy || membership.roomId === room.roomId}
              onClick={() => activateRoom(membership.roomId)}
            >
              Switch
            </button>
          </div>
        ))}
      </div>

      <div className="mode-tabs compact-tabs">
        <button className={roomMode === 'join' ? 'active' : ''} type="button" onClick={() => setRoomMode('join')}>Join</button>
        <button className={roomMode === 'create' ? 'active' : ''} type="button" onClick={() => setRoomMode('create')}>Create</button>
      </div>

      {roomMode === 'join' ? (
        <>
          <label>
            Join another room
            <input value={roomCode} onChange={(event) => setRoomCode(event.target.value.trim())} placeholder="Room code" />
          </label>
          <button className="primary-action compact" type="button" disabled={busy || !roomCode} onClick={joinRoom}>
            Find room
          </button>
          {joinResult?.room ? (
            <div className="join-result">
              <strong>{joinResult.room.name}</strong>
              <span>{joinResult.room.sportName ?? 'Team sport'} - {joinResult.room.code}</span>
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
                {joinResult.unlinkedPlayers && joinResult.unlinkedPlayers.length > 0 ? 'Your name' : 'Create your player profile'}
                <input value={playerName} onChange={(event) => setPlayerName(event.target.value)} placeholder="Your name" />
              </label>
              <SkillLevelField value={skillLevel} onChange={setSkillLevel} />
              <button className="primary-action compact" type="button" onClick={() => finalizeJoin()} disabled={busy || !playerName}>
                Join as new player
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <div className="create-room-panel">
          <label>
            Room name
            <input value={newRoomName} onChange={(event) => setNewRoomName(event.target.value)} placeholder="Sunday 7-a-side" />
          </label>
          <label>
            Your player name
            <input value={playerName} onChange={(event) => setPlayerName(event.target.value)} placeholder="Your name" />
          </label>
          <label>
            Sport
            <select value={newSportId} onChange={(event) => setNewSportId(Number(event.target.value))}>
              <option value="">Choose sport</option>
              {sports?.map((sport) => (
                <option key={sport.id} value={sport.id}>{sport.name}</option>
              ))}
            </select>
          </label>
          <SkillLevelField value={skillLevel} onChange={setSkillLevel} />
          <div className="color-grid">
            <label>
              Team A
              <input type="color" value={newTeamAColor} onChange={(event) => setNewTeamAColor(event.target.value)} />
            </label>
            <label>
              Team B
              <input type="color" value={newTeamBColor} onChange={(event) => setNewTeamBColor(event.target.value)} />
            </label>
          </div>
          <button
            className="primary-action compact"
            type="button"
            disabled={busy || !newRoomName || !playerName || !newSportId}
            onClick={createRoom}
          >
            Create room
          </button>
        </div>
      )}
    </div>
  )
}

function AdvancedAccountActions({
  room,
  onRoomChanged,
  onLogout,
}: {
  room: Room
  onRoomChanged: () => void
  onLogout: () => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <div className="advanced-panel">
      <button className="advanced-toggle" type="button" onClick={() => setOpen((value) => !value)}>
        <span>Advanced</span>
        <ChevronDown className={open ? 'open' : ''} size={17} />
      </button>
      {open ? (
        <DangerZone
          room={room}
          onRoomChanged={onRoomChanged}
          onLogout={onLogout}
        />
      ) : null}
    </div>
  )
}

function DangerZone({
  room,
  onRoomChanged,
  onLogout,
}: {
  room: Room
  onRoomChanged: () => void
  onLogout: () => void
}) {
  const { getAccessTokenSilently } = useAuth0()
  const [mode, setMode] = useState<'leave' | 'disconnect' | null>(null)
  const [confirmText, setConfirmText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function leaveRoom() {
    setBusy(true)
    setError(null)
    try {
      await apiSend('/api/unlink-player', getAccessTokenSilently, {})
      setMode(null)
      setConfirmText('')
      onRoomChanged()
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Could not leave room')
    } finally {
      setBusy(false)
    }
  }

  async function disconnectAccount() {
    setBusy(true)
    setError(null)
    try {
      await apiRequest('/api/account-link', getAccessTokenSilently, {
        method: 'DELETE',
        body: { confirm: confirmText },
      })
      onLogout()
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Could not disconnect account')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="danger-zone">
      <h2>Account actions</h2>
      {error ? <InlineError message={error} /> : null}
      <button className="secondary-action" type="button" onClick={() => setMode(mode === 'leave' ? null : 'leave')}>
        Leave active room
      </button>
      {mode === 'leave' ? (
        <div className="danger-confirm">
          <strong>Leave {room.name}?</strong>
          <p>This unlinks your login from your player profile in this room. The player, fixtures, results, and stats stay in the room.</p>
          <button className="danger-button" type="button" onClick={leaveRoom} disabled={busy}>
            Yes, leave this room
          </button>
        </div>
      ) : null}

      <button className="secondary-action" type="button" onClick={() => setMode(mode === 'disconnect' ? null : 'disconnect')}>
        Disconnect account from all rooms
      </button>
      {mode === 'disconnect' ? (
        <div className="danger-confirm">
          <strong>Disconnect this login?</strong>
          <p>This unlinks your Auth0 login from every Teamix player profile. It does not delete room history, players, fixtures, or your Auth0 user.</p>
          <label>
            Type DELETE to confirm
            <input value={confirmText} onChange={(event) => setConfirmText(event.target.value)} />
          </label>
          <button className="danger-button" type="button" onClick={disconnectAccount} disabled={busy || confirmText !== 'DELETE'}>
            Disconnect all rooms
          </button>
        </div>
      ) : null}
    </div>
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

function PlayerRow({
  player,
  rank,
  room,
  onEdit,
  onDelete,
}: {
  player: Player
  rank: number
  room: Room
  onEdit?: () => void
  onDelete?: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const wins = player.wins ?? 0
  const draws = player.draws ?? 0
  const losses = player.losses ?? 0
  const gf = player.goalsFor ?? 0
  const ga = player.goalsAgainst ?? 0
  const played = wins + draws + losses
  const form = player.recentForm ?? []

  return (
    <article className={`player-card${expanded ? ' expanded' : ''}`}>
      <div className="player-row">
        <button className="player-toggle" type="button" onClick={() => setExpanded((e) => !e)}>
          <div className="rank">{rank}</div>
          <div className="avatar" style={{ borderColor: rank % 2 ? room.teamAColor : room.teamBColor }}>
            {player.profilePicture ? <img src={player.profilePicture} alt="" /> : initials(player.name)}
          </div>
          <div className="player-main">
            <strong>{player.name}</strong>
            {played > 0 ? (
              <span className="form-bars" aria-hidden="true">
                {form.map((result, index) => (
                  <i
                    key={`${player.id}-${index}`}
                    className={result === 'W' ? 'wins' : result === 'D' ? 'draws' : 'losses'}
                  />
                ))}
              </span>
            ) : null}
            {played > 0
              ? <span>{wins}W · {draws}D · {losses}L</span>
              : <span>{player.isAdmin ? 'Room admin' : 'No games yet'}</span>}
          </div>
          {/* <div className="rating-pill">
            <Activity size={14} />
            {Math.round(Number(player.rating))}
          </div> */}
          <ChevronDown className="expand-icon" size={16} />
        </button>
        {(onEdit || onDelete) ? (
          <div className="player-actions">
            {onEdit ? <button type="button" className="icon-btn" onClick={onEdit}><Pencil size={14} /></button> : null}
            {onDelete ? <button type="button" className="icon-btn danger" onClick={onDelete}><Trash2 size={14} /></button> : null}
          </div>
        ) : null}
      </div>
      {expanded ? (
        <div className="player-detail">
          <div className="player-stat-grid">
            <div><span>Played</span><strong>{played}</strong></div>
            <div><span>Wins</span><strong>{wins}</strong></div>
            <div><span>Draws</span><strong>{draws}</strong></div>
            <div><span>Losses</span><strong>{losses}</strong></div>
            <div><span>Win %</span><strong>{played > 0 ? `${Math.round((wins / played) * 100)}%` : '—'}</strong></div>
            <div><span>Goals for</span><strong>{gf}</strong></div>
            <div><span>Goals against</span><strong>{ga}</strong></div>
            <div><span>Goal diff</span><strong style={{ color: gf - ga > 0 ? 'var(--grass)' : gf - ga < 0 ? 'var(--danger)' : undefined }}>{gf - ga > 0 ? `+${gf - ga}` : gf - ga}</strong></div>
            <div><span>Goals/game</span><strong>{played > 0 ? (gf / played).toFixed(1) : '—'}</strong></div>
            <div><span>Rating</span><strong>{Math.round(Number(player.rating))}</strong></div>
          </div>
          <PlayerRatingHistory playerId={player.id} />
        </div>
      ) : null}
    </article>
  )
}

function PlayerRatingHistory({ playerId }: { playerId: number }) {
  const { getAccessTokenSilently } = useAuth0()
  const { data, error } = useApi<RatingSummary[]>(`/api/ratings?playerId=${playerId}`, getAccessTokenSilently)
  const ratings = data?.[0]?.ratings?.slice(0, 5) ?? []

  return (
    <div className="rating-history">
      <strong>Rating history</strong>
      {error ? <InlineError message={error} /> : null}
      {ratings.length > 0 ? (
        <div className="rating-history-list">
          {ratings.map((rating) => (
            <span key={rating.id}>
              {new Date(rating.date).toLocaleDateString(undefined, { day: '2-digit', month: 'short' })}
              <strong>{Number(rating.rating).toFixed(1)}</strong>
            </span>
          ))}
        </div>
      ) : (
        <p className="muted-note">No rating records yet.</p>
      )}
    </div>
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
            return parseJsonResponse<T>(res, memoPath)
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

async function extractErrorMessage(response: Response): Promise<string> {
  const text = await response.text()
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const msg = parsed.message ?? parsed.error
    return typeof msg === 'string' ? msg : text
  } catch {
    return text
  }
}

async function parseJsonResponse<T>(response: Response, path: string): Promise<T> {
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    const text = await response.text()
    const looksLikeHtml = text.trimStart().startsWith('<!doctype') || text.trimStart().startsWith('<html')
    throw new Error(
      looksLikeHtml
        ? `API route ${path} returned the app HTML instead of JSON. Use npm run dev so Netlify Functions are available locally.`
        : `API route ${path} returned ${contentType || 'an unknown content type'} instead of JSON.`,
    )
  }

  return response.json() as Promise<T>
}

async function apiFetch<T>(path: string, getAccessTokenSilently: () => Promise<string>) {
  const token = await getAccessTokenSilently()
  const response = await fetch(path, {
    headers: {
      authorization: `Bearer ${token}`,
    },
  })

  if (!response.ok) {
    throw new Error(await extractErrorMessage(response))
  }

  return parseJsonResponse<T>(response, path)
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
    throw new Error(await extractErrorMessage(response))
  }

  if (response.status === 204) return undefined as T
  return parseJsonResponse<T>(response, path)
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

function getFixtureDateTime(fixture: Gameweek) {
  const datePart = fixture.date.slice(0, 10)
  return new Date(`${datePart}T${fixture.startTime ?? '23:59:59'}`)
}

function isFixturePast(fixture: Gameweek) {
  return getFixtureDateTime(fixture).getTime() < Date.now()
}

export default App
