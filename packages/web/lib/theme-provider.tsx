"use client";

import React, { createContext, useContext, useEffect, useState } from "react";

type ThemeMode = "dark" | "light" | "system";

interface ThemeColors {
  [key: string]: string;
}

interface ThemeData {
  colors?: {
    dark?: ThemeColors;
    light?: ThemeColors;
  };
}

interface ThemeContextValue {
  mode: ThemeMode;
  toggle: () => void;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  mode: "dark",
  toggle: () => {},
  setMode: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}

function getEffectiveMode(mode: ThemeMode): "dark" | "light" {
  if (mode === "system") {
    if (typeof window !== "undefined") {
      return window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark";
    }
    return "dark";
  }
  return mode;
}

function applyCSSVariables(colors: ThemeColors) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  Object.entries(colors).forEach(([key, value]) => {
    root.style.setProperty(key, value);
  });
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>("dark");
  const [themeData, setThemeData] = useState<ThemeData | null>(null);

  // Load saved preference from localStorage
  useEffect(() => {
    const saved = localStorage.getItem("theme-mode") as ThemeMode | null;
    if (saved && ["dark", "light", "system"].includes(saved)) {
      setModeState(saved);
    }
  }, []);

  // Fetch theme data from API
  useEffect(() => {
    async function fetchTheme() {
      try {
        const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
        const response = await fetch(`${API_URL}/api/v1/theme`);
        if (response.ok) {
          const data = await response.json();
          setThemeData(data);
        }
      } catch {
        // Silently fail — use CSS variable defaults
      }
    }
    fetchTheme();
  }, []);

  // Apply theme whenever mode or themeData changes
  useEffect(() => {
    const effective = getEffectiveMode(mode);
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-theme", effective);
    }
    if (themeData?.colors?.[effective]) {
      applyCSSVariables(themeData.colors[effective]!);
    }
  }, [mode, themeData]);

  // Listen for system theme changes when mode is "system"
  useEffect(() => {
    if (mode !== "system" || typeof window === "undefined") return;
    const mediaQuery = window.matchMedia("(prefers-color-scheme: light)");
    const handler = () => {
      const effective = getEffectiveMode("system");
      document.documentElement.setAttribute("data-theme", effective);
      if (themeData?.colors?.[effective]) {
        applyCSSVariables(themeData.colors[effective]!);
      }
    };
    mediaQuery.addEventListener("change", handler);
    return () => mediaQuery.removeEventListener("change", handler);
  }, [mode, themeData]);

  const setMode = (newMode: ThemeMode) => {
    setModeState(newMode);
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("theme-mode", newMode);
    }
  };

  const toggle = () => {
    const effective = getEffectiveMode(mode);
    setMode(effective === "dark" ? "light" : "dark");
  };

  return (
    <ThemeContext.Provider value={{ mode, toggle, setMode }}>
      {children}
    </ThemeContext.Provider>
  );
}
