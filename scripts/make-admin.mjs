import { connectToMongoDB } from "../db.js";

// --------------------------------------------------
// SECURE SERVER-SIDE ADMIN PROVISIONING
// --------------------------------------------------
// Usage:
//   npm run make-admin -- user@example.com
//
// Sets role: "admin" for the given user directly in MongoDB.
// This is the ONLY supported way to grant the admin role.
// Public sign-up can never produce an admin.

const email = process.argv[2]?.trim().toLowerCase();

if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error("Usage: npm run make-admin -- user@example.com");
  process.exit(1);
}

try {
  const connection = await connectToMongoDB();
  if (!connection?.db) {
    console.error("MongoDB is not configured. Set MONGODB_URI (or DB_USER/DB_PASSWORD).");
    process.exit(1);
  }

  const { db, client } = connection;
  const result = await db.collection("users").updateOne(
    { email },
    { $set: { role: "admin" } }
  );

  if (result.matchedCount === 0) {
    console.error(`No user found with email: ${email}`);
    await client?.close();
    process.exit(1);
  }

  console.log(`Success: ${email} now has the admin role.`);
  await client?.close();
  process.exit(0);
} catch (error) {
  console.error("Failed to assign admin role:", error.message);
  process.exit(1);
}
