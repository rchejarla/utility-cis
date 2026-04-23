"use client";

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

type ToastType = "success" | "error" | "info";

interface ToastMessage {
  id: string;
  type: ToastType;
  message: string;
}

interface ToastContextValue {
  toast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const toastStyles: Record<ToastType, { bg: string; border: string; icon: string; color: string }> = {
  success: {
    bg: "rgba(34,197,94,0.12)",
    border: "rgba(34,197,94,0.3)",
    icon: "✓",
    color: "#4ade80",
  },
  error: {
    bg: "var(--danger-subtle)",
    border: "var(--danger)",
    icon: "✕",
    color: "var(--danger)",
  },
  info: {
    bg: "rgba(59,130,246,0.12)",
    border: "rgba(59,130,246,0.3)",
    icon: "ℹ",
    color: "#60a5fa",
  },
};

function Toast({
  message,
  type,
  onDismiss,
}: {
  message: string;
  type: ToastType;
  onDismiss: () => void;
}) {
  const style = toastStyles[type];

  return (
    <div
      role={type === "error" ? "alert" : "status"}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "10px",
        padding: "12px 16px",
        borderRadius: "var(--radius)",
        background: "var(--bg-elevated)",
        border: `1px solid ${style.border}`,
        boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
        minWidth: "280px",
        maxWidth: "420px",
        animation: "slideIn 0.2s ease",
      }}
    >
      <div
        style={{
          width: "22px",
          height: "22px",
          borderRadius: "50%",
          background: style.bg,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "12px",
          color: style.color,
          fontWeight: "700",
          flexShrink: 0,
        }}
      >
        {style.icon}
      </div>

      <span
        style={{
          flex: 1,
          fontSize: "13px",
          color: "var(--text-primary)",
          lineHeight: "1.4",
        }}
      >
        {message}
      </span>

      <button
        onClick={onDismiss}
        style={{
          background: "transparent",
          border: "none",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: "16px",
          lineHeight: 1,
          padding: "0 2px",
          flexShrink: 0,
          fontFamily: "inherit",
        }}
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const timersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    if (timersRef.current[id]) {
      clearTimeout(timersRef.current[id]);
      delete timersRef.current[id];
    }
  }, []);

  const toast = useCallback(
    (message: string, type: ToastType = "info") => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setToasts((prev) => [...prev, { id, type, message }]);
      timersRef.current[id] = setTimeout(() => dismiss(id), 5000);
    },
    [dismiss]
  );

  // Cleanup on unmount
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      Object.values(timers).forEach(clearTimeout);
    };
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}

      {/* Toast container — aria-live region so assistive tech announces new toasts */}
      <div
        aria-live="polite"
        aria-atomic="false"
        aria-relevant="additions"
        style={{
          position: "fixed",
          bottom: "24px",
          right: "24px",
          display: "flex",
          flexDirection: "column",
          gap: "8px",
          zIndex: 9999,
          pointerEvents: toasts.length > 0 ? "auto" : "none",
        }}
      >
        {toasts.map((t) => (
          <Toast
            key={t.id}
            message={t.message}
            type={t.type}
            onDismiss={() => dismiss(t.id)}
          />
        ))}
      </div>

      <style>{`
        @keyframes slideIn {
          from { transform: translateX(20px); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
      `}</style>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return ctx;
}
