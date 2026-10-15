# Every API has a Swagger interface

Operator ruling, 2026-10-15, for every Shyden Labs project:

> for ALL APIs we build amongst all projects. we must have a fully capable Swagger interface for documenation purposes. this include public and private APIs. but the swagger must be private for a private API, the public cannot be allowed to see it or interact with it, only public is public.

An API is anything the project serves that something else calls: an HTTP route, a serverless or edge function, a callable or cloud function, a webhook receiver. A message between two parts of one program that no outside party can reach (for example a browser extension's own content script and side panel) is not one.

## The four decisions (operator, 2026-10-15)

1. **Try it out.** Public docs on production document every operation, but "Try it out" works there only for operations that change nothing. Operations that write are tried on the dev site's docs.
2. **Private docs.** A private API's spec and its Swagger page are reachable only after the operator signs in (Cloudflare Access for his account, or the project's own admin login). A signed-out request gets neither the page nor the spec, and a test proves it.
3. **One contract.** A hand-written OpenAPI spec per API is the source of truth, and contract tests fail when the real API answers differently from it. Every route, method, field, status, header and error is in the spec; a status the code can return that the spec does not list is a failure. The spec is never generated from the code.
4. **Self-hosted.** Swagger UI comes from the `swagger-ui-dist` npm package (Apache-2.0, the swagger-api project), served from the project's own origin, never a CDN. Adding it is approved for any project with an API.

## What a project does

1. List every API the project serves, read from the code and the deploy config, never from memory.
2. Classify each one public or private. Where it is not obvious, ask the operator.
3. Write its OpenAPI spec (`openapi/<api>.yaml`, OpenAPI 3.1).
4. Contract-test it: call the handlers for every documented case and compare status, headers and body with the spec. Mutation-verify the contract (an undocumented status, a renamed field, a dropped header each go red).
5. Serve the docs: public specs on a public docs page; private specs behind the sign-in, with a test that a signed-out request is refused.
6. File one story per API on the project's board, each with an Estimate.
