// Each product's `dev.` door (shyden-labs/repo-template#207, spec §4): nothing from
// the DEV origin reaches anyone without a valid DEV pass, and the origin never sees
// a pass. The product's door Worker builds `env` and passes its own `forward`
// (a fetch to the origin); this file holds only the rules, so they are tested here.
import { readForm } from './form.ts';
import { safeBack, verifyPass, type PublicKeys } from './pass.ts';

export const SIGNIN_ORIGIN = 'https://dev-signin.shyden.co.uk';
export const PASS_COOKIE = '__Host-devpass';
/** Apps and machines send the pass here; it wins over the cookie. */
export const PASS_HEADER = 'X-Dev-Pass';
/** Who the pass belongs to, for the origin's logs. */
export const SUB_HEADER = 'X-Dev-Pass-Sub';

const ACCEPT_PATH = '/__devpass/accept';
const SIGNOUT_PATH = '/__devpass/signout';
const COOKIE_ATTRIBUTES = 'Secure; HttpOnly; SameSite=Lax; Path=/';

export interface DoorEnv {
  /** This door's own host name, which every pass it opens must name as `aud`. */
  readonly host: string;
  readonly keys: PublicKeys;
  /** The origin's door secret, added to every forwarded request. */
  readonly secretHeader: string;
  readonly secret: string;
  /** Seconds since the epoch. */
  readonly now: number;
}

function reply(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { 'cache-control': 'no-store', ...headers } });
}

function withoutPassCookie(cookie: string | null): string | undefined {
  if (cookie === null) return undefined;
  const kept = cookie
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '' && entry.split('=', 1)[0] !== PASS_COOKIE);
  return kept.length === 0 ? undefined : kept.join('; ');
}

function passCookie(cookie: string | null): string | undefined {
  for (const entry of (cookie ?? '').split(';')) {
    const [name, ...value] = entry.trim().split('=');
    if (name === PASS_COOKIE) return value.join('=');
  }
  return undefined;
}

async function acceptPass(request: Request, env: DoorEnv): Promise<Response> {
  if (request.method !== 'POST') return reply(405, { allow: 'POST' });
  const form = await readForm(request);
  if (typeof form === 'number') return reply(form);
  const pass = form.get('pass');
  if (pass === null) return reply(401);
  const check = await verifyPass(pass, { host: env.host, keys: env.keys, now: env.now });
  if (!check.ok) return reply(401);
  return reply(303, {
    location: safeBack(form.get('back')),
    'set-cookie': `${PASS_COOKIE}=${pass}; ${COOKIE_ATTRIBUTES}; Max-Age=${check.exp - env.now}`,
  });
}

function wantsPage(request: Request): boolean {
  return request.method === 'GET' && request.headers.get('upgrade') === null && (request.headers.get('accept') ?? '').includes('text/html');
}

export async function handleDevDoor(request: Request, env: DoorEnv, forward: (request: Request) => Promise<Response>): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === ACCEPT_PATH) return acceptPass(request, env);
  if (url.pathname === SIGNOUT_PATH) {
    return reply(303, { location: `${SIGNIN_ORIGIN}/signout`, 'set-cookie': `${PASS_COOKIE}=; ${COOKIE_ATTRIBUTES}; Max-Age=0` });
  }

  const pass = request.headers.get(PASS_HEADER) ?? passCookie(request.headers.get('cookie'));
  const check = await verifyPass(pass, { host: env.host, keys: env.keys, now: env.now });
  if (!check.ok) {
    if (!wantsPage(request)) return reply(401);
    const signin = new URL('/pass', SIGNIN_ORIGIN);
    signin.search = new URLSearchParams({ for: env.host, back: url.pathname + url.search }).toString();
    return reply(302, { location: signin.toString() });
  }

  const headers = new Headers(request.headers);
  headers.delete(PASS_HEADER);
  const cookie = withoutPassCookie(headers.get('cookie'));
  if (cookie === undefined) headers.delete('cookie');
  else headers.set('cookie', cookie);
  headers.set(env.secretHeader, env.secret);
  headers.set(SUB_HEADER, check.sub);
  return forward(new Request(request, { headers }));
}
