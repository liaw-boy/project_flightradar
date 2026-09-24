require("dotenv").config();
const path = require("path");
const express = require("express");
const apiRouter = require("./routes/api");
const { startPoller } = require("./jobs/poller");
const { syncAirlines } = require("./services/airlineSync");
const { syncAirportRefs } = require("./services/airportRefSync");

const app = express();
const PORT = process.env.PORT || 3800;
// aerostrat is the only consumer (over loopback); do not expose the port to the network.
const HOST = process.env.HOST || "127.0.0.1";

app.use("/api", apiRouter);
app.use(express.static(path.join(__dirname, "public")));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function bootstrapReferenceData() {
  try {
    await syncAirlines();
  } catch (err) {
    console.error("[bootstrap] 航空公司對照資料同步失敗:", err.message);
  }
  await sleep(13000); // 避開 TDX 每分鐘 5 次請求限制
  try {
    await syncAirportRefs();
  } catch (err) {
    console.error("[bootstrap] 機場對照資料同步失敗:", err.message);
  }
}

app.listen(PORT, HOST, async () => {
  console.log(`TPE Flight Board 啟動於 http://${HOST}:${PORT}`);
  await bootstrapReferenceData();
  startPoller();
});
