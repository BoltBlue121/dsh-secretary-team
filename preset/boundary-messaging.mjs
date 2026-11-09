// Boundary for the secretary and leader presets (v2.6): identical to
// `boundary.mjs`, except the standard subagent-control `send_message` /
// `interrupt_agent` calls ({ agent_id }) pass, so a secretary can keep talking
// to the leader it started, and a leader can report back to its secretary.
// Lineage authorization stays in `ctx.subagents` (direct child / direct parent).
import { createBoundary } from './boundary.mjs'

export const name = 'secretary-team-boundary-messaging'
export const inject = ['tools', 'systemPrompt']
export const apply = createBoundary({ adjacentMessaging: true })
