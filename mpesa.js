require("dotenv").config();
const axios = require("axios");
const moment = require("moment");
const base64 = require("base-64");

const consumerKey = process.env.CONSUMER_KEY;
const consumerSecret = process.env.CONSUMER_SECRET;
const shortcode = process.env.MPESA_SHORTCODE;
const passkey = process.env.MPESA_PASSKEY;
const callbackURL = process.env.CALLBACK_URL;

async function getAccessToken() {
  const auth = base64.encode(`${consumerKey}:${consumerSecret}`);

  const url =
    process.env.MPESA_ENV === "sandbox"
      ? "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials"
      : "https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials";

  const response = await axios.get(url, {
    headers: { Authorization: `Basic ${auth}` },
  });

  return response.data.access_token;
}

async function lipaNaMpesa(phone, amount, username) {
  const token = await getAccessToken();
  const timestamp = moment().format("YYYYMMDDHHmmss");
  const password = base64.encode(shortcode + passkey + timestamp);

  const url =
    process.env.MPESA_ENV === "sandbox"
      ? "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest"
      : "https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest";

  const data = {
    BusinessShortCode: shortcode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: "CustomerPayBillOnline",
    Amount: amount,
    PartyA: phone,
    PartyB: shortcode,
    PhoneNumber: phone,
    CallBackURL: callbackURL,
    AccountReference: username,
    TransactionDesc: "Guess Game Deposit",
  };

  const res = await axios.post(url, data, {
    headers: { Authorization: `Bearer ${token}` },
  });

  return res.data;
}

module.exports = { lipaNaMpesa };
