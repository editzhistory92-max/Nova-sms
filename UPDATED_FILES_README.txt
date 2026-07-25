MUFASA SMS — Payment V2 Fixes
Date: 2026-07-25
Cache marker: /api.js?v=20260725-payment-fixes

Fixes implemented for Payment System:

1) Manager Panel hides empty payment categories
- Manager -> Agent Payments now dynamically hides Daily/Weekly/Monthly columns if there is no earning in that category.
- Agents with no payment earning and no request are hidden from the payment table.
- If only Monthly has earnings, only Monthly column appears.
- When Daily/Weekly earnings start, those columns appear automatically.

2) Rate is based on Agent assigned Payment Type
- Added users.payment_type for Agents.
- Manager Agent modal now has Agent Payment Type:
  Daily / Weekly / Monthly (30x45)
- Manager allocation forms also pass payment type when assigning numbers to agents.
- Backend updates Agent payment_type during Manager -> Agent allocation/smart divide.
- Incoming OTP uses Agent's current assigned payment_type to select the payout rate:
  daily -> rate_1_1
  weekly -> rate_7_1, fallback rate_7_7
  monthly_30x45 -> rate_30_45
- Number-specific rate remains fallback only if matching range rate is not configured.

3) Historical earnings are not moved
- sms_records stores payment_type snapshot.
- payment_ledger stores payment_type at the moment the OTP is received.
- Changing an Agent's payment type affects only future OTPs.
- Existing ledger rows stay in their original Daily/Weekly/Monthly category.

4) Payment V2 retained
- Separate Admin Payment Panel remains:
  /payment-login
  /payment
- Agent wallet/request functions remain.
- Manager read-only view remains.
- Admin processing/payment history/audit logs remain.

Files changed:
- backend/server.js
- backend/schema.js
- manager.html
- agent.html
- admin.html
- management.html
- payment.html
- payment-login.html
- api.js cache marker updated in all panels

VPS commands after GitHub push:
cd ~/Mufasa-sms
git pull --ff-only origin main
npm install && pm2 flush mufasa-sms && pm2 restart mufasa-sms --update-env && pm2 list
pm2 logs mufasa-sms --lines 80

Verification:
grep -n "20260725-payment-fixes" admin.html management.html manager.html agent.html client.html payment.html
grep -n "assignedPaymentTypeForNumber\|payoutRateForPaymentType\|payment_type" backend/server.js backend/schema.js
