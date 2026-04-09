import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { encode } from "next-auth/jwt";

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
            id: "00000000-0000-4000-8000-000000000099",
            email: credentials.email,
            name: "Admin User",
            utilityId: "00000000-0000-4000-8000-000000000001",
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
      // Encode the JWT token as a signed string so the API can verify it
      (session as any).accessToken = await encode({
        token,
        secret: process.env.NEXTAUTH_SECRET || "",
      });
      return session;
    },
  },
  session: { strategy: "jwt" },
  secret: process.env.NEXTAUTH_SECRET,
};
