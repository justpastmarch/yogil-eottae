# Roadview renderer

Private Node service that captures the native Naver Panorama SDK in an isolated Playwright browser. The application page uses `publicMapConfig().clientId` directly, independently of AI and walking configuration. The renderer stays on `/internal/roadview` and captures the SDK scene with its native Naver attribution. It does not navigate a consumer map site or use Kakao imagery. Images stay in memory; browser profiles, cookies, traces, videos, and screenshots are not reused or deliberately saved.

## Runtime configuration

The service requires Node 22+ and a browser. Dependencies install with `npm ci`. `ROADVIEW_BROWSER_CHANNEL=chrome` selects installed Google Chrome on macOS. Without a channel, Playwright uses its Chromium installation from `npx playwright install chromium`. The supplied Dockerfile uses a browser image that matches the pinned Playwright version.

| Variable | Meaning |
| --- | --- |
| `ROADVIEW_RENDERER_TOKEN` | Required bearer secret, at least 24 characters. |
| `ROADVIEW_APP_ORIGIN` | Application origin, defaults to `http://localhost:3000`. HTTPS required except localhost, 127.0.0.1, or ::1. Paths and credentials are rejected. |
| `ROADVIEW_APP_ACCESS_TOKEN` | Optional private Sites application token. Sent as `OAI-Sites-Authorization: Bearer …` only to the exact configured application origin. |
| `ROADVIEW_BROWSER_CHANNEL` | Optional installed browser channel, such as `chrome`. Omit in Docker. |
| `HOST` | Defaults to `127.0.0.1`; `0.0.0.0` or `::1` can be explicitly configured. Docker uses `0.0.0.0`. |
| `PORT` | Defaults to `3101`. |

`npm start` starts the service with these process environment values. Secrets belong in the process environment or a deployment secret manager, not files or client bundles. The service is private behind the application server. The application needs a valid `NAVER_MAP_CLIENT_ID`, enabled Naver map service, and an allowed SDK domain that matches its origin.

## HTTP contract

`GET /health` returns `{ "ok": true }` without authentication.

`POST /capture` requires `Authorization: Bearer <ROADVIEW_RENDERER_TOKEN>` and JSON with `coord: [longitude, latitude]` and `heading`. No caller-supplied URL is accepted.

| Field | Values |
| --- | --- |
| `coord` | Two finite numbers within longitude and latitude bounds. The application SDK page accepts the Korean map area, longitude 124–132 and latitude 33–40. |
| `heading` | Finite degrees, at least 0 and below 360. |
| `target` | Optional coordinate within 60 metres of `coord`. The target bearing is computed from the actual selected camera coordinate. |
| `tilt` | Finite degrees from -45 to 45; defaults to 7. Canonical tilt increases downward. Native Naver tilt has the opposite sign. |
| `zoom` | Integer request framing preset 0, 1, or 2; defaults to 0. These request native fields of view of 90, 60, and 40 degrees, respectively. They are not Naver zoom levels. |
| `maxDistance` | 20 or 60 metres; defaults to 20. The actual panorama camera must fall within this distance of `coord`. Entrance captures use 60. |

The application implements `GET /internal/roadview?lng=...&lat=...&heading=...&tilt=...&zoom=...&maxDistance=...`. Its optional `target` query parameter is a JSON coordinate. This page validates every camera field and serializes only the validated controls and public SDK identifier into HTML. It loads one Naver SDK script with the panorama submodule. SDK construction runs in a microtask after the callback because constructors can become available after the callback returns. The container has explicit viewport dimensions and calls `Panorama.setSize()`.

The page publishes JSON in `#capture-state`. A successful state contains `status: "ready"`, the actual opaque `panoId`, `coord`, canonical `heading` and `tilt`, actual `fov`, and optional `capturedMonth`. Ready means the native camera matches the requested framing. `window.__readCaptureState()` recomputes that state from the SDK rather than returning cached event metadata.

A camera outside `maxDistance` publishes `{ "status": "missing", "reason": "distance" }` and returns JSON `null` from the renderer. Native `pano_status: "ERROR"` is a lookup failure, not proof of absent coverage. SDK authentication uses the separate `navermap_authFailure` callback. Errors publish `{ "status": "error", "code": "auth" | "lookup" | "sdk" | "metadata" }`.

A successful capture returns `image: {mime: "image/jpeg", data: "<base64>"}` and `source: {provider: "naver", capturedAt: null, capturedMonth?, coord, heading, tilt, zoom, fov, panoId, url}`. Coordinates and pose describe the actual native camera. `zoom` retains only the request preset. The original URL uses the observed official format `https://viewer.map.naver.com/panorama?id=<actual-id>&heading=<native-pan>&tilt=<native-tilt>&fov=<actual-fov>`.

`capturedMonth` comes only from SDK `getLocation().photodate`. Accepted representations are an unambiguous `YYYY-MM` or the observed `YYYY-MM-DD HH:mm:ss`. Calendar dates and time fields must be valid. Future months and dates after today's UTC day are omitted. The SDK does not document its shooting-date timezone, so no exact timestamp or day-precision evidence is inferred. `capturedAt` remains `null`.

## Capture checks and failures

The renderer attaches network listeners before page navigation. It accepts panorama textures only from `panorama.pstatic.net/image/<actual-panoId>/...`, decodes the completed image bodies, and requires at least two distinct images with both dimensions at least 512 pixels. Static UI assets and textures for another panorama do not satisfy readiness. All observed panorama requests must settle, and texture activity must remain unchanged for at least 500 milliseconds.

The service captures a 1280×800 JPEG after two animation frames. It checks the native panorama identifier, coordinate, actual pose, and date metadata immediately before and after the screenshot. It also rechecks texture readiness after capture and rejects central screenshot pixels that are almost black or lack scene color variation. Native credits remain visible in the captured page. Changes to Naver SDK events, image hosts, or texture layouts can make captures unavailable rather than silently produce replacement imagery.

At most two captures run concurrently; excess requests return 429. Bodies are limited to 2 KiB. Navigation has a 20 second timeout, and the complete request has a 30 second deadline. Client disconnects and cancellation close the browser context, including cancellation while a context is being created.

Invalid input returns 400; invalid renderer bearer authentication returns 401. Native SDK authentication failure returns 403. An application navigation response of 503 remains 503. Lookup, paint, texture, and other capture failures return 502, never JSON `null`. Error responses exclude credentials and private URLs. Server logs contain only the failure stage and a coarse reason, not coordinates, credentials, viewer URLs, or image bytes.

`npm test` runs contract and request-policy checks. Live imagery checks also need the application SDK page, a valid configured Naver client and domain, and network access to Naver. The renderer has no account setup, deployment, or public hosting automation.

The application distinguishes framing recovery from occlusion recovery. Framing requests keep the actual camera coordinate and aim at the target with adjusted canonical camera controls. Occlusion recovery uses route-ordered current, 12 metre before, and 12 metre after points aimed at the original target. These application operations share their own capture deadline and concurrency limits; they do not change the renderer's per-request deadline or the actual-camera provenance contract.
