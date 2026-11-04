// "Session expired mid-stream" handler shared by fetch-based SSE consumers
// (chat + dashboard). These bypass api.ts's central request() (they need raw
// response.body), so they also bypass its 401 handling — replicate it here:
// a 401 means the sso_session expired, so clear the local user and bounce to the
// SSO login. 403 is NOT a session problem (re-auth won't help) and is left to
// each caller to surface as a friendly message.
import { redirectToSsoLogin } from "@/lib/sso";

export async function handleUnauthorized(): Promise<void> {
  try { (await import("@/stores/auth")).useAuth.getState().setUser(null); } catch { /* circular import safety */ }
  redirectToSsoLogin();
}
