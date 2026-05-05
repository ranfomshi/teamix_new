import type { Handler, HandlerEvent } from '@netlify/functions'
import { getDatabase } from '@netlify/database'
import { createRemoteJWKSet, jwtVerify } from 'jose'

type JsonValue = Record<string, unknown> | unknown[]

type AuthContext = {
  sub: string
  roomId?: number
  playerId?: number
  isAdmin?: boolean
}

const db = getDatabase()
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

export const handler: Handler = async (event) => {
  try {
    const route = getRoute(event)
    const method = event.httpMethod.toUpperCase()

    if (method === 'OPTIONS') {
      return empty(204)
    }

    if (method === 'GET' && route === '/status') {
      const [status] = await db.sql<{ database: string; checked_at: string }>`
        SELECT current_database() AS database, NOW()::text AS checked_at
      `
      return json({ ok: true, database: status.database, checkedAt: status.checked_at })
    }

    if (method === 'GET' && route === '/sports') {
      const sports = await db.sql`
        SELECT id, name, positions
        FROM public."Sports"
        ORDER BY name
      `
      return json(sports)
    }

    const sportMatch = route.match(/^\/sports\/(\d+)$/)
    if (method === 'GET' && sportMatch) {
      const [sport] = await db.sql`
        SELECT id, name, positions
        FROM public."Sports"
        WHERE id = ${Number(sportMatch[1])}
      `
      return sport ? json(sport) : json({ error: 'Sport not found' }, 404)
    }

    const auth = await requireAuth(event)

    if (method === 'GET' && route === '/check-player-existence') {
      const memberships = await getMemberships(auth.sub)
      return json(memberships.length > 0 ? { exists: true, memberships } : { exists: false })
    }

    if (method === 'GET' && route === '/check-room-membership') {
      const memberships = await getMemberships(auth.sub)
      const activeRoom = memberships.find((membership) => membership.isActive) ?? null
      return json({ memberships, activeRoom })
    }

    if (method === 'POST' && route === '/set-active-room') {
      const body = parseBody<{ roomId?: number }>(event)
      if (!body.roomId) return json({ error: 'roomId is required' }, 400)

      await db.sql`
        UPDATE public."RoomMemberships"
        SET "isActive" = false, "updatedAt" = NOW()
        WHERE "auth0Id" = ${auth.sub}
      `
      const [membership] = await db.sql`
        UPDATE public."RoomMemberships"
        SET "isActive" = true, "updatedAt" = NOW()
        WHERE "auth0Id" = ${auth.sub}
          AND "roomId" = ${body.roomId}
          AND "isMember" = true
        RETURNING "roomId", "playerId", "isAdmin", "isActive"
      `

      return membership ? json({ success: true, membership }) : json({ error: 'Membership not found' }, 404)
    }

    const active = await getActiveMembership(auth.sub)
    if (!active) {
      return json({ error: 'No active room membership found' }, 403)
    }

    auth.roomId = active.roomId
    auth.playerId = active.playerId
    auth.isAdmin = active.isAdmin

    if (method === 'GET' && route === '/current-player') {
      const [player] = await db.sql`
        SELECT p.id, p.name, p.rating, p."profilePicture",
               ${active.isAdmin}::boolean AS "isAdmin",
               ${active.favoritePositions ?? []}::text[] AS "favoritePositions"
        FROM public."Players" p
        WHERE p.id = ${active.playerId}
      `
      return player ? json(player) : json({ error: 'Player not found' }, 404)
    }

    if (method === 'GET' && route === '/players') {
      const players = await db.sql`
        SELECT p.id, p.name, p.rating, p."auth0Id", p."profilePicture",
               rm."isAdmin", rm."favoritePositions", rm."isMember"
        FROM public."RoomMemberships" rm
        JOIN public."Players" p ON p.id = rm."playerId"
        WHERE rm."roomId" = ${active.roomId}
          AND rm."isMember" = true
        ORDER BY p.rating DESC NULLS LAST, p.name ASC
      `
      return json(players)
    }

    if (method === 'POST' && route === '/players') {
      const body = parseBody<{ name?: string; rating?: number }>(event)
      if (!body.name?.trim()) return json({ error: 'name is required' }, 400)

      const [player] = await db.sql`
        INSERT INTO public."Players" (name, rating, "createdAt", "updatedAt")
        VALUES (${body.name.trim()}, ${body.rating ?? 1000}, NOW(), NOW())
        RETURNING id, name, rating, "profilePicture"
      `

      await db.sql`
        INSERT INTO public."RoomMemberships" ("playerId", "roomId", "isActive", "isAdmin", "isMember", "createdAt", "updatedAt")
        VALUES (${player.id}, ${active.roomId}, false, false, true, NOW(), NOW())
      `

      return json(player, 201)
    }

    const playerMatch = route.match(/^\/players\/(\d+)$/)
    if (playerMatch && method === 'PUT') {
      const body = parseBody<{ name?: string; rating?: number; profilePicture?: string | null }>(event)
      const playerId = Number(playerMatch[1])
      const [player] = await db.sql`
        UPDATE public."Players"
        SET name = COALESCE(${body.name ?? null}, name),
            rating = COALESCE(${body.rating ?? null}, rating),
            "profilePicture" = COALESCE(${body.profilePicture ?? null}, "profilePicture"),
            "updatedAt" = NOW()
        WHERE id = ${playerId}
          AND EXISTS (
            SELECT 1 FROM public."RoomMemberships"
            WHERE "roomId" = ${active.roomId} AND "playerId" = ${playerId} AND "isMember" = true
          )
        RETURNING id, name, rating, "profilePicture"
      `
      return player ? json(player) : json({ error: 'Player not found' }, 404)
    }

    if (playerMatch && method === 'DELETE') {
      const playerId = Number(playerMatch[1])
      await db.sql`
        UPDATE public."RoomMemberships"
        SET "isMember" = false, "isActive" = false, "updatedAt" = NOW()
        WHERE "roomId" = ${active.roomId} AND "playerId" = ${playerId}
      `
      return empty(204)
    }

    if (method === 'GET' && route === '/gameweeks') {
      const gameweeks = await db.sql`
        SELECT gw.id, gw.date, gw.location, gw."startTime", gw."maxPlayers",
               gr."teamA_score", gr."teamB_score", gr."createdAt" AS "resultCreatedAt"
        FROM public."Gameweeks" gw
        LEFT JOIN public."GameResults" gr
          ON gr."gameweekId" = gw.id AND gr."roomId" = gw."roomId"
        WHERE gw."roomId" = ${active.roomId}
        ORDER BY gw.date DESC
      `
      return json(gameweeks.map(formatGameweek))
    }

    if (method === 'POST' && route === '/gameweeks') {
      const body = parseBody<{ date?: string; location?: string; startTime?: string; maxPlayers?: number }>(event)
      if (!body.date) return json({ error: 'date is required' }, 400)

      const [gameweek] = await db.sql`
        INSERT INTO public."Gameweeks" (date, location, "startTime", "maxPlayers", "roomId", "createdAt", "updatedAt")
        VALUES (${body.date}, ${body.location ?? null}, ${body.startTime ?? null}, ${body.maxPlayers ?? null}, ${active.roomId}, NOW(), NOW())
        RETURNING id, date, location, "startTime", "maxPlayers"
      `
      return json(gameweek, 201)
    }

    const gameweekMatch = route.match(/^\/gameweeks\/(\d+)$/)
    if (gameweekMatch && method === 'GET') {
      const [gameweek] = await db.sql`
        SELECT gw.id, gw.date, gw.location, gw."startTime", gw."maxPlayers",
               gr."teamA_score", gr."teamB_score", gr."createdAt" AS "resultCreatedAt"
        FROM public."Gameweeks" gw
        LEFT JOIN public."GameResults" gr
          ON gr."gameweekId" = gw.id AND gr."roomId" = gw."roomId"
        WHERE gw.id = ${Number(gameweekMatch[1])}
          AND gw."roomId" = ${active.roomId}
      `
      return gameweek ? json(formatGameweek(gameweek)) : json({ error: 'Gameweek not found' }, 404)
    }

    if (gameweekMatch && method === 'DELETE') {
      await db.sql`
        DELETE FROM public."Gameweeks"
        WHERE id = ${Number(gameweekMatch[1])}
          AND "roomId" = ${active.roomId}
      `
      return empty(204)
    }

    if (method === 'GET' && route === '/availability') {
      const gameweekId = Number(event.queryStringParameters?.gameweekId)
      if (!gameweekId) return json({ error: 'gameweekId is required' }, 400)

      const availability = await db.sql`
        SELECT rm."playerId", a.status, ${gameweekId}::int AS "gameweekId",
               json_build_object(
                 'id', p.id,
                 'name', p.name,
                 'rating', p.rating,
                 'profilePicture', p."profilePicture",
                 'auth0Id', rm."auth0Id"
               ) AS "Player"
        FROM public."RoomMemberships" rm
        JOIN public."Players" p ON p.id = rm."playerId"
        LEFT JOIN public."Availabilities" a
          ON a."playerId" = rm."playerId"
         AND a."gameweekId" = ${gameweekId}
         AND a."roomId" = rm."roomId"
        WHERE rm."roomId" = ${active.roomId}
          AND rm."isMember" = true
        ORDER BY p.rating DESC NULLS LAST, p.name ASC
      `
      return json(availability)
    }

    if (method === 'POST' && route === '/availability') {
      const body = parseBody<{ playerId?: number; gameweekId?: number; status?: boolean }>(event)
      if (!body.playerId || !body.gameweekId || typeof body.status !== 'boolean') {
        return json({ error: 'playerId, gameweekId and status are required' }, 400)
      }

      const [availability] = await db.sql`
        INSERT INTO public."Availabilities" (status, "playerId", "gameweekId", "roomId", "createdAt", "updatedAt")
        VALUES (${body.status}, ${body.playerId}, ${body.gameweekId}, ${active.roomId}, NOW(), NOW())
        ON CONFLICT ("playerId", "gameweekId", "roomId")
        DO UPDATE SET status = EXCLUDED.status, "updatedAt" = NOW()
        RETURNING status, "playerId", "gameweekId", "roomId"
      `
      return json(availability)
    }

    if (method === 'GET' && route === '/teamassignments') {
      const gameweekId = Number(event.queryStringParameters?.gameweekId)
      if (!gameweekId) return json({ error: 'gameweekId is required' }, 400)

      const assignments = await db.sql`
        SELECT ta.id, ta.team, ta."playerId", ta."gameweekId", ta."roomId",
               json_build_object(
                 'id', p.id,
                 'name', p.name,
                 'rating', p.rating,
                 'profilePicture', p."profilePicture",
                 'auth0Id', rm."auth0Id"
               ) AS "Player"
        FROM public."TeamAssignments" ta
        JOIN public."Players" p ON p.id = ta."playerId"
        LEFT JOIN public."RoomMemberships" rm
          ON rm."playerId" = p.id AND rm."roomId" = ta."roomId"
        WHERE ta."gameweekId" = ${gameweekId}
          AND ta."roomId" = ${active.roomId}
        ORDER BY ta.team ASC, p.rating DESC NULLS LAST
      `
      return json(assignments)
    }

    if (method === 'GET' && route === '/player-achievements') {
      const achievements = await db.sql`
        SELECT a.id, a.title, a.description,
               (pa."achievementId" IS NOT NULL) AS "isCompleted",
               pa."earnedAt"
        FROM public."Achievements" a
        LEFT JOIN public."PlayerAchievements" pa
          ON pa."achievementId" = a.id
         AND pa."playerId" = ${active.playerId}
         AND pa."roomId" = ${active.roomId}
        WHERE a."isActive" = true
        ORDER BY a.id
      `
      return json(achievements)
    }

    const legacyNotYetPorted = [
      '/create-room',
      '/join-room',
      '/finalize-join-room',
      '/unlink-player',
      '/pick-teams',
      '/gameresults',
      '/manual-teamassignment',
      '/teamassignments',
      '/ratings',
      '/votes',
      '/has-voted',
      '/fcm-token',
      '/favorite-positions',
    ]

    if (legacyNotYetPorted.includes(route)) {
      return json({ error: 'This legacy API route still needs to be ported to Netlify Functions.' }, 501)
    }

    return json({ error: 'Not found' }, 404)
  } catch (error) {
    console.error(error)
    return json(
      { error: error instanceof Error ? error.message : 'Internal Server Error' },
      error instanceof AuthError ? error.statusCode : 500,
    )
  }
}

async function requireAuth(event: HandlerEvent): Promise<AuthContext> {
  const devAuth0Id = event.headers['x-teamix-auth0-id']
  if (process.env.CONTEXT !== 'production' && devAuth0Id) {
    return { sub: devAuth0Id }
  }

  const header = event.headers.authorization ?? event.headers.Authorization
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null
  if (!token) throw new AuthError('No token provided', 401)

  const domain = process.env.AUTH0_DOMAIN
  const audience = process.env.AUTH0_AUDIENCE
  if (!domain || !audience) {
    throw new AuthError('Auth0 environment variables are not configured', 500)
  }

  let jwks = jwksCache.get(domain)
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://${domain}/.well-known/jwks.json`))
    jwksCache.set(domain, jwks)
  }

  const { payload } = await jwtVerify(token, jwks, {
    audience,
    issuer: `https://${domain}/`,
  })

  if (!payload.sub) throw new AuthError('Token is missing subject', 401)
  return { sub: payload.sub }
}

async function getMemberships(auth0Id: string) {
  return db.sql`
    SELECT rm."roomId", rm."playerId", rm."isActive", rm."isAdmin", rm."isMember",
           rm."favoritePositions",
           r.id, r.name, r.code, r."teamAColor", r."teamBColor", r."sportId",
           s.name AS "sportName"
    FROM public."RoomMemberships" rm
    JOIN public."Rooms" r ON r.id = rm."roomId"
    LEFT JOIN public."Sports" s ON s.id = r."sportId"
    WHERE rm."auth0Id" = ${auth0Id}
      AND rm."isMember" = true
    ORDER BY rm."isActive" DESC, r.name ASC
  `
}

async function getActiveMembership(auth0Id: string) {
  const [membership] = await db.sql<{
    roomId: number
    playerId: number
    isAdmin: boolean
    favoritePositions: string[] | null
  }>`
    SELECT "roomId", "playerId", "isAdmin", "favoritePositions"
    FROM public."RoomMemberships"
    WHERE "auth0Id" = ${auth0Id}
      AND "isActive" = true
      AND "isMember" = true
    LIMIT 1
  `
  return membership
}

function getRoute(event: HandlerEvent) {
  const rawPath = event.path
    .replace(/^\/\.netlify\/functions\/api/, '')
    .replace(/^\/api/, '')

  const route = rawPath || '/'
  return route.endsWith('/') && route.length > 1 ? route.slice(0, -1) : route
}

function parseBody<T>(event: HandlerEvent): T {
  if (!event.body) return {} as T
  const body = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body
  return JSON.parse(body) as T
}

function formatGameweek(gameweek: Record<string, unknown>) {
  const teamAScore = gameweek.teamA_score
  const teamBScore = gameweek.teamB_score
  const resultCreatedAt = gameweek.resultCreatedAt
  return {
    id: gameweek.id,
    date: gameweek.date,
    location: gameweek.location,
    startTime: gameweek.startTime,
    maxPlayers: gameweek.maxPlayers,
    gameResult:
      teamAScore === null || teamAScore === undefined
        ? null
        : {
            teamA_score: teamAScore,
            teamB_score: teamBScore,
            createdAt: resultCreatedAt,
          },
    votingCloseTime: resultCreatedAt
      ? new Date(new Date(String(resultCreatedAt)).getTime() + 48 * 60 * 60 * 1000).toISOString()
      : null,
  }
}

function json(body: JsonValue, statusCode = 200) {
  return {
    statusCode,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, authorization, x-teamix-auth0-id',
      'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  }
}

function empty(statusCode: number) {
  return {
    statusCode,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, authorization, x-teamix-auth0-id',
      'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    },
    body: '',
  }
}

class AuthError extends Error {
  statusCode: number

  constructor(message: string, statusCode: number) {
    super(message)
    this.statusCode = statusCode
  }
}
