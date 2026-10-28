# Service runtime

Consumers select places and a mobility profile. The server owns route retrieval, street-image acquisition, image inference and recommendation. `/api/action` accepts `search`, `journey`, `advance`, read-only `status`, and `cancel`. Job commands enforce ownership. The former user-key connection endpoint has been removed; `/connect` redirects to the map.

Configure runtime secrets using the names in `.env.example`. Local development can read process environment variables. Production reads the request-scoped worker environment supplied in `build/sites-worker.ts`. Private REST, inference and renderer keys are never embedded in client bundles or returned to browsers. GET /api/map-config returns only the domain-restricted, browser-public Kakao JavaScript key. Local preview runs on localhost:3000 and the Cloudflare development plugin reads ignored .env.local secrets.

The server selects Kakao routing when KAKAO_REST_API_KEY is configured; otherwise it requires TMAP_API_KEY. It never switches providers after an upstream error. Kakao's three real walking modes are requested and equivalent geometries deduplicated; a mode label is not a wheelchair-accessibility guarantee. The map uses the native Kakao SDK. ChatKHU is configured independently for image inference. If no image source is configured, candidates remain limited without a recommendation. Mapillary can provide genuine external images. Production renderer URLs require HTTPS and bearer authentication; local development may use the included localhost renderer. It receives `POST {coord:[longitude,latitude],heading:number}` with optional viewpoint parameters and returns JSON `null` for absent imagery, or the following object.

```json
{
  "image": {"mime":"image/jpeg", "data":"BASE64_IMAGE_BYTES"},
  "source": {
    "url":"https://map.kakao.com/ORIGINAL_VIEWER_LINK",
    "capturedAt": 1782864000000,
    "coord": [127.071,37.245],
    "heading": 90
  }
}
```

`services/roadview-renderer/` contains the real Playwright capture service. Provider terms and production hosting remain operator responsibilities. Responses are size-limited and parsed before use; original viewer links are restricted to supported providers. Exact captured bytes are persisted **before** the model call in private, multipart D1 storage, separate from the job JSON. Status polling exposes only capture metadata and same-origin `/api/journey-image?id=...` URLs. That endpoint enforces job ownership and 30-minute expiry, returns the original bytes with `private, no-store`, and cannot proxy arbitrary URLs. Expired-job cleanup cascades to image metadata and parts.

Durable version-3 jobs use revision/lease fencing so cancellation or a replaced lease prevents late state and image writes. A client submits one `advance` at a time and polls read-only `status` while it waits; images can appear before any observation completes. Provider-identified stair points are also captured even though they already exclude accessibility guidance. Rotated/adjacent review images are retained with their own camera metadata. Failures, unknown observations and cancellation do not erase previously saved frames before expiry. No historical missing frame is reconstructed from a newly opened roadview.

A recommendation requires observations for every required sample, with no blocked or unknown result. Otherwise the response is `limited` and the map shows candidates without a recommendation badge. This is an observation-based comparison, not a guarantee about continuous unpictured space. Images older than one year or unmatched location/direction are excluded. Numeric terrain grade is not inferred from image pixels.

The server requests real waypoint detours around shared physical obstacles and separately around unresolved mandatory connections; candidates must remain connected, distinct and outside the excluded passage. It can still finish without an acceptable alternative. Details distinguish provider instructions from direct image observations, position the problem, and report searching, finished or interrupted exploration with request/candidate counts. Missing data and service failures do not become physical barriers. Precise sidewalk geometry, measured curb heights/grades and wheelchair-user field validation are not established. The navigation panel presents route steps; it does not track live position or reroute on deviation.

Verified on 2026-10-23: Kakao geocoded Yeongtong-dong 992-1 and found the international-campus student hall. The real walking route was 1,393 m / 1,549 s with 49 path coordinates and 16 guidance steps. Both the provider and running Worker endpoint returned these values. A separate operator-captured July 2026 student-hall roadview image was passed as actual pixels to ChatKHU gemini-3.8-flash; a caution finding identified frontal stairs and a partially visible left ramp. That image was deleted after inference. This was an image-input smoke test, not an automated route-imagery run. Production runtime credentials are set through Sites secret settings; values are excluded from source archives.
