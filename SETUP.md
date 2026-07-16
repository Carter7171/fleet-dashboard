# AFS Fleet Dashboard — Setup

A vehicle tracking & maintenance dashboard: driver mileage reporting, oil-change tracking, monthly inspections, reporting/export, and automated **email** reminders + escalation.

- **Frontend:** `index.html` — one self-contained file (no build step), hosted on GitHub Pages.
- **Data:** Firebase **Firestore** (project `afs-fleet`).
- **Login:** Firebase Auth **email/password** with roles (Driver / Manager / Administrator).
- **Automation:** Firebase **Cloud Functions** (scheduled) sending email via **SendGrid**.

---

## Try it right now (no setup) — dev preview

Open `index.html?dev=admin` in a browser. This runs a **dev bypass**: no login, in-memory sample data, so you can click through every tab, submit sample mileage, complete an inspection, and export reports. Also try `?dev=manager` and `?dev=driver` to see role-based views. Nothing is saved — it's a demo of the UI and calculations.

---

## Going live — one-time setup

### 1. Firebase project
1. Create a Firebase project named **`afs-fleet`** at <https://console.firebase.google.com>.
2. Add a **Web App**; copy its config object.
3. Paste those values into `FIREBASE_CONFIG` at the top of the `<script>` in `index.html` (replace every `REPLACE_ME`).
4. **Firestore Database** → Create database (production mode).
5. **Authentication** → Get started → enable **Email/Password**.

### 2. Deploy security rules
Install the CLI once (`npm install -g firebase-tools`), then:
```
firebase login
firebase deploy --only firestore:rules
```
These rules (in `firestore.rules`) enforce roles + row-level visibility: drivers see only their own vehicle, managers see their team, admins see everything. History is immutable.

### 3. First admin + roster
1. In the app's login screen, click **Create an account** and register with your work email.
2. In the Firebase console → Firestore, create a doc in **`fleet_employees`** with the **document ID = your lowercased email**, fields: `email`, `empId`, `name`, `role: "admin"`, `active: true`. (This first record must be added by hand; everyone after can be imported.)
3. Sign in → **Admin** tab → **Import file**: upload your roster (use **Template CSV** for the exact columns). Drivers/managers and vehicles are created automatically.
4. Each employee then self-registers (Create an account) with the **same email** that's on the roster; their role/visibility come from their roster record.

**Roster columns:** `vehicleNo, description, driverName, driverEmail, driverPhone, role, managerEmail, currentMileage, lastOilChangeMileage, oilChangeInterval`

### 4. Host the frontend (GitHub Pages)
1. Create a GitHub repo (e.g. `fleet-dashboard`), push `index.html`.
2. Repo → Settings → Pages → deploy from `main`.
3. In Firebase → Authentication → **Settings → Authorized domains**, add your Pages domain (e.g. `carter7171.github.io`).

### 5. Email automation (Cloud Functions)
Requires the **Blaze** (pay-as-you-go) plan — needed for scheduled functions. Free tier covers this workload; you only set it up once.

1. Firebase console → upgrade project to **Blaze**.
2. Create a free **SendGrid** account, verify a sender or domain, and create an API key.
3. Set secrets and the dashboard URL:
   ```
   firebase functions:secrets:set SENDGRID_KEY      # paste the SendGrid API key
   firebase functions:secrets:set FROM_EMAIL        # e.g. fleet@afsgroup.com (a verified sender)
   firebase functions:secrets:set ADMIN_RUN_KEY     # any random string, for the debug trigger
   ```
   (Edit `DASHBOARD_URL` at the top of `functions/index.js` if your Pages URL differs.)
4. Deploy:
   ```
   cd functions && npm install && cd ..
   firebase deploy --only functions
   ```

**Schedules (America/New_York):**
| Function | When | Does |
|---|---|---|
| `weeklyReminder` | Fri 8:00 AM | Emails each driver who hasn't submitted this week |
| `escalation` | Fri :00/:15/:30/:45, 1:00–3:30 PM | Re-nudges still-missing drivers; at 3:30 PM emails admins the missing list |
| `oilAlerts` | Daily 7:00 AM | Emails drivers for due/overdue oil changes; admins for overdue |
| `inspectionDue` | 1st @ 7:00 AM | Emails managers about inspections due this month |
| `inspectionOverdue` | 26th @ 7:00 AM | Emails managers + admins about still-missing inspections |

Submitting mileage flips `fleet_week_status.submitted = true`, so a driver automatically drops out of the escalation — **no reminders after they report.**

### 6. Verify the functions
Use the admin debug trigger (returns JSON, sends real emails, logs to the Notification Log in the Admin tab):
```
https://us-central1-afs-fleet.cloudfunctions.net/runJob?name=weeklyReminder&key=YOUR_ADMIN_RUN_KEY
https://us-central1-afs-fleet.cloudfunctions.net/runJob?name=oilAlerts&key=YOUR_ADMIN_RUN_KEY
https://us-central1-afs-fleet.cloudfunctions.net/runJob?name=escalation&force=1&key=YOUR_ADMIN_RUN_KEY
```

---

## Roles at a glance
| | Driver | Manager | Admin |
|---|---|---|---|
| Submit mileage | own vehicle | ✔ | any |
| See vehicles | own | team | all |
| Complete inspections | — | team | all |
| Reports & export | — | team | all |
| Manage roster / vehicles | — | — | ✔ |

## Not in this version (easy to add later)
- Inbound mileage by replying to the email/text (reply-to-submit).
- Microsoft Teams channel broadcasts.

The data model already supports both, so no migration is needed to add them.
