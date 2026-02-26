require("dotenv").config();
const axios = require("axios");
const base64 = require("base-64");

const consumerKey = process.env.CONSUMER_KEY;
const consumerSecret = process.env.CONSUMER_SECRET;

async function getToken() {
  const auth = base64.encode(`${consumerKey}:${consumerSecret}`);

  try {
    const response = await axios.get(
      "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
      {
        headers: {
          Authorization: `Basic ${auth}`,
        },
      },
    );
    console.log("✅ Token received:", response.data.access_token);
  } catch (err) {
    console.error("❌ Token error:", err.response?.data || err.message);
  }
}

getToken();
