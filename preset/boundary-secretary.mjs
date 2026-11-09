// Boundary for the secretary presets (v2.6): the messaging boundary, limited to
// the leaders this secretary started. A Claude CLI leader's native workers have
// the secretary as their DSH parent, so without this limit the secretary could
// steer a write-capable worker or the verifier directly (v2.6 review finding 1).
import { createBoundary } from './boundary.mjs'

export const name = 'secretary-team-boundary-secretary'
export const inject = ['tools', 'systemPrompt']
export const apply = createBoundary({ adjacentMessaging: true, leaderTargetsOnly: true })
