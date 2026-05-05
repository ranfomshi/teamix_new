import type { Handler } from '@netlify/functions'
import { getDatabase } from '@netlify/database'

export const handler: Handler = async () => {
  try {
    const db = getDatabase()
    const [databaseInfo] = await db.sql<{ database: string; checked_at: string }>`
      SELECT current_database() AS database, NOW()::text AS checked_at
    `

    try {
      const [events] = await db.sql<{ count: string }>`
        SELECT COUNT(*)::text AS count FROM app_events
      `

      return json({
        configured: true,
        database: databaseInfo.database,
        checkedAt: databaseInfo.checked_at,
        eventCount: Number(events.count),
      })
    } catch {
      return json({
        configured: true,
        database: databaseInfo.database,
        checkedAt: databaseInfo.checked_at,
        eventCount: null,
        needsMigration: true,
        message:
          'The connection works; apply the starter migration after initializing Netlify Database.',
      })
    }

  } catch (error) {
    return json({
      configured: false,
      message:
        'No Netlify Database connection is available yet. Run npm run db:init or create the database in Netlify, then use npm run netlify:dev.',
      detail: error instanceof Error ? error.message : 'Unknown database error',
    })
  }
}

function json(body: unknown) {
  return {
    statusCode: 200,
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  }
}
