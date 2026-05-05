import { Auth0Provider, useAuth0 } from '@auth0/auth0-react'
import {
  Activity,
  CalendarDays,
  ChevronRight,
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
  }, [getAccessTokenSilently])

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
    return <RoomGate memberships={apiState.memberships} />
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

function RoomGate({ memberships }: { memberships: Room[] }) {
  const { logout } = useAuth0()

  return (
    <main className="room-gate">
      <img src="/fp_logo.png" alt="" />
      <h1>Choose or join a squad</h1>
      <p>Your account is signed in, but there is no active room yet.</p>
      {memberships.length > 0 ? (
        <div className="room-list">
          {memberships.map((room) => (
            <div className="room-card" key={room.roomId}>
              <div>
                <strong>{room.name}</strong>
                <span>{room.code}</span>
              </div>
              <button type="button">Activate</button>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty-panel">
          <Shirt size={28} />
          <p>Create and join room flows are next in the Netlify API port.</p>
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
  const topPlayers = players?.slice(0, 5) ?? []
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
        {topPlayers.map((player, index) => (
          <PlayerRow key={player.id} player={player} rank={index + 1} room={room} />
        ))}
      </div>
    </section>
  )
}

function FixturesView({ room }: { room: Room }) {
  const { getAccessTokenSilently } = useAuth0()
  const { data: fixtures, error } = useApi<Gameweek[]>('/api/gameweeks', getAccessTokenSilently)
  const upcoming = fixtures?.filter((fixture) => new Date(fixture.date).getTime() >= Date.now()).slice(-3) ?? []
  const recent = fixtures?.slice(0, 6) ?? []

  return (
    <section className="screen">
      <ScreenHeader
        eyebrow="Fixtures"
        title="Match centre"
        actionLabel="New"
        icon={<Plus size={17} />}
      />

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
          <article className="fixture-row" key={fixture.id}>
            <div className="fixture-date">
              <strong>{new Date(fixture.date).toLocaleDateString(undefined, { day: '2-digit' })}</strong>
              <span>{new Date(fixture.date).toLocaleDateString(undefined, { month: 'short' })}</span>
            </div>
            <div>
              <h3>{fixture.location ?? 'Fixture'}</h3>
              <p>{fixture.startTime ?? 'Time TBC'} · max {fixture.maxPlayers ?? 'open'}</p>
            </div>
            <ResultBadge fixture={fixture} />
          </article>
        ))}
      </div>
    </section>
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
}: {
  eyebrow: string
  title: string
  actionLabel?: string
  icon?: React.ReactNode
}) {
  return (
    <div className="screen-header">
      <div>
        <span>{eyebrow}</span>
        <h1>{title}</h1>
      </div>
      {actionLabel ? (
        <button type="button">
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
