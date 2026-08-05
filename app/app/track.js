"use client";
import { useEffect } from "react";

// Fires once per page load on public (night-themed) pages.
// Uses sendBeacon so it doesn't block navigation or hurt perf.
export default function TrackPageView() {
  useEffect(() => {
    try {
      const data = JSON.stringify({
        path: location.pathname + location.search,
        referrer: document.referrer || null,
      });
      if (navigator.sendBeacon) {
        navigator.sendBeacon("/api/pageview", new Blob([data], { type: "application/json" }));
      } else {
        fetch("/api/pageview", { method: "POST", body: data,
          headers: { "Content-Type": "application/json" }, keepalive: true });
      }
    } catch {}
  }, []);
  return null;
}
