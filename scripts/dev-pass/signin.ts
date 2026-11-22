// The DEV sign-in Worker's rules (shyden-labs/repo-template#207, spec §5). It sits
// on workers.dev, reached only through the `dev-signin.shyden.co.uk` door behind
// Cloudflare Access, and mints DEV passes for the hosts in its map. The Worker entry
// (env wiring, the certs cache, the clock) is shyden.co.uk's, where it is deployed.
// The type import is erased: it only names WebCrypto's types, as the template has no DOM lib.
import type { webcrypto } from 'node:crypto';
import { readForm } from './form.ts';
import { CLOCK_SKEW_SECONDS, fromBase64url, mintPass, safeBack, toBase64url, type PassKind, type SigningKey } from './pass.ts';

/** One of Access's signing keys, from `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`. */
export type AccessCert = webcrypto.JsonWebKey & { readonly kid: string };
/** The slice of a Workers KV namespace the app codes need. */
export interface CodeStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options: { expirationTtl: number }): Promise<void>;
  delete(key: string): Promise<void>;
}
export interface SigninConfig {
  /** The door secret the `dev-signin` door adds; checked before anything else is read. */
  readonly secretHeader: string;
  readonly secret: string;
  /** `https://<team>.cloudflareaccess.com`. */
  readonly issuer: string;
  /** The Access application's AUD tag. */
  readonly audience: string;
  readonly fetchCerts: () => Promise<readonly AccessCert[]>;
  /** Every host a pass may be minted for, with the app links its apps may be sent back to. */
  readonly hosts: Readonly<Record<string, { readonly appRedirects: readonly string[] }>>;
  readonly signing: SigningKey;
  readonly codes: CodeStore;
  /** Seconds since the epoch. */
  readonly now: number;
}

export const CODE_TTL_SECONDS = 120;
const CODE_PREFIX = 'app-code:';
const JWT_HEADER = 'Cf-Access-Jwt-Assertion';
const RS256 = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
const encoder = new TextEncoder();

type Identity = { readonly person: boolean; readonly sub: string };

function reply(status: number, headers: Record<string, string> = {}, body: string | null = null): Response {
  return new Response(body, { status, headers: { 'cache-control': 'no-store', ...headers } });
}

const passReply = (pass: string) => reply(200, { 'content-type': 'application/json' }, JSON.stringify({ pass }));

function decodeJson(part: string): Record<string, unknown> | undefined {
  const value: unknown = JSON.parse(new TextDecoder().decode(fromBase64url(part)));
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** Who Access let in: a person (email) or a service token (common name); undefined for anything else. */
async function accessIdentity(token: string | null, config: SigninConfig): Promise<Identity | undefined> {
  const parts = (token ?? '').split('.');
  if (parts.length !== 3) return undefined;
  const [header, body, sig] = parts as [string, string, string];
  try {
    const head = decodeJson(header);
    const claims = decodeJson(body);
    if (head?.['alg'] !== 'RS256' || claims === undefined) return undefined;
    const cert = (await config.fetchCerts()).find((candidate) => candidate.kid === head['kid']);
    if (cert === undefined) return undefined;
    const key = await crypto.subtle.importKey('jwk', cert, RS256, false, ['verify']);
    if (!(await crypto.subtle.verify(RS256, key, fromBase64url(sig), encoder.encode(`${header}.${body}`)))) return undefined;
    const { aud, iss, exp, nbf, email, common_name: commonName } = claims;
    if (!Array.isArray(aud) || !aud.includes(config.audience) || iss !== config.issuer) return undefined;
    if (typeof exp !== 'number' || exp <= config.now) return undefined;
    if (nbf !== undefined && (typeof nbf !== 'number' || nbf > config.now + CLOCK_SKEW_SECONDS)) return undefined;
    if (nonEmpty(email)) return { person: true, sub: email };
    if (nonEmpty(commonName)) return { person: false, sub: commonName };
    return undefined;
  } catch {
    return undefined;
  }
}

const knownHost = (config: SigninConfig, host: string | null): host is string => host !== null && Object.hasOwn(config.hosts, host);

const mint = (config: SigninConfig, aud: string, sub: string, kind: PassKind) => mintPass({ aud, sub, kind }, config.signing, config.now);

const escapeHtml = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll("'", '&#39;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

async function s256(verifier: string): Promise<string> {
  return toBase64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))));
}

/**
 * A page that posts a browser pass to the door, so the pass never sits in a URL, history, log
 * or Referer. `Referrer-Policy: origin` keeps the post's Origin header, which the door checks
 * (under `no-referrer` a browser sends `Origin: null`).
 */
async function passPage(url: URL, identity: Identity, config: SigninConfig): Promise<Response> {
  const host = url.searchParams.get('for');
  if (!knownHost(config, host)) return reply(400);
  const pass = await mint(config, host, identity.sub, 'browser');
  const back = safeBack(url.searchParams.get('back'));
  const page = [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Signing in</title></head><body>',
    `<form method="post" action="https://${escapeHtml(host)}/__devpass/accept">`,
    `<input type="hidden" name="pass" value="${escapeHtml(pass)}">`,
    `<input type="hidden" name="back" value="${escapeHtml(back)}">`,
    '<button type="submit">Continue</button></form>',
    '<script>document.forms[0].submit()</script></body></html>',
  ].join('');
  return reply(200, { 'content-type': 'text/html; charset=utf-8', 'referrer-policy': 'origin' }, page);
}

/** RFC 8252 with PKCE: a one-use code for the app, sent to one of its host's listed app links. */
async function appCode(url: URL, identity: Identity, config: SigninConfig): Promise<Response> {
  const host = url.searchParams.get('for');
  const redirect = url.searchParams.get('redirect');
  const challenge = url.searchParams.get('challenge') ?? '';
  const state = url.searchParams.get('state') ?? '';
  if (!knownHost(config, host) || redirect === null || !config.hosts[host]?.appRedirects.includes(redirect)) return reply(400);
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge) || state === '') return reply(400);
  const code = toBase64url(crypto.getRandomValues(new Uint8Array(32)));
  await config.codes.put(CODE_PREFIX + code, JSON.stringify({ for: host, challenge, sub: identity.sub }), {
    expirationTtl: CODE_TTL_SECONDS,
  });
  const location = new URL(redirect);
  location.searchParams.set('code', code);
  location.searchParams.set('state', state);
  return reply(302, { location: location.toString() });
}

async function appExchange(request: Request, config: SigninConfig): Promise<Response> {
  const form = await readForm(request);
  if (typeof form === 'number') return reply(form);
  const code = form.get('code');
  if (code === null) return reply(401);
  const stored = await config.codes.get(CODE_PREFIX + code);
  if (stored === null) return reply(401);
  // Burnt before the verifier is checked, so a wrong guess ends the code.
  await config.codes.delete(CODE_PREFIX + code);
  const grant = JSON.parse(stored) as { for: string; challenge: string; sub: string };
  const verifier = form.get('verifier');
  if (verifier === null || (await s256(verifier)) !== grant.challenge) return reply(401);
  return passReply(await mint(config, grant.for, grant.sub, 'app'));
}

async function machinePass(url: URL, identity: Identity, config: SigninConfig): Promise<Response> {
  if (identity.person) return reply(403);
  const host = url.searchParams.get('for');
  if (!knownHost(config, host)) return reply(400);
  return passReply(await mint(config, host, identity.sub, 'machine'));
}

const ROUTES: Readonly<
  Record<string, { method: string; handle: (url: URL, identity: Identity, config: SigninConfig) => Promise<Response> }>
> = {
  '/pass': { method: 'GET', handle: passPage },
  '/app': { method: 'GET', handle: appCode },
  '/machine': { method: 'POST', handle: machinePass },
  '/signout': { method: 'GET', handle: () => Promise.resolve(reply(302, { location: '/cdn-cgi/access/logout' })) },
};

export async function handleSignin(request: Request, config: SigninConfig): Promise<Response> {
  if (request.headers.get(config.secretHeader) !== config.secret) return reply(401);
  const url = new URL(request.url);
  // The app holds no Access cookie, so Access bypasses this one path; PKCE guards it.
  if (url.pathname === '/app/exchange') return request.method === 'POST' ? appExchange(request, config) : reply(405, { allow: 'POST' });

  const identity = await accessIdentity(request.headers.get(JWT_HEADER), config);
  if (identity === undefined) return reply(401);
  // A pathname starts with `/`, so it never names an inherited property.
  const route = ROUTES[url.pathname];
  if (route === undefined) return reply(404);
  if (request.method !== route.method) return reply(405, { allow: route.method });
  return route.handle(url, identity, config);
}
