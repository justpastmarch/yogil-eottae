# Service runtime

Consumers select places and a mobility profile. The server owns route retrieval, street-image acquisition, image inference and recommendation. The public endpoint accepts only `search` and `journey` commands. The former user-key connection endpoint has been removed; `/connect` redirects to the map.

Configure runtime secrets using the names in `.env.example`. Local development can read process environment variables. Production reads the request-scoped worker environment supplied in `build/sites-worker.ts`. No secret is embedded in a client bundle or returned to the browser.

The server requires TMAP, ChatKHU and at least one image source before it starts a journey. A configured Mapillary token enables genuine external image queries. The optional renderer endpoint must be HTTPS and authenticated with the configured bearer token. It receives `POST {coord:[longitude,latitude],heading:number}` and returns JSON `null` when no image exists, or the following object.

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

Known remaining work includes deployment of a legitimate renderer, precise path-to-sidewalk correspondence, external credential configuration, real end-to-end validation, obstacle-driven generation of new detours, and terrain elevation integration. The current navigation panel presents route steps; it does not track live navigation or reroute on deviation.
