import { useEffect, useState } from "react";

/** mm:ss until `expiresAtIso`, ticking every second — matches the design's expiry countdown. Never negative; reads "0:00" once passed. */
export function useCountdown(expiresAtIso: string | undefined): string {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!expiresAtIso) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [expiresAtIso]);

  if (!expiresAtIso) return "—";
  const remainingMs = Math.max(0, new Date(expiresAtIso).getTime() - now);
  const totalSeconds = Math.floor(remainingMs / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
