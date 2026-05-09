import mixpanel from 'mixpanel-browser'

const token = import.meta.env.VITE_MIXPANEL_TOKEN as string | undefined

if (token) {
  mixpanel.init(token, {
    persistence: 'localStorage',
    track_pageview: false,
    ignore_dnt: false,
  })
}

export function identify(userId: string, traits: Record<string, unknown>) {
  if (!token) return
  mixpanel.identify(userId)
  mixpanel.people.set(traits)
}

export function track(event: string, properties?: Record<string, unknown>) {
  if (!token) return
  mixpanel.track(event, properties)
}

export function resetIdentity() {
  if (!token) return
  mixpanel.reset()
}
