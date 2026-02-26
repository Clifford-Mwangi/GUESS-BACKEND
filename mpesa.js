// console.log("KEY:", process.env.CONSUMER_KEY);
// console.log("SECRET:", process.env.CONSUMER_SECRET);
// console.log("ENV:", process.env.MPESA_ENV);

require("dotenv").config();
const axios = require("axios");
const moment = require("moment");
const base64 = require("base-64");

const consumerKey = process.env.CONSUMER_KEY;
const consumerSecret = process.env.CONSUMER_SECRET;
const shortcode = process.env.MPESA_SHORTCODE;
const passkey = process.env.MPESA_PASSKEY;
const callbackURL = process.env.CALLBACK_URL;

// === STEP 1: Get Access Token ===
async function getAccessToken() {
  const auth = base64.encode(`${consumerKey}:${consumerSecret}`);
  try {
    const response = await axios.get(
      process.env.MPESA_ENV === "sandbox"
        ? "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials"
        : "https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
      {
        headers: {
          Authorization: `Basic ${auth}`,
        },
      },
    );
    return response.data.access_token;
  } catch (err) {
    console.error(
      "Error getting access token:",
      err.response?.data || err.message,
    );
    throw err;
  }
}

// === STEP 2: Initiate STK Push ===
async function lipaNaMpesa(phone, amount) {
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
    AccountReference: "GuessGame",
    TransactionDesc: "Game Payment",
  };

  try {
    const res = await axios.post(url, data, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.data;
  } catch (err) {
    console.error("STK Push error:", err.response?.data || err.message);
    throw err;
  }
}

module.exports = { lipaNaMpesa };
