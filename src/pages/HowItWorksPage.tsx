import { Link } from 'react-router-dom'
import './HowItWorksPage.css'

interface HowItWorksPageProps {
  onLogin: () => void
}

export default function HowItWorksPage({ onLogin }: HowItWorksPageProps) {
  return (
    <div className="hiw-page">
      <header className="hiw-header">
        <Link to="/" className="hiw-brand">
          <img src="/fp_logo.png" alt="Teamix" className="hiw-logo" />
          <span>Teamix</span>
        </Link>
        <button className="hiw-header-cta" type="button" onClick={onLogin}>
          Get started
        </button>
      </header>

      <main className="hiw-main">
        <div className="hiw-intro">
          <h1>How Teamix works</h1>
          <p className="hiw-subtitle">
            From signing up to the final whistle — here's how organisers use Teamix
            to run smoother, fairer games every week.
          </p>
        </div>

        <ol className="hiw-steps">
          <li className="hiw-step">
            <div className="hiw-step-number" aria-hidden="true">1</div>
            <div className="hiw-step-content">
              <h2>Create your room</h2>
              <p>
                Sign up and create a <strong>room</strong> for your squad. Give it a name
                (e.g. "Tuesday Night 5-a-side"), choose your sport, and pick your team
                colours. Each room gets a unique invite code that you control.
              </p>
              <p>
                You're the admin. You decide who's in, who can see stats, and how games
                are organised.
              </p>
            </div>
          </li>

          <li className="hiw-step">
            <div className="hiw-step-number" aria-hidden="true">2</div>
            <div className="hiw-step-content">
              <h2>Invite your players</h2>
              <p>
                Share your room's invite link or code with your squad — on WhatsApp, by
                text, or however your group communicates. Players tap the link, sign up
                (or log in), and land straight inside your room.
              </p>
              <p>
                On joining, each player sets their name and picks a starting skill level.
                This seeds their initial rating so the first set of teams is already
                reasonably balanced.
              </p>
            </div>
          </li>

          <li className="hiw-step">
            <div className="hiw-step-number" aria-hidden="true">3</div>
            <div className="hiw-step-content">
              <h2>Schedule a fixture</h2>
              <p>
                Tap <strong>Add fixture</strong> and fill in the date, kick-off time,
                location, and player cap. The fixture appears instantly for every member
                of the room, so no one misses the details.
              </p>
              <p>
                You can schedule multiple games in advance — useful for leagues or regular
                weekly slots. Each fixture tracks its own availability and result
                independently.
              </p>
            </div>
          </li>

          <li className="hiw-step">
            <div className="hiw-step-number" aria-hidden="true">4</div>
            <div className="hiw-step-content">
              <h2>Track availability</h2>
              <p>
                Players mark themselves <strong>In</strong> or <strong>Out</strong> for
                each game from their own devices. You see a live count in real time —
                who's confirmed, who's out, and who hasn't responded yet.
              </p>
              <p>
                No more chasing replies in a group chat. One glance at the fixture tells
                you whether you have enough players or need to send a nudge.
              </p>
            </div>
          </li>

          <li className="hiw-step">
            <div className="hiw-step-number" aria-hidden="true">5</div>
            <div className="hiw-step-content">
              <h2>Pick the teams</h2>
              <p>
                When you're ready to pick, tap <strong>Pick teams</strong>. Teamix reads
                each player's current rating and automatically generates two balanced
                sides — no more "let's give them the three best players to make it fair"
                arguments.
              </p>
              <p>
                Not happy with the split? Swap players between teams with a single tap.
                Once you're satisfied, lock the teams and share them with the group.
              </p>
            </div>
          </li>

          <li className="hiw-step">
            <div className="hiw-step-number" aria-hidden="true">6</div>
            <div className="hiw-step-content">
              <h2>Play and record the result</h2>
              <p>
                After the game, post the final score from the fixture screen. As soon as
                the result is saved, <strong>Player of the Match</strong> voting opens
                automatically — everyone in the room gets to cast their vote.
              </p>
              <p>
                Votes are anonymous and close after 24 hours. The winner gets a badge and
                a boost to their form score heading into the next game.
              </p>
            </div>
          </li>

          <li className="hiw-step">
            <div className="hiw-step-number" aria-hidden="true">7</div>
            <div className="hiw-step-content">
              <h2>Watch the stats grow</h2>
              <p>
                Every game updates the squad's stats automatically. Check the{' '}
                <strong>form table</strong> to see who's in hot form, browse player
                profiles for goal tallies and win rates, and unlock achievements as
                milestones are hit — from first goal to ten-game winning streaks.
              </p>
              <p>
                Ratings adjust after each result too, so the next set of teams is always
                fairer than the last. The more games you play, the smarter the picks get.
              </p>
            </div>
          </li>
        </ol>

        <section className="hiw-cta-section">
          <h2>Ready to organise your first game?</h2>
          <p>
            Set up your room in under two minutes. No spreadsheets, no group-chat
            chaos — just football.
          </p>
          <button className="hiw-cta-button" type="button" onClick={onLogin}>
            Create your room — it's free
          </button>
          <Link to="/" className="hiw-back-link">
            ← Back to home
          </Link>
        </section>
      </main>

      <footer className="hiw-footer">
        <p>&copy; {new Date().getFullYear()} Teamix. All rights reserved.</p>
      </footer>
    </div>
  )
}
