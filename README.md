# ParkWise — Intelligent Parking Management System

ParkWise is a web-based Smart Parking Lot Booking and Intelligent Slot Recommendation System designed to make parking easier, faster, and more convenient.

The system allows users to register and log in, view parking availability, book parking slots, manage reservations, and view their booking history.

---

## 🚗 Features

- User Registration and Login
- Password Hashing
- Session Management
- Protected Routes
- Real-Time Parking Slot Availability
- Intelligent Parking Slot Recommendations
- Parking Slot Booking
- Booking History
- Search and Sort Booking History
- Booking Status Filters
- Interactive Dashboard
- Parking Statistics
- Responsive User Interface
- Scroll Animations and Interactive Landing Page
- Dark-themed UI

---

## 🛠️ Technologies Used

### Frontend
- HTML5
- CSS3
- JavaScript (ES6+)

### Browser Storage
- LocalStorage

### Other Concepts
- DOM Manipulation
- Event Handling
- Form Validation
- Password Hashing
- Session Management
- Intersection Observer API
- RequestAnimationFrame API
- Responsive Web Design

---

## 📂 Project Structure
ParkWise/
│
├── assets/
│   └── images/
│
├── css/
│   ├── style.css
│   ├── auth.css
│   ├── dashboard.css
│   ├── booking.css
│   └── history.css
│
├── js/
│   ├── index.js
│   ├── login.js
│   ├── register.js
│   ├── auth.js
│   ├── storage.js
│   ├── validation.js
│   ├── utils.js
│   ├── dashboard.js
│   ├── booking.js
│   └── history.js
│
├── index.html
├── login.html
├── register.html
├── dashboard.html
├── booking.html
├── history.html
│
└── README.md

▶️ How to Run
Since ParkWise is currently a frontend-based project, no backend server is required to run the current version.
Option 1 — Open directly
Open:
index.html
in a web browser.
Option 2 — VS Code
1. Open the project folder in VS Code.
2. Install the Live Server extension.
3. Right-click index.html.
4. Select Open with Live Server.
💾 Data Storage
The current version uses the browser's LocalStorage for storing user, session, and parking-related data.
Note: LocalStorage is used for the current evaluation version. For a production application, authentication and sensitive data should be handled by a secure backend.

🔮 Future Scope
The project can be extended into a full-stack application using:
- React.js
- Node.js
- Express.js
- MongoDB
- REST APIs
- Secure backend authentication
- bcrypt/Argon2 password hashing
- JWT or secure session-based authentication
- Real-time parking availability
- Maps and location services
- Online payment integration
- Admin dashboard
📌 Project Status
Current Status: Frontend Evaluation Version
ParkWise currently provides the core parking booking, authentication, dashboard, and history functionality using HTML, CSS, JavaScript, and LocalStorage.

🔐 Authentication
ParkWise includes a client-side authentication system.
The authentication flow includes:
1. User registration
2. Email duplication checking
3. Password hashing
4. User data storage
5. Login credential verification
6. Session creation
7. Protected page access
8. Logout functionality
Authentication-related JavaScript is separated into different modules to maintain separation of concerns.
🧩 JavaScript Architecture
The JavaScript code is divided according to responsibilities.
index.js
Handles landing page interactions such as:
- Navbar scroll behaviour
- Active navigation highlighting
- Parking statistics counter animation
- Scroll reveal animations
- Reduced-motion accessibility support
login.js
Handles:
- Login form DOM interaction
- Input validation
- Error messages
- Form submission
- Login authentication
- Dashboard redirection
register.js
Handles:
- Registration form DOM interaction
- Real-time validation
- Error messages
- Password confirmation
- Account creation
- Dashboard redirection
auth.js
Handles authentication business logic:
- Password hashing
- Password verification
- User registration
- Login
- Logout
- Session helpers
- Route guards
validation.js
Contains validation rules for registration and login forms.
storage.js
Handles user and session data using browser LocalStorage.

👥 Team Members
Team Member	Contribution
Arpit	Utility functions, storage management, validation
Aastik	Landing page JavaScript, authentication, login and registration
Siya	Dashboard, booking, history functionality and related HTML/CSS
