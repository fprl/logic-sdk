// Top-level code that throws when imported, like a missing environment variable
const url = process.env.ORDERS_API_URL;
if (!url) throw new Error("ORDERS_API_URL is not set");
export const placeholder = url;
