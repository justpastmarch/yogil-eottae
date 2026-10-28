# Roadview renderer

Private Node service that captures an actual Kakao Roadview through an isolated Playwright browser. The application selects a panorama with its official Kakao SDK route, then this service opens that panorama in the official Kakao viewer and captures the visible page, including its attribution. Images stay in memory and are returned to the caller. Browser profiles, cookies, traces, videos, and screenshots are never reused or deliberately saved.

Requires Node 22+ and a browser. Install this package with `npm ci`. For local macOS use `ROADVIEW_BROWSER_CHANNEL=chrome` to launch installed Google Chrome. Otherwise install the package's Chromium with `npx playwright install chromium`, or use the supplied Dockerfile, whose browser image matches the pinned Playwright version.

Set process environment before `npm start`:

| Variable | Meaning |
| --- | --- |
| `ROADVIEW_RENDERER_TOKEN` | Required bearer secret, at least 24 characters. Supply through process environment or a deployment secret manager. |
| `ROADVIEW_APP_ORIGIN` | Application origin, defaults to `http://localhost:3000`. HTTPS required except localhost, 127.0.0.1, or ::1. Paths and credentials are rejected. |
| `ROADVIEW_APP_ACCESS_TOKEN` | Optional private Sites application token. Sent as `OAI-Sites-Authorization: Bearer …` only to the exact configured application origin. |
| `ROADVIEW_BROWSER_CHANNEL` | Optional installed browser channel, such as `chrome`. Omit in Docker. |
| `HOST` | Defaults to `127.0.0.1`; `0.0.0.0` or `::1` can be explicitly configured. Docker uses `0.0.0.0`. |
| `PORT` | Defaults to `3101`. |

Do not put secrets in files or client application bundles. Keep this service private behind the application server. Production application origin and its allowed Kakao SDK domain must match.

`GET /health` returns `{ "ok": true }` without authentication.

`POST /capture` requires `Authorization: Bearer <ROADVIEW_RENDERER_TOKEN>` and JSON `{ "coord": [127.078, 37.307], "heading": 7 }`, optionally with `"target": [longitude, latitude]` within 60 metres, `"tilt": 25` and `"zoom": 1`. Target aiming uses the actual panorama coordinate. Heading is finite and at least 0 and below 360; tilt is finite from -45 to 45; zoom is an integer from 0 to 2. Kakao tilt increases downward: the default is 7, recovery uses 15 or 25. This was checked against the visible official viewer and [Viewpoint documentation](https://apis.map.kakao.com/web/documentation/#Viewpoint). No caller-supplied URL is accepted.

The application must implement `GET /internal/roadview?lng=...&lat=...&heading=...` and publish JSON in DOM element `#capture-state`. A successful state is `{ "status": "ready", "panoId": "1212598057", "coord": [127.078,37.307], "heading": 7 }`; missing imagery uses `{ "status": "missing" }`, and failures use `{ "status": "error" }`. Coordinates and heading describe the actual SDK panorama, not an estimated replacement.

A successful response includes `image: {mime, data}` and `source: {capturedAt, capturedMonth?, coord, heading, tilt, zoom, panoId, url}`. The month is read from visible official viewer text; it is omitted when unavailable. No day or exact capture timestamp is inferred. Missing SDK imagery returns JSON `null`. Camera tilt and zoom accompany the image so a different viewpoint cannot be mistaken for the same evidence.

The service verifies the panorama identifier in the official viewer URL, waits for a visible viewer and completed Roadview image responses, and captures a 1280×800 JPEG. It enables software WebGL for headless rendering and checks the central screenshot pixels for a painted scene, rejecting blank or almost black captures. It does not derive images or dates from private application JavaScript. Changes to Kakao's viewer DOM or image host may make a capture unavailable and require updating these checks.

At most two captures run concurrently; excess requests return 429. Bodies are limited to 2 KiB. Navigation has a 20 second timeout and the complete request a 30 second deadline. Client disconnects close the browser context. Invalid input returns 400, invalid authentication 401, and capture failures 502 with a generic error that excludes credentials and private URLs. Server logs record only the failure stage and a coarse reason; they do not include request coordinates, credentials, viewer URLs or image bytes.

Run `npm test` for contract and boundary checks. Actual imagery verification also requires the application SDK route, valid configured Kakao key/domain, and network access to Kakao. The renderer intentionally has no account setup, deployment, or public hosting automation.

Recovery distinguishes framing from occlusion. For framing, the app derives the target bearing from the original actual camera position and requests rotated views at that camera coordinate; the SDK still selects the available panorama. For occlusion or corridor mismatch it captures route-ordered current, 12 m before and 12 m after points aimed at the original target. Both paths share a 110 second capture deadline and at most two active captures; the app does not overlap this operation with ordinary capture batches. Each image request retries transient transport errors, HTTP 408, 429 and 5xx up to three attempts within its 90 second acquisition budget. Authentication errors and genuine missing imagery do not trigger retries. Losing screenshot ownership cancels remaining review captures. The app stores successful images separately with the job's expiry; this renderer does not persist images. Same-panorama rotation may resolve framing only when the original target is directly visible; it is never independent physical-view evidence for an occluded connection. Capture dates are retained when available, not used as a one-year review cutoff. An undated or older image describes only its capture, not current conditions. Different capture months do not establish current vehicle absence.
