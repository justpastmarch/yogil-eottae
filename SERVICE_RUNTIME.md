# Service runtime

Consumers select places and a mobility profile. The server owns route retrieval, street-image acquisition, image inference and recommendation. The public endpoint accepts only `search` and `journey` commands. The former user-key connection endpoint has been removed; `/connect` redirects to the map.

Configure runtime secrets using the names in `.env.example`. Local development can read process environment variables. Production reads the request-scoped worker environment supplied in `build/sites-worker.ts`. Private REST, inference and renderer keys are never embedded in client bundles or returned to browsers. GET /api/map-config returns only the domain-restricted, browser-public Kakao JavaScript key. Local preview runs on localhost:3000 and the Cloudflare development plugin reads ignored .env.local secrets.

The server selects Kakao routing when KAKAO_REST_API_KEY is configured; otherwise it requires TMAP_API_KEY. It never switches providers after an upstream error. Kakao currently returns one genuine walking route, without claiming a stair-free or wheelchair-specific option. TMAP retains its genuine option requests when selected. The map uses the native Kakao SDK. ChatKHU is configured independently for image inference. If no image source is configured, real routes remain available as limited with empty evidence and no recommendation. A configured Mapillary token enables genuine external image queries. The optional renderer endpoint must be HTTPS and authenticated with the configured bearer token. It receives `POST {coord:[longitude,latitude],heading:number}` and returns JSON `null` when no image exists, or the following object.

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

This is an adapter contract. A browser rendering service is not included in this repository and has not been deployed. A renderer operator must supply a working implementation and ensure capture and transient inference use meet the image provider's terms. The response is size-limited and parsed before use. Original viewer links are restricted to supported map providers. Captured bytes pass directly to ChatKHU and are neither persisted nor returned to consumers.

A journey has an 85-second request deadline, at most 120 image lookups and 120 image-analysis attempts. It attempts to complete a candidate before spreading the budget to other candidates, with critical samples first. A route with an observed blocking obstacle is not inspected further. There are no automatic paid retries and no verdict reuse across different samples. Cancellation and provider authentication/configuration failures propagate as service failures. Cancellation cannot guarantee reversal of upstream billing. Long routes may require a future durable background job; this request is not presented as unlimited processing.

A recommendation requires observations for every required sample, with no blocked or unknown result. Otherwise the response is `limited` and the map shows candidates without a recommendation badge. This is an observation-based comparison, not a guarantee about continuous unpictured space. Images older than one year or unmatched location/direction are excluded. Numeric terrain grade is not inferred from image pixels.

Known remaining work includes deployment of a legitimate renderer, precise path-to-sidewalk correspondence, real end-to-end validation, obstacle-driven generation of new detours, and terrain elevation integration. The current navigation panel presents route steps; it does not track live navigation or reroute on deviation.

Verified on 2026-10-23: Kakao geocoded Yeongtong-dong 992-1 and found the international-campus student hall. The real walking route was 1,393 m / 1,549 s with 49 path coordinates and 16 guidance steps. Both the provider and running Worker endpoint returned these values. A separate operator-captured July 2026 student-hall roadview image was passed as actual pixels to ChatKHU gemini-3.8-flash; a caution finding identified frontal stairs and a partially visible left ramp. That image was deleted after inference. This was an image-input smoke test, not an automated route-imagery run. Production runtime credentials are set through Sites secret settings; values are excluded from source archives.
