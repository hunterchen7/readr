# Email Recovery via Resend

Readr can optionally let users attach a recovery email to their account.
If they lose their device token, they can recover it through a 6-digit
email verification flow powered by [Resend](https://resend.com).

## How it works

1. **Attach** (authenticated): user enters an email in Settings. Server
   sends a 6-digit code. User enters code to verify.
2. **Recover** (unauthenticated): user enters their verified email on the
   login screen. Server sends a code; on success it emails the device
   token back to them.

All codes expire in 15 minutes and are single-use.

## Setup

### 1. Create a Resend account

Sign up at <https://resend.com> (free tier: 3 000 emails/month).

### 2. Verify a domain

In the Resend dashboard go to **Domains** and add the domain you want to
send from (e.g. `readr.example.com`). Follow the DNS record instructions
(MX, SPF, DKIM).

### 3. Create an API key

Go to **API Keys** → **Create API Key**. Copy the key.

### 4. Set environment variables

Add these to your `.env` (or Docker Compose env):

```env
RESEND_API_KEY=re_XXXXXXXX
RESEND_FROM=Readr <noreply@readr.example.com>
```

Both must be set for the feature to activate. If either is missing, all
email endpoints return 503 and the mobile UI hides the recovery
affordance.

### 5. Run the migration

The feature adds two columns to `users` and a new `email_verifications`
table. Apply the migration:

```sql
-- Add email columns to users
ALTER TABLE users ADD COLUMN email text;
ALTER TABLE users ADD COLUMN email_verified_at timestamptz;

-- Verification codes table
CREATE TABLE email_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  code text NOT NULL,
  purpose text NOT NULL,
  user_id text REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz DEFAULT now()
);
```

Or use `drizzle-kit push` if you prefer the ORM-managed approach.

## API endpoints

| Method | Path                       | Auth     | Description                     |
|--------|----------------------------|----------|---------------------------------|
| GET    | /api/email/status          | Public   | `{ enabled: bool }`            |
| POST   | /api/email/recover/start   | Public   | Send recovery code to email     |
| POST   | /api/email/recover/finish  | Public   | Verify code, email device token |
| POST   | /api/email/attach          | Required | Link email to current account   |
| POST   | /api/email/verify          | Required | Verify the attach code          |

## Disabling

Remove `RESEND_API_KEY` and `RESEND_FROM` from env and restart. The
feature is fully off — no endpoints respond, no UI shows.
