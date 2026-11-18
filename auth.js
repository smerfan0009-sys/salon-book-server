import { betterAuth } from "better-auth";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { admin, jwt } from "better-auth/plugins";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { connectToMongoDB } from "./db.js";

// --------------------------------------------------
// BETTER AUTH INSTANCE (shared, lazy singleton)
// --------------------------------------------------
// Reuses the SAME MongoDB connection/database as the rest of the app.
// Better Auth owns: login, registration, sessions, Google OAuth, JWKS.

const BETTER_AUTH_URL = process.env.BETTER_AUTH_URL || "http://localhost:5000";
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:3000";

// Connect (or reuse the cached connection from db.js).
// Top-level await so the CLI and the server both get a ready db.
const connection = await connectToMongoDB();
if (!connection?.db) {
  throw new Error(
    "MongoDB is required for Better Auth. Configure MONGODB_URI (or DB_USER/DB_PASSWORD) before starting the server."
  );
}
const { db, client } = connection;

// Only enable the Google provider when credentials are actually configured.
const socialProviders =
  process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    ? {
        google: {
          clientId: process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        },
      }
    : {};

export const auth = betterAuth({
  appName: "SalonBook",
  baseURL: BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  trustedOrigins: [CLIENT_URL],

  // Reuse existing database "salon-book"; the users collection is
  // explicitly named "users" per project requirements.
  user: {
    modelName: "users",
  },

  database: mongodbAdapter(db, { client }),

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 6,
  },

  socialProviders,

  plugins: [
    // Role + block management. Blocked-status field is persisted as
    // "isBlocked" (assignment requirement) via the schema remap below.
    admin({
      defaultRole: "customer",
      adminRoles: ["admin"],
      schema: {
        user: {
          fields: {
            banned: "isBlocked",
          },
        },
      },
    }),
    // JWT issuance for Express REST API verification (JWKS/EdDSA).
    jwt({
      jwt: {
        issuer: BETTER_AUTH_URL,
        audience: BETTER_AUTH_URL,
        expirationTime: "15m",
      },
    }),
  ],

  // Server-side password policy for credential sign-ups:
  // min 6 chars (enforced by minPasswordLength), at least one
  // uppercase and one lowercase letter.
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === "/sign-up/email") {
        const password = ctx.body?.password;

        if (typeof password === "string") {
          if (!/[a-z]/.test(password) || !/[A-Z]/.test(password)) {
            throw new APIError("BAD_REQUEST", {
              message:
                "Password must contain at least one uppercase letter and one lowercase letter.",
            });
          }
        }
      }
    }),
  },
});

// Lazily-created accessor used by the Express server after the DB is up.
export function getAuth() {
  return auth;
}
