// These types come from @cloudflare/workers-types in tsconfig.worker.json.
// For the Node-side tsconfig, declare them as opaque to avoid errors.
declare global {
  interface D1Database {}
  interface DurableObjectNamespace {}
}

export interface Env {
  DB: D1Database;
  GAME_ROOM: DurableObjectNamespace;
}
