import { jwtVerify, createRemoteJWKSet } from "jose";
import { ObjectId } from "mongodb";
import { getDb } from "../db.js";

// --------------------------------------------------
// JWT VERIFICATION + DATABASE ROLE/BLOCK CHECK
// --------------------------------------------------
// Better Auth issues short-lived EdDSA JWTs (verified against the public
// JWKS at /api/auth/jwks). After cryptographic verification we ALWAYS
// re-read the user from MongoDB: role and isBlocked are never trusted
// from the token or from client input.

const BETTER_AUTH_URL = process.env.BETTER_AUTH_URL || "http://localhost:5000";
const USERS_COLLECTION = "users";

// Remote JWKS with built-in caching and rotation handling.
const JWKS = createRemoteJWKSet(
  new URL(`${BETTER_AUTH_URL}/api/auth/jwks`)
);

// JWT audience/issuer are pinned to the Better Auth instance URL.
const VERIFY_OPTIONS = {
  issuer: BETTER_AUTH_URL,
  audience: BETTER_AUTH_URL,
};

const HEX_24 = /^[0-9a-fA-F]{24}$/;

function buildUserLookupFilter(sub) {
  // Default storage format (verified after migration): _id is an ObjectId
  // created from a 24-hex string. We also tolerate raw-string _id storage
  // (e.g. if the id strategy is ever changed) and never throw on bad input.
  const or = [{ _id: sub }];

  if (typeof sub === "string" && HEX_24.test(sub)) {
    try {
      or.push({ _id: new ObjectId(sub) });
    } catch {
      // Ignore conversion errors — fall back to string match only.
    }
  }

  return or.length > 1 ? { $or: or } : or[0];
}

export async function requireAuth(req, res, next) {
  try {
    const db = getDb();
    if (!db) {
      return res.status(503).json({
        success: false,
        message: "Service unavailable: database is not connected.",
      });
    }

    // 1. Extract Bearer token.
    const header = req.headers.authorization || "";
    const [scheme, token] = header.split(" ");

    if (scheme !== "Bearer" || !token) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized: provide a Bearer token.",
      });
    }

    // 2. Cryptographic verification: signature (kid -> JWKS), expiry,
    //    not-before, issuer and audience.
    let payload;
    try {
      const verified = await jwtVerify(token, JWKS, VERIFY_OPTIONS);
      payload = verified.payload;
    } catch {
      return res.status(401).json({
        success: false,
        message: "Unauthorized: token is invalid or expired.",
      });
    }

    const sub = payload?.sub;
    if (!sub || typeof sub !== "string") {
      return res.status(401).json({
        success: false,
        message: "Unauthorized: token subject is missing.",
      });
    }

    // 3. Fresh database lookup (never trust token claims).
    const user = await db
      .collection(USERS_COLLECTION)
      .findOne(buildUserLookupFilter(sub));

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized: user no longer exists.",
      });
    }

    // 4. Blocked check against current database state.
    if (user.isBlocked === true) {
      return res.status(403).json({
        success: false,
        message:
          "Forbidden: your account has been blocked. Please contact support.",
      });
    }

    // 5. Attach trusted, server-side user info.
    req.user = {
      id: sub,
      email: user.email,
      name: user.name,
      role: user.role || "customer",
      image: user.image ?? null,
    };

    next();
  } catch (error) {
    console.error("requireAuth error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error while authenticating.",
    });
  }
}

export function requireAdmin(req, res, next) {
  if (!req.user) {
    // requireAuth must run first in the chain.
    return res.status(401).json({
      success: false,
      message: "Unauthorized: missing user context.",
    });
  }

  if (req.user.role !== "admin") {
    return res.status(403).json({
      success: false,
      message: "Forbidden: admin access required.",
    });
  }

  next();
}
