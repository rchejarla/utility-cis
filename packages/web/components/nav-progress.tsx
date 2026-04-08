"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

export function NavProgress() {
  const pathname = usePathname();
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    // Reset on route change complete
    setLoading(false);
    setProgress(0);
  }, [pathname]);

  useEffect(() => {
    // Intercept link clicks to show loading bar
    function handleClick(e: MouseEvent) {
      const target = (e.target as HTMLElement).closest("a");
      if (!target) return;
      const href = target.getAttribute("href");
      if (!href || href.startsWith("http") || href.startsWith("#")) return;
      if (href === pathname) return;

      setLoading(true);
      setProgress(30);

      // Simulate progress
      const t1 = setTimeout(() => setProgress(60), 150);
      const t2 = setTimeout(() => setProgress(80), 400);
      return () => { clearTimeout(t1); clearTimeout(t2); };
    }

    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, [pathname]);

  if (!loading) return null;

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        height: "3px",
        zIndex: 9999,
        background: "transparent",
      }}
    >
      <div
        style={{
          height: "100%",
          background: "var(--accent-primary)",
          width: `${progress}%`,
          transition: "width 0.3s ease",
          boxShadow: "0 0 8px var(--accent-primary)",
          borderRadius: "0 2px 2px 0",
        }}
      />
    </div>
  );
}
