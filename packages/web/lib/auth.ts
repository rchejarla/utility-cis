import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: "Credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        // Dev mode: accept any credentials, return mock user
        if (credentials?.email) {
          return {
            id: "user-001",
            email: credentials.email,
            name: "Admin User",
            utilityId: "mwa-001-uuid",
            role: "admin",
          };
        }
        return null;
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.utilityId = (user as any).utilityId;
        token.role = (user as any).role;
      }
      return token;
    },
    async session({ session, token }) {
      (session as any).utilityId = token.utilityId;
      (session as any).role = token.role;
      (session as any).accessToken = token; // JWT for API calls
      return session;
    },
  },
  session: { strategy: "jwt" },
  secret: process.env.NEXTAUTH_SECRET,
};
