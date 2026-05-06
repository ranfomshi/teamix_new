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
        if (body.profilePicture) {
          await db.sql`
            UPDATE public."Players"
            SET "profilePicture" = ${body.profilePicture}, "updatedAt" = NOW()
            WHERE id = ${playerId}
          `
        }
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

    const roomMemberAdminMatch = route.match(/^\/rooms\/(\d+)\/members\/(\d+)\/admin$/)
    if (roomMemberAdminMatch && method === 'POST') {
      const roomId = Number(roomMemberAdminMatch[1])
      const playerId = Number(roomMemberAdminMatch[2])
      if (!isActiveRoom(auth, roomId)) return json({ error: 'Switch to this room before managing members.' }, 403)
      if (!auth.isAdmin) return json({ error: 'Admin privileges required.' }, 403)

      const [member] = await db.sql`
        UPDATE public."RoomMemberships"
        SET "isAdmin" = true, "updatedAt" = NOW()
        WHERE "roomId" = ${roomId}
          AND "playerId" = ${playerId}
          AND "isMember" = true
        RETURNING "playerId", "roomId", "isAdmin"
      `
      return member ? json({ success: true, member }) : json({ error: 'Member not found' }, 404)
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

    if (method === 'PUT' && route === '/favorite-positions') {
      const body = parseBody<{ favoritePositions?: string[] }>(event)
      const favoritePositions = Array.isArray(body.favoritePositions)
        ? body.favoritePositions.map((position) => String(position).trim()).filter(Boolean).slice(0, 3)
        : null
      if (!favoritePositions) return json({ error: 'favoritePositions must be an array.' }, 400)

      const [membership] = await db.sql`
        UPDATE public."RoomMemberships"
        SET "favoritePositions" = ${favoritePositions}::text[], "updatedAt" = NOW()
        WHERE "roomId" = ${active.roomId}
          AND "playerId" = ${active.playerId}
          AND "isMember" = true
        RETURNING "favoritePositions"
      `
      return membership ? json({ favoritePositions: membership.favoritePositions }) : json({ error: 'Membership not found' }, 404)
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
    const playerLinkMatch = route.match(/^\/players\/(\d+)\/link$/)
    const playerCombosMatch = route.match(/^\/players\/(\d+)\/combos$/)
    const playerAchievementsMatch = route.match(/^\/players\/(\d+)\/achievements$/)
    if (playerCombosMatch && method === 'GET') {
      const playerId = Number(playerCombosMatch[1])
      const allies = await db.sql<{
        partnerId: number; name: string; profilePicture: string | null
        games: number; wins: number; draws: number; losses: number
      }>`
        SELECT
          ta2."playerId" AS "partnerId",
          p.name,
          p."profilePicture",
          COUNT(*)::int AS games,
          COUNT(*) FILTER (
            WHERE (ta1.team = 'A' AND gr."teamA_score" > gr."teamB_score")
               OR (ta1.team = 'B' AND gr."teamB_score" > gr."teamA_score")
          )::int AS wins,
          COUNT(*) FILTER (
            WHERE gr."teamA_score" = gr."teamB_score"
          )::int AS draws,
          COUNT(*) FILTER (
            WHERE (ta1.team = 'A' AND gr."teamA_score" < gr."teamB_score")
               OR (ta1.team = 'B' AND gr."teamB_score" < gr."teamA_score")
          )::int AS losses
        FROM public."TeamAssignments" ta1
        JOIN public."TeamAssignments" ta2
          ON ta2."gameweekId" = ta1."gameweekId"
         AND ta2."roomId" = ta1."roomId"
         AND ta2.team = ta1.team
         AND ta2."playerId" != ta1."playerId"
        JOIN public."GameResults" gr
          ON gr."gameweekId" = ta1."gameweekId"
         AND gr."roomId" = ta1."roomId"
        JOIN public."Players" p ON p.id = ta2."playerId"
        WHERE ta1."playerId" = ${playerId}
          AND ta1."roomId" = ${active.roomId}
          AND ta1.team IN ('A', 'B')
        GROUP BY ta2."playerId", p.name, p."profilePicture"
        HAVING COUNT(*) >= 3
        ORDER BY COUNT(*) FILTER (
          WHERE (ta1.team = 'A' AND gr."teamA_score" > gr."teamB_score")
             OR (ta1.team = 'B' AND gr."teamB_score" > gr."teamA_score")
        )::float / COUNT(*) DESC
        LIMIT 5
      `
      const opponents = await db.sql<{
        partnerId: number; name: string; profilePicture: string | null
        games: number; wins: number; draws: number; losses: number
      }>`
        SELECT
          ta2."playerId" AS "partnerId",
          p.name,
          p."profilePicture",
          COUNT(*)::int AS games,
          COUNT(*) FILTER (
            WHERE (ta1.team = 'A' AND gr."teamA_score" > gr."teamB_score")
               OR (ta1.team = 'B' AND gr."teamB_score" > gr."teamA_score")
          )::int AS wins,
          COUNT(*) FILTER (
            WHERE gr."teamA_score" = gr."teamB_score"
          )::int AS draws,
          COUNT(*) FILTER (
            WHERE (ta1.team = 'A' AND gr."teamA_score" < gr."teamB_score")
               OR (ta1.team = 'B' AND gr."teamB_score" < gr."teamA_score")
          )::int AS losses
        FROM public."TeamAssignments" ta1
        JOIN public."TeamAssignments" ta2
          ON ta2."gameweekId" = ta1."gameweekId"
         AND ta2."roomId" = ta1."roomId"
         AND ta2.team != ta1.team
         AND ta2."playerId" != ta1."playerId"
        JOIN public."GameResults" gr
          ON gr."gameweekId" = ta1."gameweekId"
         AND gr."roomId" = ta1."roomId"
        JOIN public."Players" p ON p.id = ta2."playerId"
        WHERE ta1."playerId" = ${playerId}
          AND ta1."roomId" = ${active.roomId}
          AND ta1.team IN ('A', 'B')
        GROUP BY ta2."playerId", p.name, p."profilePicture"
        HAVING COUNT(*) >= 3
        ORDER BY COUNT(*) FILTER (
          WHERE (ta1.team = 'A' AND gr."teamA_score" > gr."teamB_score")
             OR (ta1.team = 'B' AND gr."teamB_score" > gr."teamA_score")
        )::float / COUNT(*) ASC
        LIMIT 5
      `
      return json({ allies, opponents })
    }

    if (playerAchievementsMatch && method === 'GET') {
      const playerId = Number(playerAchievementsMatch[1])
      const achievements = await db.sql<{ id: number; title: string; description: string; earnedAt: string }>`
        SELECT a.id, a.title, a.description, pa."earnedAt"
        FROM public."PlayerAchievements" pa
        JOIN public."Achievements" a ON a.id = pa."achievementId"
        WHERE pa."playerId" = ${playerId}
          AND pa."roomId" = ${active.roomId}
          AND a."isActive" = true
        ORDER BY pa."earnedAt" DESC
      `
      return json(achievements)
    }

    if (playerLinkMatch && method === 'PUT') {
      const playerId = Number(playerLinkMatch[1])
      const [linked] = await db.sql`
        UPDATE public."RoomMemberships"
        SET "auth0Id" = ${auth.sub}, "isActive" = true, "updatedAt" = NOW()
        WHERE "roomId" = ${active.roomId}
          AND "playerId" = ${playerId}
          AND "isMember" = true
          AND ("auth0Id" IS NULL OR "auth0Id" = ${auth.sub})
        RETURNING "playerId", "roomId", "isActive", "isAdmin"
      `
      return linked ? json({ success: true, membership: linked }) : json({ error: 'Player profile is not available to link' }, 409)
    }

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

    if (method === 'POST' && route === '/ratings') {
      const body = parseBody<{ date?: string; ratings?: Array<{ playerId?: number; rating?: number; raterId?: number | null }> }>(event)
      if (!body.date || !Array.isArray(body.ratings)) return json({ error: 'date and ratings are required' }, 400)

      const created = []
      for (const rating of body.ratings) {
        if (!rating.playerId || !Number.isFinite(rating.rating)) return json({ error: 'Each rating needs playerId and rating' }, 400)
        const [member] = await db.sql`
          SELECT "playerId"
          FROM public."RoomMemberships"
          WHERE "roomId" = ${active.roomId}
            AND "playerId" = ${rating.playerId}
            AND "isMember" = true
        `
        if (!member) return json({ error: `Player not found: ${rating.playerId}` }, 404)

        const [record] = await db.sql`
          INSERT INTO public."Ratings" ("playerId", date, rating, "raterId", "roomId", "createdAt", "updatedAt")
          VALUES (${rating.playerId}, ${body.date}, ${rating.rating}, ${rating.raterId ?? active.playerId ?? null}, ${active.roomId}, NOW(), NOW())
          RETURNING id, "playerId", date, rating, "raterId", "roomId"
        `
        created.push(record)
      }
      return json(created, 201)
    }

    if (method === 'GET' && route === '/ratings') {
      const date = event.queryStringParameters?.date
      const playerId = event.queryStringParameters?.playerId ? Number(event.queryStringParameters.playerId) : null
      const ratings = await db.sql`
        SELECT r."playerId", p.name AS "playerName", AVG(r.rating)::float AS "avgRating",
               json_agg(json_build_object('id', r.id, 'date', r.date, 'rating', r.rating, 'raterId', r."raterId") ORDER BY r.date DESC, r.id DESC) AS ratings
        FROM public."Ratings" r
        JOIN public."Players" p ON p.id = r."playerId"
        JOIN public."RoomMemberships" rm
          ON rm."playerId" = r."playerId"
         AND rm."roomId" = r."roomId"
         AND rm."isMember" = true
        WHERE r."roomId" = ${active.roomId}
          AND (${date ?? null}::date IS NULL OR r.date = ${date ?? null})
          AND (${playerId ?? null}::int IS NULL OR r."playerId" = ${playerId ?? null})
        GROUP BY r."playerId", p.name
        ORDER BY p.name ASC
      `
      return json(ratings)
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
               gr."teamA_score", gr."teamB_score", gr."createdAt" AS "resultCreatedAt",
               COALESCE(potm."playerOfTheMatch", '[]'::json) AS "playerOfTheMatch"
        FROM public."Gameweeks" gw
        LEFT JOIN public."GameResults" gr
          ON gr."gameweekId" = gw.id AND gr."roomId" = gw."roomId"
        LEFT JOIN LATERAL (
          SELECT json_agg(json_build_object('id', ranked."playerId", 'name', p.name, 'votes', ranked.vote_count) ORDER BY p.name) AS "playerOfTheMatch"
          FROM (
            SELECT v."voted_player_id" AS "playerId", COUNT(*)::int AS vote_count,
                   DENSE_RANK() OVER (ORDER BY COUNT(*) DESC) AS vote_rank
            FROM public."Votes" v
            WHERE v."gameweek_id" = gw.id
              AND v."roomId" = gw."roomId"
            GROUP BY v."voted_player_id"
          ) ranked
          JOIN public."Players" p ON p.id = ranked."playerId"
          WHERE ranked.vote_rank = 1
        ) potm ON true
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
               gr."teamA_score", gr."teamB_score", gr."createdAt" AS "resultCreatedAt",
               COALESCE(potm."playerOfTheMatch", '[]'::json) AS "playerOfTheMatch"
        FROM public."Gameweeks" gw
        LEFT JOIN public."GameResults" gr
          ON gr."gameweekId" = gw.id AND gr."roomId" = gw."roomId"
        LEFT JOIN LATERAL (
          SELECT json_agg(json_build_object('id', ranked."playerId", 'name', p.name, 'votes', ranked.vote_count) ORDER BY p.name) AS "playerOfTheMatch"
          FROM (
            SELECT v."voted_player_id" AS "playerId", COUNT(*)::int AS vote_count,
                   DENSE_RANK() OVER (ORDER BY COUNT(*) DESC) AS vote_rank
            FROM public."Votes" v
            WHERE v."gameweek_id" = gw.id
              AND v."roomId" = gw."roomId"
            GROUP BY v."voted_player_id"
          ) ranked
          JOIN public."Players" p ON p.id = ranked."playerId"
          WHERE ranked.vote_rank = 1
        ) potm ON true
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
      await updatePlayerRatings(body.gameweekId, active.roomId)
      await awardAchievementsForGameweek(body.gameweekId, active.roomId, body.teamA_score, body.teamB_score)
      return json(result)
    }

    if (method === 'POST' && route === '/recalculate-achievements') {
      const allResults = await db.sql<{ gameweekId: number; teamA_score: number; teamB_score: number }>`
        SELECT gr."gameweekId", gr."teamA_score", gr."teamB_score"
        FROM public."GameResults" gr
        JOIN public."Gameweeks" gw ON gw.id = gr."gameweekId" AND gw."roomId" = gr."roomId"
        WHERE gr."roomId" = ${active.roomId}
        ORDER BY gw.date ASC, gr."createdAt" ASC
      `
      for (const result of allResults) {
        await awardAchievementsForGameweek(result.gameweekId, active.roomId, result.teamA_score, result.teamB_score)
      }
      return json({ processed: allResults.length })
    }

    if (method === 'GET' && route === '/gameresults') {
      const gameResults = await db.sql`
        SELECT gr.id, gr."gameweekId", gr."teamA_score", gr."teamB_score",
               gr."teamA_player_count", gr."teamB_player_count", gr."createdAt",
               gw.date, gw.location, gw."startTime"
        FROM public."GameResults" gr
        JOIN public."Gameweeks" gw
          ON gw.id = gr."gameweekId"
         AND gw."roomId" = gr."roomId"
        WHERE gr."roomId" = ${active.roomId}
        ORDER BY gw.date DESC, gr."createdAt" DESC
      `
      return json(gameResults)
    }

    if (method === 'POST' && route === '/votes') {
      const body = parseBody<{ gameweekId?: number; votedPlayerId?: number }>(event)
      if (!body.gameweekId || !body.votedPlayerId) return json({ error: 'gameweekId and votedPlayerId are required' }, 400)
      if (body.votedPlayerId === active.playerId) return json({ error: 'You cannot vote for yourself.' }, 403)

      const [gameResult] = await db.sql<{ createdAt: string }>`
        SELECT "createdAt"
        FROM public."GameResults"
        WHERE "gameweekId" = ${body.gameweekId}
          AND "roomId" = ${active.roomId}
      `
      if (!gameResult) return json({ error: 'Voting opens after the result is recorded.' }, 400)
      if (Date.now() > new Date(gameResult.createdAt).getTime() + 48 * 60 * 60 * 1000) {
        return json({ error: 'Voting has closed for this fixture.' }, 403)
      }

      const [voterAssignment] = await db.sql`
        SELECT id
        FROM public."TeamAssignments"
        WHERE "gameweekId" = ${body.gameweekId}
          AND "roomId" = ${active.roomId}
          AND "playerId" = ${active.playerId}
          AND team IN ('A', 'B')
      `
      if (!voterAssignment) return json({ error: 'You did not play in this fixture and cannot vote.' }, 403)

      const [candidateAssignment] = await db.sql`
        SELECT id
        FROM public."TeamAssignments"
        WHERE "gameweekId" = ${body.gameweekId}
          AND "roomId" = ${active.roomId}
          AND "playerId" = ${body.votedPlayerId}
          AND team IN ('A', 'B')
      `
      if (!candidateAssignment) return json({ error: 'That player did not play in this fixture.' }, 400)

      const [existing] = await db.sql`
        SELECT id
        FROM public."Votes"
        WHERE "gameweek_id" = ${body.gameweekId}
          AND "roomId" = ${active.roomId}
          AND "voting_player_id" = ${active.playerId}
      `
      if (existing) return json({ error: 'You have already voted in this fixture.' }, 403)

      const [vote] = await db.sql`
        INSERT INTO public."Votes" ("gameweek_id", "voting_player_id", "voted_player_id", "voted_at", "roomId")
        VALUES (${body.gameweekId}, ${active.playerId}, ${body.votedPlayerId}, NOW(), ${active.roomId})
        RETURNING id, "gameweek_id", "voting_player_id", "voted_player_id", "voted_at"
      `
      return json({ message: 'Vote cast successfully.', vote }, 201)
    }

    if (method === 'GET' && route === '/has-voted') {
      const gameweekId = Number(event.queryStringParameters?.gameweekId)
      if (!gameweekId) return json({ error: 'gameweekId is required' }, 400)

      const [vote] = await db.sql`
        SELECT id, "voted_player_id"
        FROM public."Votes"
        WHERE "gameweek_id" = ${gameweekId}
          AND "roomId" = ${active.roomId}
          AND "voting_player_id" = ${active.playerId}
      `
      return json({ hasVoted: Boolean(vote), player_id: active.playerId, votedPlayerId: vote?.voted_player_id ?? null })
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

    if (method === 'GET' && route === '/notifications') {
      const voteNotifications = await db.sql<{
        gameweekId: number; date: string; location: string | null; startTime: string | null;
        players: { id: number; name: string; profilePicture: string | null }[]
      }>`
        SELECT
          gw.id AS "gameweekId",
          gw.date,
          gw.location,
          gw."startTime",
          json_agg(
            json_build_object('id', p.id, 'name', p.name, 'profilePicture', p."profilePicture")
            ORDER BY p.name
          ) AS players
        FROM public."GameResults" gr
        JOIN public."Gameweeks" gw
          ON gw.id = gr."gameweekId" AND gw."roomId" = gr."roomId"
        JOIN public."TeamAssignments" my_ta
          ON my_ta."gameweekId" = gr."gameweekId"
         AND my_ta."roomId" = gr."roomId"
         AND my_ta."playerId" = ${active.playerId}
         AND my_ta.team IN ('A', 'B')
        JOIN public."TeamAssignments" other_ta
          ON other_ta."gameweekId" = gr."gameweekId"
         AND other_ta."roomId" = gr."roomId"
         AND other_ta."playerId" != ${active.playerId}
         AND other_ta.team IN ('A', 'B')
        JOIN public."Players" p ON p.id = other_ta."playerId"
        LEFT JOIN public."Votes" v
          ON v."gameweek_id" = gr."gameweekId"
         AND v."roomId" = gr."roomId"
         AND v."voting_player_id" = ${active.playerId}
        WHERE gr."roomId" = ${active.roomId}
          AND gr."createdAt" >= NOW() - INTERVAL '48 hours'
          AND v.id IS NULL
        GROUP BY gw.id, gw.date, gw.location, gw."startTime"
      `

      const availabilityNotifications = await db.sql<{
        gameweekId: number; date: string; location: string | null; startTime: string | null
      }>`
        SELECT gw.id AS "gameweekId", gw.date, gw.location, gw."startTime"
        FROM public."Gameweeks" gw
        LEFT JOIN public."Availabilities" a
          ON a."gameweekId" = gw.id
         AND a."roomId" = gw."roomId"
         AND a."playerId" = ${active.playerId}
        WHERE gw."roomId" = ${active.roomId}
          AND gw.date >= CURRENT_DATE
          AND a."playerId" IS NULL
        ORDER BY gw.date ASC
      `

      const notifications = [
        ...voteNotifications.map((n) => ({ type: 'vote' as const, ...n })),
        ...availabilityNotifications.map((n) => ({ type: 'availability' as const, ...n })),
      ]
      return json(notifications)
    }

    if (method === 'PATCH' && route === '/sync-avatar') {
      const body = parseBody<{ picture?: string | null }>(event)
      if (body.picture) {
        await db.sql`
          UPDATE public."Players" p
          SET "profilePicture" = ${body.picture}, "updatedAt" = NOW()
          FROM public."RoomMemberships" rm
          WHERE rm."playerId" = p.id
            AND rm."auth0Id" = ${auth.sub}
        `
      }
      return json({ ok: true })
    }

    const legacyNotYetPorted = [
      '/pick-teams',
      '/teamassignments',
      '/fcm-token',
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

async function updatePlayerRatings(gameweekId: number, roomId: number) {
  const [result] = await db.sql<{
    teamA_score: number
    teamB_score: number
    teamA_player_count: number
    teamB_player_count: number
    date: string
  }>`
    SELECT gr."teamA_score", gr."teamB_score", gr."teamA_player_count", gr."teamB_player_count", gw.date
    FROM public."GameResults" gr
    JOIN public."Gameweeks" gw
      ON gw.id = gr."gameweekId"
     AND gw."roomId" = gr."roomId"
    WHERE gr."gameweekId" = ${gameweekId}
      AND gr."roomId" = ${roomId}
  `
  if (!result) return

  const assignments = await db.sql<{ playerId: number; team: string }>`
    SELECT "playerId", team
    FROM public."TeamAssignments"
    WHERE "gameweekId" = ${gameweekId}
      AND "roomId" = ${roomId}
      AND team IN ('A', 'B')
  `

  for (const assignment of assignments) {
    let points = 0
    const teamAPlayers = Number(result.teamA_player_count || 0)
    const teamBPlayers = Number(result.teamB_player_count || 0)
    const isHandicappedWin = teamAPlayers !== teamBPlayers
    const winPoints = isHandicappedWin
      ? assignment.team === 'A' && teamAPlayers > teamBPlayers
        ? 2
        : assignment.team === 'B' && teamBPlayers > teamAPlayers
          ? 2
          : 4
      : 3

    if (
      (assignment.team === 'A' && result.teamA_score > result.teamB_score) ||
      (assignment.team === 'B' && result.teamB_score > result.teamA_score)
    ) {
      points += winPoints
    } else if (result.teamA_score === result.teamB_score) {
      points += 1
    }

    if (assignment.team === 'A') {
      points += result.teamA_score * (teamAPlayers > teamBPlayers ? 0.1 : 0.2)
      if (teamAPlayers <= teamBPlayers) points -= result.teamB_score * 0.1
    } else {
      points += result.teamB_score * (teamBPlayers > teamAPlayers ? 0.1 : 0.2)
      if (teamBPlayers <= teamAPlayers) points -= result.teamA_score * 0.1
    }

    await db.sql`
      INSERT INTO public."Ratings" ("playerId", date, rating, "raterId", "roomId", "createdAt", "updatedAt")
      VALUES (${assignment.playerId}, ${result.date}, ${Number(points.toFixed(2))}, NULL, ${roomId}, NOW(), NOW())
    `

    const recentRatings = await db.sql<{ rating: string | number }>`
      SELECT rating
      FROM public."Ratings"
      WHERE "playerId" = ${assignment.playerId}
        AND "roomId" = ${roomId}
      ORDER BY date DESC, id DESC
      LIMIT 5
    `
    const totalPoints = recentRatings.reduce((total, row) => total + Number(row.rating || 0), 0)
    await db.sql`
      UPDATE public."Players"
      SET rating = ${Number(totalPoints.toFixed(2))}, "updatedAt" = NOW()
      WHERE id = ${assignment.playerId}
    `
  }
}

async function awardAchievementsForGameweek(gameweekId: number, roomId: number, teamA_score: number, teamB_score: number) {
  const assignments = await db.sql<{ playerId: number; team: string }>`
    SELECT "playerId", team
    FROM public."TeamAssignments"
    WHERE "gameweekId" = ${gameweekId}
      AND "roomId" = ${roomId}
      AND team IN ('A', 'B')
  `

  for (const assignment of assignments) {
    const eligibleIds = await getEligibleAchievementIds({
      playerId: assignment.playerId,
      roomId,
      gameweekId,
      team: assignment.team,
      teamA_score,
      teamB_score,
    })

    for (const achievementId of eligibleIds) {
      await db.sql`
        INSERT INTO public."PlayerAchievements" ("playerId", "achievementId", "roomId", "earnedAt", "createdAt", "updatedAt")
        VALUES (${assignment.playerId}, ${achievementId}, ${roomId}, NOW(), NOW(), NOW())
        ON CONFLICT ("playerId", "achievementId") DO NOTHING
      `
    }
  }
}

async function getEligibleAchievementIds({
  playerId,
  roomId,
  gameweekId,
  team,
  teamA_score,
  teamB_score,
}: {
  playerId: number
  roomId: number
  gameweekId: number
  team: string
  teamA_score: number
  teamB_score: number
}) {
  const recent = await getPlayerResultHistory(playerId, roomId, 100)
  const currentWin = didTeamWin(team, teamA_score, teamB_score)
  const currentLoss = didTeamLose(team, teamA_score, teamB_score)
  const teamGoals = team === 'A' ? teamA_score : teamB_score
  const conceded = team === 'A' ? teamB_score : teamA_score
  const ids: number[] = []

  if (recent.slice(0, 3).length >= 3 && recent.slice(0, 3).every((row) => row.outcome === 'W')) ids.push(1)
  if (recent.filter((row) => row.outcome === 'D').length >= 5) ids.push(2)
  if (recent.length >= 10) ids.push(3)
  if (recent.slice(0, 5).length >= 5 && recent.slice(0, 5).every((row) => row.outcome !== 'L')) ids.push(4)
  if (await hasLongTimeTeammate(playerId, roomId, gameweekId)) ids.push(5)
  if (recent.length >= 50) ids.push(8)
  if (recent.length >= 100) ids.push(9)
  if (recent.filter((row) => row.outcome === 'W').length >= 10) ids.push(10)
  if (currentWin && Math.abs(teamA_score - teamB_score) >= 5) ids.push(11)
  if (recent.filter((row) => row.outcome === 'L').length >= 5) ids.push(12)
  if (currentLoss && Math.abs(teamA_score - teamB_score) === 1) ids.push(13)
  if (currentWin && recent[1]?.outcome === 'L') ids.push(14)
  if (teamGoals >= 10) ids.push(15)
  if (conceded === 0) ids.push(16)
  if (teamA_score >= 5 && teamB_score >= 5) ids.push(17)

  return ids
}

async function getPlayerResultHistory(playerId: number, roomId: number, limit: number) {
  return db.sql<{ gameweekId: number; team: string; outcome: 'W' | 'D' | 'L' }>`
    SELECT gw.id AS "gameweekId", ta.team,
           CASE
             WHEN gr."teamA_score" = gr."teamB_score" THEN 'D'
             WHEN (ta.team = 'A' AND gr."teamA_score" > gr."teamB_score")
               OR (ta.team = 'B' AND gr."teamB_score" > gr."teamA_score") THEN 'W'
             ELSE 'L'
           END AS outcome
    FROM public."TeamAssignments" ta
    JOIN public."GameResults" gr
      ON gr."gameweekId" = ta."gameweekId" AND gr."roomId" = ta."roomId"
    JOIN public."Gameweeks" gw
      ON gw.id = ta."gameweekId" AND gw."roomId" = ta."roomId"
    WHERE ta."roomId" = ${roomId}
      AND ta."playerId" = ${playerId}
      AND ta.team IN ('A', 'B')
    ORDER BY gr."createdAt" DESC, gw.date DESC, gw.id DESC
    LIMIT ${limit}
  `
}

async function hasLongTimeTeammate(playerId: number, roomId: number, gameweekId: number) {
  const recentGames = await db.sql<{ gameweekId: number; team: string }>`
    SELECT ta."gameweekId", ta.team
    FROM public."TeamAssignments" ta
    JOIN public."GameResults" gr
      ON gr."gameweekId" = ta."gameweekId" AND gr."roomId" = ta."roomId"
    WHERE ta."roomId" = ${roomId}
      AND ta."playerId" = ${playerId}
      AND ta.team IN ('A', 'B')
    ORDER BY CASE WHEN ta."gameweekId" = ${gameweekId} THEN 0 ELSE 1 END, gr."createdAt" DESC
    LIMIT 5
  `
  if (recentGames.length < 5) return false

  const gameIds = recentGames.map((game) => Number(game.gameweekId))
  const teamByGame = new Map(recentGames.map((game) => [Number(game.gameweekId), game.team]))
  const teammateRows = await db.sql<{ playerId: number; gameweekId: number; team: string }>`
    SELECT ta."playerId", ta."gameweekId", ta.team
    FROM public."TeamAssignments" ta
    WHERE ta."roomId" = ${roomId}
      AND ta."playerId" <> ${playerId}
      AND ta."gameweekId" = ANY(${gameIds}::int[])
      AND ta.team IN ('A', 'B')
  `
  const teammateCounts = new Map<number, number>()
  for (const row of teammateRows) {
    if (teamByGame.get(Number(row.gameweekId)) !== row.team) continue
    teammateCounts.set(Number(row.playerId), (teammateCounts.get(Number(row.playerId)) ?? 0) + 1)
  }
  return [...teammateCounts.values()].some((count) => count >= 5)
}

function didTeamWin(team: string, teamA_score: number, teamB_score: number) {
  return (team === 'A' && teamA_score > teamB_score) || (team === 'B' && teamB_score > teamA_score)
}

function didTeamLose(team: string, teamA_score: number, teamB_score: number) {
  return (team === 'A' && teamA_score < teamB_score) || (team === 'B' && teamB_score < teamA_score)
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
    playerOfTheMatch: Array.isArray(gameweek.playerOfTheMatch) ? gameweek.playerOfTheMatch : [],
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
