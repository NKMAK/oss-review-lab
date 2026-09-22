import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";
import { useLoadedData } from "../data/DataContext";
import { parseViewParams, readStoredThreshold, toSearchParams, writeStoredThreshold } from "./params";
import type { ViewParams } from "./params";

/**
 * URLのクエリを正とする画面の状態(2つの閾値・観点・言い方・発言者役割・除外表示・variant・run)。
 * - 読み: クエリ → (閾値だけ)localStorage → 既定値。不正な値は既定値に戻る(`parseViewParams`)。
 * - 書き: `update(patch)` で、クエリを書き換える。閾値は、変えたものだけ、用途別のキーで localStorage にも保存する。
 * DataProvider(成功状態)の中で使う。
 */
export function useViewParams(): [ViewParams, (patch: Partial<ViewParams>) => void] {
  const { manifest } = useLoadedData();
  const [search, setSearch] = useSearchParams();
  const searchString = search.toString();

  const params = useMemo(
    () =>
      parseViewParams(new URLSearchParams(searchString), {
        knownRunIds: manifest.runs.map((r) => r.runId),
        storedAckThreshold: readStoredThreshold("ack"),
        storedLabelThreshold: readStoredThreshold("label"),
      }),
    [searchString, manifest],
  );

  const update = useCallback(
    (patch: Partial<ViewParams>) => {
      const next = { ...params, ...patch };
      if (patch.ackThreshold !== undefined) writeStoredThreshold("ack", next.ackThreshold);
      if (patch.labelThreshold !== undefined) writeStoredThreshold("label", next.labelThreshold);
      setSearch(toSearchParams(next), { replace: true });
    },
    [params, setSearch],
  );

  return [params, update];
}
