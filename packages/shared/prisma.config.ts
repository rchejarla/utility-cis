// Prisma v6 config. We can't use `env("DATABASE_URL")` here because that
// helper evaluates eagerly at config-load time and throws when the env
// var is missing (e.g. `prisma generate` in CI, which doesn't need a
// real database). Using `process.env.DATABASE_URL` with a placeholder
// fallback keeps the config loadable in CI while still routing every
// command that actually connects (migrate/db execute) to the real URL.
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  engine: "classic",
  datasource: {
    // `.invalid` is reserved by RFC 2606 and guaranteed never to resolve,
    // so if DATABASE_URL is missing when a command actually needs a
    // connection, Prisma fails fast instead of accidentally hitting a
    // real DB at localhost.
    url: process.env.DATABASE_URL ?? "postgresql://placeholder:placeholder@nowhere.invalid:5432/placeholder",
  },
});
