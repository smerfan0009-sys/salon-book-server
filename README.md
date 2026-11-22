# SalonBook Server

The SalonBook server is an Express and MongoDB API for authentication, salon services, appointments, payments, profiles, and administration. Payment completion is recorded only from verified Stripe webhooks.

## Key features

- Better Auth authentication with server-side role and blocked-account checks
- Customer appointment lifecycle, protected ownership rules, and collision prevention
- Admin service, appointment, user, transaction, and reporting endpoints
- Stripe Checkout creation plus signature-verified, idempotent webhook processing
- Image upload support and safe profile updates

## Tech stack

Node.js, Express, MongoDB, Better Auth, Stripe, Multer, and CORS.

## Run locally

```bash
npm install
npm run dev
```

Use `npm start` for a normal Node process. Configure the local MongoDB, Better Auth, Stripe, and optional image-upload settings before starting it.

## Required environment variable names

- `PORT`
- `CLIENT_URL`
- `BETTER_AUTH_URL`
- `BETTER_AUTH_SECRET`
- `MONGODB_URI` (or `DB_USER` and `DB_PASSWORD`)
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `IMGBB_API_KEY`
- `NODE_ENV`
- `VERCEL`

Use local, test-only values while developing. Never commit environment files or secret values.

## Main API route groups

- Auth: `/api/auth/*`
- Services: `/api/services`
- Appointments: `/api/appointments`
- Payments: `/api/payments`
- Admin: `/api/admin`
- Profile: `/api/profile`

## Links

- Live client: https://salon-book-client-puce.vercel.app
- Live API: https://salon-book-server-sigma.vercel.app
- Client repository: https://github.com/smerfan0009-sys/salon-book-client
- Server repository: https://github.com/smerfan0009-sys/salon-book-server
