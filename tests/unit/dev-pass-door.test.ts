import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { webcrypto } from 'node:crypto';
import { handleDevDoor, PASS_COOKIE, PASS_HEADER, SIGNIN_ORIGIN, SUB_HEADER, type DoorEnv } from '../../scripts/dev-pass/door.ts';
import { mintPass, type PassKind, type SigningKey } from '../../scripts/dev-pass/pass.ts';

/**
 * Each product's `dev.` door (shyden-labs/repo-template#207, spec §4): nothing
 * reaches the origin without a valid DEV pass, and the origin never sees one.
 * The origin is a mock, so its call count proves what got through.
 */

const HOST = 'dev.yaweloidle.com';
const NOW = 1_800_000_000;
const SECRET_HEADER = 'X-Door-Secret';
const SECRET = 'origin-door-secret';

let key: SigningKey;
let env: DoorEnv;
const forward = vi.fn<(request: Request) => Promise<Response>>();

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
  key = { kid: 'k1', privateKey: pair.privateKey };
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  env = { host: HOST, keys: { k1: jwk.x ?? '' }, secretHeader: SECRET_HEADER, secret: SECRET, now: NOW };
});

beforeEach(() => {
  forward.mockReset();
  forward.mockResolvedValue(new Response('origin page', { status: 200 }));
});

const pass = (aud = HOST, kind: PassKind = 'browser', now = NOW) => mintPass({ aud, sub: 'shyden@example.com', kind }, key, now);
const url = (path: string) => `https://${HOST}${path}`;
const door = (request: Request) => handleDevDoor(request, env, forward);
const html = { accept: 'text/html,application/xhtml+xml' };

function accept(body: string, headers: Record<string, string> = {}): Request {
  return new Request(url('/__devpass/accept'), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: SIGNIN_ORIGIN, ...headers },
    body,
  });
}

function forwarded(): Request {
  expect(forward).toHaveBeenCalledTimes(1);
  const request = forward.mock.calls[0]?.[0];
  if (request === undefined) throw new Error('forward got no request');
  return request;
}

async function expectRefusal(response: Response): Promise<void> {
  expect(response.status).toBe(401);
  expect(await response.text()).toBe('');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(forward).not.toHaveBeenCalled();
}

describe('accepting a pass', () => {
  it('sets the pass cookie until the pass expires and sends the person back', async () => {
    const response = await door(accept(new URLSearchParams({ pass: await pass(), back: '/rooms/7?tab=chat' }).toString()));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/rooms/7?tab=chat');
    expect(response.headers.get('set-cookie')).toBe(
      `${PASS_COOKIE}=${await pass()}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`,
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(forward).not.toHaveBeenCalled();
  });

  it('sets Max-Age to the seconds the pass has left', async () => {
    const response = await door(accept(new URLSearchParams({ pass: await pass(HOST, 'browser', NOW - 43_000) }).toString()));
    expect(response.headers.get('set-cookie')).toMatch(/; Max-Age=200$/);
  });

  it('sends the person to the root when back is missing', async () => {
    const response = await door(accept(new URLSearchParams({ pass: await pass() }).toString()));
    expect(response.headers.get('location')).toBe('/');
  });

  it('sends the person to the root when back names another site', async () => {
    const response = await door(accept(new URLSearchParams({ pass: await pass(), back: '//evil.example/' }).toString()));
    expect(response.headers.get('location')).toBe('/');
  });

  it('refuses a pass for another door with an empty 401 and no cookie', async () => {
    const response = await door(accept(new URLSearchParams({ pass: await pass('dev.shytalk.com') }).toString()));
    expect(response.headers.get('set-cookie')).toBeNull();
    await expectRefusal(response);
  });

  it('refuses a good pass posted with no Origin with 403, so another site cannot sign someone in', async () => {
    const request = new Request(url('/__devpass/accept'), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ pass: await pass() }).toString(),
    });
    const response = await door(request);
    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('refuses a good pass posted from another site with 403', async () => {
    const response = await door(accept(new URLSearchParams({ pass: await pass() }).toString(), { origin: 'https://evil.example' }));
    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('refuses a good pass posted with Origin null with 403', async () => {
    const response = await door(accept(new URLSearchParams({ pass: await pass() }).toString(), { origin: 'null' }));
    expect(response.status).toBe(403);
  });

  it('refuses a form with no pass field', async () => {
    await expectRefusal(await door(accept('back=%2F')));
  });

  it('refuses a body over 4 KiB with 413', async () => {
    const response = await door(accept(`pass=${'a'.repeat(4_092)}`));
    expect(response.status).toBe(413);
    expect(forward).not.toHaveBeenCalled();
  });

  it('refuses a declared length over 4 KiB with 413 without reading the body', async () => {
    const unread = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error('the body was read');
      },
    });
    const request = new Request(url('/__devpass/accept'), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': '4097', origin: SIGNIN_ORIGIN },
      body: unread,
      duplex: 'half',
    });
    expect((await door(request)).status).toBe(413);
  });

  it('reads a body of exactly 4 KiB', async () => {
    const response = await door(accept(`pass=${'a'.repeat(4_091)}`));
    expect(response.status).toBe(401);
  });

  it('counts the body in bytes, not characters', async () => {
    const response = await door(accept(`pass=${'é'.repeat(2_046)}`));
    expect(response.status).toBe(413);
  });

  it('refuses an accept with no content type with 415', async () => {
    const response = await door(new Request(url('/__devpass/accept'), { method: 'POST', headers: { origin: SIGNIN_ORIGIN } }));
    expect(response.status).toBe(415);
    expect(forward).not.toHaveBeenCalled();
  });

  it('refuses a content type that only starts like a urlencoded form with 415', async () => {
    const response = await door(
      accept(new URLSearchParams({ pass: await pass() }).toString(), { 'content-type': 'application/x-www-form-urlencodedx' }),
    );
    expect(response.status).toBe(415);
  });

  it('refuses a body that is not a urlencoded form with 415', async () => {
    const response = await door(
      accept(new URLSearchParams({ pass: await pass() }).toString(), { 'content-type': 'multipart/form-data; boundary=x' }),
    );
    expect(response.status).toBe(415);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(forward).not.toHaveBeenCalled();
  });

  it('accepts a urlencoded form whose content type names a charset', async () => {
    const response = await door(
      accept(new URLSearchParams({ pass: await pass() }).toString(), {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      }),
    );
    expect(response.status).toBe(303);
  });

  it('refuses any other method on the accept path with 405', async () => {
    const response = await door(new Request(url('/__devpass/accept'), { headers: html }));
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
    expect(forward).not.toHaveBeenCalled();
  });
});

describe('signing out', () => {
  it('clears the cookie and sends the person to the sign-in signout', async () => {
    const response = await door(new Request(url('/__devpass/signout')));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${SIGNIN_ORIGIN}/signout`);
    expect(response.headers.get('set-cookie')).toBe(`${PASS_COOKIE}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    expect(forward).not.toHaveBeenCalled();
  });
});

describe('a request with no valid pass', () => {
  it('sends a page request to the sign-in, naming this door and the way back', async () => {
    const response = await door(new Request(url('/rooms/7?tab=chat'), { headers: html }));
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`${SIGNIN_ORIGIN}/pass?for=${HOST}&back=%2Frooms%2F7%3Ftab%3Dchat`);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(forward).not.toHaveBeenCalled();
  });

  it('refuses an API request with an empty 401', async () => {
    await expectRefusal(await door(new Request(url('/api/me'), { headers: { accept: 'application/json' } })));
  });

  it('refuses a request with no Accept header with an empty 401', async () => {
    await expectRefusal(await door(new Request(url('/'))));
  });

  it('refuses a WebSocket upgrade with an empty 401 even when it asks for HTML', async () => {
    await expectRefusal(await door(new Request(url('/socket'), { headers: { ...html, upgrade: 'websocket' } })));
  });

  it('refuses a POST asking for HTML with an empty 401', async () => {
    await expectRefusal(await door(new Request(url('/form'), { method: 'POST', headers: html, body: 'x=1' })));
  });

  it('refuses a cookie holding a pass for another door', async () => {
    await expectRefusal(
      await door(new Request(url('/api/me'), { headers: { cookie: `${PASS_COOKIE}=${await pass('dev.shytalk.com')}` } })),
    );
  });

  it('refuses an expired header pass', async () => {
    await expectRefusal(await door(new Request(url('/api/me'), { headers: { [PASS_HEADER]: await pass(HOST, 'machine', NOW - 3_600) } })));
  });

  it('lets the header win over the cookie, even when the cookie is good', async () => {
    const headers = { [PASS_HEADER]: await pass('dev.shytalk.com'), cookie: `${PASS_COOKIE}=${await pass()}` };
    await expectRefusal(await door(new Request(url('/api/me'), { headers })));
  });
});

describe('a request with a valid pass', () => {
  it('forwards a cookie pass to the origin and returns its answer', async () => {
    const response = await door(new Request(url('/rooms/7?tab=chat'), { headers: { ...html, cookie: `${PASS_COOKIE}=${await pass()}` } }));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('origin page');
    expect(forwarded().url).toBe(url('/rooms/7?tab=chat'));
  });

  it('forwards a header pass, with the door secret and the subject, and no pass', async () => {
    await door(new Request(url('/api/me'), { headers: { [PASS_HEADER]: await pass(HOST, 'app') } }));
    const request = forwarded();
    expect(request.headers.get(SECRET_HEADER)).toBe(SECRET);
    expect(request.headers.get(SUB_HEADER)).toBe('shyden@example.com');
    expect(request.headers.get(PASS_HEADER)).toBeNull();
  });

  it('replaces a door secret or subject the caller sent', async () => {
    await door(
      new Request(url('/api/me'), { headers: { [PASS_HEADER]: await pass(), [SECRET_HEADER]: 'guess', [SUB_HEADER]: 'someone-else' } }),
    );
    const request = forwarded();
    expect(request.headers.get(SECRET_HEADER)).toBe(SECRET);
    expect(request.headers.get(SUB_HEADER)).toBe('shyden@example.com');
  });

  it('strips only the pass from the cookies it forwards', async () => {
    await door(new Request(url('/'), { headers: { cookie: `theme=dark; ${PASS_COOKIE}=${await pass()};session=abc` } }));
    expect(forwarded().headers.get('cookie')).toBe('theme=dark; session=abc');
  });

  it('drops the Cookie header when the pass was its only cookie', async () => {
    await door(new Request(url('/'), { headers: { cookie: `${PASS_COOKIE}=${await pass()}` } }));
    expect(forwarded().headers.get('cookie')).toBeNull();
  });

  it('drops the Cookie header when only the pass and empty entries were in it', async () => {
    await door(new Request(url('/'), { headers: { cookie: `${PASS_COOKIE}=${await pass()}; ;` } }));
    expect(forwarded().headers.get('cookie')).toBeNull();
  });

  it('strips a stale pass cookie when a header pass opened the door', async () => {
    await door(new Request(url('/'), { headers: { [PASS_HEADER]: await pass(), cookie: `${PASS_COOKIE}=old; theme=dark` } }));
    expect(forwarded().headers.get('cookie')).toBe('theme=dark');
  });

  it('keeps a cookie whose name only starts with the pass cookie name', async () => {
    await door(new Request(url('/'), { headers: { [PASS_HEADER]: await pass(), cookie: `${PASS_COOKIE}2=keep` } }));
    expect(forwarded().headers.get('cookie')).toBe(`${PASS_COOKIE}2=keep`);
  });

  it('forwards the method and body', async () => {
    await door(new Request(url('/api/rooms'), { method: 'POST', headers: { [PASS_HEADER]: await pass() }, body: '{"name":"a"}' }));
    const request = forwarded();
    expect(request.method).toBe('POST');
    expect(await request.text()).toBe('{"name":"a"}');
  });
});
