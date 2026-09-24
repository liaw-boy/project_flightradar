// TDX FIDS 已實測涵蓋的台灣機場代碼
const AIRPORTS = [
  { code: "TPE", name: "桃園國際機場" },
  { code: "TSA", name: "台北松山機場" },
  { code: "KHH", name: "高雄小港機場" },
  { code: "RMQ", name: "台中機場" },
  { code: "TNN", name: "台南機場" },
  { code: "HUN", name: "花蓮機場" },
  { code: "KNH", name: "金門機場" },
  { code: "MZG", name: "澎湖馬公機場" },
];

const AIRPORT_CODES = AIRPORTS.map((a) => a.code);

module.exports = { AIRPORTS, AIRPORT_CODES };
