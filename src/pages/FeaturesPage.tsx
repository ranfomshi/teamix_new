import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { track } from '../analytics'
import './FeaturesPage.css'

interface FeaturesPageProps {
  onLogin: () => void
}

export default function FeaturesPage({ onLogin }: FeaturesPageProps) {
  useEffect(() => { track('Page Viewed', { page: 'features' }) }, [])

  return (
    <div className="features-page">
      <header className="features-header">
        <div className="features-header-inner">
          <Link to="/" className="features-brand">
            <img src="/fp_logo.png" alt="Teamix" />
            <span>Teamix</span>
          </Link>
          <button type="button" className="features-cta-small" onClick={onLogin}>
            Get started
          </button>
        </div>
      </header>

      <main>
        <section className="features-hero">
          <h1>Everything your squad actually needs.</h1>
          <p className="features-hero-sub">
            Teamix handles the admin so you can focus on the game. Fixtures, availability,
            team picking, stats — all in one place, on your phone.
          </p>
          <button type="button" className="features-cta-primary" onClick={onLogin}>
            Get started free
          </button>
          <Link to="/" className="features-back-link">← Back to home</Link>
        </section>

        <section className="features-grid-section">
          <div className="features-grid">

            <article className="feature-card">
              <div className="feature-card-icon">⚖️</div>
              <h2>Smart team picking</h2>
              <p>
                No more arguing over who's on which side. Teamix assigns every player a
                dynamic rating that updates after each match based on results. When you
                pick teams, the algorithm distributes ratings to create the most balanced
                possible split — competitive every single game.
              </p>
              <ul className="feature-detail-list">
                <li>Rating-based balancing across both teams</li>
                <li>Updates automatically after each result</li>
                <li>One-tap team reveal, shareable to your group chat</li>
              </ul>
            </article>

            <article className="feature-card">
              <div className="feature-card-icon">✅</div>
              <h2>Availability tracking</h2>
              <p>
                Know exactly who's in and who's out before you pick a team. Players mark
                their availability directly from the fixture card — no group chat chaos,
                no last-minute spreadsheet.
              </p>
              <ul className="feature-detail-list">
                <li>In / Out responses per fixture</li>
                <li>Live headcount as responses come in</li>
                <li>Only available players are included in team selection</li>
              </ul>
            </article>

            <article className="feature-card">
              <div className="feature-card-icon">📈</div>
              <h2>Player form &amp; stats</h2>
              <p>
                Track how everyone is actually performing — not just who shows up. Every
                player has a live W/D/L record, goals scored/conceded across their teams,
                and a recent form streak so you always know who's flying and who's in
                a rough patch.
              </p>
              <ul className="feature-detail-list">
                <li>Win / Draw / Loss record per player</li>
                <li>Goals for and against across all fixtures</li>
                <li>Recent form streak (e.g. W W D L W)</li>
                <li>Dynamic rating shifts after every result</li>
              </ul>
            </article>

            <article className="feature-card">
              <div className="feature-card-icon">🏆</div>
              <h2>Achievements &amp; gamification</h2>
              <p>
                Trophies make turning up matter. Players unlock achievements for
                milestones that go beyond just winning — loyalty, consistency, and
                clutch moments all count. It's a subtle layer of competition that keeps
                your squad engaged between seasons.
              </p>
              <ul className="feature-detail-list">
                <li>Hat-trick hero, win streak, and clean sheet badges</li>
                <li>Loyalty awards for showing up consistently</li>
                <li>Trophy cabinet visible on every player profile</li>
                <li>Achievements announced via notifications when unlocked</li>
              </ul>
            </article>

            <article className="feature-card">
              <div className="feature-card-icon">📅</div>
              <h2>Fixture management</h2>
              <p>
                Create a fixture in seconds: set the date, time, location, and player
                cap. Recurring weekly games? Set up a repeat fixture and forget about it.
                After the match, log the score and ratings update automatically.
              </p>
              <ul className="feature-detail-list">
                <li>One-off or repeating fixtures</li>
                <li>Location field with free-text address</li>
                <li>Max player cap to manage squad size</li>
                <li>Post-match score entry triggers rating recalculation</li>
              </ul>
            </article>

            <article className="feature-card">
              <div className="feature-card-icon">🏟️</div>
              <h2>Multi-squad support</h2>
              <p>
                Play in a Monday lunchtime 5-a-side and a Sunday league? Teamix lets you
                join multiple squads under one account. Switch between them with a tap —
                each squad has its own fixtures, ratings, and player pool.
              </p>
              <ul className="feature-detail-list">
                <li>Join unlimited squads with a share code</li>
                <li>Separate ratings and stats per squad</li>
                <li>Pin your most active squad to the top</li>
              </ul>
            </article>

            <article className="feature-card feature-card--wide">
              <div className="feature-card-icon">📱</div>
              <h2>Built as a PWA — install it like a native app</h2>
              <p>
                Teamix runs in your browser but installs on your home screen like a real
                app. No App Store, no Play Store, no waiting for review cycles. Add it
                to your phone in two taps and it's there every time you need it — even
                when your signal is patchy.
              </p>
              <ul className="feature-detail-list">
                <li>Installable on iOS, Android, and desktop</li>
                <li>Installs to your home screen like a native app</li>
                <li>No app store download required</li>
                <li>Always up to date — no manual updates needed</li>
              </ul>
            </article>

          </div>
        </section>

        <section className="features-cta-section">
          <h2>Ready to sort your squad?</h2>
          <p>Free to use. No subscription. Just sign up and share a code with your team.</p>
          <button type="button" className="features-cta-primary" onClick={onLogin}>
            Create your squad
          </button>
        </section>
      </main>

      <footer className="features-footer">
        <p>© {new Date().getFullYear()} Teamix</p>
      </footer>
    </div>
  )
}
