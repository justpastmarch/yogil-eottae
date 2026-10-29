declare namespace Cloudflare {
  interface Env {
    KAKAO_JAVASCRIPT_KEY?: string;
    KAKAO_REST_API_KEY?: string;
    TMAP_API_KEY?: string;
    CHATKHU_API_KEY?: string;
    CHATKHU_MODEL?: string;
    MAPILLARY_TOKEN?: string;
    ROADVIEW_RENDERER_URL?: string;
    ROADVIEW_RENDERER_TOKEN?: string;
    STREET_IMAGERY_PROVIDER?: string;
    GOOGLE_STREET_VIEW_API_KEY?: string;
    DB?: D1Database;
    BUCKET?: R2Bucket;
  }
}
