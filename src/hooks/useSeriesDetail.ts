import { useEffect, useState } from "react";

import {
  seriesChapters,
  seriesCovers,
  type SeriesMatch,
  type VolumeChapters,
  type VolumeCover,
} from "@/lib/api";

export interface SeriesDetailState {
  covers: VolumeCover[];
  layout: VolumeChapters[];
  loading: boolean;
}

/**
 * The per-volume covers and published chapter layout for a selected series.
 *
 * Both dialogs that show a search result want exactly this pair, fetched
 * together. Requests for a series the user has already clicked past are
 * discarded rather than applied late, which is easy to hit when clicking down
 * a result list.
 */
export function useSeriesDetail(
  selected: SeriesMatch | null,
  onError: (message: string) => void,
): SeriesDetailState {
  const [covers, setCovers] = useState<VolumeCover[]>([]);
  const [layout, setLayout] = useState<VolumeChapters[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setCovers([]);
    setLayout([]);
    if (!selected) return;

    let cancelled = false;
    setLoading(true);

    Promise.all([
      seriesCovers(selected.source, selected.id),
      seriesChapters(selected.source, selected.id),
    ])
      .then(([foundCovers, foundLayout]) => {
        if (cancelled) return;
        setCovers(foundCovers);
        setLayout(foundLayout);
      })
      .catch((e) => {
        if (!cancelled) onError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // `onError` is a setter from the caller and is stable in practice; including
    // it would re-fetch the series every time the parent re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.source, selected?.id]);

  return { covers, layout, loading };
}
