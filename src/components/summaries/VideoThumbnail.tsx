import { useState } from "react";
import { VideoOff } from "lucide-react";

interface Props {
  youtubeId: string;
  /** What Supadata last reported — may be null, and may 404. See `Video.thumbnail_url_reported`. */
  reportedUrl: string | null;
  title: string | null;
}

/**
 * The derived fallback. `maxresdefault` — which is what Supadata reports — does not exist for videos
 * never uploaded above 480p, whereas `hqdefault` exists for every video. This URL is only ever
 * rendered; it is never written back to `videos.thumbnail_url_reported`, which stays a record of what
 * the vendor said rather than of what happened to load.
 */
function derivedThumbnailUrl(youtubeId: string): string {
  return `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`;
}

/**
 * Hosts YouTube actually serves thumbnails from. `reportedUrl` is third-party metadata persisted
 * without validation at write time — allowlisting here, at render time, is what stops a malformed or
 * compromised reported value from making every viewer's browser request an arbitrary origin.
 */
const ALLOWED_THUMBNAIL_HOSTS = new Set([
  "i.ytimg.com",
  "i1.ytimg.com",
  "i2.ytimg.com",
  "i3.ytimg.com",
  "i4.ytimg.com",
  "img.youtube.com",
]);

function isTrustedThumbnailUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && ALLOWED_THUMBNAIL_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Renders a video's thumbnail with a double fallback: the reported URL, then the derived
 * `hqdefault.jpg`, then a non-image placeholder.
 *
 * The reported URLs are heterogeneous — `/vi/…jpg`, `/vi_webp/…webp`, and `…jpg?sqp=…&rs=…` with
 * signed params that can expire — and are deliberately NOT pattern-matched or repaired: they are just
 * allowed to fail into the fallback. A 404 is only observable once the browser tries the load, so the
 * first hop is an `onError` handler rather than a server-side check.
 *
 * `stage` is the one-shot guard: reassigning `src` from `onError` re-arms the handler, so a fallback
 * that also fails would loop forever without it. Each stage can only move forward.
 */
export function VideoThumbnail({ youtubeId, reportedUrl, title }: Props) {
  const trustedReportedUrl = reportedUrl && isTrustedThumbnailUrl(reportedUrl) ? reportedUrl : null;
  const [stage, setStage] = useState<"reported" | "derived" | "placeholder">(
    trustedReportedUrl ? "reported" : "derived",
  );

  if (stage === "placeholder") {
    return (
      <div
        className="border-border bg-muted flex aspect-video w-full items-center justify-center rounded-lg border"
        aria-hidden="true"
      >
        <VideoOff className="text-muted-foreground size-6" />
      </div>
    );
  }

  return (
    <img
      src={stage === "reported" && trustedReportedUrl ? trustedReportedUrl : derivedThumbnailUrl(youtubeId)}
      alt={title ?? "Video thumbnail"}
      loading="lazy"
      onError={() => {
        setStage((current) => (current === "reported" ? "derived" : "placeholder"));
      }}
      className="border-border bg-muted aspect-video w-full rounded-lg border object-cover"
    />
  );
}
