"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    const token = localStorage.getItem("cis_token");
    router.replace(token ? "/premises" : "/login");
  }, [router]);

  return null;
}
