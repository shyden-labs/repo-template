import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { webcrypto } from 'node:crypto';
import { CODE_TTL_SECONDS, handleSignin, type AccessCert, type CodeStore, type SigninConfig } from '../../scripts/dev-pass/signin.ts';
import { mintPass, verifyPass, type PassKind, type PublicKeys, type SigningKey } from '../../scripts/dev-pass/pass.ts';

/**
 * The DEV sign-in Worker (shyden-labs/repo-template#207, spec §5), reached only
 * through the `dev-signin.shyden.co.uk` door behind Cloudflare Access. Access's
 * certs endpoint and the KV code store are mocks; the Access JWTs are signed here
 * with a test RSA key, so every check on them is exercised by a crafted token.
 */

const ORIGIN = 'https://dev-signin.shyden.co.uk';
const HOST = 'dev.yaweloidle.com';
const OTHER_HOST = 'dev.shytalk.com';
/** An embed's API, reached from HOST's pages with an embed pass. */
const EMBED_HOST = 'dev-api.shydesk.example';
const APP_LINK = 'com.shyden.yawelo:/devpass';
const NOW = 1_800_000_000;
const ISSUER = 'https://shyden.cloudflareaccess.com';
const AUDIENCE = 'aud-tag-123';
const SECRET_HEADER = 'X-Door-Secret';
const SECRET = 'signin-door-secret';
const EMAIL = 'shyden@example.com';
const RSA = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
const json = (value: unknown): string => b64url(new TextEncoder().encode(JSON.stringify(value)));

let accessKey: webcrypto.CryptoKey;
let strangerKey: webcrypto.CryptoKey;
let cert: AccessCert;
let passKeys: PublicKeys;
let passSigning: SigningKey;
let strangerSigning: SigningKey;
let config: SigninConfig;
let stored: Map<string, string>;
const fetchCerts = vi.fn<() => Promise<readonly AccessCert[]>>();
const codes = {
  get: vi.fn<CodeStore['get']>(),
  put: vi.fn<CodeStore['put']>(),
  delete: vi.fn<CodeStore['delete']>(),
};

beforeAll(async () => {
  const access = await crypto.subtle.generateKey(RSA, true, ['sign', 'verify']);
  accessKey = access.privateKey;
  strangerKey = (await crypto.subtle.generateKey(RSA, true, ['sign', 'verify'])).privateKey;
  cert = { ...(await crypto.subtle.exportKey('jwk', access.publicKey)), kid: 'access-1' };
  const pass = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
  passKeys = { p1: (await crypto.subtle.exportKey('jwk', pass.publicKey)).x ?? '' };
  passSigning = { kid: 'p1', privateKey: pass.privateKey };
  const stranger = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
  strangerSigning = { kid: 'p1', privateKey: stranger.privateKey };
  config = {
    secretHeader: SECRET_HEADER,
    secret: SECRET,
    issuer: ISSUER,
    audience: AUDIENCE,
    fetchCerts,
    hosts: { [HOST]: { appRedirects: [APP_LINK] }, [OTHER_HOST]: { appRedirects: [] } },
    signing: { kid: 'p1', privateKey: pass.privateKey },
    codes,
    embeds: { keys: passKeys, audiences: { [HOST]: [EMBED_HOST] } },
    now: NOW,
  };
});

beforeEach(() => {
  stored = new Map();
  fetchCerts.mockReset();
  fetchCerts.mockResolvedValue([{ ...cert, kid: 'access-0' }, cert]);
  codes.get.mockReset().mockImplementation((key) => Promise.resolve(stored.get(key) ?? null));
  codes.put.mockReset().mockImplementation((key, value) => {
    stored.set(key, value);
    return Promise.resolve();
  });
  codes.delete.mockReset().mockImplementation((key) => {
    stored.delete(key);
    return Promise.resolve();
  });
});

const claims = (overrides: Record<string, unknown> = {}) => ({
  aud: [AUDIENCE],
  iss: ISSUER,
  email: EMAIL,
  iat: NOW,
  exp: NOW + 600,
  ...overrides,
});

async function jwt(
  payload: unknown = claims(),
  options: { header?: Record<string, unknown>; signer?: webcrypto.CryptoKey } = {},
): Promise<string> {
  const head = `${json({ alg: 'RS256', kid: 'access-1', typ: 'JWT', ...options.header })}.${json(payload)}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', options.signer ?? accessKey, new TextEncoder().encode(head));
  return `${head}.${b64url(new Uint8Array(sig))}`;
}

async function call(
  path: string,
  options: { method?: string; token?: string | null; secret?: string | null; body?: string; type?: string } = {},
): Promise<Response> {
  const headers = new Headers();
  const secret = options.secret === undefined ? SECRET : options.secret;
  if (secret !== null) headers.set(SECRET_HEADER, secret);
  const token = options.token === undefined ? await jwt() : options.token;
  if (token !== null) headers.set('Cf-Access-Jwt-Assertion', token);
  if (options.body !== undefined) headers.set('content-type', options.type ?? 'application/x-www-form-urlencoded');
  const init: RequestInit = { method: options.method ?? 'GET', headers };
  if (options.body !== undefined) init.body = options.body;
  return handleSignin(new Request(`${ORIGIN}${path}`, init), config);
}

const query = (params: Record<string, string>) => `?${new URLSearchParams(params).toString()}`;

async function s256(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

const VERIFIER = 'v'.repeat(43);

async function issueCode(): Promise<string> {
  const response = await call(`/app${query({ for: HOST, redirect: APP_LINK, challenge: await s256(VERIFIER), state: 'st' })}`);
  return new URL(response.headers.get('location') ?? '').searchParams.get('code') ?? '';
}

const exchange = (code: string, verifier = VERIFIER) =>
  call('/app/exchange', { method: 'POST', token: null, body: new URLSearchParams({ code, verifier }).toString() });

function expectStatus(response: Response, status: number): void {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('no-store');
}

describe('the door secret', () => {
  it('refuses a request with no door secret before fetching any certs', async () => {
    expectStatus(await call(`/pass${query({ for: HOST })}`, { secret: null }), 401);
    expect(fetchCerts).not.toHaveBeenCalled();
  });

  it('refuses a wrong door secret before fetching any certs', async () => {
    expectStatus(await call(`/pass${query({ for: HOST })}`, { secret: 'guess' }), 401);
    expect(fetchCerts).not.toHaveBeenCalled();
  });

  it('refuses an app exchange with no door secret before reading the code store', async () => {
    expectStatus(await call('/app/exchange', { method: 'POST', token: null, secret: null, body: 'code=a&verifier=b' }), 401);
    expect(codes.get).not.toHaveBeenCalled();
  });
});

describe('the Access JWT', () => {
  const pass = (token: string | null) => call(`/pass${query({ for: HOST })}`, { token });

  it('lets a person with a good token through', async () => {
    expectStatus(await pass(await jwt()), 200);
  });

  it('refuses a request with no token', async () => {
    expectStatus(await pass(null), 401);
  });

  it('refuses a token that is not three parts', async () => {
    expectStatus(await pass((await jwt()).split('.').slice(0, 2).join('.')), 401);
  });

  it('refuses a token of four parts, even when the first three are good', async () => {
    expectStatus(await pass(`${await jwt()}.extra`), 401);
  });

  it('refuses a token whose header is not JSON', async () => {
    const [, payload = '', sig = ''] = (await jwt()).split('.');
    expectStatus(await pass(`bm90IGpzb24.${payload}.${sig}`), 401);
  });

  it('refuses a token whose payload is JSON null', async () => {
    const [header = '', , sig = ''] = (await jwt()).split('.');
    expectStatus(await pass(`${header}.${json(null)}.${sig}`), 401);
  });

  it('refuses a token whose payload is not JSON', async () => {
    const [header = '', , sig = ''] = (await jwt()).split('.');
    expectStatus(await pass(`${header}.bm90IGpzb24.${sig}`), 401);
  });

  for (const alg of ['HS256', 'none', 'RS512']) {
    it(`refuses a token signed with ${alg}`, async () => {
      expectStatus(await pass(await jwt(claims(), { header: { alg } })), 401);
    });
  }

  it('refuses a token whose kid is not in the certs', async () => {
    expectStatus(await pass(await jwt(claims(), { header: { kid: 'access-9' } })), 401);
  });

  it('refuses a token signed by another key under a known kid', async () => {
    expectStatus(await pass(await jwt(claims(), { signer: strangerKey })), 401);
  });

  it('refuses a token whose payload was changed after signing', async () => {
    const [header = '', , sig = ''] = (await jwt()).split('.');
    expectStatus(await pass(`${header}.${json(claims({ email: 'intruder@example.com' }))}.${sig}`), 401);
  });

  it('refuses an audience given as a string, not an array', async () => {
    expectStatus(await pass(await jwt(claims({ aud: AUDIENCE }))), 401);
  });

  it('refuses an audience array without the AUD tag', async () => {
    expectStatus(await pass(await jwt(claims({ aud: ['another-app'] }))), 401);
  });

  it('accepts an audience array holding the AUD tag among others', async () => {
    expectStatus(await pass(await jwt(claims({ aud: ['another-app', AUDIENCE] }))), 200);
  });

  it('refuses another issuer', async () => {
    expectStatus(await pass(await jwt(claims({ iss: 'https://evil.cloudflareaccess.com' }))), 401);
  });

  it('refuses a token at the second it expires', async () => {
    expectStatus(await pass(await jwt(claims({ exp: NOW }))), 401);
  });

  it('accepts a token one second before it expires', async () => {
    expectStatus(await pass(await jwt(claims({ exp: NOW + 1 }))), 200);
  });

  it('refuses a token with no expiry', async () => {
    expectStatus(await pass(await jwt(claims({ exp: undefined }))), 401);
  });

  it('refuses a token not valid for another 61 seconds', async () => {
    expectStatus(await pass(await jwt(claims({ nbf: NOW + 61 }))), 401);
  });

  it('accepts a token valid in 60 seconds', async () => {
    expectStatus(await pass(await jwt(claims({ nbf: NOW + 60 }))), 200);
  });

  it('refuses a not-before that is not a number', async () => {
    expectStatus(await pass(await jwt(claims({ nbf: String(NOW) }))), 401);
  });

  it('refuses a token naming neither an email nor a service token', async () => {
    expectStatus(await pass(await jwt(claims({ email: undefined }))), 401);
  });

  it('refuses a token whose email and common name are both empty', async () => {
    expectStatus(await pass(await jwt(claims({ email: '', common_name: '' }))), 401);
  });

  it('refuses a request whose certs cannot be fetched', async () => {
    fetchCerts.mockRejectedValue(new Error('certs endpoint down'));
    expectStatus(await pass(await jwt()), 401);
  });
});

describe('routes', () => {
  it('answers an unknown path with 404', async () => {
    expectStatus(await call('/admin'), 404);
  });

  it('answers a POST to the pass page with 405', async () => {
    expectStatus(await call(`/pass${query({ for: HOST })}`, { method: 'POST' }), 405);
  });

  it('answers a GET to the machine path with 405', async () => {
    expectStatus(await call(`/machine${query({ for: HOST })}`), 405);
  });

  it('answers a GET to the app exchange with 405', async () => {
    expectStatus(await call('/app/exchange', { token: null }), 405);
  });

  it('answers a POST to the app page with 405', async () => {
    expectStatus(await call('/app', { method: 'POST' }), 405);
  });

  it('answers a POST to signout with 405', async () => {
    expectStatus(await call('/signout', { method: 'POST' }), 405);
  });

  it('refuses an unknown path without a token as 401, before saying it is unknown', async () => {
    expectStatus(await call('/admin', { token: null }), 401);
  });

  it('sends signout to the Access logout', async () => {
    const response = await call('/signout');
    expectStatus(response, 302);
    expect(response.headers.get('location')).toBe('/cdn-cgi/access/logout');
  });
});

describe('the browser pass page', () => {
  async function page(params: Record<string, string>): Promise<{ response: Response; body: string }> {
    const response = await call(`/pass${query(params)}`);
    return { response, body: await response.text() };
  }

  const field = (body: string, name: string) => body.match(new RegExp(`name="${name}" value="([^"]*)"`))?.[1];

  it('posts a 12-hour browser pass for the person to the door, from a no-store HTML page whose Referer holds only its origin', async () => {
    const { response, body } = await page({ for: HOST, back: '/rooms/7' });
    expectStatus(response, 200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('referrer-policy')).toBe('origin');
    expect(body).toContain(`<form method="post" action="https://${HOST}/__devpass/accept">`);
    expect(await verifyPass(field(body, 'pass'), { host: HOST, keys: passKeys, now: NOW })).toEqual({
      ok: true,
      sub: EMAIL,
      kind: 'browser',
      exp: NOW + 43_200,
    });
    expect(field(body, 'back')).toBe('/rooms/7');
  });

  it('submits itself, with a button for browsers without JavaScript', async () => {
    const { body } = await page({ for: HOST });
    expect(body).toContain('<button type="submit">');
    expect(body).toContain('document.forms[0].submit()');
  });

  it('sends the person to the root when back is missing', async () => {
    expect(field((await page({ for: HOST })).body, 'back')).toBe('/');
  });

  it('sends the person to the root when back names another site', async () => {
    expect(field((await page({ for: HOST, back: '//evil.example' })).body, 'back')).toBe('/');
  });

  it('escapes back in the page', async () => {
    const { body } = await page({ for: HOST, back: `/a?x="><script>&y='` });
    expect(field(body, 'back')).toBe('/a?x=&quot;&gt;&lt;script&gt;&amp;y=&#39;');
    expect(body).not.toContain('"><script>');
  });

  it('mints a pass for a service token under its common name', async () => {
    const { body } = await (async () => {
      const response = await call(`/pass${query({ for: HOST })}`, { token: await jwt(claims({ email: '', common_name: 'ci-runner' })) });
      return { body: await response.text() };
    })();
    expect(await verifyPass(field(body, 'pass'), { host: HOST, keys: passKeys, now: NOW })).toMatchObject({ ok: true, sub: 'ci-runner' });
  });

  for (const host of ['dev.evil.example', 'toString', '__proto__']) {
    it(`refuses to mint for ${host}, which is not in the host map`, async () => {
      expectStatus((await page({ for: host })).response, 400);
    });
  }

  it('refuses a request naming no host', async () => {
    expectStatus((await page({})).response, 400);
  });
});

describe('the app sign-in', () => {
  const app = async (overrides: Record<string, string | undefined> = {}) => {
    const params = new URLSearchParams({ for: HOST, redirect: APP_LINK, challenge: await s256(VERIFIER), state: 'st' });
    for (const [name, value] of Object.entries(overrides)) {
      if (value === undefined) params.delete(name);
      else params.set(name, value);
    }
    return call(`/app?${params.toString()}`);
  };

  it('keeps codes for two minutes', () => {
    expect(CODE_TTL_SECONDS).toBe(120);
  });

  it('stores a one-use code for two minutes and sends it to the app link with the state', async () => {
    const response = await app();
    expectStatus(response, 302);
    const location = new URL(response.headers.get('location') ?? '');
    expect(`${location.protocol}${location.pathname}`).toBe(APP_LINK);
    expect(location.searchParams.get('state')).toBe('st');
    const code = location.searchParams.get('code') ?? '';
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(codes.put).toHaveBeenCalledTimes(1);
    const [key, value, options] = codes.put.mock.calls[0] ?? [];
    expect(key).toContain(code);
    expect(JSON.parse(value ?? '')).toEqual({ for: HOST, challenge: await s256(VERIFIER), sub: EMAIL });
    expect(options).toEqual({ expirationTtl: 120 });
  });

  it('gives a new code each time', async () => {
    const first = await issueCode();
    expect(await issueCode()).not.toBe(first);
  });

  it('refuses an app link the host does not list', async () => {
    expectStatus(await app({ redirect: 'com.evil:/devpass' }), 400);
  });

  it('refuses an app link that only starts with a listed one', async () => {
    expectStatus(await app({ redirect: `${APP_LINK}/more` }), 400);
  });

  it('refuses a missing app link', async () => {
    expectStatus(await app({ redirect: undefined }), 400);
  });

  it('refuses a listed app link for another host', async () => {
    expectStatus(await app({ for: OTHER_HOST }), 400);
  });

  it('refuses a host not in the map', async () => {
    expectStatus(await app({ for: 'toString' }), 400);
  });

  it('refuses a challenge of 42 characters', async () => {
    expectStatus(await app({ challenge: 'a'.repeat(42) }), 400);
  });

  it('refuses a challenge of 44 characters', async () => {
    expectStatus(await app({ challenge: 'a'.repeat(44) }), 400);
  });

  it('refuses a challenge that is not base64url', async () => {
    expectStatus(await app({ challenge: `${'a'.repeat(42)}+` }), 400);
  });

  it('refuses a missing challenge', async () => {
    expectStatus(await app({ challenge: undefined }), 400);
  });

  it('refuses an empty state', async () => {
    expectStatus(await app({ state: '' }), 400);
  });

  it('refuses a missing state', async () => {
    expectStatus(await app({ state: undefined }), 400);
  });

  it('stores nothing for a refused request', async () => {
    await app({ state: '' });
    expect(codes.put).not.toHaveBeenCalled();
  });
});

describe('the app exchange', () => {
  it('trades a code and its verifier for a 12-hour app pass, without an Access token', async () => {
    const code = await issueCode();
    fetchCerts.mockClear();
    const response = await exchange(code);
    expectStatus(response, 200);
    expect(response.headers.get('content-type')).toBe('application/json');
    const { pass } = (await response.json()) as { pass: string };
    expect(await verifyPass(pass, { host: HOST, keys: passKeys, now: NOW })).toEqual({
      ok: true,
      sub: EMAIL,
      kind: 'app',
      exp: NOW + 43_200,
    });
    expect(fetchCerts).not.toHaveBeenCalled();
  });

  it('burns the code once it is used', async () => {
    const code = await issueCode();
    await exchange(code);
    expectStatus(await exchange(code), 401);
  });

  it('burns the code on a wrong verifier, so one wrong guess ends it', async () => {
    const code = await issueCode();
    expectStatus(await exchange(code, 'w'.repeat(43)), 401);
    expectStatus(await exchange(code), 401);
  });

  it('deletes the code before checking the verifier', async () => {
    const code = await issueCode();
    await exchange(code, 'w'.repeat(43));
    expect(codes.delete).toHaveBeenCalledTimes(1);
    expect(codes.delete.mock.calls[0]?.[0]).toContain(code);
  });

  it('refuses an unknown code', async () => {
    expectStatus(await exchange('unknown'), 401);
  });

  it('refuses a missing code without reading the store', async () => {
    expectStatus(await call('/app/exchange', { method: 'POST', token: null, body: `verifier=${VERIFIER}` }), 401);
    expect(codes.get).not.toHaveBeenCalled();
  });

  it('refuses a missing verifier', async () => {
    const code = await issueCode();
    expectStatus(await call('/app/exchange', { method: 'POST', token: null, body: `code=${code}` }), 401);
  });

  it('refuses a missing verifier even when the challenge is the hash of "null"', async () => {
    const issued = await call(`/app${query({ for: HOST, redirect: APP_LINK, challenge: await s256('null'), state: 'st' })}`);
    const code = new URL(issued.headers.get('location') ?? '').searchParams.get('code') ?? '';
    expectStatus(await call('/app/exchange', { method: 'POST', token: null, body: `code=${code}` }), 401);
  });

  it('refuses a body over 4 KiB with 413', async () => {
    expectStatus(await call('/app/exchange', { method: 'POST', token: null, body: `code=${'a'.repeat(4_092)}` }), 413);
  });

  it('refuses a body that is not a urlencoded form with 415', async () => {
    expectStatus(await call('/app/exchange', { method: 'POST', token: null, body: '{"code":"a"}', type: 'application/json' }), 415);
  });
});

describe('the machine pass', () => {
  const machine = async (token: string, host = HOST) => call(`/machine${query({ for: host })}`, { method: 'POST', token });

  it('gives a service token a 1-hour machine pass under its common name', async () => {
    const response = await machine(await jwt(claims({ email: '', common_name: 'mac-mini' })));
    expectStatus(response, 200);
    expect(response.headers.get('content-type')).toBe('application/json');
    const { pass } = (await response.json()) as { pass: string };
    expect(await verifyPass(pass, { host: HOST, keys: passKeys, now: NOW })).toEqual({
      ok: true,
      sub: 'mac-mini',
      kind: 'machine',
      exp: NOW + 3_600,
    });
  });

  it('refuses a person with 403', async () => {
    expectStatus(await machine(await jwt()), 403);
  });

  it('refuses a person even for an unknown host, before naming the host', async () => {
    expectStatus(await machine(await jwt(), 'dev.evil.example'), 403);
  });

  it('refuses a host not in the map', async () => {
    expectStatus(await machine(await jwt(claims({ email: undefined, common_name: 'mac-mini' })), 'dev.evil.example'), 400);
  });
});

describe('the embed pass', () => {
  const doorPass = (options: { aud?: string; kind?: PassKind; now?: number; signing?: SigningKey } = {}) =>
    mintPass({ aud: options.aud ?? HOST, sub: EMAIL, kind: options.kind ?? 'browser' }, options.signing ?? passSigning, options.now ?? NOW);
  const embed = (body: Record<string, string>, secret: string | null = SECRET) =>
    call('/embed', { method: 'POST', token: null, secret, body: new URLSearchParams(body).toString() });

  it("swaps a door's pass, with no Access token, for a 5-minute embed pass to an audience listed for that door", async () => {
    const response = await embed({ pass: await doorPass(), for: EMBED_HOST });
    expectStatus(response, 200);
    expect(response.headers.get('content-type')).toBe('application/json');
    const { pass } = (await response.json()) as { pass: string };
    expect(await verifyPass(pass, { host: EMBED_HOST, keys: passKeys, now: NOW })).toEqual({
      ok: true,
      sub: EMAIL,
      kind: 'embed',
      exp: NOW + 300,
    });
  });

  it('refuses a call without the door secret', async () => {
    expectStatus(await embed({ pass: await doorPass(), for: EMBED_HOST }, null), 401);
  });

  it('refuses a call with no pass', async () => {
    expectStatus(await embed({ for: EMBED_HOST }), 401);
  });

  it('refuses an expired pass', async () => {
    expectStatus(await embed({ pass: await doorPass({ now: NOW - 43_200 }), for: EMBED_HOST }), 401);
  });

  it('refuses a forged pass', async () => {
    expectStatus(await embed({ pass: await doorPass({ signing: strangerSigning }), for: EMBED_HOST }), 401);
  });

  it('refuses a pass for a door that does not list the audience', async () => {
    expectStatus(await embed({ pass: await doorPass({ aud: OTHER_HOST }), for: EMBED_HOST }), 401);
  });

  it('refuses an audience not listed for the door', async () => {
    expectStatus(await embed({ pass: await doorPass(), for: OTHER_HOST }), 401);
  });

  it('refuses an inherited property name as a door', async () => {
    expectStatus(await embed({ pass: await doorPass({ aud: 'constructor' }), for: EMBED_HOST }), 401);
  });

  it('refuses to swap an embed pass for another', async () => {
    expectStatus(await embed({ pass: await doorPass({ kind: 'embed' }), for: EMBED_HOST }), 401);
  });

  it('refuses a GET with 405', async () => {
    const response = await call(`/embed${query({ for: EMBED_HOST })}`, { token: null });
    expectStatus(response, 405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('refuses a body that is not a form with 415', async () => {
    expectStatus(await call('/embed', { method: 'POST', token: null, body: '{"pass":"a"}', type: 'application/json' }), 415);
  });

  it('is not found where no embeds are configured', async () => {
    const { embeds: _embeds, ...plain } = config;
    const request = new Request(`${ORIGIN}/embed`, {
      method: 'POST',
      headers: { [SECRET_HEADER]: SECRET, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ pass: await doorPass(), for: EMBED_HOST }).toString(),
    });
    expectStatus(await handleSignin(request, plain), 404);
  });
});
