"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { getStoredUser } from "@/lib/api-client";

/**
 * Where "/" sends you: the dashboard, for every staff member.
 *
 * It used to be Premises, which is a working screen rather than a place
 * to be told what is unfinished — and the setup check-list had nowhere
 * to live. The dashboard carries whichever widgets the viewer can see,
 * so there is no permission to branch on here: the page decides what to
 * show, not the redirect.
 */
export default function Home() {
  const router = useRouter();

  useEffect(() => {
    const token = localStorage.getItem("cis_token");
    if (!token) {
      router.replace("/login");
      return;
    }
    const user = getStoredUser();
    router.replace(user?.customerId ? "/portal/dashboard" : "/dashboard");
  }, [router]);

  return null;
}
