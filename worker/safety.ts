// 安全分類器
// 在主模型「之前」跑。命中就直接回傳固定文字，完全不呼叫 AI。
//
// 設計原則：
// 1. 寧可誤報。把正常對話誤判成緊急狀況，代價是阿明大驚小怪；
//    漏掉真的緊急狀況，代價是人命。閾值一律往安全那邊偏。
// 2. 回應文字寫死。緊急狀況不讓模型即興發揮。
// 3. 純字串比對，零延遲零成本，不受模型當機影響。
//
// 這是第一版，只有關鍵字。第二層的小模型二次確認之後再加。

export type SafetyLevel = "none" | "medical" | "emotional";

export interface SafetyResult {
  level: SafetyLevel;
  reply: string;       // level 不是 none 時，直接回這段，不呼叫 AI
  matched: string;     // 命中的關鍵字，寫進 log 方便調整
}

// ===== 醫療急症 =====
// 這些症狀需要立刻就醫，不是聊天能處理的
const MEDICAL_KEYWORDS = [
  // 心血管
  "胸口痛", "胸痛", "胸口悶", "胸悶", "心臟痛", "喘不過氣", "呼吸困難",
  "喘不上來", "快沒氣",
  // 腦中風徵兆
  "手麻", "腳麻", "半邊", "一邊不能動", "嘴歪", "講話不清", "口齒不清",
  "說話大舌頭", "臉歪", "突然看不到",
  // 外傷與出血
  "跌倒", "摔倒", "跌下去", "流很多血", "血流不止", "大量出血", "撞到頭",
  // 意識
  "昏倒", "暈倒", "意識不清", "叫不醒", "搞不清楚自己在哪",
  // 其他
  "很痛很痛", "痛到受不了", "全身抽筋",
];

const MEDICAL_REPLY =
  "你說的這個狀況要趕快找人幫忙。\n" +
  "請打 119，或是馬上聯絡家人。\n" +
  "我在這裡陪你，但這件事要讓專業的人處理。";

// ===== 情緒風險 =====
// 台灣 65 歲以上是自殺率最高的年齡層之一，這組不能漏
const EMOTIONAL_KEYWORDS = [
  "活著沒意思", "活著沒什麼意思", "不想活", "不想再活",
  "死一死", "去死", "早點走", "早點去",
  "拖累", "累贅", "麻煩家人", "沒有我比較好",
  "交代後事", "後事", "遺書", "遺言", "分財產",
  "不想醒來", "睡著不要醒", "一了百了", "解脫",
  "沒有人需要我", "沒人在乎我",
];

const EMOTIONAL_REPLY =
  "你願意跟我說這些，我很謝謝你。\n" +
  "這種心情不用一個人扛，安心專線 1925 有人可以聽你說，24 小時都在。\n" +
  "生命線 1995 也可以打。我這邊也在。";

// ===== 檢查 =====
// 同時比對使用者說的話。醫療優先於情緒，因為時間壓力不同。
export function checkSafety(userMessage: string): SafetyResult {
  const text = (userMessage || "").trim();
  if (!text) {
    return { level: "none", reply: "", matched: "" };
  }

  for (const kw of MEDICAL_KEYWORDS) {
    if (text.includes(kw)) {
      return { level: "medical", reply: MEDICAL_REPLY, matched: kw };
    }
  }

  for (const kw of EMOTIONAL_KEYWORDS) {
    if (text.includes(kw)) {
      return { level: "emotional", reply: EMOTIONAL_REPLY, matched: kw };
    }
  }

  return { level: "none", reply: "", matched: "" };
}

// ===== 後置檢查 =====
// 主模型輸出之後跑，攔截不該說出口的內容。
// 命中就代表 prompt 沒守住，要記進 log 當作改進素材。
const OUTPUT_FORBIDDEN = [
  // 藥物相關
  "停藥", "劑量", "藥量", "可以不吃", "不用吃藥", "自己調整",
  // 數值判讀
  "正常值", "標準值", "偏高", "偏低", "超標",
  // 做不到的承諾
  "陪你去", "陪您去", "我去找你", "來看你", "見面",
];

export interface OutputCheckResult {
  ok: boolean;
  matched: string;
}

export function checkOutput(reply: string): OutputCheckResult {
  const text = (reply || "").trim();
  for (const kw of OUTPUT_FORBIDDEN) {
    if (text.includes(kw)) {
      return { ok: false, matched: kw };
    }
  }
  return { ok: true, matched: "" };
}

// 後置檢查沒過時的替代回應
// 不重跑模型，因為重跑可能還是講錯，而且會拖慢回應
export const FALLBACK_REPLY =
  "這個我不太清楚呢。\n" +
  "你最近過得還好嗎？";
