import { useEffect, useState } from 'react'

type DbStatus =
  | {
      configured: true
      database: string
      checkedAt: string
      eventCount: number | null
      needsMigration?: boolean
      message?: string
    }
  | {
      configured: false
      message: string
    }

function App() {
  const [dbStatus, setDbStatus] = useState<DbStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/.netlify/functions/db-status')
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(await response.text())
        }

        return response.json() as Promise<DbStatus>
      })
      .then(setDbStatus)
      .catch((caughtError: unknown) => {
        setError(caughtError instanceof Error ? caughtError.message : 'Unknown error')
      })
  }, [])

  return (
    <main className="shell">
      <section className="panel">
        <p className="eyebrow">Vite + React + Netlify Functions</p>
        <h1>Teamix is ready for a Netlify Database.</h1>
        <p className="intro">
          The frontend is served by Vite, server code lives in Netlify Functions,
          and database access is isolated from the browser.
        </p>

        <div className="status">
          <span className={dbStatus?.configured ? 'dot ready' : 'dot'} />
          <div>
            <strong>Database status</strong>
            <p>{renderStatus(dbStatus, error)}</p>
          </div>
        </div>
      </section>
    </main>
  )
}

function renderStatus(dbStatus: DbStatus | null, error: string | null) {
  if (error) {
    return `Function call failed: ${error}`
  }

  if (!dbStatus) {
    return 'Checking the Netlify function...'
  }

  if (!dbStatus.configured) {
    return dbStatus.message
  }

  if (dbStatus.needsMigration) {
    return `${dbStatus.database} responded at ${new Date(dbStatus.checkedAt).toLocaleString()}. ${dbStatus.message}`
  }

  return `${dbStatus.database} responded at ${new Date(dbStatus.checkedAt).toLocaleString()} with ${dbStatus.eventCount} app event rows.`
}

export default App
