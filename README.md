# ParkWise — Smart Parking Management System

**ParkWise** is a full-stack smart parking management and intelligent slot recommendation platform. Built with **Node.js**, **Express 5**, and **MongoDB Atlas**, it replaces legacy browser-only storage with a multi-location backend architecture featuring ACID transactions for double-booking prevention, role-based access control (RBAC), interactive geospatial facility discovery, and live countdown-synchronized booking management.

---

## 🌟 Overview & Workflows

### 👤 User Workflow (Driver)
1. **Registration & Authentication**: Drivers register an account (`/register.html`) or log in (`/login.html`). Upon authentication, a signed JWT is issued and stored in browser `sessionStorage` (tab-scoped; zero plaintext passwords stored in the browser).
2. **Facility Discovery & Search**: Drivers browse public parking locations (`/locations.html`) using debounced text search, city/area filtering, current total/available slot counters, and an interactive Leaflet map.
3. **Slot Recommendation & Selection**: Viewing a location (`/booking.html?locationId=...`) displays compatible enabled parking slots (`car`, `bike`, `ev`) with clear pricing in paise and integer Rupees. The system provides deterministic top-3 rule-based slot recommendations prioritizing lowest price and nearest distance.
4. **Immediate Booking**: Booking a slot executes an atomic MongoDB transaction. Pre-POST recovery guards prevent duplicate payments across network timeouts using unique UUID `requestId` idempotency.
5. **Saved Vehicles & Autofill**: Drivers manage frequently used vehicles (`label`, `registrationNumber`, `type`) from the dashboard modal. Compatible saved vehicles automatically autofill the booking form with strict type safety.
6. **Active Dashboard & History**: Drivers track their active reservation with a live second-by-second countdown synchronized to server time (`/dashboard.html`). Past records can be searched, sorted, and paginated (`/history.html`), and active bookings can be cancelled atomically to release the claimed slot.

### 🛡️ Administrator Workflow (Operator)
1. **Operator Sign-In**: Administrators authenticate via `/login.html`. Dynamic database role verification grants access to the restricted console (`/admin.html`).
2. **Create Draft Facility**: Admins create a new parking facility (`name`, `category`, `address`, `city`, `area`, `contactPhone`, `latitude`, `longitude`, `facilities`). New facilities start in `draft` status.
3. **Add Parking Slots**: Admins create individual slots (`code`, `zone`, `floor`, `vehicleType`, `pricePerHourPaise`, `distanceFromEntry`, `features`) scoped to the facility.
4. **Publish Facility**: Transitioning a facility to `active` is validated against backend preconditions: a location cannot be published until it possesses valid coordinates, an address, and at least one enabled slot.
5. **Manage Slot Operations**: Admins can toggle a slot's `serviceStatus` to `maintenance` or `disabled` without corrupting active booking snapshots.
6. **Telemetry & Audit Logging**: Admins monitor system-wide occupancy statistics and audit driver bookings with populated user contact details (sensitive `passwordHash` strictly excluded).

---

## 🏗️ Architecture & Technology Stack

### System Architecture
```
┌─────────────────────────────────────────────────────────────┐
│                       Client Browser                        │
│   Vanilla JS (ES6 Modules) • Semantic HTML5 • CSS3 Modern  │
│   Leaflet.js Map • SessionStore JWT • Client Clock Sync     │
└──────────────────────────────┬──────────────────────────────┘
                               │ JSON REST API (HTTP locally; HTTPS when deployed behind TLS)
┌──────────────────────────────▼──────────────────────────────┐
│                    Express 5 API Server                     │
│   Helmet Security Headers • Rate Limiting • Auth Middleware │
│   Booking Concurrency Service • Expiry Sweeper Reconciler   │
└──────────────────────────────┬──────────────────────────────┘
                               │ Mongoose 8 / Replica Set
┌──────────────────────────────▼──────────────────────────────┐
│                     MongoDB Atlas Cluster                   │
│   ACID Transactions • Partial Unique Indexes • Expiry Reconciliation │
│   Users • Locations • Slots • Bookings • Vehicles           │
└─────────────────────────────────────────────────────────────┘
```

### Technology Stack
- **Backend Runtime**: Node.js (v20+)
- **API Framework**: Express 5 (`express@5.0.1`)
- **Database & ODM**: MongoDB Atlas (Replica Set required for transactions) with Mongoose 8 (`mongoose@8.24.5`)
- **Security & Cryptography**: Helmet 8, bcryptjs (10 salt rounds, 72-byte truncation guard), JSON Web Tokens (`jsonwebtoken`)
- **Frontend Architecture**: Pure Vanilla JavaScript (zero UI framework dependencies), CSS Custom Properties, Glassmorphism dark mode, Leaflet 1.9.4
- **Testing Runner**: Node native test runner (`node:test`, `node:assert`); integration tests use the separate TEST_MONGODB_URI database.
- **API Verification**: Postman Collection (v2.1.0 schema) and Postman CLI

---

## 🔌 API Endpoint Summary

| Route Group | Base Path | Auth Level | Purpose |
| :--- | :--- | :--- | :--- |
| **System Diagnostics** | `GET /api/health`, `GET /api/ready` | Public | Liveness probe and MongoDB Atlas readiness verification. |
| **Authentication** | `/api/auth` | Public / Bearer | `POST /register`, `POST /login`, `GET /me` (token verification). |
| **Public Locations** | `/api/locations` | Public | Search, city/area filtering, detail, slot availability, and slot recommendations. |
| **Bookings** | `/api/bookings` | User Bearer | `POST /` (atomic slot claim), `GET /me` (all-time counts & pagination), `PATCH /:id/cancel`. |
| **Saved Vehicles** | `/api/vehicles` | User Bearer | `GET /me`, `POST /`, `PATCH /:id`, `DELETE /:id` (strictly user-isolated CRUD). |
| **Admin Operations** | `/api/admin` | Admin Bearer | `/summary` (occupancy metrics), `/locations` (CRUD & publish), `/slots` (nested management), `/bookings` (audit log). |

---

## 🚀 Setup & Installation (Windows PowerShell)

Follow these steps to set up and run ParkWise locally:

### 1. Clone & Install Dependencies
```powershell
# Navigate into project directory
cd ParkWise---Your-Smart-Parking-System

# Install backend and development dependencies
npm install
```

### 2. Configure Environment Variables
Create your local `.env` configuration file from the template:
```powershell
Copy-Item .env.example .env
```
Open `.env` in your text editor and configure your credentials:
```env
PORT=5000
NODE_ENV=development
MONGODB_URI=mongodb+srv://<username>:<password>@cluster.mongodb.net/parkwise_eval2?retryWrites=true&w=majority
TEST_MONGODB_URI=mongodb+srv://<username>:<password>@cluster.mongodb.net/parkwise_eval2_test?retryWrites=true&w=majority
JWT_SECRET=your_super_secret_jwt_key_at_least_32_characters_long
JWT_EXPIRES_IN=1h
```
> [!NOTE]
> MongoDB Atlas database targets must support replica set transactions. Ensure your current IP address is added to your MongoDB Atlas Network Access IP Access List.

### 3. Verify Database Connectivity
Test read-only connectivity to both configured databases:
```powershell
# Check application database connectivity
npm run db:check

# Check isolated test database connectivity
npm run db:check:test
```

### 4. Seed Demo Parking Facilities
Populate standard parking locations and slots into your application database (idempotent; safe to run):
```powershell
npm run seed:demo
```

### 5. Create Local Administrator Account
Generate your administrator credentials using the secure interactive CLI (prompts with hidden password input):
```powershell
npm run admin:create
```

### 6. Start Development Server
```powershell
npm run dev
```
Open your browser to: **`http://localhost:5000`**

live deployed site : **`https://parkwise-your-smart-parking-system.onrender.com`**

---

## 🧪 Automated Testing & Verification

The test suite runs using Node's native `node:test` runner.

| Command | Suite Scope | Description |
| :--- | :--- | :--- |
| `npm run lint` | Syntax Linting | Validates strict JavaScript syntax across all 49 backend and frontend files. |
| `npm run test:unit` | Comprehensive Unit Tests | 273 tests across 20 suites covering foundation, DB lifecycle, auth rate limits, booking concurrency, DTO sanitization, and frontend UI logic. |
| `npm run test:integration` | Replica Set Integration | 7 tests verifying compound indexes, slot code uniqueness, coordinate bounds, passwordHash suppression, and multi-document transactions. |

To run the safe public Postman collection in Windows PowerShell:
```powershell
postman collection run postman/ParkWise-Eval2.postman_collection.json -e postman/ParkWise-Eval2.environment.example.json -i "01 - System Health & Readiness (Safe)" -i "02 - Location Discovery (Safe Read-Only)"
```

---

## 📖 Key Documentation & Evaluation Resources

- 📋 [**Evaluation Demo Checklist**](file:///c:/Users/Madaa/OneDrive/Desktop/ParkWise---Your-Smart-Parking-System/docs/FINAL-DEMO-CHECKLIST.md) — Pre-flight setup, 4–5 minute evaluation demo sequence, and troubleshooting guide.
- 🎯 [**Evaluation Talking Points**](file:///c:/Users/Madaa/OneDrive/Desktop/ParkWise---Your-Smart-Parking-System/docs/EVALUATION-TALKING-POINTS.md) — 90-second elevator pitch, double-booking prevention explanation, and team Q&A prep.
- 📚 [**Syllabus Mapping & Code Evidence**](file:///c:/Users/Madaa/OneDrive/Desktop/ParkWise---Your-Smart-Parking-System/docs/SYLLABUS.md) — Direct mapping of syllabus Topics 25–41 to exact files, lines, and functions.
- 📬 [**Postman Testing Guide**](file:///c:/Users/Madaa/OneDrive/Desktop/ParkWise---Your-Smart-Parking-System/docs/API-TESTING.md) — Instructions for importing collections, environment variable setup, dynamic token capture, and RBAC testing.
- 📈 [**Feature Progression Status**](file:///c:/Users/Madaa/OneDrive/Desktop/ParkWise---Your-Smart-Parking-System/docs/feature-status.md) — Detailed milestone audit from Stage 0 to Stage 14.

---

## ⚖️ Honest Technical Boundaries & Limitations

To maintain academic and professional integrity, ParkWise clearly documents features intentionally outside the scope of this project:
- **No Real Payment Gateway**: ParkWise records and computes tariffs using non-negative integer paise (`pricePerHourPaise`), but does not integrate Stripe, Razorpay, or credit card processors.
- **No File Uploads**: The application does not use Multer or store binary files; facility representations use vector icons and OpenStreetMap coordinates.
- **No Advance Reservations**: Bookings are immediate on-demand allocations. Advance calendar date reservations are not supported.
- **No WebSockets**: Live countdown timers use client-side interval clocks synchronized to server timestamp offsets (`serverClockOffset`), with graceful visibility pausing.
- **No Framework Dependencies**: Built with Vanilla JS and CSS for maximum standards compliance; does not use React, Vue, or Tailwind.
- **No Government Vehicle Verification**: Vehicle registration numbers are validated and normalized, but not checked against an external transport department registry.
- **No PDF Exporting**: Booking history and admin audit tables render in-browser with pagination and search; PDF generation libraries are omitted.
