"use client";

import { createContext, useContext } from "react";

const ModuleContext = createContext<string | null>(null);

export function useModuleContext(): string | null {
  return useContext(ModuleContext);
}

export function ModuleProvider({
  module,
  children,
}: {
  module: string;
  children: React.ReactNode;
}) {
  return (
    <ModuleContext.Provider value={module}>{children}</ModuleContext.Provider>
  );
}
