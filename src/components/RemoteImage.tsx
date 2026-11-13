import { usePreview } from "@/hooks/useThumbnail";
import { cn } from "@/lib/utils";

/**
 * A cover still out on the web, from a source or a metadata provider.
 *
 * Fetched through the backend, never by pointing the `<img>` at the URL.
 * MangaDex answers a browser's request for a cover with a bot challenge, and
 * resets one carrying the WebView's own origin as `Referer` outright; the
 * backend's plain client is simply served the image. Every remote cover went
 * blank the day that started, so all of them go this way, not just MangaDex's.
 *
 * `className` sizes the box; the image fills it.
 */
export function RemoteImage({
  url,
  max,
  alt = "",
  className,
  imageClassName,
}: {
  url: string;
  max: number;
  alt?: string;
  className?: string;
  imageClassName?: string;
}) {
  const { ref, url: src } = usePreview(url, null, max);
  return (
    <div ref={ref} className={cn("overflow-hidden", className)}>
      {src && (
        <img
          src={src}
          alt={alt}
          draggable={false}
          className={cn("h-full w-full object-cover", imageClassName)}
        />
      )}
    </div>
  );
}
