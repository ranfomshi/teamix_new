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

type DraftPlayer = {
  id: number
  rating: number
  favoritePositions: string[]
}

type TeamPickOptions = {
  pairSynergyMap?: Record<string, number>
  pairSynergyWeight?: number
  ratingGapEpsilon?: number
}

const TEAM_PICKING_OPTIONS = {
  pairSynergyWeight: 0.75,
  ratingGapEpsilon: 0.015,
  synergyLookbackGames: 40,
}

const db = getDatabase({
  connectionString: process.env.TEAMIX_DATABASE_URL ?? process.env.NETLIFY_DB_URL,
})
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

    if (method === 'POST' && route === '/create-room') {
      const body = parseBody<{
        name?: string
        playerName?: string
        sportId?: number
        teamAColor?: string
        teamBColor?: string
        skillLevel?: string
        profilePicture?: string | null
      }>(event)

      if (!body.name?.trim()) return json({ error: 'Room name is required' }, 400)
      if (!body.playerName?.trim()) return json({ error: 'Player name is required' }, 400)
      if (!body.sportId) return json({ error: 'sportId is required' }, 400)

      const [sport] = await db.sql`
        SELECT id, name
        FROM public."Sports"
        WHERE id = ${body.sportId}
      `
      if (!sport) return json({ error: 'Invalid sport ID' }, 400)

      const code = await generateRoomCode()
      const rating = initialRating(body.skillLevel)

      await db.sql`
        UPDATE public."RoomMemberships"
        SET "isActive" = false, "updatedAt" = NOW()
        WHERE "auth0Id" = ${auth.sub}
      `

      const [room] = await db.sql`
        INSERT INTO public."Rooms" (name, code, "sportId", "teamAColor", "teamBColor", "createdAt", "updatedAt")
        VALUES (
          ${body.name.trim()},
          ${code},
          ${body.sportId},
          ${body.teamAColor ?? '#28d17c'},
          ${body.teamBColor ?? '#f5c84b'},
          NOW(),
          NOW()
        )
        RETURNING id, name, code, "teamAColor", "teamBColor", "sportId"
      `

      const [player] = await db.sql`
        INSERT INTO public."Players" (name, rating, "profilePicture", "createdAt", "updatedAt")
        VALUES (${body.playerName.trim()}, ${rating}, ${body.profilePicture ?? null}, NOW(), NOW())
        RETURNING id, name, rating, "profilePicture"
      `

      const [membership] = await db.sql`
        INSERT INTO public."RoomMemberships" ("playerId", "auth0Id", "roomId", "isActive", "isAdmin", "isMember", "createdAt", "updatedAt")
        VALUES (${player.id}, ${auth.sub}, ${room.id}, true, true, true, NOW(), NOW())
        RETURNING "roomId", "playerId", "isActive", "isAdmin", "isMember"
      `

      await db.sql`
        INSERT INTO public."Ratings" ("playerId", date, rating, "raterId", "roomId", "createdAt", "updatedAt")
        VALUES (${player.id}, CURRENT_DATE, ${rating}, NULL, ${room.id}, NOW(), NOW())
      `

      return json({
        room: {
          roomId: room.id,
          playerId: player.id,
          isActive: true,
          isAdmin: true,
          name: room.name,
          code: room.code,
          teamAColor: room.teamAColor,
          teamBColor: room.teamBColor,
          sportName: sport.name,
        },
        player,
        membership,
      }, 201)
    }

    if (method === 'POST' && route === '/join-room') {
      const body = parseBody<{ code?: string }>(event)
      const code = body.code?.trim()
      if (!code) return json({ error: 'Room code is required' }, 400)

      const [room] = await db.sql`
        SELECT r.id, r.name, r.code, r."teamAColor", r."teamBColor", s.name AS "sportName"
        FROM public."Rooms" r
        LEFT JOIN public."Sports" s ON s.id = r."sportId"
        WHERE LOWER(r.code) = LOWER(${code})
      `
      if (!room) return json({ status: 'error', message: 'Room not found' }, 404)

      const [existing] = await db.sql`
        SELECT "roomId", "playerId", "isActive", "isAdmin", "isMember"
        FROM public."RoomMemberships"
        WHERE "auth0Id" = ${auth.sub}
          AND "roomId" = ${room.id}
          AND "isMember" = true
      `

      if (existing) {
        return json({
          status: 'already-member',
          room,
          membership: existing,
        })
      }

      const unlinkedPlayers = await db.sql`
        SELECT p.id, p.name, p.rating, p."profilePicture"
        FROM public."RoomMemberships" rm
        JOIN public."Players" p ON p.id = rm."playerId"
        WHERE rm."roomId" = ${room.id}
          AND rm."auth0Id" IS NULL
          AND rm."isMember" = true
        ORDER BY p.name
      `

      return json({ status: 'unlinked', room, unlinkedPlayers })
    }

    if (method === 'POST' && route === '/finalize-join-room') {
      const body = parseBody<{
        roomCode?: string
        playerId?: number
        newPlayerName?: string
        skillLevel?: string
        profilePicture?: string | null
      }>(event)
      if (!body.roomCode?.trim()) return json({ error: 'roomCode is required' }, 400)

      const [room] = await db.sql`
        SELECT r.id, r.name, r.code, r."teamAColor", r."teamBColor", s.name AS "sportName"
        FROM public."Rooms" r
        LEFT JOIN public."Sports" s ON s.id = r."sportId"
        WHERE LOWER(r.code) = LOWER(${body.roomCode.trim()})
      `
      if (!room) return json({ status: 'error', message: 'Room not found' }, 404)

      await db.sql`
        UPDATE public."RoomMemberships"
        SET "isActive" = false, "updatedAt" = NOW()
        WHERE "auth0Id" = ${auth.sub}
      `

      let playerId = body.playerId
      if (playerId) {
        const [linked] = await db.sql`
          UPDATE public."RoomMemberships"
          SET "auth0Id" = ${auth.sub}, "isActive" = true, "updatedAt" = NOW()
          WHERE "roomId" = ${room.id}
            AND "playerId" = ${playerId}
            AND "auth0Id" IS NULL
            AND "isMember" = true
          RETURNING "roomId", "playerId", "isActive", "isAdmin", "isMember"
        `
        if (!linked) return json({ error: 'That player profile is no longer available to link' }, 409)
      } else {
        if (!body.newPlayerName?.trim()) {
          return json({ error: 'Choose an existing player or enter a player name' }, 400)
        }

        const rating = initialRating(body.skillLevel)
        const [player] = await db.sql`
          INSERT INTO public."Players" (name, rating, "profilePicture", "createdAt", "updatedAt")
          VALUES (${body.newPlayerName.trim()}, ${rating}, ${body.profilePicture ?? null}, NOW(), NOW())
          RETURNING id
        `
        playerId = player.id

        await db.sql`
          INSERT INTO public."RoomMemberships" ("playerId", "auth0Id", "roomId", "isActive", "isAdmin", "isMember", "createdAt", "updatedAt")
          VALUES (${playerId}, ${auth.sub}, ${room.id}, true, false, true, NOW(), NOW())
        `
        await db.sql`
          INSERT INTO public."Ratings" ("playerId", date, rating, "raterId", "roomId", "createdAt", "updatedAt")
          VALUES (${playerId}, CURRENT_DATE, ${rating}, NULL, ${room.id}, NOW(), NOW())
        `
      }

      return json({
        success: true,
        room: {
          roomId: room.id,
          playerId,
          isActive: true,
          isAdmin: false,
          name: room.name,
          code: room.code,
          teamAColor: room.teamAColor,
          teamBColor: room.teamBColor,
          sportName: room.sportName,
        },
      })
    }

    if (method === 'POST' && route === '/unlink-player') {
      const active = await getActiveMembership(auth.sub)
      if (!active) return json({ error: 'No active room membership found' }, 404)

      await db.sql`
        UPDATE public."RoomMemberships"
        SET "auth0Id" = NULL, "isActive" = false, "updatedAt" = NOW()
        WHERE "auth0Id" = ${auth.sub}
          AND "roomId" = ${active.roomId}
          AND "isMember" = true
      `
      return json({ success: true, message: 'Player unlinked successfully' })
    }

    if (method === 'DELETE' && route === '/account-link') {
      const body = parseBody<{ confirm?: string }>(event)
      if (body.confirm !== 'DELETE') return json({ error: 'Type DELETE to confirm account unlink.' }, 400)

      await db.sql`
        UPDATE public."RoomMemberships"
        SET "auth0Id" = NULL, "isActive" = false, "updatedAt" = NOW()
        WHERE "auth0Id" = ${auth.sub}
          AND "isMember" = true
      `
      return json({ success: true, message: 'Account disconnected from all rooms' })
    }

    const active = await getActiveMembership(auth.sub)
    if (!active) {
      return json({ error: 'No active room membership found' }, 403)
    }

    auth.roomId = active.roomId
    auth.playerId = active.playerId
    auth.isAdmin = active.isAdmin

    const roomMatch = route.match(/^\/rooms\/(\d+)$/)
    if (roomMatch && method === 'PUT') {
      const roomId = Number(roomMatch[1])
      if (!isActiveRoom(auth, roomId)) return json({ error: 'Switch to this room before managing it.' }, 403)
      if (!auth.isAdmin) return json({ error: 'Admin privileges required.' }, 403)

      const body = parseBody<{ name?: string; sportId?: number; teamAColor?: string; teamBColor?: string }>(event)
      const [room] = await db.sql`
        UPDATE public."Rooms"
        SET name = COALESCE(${body.name?.trim() || null}, name),
            "sportId" = COALESCE(${body.sportId ?? null}, "sportId"),
            "teamAColor" = COALESCE(${body.teamAColor ?? null}, "teamAColor"),
            "teamBColor" = COALESCE(${body.teamBColor ?? null}, "teamBColor"),
            "updatedAt" = NOW()
        WHERE id = ${roomId}
        RETURNING id AS "roomId", name, code, "teamAColor", "teamBColor", "sportId"
      `
      return room ? json({ room }) : json({ error: 'Room not found' }, 404)
    }

    const roomMembersMatch = route.match(/^\/rooms\/(\d+)\/members$/)
    if (roomMembersMatch && method === 'GET') {
      const roomId = Number(roomMembersMatch[1])
      if (!isActiveRoom(auth, roomId)) return json({ error: 'Switch to this room before managing members.' }, 403)

      const members = await db.sql`
        SELECT p.id AS "playerId", p.name, p."profilePicture",
               rm."isAdmin", (rm."auth0Id" IS NOT NULL) AS "isLinked",
               rm."favoritePositions"
        FROM public."RoomMemberships" rm
        JOIN public."Players" p ON p.id = rm."playerId"
        WHERE rm."roomId" = ${roomId}
          AND rm."isMember" = true
        ORDER BY p.name ASC
      `
      return json({ members })
    }

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
        SELECT
          p.id, p.name, p.rating, p."profilePicture", rm."isAdmin",
          COALESCE(s.wins, 0)::int   AS wins,
          COALESCE(s.draws, 0)::int  AS draws,
          COALESCE(s.losses, 0)::int AS losses,
          COALESCE(s."goalsFor", 0)::int     AS "goalsFor",
          COALESCE(s."goalsAgainst", 0)::int AS "goalsAgainst",
          COALESCE(f."recentForm", '[]'::json) AS "recentForm"
        FROM public."RoomMemberships" rm
        JOIN public."Players" p ON p.id = rm."playerId"
        LEFT JOIN (
          SELECT
            ta."playerId",
            COUNT(*) FILTER (
              WHERE (ta.team = 'A' AND gr."teamA_score" > gr."teamB_score")
                 OR (ta.team = 'B' AND gr."teamB_score" > gr."teamA_score")
            ) AS wins,
            COUNT(*) FILTER (
              WHERE gr."teamA_score" = gr."teamB_score"
            ) AS draws,
            COUNT(*) FILTER (
              WHERE (ta.team = 'A' AND gr."teamA_score" < gr."teamB_score")
                 OR (ta.team = 'B' AND gr."teamB_score" < gr."teamA_score")
            ) AS losses,
            SUM(CASE WHEN ta.team = 'A' THEN gr."teamA_score"
                     WHEN ta.team = 'B' THEN gr."teamB_score" ELSE 0 END) AS "goalsFor",
            SUM(CASE WHEN ta.team = 'A' THEN gr."teamB_score"
                     WHEN ta.team = 'B' THEN gr."teamA_score" ELSE 0 END) AS "goalsAgainst"
          FROM public."TeamAssignments" ta
          JOIN public."GameResults" gr
            ON gr."gameweekId" = ta."gameweekId" AND gr."roomId" = ta."roomId"
          WHERE ta."roomId" = ${active.roomId}
            AND ta.team IN ('A', 'B')
          GROUP BY ta."playerId"
        ) s ON s."playerId" = p.id
        LEFT JOIN LATERAL (
          SELECT json_agg(form_row.result ORDER BY form_row.date ASC, form_row.id ASC) AS "recentForm"
          FROM (
            SELECT recent.id, recent.date, recent.result
            FROM (
              SELECT
                gw.id,
                gw.date,
                CASE
                  WHEN gr."teamA_score" = gr."teamB_score" THEN 'D'
                  WHEN (ta.team = 'A' AND gr."teamA_score" > gr."teamB_score")
                    OR (ta.team = 'B' AND gr."teamB_score" > gr."teamA_score") THEN 'W'
                  ELSE 'L'
                END AS result
              FROM public."TeamAssignments" ta
              JOIN public."GameResults" gr
                ON gr."gameweekId" = ta."gameweekId" AND gr."roomId" = ta."roomId"
              JOIN public."Gameweeks" gw
                ON gw.id = ta."gameweekId" AND gw."roomId" = ta."roomId"
              WHERE ta."roomId" = ${active.roomId}
                AND ta."playerId" = p.id
                AND ta.team IN ('A', 'B')
              ORDER BY gw.date DESC, gw.id DESC
              LIMIT 5
            ) recent
          ) form_row
        ) f ON true
        WHERE rm."roomId" = ${active.roomId}
          AND rm."isMember" = true
        ORDER BY COALESCE(s.wins, 0) DESC, p.rating DESC NULLS LAST, p.name ASC
      `
      return json(players)
    }

    if (method === 'POST' && route === '/players') {
      const body = parseBody<{ name?: string; skillLevel?: string }>(event)
      if (!body.name?.trim()) return json({ error: 'name is required' }, 400)

      const rating = initialRating(body.skillLevel)
      const [player] = await db.sql`
        INSERT INTO public."Players" (name, rating, "createdAt", "updatedAt")
        VALUES (${body.name.trim()}, ${rating}, NOW(), NOW())
        RETURNING id, name, rating, "profilePicture"
      `

      await db.sql`
        INSERT INTO public."RoomMemberships" ("playerId", "roomId", "isActive", "isAdmin", "isMember", "createdAt", "updatedAt")
        VALUES (${player.id}, ${active.roomId}, false, false, true, NOW(), NOW())
      `
      await db.sql`
        INSERT INTO public."Ratings" ("playerId", date, rating, "raterId", "roomId", "createdAt", "updatedAt")
        VALUES (${player.id}, CURRENT_DATE, ${rating}, NULL, ${active.roomId}, NOW(), NOW())
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
      if (body.playerId !== active.playerId && !auth.isAdmin) {
        return json({ error: 'Admin privileges required to update another player.' }, 403)
      }

      const [target] = await db.sql<{ gameweekId: number; maxPlayers: number | null; playerId: number; currentStatus: boolean | null }>`
        SELECT gw.id AS "gameweekId", gw."maxPlayers", rm."playerId", a.status AS "currentStatus"
        FROM public."Gameweeks" gw
        JOIN public."RoomMemberships" rm
          ON rm."roomId" = gw."roomId"
         AND rm."playerId" = ${body.playerId}
         AND rm."isMember" = true
        LEFT JOIN public."Availabilities" a
          ON a."roomId" = gw."roomId"
         AND a."gameweekId" = gw.id
         AND a."playerId" = rm."playerId"
        WHERE gw.id = ${body.gameweekId}
          AND gw."roomId" = ${active.roomId}
      `
      if (!target) return json({ error: 'Gameweek or player not found in this room' }, 404)
      if (body.status && target.maxPlayers && target.currentStatus !== true) {
        const [countRow] = await db.sql<{ count: string }>`
          SELECT COUNT(*)::text AS count
          FROM public."Availabilities"
          WHERE "gameweekId" = ${body.gameweekId}
            AND "roomId" = ${active.roomId}
            AND status = true
        `
        if (Number(countRow.count) >= target.maxPlayers) {
          return json({ error: `Max players (${target.maxPlayers}) exceeded.` }, 400)
        }
      }

      const [availability] = await db.sql`
        INSERT INTO public."Availabilities" (status, "playerId", "gameweekId", "roomId", "createdAt", "updatedAt")
        VALUES (${body.status}, ${body.playerId}, ${body.gameweekId}, ${active.roomId}, NOW(), NOW())
        ON CONFLICT ("playerId", "gameweekId", "roomId")
        DO UPDATE SET status = EXCLUDED.status, "updatedAt" = NOW()
        RETURNING status, "playerId", "gameweekId", "roomId"
      `
      await rebuildDraftTeams(body.gameweekId, active.roomId)
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

    if (method === 'POST' && route === '/manual-teamassignment') {
      const body = parseBody<{ gameweekId?: number; playerId?: number; team?: 'A' | 'B' | 'bench' | null }>(event)
      if (!body.gameweekId || !body.playerId) return json({ error: 'gameweekId and playerId are required' }, 400)
      if (!auth.isAdmin) return json({ error: 'Admin privileges required.' }, 403)

      const [gameweek] = await db.sql`
        SELECT id
        FROM public."Gameweeks"
        WHERE id = ${body.gameweekId}
          AND "roomId" = ${active.roomId}
      `
      if (!gameweek) return json({ error: 'Gameweek not found' }, 404)

      const [member] = await db.sql`
        SELECT "playerId"
        FROM public."RoomMemberships"
        WHERE "roomId" = ${active.roomId}
          AND "playerId" = ${body.playerId}
          AND "isMember" = true
      `
      if (!member) return json({ error: 'Player is not in this room' }, 404)

      if (!body.team || body.team === 'bench') {
        await db.sql`
          DELETE FROM public."TeamAssignments"
          WHERE "gameweekId" = ${body.gameweekId}
            AND "playerId" = ${body.playerId}
            AND "roomId" = ${active.roomId}
        `
        return json({ success: true, playerId: body.playerId, team: null })
      }

      const [assignment] = await db.sql`
        INSERT INTO public."TeamAssignments" (team, "playerId", "gameweekId", "roomId", "createdAt", "updatedAt")
        VALUES (${body.team}, ${body.playerId}, ${body.gameweekId}, ${active.roomId}, NOW(), NOW())
        ON CONFLICT ("playerId", "gameweekId", "roomId")
        DO UPDATE SET team = EXCLUDED.team, "updatedAt" = NOW()
        RETURNING id, team, "playerId", "gameweekId", "roomId"
      `
      return json({ success: true, assignment })
    }

    if (method === 'POST' && route === '/gameresults') {
      const body = parseBody<{
        gameweekId?: number
        teamA_score?: number
        teamB_score?: number
        teamA_player_count?: number
        teamB_player_count?: number
      }>(event)
      if (!auth.isAdmin) return json({ error: 'Admin privileges required.' }, 403)
      if (!body.gameweekId || body.teamA_score === undefined || body.teamB_score === undefined) {
        return json({ error: 'gameweekId, teamA_score and teamB_score are required' }, 400)
      }
      if (!Number.isFinite(body.teamA_score) || !Number.isFinite(body.teamB_score)) {
        return json({ error: 'Scores must be valid numbers' }, 400)
      }

      const [gameweek] = await db.sql`
        SELECT id
        FROM public."Gameweeks"
        WHERE id = ${body.gameweekId}
          AND "roomId" = ${active.roomId}
      `
      if (!gameweek) return json({ error: 'Gameweek not found' }, 404)

      const [counts] = await db.sql<{ team_a: string; team_b: string }>`
        SELECT
          COUNT(*) FILTER (WHERE team = 'A')::text AS team_a,
          COUNT(*) FILTER (WHERE team = 'B')::text AS team_b
        FROM public."TeamAssignments"
        WHERE "gameweekId" = ${body.gameweekId}
          AND "roomId" = ${active.roomId}
      `

      const [result] = await db.sql`
        INSERT INTO public."GameResults" (
          "gameweekId", "roomId", "teamA_score", "teamB_score",
          "teamA_player_count", "teamB_player_count", "createdAt", "updatedAt"
        )
        VALUES (
          ${body.gameweekId}, ${active.roomId}, ${body.teamA_score}, ${body.teamB_score},
          ${body.teamA_player_count ?? Number(counts.team_a)}, ${body.teamB_player_count ?? Number(counts.team_b)},
          NOW(), NOW()
        )
        ON CONFLICT ("gameweekId", "roomId")
        DO UPDATE SET
          "teamA_score" = EXCLUDED."teamA_score",
          "teamB_score" = EXCLUDED."teamB_score",
          "teamA_player_count" = EXCLUDED."teamA_player_count",
          "teamB_player_count" = EXCLUDED."teamB_player_count",
          "updatedAt" = NOW()
        RETURNING id, "gameweekId", "teamA_score", "teamB_score", "teamA_player_count", "teamB_player_count"
      `
      return json(result)
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
      '/pick-teams',
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

async function generateRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('')
    const [existing] = await db.sql`
      SELECT id
      FROM public."Rooms"
      WHERE code = ${code}
    `
    if (!existing) return code
  }

  throw new Error('Could not generate a unique room code')
}

function initialRating(skillLevel?: string) {
  switch (skillLevel) {
    case 'beginner':
      return 800
    case 'below_average':
      return 900
    case 'better_than_average':
      return 1100
    case 'experienced':
      return 1200
    default:
      return 1000
  }
}

function isActiveRoom(auth: AuthContext, roomId: number) {
  return Number(auth.roomId) === Number(roomId)
}

async function rebuildDraftTeams(gameweekId: number, roomId: number) {
  const availablePlayers = await db.sql<{
    id: number
    rating: string | number | null
    favoritePositions: string[] | null
  }>`
    SELECT p.id, p.rating, rm."favoritePositions"
    FROM public."Availabilities" a
    JOIN public."Players" p ON p.id = a."playerId"
    JOIN public."RoomMemberships" rm
      ON rm."playerId" = a."playerId"
     AND rm."roomId" = a."roomId"
     AND rm."isMember" = true
    WHERE a."gameweekId" = ${gameweekId}
      AND a."roomId" = ${roomId}
      AND a.status = true
    ORDER BY p.rating DESC NULLS LAST
  `

  const players = availablePlayers.map((player) => ({
    id: player.id,
    rating: Number(player.rating || 0),
    favoritePositions: player.favoritePositions ?? [],
  }))

  const totalPlayers = players.length
  let threshold = 0.15
  if (totalPlayers === 6) threshold = 0.5
  else if (totalPlayers <= 8) threshold = 0.4
  else if (totalPlayers <= 10) threshold = 0.3
  else if (totalPlayers <= 12) threshold = 0.25

  const pairSynergyMap = await buildPairSynergyMap({
    roomId,
    playerIds: players.map((player) => player.id),
    lookbackGames: TEAM_PICKING_OPTIONS.synergyLookbackGames,
  })

  const teamResult = await pickBalancedTeams(players, threshold, {
    pairSynergyMap,
    pairSynergyWeight: TEAM_PICKING_OPTIONS.pairSynergyWeight,
    ratingGapEpsilon: TEAM_PICKING_OPTIONS.ratingGapEpsilon,
  })

  await db.sql`
    DELETE FROM public."TeamAssignments"
    WHERE "gameweekId" = ${gameweekId}
      AND "roomId" = ${roomId}
  `

  if (!teamResult) return

  const assignments = [
    ...teamResult.teamA.map((player) => ({ playerId: player.id, team: 'A' })),
    ...teamResult.teamB.map((player) => ({ playerId: player.id, team: 'B' })),
  ]

  for (const assignment of assignments) {
    await db.sql`
      INSERT INTO public."TeamAssignments" (team, "playerId", "gameweekId", "roomId", "createdAt", "updatedAt")
      VALUES (${assignment.team}, ${assignment.playerId}, ${gameweekId}, ${roomId}, NOW(), NOW())
    `
  }
}

function averageRating(players: DraftPlayer[]) {
  const sum = players.reduce((acc, player) => acc + (player.rating || 0), 0)
  return players.length ? sum / players.length : 0
}

function isRatingBalanced(avgA: number, avgB: number, threshold = 0.1) {
  const max = Math.max(avgA, avgB)
  const min = Math.min(avgA, avgB)
  return max === 0 ? true : (max - min) / max <= threshold
}

function generateCombinations(players: DraftPlayer[]) {
  const result: Array<[DraftPlayer[], DraftPlayer[]]> = []
  const total = players.length
  const half = Math.floor(total / 2)
  const upperHalf = Math.ceil(total / 2)

  function backtrack(start: number, teamA: DraftPlayer[]) {
    if (teamA.length === half || teamA.length === upperHalf) {
      const teamB = players.filter((player) => !teamA.includes(player))
      result.push([teamA.slice(), teamB])
      return
    }

    for (let index = start; index < players.length; index += 1) {
      teamA.push(players[index])
      backtrack(index + 1, teamA)
      teamA.pop()
    }
  }

  backtrack(0, [])
  return result
}

function getPositionPreferenceScore(team: DraftPlayer[], allPositions: Set<string>) {
  if (allPositions.size === 0) return 0

  const positionCount = Object.fromEntries([...allPositions].map((position) => [position, 0]))
  for (const player of team) {
    const prefs = player.favoritePositions || []
    if (prefs[0] && allPositions.has(prefs[0])) positionCount[prefs[0]] += 3
    if (prefs[1] && allPositions.has(prefs[1])) positionCount[prefs[1]] += 2
    if (prefs[2] && allPositions.has(prefs[2])) positionCount[prefs[2]] += 1
  }

  const teamScore = Object.values(positionCount).reduce((acc, value) => acc + value, 0)
  if (teamScore === 0) return 0

  const idealCount = teamScore / allPositions.size
  let deviationSum = 0
  for (const position of Object.keys(positionCount)) {
    deviationSum += Math.abs(positionCount[position] - idealCount)
  }

  return deviationSum / allPositions.size
}

function getRatingGapRatio(teamA: DraftPlayer[], teamB: DraftPlayer[]) {
  const avgA = averageRating(teamA)
  const avgB = averageRating(teamB)
  const max = Math.max(avgA, avgB)
  const min = Math.min(avgA, avgB)
  return max === 0 ? 0 : (max - min) / max
}

function buildPairKey(a: number, b: number) {
  const first = Number(a)
  const second = Number(b)
  return first < second ? `${first}:${second}` : `${second}:${first}`
}

function getTeamPairSynergyScore(team: DraftPlayer[], pairSynergyMap: Record<string, number>) {
  if (!team || team.length < 2) return 0

  let total = 0
  let pairCount = 0
  for (let first = 0; first < team.length; first += 1) {
    for (let second = first + 1; second < team.length; second += 1) {
      const key = buildPairKey(team[first].id, team[second].id)
      total += Number(pairSynergyMap[key] || 0)
      pairCount += 1
    }
  }

  return pairCount === 0 ? 0 : total / pairCount
}

function isBetterCandidate(
  ratingGap: number,
  adjustedScore: number,
  bestRatingGap: number,
  bestAdjustedScore: number,
  ratingGapEpsilon: number,
) {
  if (ratingGap < bestRatingGap - ratingGapEpsilon) return true
  return Math.abs(ratingGap - bestRatingGap) <= ratingGapEpsilon && adjustedScore < bestAdjustedScore
}

async function pickBalancedTeams(players: DraftPlayer[], threshold = 0.1, options: TeamPickOptions = {}) {
  if (players.length === 0) return { teamA: [], teamB: [] }
  if (players.length === 1) return { teamA: [players[0]], teamB: [] }

  const allPositions = new Set<string>()
  players.forEach((player) => (player.favoritePositions || []).forEach((position) => allPositions.add(position)))

  const combos = generateCombinations(players)
  const pairSynergyMap = options.pairSynergyMap || {}
  const pairSynergyWeight =
    typeof options.pairSynergyWeight === 'number' && Number.isFinite(options.pairSynergyWeight)
      ? options.pairSynergyWeight
      : 0.75
  const ratingGapEpsilon =
    typeof options.ratingGapEpsilon === 'number' && Number.isFinite(options.ratingGapEpsilon)
      ? options.ratingGapEpsilon
      : 0.015
  const adjustedThreshold = players.length % 2 !== 0 ? threshold * 1.5 : threshold

  let bestWithinThreshold: { teamA: DraftPlayer[]; teamB: DraftPlayer[] } | null = null
  let bestWithinRatingGap = Infinity
  let bestWithinAdjustedScore = Infinity
  let bestOverall: { teamA: DraftPlayer[]; teamB: DraftPlayer[] } | null = null
  let bestOverallRatingGap = Infinity
  let bestOverallAdjustedScore = Infinity

  for (const [teamA, teamB] of combos) {
    const ratingGap = getRatingGapRatio(teamA, teamB)
    const positionScore = getPositionPreferenceScore(teamA, allPositions) + getPositionPreferenceScore(teamB, allPositions)
    const pairSynergyScore = getTeamPairSynergyScore(teamA, pairSynergyMap) + getTeamPairSynergyScore(teamB, pairSynergyMap)
    const adjustedScore = positionScore - pairSynergyWeight * pairSynergyScore
    const isWithinThreshold = isRatingBalanced(averageRating(teamA), averageRating(teamB), adjustedThreshold)

    if (isBetterCandidate(ratingGap, adjustedScore, bestOverallRatingGap, bestOverallAdjustedScore, ratingGapEpsilon)) {
      bestOverall = { teamA, teamB }
      bestOverallRatingGap = ratingGap
      bestOverallAdjustedScore = adjustedScore
    }

    if (
      isWithinThreshold &&
      isBetterCandidate(ratingGap, adjustedScore, bestWithinRatingGap, bestWithinAdjustedScore, ratingGapEpsilon)
    ) {
      bestWithinThreshold = { teamA, teamB }
      bestWithinRatingGap = ratingGap
      bestWithinAdjustedScore = adjustedScore
    }
  }

  return bestWithinThreshold ?? bestOverall
}

function getTeamOutcomeScore(result: { teamA_score: number; teamB_score: number }, team: string) {
  if (result.teamA_score === result.teamB_score) return 0
  const teamAWin = result.teamA_score > result.teamB_score
  if (team === 'A') return teamAWin ? 1 : -1
  return teamAWin ? -1 : 1
}

async function buildPairSynergyMap({
  roomId,
  playerIds = [],
  lookbackGames,
}: {
  roomId: number
  playerIds?: number[]
  lookbackGames: number
}) {
  const targetPlayerIds = new Set((playerIds || []).map((id) => Number(id)))
  const recentResults = await db.sql<{
    gameweekId: number
    teamA_score: number
    teamB_score: number
  }>`
    SELECT "gameweekId", "teamA_score", "teamB_score"
    FROM public."GameResults"
    WHERE "roomId" = ${roomId}
    ORDER BY "createdAt" DESC
    LIMIT ${lookbackGames}
  `

  if (!recentResults.length) return {}

  const resultByGameweekId = new Map(recentResults.map((row) => [Number(row.gameweekId), row]))
  const gameweekIds = [...resultByGameweekId.keys()]
  const assignments = await db.sql<{ gameweekId: number; team: string; playerId: number }>`
    SELECT "gameweekId", team, "playerId"
    FROM public."TeamAssignments"
    WHERE "roomId" = ${roomId}
      AND "gameweekId" = ANY(${gameweekIds}::int[])
  `

  const assignmentsByGameweekTeam = new Map<string, number[]>()
  for (const row of assignments) {
    const playerId = Number(row.playerId)
    if (targetPlayerIds.size && !targetPlayerIds.has(playerId)) continue

    const key = `${Number(row.gameweekId)}:${row.team}`
    const existing = assignmentsByGameweekTeam.get(key) || []
    existing.push(playerId)
    assignmentsByGameweekTeam.set(key, existing)
  }

  const pairStats = new Map<string, { score: number; games: number }>()
  for (const [groupKey, playerList] of assignmentsByGameweekTeam.entries()) {
    if (playerList.length < 2) continue

    const [gameweekIdRaw, team] = groupKey.split(':')
    const result = resultByGameweekId.get(Number(gameweekIdRaw))
    if (!result) continue

    const outcomeScore = getTeamOutcomeScore(result, team)
    const sortedPlayers = [...playerList].sort((a, b) => a - b)
    for (let first = 0; first < sortedPlayers.length; first += 1) {
      for (let second = first + 1; second < sortedPlayers.length; second += 1) {
        const pairKey = buildPairKey(sortedPlayers[first], sortedPlayers[second])
        const stat = pairStats.get(pairKey) || { score: 0, games: 0 }
        stat.games += 1
        stat.score += outcomeScore
        pairStats.set(pairKey, stat)
      }
    }
  }

  const smoothing = 3
  const pairSynergyMap: Record<string, number> = {}
  for (const [pairKey, stat] of pairStats.entries()) {
    const meanOutcome = stat.games > 0 ? stat.score / stat.games : 0
    const confidence = stat.games / (stat.games + smoothing)
    pairSynergyMap[pairKey] = meanOutcome * confidence
  }

  return pairSynergyMap
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
