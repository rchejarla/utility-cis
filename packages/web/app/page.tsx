"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { getStoredUser } from "@/lib/api-client";

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    const token = localStorage.getItem("cis_token");
    if (!token) {
      router.replace("/login");
      return;
    }
    const user = getStoredUser();
    router.replace(user?.customerId ? "/portal/dashboard" : "/premises");
  }, [router]);

  return null;
}
