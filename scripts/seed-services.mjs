import { connectToMongoDB } from "../db.js";

// --------------------------------------------------
// INITIAL SERVICE DATA
// --------------------------------------------------
// Usage:
//   npm run seed-services
//
// Uses slug-based upserts, so running this script more than once will not
// create duplicate services or overwrite services that already exist.

const services = [
  {
    name: "Premium Haircut",
    slug: "premium-haircut",
    category: "Haircut & Styling",
    image:
      "https://images.unsplash.com/photo-1621605815971-fbc98d665033?auto=format&fit=crop&w=1000&q=85",
    shortDescription:
      "A precision haircut finished with a style tailored to your look.",
    description:
      "Refresh your look with a professional consultation, precision haircut, wash, and finished styling. Our stylist will recommend a shape and finish that suit your hair type and personal style.",
    price: 800,
    duration: 45,
    isActive: true,
    featuredOrder: 1,
  },
  {
    name: "Full Hair Coloring",
    slug: "full-hair-coloring",
    category: "Hair Coloring",
    image:
      "https://images.unsplash.com/photo-1527799820374-dcf8d9d4a388?auto=format&fit=crop&w=1000&q=85",
    shortDescription:
      "A customized all-over color service for a fresh, polished look.",
    description:
      "Get a refreshed hair color selected to complement your style. This service includes a color consultation, full application, rinse, and professional finish. Final pricing may vary with hair length and product usage.",
    price: 2500,
    duration: 120,
    isActive: true,
    featuredOrder: 2,
  },
  {
    name: "Keratin Hair Treatment",
    slug: "keratin-hair-treatment",
    category: "Hair Treatment",
    image:
      "https://images.unsplash.com/photo-1560066984-138dadb4c035?auto=format&fit=crop&w=1000&q=85",
    shortDescription:
      "A smoothing treatment that helps leave hair softer and easier to manage.",
    description:
      "A professional smoothing treatment designed to reduce frizz and improve manageability. The service includes a hair assessment, treatment application, and finishing. Suitability and final pricing should be confirmed during consultation.",
    price: 3500,
    duration: 150,
    isActive: true,
    featuredOrder: 3,
  },
  {
    name: "Luxury Facial",
    slug: "luxury-facial",
    category: "Facial & Skincare",
    image:
      "https://images.unsplash.com/photo-1570172619644-dfd03ed5d881?auto=format&fit=crop&w=1000&q=85",
    shortDescription:
      "A relaxing facial with cleansing, exfoliation, and hydration.",
    description:
      "Enjoy a refreshing facial session tailored to your skin's needs. The service includes cleansing, gentle exfoliation, a treatment mask, and moisturizing care. Please let the specialist know about any skin sensitivities before the session.",
    price: 1800,
    duration: 60,
    isActive: true,
    featuredOrder: 4,
  },
  {
    name: "Party Makeup",
    slug: "party-makeup",
    category: "Makeup",
    image:
      "https://images.unsplash.com/photo-1487412720507-e7ab37603c6f?auto=format&fit=crop&w=1000&q=85",
    shortDescription:
      "A professionally finished makeup look for your special occasion.",
    description:
      "Get ready for your event with a makeup look customized to your outfit and preferences. The session includes skin preparation, complexion work, eye makeup, and a final look check.",
    price: 3000,
    duration: 90,
    isActive: true,
    featuredOrder: 5,
  },
  {
    name: "Manicure & Pedicure",
    slug: "manicure-pedicure",
    category: "Manicure & Pedicure",
    image:
      "https://images.unsplash.com/photo-1604654894610-df63bc536371?auto=format&fit=crop&w=1000&q=85",
    shortDescription:
      "Complete nail grooming and care for hands and feet.",
    description:
      "A combined nail-care session featuring nail shaping, cuticle care, hand and foot treatment, and your choice of a simple polish finish.",
    price: 1200,
    duration: 60,
    isActive: true,
    featuredOrder: 6,
  },
  {
    name: "Relaxing Body Massage",
    slug: "relaxing-body-massage",
    category: "Spa & Massage",
    image:
      "https://images.unsplash.com/photo-1540555700478-4be289fbecef?auto=format&fit=crop&w=1000&q=85",
    shortDescription:
      "A calming massage session designed to help you unwind.",
    description:
      "Take time to unwind with a relaxing massage session in a calm environment. Tell the therapist about your comfort preferences before the session begins.",
    price: 2200,
    duration: 60,
    isActive: true,
    featuredOrder: 7,
  },
];

let client;

try {
  const connection = await connectToMongoDB();

  if (!connection?.db) {
    throw new Error(
      "MongoDB is not configured. Set MONGODB_URI (or DB_USER/DB_PASSWORD)."
    );
  }

  client = connection.client;

  const collection = connection.db.collection("services");

  // Enforce unique slugs while allowing unrelated legacy documents
  // that do not yet have a slug field.
  await collection.createIndex(
    { slug: 1 },
    {
      unique: true,
      name: "uniq_service_slug",
      partialFilterExpression: { slug: { $type: "string" } },
    }
  );

  const now = new Date();

  const operations = services.map((service) => ({
    updateOne: {
      filter: { slug: service.slug },
      update: {
        $setOnInsert: {
          ...service,
          createdAt: now,
          updatedAt: now,
        },
      },
      upsert: true,
    },
  }));

  const result = await collection.bulkWrite(operations, { ordered: false });
  const activeCount = await collection.countDocuments({ isActive: true });

  console.log("Service seed completed.");
  console.log(`Inserted: ${result.upsertedCount}`);
  console.log(`Already existed: ${result.matchedCount}`);
  console.log(`Active services in database: ${activeCount}`);
} catch (error) {
  console.error("Failed to seed services:", error);
  process.exitCode = 1;
} finally {
  await client?.close();
}
