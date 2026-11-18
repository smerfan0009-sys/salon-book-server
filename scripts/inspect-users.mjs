import { connectToMongoDB } from "../db.js";

// --------------------------------------------------
// POST-MIGRATION SANITY CHECK
// --------------------------------------------------
// Lists collections, and prints the _id storage format and key fields of
// one sample user document. Used to verify migration + adapter behavior.

try {
  const connection = await connectToMongoDB();
  if (!connection?.db) {
    console.error("MongoDB is not configured.");
    process.exit(1);
  }

  const { db, client } = connection;

  const collections = await db.listCollections().toArray();
  console.log("Collections:", collections.map((c) => c.name).join(", ") || "(none)");

  const usersCollection = db.collection("users");
  const count = await usersCollection.countDocuments();
  console.log(`users collection: ${count} document(s)`);

  const sample = await usersCollection.findOne({});
  if (sample) {
    const idType = sample._id?.constructor?.name || typeof sample._id;
    console.log("Sample _id type:", idType);
    console.log("Sample _id value:", String(sample._id));
    console.log("Sample fields:", Object.keys(sample).join(", "));
    console.log("Sample role:", sample.role);
    console.log("Sample isBlocked:", sample.isBlocked);
  } else {
    console.log("No user documents yet (sign up once, then re-run).");
  }

  await client?.close();
  process.exit(0);
} catch (error) {
  console.error("Inspection failed:", error.message);
  process.exit(1);
}
