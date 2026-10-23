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
    DB?: D1Database;
    BUCKET?: R2Bucket;
  }
}
