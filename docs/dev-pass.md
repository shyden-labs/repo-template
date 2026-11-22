# The DEV pass (issue shyden-labs/repo-template#207)

Every product's DEV site sits behind a DEV pass. TEST has no gate. Nothing
from a `dev.` origin reaches anyone who lacks a valid pass. One sign-in at
`dev-signin.shyden.co.uk` covers every product's DEV. No build holds a shared
secret.

| Part | Lives in | Holds |
| --- | --- | --- |
| `scripts/dev-pass/pass.ts` | every door and the sign-in Worker | `mintPass`, `verifyPass` and `safeBack`. A pass is `v1.<kid>.<payload>.<sig>`, Ed25519-signed, bound to one door by `aud`. Browser and app passes last 12 h, machine passes 1 h. |
| `scripts/dev-pass/door.ts` | each product's `dev.` door Worker | `handleDevDoor(request, env, forward)`: accepts a pass into an HttpOnly `__Host-devpass` cookie, or reads it from `X-Dev-Pass`. It forwards to the origin only on a valid pass, and strips the pass before forwarding. |
| `scripts/dev-pass/signin.ts` | the sign-in Worker (shyden.co.uk's TEST+DEV account, reached only through its door) | `handleSignin(request, config)`: `/pass` for browsers, `/app` and `/app/exchange` for apps (PKCE), `/machine` for service tokens, and `/signout`. |
| `scripts/dev-pass/form.ts` | both | reads a urlencoded form of at most 4 KiB. |

People never open a `workers.dev` address, because Indonesia blocks it. Only
the doors call one, server to server.

## One-time setup (Shyden, in Cloudflare)

1. **Keys.** Generate one Ed25519 key pair on the Mac:

   ```sh
   node --input-type=module -e "const k = await crypto.subtle.generateKey('Ed25519', true, ['sign','verify']); console.log(JSON.stringify({ private: await crypto.subtle.exportKey('jwk', k.privateKey), x: (await crypto.subtle.exportKey('jwk', k.publicKey)).x }))"
   ```

   Store the private JWK as a secret on the sign-in Worker (`wrangler secret
   put DEV_PASS_PRIVATE_JWK`) and never anywhere else. Pick a `kid`, for
   example `2026-11`. The public `x` goes to every door as a plain variable.
2. **Access application.** In the shyden.co.uk PROD account, go to Zero Trust
   → Access → Applications. Add a self-hosted application on
   `dev-signin.shyden.co.uk`, with these policies:
   - **Allow** (people): the allowed emails, using the one-time PIN and GitHub
     login methods.
   - **Service Auth**: one service token per machine (each CI environment and
     the Mac). Name each after its machine.
3. **Bypass for the app exchange.** Add a second self-hosted application on
   `dev-signin.shyden.co.uk/app/exchange` with a single **Bypass** policy for
   everyone. The app holds no Access cookie there; PKCE guards that path.
   This is Cloudflare's documented pattern for one public endpoint (its
   OAuth-callback example). The docs do not say which application wins where
   paths overlap, so measure both before relying on it: `/app/exchange` with
   no Access cookie reaches the Worker, and `/pass` with none gets the Access
   login.
4. **Read back two values** into the sign-in Worker's variables: the team
   domain (`https://<team>.cloudflareaccess.com`, under Zero Trust →
   Settings) and the AUD tag of the application from step 2 (on its
   overview). The Worker entry fetches and caches
   `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`.
5. **Door secret.** The `dev-signin` door Worker forwards to the sign-in
   Worker's `workers.dev` address with a door secret header. The same value
   is set as the sign-in Worker's secret.

## Adopting it in a product

1. The product's `dev.` door Worker imports `handleDevDoor` and builds `env`
   from its variables: `host` (its own `dev.` host), `keys` (`{ "<kid>": "<x>" }`),
   the origin's door secret header and value, and `now` in seconds. Its
   `forward` fetches the origin.
2. The product's host goes into the sign-in Worker's host map with its app
   links (`appRedirects`). The map has no other route in.
3. Apps (DEV builds only, behind a compile-time flag): open `/app` with
   `ASWebAuthenticationSession` on iOS (`prefersEphemeralWebBrowserSession =
   false`) or Custom Tabs on Android. Catch the redirect, call
   `/app/exchange`, keep the pass in Keychain or EncryptedSharedPreferences,
   and send it as `X-Dev-Pass`. A `401` from the door means: sign in again.
4. Machines call `POST /machine?for=<host>` with their service token's
   `CF-Access-Client-Id` and `CF-Access-Client-Secret`, and hand the pass to the app
   at launch. The pass's `sub` is the token's `common_name`, which Cloudflare
   documents as the token's Client ID ([application token](https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/application-token/)).
5. CI and automated API tests keep calling the origin's `workers.dev`
   directly with its door secret. Passes are only for what must go through a
   door.
6. `test.` doors forward with no check.

## Key rotation

Add the new `kid` → `x` to every door. Then switch the sign-in Worker to sign
with the new key, wait 12 hours, and remove the old key. To revoke every pass
at once, rotate with no overlap.

## Known limits

- **A pass is a bearer token.** It is HttpOnly, short-lived and bound to one
  door, and no build holds it. Malware on a signed-in person's own machine can
  still copy it. Nothing on Cloudflare Free does better.
- **Login CSRF.** Someone with their own pass could POST it to another
  person's door. That would only sign the victim into DEV as the sender, and
  getting a pass at all needs an allowed sign-in. Accepted.
- **App codes in KV.** KV is eventually consistent, so two exchanges racing
  in different locations could both read a code before its delete lands.
  Both would still need the verifier, which only the app holds. Accepted. A
  Durable Object would close it, but that is not worth it for DEV.
